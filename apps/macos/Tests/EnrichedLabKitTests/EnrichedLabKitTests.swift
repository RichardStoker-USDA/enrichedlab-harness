import Foundation
import Testing
@testable import EnrichedLabKit

/// The repository root, from this file's place in it.
private let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

@Suite("Protocol shapes")
struct ShapeTests {
	@Test("a session snapshot decodes, kinds this app doesn't know included")
	func snapshot() throws {
		let json = """
		{"summary":{"id":"s1","cwd":"/p","title":"Plots","created":"2026-11-07T00:00:00Z","updated":"2026-11-07T00:00:00Z","model":"lab/m","turns":1,"running":false,"place":"home"},
		 "events":[
		  {"t":"header","v":1,"id":"h","at":"2026-11-07T00:00:00Z","cwd":"/p","created":"2026-11-07T00:00:00Z"},
		  {"t":"user","id":"u","at":"2026-11-07T00:00:01Z","text":"Plot it"},
		  {"t":"assistant","id":"a","at":"2026-11-07T00:00:02Z","model":"lab/m","text":"","reasoning":"thinking","toolCalls":[{"id":"c","name":"shell","args":"{}"}],"stop":"tool_use"},
		  {"t":"tool","id":"r","at":"2026-11-07T00:00:03Z","callId":"c","name":"shell","ok":true,"content":"done","view":{"verb":"ran","target":"Rscript plot.R","result":"exit 0"},"decision":"auto"},
		  {"t":"reasoning_summary","id":"rs","at":"2026-11-07T00:00:04Z","of":"a","text":"Planned the plot.","model":"lab/m"},
		  {"t":"checkpoint","id":"k","at":"2026-11-07T00:00:05Z","callId":"c","files":[]},
		  {"t":"something_new","id":"n","at":"2026-11-07T00:00:06Z","whatever":[1,2]}
		 ],
		 "status":{"sessionId":"s1","activity":"idle","model":"lab/m","context":{"used":10,"threshold":100,"window":200,"estimated":true},"queued":0},
		 "pending":[]}
		"""
		let snap = try JSONDecoder().decode(SessionSnapshot.self, from: Data(json.utf8))
		#expect(snap.events.count == 7)
		#expect(snap.events.map(\.id) == ["h", "u", "a", "r", "rs", "k", "n"])
		guard case let .assistant(step) = snap.events[2] else { Issue.record("not an assistant step"); return }
		#expect(step.toolCalls?.first?.name == "shell")
		guard case let .other(unknown) = snap.events[6] else { Issue.record("an unknown kind didn't decode as other"); return }
		#expect(unknown.t == "something_new")
		#expect(snap.status.busy == false)
	}

	@Test("free-form JSON keeps its shape")
	func json() throws {
		let value = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"a":[1,true,null,"x"],"b":{"c":2.5}}"#.utf8))
		#expect(value["a"]?.array?.count == 4)
		#expect(value["b"]?["c"]?.number == 2.5)
		#expect(value.text == #"{"a":[1,true,null,"x"],"b":{"c":2.5}}"#)
	}
}

@Suite("A real engine", .serialized)
struct EngineTests {
	@Test("starts through el engine ensure, then sessions open over the protocol", .timeLimit(.minutes(2)))
	func roundTrip() async throws {
		let home = FileManager.default.temporaryDirectory.appending(path: "el-kit-\(UUID().uuidString.prefix(8))")
		let project = home.appending(path: "project")
		try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
		defer { try? FileManager.default.removeItem(at: home) }
		let bun = ["/opt/homebrew/bin/bun", FileManager.default.homeDirectoryForCurrentUser.appending(path: ".bun/bin/bun").path].first { FileManager.default.isExecutableFile(atPath: $0) } ?? "/usr/local/bin/bun"
		let locator = EngineLocator(
			home: home.appending(path: "el"),
			command: [bun, repository.appending(path: "packages/cli/src/main.ts").path],
			appVersion: "test",
			environment: ["EL_HOME": home.appending(path: "el").path, "EL_KEYSTORE": "file"]
		)
		let connection = EngineConnection(locator: locator, client: "kit-test")
		await connection.start()
		var connected = false
		for await state in connection.states {
			if case .connected = state { connected = true; break }
			if case let .lost(reason) = state { Issue.record("lost: \(reason)"); break }
		}
		#expect(connected)
		defer { Task { await connection.stop() } }

		let made = try await connection.createSession(cwd: project.path)
		#expect(made.cwd == project.path)
		let listed = try await connection.sessions()
		#expect(listed.contains { $0.id == made.id })
		let snap = try await connection.openSession(made.id)
		#expect(snap.summary.id == made.id)
		#expect(snap.events.contains { if case .header = $0 { true } else { false } })
		let prefs = try await connection.uiPrefs()
		#expect(["auto", "light", "dark"].contains(prefs.theme))
		// The engine's own words come back as the error's message.
		await #expect(throws: EngineError.self) { try await connection.openSession("s-no-such-session") }
		try await connection.renameSessionForTest(made.id)
		let renamed = try await connection.sessions().first { $0.id == made.id }
		#expect(renamed?.title == "Kit test")

		// Stop the scratch engine.
		let stop = Process()
		stop.executableURL = URL(fileURLWithPath: bun)
		stop.arguments = [repository.appending(path: "packages/cli/src/main.ts").path, "engine", "stop"]
		stop.environment = ProcessInfo.processInfo.environment.merging(["EL_HOME": home.appending(path: "el").path], uniquingKeysWith: { _, new in new })
		try stop.run()
		stop.waitUntilExit()
	}
}

extension EngineConnection {
	func renameSessionForTest(_ id: String) async throws {
		try await rename(id, title: "Kit test")
	}
}

@Suite("The run sheet's shape")
struct BlockTests {
	private func decode(_ json: String) throws -> [SessionEvent] {
		try JSONDecoder().decode([SessionEvent].self, from: Data(json.utf8))
	}

	@Test("a turn reads prompt, thinking with its summary, one activity, answer")
	func turn() throws {
		let events = try decode("""
		[{"t":"user","id":"u","at":"2026-11-07T00:00:00Z","text":"Plot it"},
		 {"t":"assistant","id":"a","at":"2026-11-07T00:00:12Z","model":"m","text":"","reasoning":"plan","toolCalls":[{"id":"c1","name":"read","args":"{}"},{"id":"c2","name":"shell","args":"{}"}],"stop":"tool_use"},
		 {"t":"tool","id":"r1","at":"2026-11-07T00:00:13Z","callId":"c1","name":"read","ok":true,"content":""},
		 {"t":"tool","id":"r2","at":"2026-11-07T00:00:14Z","callId":"c2","name":"shell","ok":false,"content":""},
		 {"t":"reasoning_summary","id":"s","at":"2026-11-07T00:00:15Z","of":"a","text":"Planned it.","model":"m"},
		 {"t":"assistant","id":"b","at":"2026-11-07T00:00:20Z","model":"m","text":"Done.","stop":"end"}]
		""")
		let made = blocks(events)
		#expect(made.map(\.id) == ["u", "a-r", "a-2", "b"])
		guard case let .thinking(_, _, summary, seconds) = made[1] else { Issue.record("no thinking block"); return }
		#expect(summary == "Planned it.")
		#expect(seconds == 12)
		guard case let .activity(_, steps) = made[2] else { Issue.record("no activity"); return }
		#expect(summarize(steps) == "Read 1 file, ran 1 command, 1 failed")
	}

	@Test("the timeline: steps by request, the reason once per message, the input laid out, who allowed it")
	func steps() throws {
		let events = try decode("""
		[{"t":"tool","id":"r0","at":"2026-11-07T00:00:01Z","callId":"c0","name":"read","ok":true,"content":""},
		 {"t":"user","id":"u","at":"2026-11-07T00:00:00Z","text":"Plot it"},
		 {"t":"assistant","id":"a","at":"2026-11-07T00:00:12Z","model":"lab/m","text":"","reasoning":"plan","toolCalls":[{"id":"c1","name":"read","args":"{\\"path\\":\\"a.csv\\"}"},{"id":"c2","name":"shell","args":"{\\"command\\":\\"rm x\\",\\"a\\":1}"}],"stop":"tool_use"},
		 {"t":"tool","id":"r1","at":"2026-11-07T00:00:13Z","callId":"c1","name":"read","ok":true,"content":"x"},
		 {"t":"tool","id":"r2","at":"2026-11-07T00:00:15Z","callId":"c2","name":"shell","ok":false,"content":"","decision":"allowed_session"},
		 {"t":"reasoning_summary","id":"s","at":"2026-11-07T00:00:16Z","of":"a","text":"Planned it.","model":"lab/mini"}]
		""")
		let turns = timeline(events)
		#expect(turns.map(\.request) == ["", "Plot it"])
		let steps = turns[1].steps
		#expect(steps.map(\.id) == ["r1", "r2"])
		#expect(steps.map(\.leads) == [true, false])
		#expect(steps[0].why == "Planned it.")
		#expect(steps[0].target == "a.csv")
		#expect(steps[1].input == "{\n  \"a\" : 1,\n  \"command\" : \"rm x\"\n}")
		#expect(steps[1].seconds == 3)
		#expect(steps[1].asked && steps[1].permission == "allowed for this session")
		#expect(TimelineFilter.problems.keeps(steps[1]) && !TimelineFilter.problems.keeps(steps[0]))
		#expect(TimelineFilter.changes.keeps(steps[1]) && !TimelineFilter.changes.keeps(steps[0]))
		#expect(timelineSummary(Array(turns.suffix(1))) == "2 steps for 1 request · 15 s · m · 1 failed")
	}

	@Test("calls still running join the activity, with the question they wait on")
	func running() throws {
		let events = try decode("""
		[{"t":"user","id":"u","at":"2026-11-07T00:00:00Z","text":"Go"},
		 {"t":"assistant","id":"a","at":"2026-11-07T00:00:01Z","model":"m","text":"","toolCalls":[{"id":"c1","name":"shell","args":"{}"}],"stop":"tool_use"}]
		""")
		let question = PermissionRequest(requestId: "q", sessionId: "s", callId: "c1", tool: "shell", view: StepView(verb: "run", target: "rm -rf build"), reason: "changes files", once: nil)
		let made = blocks(events, running: [RunningCall(id: "c1", name: "shell", target: "")], pending: [question])
		guard case let .activity(_, steps) = made.last, case let .running(_, name, target, waiting) = steps.first else { Issue.record("no running step"); return }
		#expect(name == "run")
		#expect(target == "rm -rf build")
		#expect(waiting?.requestId == "q")
	}

	@Test("models a session may use follow the lab's isolation")
	func models() {
		let model = { (provider: String, source: String) in ModelInfo(ref: "\(provider)/m", provider: provider, id: "m", label: "m", source: source, where: ModelWhere(kind: source == "site" ? "lab" : "cloud", name: provider), context: 1, maxOutput: 1, vision: false, efforts: []) }
		let all = [model("home", "site"), model("whnrc", "site"), model("openai", "config")]
		let site = { (name: String, isolated: Bool) in SiteSummary(name: name, title: name, url: "", kind: "gate", isolated: isolated, signedIn: true, models: 1, tools: 0, sandbox: true) }
		let sites = [site("home", false), site("whnrc", true)]
		#expect(allowedModels(all, sites: sites, site: nil).map(\.provider) == ["home", "openai"])
		#expect(allowedModels(all, sites: sites, site: "whnrc").map(\.provider) == ["whnrc"])
		#expect(allowedModels(all, sites: sites, site: "home").map(\.provider) == ["home", "openai"])
		#expect(argumentPreview(#"{"command":"ls -la\nwc"#) == "ls -la wc")
	}
}
