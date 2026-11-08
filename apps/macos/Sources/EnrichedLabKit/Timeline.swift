import Foundation

// The timeline: every step a session took, by request, with what went in, what came out, why, and who said yes.
// Pure, so it's tested without a window; the files a step changed come from the engine (session.stepFiles).

/// One tool call, with the message that asked for it.
public struct TimelineStep: Sendable, Hashable, Identifiable {
	public enum Kind: Sendable, Hashable { case read, change, command, other }

	public var tool: SessionEvent.Tool
	/// The call as the model wrote it: its arguments are the step's input.
	public var call: ToolCall?
	/// The assistant message that made the call.
	public var message: String
	public var model: String
	/// The short summary of that message's reasoning, and the reasoning itself.
	public var why: String?
	public var reasoning: String?
	/// First of the calls its message made: the reason shows once for them all.
	public var leads: Bool
	public var started: Date?
	public var ended: Date?

	public var id: String { tool.id }
	public var verb: String { tool.view?.verb ?? tool.name }
	public var target: String { tool.view?.target ?? argumentPreview(call?.args ?? "") }

	public var kind: Kind {
		if reads.contains(tool.name) { return .read }
		if edits.contains(tool.name) || !(tool.view?.files ?? []).isEmpty { return .change }
		if tool.name == "shell" || tool.name.hasSuffix("_sandbox_run") || tool.name.hasSuffix("_sandbox_job_start") { return .command }
		return .other
	}

	/// The person was asked before it ran.
	public var asked: Bool { ["allowed", "allowed_session", "denied"].contains(tool.decision ?? "") }

	public var seconds: Double? {
		guard let started, let ended else { return nil }
		return max(0, ended.timeIntervalSince(started))
	}

	/// Who let it run, in words.
	public var permission: String {
		switch tool.decision {
		case "allowed": "you allowed it"
		case "allowed_session": "allowed for this session"
		case "denied": "you declined it"
		case "refused": "refused: not allowed here"
		default: "ran without asking"
		}
	}

	/// The input, laid out to read: JSON keys sorted and indented, or the text as written.
	public var input: String {
		guard let args = call?.args, let data = args.data(using: .utf8),
		      let value = try? JSONSerialization.jsonObject(with: data),
		      let pretty = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]),
		      let text = String(data: pretty, encoding: .utf8) else { return call?.args ?? "" }
		return text
	}
}

/// One request from the person and the steps it led to.
public struct TimelineTurn: Sendable, Hashable, Identifiable {
	public var id: String
	/// What the person asked; empty for steps before the first request (an imported session).
	public var request: String
	public var at: Date?
	public var steps: [TimelineStep]
}

public enum TimelineFilter: String, CaseIterable, Sendable, Identifiable {
	case all, changes, questions, problems
	public var id: String { rawValue }

	public var title: String {
		switch self {
		case .all: "All"
		case .changes: "Changes"
		case .questions: "Asked"
		case .problems: "Failed"
		}
	}

	public func keeps(_ step: TimelineStep) -> Bool {
		switch self {
		case .all: true
		case .changes: step.kind == .change || step.kind == .command
		case .questions: step.asked || step.tool.decision == "refused"
		case .problems: !step.tool.ok
		}
	}
}

public func timeline(_ events: [SessionEvent]) -> [TimelineTurn] {
	var summaries: [String: String] = [:]
	for event in events { if case let .reasoningSummary(s) = event { summaries[s.of] = s.text } }
	var turns: [TimelineTurn] = []
	var calls: [String: (call: ToolCall, message: SessionEvent.Assistant)] = [:]
	var shown: Set<String> = []
	for event in events {
		switch event {
		case let .user(user):
			turns.append(TimelineTurn(id: user.id, request: user.text, at: parseDate(user.at), steps: []))
		case let .assistant(message):
			for call in message.toolCalls ?? [] { calls[call.id] = (call, message) }
		case let .tool(tool):
			if turns.isEmpty { turns.append(TimelineTurn(id: "start", request: "", at: nil, steps: [])) }
			let made = calls[tool.callId]
			let message = made?.message
			let leads = message.map { shown.insert($0.id).inserted } ?? true
			turns[turns.count - 1].steps.append(TimelineStep(
				tool: tool,
				call: made?.call,
				message: message?.id ?? "",
				model: message?.model ?? "",
				why: message.flatMap { summaries[$0.id] },
				reasoning: message?.reasoning.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 },
				leads: leads,
				started: message.flatMap { parseDate($0.at) },
				ended: parseDate(tool.at)
			))
		default:
			break
		}
	}
	return turns.filter { !$0.steps.isEmpty }
}

/// "38 steps for 3 requests · 4 min · claude-fable-5-1"
public func timelineSummary(_ turns: [TimelineTurn]) -> String {
	let steps = turns.flatMap(\.steps)
	guard !steps.isEmpty else { return "No steps yet" }
	var parts = ["\(steps.count) step\(steps.count == 1 ? "" : "s") for \(turns.count) request\(turns.count == 1 ? "" : "s")"]
	if let first = turns.compactMap({ $0.at ?? $0.steps.first?.started }).first, let last = steps.compactMap(\.ended).last {
		parts.append(durationText(last.timeIntervalSince(first)))
	}
	var models: [String] = []
	for step in steps where !step.model.isEmpty && !models.contains(step.model) { models.append(step.model) }
	if !models.isEmpty { parts.append(models.map { $0.split(separator: "/").last.map(String.init) ?? $0 }.joined(separator: ", ")) }
	let failed = steps.filter { !$0.tool.ok }.count
	if failed > 0 { parts.append("\(failed) failed") }
	return parts.joined(separator: " · ")
}
