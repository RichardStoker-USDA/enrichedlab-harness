import Foundation

// The run sheet's shape and the words around it, kept pure so they're tested without a window. The same rules as the
// web surface (packages/web/src/lib/turns.ts, places.ts, where.ts, format.ts); the two read side by side.

// MARK: Blocks

public enum StepItem: Sendable, Hashable, Identifiable {
	case done(SessionEvent.Tool)
	case running(id: String, name: String, target: String, waiting: PermissionRequest?)

	public var id: String {
		switch self {
		case let .done(tool): tool.id
		case let .running(id, _, _, _): id
		}
	}
}

public enum Block: Sendable, Hashable, Identifiable {
	case prompt(id: String, text: String, images: Int)
	case thinking(id: String, text: String, summary: String?, seconds: Double?)
	case activity(id: String, steps: [StepItem])
	case answer(id: String, text: String, error: String?, stop: String)
	case notice(id: String, level: String, text: String)
	case rule(id: String, text: String)

	public var id: String {
		switch self {
		case let .prompt(id, _, _), let .thinking(id, _, _, _), let .activity(id, _), let .answer(id, _, _, _), let .notice(id, _, _), let .rule(id, _): id
		}
	}
}

/// A call in the newest answer that hasn't finished, for the live end of the activity.
public struct RunningCall: Sendable, Hashable {
	public var id: String
	public var name: String
	public var target: String

	public init(id: String, name: String, target: String) {
		self.id = id
		self.name = name
		self.target = target
	}
}

public func blocks(_ events: [SessionEvent], running: [RunningCall]? = nil, pending: [PermissionRequest] = []) -> [Block] {
	var out: [Block] = []
	var summaries: [String: String] = [:]
	for event in events { if case let .reasoningSummary(s) = event { summaries[s.of] = s.text } }
	var lastAt: Date?
	func appendStep(_ step: StepItem) {
		if case let .activity(id, steps) = out.last {
			out[out.count - 1] = .activity(id: id, steps: steps + [step])
		} else {
			out.append(.activity(id: "a-\(out.count)", steps: [step]))
		}
	}
	for event in events {
		switch event {
		case let .user(e):
			out.append(.prompt(id: e.id, text: e.text, images: e.images?.count ?? 0))
			lastAt = parseDate(e.at)
		case let .assistant(e):
			let end = parseDate(e.at)
			if let reasoning = e.reasoning, !reasoning.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
				var seconds = e.ms.map { $0 / 1000 }
				if seconds == nil, let start = lastAt, let end { seconds = end.timeIntervalSince(start) }
				out.append(.thinking(id: "\(e.id)-r", text: reasoning, summary: summaries[e.id], seconds: seconds))
			}
			if !e.text.isEmpty || e.stop == "error" || e.stop == "cancelled" {
				out.append(.answer(id: e.id, text: e.text, error: e.error, stop: e.stop))
			}
			lastAt = end
		case let .tool(e):
			appendStep(.done(e))
			lastAt = parseDate(e.at)
		case let .notice(e):
			out.append(.notice(id: e.id, level: e.level, text: e.text))
		case let .compaction(e):
			out.append(.rule(id: e.id, text: "Earlier turns summarized to save room · \(Int((Double(e.tokensBefore) / 1000).rounded()))k tokens"))
		case let .undo(e):
			out.append(.rule(id: e.id, text: "Undone · \(e.files.joined(separator: ", "))"))
		case let .discovery(e):
			out.append(.rule(id: e.id, text: e.on ? "Discovery mode on · the agent works without asking at the lab" : "Discovery mode off"))
		case let .place(e) where e.initial != true:
			out.append(.rule(id: e.id, text: e.place == "local" ? "Moved back to this computer" : "Moved to \(placeLabel(e.label))"))
		default:
			break
		}
	}
	if let running {
		var finished = Set<String>()
		for event in events { if case let .tool(e) = event { finished.insert(e.callId) } }
		for call in running where !finished.contains(call.id) {
			let waiting = pending.first { $0.callId == call.id }
			appendStep(.running(id: call.id, name: waiting?.view.verb ?? call.name, target: waiting?.view.target ?? call.target, waiting: waiting))
		}
	}
	return out
}

private func placeLabel(_ label: String) -> String {
	var text = label
	if text.hasPrefix("the ") { text.removeFirst(4) }
	if let paren = text.range(of: " (") { text = String(text[..<paren.lowerBound]) }
	return text
}

public func parseDate(_ text: String) -> Date? {
	(try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))) ?? (try? Date(text, strategy: Date.ISO8601FormatStyle()))
}

let reads: Set<String> = ["read", "ls", "glob", "grep", "recall"]
let edits: Set<String> = ["edit", "write"]

/// One line for a finished activity: "Read 4 files, ran 2 commands, edited geom.py".
public func summarize(_ steps: [StepItem]) -> String {
	var readCount = 0, searches = 0, commands = 0, failed = 0
	var edited: [String] = []
	var other: [String] = []
	for step in steps {
		guard case let .done(tool) = step else { continue }
		let verb = tool.view?.verb ?? tool.name
		if !tool.ok { failed += 1 }
		if tool.name == "grep" || tool.name == "glob" { searches += 1 }
		else if reads.contains(tool.name) { readCount += 1 }
		else if tool.name == "shell" || tool.name.hasSuffix("_sandbox_run") || tool.name.hasSuffix("_sandbox_job_start") { commands += 1 }
		else if edits.contains(tool.name) {
			let file = (tool.view?.target ?? "").split(separator: "/").last.map(String.init) ?? ""
			if !file.isEmpty, !edited.contains(file) { edited.append(file) }
		} else if !other.contains(verb) { other.append(verb) }
	}
	var parts: [String] = []
	if readCount > 0 { parts.append("read \(readCount) file\(readCount == 1 ? "" : "s")") }
	if searches > 0 { parts.append("searched \(searches) time\(searches == 1 ? "" : "s")") }
	if commands > 0 { parts.append("ran \(commands) command\(commands == 1 ? "" : "s")") }
	if !edited.isEmpty { parts.append("edited \(edited.count > 3 ? "\(edited.count) files" : edited.joined(separator: ", "))") }
	parts.append(contentsOf: other.prefix(3))
	if failed > 0 { parts.append("\(failed) failed") }
	let text = parts.joined(separator: ", ")
	guard let first = text.first else { return "\(steps.count) step\(steps.count == 1 ? "" : "s")" }
	return first.uppercased() + text.dropFirst()
}

/// "4 s", "2 min 5 s".
public func durationText(_ seconds: Double) -> String {
	let s = Int(seconds.rounded())
	return s < 60 ? "\(max(1, s)) s" : "\(s / 60) min \(s % 60) s"
}

/// The useful part of tool arguments still streaming: a path or command if one has appeared.
public func argumentPreview(_ args: String) -> String {
	guard let regex = try? NSRegularExpression(pattern: #""(path|command|pattern|url|title|query)"\s*:\s*"((?:[^"\\]|\\.)*)"#),
	      let match = regex.firstMatch(in: args, range: NSRange(args.startIndex..., in: args)),
	      let range = Range(match.range(at: 2), in: args) else { return "" }
	return args[range].replacingOccurrences(of: "\\n", with: " ").replacingOccurrences(of: "\\\"", with: "\"")
}

// MARK: Places

/// Where a session's files and commands act: this computer, or a lab's sandbox.
public struct Place: Sendable, Hashable, Identifiable {
	public var id: String
	/// "This Mac", or the lab's name.
	public var title: String
	/// Where work runs there, in a few words.
	public var detail: String
	/// The marker's place in the order labs are listed (0 is this computer).
	public var index: Int
	/// Can sessions work there now?
	public var ready: Bool
	public var site: SiteSummary?
	/// A lab a session still names that isn't among this person's labs now.
	public var missing: Bool

	public var isLocal: Bool { id == "local" }

	/// "This Mac", or "<lab> sandbox".
	public var runsLabel: String { isLocal ? title : missing ? "\(title) (not one of your labs now)" : "\(title) sandbox" }
}

public func places(_ sites: [SiteSummary], computer: String = "This Mac") -> [Place] {
	let local = Place(id: "local", title: computer, detail: "local sandbox", index: 0, ready: true, site: nil, missing: false)
	let labs = sites.enumerated().map { i, site in
		Place(
			id: site.name,
			title: site.displayTitle,
			detail: site.signedIn ? (site.sandbox ? "sandbox · \(site.who ?? "signed in")" : "\(site.who ?? "signed in") · no sandbox") : site.error != nil ? "can't connect" : "sign in",
			index: i + 1,
			ready: site.signedIn && site.sandbox,
			site: site,
			missing: false
		)
	}
	return [local] + labs
}

/// The place a session names. A lab that's no longer listed stays itself, marked missing.
public func place(of id: String?, in list: [Place]) -> Place {
	let wanted = id ?? "local"
	if let found = list.first(where: { $0.id == wanted }) { return found }
	return Place(id: wanted, title: wanted, detail: "not connected", index: 0, ready: false, site: nil, missing: true)
}

/// The models a session may use, as the engine decides: a session bound to an isolated lab uses that lab's models only;
/// other sessions use any model except isolated labs'.
public func allowedModels(_ models: [ModelInfo], sites: [SiteSummary], site: String?) -> [ModelInfo] {
	func isolated(_ name: String) -> Bool { sites.contains { $0.name == name && $0.isolated == true } }
	if let site, isolated(site) { return models.filter { $0.source == "site" && $0.provider == site } }
	return models.filter { model in
		guard model.source == "site" else { return true }
		if let site { return model.provider == site }
		return !isolated(model.provider)
	}
}

/// Models grouped by where they run, private places first: the model menu's sections.
public struct ModelGroup: Sendable, Hashable, Identifiable {
	public var where_: ModelWhere
	public var label: String
	public var models: [ModelInfo]
	public var id: String { "\(where_.kind):\(where_.name)" }
}

public func modelGroups(_ models: [ModelInfo], computer: String = "This Mac") -> [ModelGroup] {
	let order = ["lab": 0, "device": 1, "network": 2, "cloud": 3]
	var groups: [String: ModelGroup] = [:]
	var keys: [String] = []
	for model in models {
		let key = "\(model.where.kind):\(model.where.name)"
		if groups[key] == nil {
			keys.append(key)
			let name = model.where.kind == "device" ? computer : model.where.name
			groups[key] = ModelGroup(where_: model.where, label: "\(model.where.isPrivate ? "Private" : "Cloud") · \(name)", models: [])
		}
		groups[key]!.models.append(model)
	}
	return keys.compactMap { groups[$0] }.sorted { (order[$0.where_.kind] ?? 9) < (order[$1.where_.kind] ?? 9) }
}

/// Where what the person sends goes, in a sentence.
public func whereNote(_ where_: ModelWhere) -> String {
	switch where_.kind {
	case "device": "Runs on this computer, and what you send stays on it."
	case "network": "Runs on \(where_.name), on your network, and what you send stays there."
	case "lab": "Runs on \(where_.name)'s own servers, and what you send stays in the lab."
	default: "What you send goes to \(where_.name). Whether it's kept or used for training depends on that service's terms and your account settings."
	}
}

// MARK: Words

public func ago(_ iso: String, now: Date = Date()) -> String {
	guard let date = parseDate(iso) else { return "" }
	let seconds = max(0, now.timeIntervalSince(date))
	if seconds < 60 { return "now" }
	if seconds < 3600 { return "\(Int(seconds / 60))m" }
	if seconds < 86_400 { return "\(Int(seconds / 3600))h" }
	if seconds < 7 * 86_400 { return "\(Int(seconds / 86_400))d" }
	return date.formatted(.dateTime.month(.abbreviated).day())
}

public func tokenCount(_ n: Int) -> String {
	if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
	if n >= 1000 { return n >= 100_000 ? "\(n / 1000)k" : String(format: "%.1fk", Double(n) / 1000) }
	return String(n)
}

public func folderName(_ path: String) -> String {
	path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? path
}

public func shortPath(_ path: String) -> String {
	let home = FileManager.default.homeDirectoryForCurrentUser.path
	return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
}
