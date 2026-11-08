import EnrichedLabKit
import SwiftUI

/// One stretch of the agent's work: a summary line over its steps. A long finished activity folds to its last steps.
struct ActivityView: View {
	@Environment(AppModel.self) private var app
	var id: String
	var steps: [StepItem]
	var session: SessionModel
	var live: Bool
	@State private var expanded = false

	private var folded: Bool { !live && !expanded && steps.count > 4 }

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			if !live || steps.count > 1 {
				Button {
					withAnimation(.smooth(duration: 0.2)) { expanded.toggle() }
				} label: {
					HStack(spacing: 6) {
						Text(summarize(steps)).font(.callout.weight(.medium)).foregroundStyle(.secondary)
						if steps.count > 4, !live {
							Text(expanded ? "Show fewer" : "Show all \(steps.count)").font(.caption).foregroundStyle(.tertiary)
						}
					}
					.contentShape(Rectangle())
				}
				.buttonStyle(.plain)
				.disabled(steps.count <= 4 || live)
				.padding(.bottom, 6)
			}
			VStack(alignment: .leading, spacing: 0) {
				ForEach(folded ? Array(steps.suffix(3)) : steps) { step in
					StepRow(step: step, session: session)
					Divider().opacity(0.5)
				}
			}
			.overlay(alignment: .leading) {
				Rectangle().fill(.separator).frame(width: 2).padding(.vertical, 2)
			}
		}
	}
}

/// One step on one ruled line: its mark, verb and target, and its result at the right edge. Opens to its output or diff.
struct StepRow: View {
	@Environment(AppModel.self) private var app
	@AppStorage("advanced") private var advanced = false
	var step: StepItem
	var session: SessionModel
	@State private var open = false

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			Button {
				if hasDetail { withAnimation(.smooth(duration: 0.18)) { open.toggle() } }
			} label: {
				HStack(alignment: .firstTextBaseline, spacing: 8) {
					mark
					Text(verb).font(Theme.mono).foregroundStyle(.secondary).fixedSize()
					Text(target)
						.font(Theme.mono)
						.lineLimit(1)
						.truncationMode(.middle)
						.foregroundStyle(.primary)
					if unreviewed {
						Text("Not reviewed by the lab").font(.caption2).foregroundStyle(Theme.warn)
					}
					Spacer(minLength: 8)
					Text(result).font(.caption).foregroundStyle(.secondary).lineLimit(1).fixedSize()
					if hasDetail {
						Image(systemName: "chevron.right")
							.font(.caption2.weight(.semibold))
							.foregroundStyle(.tertiary)
							.rotationEffect(.degrees(open ? 90 : 0))
					}
				}
				.padding(.leading, 12)
				.padding(.vertical, 6)
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.contextMenu { menu }
			.accessibilityElement(children: .combine)
			.accessibilityHint(hasDetail ? "Shows the output" : "")

			if case let .running(_, _, _, waiting) = step, let waiting {
				ApprovalCard(request: waiting, session: session).padding(.leading, 12).padding(.bottom, 8)
			} else if case let .running(id, _, _, _) = step, let output = session.partial.output[id], !output.isEmpty {
				Text(lastLines(output, 6))
					.font(.system(size: 11.5, design: .monospaced))
					.foregroundStyle(.secondary)
					.padding(.leading, 30)
					.padding(.bottom, 6)
					.frame(maxWidth: .infinity, alignment: .leading)
			}
			if case let .done(tool) = step {
				extras(tool)
				if open { DetailView(tool: tool).padding(.leading, 30).padding(.bottom, 8).transition(.opacity) }
			}
		}
	}

	private var view: StepView? { if case let .done(tool) = step { tool.view } else { nil } }

	private var verb: String {
		switch step {
		case let .done(tool): tool.view?.verb ?? tool.name
		case let .running(_, name, _, _): name
		}
	}

	private var target: String {
		switch step {
		case let .done(tool): tool.view?.target ?? ""
		case let .running(_, _, target, _): target
		}
	}

	private var unreviewed: Bool { view?.unreviewed == true || { if case let .running(_, _, _, w) = step { w?.view.unreviewed == true } else { false } }() }

	private var hasDetail: Bool {
		guard case let .done(tool) = step else { return false }
		return tool.view?.diff != nil || tool.view?.detail != nil || (!tool.ok && !tool.content.isEmpty) || (advanced && !tool.content.isEmpty)
	}

	private var result: String {
		switch step {
		case let .done(tool):
			if tool.decision == "denied" { return "declined" }
			return tool.view?.result ?? (tool.ok ? "done" : "failed")
		case let .running(_, _, _, waiting):
			return waiting != nil ? "waiting for you" : "running"
		}
	}

	@ViewBuilder private var mark: some View {
		switch step {
		case let .done(tool):
			if tool.decision == "denied" {
				Image(systemName: "minus.circle").foregroundStyle(.secondary)
			} else if tool.ok {
				Image(systemName: "checkmark").foregroundStyle(Theme.ok)
			} else {
				Image(systemName: "xmark").foregroundStyle(Theme.bad)
			}
		case let .running(_, _, _, waiting):
			// Waiting on the person: the gold notch, edged in Aggie Blue in light so it holds on white (as the web window).
			if waiting != nil {
				RoundedRectangle(cornerRadius: 2)
					.fill(Theme.gold)
					.overlay(RoundedRectangle(cornerRadius: 2).strokeBorder(Theme.accent, lineWidth: 1.5))
					.frame(width: 9, height: 9)
					.rotationEffect(.degrees(45))
					.frame(width: 12, height: 12)
					.accessibilityLabel("Waiting for you")
			}
			else { ProgressView().controlSize(.mini).frame(width: 12, height: 12) }
		}
	}

	@ViewBuilder private func extras(_ tool: SessionEvent.Tool) -> some View {
		if let canvas = tool.view?.canvas, let shown = session.canvases.first(where: { $0.id == canvas }) {
			Button {
				session.showView(shown.id)
			} label: {
				Label(openLabel(shown.kind), systemImage: "arrow.up.forward.square")
			}
			.buttonStyle(.link)
			.font(.callout)
			.padding(.leading, 30)
			.padding(.bottom, 6)
		}
		if let files = tool.view?.files, !files.isEmpty {
			VStack(alignment: .leading, spacing: 4) {
				ForEach(files, id: \.uri) { file in LabFileRow(file: file, session: session) }
			}
			.padding(.leading, 30)
			.padding(.bottom, 6)
		}
	}

	private func openLabel(_ kind: String) -> String {
		["table": "Open Table", "plot": "Open Plot", "page": "Open App", "image": "Open Figure"][kind] ?? "Open View"
	}

	@ViewBuilder private var menu: some View {
		if !target.isEmpty { Button("Copy Command or Path") { copyText(target, what: "the command", app: app) } }
		if case let .done(tool) = step, let output = tool.view?.detail ?? (tool.content.isEmpty ? nil : tool.content) {
			Button("Copy Output") { copyText(output, what: "the output", app: app) }
		}
		// Every step is kept in history: the folder can go back to how it was before this one ran.
		if case let .done(tool) = step {
			Divider()
			Button("Go Back to Before This Step") { session.confirmRewind(before: tool.id, retry: false) }
				.disabled(session.busy)
			Button("Try Again From Here…") { session.confirmRewind(before: tool.id, retry: true) }
				.disabled(session.busy || !session.place.isLocal)
		}
	}

	private func lastLines(_ text: String, _ n: Int) -> String {
		text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n", omittingEmptySubsequences: false).suffix(n).joined(separator: "\n")
	}
}

/// A step's output or diff, opened.
private struct DetailView: View {
	var tool: SessionEvent.Tool

	var body: some View {
		if let diff = tool.view?.diff {
			ScrollView(.horizontal) {
				VStack(alignment: .leading, spacing: 0) {
					ForEach(Array(diffLines(diff).enumerated()), id: \.offset) { _, line in
						Text(line.isEmpty ? " " : line)
							.font(.system(size: 11.5, design: .monospaced))
							.foregroundStyle(line.hasPrefix("+") ? AnyShapeStyle(Theme.ok) : line.hasPrefix("-") ? AnyShapeStyle(Theme.bad) : line.hasPrefix("@@") ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
							.frame(maxWidth: .infinity, alignment: .leading)
							.background(line.hasPrefix("+") ? Theme.ok.opacity(0.1) : line.hasPrefix("-") ? Theme.bad.opacity(0.1) : .clear)
					}
				}
				.padding(10)
			}
			.background(Theme.surface, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
			.textSelection(.enabled)
		} else {
			let output = tool.view?.detail ?? tool.content
			ScrollView {
				Text(output.count > 20_000 ? String(output.prefix(20_000)) + "\n…" : output)
					.font(.system(size: 11.5, design: .monospaced))
					.foregroundStyle(tool.ok ? AnyShapeStyle(.secondary) : AnyShapeStyle(Theme.bad))
					.textSelection(.enabled)
					.frame(maxWidth: .infinity, alignment: .leading)
					.padding(10)
			}
			.frame(maxHeight: 320)
			.background(Theme.surface, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
		}
	}

	private func diffLines(_ diff: String) -> [String] {
		diff.split(separator: "\n", omittingEmptySubsequences: false).map(String.init).filter { !$0.hasPrefix("---") && !$0.hasPrefix("+++") }
	}
}

/// A file a lab tool returned by reference: its size and checksum, saved into the project on request.
private struct LabFileRow: View {
	@Environment(AppModel.self) private var app
	var file: FileRef
	var session: SessionModel
	@State private var saving = false
	@State private var saved: String?

	var body: some View {
		HStack(spacing: 8) {
			Image(systemName: "doc").foregroundStyle(.secondary)
			Text(file.name).font(.callout)
			if let bytes = file.bytes { Text(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)).font(.caption).foregroundStyle(.secondary) }
			Spacer()
			if let saved {
				Text(saved).font(.caption).foregroundStyle(.secondary).lineLimit(1)
			} else {
				Button(saving ? "Saving…" : "Save to Project") {
					Task {
						saving = true
						defer { saving = false }
						do { saved = "Saved as \(try await app.connection.saveLabFile(sessionId: session.id, uri: file.uri, name: file.name, sha256: file.sha256))" } catch { app.said(error) }
					}
				}
				.disabled(saving)
				.controlSize(.small)
			}
		}
	}
}

/// A question at its step: exactly what would run or change, then Decline, Allow for This Session, Allow.
struct ApprovalCard: View {
	@Environment(AppModel.self) private var app
	var request: PermissionRequest
	var session: SessionModel
	@State private var answering = false

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			Text(request.reason).font(.callout).fixedSize(horizontal: false, vertical: true)
			if !request.view.target.isEmpty {
				Text(request.view.target)
					.font(.system(size: 12, design: .monospaced))
					.textSelection(.enabled)
					.padding(8)
					.frame(maxWidth: .infinity, alignment: .leading)
					.background(Theme.surface2, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
			}
			if let diff = request.view.diff, !diff.isEmpty {
				ScrollView {
					Text(diff).font(.system(size: 11.5, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
				}
				.frame(maxHeight: 200)
				.padding(8)
				.background(Theme.surface2, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
			}
			if request.view.unreviewed == true {
				Text("This lab tool hasn't been reviewed by the lab yet.").font(.caption).foregroundStyle(Theme.warn)
			}
			// No Return or Escape shortcuts: a stray key in the composer must never answer a question.
			ViewThatFits(in: .horizontal) {
				HStack(spacing: 8) {
					Button("Decline") { answer(.deny) }
					Spacer(minLength: 8)
					remembering
					Button("Allow Once") { answer(.allow) }
						.buttonStyle(.borderedProminent)
				}
				VStack(alignment: .trailing, spacing: 8) {
					HStack(spacing: 8) {
						Button("Decline") { answer(.deny) }
						Spacer(minLength: 8)
						Button("Allow Once") { answer(.allow) }
							.buttonStyle(.borderedProminent)
					}
					remembering
				}
			}
			.fixedSize(horizontal: false, vertical: true)
			.disabled(answering)
		}
		.padding(12)
		.background(Theme.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
		.overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.accent.opacity(0.5)))
		.accessibilityElement(children: .contain)
		.accessibilityLabel("Question: \(request.reason)")
	}

	/// The answer that's remembered, saying exactly what it covers: this folder from now on, or a kind of step for
	/// the rest of the session.
	@ViewBuilder private var remembering: some View {
		if let folder = request.folder {
			Button("Allow Changes in “\(URL(fileURLWithPath: folder).lastPathComponent)”") { answer(.allowFolder) }
				.help("From now on, in every session: file changes in \(shortPath(folder)) run without asking. Each one is kept in history.")
		} else if request.once != true, let scope = request.scope {
			Button("Allow \(scope) This Session") { answer(.allowSession) }
				.help("For the rest of this session, \(scope) run without asking.")
		}
	}

	private func answer(_ decision: PermissionDecision) {
		answering = true
		Task {
			await session.answer(request, decision)
			answering = false
		}
	}
}
