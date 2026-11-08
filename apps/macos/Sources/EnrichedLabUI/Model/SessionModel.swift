import AppKit
import EnrichedLabKit
import Foundation
import Observation

/// The open session: its log, its live state, the questions it waits on, its views and its workbench.
@MainActor
@Observable
public final class SessionModel {
	public let id: String
	unowned let app: AppModel
	public var summary: SessionSummary
	public private(set) var events: [SessionEvent] = []
	public private(set) var status: SessionStatus?
	public private(set) var partial = PartialResponse()
	public var pending: [PermissionRequest] = [] { didSet { rebuild() } }
	public var canvases: [CanvasSummary] = []
	/// The run sheet, rebuilt when the log or the running calls change (not on every streamed token).
	public private(set) var blocks: [Block] = []
	public var opening = false
	/// Text a send couldn't deliver, or messages a stop returned, for the composer to show again.
	public var draft: String?
	/// When the current turn started, for the elapsed time beside the activity word.
	public private(set) var turnStarted: Date?
	/// The workbench's tabs for this session.
	public let workbench: WorkbenchModel
	/// The window's browser pane, for the person and for the agent.
	public let browser = BrowserController()
	/// The agent's page in a lab's sandbox browser, and its latest picture.
	public var screen: BrowserPageState?
	public var screenFrame: BrowserFrame? {
		didSet { screenImage = screenFrame.flatMap { decodeImage($0.data) } }
	}
	/// The sandbox browser's newest picture, decoded once when it arrives.
	public private(set) var screenImage: NSImage?
	/// Set when a compaction lands, so the context gauge can show it once.
	public private(set) var compactedAt: Date?

	init(id: String, app: AppModel) {
		self.id = id
		self.app = app
		summary = SessionSummary(id: id, cwd: "", title: "", created: "", updated: "", model: "", turns: 0, running: false)
		workbench = WorkbenchModel(sessionId: id)
	}

	/// Events and questions that arrived while the snapshot was on its way, joined after it without repeats.
	private var held: [SessionEvent] = []
	@ObservationIgnored private var lastToolRebuild = Date.distantPast
	private var heldRequests: [PermissionRequest] = []

	func apply(_ snapshot: SessionSnapshot) {
		summary = snapshot.summary
		let known = Set(snapshot.events.map(\.id))
		events = snapshot.events + held.filter { !known.contains($0.id) }
		held = []
		status = snapshot.status
		let asked = Set(snapshot.pending.map(\.requestId))
		pending = snapshot.pending + heldRequests.filter { !asked.contains($0.requestId) }
		heldRequests = []
		partial = snapshot.partial ?? PartialResponse()
		turnStarted = snapshot.status.busy ? Date() : nil
		opening = false
		rebuild()
	}

	func receive(_ event: SessionEvent) {
		if opening { held.append(event); return }
		guard !events.contains(where: { $0.id == event.id }) else { return }
		events.append(event)
		switch event {
		case .assistant: partial = PartialResponse()
		case .compaction: compactedAt = Date()
		case let .title(t): summary.title = t.title
		default: break
		}
		rebuild()
	}

	func delta(kind: String, text: String, index: Int?, name: String?, callId: String?) {
		switch kind {
		case "text": partial.text += text
		case "reasoning": partial.reasoning += text
		case "tool":
			if let name {
				partial.tools.append(.init(index: index ?? 0, name: name, args: ""))
				rebuild()
			} else if let i = partial.tools.firstIndex(where: { $0.index == index }) {
				partial.tools[i].args += text
				// The step's target shows as its arguments arrive, redrawn a few times a second at most.
				if Date().timeIntervalSince(lastToolRebuild) > 0.25 {
					lastToolRebuild = Date()
					rebuild()
				}
			}
		case "output":
			if let callId { partial.output[callId] = String(((partial.output[callId] ?? "") + text).suffix(20_000)) }
		default: break
		}
	}

	func update(_ next: SessionStatus) {
		let wasBusy = status?.busy ?? false
		status = next
		if next.busy, !wasBusy { turnStarted = Date() }
		if !next.busy {
			partial = PartialResponse()
			turnStarted = nil
		}
		rebuild()
	}

	func ask(_ request: PermissionRequest) {
		if opening { heldRequests.append(request); return }
		if !pending.contains(where: { $0.requestId == request.requestId }) { pending.append(request) }
	}

	public var busy: Bool { status?.busy ?? false }

	public var place: Place { app.place(of: summary.place) }

	public var model: ModelInfo? { app.model(status?.model ?? summary.model) }

	/// Calls in the newest answer that haven't finished: the live end of the activity.
	private var runningCalls: [RunningCall]? {
		guard busy else { return nil }
		var calls: [RunningCall] = []
		if let last = events.last(where: { if case .assistant = $0 { true } else { false } }), case let .assistant(step) = last {
			calls = (step.toolCalls ?? []).map { RunningCall(id: $0.id, name: $0.name, target: argumentPreview($0.args)) }
		}
		// Calls the model is still writing show as steps too, with what they'll act on once it appears.
		for tool in partial.tools {
			calls.append(RunningCall(id: "streaming-\(tool.index)", name: tool.name, target: argumentPreview(tool.args)))
		}
		return calls
	}

	private func rebuild() {
		blocks = EnrichedLabKit.blocks(events, running: runningCalls, pending: pending)
	}

	/// Questions whose step isn't in the run sheet (asked before its call streamed): shown above the composer.
	public var looseQuestions: [PermissionRequest] {
		let shown = Set(blocks.flatMap { block -> [String] in
			guard case let .activity(_, steps) = block else { return [] }
			return steps.compactMap { if case let .running(id, _, _, waiting) = $0, waiting != nil { id } else { nil } }
		})
		return pending.filter { !shown.contains($0.callId) }
	}

	// MARK: Actions

	public func send(_ text: String, images: [Part]? = nil) async -> Bool {
		do {
			try await app.connection.prompt(id, text: text, images: images)
			return true
		} catch {
			app.said(error, prefix: "Not sent")
			return false
		}
	}

	public func stop() async {
		do {
			let result = try await app.connection.cancel(id)
			if let returned = result.returned, !returned.isEmpty { draft = returned.joined(separator: "\n\n") }
		} catch {
			app.said(error, prefix: "Couldn't stop it")
		}
	}

	/// Answer a question. If the answer doesn't reach the engine, the question comes back to answer again.
	public func answer(_ request: PermissionRequest, _ decision: PermissionDecision) async {
		pending.removeAll { $0.requestId == request.requestId }
		do {
			try await app.connection.answer(request.requestId, decision)
		} catch {
			if !pending.contains(where: { $0.requestId == request.requestId }) { pending.insert(request, at: 0) }
			app.said(error, prefix: "Your answer didn't reach the engine")
		}
	}

	/// How much this session asks: its own mode, else the default for new sessions.
	public var permissionMode: PermissionMode { summary.permissions.flatMap(PermissionMode.init(rawValue:)) ?? app.ui.permissionMode }

	/// Set how much this session asks; nil returns it to the default.
	public func setPermissions(_ mode: PermissionMode?) async {
		do { summary = try await app.connection.setPermissions(id, mode: mode) } catch { app.said(error, prefix: "Couldn't change that") }
	}

	public func setModel(_ model: String?, effort: String? = nil) async {
		do { status = try await app.connection.setModel(id, model: model, effort: effort) } catch { app.said(error) }
	}

	/// Ask, then put the folder back as it was before a step; with `retry`, open a new session that continues from there.
	public func confirmRewind(before: String, retry: Bool) {
		app.confirmation = Confirmation(
			title: retry ? "Try again from before this step?" : "Go back to before this step?",
			facts: [
				(label: "Files", text: "The folder goes back to how it was before this step. Files changed since come back as they were; files made since go."),
				(label: "Nothing is lost", text: "The present is kept in history first, so you can come back to it."),
			] + (retry ? [(label: "Conversation", text: "A new session continues from just before this step. This one stays as it is.")] : [(label: "Conversation", text: "The agent is told, and continues from the files as they are.")]),
			action: retry ? "Try Again" : "Go Back",
			destructive: false
		) { [weak self] in
			await self?.rewind(before: before, retry: retry)
		}
	}

	func rewind(before: String, retry: Bool) async {
		do {
			let result = try await app.connection.rewind(id, before: before, retry: retry)
			app.say(result.detail)
			if let fork = result.session {
				app.upsert(fork)
				app.selection = fork.id
			}
		} catch {
			app.said(error, prefix: "Couldn't go back")
		}
	}

	public func compact() async {
		do { app.say(try await app.connection.compact(id).detail) } catch { app.said(error, prefix: "Summarizing didn't work") }
	}

	public func undo() async {
		do { app.say(try await app.connection.undo(id).detail) } catch { app.said(error, prefix: "Undo didn't work") }
	}

	/// Moving a session: what goes along, where it runs, how work comes back; asked first, then done.
	public func requestMove(to target: Place) async {
		guard target.id != place.id else { return }
		if let site = target.site, !site.signedIn {
			_ = await app.signIn(site.name)
			return
		}
		if !target.isLocal, !place.isLocal {
			app.say("Move back to This Mac first: the work comes home as a branch, and then it can go to \(target.title).")
			return
		}
		var facts: [(String, String)] = []
		if target.isLocal {
			facts.append(("Works in", shortPath(summary.cwd)))
			if !place.isLocal { facts += [("Comes back", "New commits from the \(place.title) sandbox, as a branch for you to merge"), ("Stays there", "Changes it didn't commit")] }
		} else {
			let repo: String?
			do { repo = try await app.connection.movePlan(id) } catch { app.said(error, prefix: "Couldn't check what would move"); return }
			let runs = ("Runs", "On Linux in the \(target.title) sandbox")
			facts = repo.map { [("Goes along", "The git repository, uncommitted changes included. Files that look like secrets stay here."), ("Repository", shortPath($0)), runs, ("Comes back", "New commits, as a branch, when you move back")] }
				?? [("Goes along", "Nothing: this folder isn't a git repository, so the sandbox starts empty. Make it a repository first to take its files."), runs]
		}
		app.confirmation = Confirmation(
			title: target.isLocal ? "Move back to \(target.title)?" : "Move this session to the \(target.title) sandbox?",
			facts: facts.map { (label: $0.0, text: $0.1) },
			action: "Move",
			destructive: false
		) { [weak self] in
			await self?.move(to: target.id)
		}
	}

	public private(set) var moving: String?

	func move(to place: String) async {
		guard moving == nil else { return }
		moving = place
		defer { moving = nil }
		do {
			let result = try await app.connection.moveSession(id, to: place)
			app.upsert(result.summary)
			app.say(result.detail)
		} catch {
			app.said(error)
		}
	}

	// MARK: Views

	func upsertView(_ view: CanvasSummary) {
		let first = !canvases.contains { $0.id == view.id }
		canvases.removeAll { $0.id == view.id }
		canvases.insert(view, at: 0)
		if first { workbench.show(WorkbenchModel.pane(for: view), title: view.title) }
		else { workbench.retitle(WorkbenchModel.pane(for: view), title: view.title) }
	}

	public func showView(_ id: String) {
		guard let view = canvases.first(where: { $0.id == id }) else { return }
		workbench.show(WorkbenchModel.pane(for: view), title: view.title)
	}

	public func openFile(_ path: String) async {
		do {
			let view = try await app.connection.openView(sessionId: id, path: path)
			upsertView(view)
			showView(view.id)
		} catch {
			app.said(error)
		}
	}

	func browserPage(_ page: BrowserPageState) {
		let fresh = screen?.site != page.site
		screen = page
		if fresh { workbench.show(.screen(site: page.site), title: "\(page.lab) browser") }
	}

	func restoreWorkbench() {
		workbench.restore(views: canvases)
	}

	func save() {
		workbench.save()
	}
}
