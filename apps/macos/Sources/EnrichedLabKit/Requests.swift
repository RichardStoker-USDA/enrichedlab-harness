import Foundation

// Typed requests, named as the protocol names them (packages/protocol, Requests). Each is one call; errors carry the
// engine's own words.

public struct SessionSnapshot: Decodable, Sendable {
	public var summary: SessionSummary
	public var events: [SessionEvent]
	public var status: SessionStatus
	public var pending: [PermissionRequest]
	public var partial: PartialResponse?
}

public struct ModelList: Decodable, Sendable {
	public var models: [ModelInfo]
	public var `default`: String?
}

public struct PlaceResult: Decodable, Sendable {
	public var summary: SessionSummary
	public var detail: String
}

public struct DetailResult: Decodable, Sendable {
	public var ok: Bool
	public var detail: String
}

public struct UndoResult: Decodable, Sendable {
	public var ok: Bool
	public var files: [String]
	public var detail: String
}

public struct CancelResult: Decodable, Sendable {
	public var ok: Bool
	public var returned: [String]?
}

public struct DirectoryEntry: Decodable, Sendable, Hashable, Identifiable {
	public var name: String
	/// file, dir, link, other
	public var type: String
	public var size: Int
	public var id: String { name }
}

public struct DirectoryListing: Decodable, Sendable {
	public var root: String
	public var place: String
	public var entries: [DirectoryEntry]
}

public struct FileText: Decodable, Sendable {
	public var path: String
	public var size: Int
	public var text: String?
	public var binary: Bool?
}

public struct ViewData: Decodable, Sendable {
	public var name: String
	public var size: Int
	public var text: String?
	public var base64: String?
}

public struct TerminalOpened: Decodable, Sendable {
	public var termId: String
	public var label: String
}

public struct DesktopAnswer: Decodable, Sendable {
	public var frame: DesktopFrame?
	/// From the lab, in its pixels (a lab may send fractions).
	public var cursor: [Double]?
}

public struct AppOpened: Decodable, Sendable {
	public var app: AppSummary
	public var token: String
	public var url: String
	/// view or page
	public var kind: String
	public var asks: [String]
	public var toolInput: [String: JSONValue]?
	public var toolResult: AppToolResult?
}

public struct BrowserWatch: Decodable, Sendable {
	public var page: BrowserPageState?
}

public struct SignInResult: Decodable, Sendable {
	public var account: ServiceAccount
	public var models: Int
	public var welcome: Bool
}

public struct ProviderAdded: Decodable, Sendable {
	public var name: String
	public var models: Int
}

public struct CheckRow: Decodable, Sendable, Hashable {
	public var row: String
	public var status: String
	public var detail: String?
}

private struct Empty: Encodable, Sendable {}
private struct Ok: Decodable, Sendable {}

extension EngineConnection {
	// MARK: Sessions

	public func sessions(limit: Int = 200, query: String? = nil) async throws -> [SessionSummary] {
		struct P: Encodable, Sendable { var limit: Int; var query: String? }
		return try await call("session.list", P(limit: limit, query: query))
	}

	public func createSession(cwd: String, model: String? = nil, site: String? = nil, worktree: Bool? = nil) async throws -> SessionSummary {
		struct P: Encodable, Sendable { var cwd: String; var model: String?; var site: String?; var worktree: Bool? }
		return try await call("session.create", P(cwd: cwd, model: model, site: site, worktree: worktree))
	}

	public func openSession(_ id: String) async throws -> SessionSnapshot {
		try await call("session.open", ["sessionId": id], as: SessionSnapshot.self)
	}

	public func closeSession(_ id: String) async throws {
		try await send("session.close", ["sessionId": id])
	}

	public func prompt(_ id: String, text: String, images: [Part]? = nil) async throws {
		struct P: Encodable, Sendable { var sessionId: String; var text: String; var images: [Part]? }
		try await send("session.prompt", P(sessionId: id, text: text, images: images))
	}

	public func cancel(_ id: String) async throws -> CancelResult {
		try await call("session.cancel", ["sessionId": id])
	}

	public func setModel(_ id: String, model: String? = nil, effort: String? = nil) async throws -> SessionStatus {
		struct P: Encodable, Sendable { var sessionId: String; var model: String?; var effort: String? }
		return try await call("session.model", P(sessionId: id, model: model, effort: effort))
	}

	public func compact(_ id: String) async throws -> DetailResult {
		try await call("session.compact", ["sessionId": id])
	}

	public func undo(_ id: String) async throws -> UndoResult {
		try await call("session.undo", ["sessionId": id])
	}

	public func rename(_ id: String, title: String) async throws {
		try await send("session.rename", ["sessionId": id, "title": title])
	}

	public func moveSession(_ id: String, to place: String) async throws -> PlaceResult {
		try await call("session.place", ["sessionId": id, "place": place])
	}

	public func movePlan(_ id: String) async throws -> String? {
		struct R: Decodable, Sendable { var repo: String? }
		return try await call("session.moveplan", ["sessionId": id], as: R.self).repo
	}

	public func setDiscovery(_ id: String, on: Bool) async throws -> PlaceResult {
		struct P: Encodable, Sendable { var sessionId: String; var on: Bool }
		return try await call("session.discovery", P(sessionId: id, on: on))
	}

	public func deleteSession(_ id: String) async throws {
		try await send("session.delete", ["sessionId": id])
	}

	public func answer(_ requestId: String, _ decision: PermissionDecision) async throws {
		struct P: Encodable, Sendable { var requestId: String; var decision: PermissionDecision }
		try await send("permission.answer", P(requestId: requestId, decision: decision))
	}

	// MARK: Models, labs, settings

	public func models(refresh: Bool = false) async throws -> ModelList {
		struct P: Encodable, Sendable { var refresh: Bool }
		return try await call("model.list", P(refresh: refresh))
	}

	public func setDefaultModel(_ model: String, effort: String? = nil) async throws {
		struct P: Encodable, Sendable { var model: String; var effort: String? }
		try await send("model.default", P(model: model, effort: effort))
	}

	public func sites() async throws -> [SiteSummary] {
		try await call("site.list", Empty())
	}

	public func refreshSites(_ name: String? = nil) async throws -> [SiteSummary] {
		struct P: Encodable, Sendable { var name: String? }
		return try await call("site.refresh", P(name: name))
	}

	public func addSite(name: String, url: String, title: String? = nil, isolated: Bool? = nil) async throws -> SiteSummary {
		struct P: Encodable, Sendable { var name: String; var url: String; var title: String?; var isolated: Bool? }
		return try await call("site.add", P(name: name, url: url, title: title, isolated: isolated))
	}

	public func signIn(_ name: String) async throws -> SiteSummary {
		try await call("site.login", ["name": name])
	}

	public func signOut(_ name: String) async throws {
		try await send("site.logout", ["name": name])
	}

	public func removeSite(_ name: String) async throws {
		try await send("site.remove", ["name": name])
	}

	public func uiPrefs() async throws -> UiPrefs {
		try await call("ui.get", Empty())
	}

	/// `summaryModel` "" returns summaries to the automatic choice.
	public func setUiPrefs(theme: String? = nil, showReasoning: Bool? = nil, permissions: PermissionMode? = nil, summaryModel: String? = nil, reasoningSummaries: Bool? = nil) async throws -> UiPrefs {
		struct P: Encodable, Sendable { var theme: String?; var showReasoning: Bool?; var permissions: String?; var summaryModel: String?; var reasoningSummaries: Bool? }
		return try await call("ui.set", P(theme: theme, showReasoning: showReasoning, permissions: permissions?.rawValue, summaryModel: summaryModel, reasoningSummaries: reasoningSummaries))
	}

	/// The files a step changed, from step history.
	public struct StepFiles: Decodable, Sendable, Hashable {
		public var files: [String]
		/// Calls that ran together with it; their changes come together.
		public var with: Int
		/// False when the session kept no history for that step here.
		public var history: Bool
		public var commit: String?
	}

	public func stepFiles(_ id: String, step: String) async throws -> StepFiles {
		struct P: Encodable, Sendable { var sessionId: String; var id: String }
		return try await call("session.stepFiles", P(sessionId: id, id: step))
	}

	public struct RewindResult: Decodable, Sendable {
		public var ok: Bool
		public var detail: String
		public var files: [String]
		public var session: SessionSummary?
	}

	/// Put the session's folder back as it was before a step; with `retry`, a new session continues from there.
	public func rewind(_ id: String, before: String, retry: Bool) async throws -> RewindResult {
		struct P: Encodable, Sendable { var sessionId: String; var before: String; var retry: Bool }
		return try await call("session.rewind", P(sessionId: id, before: before, retry: retry))
	}

	/// Set how much a session asks; nil returns it to the default for new sessions.
	public func setPermissions(_ id: String, mode: PermissionMode?) async throws -> SessionSummary {
		struct P: Encodable, Sendable { var sessionId: String; var mode: String? }
		return try await call("session.permissions", P(sessionId: id, mode: mode?.rawValue))
	}

	public struct FolderGrant: Decodable, Sendable, Hashable, Identifiable {
		public var path: String
		public var access: FolderAccess
		public var at: String
		public var id: String { path }
	}

	public func folders() async throws -> [FolderGrant] {
		struct P: Encodable, Sendable {}
		return try await call("folder.list", P())
	}

	/// What EnrichedLab may do in a folder; pass `access` (change, read or none) to set it.
	public func folderAccess(_ path: String, set access: String? = nil) async throws -> FolderAccess? {
		struct P: Encodable, Sendable { var path: String; var access: String? }
		struct R: Decodable { var path: String; var access: FolderAccess? }
		let result: R = try await call("folder.access", P(path: path, access: access))
		return result.access
	}

	public func providers() async throws -> ProviderList {
		try await call("provider.list", Empty())
	}

	public func addProvider(preset: String, key: String, name: String? = nil, baseUrl: String? = nil) async throws -> ProviderAdded {
		struct P: Encodable, Sendable { var preset: String; var key: String; var name: String?; var baseUrl: String? }
		return try await call("provider.add", P(preset: preset, key: key, name: name, baseUrl: baseUrl))
	}

	public func removeProvider(_ name: String) async throws {
		try await send("provider.remove", ["name": name])
	}

	public func chatGPTSignIn(account: String? = nil) async throws -> SignInResult {
		struct P: Encodable, Sendable { var service = "chatgpt"; var account: String? }
		return try await call("provider.signin", P(account: account))
	}

	public func localModels() async throws -> LocalModelsStatus {
		try await call("local.models", Empty())
	}

	public func pullLocalModel(_ model: String) async throws {
		try await send("local.pull", ["model": model])
	}

	public func checkUpdate(force: Bool = false) async throws -> UpdateStatus {
		struct P: Encodable, Sendable { var force: Bool }
		return try await call("update.check", P(force: force))
	}

	public func applyUpdate() async throws -> (version: String, restart: Bool) {
		struct R: Decodable, Sendable { var version: String; var restart: Bool }
		let result: R = try await call("update.apply", Empty())
		return (result.version, result.restart)
	}

	public func labSandboxes(_ name: String) async throws -> [LabSandbox] {
		try await call("lab.sandboxes", ["name": name])
	}

	public func labCheck(_ name: String) async throws -> [CheckRow] {
		struct R: Decodable, Sendable { var rows: [CheckRow] }
		return try await call("lab.check", ["name": name], as: R.self).rows
	}

	public func approveDevice(site: String, id: String) async throws {
		try await send("lab.device.approve", ["name": site, "id": id])
	}

	public func revokeDevice(site: String, id: String) async throws {
		try await send("lab.device.revoke", ["name": site, "id": id])
	}

	// MARK: Workbench

	public func canvases(sessionId: String) async throws -> [CanvasSummary] {
		try await call("canvas.list", ["sessionId": sessionId])
	}

	public func listFiles(sessionId: String, path: String? = nil) async throws -> DirectoryListing {
		struct P: Encodable, Sendable { var sessionId: String; var path: String? }
		return try await call("fs.list", P(sessionId: sessionId, path: path))
	}

	public func readFile(sessionId: String, path: String) async throws -> FileText {
		try await call("fs.read", ["sessionId": sessionId, "path": path])
	}

	public func openView(sessionId: String, path: String) async throws -> CanvasSummary {
		try await call("view.open", ["sessionId": sessionId, "path": path])
	}

	public func viewData(_ canvasId: String) async throws -> ViewData {
		try await call("view.data", ["canvasId": canvasId])
	}

	public func openTerminal(sessionId: String?, cols: Int, rows: Int) async throws -> TerminalOpened {
		struct P: Encodable, Sendable { var sessionId: String?; var cols: Int; var rows: Int }
		return try await call("term.open", P(sessionId: sessionId, cols: cols, rows: rows))
	}

	public func terminalInput(_ termId: String, _ data: String) async throws {
		try await send("term.input", ["termId": termId, "data": data])
	}

	public func terminalResize(_ termId: String, cols: Int, rows: Int) async throws {
		struct P: Encodable, Sendable { var termId: String; var cols: Int; var rows: Int }
		try await send("term.resize", P(termId: termId, cols: cols, rows: rows))
	}

	public func closeTerminal(_ termId: String) async throws {
		try await send("term.close", ["termId": termId])
	}

	public func desktopAct(site: String, action: [String: JSONValue]) async throws -> DesktopAnswer {
		struct P: Encodable, Sendable { var site: String; var action: [String: JSONValue] }
		return try await call("desktop.act", P(site: site, action: action))
	}

	public func updateDesktop(site: String) async throws {
		struct R: Decodable { var ok: Bool }
		let _: R = try await call("desktop.update", ["site": site])
	}

	public func watchDesktop(site: String, on: Bool) async throws -> DesktopStream {
		struct P: Encodable, Sendable { var site: String; var on: Bool }
		return try await call("desktop.watch", P(site: site, on: on))
	}

	public func desktopOpen(site: String, target: String) async throws -> DesktopAnswer {
		try await call("desktop.open", ["site": site, "target": target])
	}

	public func apps() async throws -> [AppSummary] {
		try await call("app.list", Empty())
	}

	public func labApps() async throws -> [LabApp] {
		try await call("lab.apps", Empty())
	}

	public func openApp(sessionId: String?, id: String) async throws -> AppOpened {
		struct P: Encodable, Sendable { var sessionId: String?; var id: String }
		return try await call("app.open", P(sessionId: sessionId, id: id))
	}

	public func grantApp(_ id: String, allow: Bool) async throws -> AppSummary {
		struct P: Encodable, Sendable { var id: String; var allow: Bool }
		return try await call("app.grant", P(id: id, allow: allow))
	}

	public func appCall(token: String, name: String, arguments: [String: JSONValue]?) async throws -> AppToolResult {
		struct P: Encodable, Sendable { var token: String; var name: String; var arguments: [String: JSONValue]? }
		return try await call("app.call", P(token: token, name: name, arguments: arguments))
	}

	public func appMessage(token: String, text: String) async throws {
		try await send("app.message", ["token": token, "text": text])
	}

	public func appContext(token: String, text: String) async throws {
		try await send("app.context", ["token": token, "text": text])
	}

	public func closeApp(token: String) async throws {
		try await send("app.close", ["token": token])
	}

	public func watchBrowser(sessionId: String, on: Bool) async throws -> BrowserPageState? {
		struct P: Encodable, Sendable { var sessionId: String; var on: Bool }
		return try await call("browser.watch", P(sessionId: sessionId, on: on), as: BrowserWatch.self).page
	}

	public func surfaceReply(callId: String, result: SurfaceAnswer?, error: String?) async throws {
		struct P: Encodable, Sendable { var callId: String; var result: SurfaceAnswer?; var error: String? }
		try await send("surface.reply", P(callId: callId, result: result, error: error))
	}

	public func saveLabFile(sessionId: String, uri: String, name: String, sha256: String?) async throws -> String {
		struct P: Encodable, Sendable { var sessionId: String; var uri: String; var name: String; var sha256: String? }
		struct R: Decodable, Sendable { var path: String }
		return try await call("site.save", P(sessionId: sessionId, uri: uri, name: name, sha256: sha256), as: R.self).path
	}

	/// The engine's address for pages it serves (views, apps), for the window's web views.
	public func pairLink(next: String) async throws -> URL? {
		struct R: Decodable, Sendable { var url: String }
		return URL(string: try await call("engine.pair", ["next": next], as: R.self).url)
	}
}
