import EnrichedLabKit
import SwiftUI

// The timeline (docs/design.md, "Timeline"): a lab notebook's ledger of every step. Each request heads its steps; a
// time rail runs down the left; the reason a step was taken sits above it in the margin voice, once per message. Open
// a step for its input, output, the files it changed (from step history) and where it came from, and go back to
// before it.

struct TimelinePane: View {
	var session: SessionModel
	@State private var filter: TimelineFilter = .all

	var body: some View {
		let turns = timeline(session.events)
		VStack(spacing: 0) {
			// The summary beside the filter while both fit; under it when the workbench is narrow.
			ViewThatFits(in: .horizontal) {
				HStack(spacing: 12) {
					summary(turns).fixedSize()
					Spacer(minLength: 8)
					filters
				}
				VStack(alignment: .leading, spacing: 6) {
					filters
					summary(turns)
				}
				.frame(maxWidth: .infinity, alignment: .leading)
			}
			.padding(.horizontal, 14)
			.padding(.vertical, 8)
			Rectangle().fill(Theme.rule).frame(height: 1)
			if turns.isEmpty {
				ContentUnavailableView("No Steps Yet", systemImage: "list.bullet.rectangle", description: Text("Each tool the agent uses shows here: why it was used, what went in and came out, the files it changed, and who allowed it."))
			} else {
				let shown = turns.map { turn in (turn, turn.steps.filter(filter.keeps)) }.filter { !$0.1.isEmpty }
				if shown.isEmpty {
					ContentUnavailableView("Nothing \(filter.title)", systemImage: "line.3.horizontal.decrease", description: Text("No step in this session matches. Choose All to see every step."))
				} else {
					ScrollView {
						LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
							ForEach(shown, id: \.0.id) { turn, steps in
								Section {
									ForEach(steps) { step in TimelineRow(step: step, session: session, open: opensFirst(step, in: turns)) }
								} header: {
									TurnHeader(turn: turn)
								}
							}
						}
						.padding(.bottom, 16)
					}
				}
			}
		}
	}

	/// A test scene can open the newest step (EL_SCENE_STEP=last).
	private func opensFirst(_ step: TimelineStep, in turns: [TimelineTurn]) -> Bool {
		#if DEBUG
			return ProcessInfo.processInfo.environment["EL_SCENE_STEP"] == "last" && turns.last?.steps.last?.id == step.id
		#else
			return false
		#endif
	}

	private func summary(_ turns: [TimelineTurn]) -> some View {
		Text(timelineSummary(turns)).font(.callout).foregroundStyle(.secondary).lineLimit(2)
	}

	private var filters: some View {
		Picker("Show", selection: $filter) {
			ForEach(TimelineFilter.allCases) { Text($0.title).tag($0) }
		}
		.pickerStyle(.segmented)
		.labelsHidden()
		.fixedSize()
	}
}

/// A request, in the person's words, heading the steps it led to.
private struct TurnHeader: View {
	var turn: TimelineTurn

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: 10) {
			Text(turn.request.isEmpty ? "Before the first request" : turn.request)
				.font(.callout.weight(.semibold))
				.foregroundStyle(Theme.text)
				.lineLimit(2)
			Spacer(minLength: 8)
			if let at = turn.at { Text(clock(at)).font(.caption.monospacedDigit()).foregroundStyle(.tertiary) }
		}
		.padding(.horizontal, 14)
		.padding(.top, 12)
		.padding(.bottom, 8)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(Theme.surface)
		.overlay(alignment: .bottom) { Rectangle().fill(Theme.rule).frame(height: 1) }
		.accessibilityAddTraits(.isHeader)
	}
}

private struct TimelineRow: View {
	@Environment(AppModel.self) private var app
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	var step: TimelineStep
	var session: SessionModel
	@State private var open: Bool

	init(step: TimelineStep, session: SessionModel, open: Bool = false) {
		self.step = step
		self.session = session
		_open = State(initialValue: open)
	}

	var body: some View {
		HStack(alignment: .top, spacing: 10) {
			Text(step.ended.map(clock) ?? "")
				.font(.caption.monospacedDigit())
				.foregroundStyle(.tertiary)
				.frame(width: 62, alignment: .trailing)
				.padding(.top, step.leads && step.why != nil ? 24 : 5)
			// The rail: one line through every step, a mark at each.
			ZStack(alignment: .top) {
				Rectangle().fill(Theme.rule).frame(width: 1).frame(maxHeight: .infinity)
				Circle().fill(markColor).frame(width: 7, height: 7).padding(.top, step.leads && step.why != nil ? 26 : 7)
			}
			.frame(width: 9)
			VStack(alignment: .leading, spacing: 4) {
				if step.leads, let why = step.why {
					Text(why).font(.callout).foregroundStyle(.secondary).lineLimit(open ? nil : 2)
				}
				Button {
					withAnimation(reduceMotion ? nil : .smooth(duration: 0.18)) { open.toggle() }
				} label: {
					HStack(alignment: .firstTextBaseline, spacing: 8) {
						Text(step.verb).font(Theme.mono).foregroundStyle(.secondary).fixedSize()
						Text(step.target).font(Theme.mono).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.middle)
						Spacer(minLength: 8)
						Text(meta).font(.caption).foregroundStyle(step.tool.ok ? AnyShapeStyle(.secondary) : AnyShapeStyle(Theme.bad)).lineLimit(1).fixedSize()
						Image(systemName: "chevron.right")
							.font(.caption2.weight(.semibold))
							.foregroundStyle(.tertiary)
							.rotationEffect(.degrees(open ? 90 : 0))
					}
					.contentShape(Rectangle())
				}
				.buttonStyle(.plain)
				.accessibilityLabel("\(step.verb) \(step.target), \(meta)")
				.accessibilityHint(open ? "Hides the details" : "Shows input, output and files changed")
				if open { StepDetail(step: step, session: session).transition(.opacity) }
			}
			.padding(.vertical, 6)
			.padding(.trailing, 14)
		}
		.padding(.leading, 4)
		.contextMenu {
			Button("Go Back to Before This Step") { session.confirmRewind(before: step.id, retry: false) }.disabled(session.busy)
			Button("Try Again From Here…") { session.confirmRewind(before: step.id, retry: true) }.disabled(session.busy || !session.place.isLocal)
			if !session.place.isLocal {
				Button("Go Back the Whole Sandbox…") { session.confirmRewind(before: step.id, retry: false, whole: true) }.disabled(session.busy)
			}
			Divider()
			Button("Copy Input") { copyText(step.input, what: "the input", app: app) }
			Button("Copy Output") { copyText(step.tool.content, what: "the output", app: app) }
		}
	}

	private var markColor: Color {
		if !step.tool.ok { return Theme.bad }
		if step.asked { return Theme.warn }
		return step.kind == .read ? Theme.rule : Theme.accentText
	}

	private var meta: String {
		let took = step.seconds.map { $0 < 1 ? "under 1 s" : durationText($0) }
		return [step.tool.ok ? nil : "failed", step.asked || step.tool.decision == "refused" ? step.permission : nil, took].compactMap { $0 }.joined(separator: " · ")
	}
}

/// A step opened: why, what went in, what came out, the files it changed, and where it came from.
private struct StepDetail: View {
	@Environment(AppModel.self) private var app
	var step: TimelineStep
	var session: SessionModel
	@State private var files: EngineConnection.StepFiles?
	@State private var loaded = false

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			if let reasoning = step.reasoning, step.leads {
				DisclosureGroup("Full reasoning") {
					Text(reasoning).font(.callout).foregroundStyle(.secondary).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
				}
				.font(.caption)
			}
			box("Input", step.input.isEmpty ? "No input" : step.input)
			box("Output", output)
			VStack(alignment: .leading, spacing: 3) {
				label("Files changed")
				if !loaded {
					ProgressView().controlSize(.small)
				} else if let files, !files.files.isEmpty {
					ForEach(files.files.prefix(50), id: \.self) { Text($0).font(Theme.mono).textSelection(.enabled) }
					if files.files.count > 50 { Text("and \(files.files.count - 50) more").font(.caption).foregroundStyle(.secondary) }
					if files.with > 1 { Text("Ran together with \(files.with - 1) other step\(files.with == 2 ? "" : "s"); these are their changes together.").font(.caption).foregroundStyle(.secondary) }
				} else {
					Text(files?.history == false ? "Not kept in step history (an older session, or the history was off)." : "None.").font(.caption).foregroundStyle(.secondary)
				}
			}
			Text(provenance).font(.caption).foregroundStyle(.tertiary).textSelection(.enabled)
			HStack(spacing: 12) {
				Button("Go Back to Before This Step") { session.confirmRewind(before: step.id, retry: false) }
					.disabled(session.busy)
				Button("Copy Input") { copyText(step.input, what: "the input", app: app) }.buttonStyle(.borderless)
				Button("Copy Output") { copyText(step.tool.content, what: "the output", app: app) }.buttonStyle(.borderless)
			}
			.controlSize(.small)
		}
		.padding(.top, 4)
		.padding(.bottom, 6)
		.task(id: step.id) {
			files = await session.stepFiles(step.id)
			loaded = true
		}
	}

	private var output: String {
		let text = step.tool.view?.detail ?? step.tool.content
		if text.isEmpty { return "No output" }
		return text.count > 6000 ? "\(text.prefix(6000))\n[…] Copy Output for all of it." : text
	}

	private var provenance: String {
		var parts: [String] = []
		if !step.model.isEmpty { parts.append(step.model) }
		if let started = step.started { parts.append("asked at \(clock(started))") }
		parts.append(step.permission)
		parts.append("step \(step.id)")
		if let commit = files?.commit { parts.append("history \(commit.prefix(10))") }
		return parts.joined(separator: " · ")
	}

	private func label(_ text: String) -> some View {
		Text(text).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
	}

	private func box(_ title: String, _ text: String) -> some View {
		VStack(alignment: .leading, spacing: 3) {
			label(title)
			ScrollView {
				Text(text)
					.font(Theme.mono)
					.foregroundStyle(Theme.text)
					.textSelection(.enabled)
					.frame(maxWidth: .infinity, alignment: .leading)
					.padding(8)
			}
			.frame(maxHeight: 200)
			.fixedSize(horizontal: false, vertical: true)
			.background(Theme.canvas, in: RoundedRectangle(cornerRadius: 6))
			.overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.rule))
		}
	}
}

private func clock(_ date: Date) -> String {
	date.formatted(.dateTime.hour().minute().second())
}
