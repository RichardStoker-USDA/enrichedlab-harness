import AppKit
import EnrichedLabKit
import Observation
import SwiftUI

/// A short message at the bottom of the window. One with a page to open stays longer.
public struct Toast: Identifiable, Equatable {
	public let id = UUID()
	public var text: String
	public var url: URL?
}

/// A question that needs a yes before something that can't be undone.
public struct Confirmation: Identifiable {
	public let id = UUID()
	public var title: String
	public var detail: String?
	public var facts: [(label: String, text: String)] = []
	public var action: String
	public var destructive: Bool = true
	public var run: @MainActor () async -> Void
}

/// The window's state. Everything comes from the engine; this mirrors it and sends requests. The workbench's tabs are
/// the one piece kept here: they belong to this person's screen, per session.
@MainActor
@Observable
public final class AppModel {
	public let connection: EngineConnection
	public let locator: EngineLocator

	// Connection
	public private(set) var connection_: ConnectionState = .connecting
	public private(set) var engineVersion: String?
	/// Where the engine serves pages (views, apps), for the window's web views.
	public private(set) var engineBase: URL?
	public var connected: Bool { if case .connected = connection_ { true } else { false } }

	// What the engine knows
	public private(set) var sessions: [SessionSummary] = []
	public private(set) var sites: [SiteSummary] = []
	public private(set) var models: [ModelInfo] = []
	public private(set) var defaultModel: String?
	public private(set) var ui = UiPrefs() {
		didSet { applyAppearance() }
	}
	public private(set) var apps: [AppSummary] = []
	public private(set) var labApps: [LabApp] = []
	public var deviceRequests: [DeviceRequest] = []
	public private(set) var desktops: [String: DesktopFrame] = [:] {
		// A desktop shown live keeps its live picture; an action's screenshot would only step back in time.
		didSet { for (site, frame) in desktops where desktopImages[site]?.at != frame.at && desktopScreens[site] == nil { desktopImages[site] = (frame.at, decodeImage(frame.png)) } }
	}
	/// Each lab desktop's newest picture, decoded once when it arrives.
	public private(set) var desktopImages: [String: (at: String, image: NSImage?)] = [:]
	public private(set) var desktopBusy: Set<String> = []
	/// Each watched lab desktop's live view, when the lab streams it.
	public private(set) var desktopLive: [String: DesktopStream] = [:]
	@ObservationIgnored private var desktopWatchers: [String: Int] = [:]
	@ObservationIgnored private var desktopScreens: [String: DesktopScreen] = [:]
	public var sessionLimit = 200

	// The open session
	public var selection: String? {
		didSet { if selection != oldValue { Task { await self.open(selection) } } }
	}
	public private(set) var session: SessionModel?

	// Window state
	public var toast: Toast?
	public var confirmation: Confirmation?
	public var joining: JoinRequest?
	public var renaming: String?
	/// The place and folder the new-session screen starts on.
	public var newPlace: String = "local"
	public var newFolder: URL?
	public var showServices = false
	public var showSettingsTab: SettingsTab?

	private var openGeneration = 0
	private var listening: Task<Void, Never>?
	private var toastTimer: Task<Void, Never>?
	private let terminals = TerminalHub()

	public init(locator: EngineLocator = .standard()) {
		self.locator = locator
		connection = EngineConnection(locator: locator, client: "macos", capabilities: ["browser"])
		let recent = UserDefaults.standard.url(forKey: "newFolder")
		newFolder = recent ?? FileManager.default.homeDirectoryForCurrentUser
	}

	public var terminalHub: TerminalHub { terminals }

	/// Set by the main window: whether the workbench has room beside the run sheet right now.
	public var workbenchRoom = true

	/// The sidebar's and the workbench's widths as last drawn: the window needs room for both beside the run sheet.
	public var sidebarWidth: CGFloat = 260
	public var workbenchWidth: CGFloat = 560

	/// The run sheet's narrowest: the composer's place and model menus and buttons in one row.
	public static let runSheetWidth: CGFloat = 470
	/// The workbench's narrowest, and its widest right now: what's left beside the run sheet (kept by the main window).
	public static let workbenchNarrowest: CGFloat = 380
	public var workbenchMax: CGFloat = 1400

	/// The person's appearance for every window, AppKit views (terminals, web views) and Settings included.
	private func applyAppearance() {
		NSApp?.appearance = ui.theme == "light" ? NSAppearance(named: .aqua) : ui.theme == "dark" ? NSAppearance(named: .darkAqua) : nil
	}

	// MARK: Start

	public func start() {
		guard listening == nil else { return }
		listening = Task { [weak self] in
			guard let self else { return }
			await withTaskGroup(of: Void.self) { group in
				group.addTask { await self.watchState() }
				group.addTask { await self.watchNotifications() }
			}
		}
		Task { await connection.start() }
	}

	private func watchState() async {
		for await state in connection.states {
			connection_ = state
			if case let .connected(engine, reconnected) = state {
				engineVersion = engine
				if reconnected { terminals.restartAll(showing: session?.id) }
				if let file = await locator.running() { engineBase = URL(string: "http://127.0.0.1:\(file.port)") }
				await reload()
			}
		}
	}

	private func watchNotifications() async {
		for await note in connection.notifications {
			handle(note)
		}
	}

	/// Each part shows as it arrives; one failure doesn't hold back the rest.
	public func reload() async {
		// The engine forgets a window's live views when it reconnects: ask again for those still shown.
		for site in desktopWatchers.keys { Task { await askDesktopLive(site) } }
		async let prefs = try? connection.uiPrefs()
		async let list = try? connection.sessions(limit: sessionLimit)
		async let labs = try? connection.sites()
		async let modelList = try? connection.models()
		async let appList = try? connection.apps()
		if let value = await prefs { ui = value }
		if let value = await list {
			sessions = value
			if UserDefaults.standard.url(forKey: "newFolder") == nil, let newest = projects.first?.folder { newFolder = URL(fileURLWithPath: newest) }
		}
		if let value = await labs { sites = value }
		if let value = await modelList { models = value.models; defaultModel = value.default }
		if let value = await appList { apps = value }
		labApps = (try? await connection.labApps()) ?? labApps
		if let current = session?.id {
			await open(current, force: true)
			// A lab browser pane that was showing asks for its pictures again.
			if session?.workbench.tabs.contains(where: { if case .screen = $0.pane { true } else { false } }) == true {
				if let page = try? await connection.watchBrowser(sessionId: current, on: true) { session?.screen = page }
			}
		}
	}

	// MARK: Derived

	public var places: [Place] { EnrichedLabKit.places(sites) }

	public func place(of id: String?) -> Place { EnrichedLabKit.place(of: id, in: places) }

	public func model(_ ref: String?) -> ModelInfo? { models.first { $0.ref == ref } }

	public func allowed(site: String?) -> [ModelInfo] { allowedModels(models, sites: sites, site: site) }

	/// Sessions grouped by project folder, the newest project first.
	public var projects: [(folder: String, sessions: [SessionSummary])] {
		var order: [String] = []
		var byFolder: [String: [SessionSummary]] = [:]
		for session in sessions where session.parent == nil {
			let folder = projectFolder(session.cwd)
			if byFolder[folder] == nil { order.append(folder) }
			byFolder[folder, default: []].append(session)
		}
		return order.map { ($0, byFolder[$0] ?? []) }
	}

	// MARK: Messages

	public func say(_ text: String, url: URL? = nil) {
		toast = Toast(text: text, url: url)
		toastTimer?.cancel()
		toastTimer = Task { [weak self] in
			try? await Task.sleep(for: .seconds(url == nil ? 6 : 20))
			guard !Task.isCancelled else { return }
			self?.toast = nil
		}
	}

	func said(_ error: any Error, prefix: String? = nil) {
		let text = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
		say(prefix.map { "\($0): \(text)" } ?? text)
	}

	// MARK: Sessions

	private func open(_ id: String?, force: Bool = false) async {
		if let current = session, current.id != id {
			let leaving = current.id
			Task { try? await connection.closeSession(leaving) }
			session?.save()
		}
		guard let id else { session = nil; return }
		if !force, session?.id == id { return }
		openGeneration += 1
		let generation = openGeneration
		// Events and questions that arrive while the snapshot is on its way are held and joined after it.
		let target = session?.id == id ? session! : SessionModel(id: id, app: self)
		target.opening = true
		if session?.id != id { session = target }
		do {
			let snapshot = try await connection.openSession(id)
			guard generation == openGeneration else { return }
			target.apply(snapshot)
			target.canvases = (try? await connection.canvases(sessionId: id)) ?? []
			guard generation == openGeneration else { return }
			target.restoreWorkbench()
			session = target
		} catch {
			guard generation == openGeneration else { return }
			// A session that won't open (deleted elsewhere, the engine gone) leaves the window on New Session, saying why.
			said(error, prefix: "That session didn't open")
			session = nil
			if selection == id { selection = nil }
		}
	}

	/// Start a session; a `prompt` runs as the first turn once the session is in its place.
	@discardableResult
	public func create(folder: URL, place: String, model: String?, prompt: String?, images: [Part]? = nil) async -> String? {
		// Work on this computer starts in a folder the person has answered for (asked once per folder).
		if place == "local" || !(sites.first { $0.name == place }?.isolated ?? false), !(await askFolder(folder)) { return nil }
		var made: String?
		// A lab that keeps its data inside binds the session to it from the start: its models, its sandbox.
		let isolated = sites.first { $0.name == place }?.isolated == true
		do {
			var summary = try await connection.createSession(cwd: folder.path, model: model, site: isolated ? place : nil)
			made = summary.id
			if place != "local", !isolated, summary.place != place {
				summary = try await connection.moveSession(summary.id, to: place).summary
			}
			upsert(summary)
		} catch {
			// A session that never reached its place is removed, so the task never runs somewhere else by mistake.
			if let made { Task { try? await connection.deleteSession(made) } }
			said(error)
			return nil
		}
		UserDefaults.standard.set(folder, forKey: "newFolder")
		guard let id = made else { return nil }
		selection = id
		if let prompt, !prompt.isEmpty {
			do {
				try await connection.prompt(id, text: prompt, images: images)
			} catch {
				said(error, prefix: "The task didn't start")
				session?.draft = prompt
			}
		}
		return id
	}

	public func beginNew(place: String? = nil, folder: URL? = nil) {
		if let place { newPlace = place }
		if let folder { newFolder = folder }
		selection = nil
	}

	public func rename(_ id: String, to title: String) async -> Bool {
		let clean = title.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !clean.isEmpty else { return false }
		do {
			try await connection.rename(id, title: clean)
		} catch {
			said(error, prefix: "The new name didn't save")
			return false
		}
		if var summary = sessions.first(where: { $0.id == id }) {
			summary.title = clean
			upsert(summary)
		}
		return true
	}

	public func confirmDelete(_ id: String) {
		guard let summary = sessions.first(where: { $0.id == id }) else { return }
		confirmation = Confirmation(
			title: "Delete “\(summary.title)”?",
			detail: "Its conversation and outputs are removed from this computer. Files in the project folder stay as they are.",
			action: "Delete"
		) { [weak self] in
			guard let self else { return }
			do {
				try await connection.deleteSession(id)
				sessions.removeAll { $0.id == id }
				if selection == id { selection = nil }
			} catch {
				said(error)
			}
		}
	}

	public func loadOlderSessions() async {
		sessionLimit += 200
		if let list = try? await connection.sessions(limit: sessionLimit) { sessions = list }
	}

	func upsert(_ summary: SessionSummary) {
		sessions.removeAll { $0.id == summary.id }
		sessions.append(summary)
		sessions.sort { $0.updated > $1.updated }
		if session?.id == summary.id { session?.summary = summary }
	}

	// MARK: Labs and models

	/// An invite link (enrichedlab://join?url=…&name=…&title=…&isolated=1) opens Add a Lab with it filled in.
	public func openInvite(_ url: URL) {
		guard url.scheme == "enrichedlab", let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
		let value = { (name: String) in parts.queryItems?.first { $0.name == name }?.value ?? "" }
		joining = JoinRequest(url: value("url"), name: value("name"), title: value("title"), isolated: value("isolated") == "1")
	}

	/// Add a lab from an invite, then sign in to it.
	public func join(_ request: JoinRequest) async -> String? {
		do {
			let site = try await connection.addSite(name: request.name, url: request.url, title: request.title.isEmpty ? nil : request.title, isolated: request.isolated ? true : nil)
			await refreshModels()
			if !site.signedIn { _ = await signIn(site.name) }
			return nil
		} catch {
			return (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
		}
	}

	public func signIn(_ name: String) async -> Bool {
		do {
			let site = try await connection.signIn(name)
			say(site.signedIn ? "Signed in to \(site.displayTitle) as \(site.who ?? "you")." : "Not signed in: \(site.error ?? "the sign-in didn't finish").")
			await refreshModels()
			return site.signedIn
		} catch {
			said(error)
			return false
		}
	}

	public func signOut(_ name: String) async {
		do {
			try await connection.signOut(name)
			await refreshModels()
			say("Signed out of \(sites.first { $0.name == name }?.displayTitle ?? name).")
		} catch {
			said(error)
		}
	}

	public func confirmRemoveLab(_ name: String) {
		let title = sites.first { $0.name == name }?.displayTitle ?? name
		confirmation = Confirmation(
			title: "Remove \(title)?",
			detail: "You're signed out of \(title) and it leaves this computer. Its sessions stay here, without its models and tools. You can add it again from its invite.",
			action: "Remove"
		) { [weak self] in
			guard let self else { return }
			do {
				try await connection.removeSite(name)
				await refreshModels()
				say("Removed \(title).")
			} catch {
				said(error)
			}
		}
	}

	public func reconnectLabs() async {
		do {
			sites = try await connection.refreshSites()
			let list = try await connection.models(refresh: true)
			models = list.models
			defaultModel = list.default
		} catch {
			said(error)
		}
	}

	public func refreshModels() async {
		if let list = try? await connection.models(refresh: true) {
			models = list.models
			defaultModel = list.default
		}
		if let labs = try? await connection.sites() { sites = labs }
	}

	public func setTheme(_ theme: String) async {
		let before = ui
		ui.theme = theme
		do { ui = try await connection.setUiPrefs(theme: theme) } catch {
			ui = before
			said(error, prefix: "Couldn't save that setting")
		}
	}

	/// How much new sessions ask.
	public func setDefaultPermissions(_ mode: PermissionMode) async {
		let before = ui
		ui.permissions = mode.rawValue
		do { ui = try await connection.setUiPrefs(permissions: mode) } catch {
			ui = before
			said(error, prefix: "Couldn't save that setting")
		}
	}

	/// Who writes reasoning summaries ("" for automatic), and whether they're written.
	public func setSummaries(model: String? = nil, on: Bool? = nil) async {
		do { ui = try await connection.setUiPrefs(summaryModel: model, reasoningSummaries: on) } catch {
			said(error, prefix: "Couldn't save that setting")
		}
	}

	/// The question asked once when a folder is added: may EnrichedLab change files there, or only read them.
	public var folderQuestion: FolderQuestion?

	/// Ask about a folder the person hasn't answered for yet; true once it may be used (changed or read).
	public func askFolder(_ folder: URL) async -> Bool {
		if let known = try? await connection.folderAccess(folder.path), known != nil { return true }
		// Listing it now brings up any macOS privacy prompt for the folder at the start, not halfway through a task.
		_ = try? FileManager.default.contentsOfDirectory(atPath: folder.path)
		// One question at a time: a newer one answers an older, unanswered one with cancel.
		folderQuestion?.respond(nil)
		let answer: FolderAccess? = await withCheckedContinuation { continuation in
			folderQuestion = FolderQuestion(folder: folder) { continuation.resume(returning: $0) }
		}
		folderQuestion = nil
		guard let answer else { return false }
		do {
			_ = try await connection.folderAccess(folder.path, set: answer.rawValue)
			return true
		} catch {
			said(error, prefix: "Couldn't save your answer for that folder")
			return false
		}
	}

	public func setShowReasoning(_ on: Bool) async {
		let before = ui
		ui.showReasoning = on
		do { ui = try await connection.setUiPrefs(showReasoning: on) } catch {
			ui = before
			said(error, prefix: "Couldn't save that setting")
		}
	}

	// MARK: Desktop

	public func desktopAct(site: String, action: [String: JSONValue]) async {
		desktopBusy.insert(site)
		defer { desktopBusy.remove(site) }
		do {
			let answer = try await connection.desktopAct(site: site, action: action)
			if let frame = answer.frame { desktops[site] = frame }
		} catch {
			said(error)
		}
	}

	public private(set) var desktopUpdating: Set<String> = []

	/// Move an outdated lab desktop to the lab's current one, keeping its files; then a fresh picture.
	public func desktopUpdate(site: String) async {
		desktopUpdating.insert(site)
		defer { desktopUpdating.remove(site) }
		do {
			try await connection.updateDesktop(site: site)
			sites = (try? await connection.sites()) ?? sites
			await desktopAct(site: site, action: ["action": "screenshot"])
		} catch {
			said(error, prefix: "The desktop didn't update")
		}
	}

	/// Watch a lab desktop live while a pane shows it (where the lab streams it).
	public func watchDesktop(_ site: String) {
		desktopWatchers[site, default: 0] += 1
		guard desktopWatchers[site] == 1 else { return }
		Task { await askDesktopLive(site) }
	}

	public func unwatchDesktop(_ site: String) {
		guard let count = desktopWatchers[site], count > 0 else { return }
		desktopWatchers[site] = count - 1
		guard count == 1 else { return }
		desktopWatchers[site] = nil
		desktopScreens[site] = nil
		desktopLive[site] = DesktopStream(site: site, live: false)
		Task { _ = try? await connection.watchDesktop(site: site, on: false) }
	}

	private func askDesktopLive(_ site: String) async {
		let stream = (try? await connection.watchDesktop(site: site, on: true)) ?? DesktopStream(site: site, live: false)
		if desktopWatchers[site, default: 0] > 0 { desktopLive[site] = stream }
	}

	/// Bands arrive many times a second: the picture is made once per turn of the main loop.
	@ObservationIgnored private var publishing: Set<String> = []
	private func publishDesktop(_ site: String) {
		guard publishing.insert(site).inserted else { return }
		DispatchQueue.main.async { [weak self] in
			MainActor.assumeIsolated {
				guard let self else { return }
				self.publishing.remove(site)
				guard let screen = self.desktopScreens[site], let image = screen.image() else { return }
				self.desktopImages[site] = ("live-\(screen.drawn)", image)
			}
		}
	}

	public func desktopOpen(site: String, target: String) async {
		desktopBusy.insert(site)
		defer { desktopBusy.remove(site) }
		do {
			let answer = try await connection.desktopOpen(site: site, target: target)
			if let frame = answer.frame { desktops[site] = frame }
		} catch {
			said(error)
		}
	}

	// MARK: Apps

	public func refreshApps() async {
		if let list = try? await connection.apps() { apps = list }
		if let offered = try? await connection.labApps() { labApps = offered }
	}

	/// What each lab offers that isn't installed at its newest version: one entry per app.
	public var labOffers: [LabApp] {
		var seen = Set<String>()
		return labApps.filter { app in
			let key = "\(app.site)/\(app.name)"
			guard !seen.contains(key), !app.withdrawn, !app.signerRevoked else { return false }
			seen.insert(key)
			return app.installed != app.version
		}
	}

	// MARK: Notifications

	private func handle(_ note: EngineNotification) {
		switch note.method {
		case "session.event":
			struct P: Decodable { var sessionId: String; var event: SessionEvent }
			guard let p = try? note.decode(P.self) else { return }
			if session?.id == p.sessionId { session?.receive(p.event) }
		case "session.delta":
			struct P: Decodable { var sessionId: String; var kind: String; var text: String; var index: Int?; var name: String?; var callId: String? }
			guard let p = try? note.decode(P.self), session?.id == p.sessionId else { return }
			session?.delta(kind: p.kind, text: p.text, index: p.index, name: p.name, callId: p.callId)
		case "session.status":
			guard let status = try? note.decode(SessionStatus.self), session?.id == status.sessionId else { return }
			session?.update(status)
		case "session.updated":
			if let summary = try? note.decode(SessionSummary.self) { upsert(summary) }
		case "permission.request":
			guard let request = try? note.decode(PermissionRequest.self) else { return }
			// The open session's own questions, and its subagents' (the engine sends those to the lead's windows).
			if let open = session?.id, request.sessionId == open || request.lead == open { session?.ask(request) }
			else { notifyElsewhere(request) }
		case "permission.settled":
			struct P: Decodable { var requestId: String }
			if let p = try? note.decode(P.self) { session?.pending.removeAll { $0.requestId == p.requestId } }
		case "site.updated":
			guard let site = try? note.decode(SiteSummary.self) else { return }
			let before = sites.first { $0.name == site.name }
			if let i = sites.firstIndex(where: { $0.name == site.name }) { sites[i] = site } else { sites.append(site) }
			if before == nil || before?.signedIn != site.signedIn || before?.models != site.models {
				Task { if let list = try? await connection.models() { models = list.models; defaultModel = list.default } }
			}
		case "lab.notice":
			if let notice = try? note.decode(LabNotice.self) { say(notice.text, url: notice.url.flatMap(URL.init(string:))) }
		case "lab.apps.changed":
			Task { await refreshApps() }
		case "lab.device.pending":
			guard let request = try? note.decode(DeviceRequest.self) else { return }
			if !deviceRequests.contains(where: { $0.site == request.site && $0.id == request.id }) { deviceRequests.append(request) }
		case "provider.auth", "site.auth":
			struct P: Decodable { var url: String; var name: String? }
			guard let p = try? note.decode(P.self), let url = URL(string: p.url), ["https", "http"].contains(url.scheme ?? "") else { return }
			NSWorkspace.shared.open(url)
			if note.method == "site.auth" {
				say("Sign in to \(sites.first { $0.name == p.name }?.displayTitle ?? p.name ?? "the lab") in the browser window that opened. The first time, it may ask you to set up a second step: a passkey, a security key or an authenticator app.")
			}
		case "canvas.updated":
			guard let view = try? note.decode(CanvasSummary.self), session?.id == view.sessionId else { return }
			session?.upsertView(view)
		case "ui.updated":
			if let prefs = try? note.decode(UiPrefs.self) { ui = prefs }
		case "browser.page":
			guard let page = try? note.decode(BrowserPageState.self), session?.id == page.sessionId else { return }
			session?.browserPage(page)
		case "browser.frame":
			guard let frame = try? note.decode(BrowserFrame.self), session?.id == frame.sessionId else { return }
			session?.screenFrame = frame
		case "desktop.band":
			guard let band = try? note.decode(DesktopBand.self), desktopWatchers[band.site, default: 0] > 0 else { return }
			let live = desktopLive[band.site]
			let screen = desktopScreens[band.site] ?? DesktopScreen(width: live?.width ?? band.x + band.w, height: live?.height ?? band.y + band.h, under: desktopImages[band.site]?.image)
			desktopScreens[band.site] = screen
			if screen.draw(band) { publishDesktop(band.site) }
		case "desktop.stream":
			guard let stream = try? note.decode(DesktopStream.self) else { return }
			desktopLive[stream.site] = stream
			if !stream.live { desktopScreens[stream.site] = nil }
		case "desktop.frame":
			guard let frame = try? note.decode(DesktopFrame.self) else { return }
			desktops[frame.site] = frame
			if frame.by == "agent", session?.summary.place == frame.site { session?.workbench.show(.desktop(site: frame.site), title: "\(place(of: frame.site).title) desktop", focus: false) }
		case "app.opened":
			struct P: Decodable { var sessionId: String; var app: AppSummary }
			guard let p = try? note.decode(P.self), session?.id == p.sessionId else { return }
			if !apps.contains(where: { $0.id == p.app.id }) { apps.append(p.app) }
			session?.workbench.show(.app(id: p.app.id), title: p.app.title)
		case "surface.call":
			struct P: Decodable { var callId: String; var sessionId: String; var capability: String; var op: String; var args: [String: JSONValue] }
			guard let p = try? note.decode(P.self) else { return }
			Task { await self.surfaceCall(callId: p.callId, sessionId: p.sessionId, capability: p.capability, op: p.op, args: p.args) }
		case "term.output":
			struct P: Decodable { var termId: String; var data: String }
			if let p = try? note.decode(P.self) { terminals.output(p.termId, p.data) }
		case "term.exit":
			struct P: Decodable { var termId: String; var code: Int? }
			if let p = try? note.decode(P.self) { terminals.exited(p.termId, code: p.code) }
		case "update.available":
			if let status = try? note.decode(UpdateStatus.self), let latest = status.latest { say("EnrichedLab \(latest) is ready to install. Choose EnrichedLab › Check for Updates.") }
		default:
			break
		}
	}

	/// A question in a session that isn't open: a notification the person can act on.
	private func notifyElsewhere(_ request: PermissionRequest) {
		let title = sessions.first { $0.id == request.sessionId }?.title ?? "Another session"
		say("“\(title)” is waiting for you: \(request.view.verb) \(request.view.target)")
	}

	/// The agent's use of the browser pane: open (or reuse) one and act on its page.
	private func surfaceCall(callId: String, sessionId: String, capability: String, op: String, args: [String: JSONValue]) async {
		guard capability == "browser" else {
			try? await connection.surfaceReply(callId: callId, result: nil, error: "This window can't do \(capability).")
			return
		}
		if selection != sessionId { selection = sessionId }
		for _ in 0 ..< 50 where session?.id != sessionId || session?.opening == true { try? await Task.sleep(for: .milliseconds(100)) }
		guard let session, session.id == sessionId else {
			try? await connection.surfaceReply(callId: callId, result: nil, error: "The session's window isn't open.")
			return
		}
		do {
			let answer = try await session.browser.agent(op: op, args: args, show: { session.workbench.show(.browser, title: "Browser") })
			try await connection.surfaceReply(callId: callId, result: answer, error: nil)
		} catch {
			try? await connection.surfaceReply(callId: callId, result: nil, error: (error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
		}
	}
}

/// An invite being joined, from an enrichedlab://join link or Add a Lab.
public struct JoinRequest: Identifiable, Equatable {
	public let id = UUID()
	public var url: String = ""
	public var name: String = ""
	public var title: String = ""
	public var isolated = false
}

public enum SettingsTab: String, Hashable, CaseIterable {
	case general, models, labs, updates
}

/// The project a session works in: its own folder, or the repository a worktree session branched from.
func projectFolder(_ cwd: String) -> String {
	if let range = cwd.range(of: "/.git/enrichedlab-worktrees/") { return String(cwd[..<range.lowerBound]) }
	return cwd
}

/// A folder waiting on the person's answer: change its files, only read them, or nil when they cancelled. Answered
/// once: a second answer (the alert closing after a button) is ignored.
public final class FolderQuestion: Identifiable {
	public let folder: URL
	private var answer: ((FolderAccess?) -> Void)?
	public var id: String { folder.path }

	init(folder: URL, answer: @escaping (FolderAccess?) -> Void) {
		self.folder = folder
		self.answer = answer
	}

	public func respond(_ access: FolderAccess?) {
		let pending = answer
		answer = nil
		pending?(access)
	}
}
