import Foundation

// The Lab protocol's shapes, as packages/protocol/src/index.ts defines them. Names follow the TypeScript so the two
// read side by side. String unions stay strings: a newer engine's new values decode, and the window shows them plainly.

public let protocolVersion = 1

// MARK: Content

public struct Part: Codable, Sendable, Hashable {
	public var type: String
	public var text: String?
	public var mime: String?
	public var data: String?

	public static func text(_ text: String) -> Part { Part(type: "text", text: text) }
	public static func image(mime: String, data: String) -> Part { Part(type: "image", mime: mime, data: data) }
}

public struct ToolCall: Codable, Sendable, Hashable, Identifiable {
	public var id: String
	public var name: String
	/// Raw JSON text as the model wrote it.
	public var args: String
}

public struct Usage: Codable, Sendable, Hashable {
	public var input: Int
	public var output: Int
	public var cached: Int?
	public var reasoning: Int?
}

/// A file a tool returned by reference: where it lives, what it is, and its checksum.
public struct FileRef: Codable, Sendable, Hashable {
	public var uri: String
	public var name: String
	public var mime: String?
	public var bytes: Int?
	public var sha256: String?
}

/// How a tool's call is shown: the verb and its target, as one step line.
public struct StepView: Codable, Sendable, Hashable {
	public var verb: String
	public var target: String
	public var unreviewed: Bool?
	public var files: [FileRef]?
	public var result: String?
	public var detail: String?
	public var diff: String?
	public var canvas: String?
	public var session: String?
}

// MARK: Live state

public struct ContextGauge: Codable, Sendable, Hashable {
	public var used: Int
	public var threshold: Int
	public var window: Int
	public var estimated: Bool
}

public struct SessionStatus: Codable, Sendable, Hashable {
	public var sessionId: String
	/// idle, thinking, writing, tool, waiting, compacting, retrying
	public var activity: String
	public var undoable: [String]?
	public var model: String
	public var effort: String?
	public var context: ContextGauge
	public var rate: Double?
	public var queued: Int
	public var detail: String?

	public var busy: Bool { activity != "idle" }
}

public struct SessionSummary: Codable, Sendable, Hashable, Identifiable {
	public var id: String
	public var cwd: String
	public var title: String
	public var created: String
	public var updated: String
	public var model: String
	public var turns: Int
	public var running: Bool
	public var site: String?
	public var parent: String?
	public var place: String?
	public var discovery: String?
	/// How much this session asks, when the person set it for this session.
	public var permissions: String?

	public init(id: String, cwd: String, title: String, created: String, updated: String, model: String, turns: Int, running: Bool, site: String? = nil, parent: String? = nil, place: String? = nil, discovery: String? = nil) {
		self.id = id
		self.cwd = cwd
		self.title = title
		self.created = created
		self.updated = updated
		self.model = model
		self.turns = turns
		self.running = running
		self.site = site
		self.parent = parent
		self.place = place
		self.discovery = discovery
	}
}

// MARK: Models and sites

/// Where a model runs, so people know where what they send goes.
public struct ModelWhere: Codable, Sendable, Hashable {
	/// device, network, lab, cloud
	public var kind: String
	public var name: String

	public var isPrivate: Bool { kind != "cloud" }
}

public struct ModelInfo: Codable, Sendable, Hashable, Identifiable {
	public var ref: String
	public var provider: String
	public var id: String
	public var label: String
	/// local, config, site
	public var source: String
	public var `where`: ModelWhere
	public var context: Int
	public var maxOutput: Int
	public var vision: Bool
	public var efforts: [String]
	public var defaultEffort: String?
}

public struct SandboxProfile: Codable, Sendable, Hashable {
	public var name: String
	public var cpu: Double
	public var memory: String
	public var gpu: String?
}

public struct SiteDesktop: Codable, Sendable, Hashable {
	public var width: Int?
	public var height: Int?
	public var actions: [String]
	public var open: Bool
	/// Made before the lab's current desktop image: desktop.update moves it over, keeping its files.
	public var outdated: Bool?
}

public struct SiteSummary: Codable, Sendable, Hashable, Identifiable {
	public var name: String
	public var title: String
	public var url: String
	public var kind: String
	public var isolated: Bool?
	public var signedIn: Bool
	public var who: String?
	public var via: String?
	public var models: Int
	public var tools: Int
	public var sandbox: Bool
	public var browser: Bool?
	public var error: String?
	public var warning: String?
	public var support: String?
	public var docs: String?
	public var keepsDataInside: Bool?
	public var profiles: [SandboxProfile]?
	public var desktop: SiteDesktop?

	public var id: String { name }
	public var displayTitle: String { title.isEmpty ? name : title }
}

/// A changed band of a watched desktop's screen: a JPEG (base64) to draw at x, y, w by h desktop pixels.
public struct DesktopBand: Codable, Sendable {
	public var site: String
	public var x: Int
	public var y: Int
	public var w: Int
	public var h: Int
	public var jpeg: String
}

/// Whether a desktop's live view runs, its size, and why it ended.
public struct DesktopStream: Codable, Sendable, Hashable {
	public var site: String
	public var live: Bool
	public var width: Int?
	public var height: Int?
	public var reason: String?

	public init(site: String, live: Bool, width: Int? = nil, height: Int? = nil, reason: String? = nil) {
		self.site = site
		self.live = live
		self.width = width
		self.height = height
		self.reason = reason
	}
}

public struct DesktopFrame: Codable, Sendable, Hashable {
	public var site: String
	/// base64 PNG
	public var png: String
	public var width: Int
	public var height: Int
	/// agent or person
	public var by: String
	public var at: String
}

public struct LabNotice: Codable, Sendable, Hashable {
	public var site: String
	public var type: String
	public var at: String
	public var text: String
	public var session: String?
	public var url: String?
}

public struct PermissionRequest: Codable, Sendable, Hashable, Identifiable {
	public var requestId: String
	public var sessionId: String
	public var callId: String
	public var tool: String
	public var view: StepView
	public var reason: String
	public var once: Bool?
	/// For a subagent's question: the session it works for.
	public var lead: String?
	/// What "allow for this session" covers, in words: "“python3” commands", "requests to example.org".
	public var scope: String?
	/// A folder the person hasn't let EnrichedLab change yet: offer allowFolder.
	public var folder: String?

	public var id: String { requestId }
}

public enum PermissionDecision: String, Codable, Sendable {
	case allow
	case allowSession = "allow_session"
	/// Let EnrichedLab change files in the request's folder from now on, in every session.
	case allowFolder = "allow_folder"
	case deny
}

/// How much a session asks: before changes, only for what history can't take back, or never.
public enum PermissionMode: String, Codable, Sendable, CaseIterable {
	case ask
	case auto
	case full

	public var title: String {
		switch self {
		case .ask: "Ask Before Changes"
		case .auto: "Ask When It Can't Be Undone"
		case .full: "Allow Everything"
		}
	}

	/// The short name beside the composer's other menus.
	public var short: String {
		switch self {
		case .ask: "Ask"
		case .auto: "Auto"
		case .full: "Allow All"
		}
	}

	public var detail: String {
		switch self {
		case .ask: "Asks before each file change and each command that can change things. You can let a kind of step run for the rest of the session."
		case .auto: "File changes in a folder you let it change, and commands contained to that folder, run without asking: every step is kept in history, so you can go back. It asks before commands outside the containment, requests to new sites, and anything it can't take back."
		case .full: "Never asks, except before pushing to a remote and before lab tools the lab hasn't reviewed. Every step is still kept in history."
		}
	}
}

/// What EnrichedLab may do in a folder the person added.
public enum FolderAccess: String, Codable, Sendable {
	case change
	case read
}

public struct PlotSpec: Codable, Sendable, Hashable {
	public var x: String
	public var y: String
	public var color: String?
	public var type: String?
}

public struct CanvasSource: Codable, Sendable, Hashable {
	public var path: String
	public var place: String
}

public struct CanvasSummary: Codable, Sendable, Hashable, Identifiable {
	public var id: String
	public var sessionId: String
	public var title: String
	/// html, markdown, svg, image, table, plot, page
	public var kind: String
	public var url: String
	public var updated: String
	public var version: Int
	public var source: CanvasSource?
	public var plot: PlotSpec?
	public var href: String?
}

// MARK: Apps

public struct AppPermissions: Codable, Sendable, Hashable {
	public var files: String?
	public var commands: Bool?
	public var models: Bool?
	public var labs: [String]?
	public var network: [String]?
}

public struct AppSummary: Codable, Sendable, Hashable, Identifiable {
	public var id: String
	public var name: String
	public var title: String
	public var version: String
	public var description: String
	public var dir: String
	public var source: String
	public var backend: String?
	public var permissions: AppPermissions
	public var granted: Bool
	public var signer: String?
}

public struct AppToolResult: Codable, Sendable, Hashable {
	public struct Content: Codable, Sendable, Hashable {
		public var type: String
		public var text: String?
		public var data: String?
		public var mimeType: String?
	}

	public var content: [Content]
	public var structuredContent: [String: JSONValue]?
	public var isError: Bool?
}

public struct LabApp: Codable, Sendable, Hashable {
	public struct Signer: Codable, Sendable, Hashable {
		public var fingerprint: String
		public var name: String?
	}

	public var site: String
	public var lab: String
	public var name: String
	public var title: String
	public var version: String
	public var description: String
	public var signer: Signer
	public var runtime: String?
	public var permissions: [String: JSONValue]
	public var published: String?
	public var withdrawn: Bool
	public var signerRevoked: Bool
	public var installed: String?
}

public struct DeviceRequest: Codable, Sendable, Hashable, Identifiable {
	public var site: String
	public var lab: String
	public var id: String
	public var name: String
	public var created: String
}

public struct LabDevice: Codable, Sendable, Hashable, Identifiable {
	public var id: String
	public var name: String?
	public var status: String?
	public var created: String?
	public var last_seen: String?
	public var current: Bool?
	public var thumbprint: String?
}

public struct LabSandbox: Codable, Sendable, Hashable, Identifiable {
	public var id: String
	public var name: String?
	public var status: String?
	public var created: String?
	public var last_active: String?
	public var memory: String?
	public var profile: String?
	public var current: Bool?
	public var stoppable: Bool?
	public var reason: String?
	public var image: String?
	public var network: String?
}

// MARK: Model services, local models, updates

public struct ProviderPreset: Codable, Sendable, Hashable, Identifiable {
	public var id: String
	public var label: String
	public var api: String
	public var baseUrl: String
	public var keyUrl: String?
	public var note: String
}

public struct ServiceAccount: Codable, Sendable, Hashable, Identifiable {
	public var service: String
	public var id: String
	public var label: String
	public var active: Bool
	public var signedIn: Bool
	public var plan: Bool
}

public struct AddedProvider: Codable, Sendable, Hashable, Identifiable {
	public var name: String
	public var label: String
	public var baseUrl: String
	public var id: String { name }
}

public struct ProviderList: Codable, Sendable, Hashable {
	public var presets: [ProviderPreset]
	public var added: [AddedProvider]
	public var accounts: [ServiceAccount]
}

public struct LocalServerInfo: Codable, Sendable, Hashable {
	public var name: String
	public var kind: String
	public var label: String
	public var port: Int
	public var version: String?
	public var models: [String]
}

public struct SuggestedModel: Codable, Sendable, Hashable, Identifiable {
	public var model: String
	public var label: String
	public var sizeGB: Double
	public var traits: [String]
	public var about: String
	public var fits: Bool
	public var installed: Bool
	public var id: String { model }
}

public struct LocalPullProgress: Codable, Sendable, Hashable {
	public var model: String
	public var status: String
	public var completed: Double?
	public var total: Double?
	public var done: Bool?
	public var error: String?
}

public struct LocalModelsStatus: Codable, Sendable, Hashable {
	public struct Ollama: Codable, Sendable, Hashable {
		public var name: String
		public var version: String?
		public var mlx: Bool
		public var updateForMlx: Bool
	}

	public var memoryGiB: Double
	public var appleSilicon: Bool
	public var servers: [LocalServerInfo]
	public var ollama: Ollama?
	public var suggestions: [SuggestedModel]
	public var checked: String
	public var pulls: [LocalPullProgress]
}

public struct UpdateStatus: Codable, Sendable, Hashable {
	public var current: String
	public var latest: String?
	public var security: Bool?
	public var notes: [String]?
	public var kind: String
	public var file: String?
	public var checked: String?
	public var error: String?
}

public struct UiPrefs: Codable, Sendable, Hashable {
	/// auto, light, dark
	public var theme: String
	public var showReasoning: Bool
	/// How much new sessions ask: ask, auto or full.
	public var permissions: String?
	/// The model that writes reasoning summaries; nil picks a fast one in the same place.
	public var summaryModel: String?
	/// Whether each step's reasoning gets a short summary (on unless turned off).
	public var reasoningSummaries: Bool?

	public init(theme: String = "auto", showReasoning: Bool = true, permissions: String? = nil, summaryModel: String? = nil, reasoningSummaries: Bool? = nil) {
		self.theme = theme
		self.showReasoning = showReasoning
		self.permissions = permissions
		self.summaryModel = summaryModel
		self.reasoningSummaries = reasoningSummaries
	}

	public var permissionMode: PermissionMode { permissions.flatMap(PermissionMode.init(rawValue:)) ?? .auto }
}

// MARK: The browser in a lab's sandbox

public struct BrowserPageState: Codable, Sendable, Hashable {
	public var sessionId: String
	public var site: String
	public var lab: String
	public var url: String
	public var title: String
	public var loading: Bool
	public var canBack: Bool
	public var canForward: Bool
	public var network: String?
	public var hosts: [String]?
}

public struct BrowserFrame: Codable, Sendable, Hashable {
	public var sessionId: String
	/// base64 JPEG
	public var data: String
	public var width: Double
	public var height: Double
}

/// What a surface needs to redraw a response that is still streaming when it attaches.
public struct PartialResponse: Codable, Sendable, Hashable {
	public struct ToolStream: Codable, Sendable, Hashable {
		public var index: Int
		public var name: String
		public var args: String

		public init(index: Int, name: String, args: String) {
			self.index = index
			self.name = name
			self.args = args
		}
	}

	public var text: String
	public var reasoning: String
	public var tools: [ToolStream]
	public var output: [String: String]

	public init(text: String = "", reasoning: String = "", tools: [ToolStream] = [], output: [String: String] = [:]) {
		self.text = text
		self.reasoning = reasoning
		self.tools = tools
		self.output = output
	}
}

/// What a surface answers when the engine asks it to act (the window's browser pane).
public struct SurfaceAnswer: Codable, Sendable, Hashable {
	public struct Image: Codable, Sendable, Hashable {
		public var mime: String
		public var data: String

		public init(mime: String, data: String) {
			self.mime = mime
			self.data = data
		}
	}

	public var text: String
	public var image: Image?

	public init(text: String, image: Image? = nil) {
		self.text = text
		self.image = image
	}
}

/// Where a running engine says it can be reached: `<home>/run/engine.json`.
public struct EngineFile: Codable, Sendable, Hashable {
	public var pid: Int32
	public var port: Int
	public var token: String
	public var version: String
	public var started: String
}
