import EnrichedLabKit
import SwiftUI
import Textual

/// The run sheet: the person's request, the agent's thinking, its steps as one activity per stretch of work, and its
/// answer, typeset for reading. It follows new output while the reader is at the bottom, and stays put once the reader
/// scrolls up; scrolling back to the bottom, or sending a message, follows again.
struct TranscriptView: View {
	@Environment(AppModel.self) private var app
	var session: SessionModel
	@State private var position = ScrollPosition(edge: .bottom)
	@State private var pinned = true

	var body: some View {
		ScrollView {
			LazyVStack(alignment: .leading, spacing: 18) {
				ForEach(session.blocks) { block in
					BlockView(block: block, session: session)
				}
				if session.busy || !session.partial.text.isEmpty {
					LiveView(session: session)
				}
				if !session.busy, session.blocks.isEmpty, !session.opening {
					EmptySessionView(session: session)
				}
			}
			.frame(maxWidth: Theme.measure, alignment: .leading)
			.padding(.horizontal, 32)
			.padding(.top, 28)
			.padding(.bottom, 24)
			.frame(maxWidth: .infinity)
		}
		.scrollPosition($position)
		.defaultScrollAnchor(.bottom, for: .initialOffset)
		// Content growing (a tall step, streamed output, a question) never unpins: only the reader moving up does.
		// While pinned, any growth scrolls to the new bottom, whatever grew.
		.onScrollGeometryChange(for: Scroll.self) { geometry in
			Scroll(offset: geometry.contentOffset.y, height: geometry.contentSize.height, gap: geometry.contentSize.height - geometry.contentOffset.y - geometry.containerSize.height)
		} action: { old, new in
			if new.gap < 96 {
				pinned = true
			} else if new.offset < old.offset - 1 {
				// Growth moves the bottom, never the top: an offset that went up is the reader looking back.
				pinned = false
				return
			}
			if pinned, new.gap > 0.5, new.height != old.height { position.scrollTo(edge: .bottom) }
		}
		// Sending a message follows again, wherever the reader was. (A reconnect reloading the session doesn't.)
		.onChange(of: session.sentAt) {
			pinned = true
			position.scrollTo(edge: .bottom)
		}
		.onChange(of: session.pending.count) { follow() }
		.overlay(alignment: .bottomTrailing) {
			if !pinned {
				Button {
					withAnimation(.smooth) { position.scrollTo(edge: .bottom) }
				} label: {
					Label("Jump to Latest", systemImage: "arrow.down")
						.labelStyle(.iconOnly)
						.frame(width: 28, height: 28)
				}
				.buttonStyle(.plain)
				.glass(in: Circle(), interactive: true)
				.padding(16)
				.help("Jump to latest")
				.transition(.opacity.combined(with: .scale(scale: 0.9)))
			}
		}
	}

	private func follow() {
		guard pinned else { return }
		position.scrollTo(edge: .bottom)
	}

	private struct Scroll: Equatable {
		var offset: CGFloat
		var height: CGFloat
		var gap: CGFloat
	}
}

/// A session with nothing in it yet: where it works, in a line.
private struct EmptySessionView: View {
	var session: SessionModel

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			Text("Ready in \(folderName(session.summary.cwd))").font(.title3.weight(.semibold))
			Text("\(session.place.isLocal ? "Runs on This Mac, contained to the project folder." : "Runs in the \(session.place.title) sandbox.") Ask for anything below.")
				.foregroundStyle(.secondary)
		}
		.padding(.top, 40)
	}
}

/// One block of the run sheet.
struct BlockView: View {
	@Environment(AppModel.self) private var app
	var block: Block
	var session: SessionModel

	var body: some View {
		switch block {
		case let .prompt(_, text, images):
			VStack(alignment: .leading, spacing: 6) {
				Text(text)
					.font(Theme.prompt)
					.foregroundStyle(Theme.promptText)
					.textSelection(.enabled)
					.fixedSize(horizontal: false, vertical: true)
				if images > 0 {
					Label("\(images) image\(images == 1 ? "" : "s")", systemImage: "photo")
						.font(.caption)
						.foregroundStyle(.secondary)
				}
			}
			.padding(.top, 10)
			.contextMenu { Button("Copy Request") { copyText(text, what: "the request", app: app) } }
		case let .thinking(_, text, summary, seconds):
			if app.ui.showReasoning { ThinkingView(text: text, summary: summary, seconds: seconds) }
		case let .activity(id, steps):
			ActivityView(id: id, steps: steps, session: session, live: session.busy && isLast)
		case let .answer(_, text, error, stop):
			AnswerView(text: text, error: error, stop: stop)
		case let .notice(_, level, text):
			Label(text, systemImage: level == "error" ? "exclamationmark.octagon" : level == "warn" ? "exclamationmark.triangle" : "info.circle")
				.font(.callout)
				.foregroundStyle(level == "error" ? AnyShapeStyle(Theme.bad) : level == "warn" ? AnyShapeStyle(Theme.warn) : AnyShapeStyle(.secondary))
				.textSelection(.enabled)
		case let .rule(_, text):
			HStack(spacing: 10) {
				// The text shortens in the middle in a narrow window rather than setting the run sheet's width.
				Rectangle().fill(.separator).frame(minWidth: 12, maxHeight: 1)
				Text(text).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle).layoutPriority(1).help(text)
				Rectangle().fill(.separator).frame(minWidth: 12, maxHeight: 1)
			}
			.padding(.vertical, 4)
		}
	}

	private var isLast: Bool {
		session.blocks.last(where: { if case .activity = $0 { true } else { false } })?.id == block.id
	}
}

/// The agent's thinking: folded to its time and summary; the full text a click away.
struct ThinkingView: View {
	var text: String
	var summary: String?
	var seconds: Double?
	@State private var open = false

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			Button {
				withAnimation(.smooth(duration: 0.2)) { open.toggle() }
			} label: {
				HStack(alignment: .firstTextBaseline, spacing: 6) {
					Image(systemName: "chevron.right")
						.font(.caption2.weight(.semibold))
						.rotationEffect(.degrees(open ? 90 : 0))
						.foregroundStyle(.tertiary)
					Text(seconds.map { "Thought for \(durationText($0))" } ?? "Thought").foregroundStyle(.secondary)
					if let summary, !open {
						Text(summary).foregroundStyle(.tertiary).lineLimit(1)
					}
				}
				.font(.callout)
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.accessibilityLabel(open ? "Hide thinking" : "Show thinking")
			if open {
				VStack(alignment: .leading, spacing: 8) {
					if let summary { Text(summary).font(.callout.weight(.medium)).foregroundStyle(.secondary) }
					Text(text)
						.font(.callout)
						.foregroundStyle(.secondary)
						.lineSpacing(3)
						.textSelection(.enabled)
						.fixedSize(horizontal: false, vertical: true)
				}
				.padding(.leading, 16)
				.transition(.opacity)
			}
		}
	}
}

func durationText(_ seconds: Double) -> String {
	let s = Int(seconds.rounded())
	return s < 60 ? "\(max(1, s)) s" : "\(s / 60) min \(s % 60) s"
}

/// The agent's answer: Markdown typeset for reading, with code blocks you can copy.
struct AnswerView: View {
	var text: String
	var error: String?
	var stop: String

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			if !text.isEmpty {
				MarkdownText(text: text)
			}
			if stop == "error" {
				Label(error ?? "The model stopped with an error.", systemImage: "exclamationmark.octagon")
					.font(.callout)
					.foregroundStyle(Theme.bad)
					.textSelection(.enabled)
			} else if stop == "cancelled" {
				Text("Stopped.").font(.callout).foregroundStyle(.secondary)
			} else if stop == "length" {
				Text("The answer reached the model's length limit.").font(.callout).foregroundStyle(.secondary)
			}
		}
	}
}

/// Markdown in the run sheet's type: GitHub-like blocks at the reading size, code blocks with a language and Copy.
struct MarkdownText: View {
	var text: String

	var body: some View {
		StructuredText(markdown: text)
			.font(Theme.prose)
			.textual.codeBlockStyle(RunSheetCodeBlock())
			// UC Davis colors for links, inline code, tables and quotes; the rest of GitHub's layout stays.
			.textual.inlineStyle(InlineStyle().code(.monospaced, .fontScale(0.85), .backgroundColor(DynamicColor(Theme.surface2))).strong(.fontWeight(.semibold)).link(.foregroundColor(DynamicColor(Theme.accentText))))
			.textual.tableStyle(RunSheetTable())
			.textual.blockQuoteStyle(RunSheetQuote())
			.textual.structuredTextStyle(.gitHub)
			.textual.textSelection(.enabled)
			.fixedSize(horizontal: false, vertical: true)
	}
}

/// A table: hairline rules and every other row striped, in the theme's colors.
struct RunSheetTable: StructuredText.TableStyle {
	func makeBody(configuration: Configuration) -> some View {
		configuration.label
			.textual.tableCellSpacing(horizontal: 1, vertical: 1)
			.textual.blockSpacing(.init(top: 0, bottom: 16))
			.textual.tableBackground { layout in
				Canvas { context, _ in
					for row in layout.rowIndices.dropFirst() where row.isMultiple(of: 2) {
						context.fill(Path(layout.rowBounds(row).integral), with: .color(Theme.surface))
					}
				}
			}
			.textual.tableOverlay { layout in
				Canvas { context, _ in
					for divider in layout.dividers() { context.fill(Path(divider), with: .color(Theme.rule)) }
				}
			}
			.padding(1)
			.border(Theme.rule, width: 1)
	}
}

/// A quotation: a bar in the rule color and the text one step quieter.
struct RunSheetQuote: StructuredText.BlockQuoteStyle {
	func makeBody(configuration: Configuration) -> some View {
		HStack(spacing: 12) {
			RoundedRectangle(cornerRadius: 1.5).fill(Theme.rule).frame(width: 3)
			configuration.label.foregroundStyle(.secondary)
		}
		.textual.blockSpacing(.init(top: 0, bottom: 16))
	}
}

/// A code block: a quiet frame with the language and a Copy button.
struct RunSheetCodeBlock: StructuredText.CodeBlockStyle {
	func makeBody(configuration: Configuration) -> some View {
		CodeBlockFrame(configuration: configuration)
	}
}

private struct CodeBlockFrame: View {
	var configuration: StructuredText.CodeBlockStyleConfiguration
	@State private var copied = false

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			HStack {
				Text(configuration.languageHint?.lowercased() ?? "code").font(.caption).foregroundStyle(.secondary)
				Spacer()
				Button(copied ? "Copied" : "Copy") {
					configuration.codeBlock.copyToPasteboard()
					copied = true
					Task {
						try? await Task.sleep(for: .seconds(1.5))
						copied = false
					}
				}
				.buttonStyle(.borderless)
				.font(.caption)
			}
			.padding(.horizontal, 12)
			.padding(.vertical, 6)
			Divider()
			ScrollView(.horizontal) {
				configuration.label
					.font(.system(size: 12.5, design: .monospaced))
					.lineSpacing(3)
					.fixedSize(horizontal: false, vertical: true)
					.padding(12)
			}
			.scrollIndicators(.automatic)
		}
		.background(Theme.code)
		.clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
		.overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.rule))
		.textual.blockSpacing(.fontScaled(top: 0.8, bottom: 0.2))
	}
}

/// The live end of a turn: what the agent is doing now, its thinking as it streams, and the answer being written.
struct LiveView: View {
	@Environment(AppModel.self) private var app
	var session: SessionModel

	var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			if session.busy, !session.partial.reasoning.isEmpty, session.partial.text.isEmpty, app.ui.showReasoning {
				Text(tail(session.partial.reasoning))
					.font(.callout)
					.foregroundStyle(.tertiary)
					.lineLimit(3)
					.fixedSize(horizontal: false, vertical: true)
					.transition(.opacity)
			}
			if !session.partial.text.isEmpty {
				MarkdownText(text: session.partial.text)
			}
			if session.busy {
				TimelineView(.periodic(from: .now, by: 1)) { context in
					HStack(spacing: 8) {
						ProgressView().controlSize(.small)
						Text(activityWord).foregroundStyle(.secondary)
						if let started = session.turnStarted {
							Text(durationText(context.date.timeIntervalSince(started))).foregroundStyle(.tertiary).monospacedDigit()
						}
						if let detail = session.status?.detail, !detail.isEmpty {
							Text(detail).foregroundStyle(.tertiary).lineLimit(1)
						}
					}
					.font(.callout)
				}
				.accessibilityElement(children: .combine)
			}
		}
	}

	private var activityWord: String {
		switch session.status?.activity {
		case "thinking": "Thinking"
		case "writing": "Writing"
		case "tool": "Working"
		case "waiting": "Waiting for you"
		case "compacting": "Summarizing older turns"
		case "retrying": "Retrying"
		default: "Working"
		}
	}

	private func tail(_ text: String) -> String {
		text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n", omittingEmptySubsequences: false).suffix(3).joined(separator: "\n")
	}
}
