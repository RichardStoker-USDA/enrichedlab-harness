// The Lab protocol: what the engine and every surface (terminal, desktop, browser, editor bridge) say to each other.
// JSON-RPC 2.0 over a WebSocket on loopback. Surfaces import only this file from the engine side.

export const PROTOCOL_VERSION = 1;

// ── Content ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type Part = { type: "text"; text: string } | { type: "image"; mime: string; data: string };

/** One event of the shared session log, v1 (docs/session-log.md). */
export interface LogV1Event {
	v: 1;
	seq: number;
	time: string;
	kind: string;
	data: Record<string, unknown>;
}

export interface ToolCall {
	id: string;
	name: string;
	/** Raw JSON text as the model wrote it. */
	args: string;
}

export interface Usage {
	input: number;
	output: number;
	cached?: number;
	reasoning?: number;
}

export type StopReason = "end" | "tool_use" | "length" | "error" | "cancelled";

/** How a tool's call is shown: the verb and its target, as one step line. */
/** A file a tool returned by reference: where it lives, what it is, and its checksum. */
export interface FileRef {
	uri: string;
	name: string;
	mime?: string;
	bytes?: number;
	sha256?: string;
}

export interface StepView {
	verb: string;
	target: string;
	/** A lab tool its lab hasn't reviewed yet; shown beside the step and in the question. */
	unreviewed?: boolean;
	/** Files a lab tool returned by reference (its data stays at the lab until the person saves a copy). */
	files?: FileRef[];
	/** Short result for the right edge of the step line, e.g. "120 lines" or "exit 0". */
	result?: string;
	/** Longer output shown when the step is opened. */
	detail?: string;
	/** Unified diff for edits and writes. */
	diff?: string;
	/** A canvas the step published. */
	canvas?: string;
	/** A child session the step started (a subagent). */
	session?: string;
}

// ── Durable session events (one JSON object per line in the session log) ─────────────────────────────────────────

export interface EventBase {
	id: string;
	at: string;
}

export type SessionEvent =
	| (EventBase & {
			t: "header";
			v: 1;
			cwd: string;
			created: string;
			/** The system prompt, frozen for the session so prompt caches stay valid. */
			system?: string;
			/** The site this session is bound to: it sees only that site's tools and models. */
			site?: string;
			/** The session that started this one as a subagent, and what it may do. */
			parent?: string;
			mode?: "read" | "full";
			/** Set when the session works in its own git worktree: the repository, the worktree folder and its branch. */
			worktree?: { repo: string; path: string; branch: string };
	  })
	| (EventBase & { t: "user"; text: string; images?: Part[] })
	| (EventBase & {
			t: "assistant";
			model: string;
			text: string;
			reasoning?: string;
			/** Provider data needed to replay reasoning (e.g. a signature). Never shown. */
			reasoningData?: unknown;
			toolCalls?: ToolCall[];
			usage?: Usage;
			stop: StopReason;
			error?: string;
			ms?: number;
	  })
	| (EventBase & {
			t: "tool";
			callId: string;
			name: string;
			ok: boolean;
			/** What the model sees. */
			content: string;
			images?: Part[];
			view?: StepView;
			/** Handle of the full output when it was too large to keep inline. */
			handle?: string;
			decision?: "auto" | "allowed" | "allowed_session" | "denied" | "refused";
	  })
	| (EventBase & { t: "elide"; ids: string[]; tokensBefore: number })
	| (EventBase & { t: "compaction"; summary: string; firstKeptId: string; tokensBefore: number; model: string })
	| (EventBase & { t: "model"; model: string; effort?: string })
	| (EventBase & { t: "title"; title: string })
	| (EventBase & { t: "notice"; level: "info" | "warn" | "error"; text: string })
	/** Files as they were before a tool call changed them (see session.undo). */
	| (EventBase & {
			t: "checkpoint";
			callId: string;
			files: { path: string; existed: boolean; blob?: string }[];
			/** In a git repository: the working tree before the turn, as a commit on refs/enrichedlab/checkpoints. */
			git?: string;
			/** The folder as it was at this point, in the session's step history (docs/history.md); "turn" marks a turn's start. */
			history?: string;
			/** The tool calls this snapshot follows. */
			calls?: string[];
			/** Files the snapshot left out (too large, or past one step's limit): going back leaves them as they are. */
			skipped?: string[];
	  })
	/** The folder went back to how it was before a step. `saved` is the present just before, so it can come back too. */
	| (EventBase & { t: "rewind"; before: string; to: string; saved: string; restored: string[]; removed: string[] })
	/** File changes since the last message were put back. The model is told on its next request. */
	| (EventBase & {
			t: "undo";
			files: string[];
			/** True when a git snapshot restored the whole working tree, shell changes included. */
			all?: boolean;
	  })
	/** The session moved: files and commands now act in `root` at `place` ("local" or a site name). */
	| (EventBase & {
			t: "place";
			place: string;
			label: string;
			root: string;
			/** The repository came along: the commit sent, so new work can come back as a branch. */
			carried?: { repo: string; base: string; home?: string; id: string };
			/** Where the session started (a site that keeps work in its sandbox); the system prompt already says so. */
			initial?: boolean;
	  })
	/**
	 * Discovery mode turned on or off at a lab. While on and the session works there, what acts inside that lab (its
	 * sandbox, its tools) runs without asking, for a person the lab grants it to.
	 */
	| (EventBase & { t: "discovery"; on: boolean; site: string })
	/** The person answered "allow for this session": these keys run without asking for the rest of it. */
	| (EventBase & { t: "allow"; keys: string[]; scope: string })
	/** The person set how much this session asks; absent `mode` returns to the configured one. */
	| (EventBase & { t: "permissions"; mode?: PermissionMode })
	/**
	 * A short summary of one assistant step's reasoning, for the person reading the session. The full reasoning stays on
	 * the step (`of`); the model never sees this. Made by a model in the same place as the session's model.
	 */
	| (EventBase & { t: "reasoning_summary"; of: string; text: string; model: string })
	/** What an open app shows, sent by the app (MCP Apps ui/update-model-context). The model reads the latest. */
	| (EventBase & {
			t: "app_context";
			app: string;
			title: string;
			text: string;
	  });

export type SessionEventType = SessionEvent["t"];

// ── Live state ───────────────────────────────────────────────────────────────────────────────────────────────────

export type Activity = "idle" | "thinking" | "writing" | "tool" | "waiting" | "compacting" | "retrying";

export interface ContextGauge {
	/** Tokens the next request is expected to carry. */
	used: number;
	/** Where automatic compaction starts. */
	threshold: number;
	window: number;
	/** True when `used` is an estimate (no provider count yet). */
	estimated: boolean;
}

export interface SessionStatus {
	sessionId: string;
	activity: Activity;
	/** Files the last turn changed that undo would put back; absent when nothing changed. */
	undoable?: string[];
	model: string;
	effort?: string;
	context: ContextGauge;
	/** Output tokens per second of the last response. */
	rate?: number;
	queued: number;
	detail?: string;
}

export interface SessionSummary {
	id: string;
	cwd: string;
	title: string;
	created: string;
	updated: string;
	model: string;
	turns: number;
	running: boolean;
	site?: string;
	/** Set on subagent sessions: the session that started it. */
	parent?: string;
	/** Where its files and commands act: "local" or a site name. */
	place?: string;
	/** The lab where Discovery mode is on for this session. */
	discovery?: string;
	/** How much this session asks, when the person set it for this session. */
	permissions?: PermissionMode;
}

// ── Models and sites ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where a model runs, so people know where what they send goes: on this computer, on a machine on their network, at a
 * lab (its own servers), or at a cloud service. `name` is the computer, host, lab or service.
 */
export interface ModelWhere {
	kind: "device" | "network" | "lab" | "cloud";
	name: string;
}

export interface ModelInfo {
	/** `<provider>/<model>` */
	ref: string;
	provider: string;
	id: string;
	label: string;
	source: "local" | "config" | "site";
	where: ModelWhere;
	context: number;
	maxOutput: number;
	vision: boolean;
	efforts: string[];
	defaultEffort?: string;
}

/** An installed add-on: skills, instructions, MCP servers, hooks and model settings in one. */
export interface BundleSummary {
	name: string;
	version: string;
	description: string;
	/** A folder, an https git address, or "site:<name>" for one a site granted. */
	source: string;
	sha256: string;
}

export interface SiteSummary {
	name: string;
	/** What people see: the lab's name. */
	title: string;
	url: string;
	kind: string;
	/** Only sessions bound to it see its tools and models. */
	isolated?: boolean;
	signedIn: boolean;
	who?: string;
	via?: "oauth" | "key";
	models: number;
	tools: number;
	sandbox: boolean;
	/** The lab runs a browser in the person's sandbox (the browser tools' sandbox lane). */
	browser?: boolean;
	error?: string;
	/** Connected, but something the person should know (for example: the browser sign-in was refused and the LAN key is in use). */
	warning?: string;
	/** From the lab's own description: where to get help and read its docs, and whether it keeps data inside. */
	support?: string;
	docs?: string;
	keepsDataInside?: boolean;
	/** Sandbox sizes the lab offers. */
	profiles?: { name: string; cpu: number; memory: string; gpu?: string }[];
	/** A desktop sandbox the person and the agent work in, through the lab's checked actions. */
	desktop?: { width?: number; height?: number; actions: string[]; open: boolean; /** Made before the lab's current desktop image: desktop.update moves it over, keeping its files. */ outdated?: boolean };
}

/** A part of a desktop's screen from its live view: a JPEG (base64) to draw at x, y, w by h desktop pixels. */
export interface DesktopBand {
	site: string;
	x: number;
	y: number;
	w: number;
	h: number;
	jpeg: string;
}

/** Whether a desktop's live view runs; when it ends, windows go back to pictures after each action. */
export interface DesktopStream {
	site: string;
	live: boolean;
	width?: number;
	height?: number;
	/** Why it ended: access_ended, time_limit, desktop_gone, slow_client, or closed. */
	reason?: string;
}

/** A picture of a lab's desktop sandbox after an action (PNG), for the windows that show it. */
export interface DesktopFrame {
	site: string;
	png: string;
	width: number;
	height: number;
	/** Who the client said asked for the action: the agent, or the person in the pane. */
	by: "agent" | "person";
	at: string;
}

/** Something a lab told this person: a job finished, a sandbox is about to stop, a quota is near. */
export interface LabNotice {
	site: string;
	type: string;
	at: string;
	text: string;
	session?: string;
	/** A page the notice points to (https), such as where to approve a lab agent's run. */
	url?: string;
}

export interface PermissionRequest {
	requestId: string;
	sessionId: string;
	callId: string;
	tool: string;
	view: StepView;
	/** Why it asks, in plain words. */
	reason: string;
	/** The answer can't be remembered for the session (pushes, unreviewed lab tools): offer allow and deny only. */
	once?: boolean;
	/** For a subagent's question: the session it works for, whose windows show the question. */
	lead?: string;
	/** What "allow for this session" covers, in words for the button: "“python” commands", "requests to example.org". */
	scope?: string;
	/** A folder the person hasn't let EnrichedLab change yet: offer allow_folder, which lets it change files there. */
	folder?: string;
}

/** allow_folder: let EnrichedLab change files in the request's folder from now on, in every session. */
export type PermissionDecision = "allow" | "allow_session" | "allow_folder" | "deny";

/** How much a session asks: ask (before changes), auto (only for what history can't take back), full (never). */
export type PermissionMode = "ask" | "auto" | "full";

export interface CanvasSummary {
	id: string;
	sessionId: string;
	title: string;
	/**
	 * html, markdown, svg, image: a document the engine serves at `url`. table and plot: data the surface draws
	 * itself from `source` (read with view.data). page: a running app at `href` (a Shiny or Streamlit app, a dev server).
	 */
	kind: "html" | "markdown" | "svg" | "image" | "table" | "plot" | "page";
	url: string;
	updated: string;
	version: number;
	/** The data file and where it lives ("local" or a site name), for table and plot. */
	source?: { path: string; place: string };
	/** Columns to draw, for plot. */
	plot?: { x: string; y: string; color?: string; type?: "scatter" | "line" };
	/** The app's address, for page. */
	href?: string;
}

// ── Apps ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// An app is a web page that runs in a workbench pane and reaches tools through its host, on the MCP Apps protocol
// (io.modelcontextprotocol/ui, 2026-01-26). Its backend, when it has one, is an MCP server: a module on the Bun
// runtime inside EnrichedLab, a program the person has, or a container. See docs/apps.md.

/** What an app may do beyond drawing itself. The person allows these when it first opens, and again if they grow. */
export interface AppPermissions {
	/** Read, or also change, files in the project of the session it opens in. */
	files?: "read" | "write";
	/** Run commands where that session works, contained like the agent's. */
	commands?: boolean;
	/** Ask the session's model. */
	models?: boolean;
	/** Run commands in these labs' sandboxes (site names). */
	labs?: string[];
	/** Origins the page and its backend may reach, such as "https://api.example.org". None by default. */
	network?: string[];
}

/** Another device asks to use the person's sign-in at a lab: the person approves it, or revokes it if it isn't theirs. */
export interface DeviceRequest {
	site: string;
	lab: string;
	id: string;
	name: string;
	created: string;
}

/** One of the person's devices at a lab. */
export interface LabDevice {
	id: string;
	name?: string;
	status?: string;
	created?: string;
	last_seen?: string;
	current?: boolean;
	thumbprint?: string;
}

/** One of the person's sandboxes at a lab (GET /v1/containers). */
export interface LabSandbox {
	id: string;
	name?: string;
	/** running, starting, stopped, archived, restoring, or deleting while the lab clears it (it still counts toward the limit) */
	status?: string;
	created?: string;
	last_active?: string;
	/** its memory, such as 4g */
	memory?: string;
	profile?: string;
	/** the one this engine works in */
	current?: boolean;
	/** it runs and the lab can stop it, freeing its place under the lab's limit on sandboxes running at once */
	stoppable?: boolean;
	/** why the lab ended or stopped it, when it says: one the lab ended itself lists as deleted, with no files */
	reason?: string;
	/** the image it was made from, when not the lab's default (such as browser) */
	image?: string;
	/** internet when it reaches the public web; such a sandbox takes no lab files */
	network?: string;
}

/** An app version a lab offers this person (its /v1/apps), as the Apps list shows it. */
export interface LabApp {
	/** The lab's short name on this computer. */
	site: string;
	/** The lab's title. */
	lab: string;
	name: string;
	title: string;
	version: string;
	description: string;
	signer: { fingerprint: string; name?: string };
	runtime?: string;
	permissions: Record<string, unknown>;
	published?: string;
	/** The lab withdrew this version, or stopped vouching for its signer: it can't be installed. */
	withdrawn: boolean;
	signerRevoked: boolean;
	/** The version installed on this computer, if any. */
	installed?: string;
}

export interface AppSummary {
	id: string;
	name: string;
	title: string;
	version: string;
	description: string;
	/** Where its files are, for display. */
	dir: string;
	/** "project", "library", "bundle:<name>", or "mcp:<server>" for an MCP server's view. */
	source: string;
	backend?: "bun" | "command" | "container" | "serve";
	permissions: AppPermissions;
	/** True once the person has allowed its permissions (always true for an app that asks for none). */
	granted: boolean;
	/** Short fingerprint of the key that signed a packaged app. */
	signer?: string;
}

export interface AppToolResult {
	content: { type: string; text?: string; data?: string; mimeType?: string }[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

/** What a surface answers when the engine asks it to act (the desktop's browser pane). */
export interface SurfaceAnswer {
	text: string;
	image?: { mime: string; data: string };
}

/** A model service someone can add with their own key. */
export interface ProviderPreset {
	id: string;
	label: string;
	api: "openai-chat" | "openai-responses" | "anthropic";
	baseUrl: string;
	keyUrl?: string;
	note: string;
}

/** An account signed in through a service's own sign-in (ChatGPT plan use). Tokens never leave the engine. */
export interface ServiceAccount {
	service: "chatgpt";
	id: string;
	label: string;
	active: boolean;
	signedIn: boolean;
	/** The account allowed EnrichedLab to use its plan. */
	plan: boolean;
}

/** What `update.check` found. `kind` is how this copy was installed. */
/** A model server found on this computer, named by how it answered (llama.cpp and mlx_lm.server share 8080). */
export interface LocalServerInfo {
	name: string;
	kind: string;
	label: string;
	port: number;
	version?: string;
	models: string[];
}

/** An open model the app suggests downloading, and whether it fits this computer's memory. */
export interface SuggestedModel {
	model: string;
	label: string;
	sizeGB: number;
	traits: string[];
	about: string;
	fits: boolean;
	installed: boolean;
}

/** One download's progress, summed over its layers; `done` with no `error` means it's ready to use. */
export interface LocalPullProgress {
	model: string;
	status: string;
	completed?: number;
	total?: number;
	done?: boolean;
	error?: string;
}

export interface LocalModelsStatus {
	memoryGiB: number;
	appleSilicon: boolean;
	servers: LocalServerInfo[];
	/** Present when Ollama runs here. `mlx`: it runs models on MLX; `updateForMlx`: a newer Ollama would. */
	ollama?: { name: string; version?: string; mlx: boolean; updateForMlx: boolean };
	suggestions: SuggestedModel[];
	/** When the suggestions were last checked against the Ollama library. */
	checked: string;
	pulls: LocalPullProgress[];
}

export interface UpdateStatus {
	current: string;
	latest?: string;
	security?: boolean;
	notes?: string[];
	kind: "mac-app" | "windows-app" | "appimage" | "binary" | "source";
	file?: string;
	checked?: string;
	error?: string;
}

// ── Requests (surface to engine) ─────────────────────────────────────────────────────────────────────────────────

export interface Requests {
	hello: { params: { client: string; version: string; capabilities?: string[] }; result: { engine: string; protocol: number; home: string; pid: number } };
	/** Newest first. `query` matches words in the title or folder, across all history. */
	"session.list": { params: { cwd?: string; limit?: number; query?: string }; result: SessionSummary[] };
	"session.create": { params: { cwd: string; model?: string; site?: string; worktree?: boolean }; result: SessionSummary };
	"session.open": {
		params: { sessionId: string };
		result: { summary: SessionSummary; events: SessionEvent[]; status: SessionStatus; pending: PermissionRequest[]; partial?: Partial_ };
	};
	"session.close": { params: { sessionId: string }; result: { ok: true } };
	"session.prompt": { params: { sessionId: string; text: string; images?: Part[] }; result: { queued: boolean } };
	/** Stops the turn. Messages that were waiting to join it come back (`returned`), for the person to send again. */
	"session.cancel": { params: { sessionId: string }; result: { ok: true; returned?: string[] } };
	"session.model": { params: { sessionId: string; model?: string; effort?: string }; result: SessionStatus };
	"session.compact": { params: { sessionId: string }; result: { ok: boolean; detail: string } };
	/** Put the folder back as it was before a step (an event id in the log); with `retry`, a new session continues from there. */
	"session.rewind": { params: { sessionId: string; before: string; retry?: boolean }; result: { ok: boolean; detail: string; files: string[]; session?: SessionSummary } };
	"session.undo": { params: { sessionId: string }; result: { ok: boolean; files: string[]; detail: string } };
	"session.rename": { params: { sessionId: string; title: string }; result: { ok: true } };
	/** Move where the session's files and commands act. A git repository comes along when `carry` is set. */
	"session.place": { params: { sessionId: string; place: string; carry?: boolean }; result: { summary: SessionSummary; detail: string } };
	/** One action in a lab's desktop sandbox from the person in the pane (contract/desktop.schema.json). */
	"desktop.act": { params: { site: string; action: Record<string, unknown> }; result: { frame?: DesktopFrame; cursor?: [number, number] } };
	/** Open an https address or a /sandbox file on a lab's desktop. */
	"desktop.open": { params: { site: string; target: string }; result: { frame?: DesktopFrame } };
	/** Move an outdated desktop to the lab's current image, keeping its files (its open windows close). */
	"desktop.update": { params: { site: string }; result: { ok: true } };
	/** Watch a lab desktop live where the lab streams it: desktop.band notifications follow while on. */
	"desktop.watch": { params: { site: string; on: boolean }; result: DesktopStream };
	/** Turn Discovery mode on or off; on only in a session at a lab that grants the person `discovery`. */
	"session.discovery": { params: { sessionId: string; on: boolean }; result: { summary: SessionSummary; detail: string } };
	/** Set how much this session asks; no mode returns it to the configured one. */
	"session.permissions": { params: { sessionId: string; mode?: PermissionMode }; result: SessionSummary };
	/** What EnrichedLab may do in a folder: read it with `access` absent, set it with "change", "read" or "none". */
	"folder.access": { params: { path: string; access?: "change" | "read" | "none" }; result: { path: string; access?: "change" | "read" } };
	/** The folders the person answered for, with what EnrichedLab may do in each. */
	"folder.list": { params: Record<string, never>; result: { path: string; access: "change" | "read"; at: string }[] };
	"permission.answer": { params: { requestId: string; decision: PermissionDecision }; result: { ok: boolean } };
	"model.list": { params: { refresh?: boolean }; result: { models: ModelInfo[]; default?: string } };
	"model.default": { params: { model: string; effort?: string }; result: { ok: true } };
	/** Read config.json and installed bundles again, and connect or drop MCP servers to match. */
	"config.reload": { params: Record<string, never>; result: { bundles: BundleSummary[] } };
	"site.list": { params: Record<string, never>; result: SiteSummary[] };
	"site.add": { params: { name: string; url: string; title?: string; isolated?: boolean }; result: SiteSummary };
	"site.login": { params: { name: string }; result: SiteSummary };
	"site.logout": { params: { name: string }; result: { ok: true } };
	/** Forget a lab on this computer: sign out and drop it. Its sessions stay, without its models and tools. */
	"site.remove": { params: { name: string }; result: { ok: true } };
	/** Exercise a lab against the lab contract (contract/ in the repository); read-only apart from one throwaway sandbox. */
	"lab.check": { params: { name: string }; result: { rows: { row: string; status: "pass" | "fail" | "skip"; detail?: string }[] } };
	/** The person's devices at a lab, and approving or revoking one (a lab that binds sign-ins to devices). */
	"lab.devices": { params: { name: string }; result: LabDevice[] };
	"lab.device.approve": { params: { name: string; id: string }; result: { ok: true } };
	"lab.device.revoke": { params: { name: string; id: string }; result: { ok: true } };
	/** The person's sandboxes at a lab, and deleting one (it frees the lab's limit on how many a person keeps). */
	"lab.sandboxes": { params: { name: string }; result: LabSandbox[] };
	"lab.sandbox.delete": { params: { name: string; id: string }; result: { status: "deleted" | "deleting" } };
	"lab.sandbox.create": { params: { name: string; image?: string; network?: string }; result: { id: string; image?: string; network?: string; previous?: string } };
	"lab.sandbox.stop": { params: { name: string; id: string }; result: { status: "stopped" | "stopping" | "archived" } };
	/** Use by lab and group over the window (GET /v1/usage). */
	"lab.usage": { params: { name: string; window?: "7d" | "30d" }; result: unknown };
	/** Save a file a lab tool returned by reference into the session's project; the checksum is checked when given. */
	"site.save": { params: { sessionId: string; uri: string; name: string; sha256?: string }; result: { path: string; bytes: number } };
	"site.refresh": { params: { name?: string }; result: SiteSummary[] };
	"canvas.list": { params: { sessionId?: string }; result: CanvasSummary[] };
	"ui.get": { params: Record<string, never>; result: UiPrefs };
	"ui.set": { params: Partial<UiPrefs>; result: UiPrefs };
	/** A folder where the session works (this computer or a lab sandbox). Paths are relative to its root. */
	"fs.list": { params: { sessionId: string; path?: string }; result: { root: string; place: string; entries: { name: string; type: "file" | "dir" | "link" | "other"; size: number }[] } };
	/** A text file's contents (up to 2 MB) where the session works. */
	"fs.read": { params: { sessionId: string; path: string }; result: { path: string; size: number; text?: string; binary?: boolean } };
	/** Open a file where the session works as a view: data as a table (or plot), images and HTML as shown. */
	"view.open": { params: { sessionId: string; path: string; plot?: CanvasSummary["plot"] }; result: CanvasSummary };
	/** The data behind a table or plot view: text for CSV, TSV and JSON; base64 for Parquet. */
	"view.data": { params: { canvasId: string }; result: { name: string; size: number; text?: string; base64?: string } };
	/** A terminal where the session works (or this computer without one): the person's shell, or a sandbox console. */
	"term.open": { params: { sessionId?: string; cwd?: string; cols: number; rows: number }; result: { termId: string; label: string } };
	"term.input": { params: { termId: string; data: string }; result: { ok: true } };
	"term.resize": { params: { termId: string; cols: number; rows: number }; result: { ok: true } };
	"term.close": { params: { termId: string }; result: { ok: true } };
	/** Remove a session and its log; refused while it runs. */
	"session.delete": { params: { sessionId: string }; result: { ok: true } };
	/** Send a session to a lab's Rein (its web harness) in the shared log format; `result` is Rein's answer. */
	"session.push": { params: { sessionId: string; site: string; title?: string }; result: { records: number; result: unknown } };
	/** Bring a Rein session back as a new session here, working in `cwd`. */
	"session.pull": { params: { site: string; id: string; cwd?: string }; result: { records: number; summary: SessionSummary } };
	/** What moving the session would carry: whether its folder is a git repository (whose work, uncommitted too, goes along). */
	"session.moveplan": { params: { sessionId: string }; result: { repo?: string } };
	/** The session in the shared log format v1 (docs/session-log.md), with the bytes of the images it refers to. */
	"session.export": { params: { sessionId: string }; result: { events: LogV1Event[]; attachments: Record<string, { mime: string; data: string }> } };
	/** A new session from a v1 log: its context rebuilt as the format says. `cwd` overrides the folder it names. */
	"session.import": { params: { events: LogV1Event[]; attachments?: Record<string, { mime: string; data: string }>; cwd?: string; model?: string }; result: SessionSummary };
	/** A surface's answer to surface.call. */
	"surface.reply": { params: { callId: string; result?: SurfaceAnswer; error?: string }; result: { ok: true } };
	/** A window shows (or stops showing) the session's page in a lab's sandbox browser: frames come while one does. */
	"browser.watch": { params: { sessionId: string; on: boolean | "again" }; result: { page?: BrowserPageState } };
	/** The window's pane size for the sandbox browser's page, in CSS pixels: the page lays out to it. */
	"browser.resize": { params: { sessionId: string; width: number; height: number }; result: { ok: true } };
	/** The person's own click, scroll or key in the sandbox browser's page. */
	"browser.input": { params: { sessionId: string; event: BrowserInput }; result: { ok: true } };
	/** The person moving the sandbox browser's page: an address, back, forward or reload. */
	"browser.navigate": { params: { sessionId: string; site?: string; url?: string; step?: "back" | "forward" | "reload" }; result: { ok: true } };
	/** Services `provider.add` knows, and the ones this person added. */
	"provider.list": {
		params: Record<string, never>;
		result: { presets: ProviderPreset[]; added: { name: string; label: string; baseUrl: string }[]; accounts: ServiceAccount[] };
	};
	/** Sign in through the service's own page in the browser (provider.auth carries the address). `account` signs
	 * in again to a saved account; without it a new account is added. `welcome` is true the first time plan use is on. */
	"provider.signin": { params: { service: "chatgpt"; account?: string }; result: { account: ServiceAccount; models: number; welcome: boolean } };
	/** End the account's session at the service and clear its tokens; `revoked` says the service confirmed it. */
	"provider.signout": { params: { service: "chatgpt"; account: string }; result: { revoked: boolean } };
	/** Use this saved account from now on. */
	"provider.use": { params: { service: "chatgpt"; account: string }; result: { ok: true } };
	/** Check a key against the service, keep it in the OS credential store, and offer the service's models. */
	"provider.add": { params: { preset: string; key: string; name?: string; baseUrl?: string }; result: { name: string; models: number } };
	"provider.remove": { params: { name: string }; result: { ok: true } };
	/** Model servers on this computer, and open models to download that fit it. */
	"local.models": { params: Record<string, never>; result: LocalModelsStatus };
	/** Start downloading an open model through Ollama; local.pull.progress follows it. */
	"local.pull": { params: { model: string }; result: { ok: true } };
	"local.pull.cancel": { params: { model: string }; result: { ok: true } };
	/** Delete a downloaded model from Ollama. */
	"local.remove": { params: { model: string }; result: { ok: true } };
	/** Whether a newer release is out (checked at most daily unless `force`). */
	"update.check": { params: { force?: boolean }; result: UpdateStatus };
	/** Download, verify and install the newer release. `restart` means the app should quit and start again. */
	"update.apply": { params: Record<string, never>; result: { version: string; restart: boolean } };
	"app.list": { params: Record<string, never>; result: AppSummary[] };
	/** Apps the person's labs offer them, every listed version, with what's installed. */
	"lab.apps": { params: Record<string, never>; result: LabApp[] };
	/** Install (or update to) an app from a lab's list; the package is checked against the listing and its signature. */
	"lab.app.install": { params: { site: string; name: string; version?: string }; result: AppSummary };
	/** Open an app for a session: a library app by id, or a folder with an app.json. The page lives at `url`. */
	"app.open": {
		params: { sessionId?: string; id?: string; path?: string };
		result: {
			app: AppSummary;
			token: string;
			/** Empty until the person allows what `asks` lists. */
			url: string;
			kind: "view" | "page";
			/** What the app asks for, in plain words, for the consent card. */
			asks: string[];
			toolInput?: Record<string, unknown>;
			toolResult?: AppToolResult;
		};
	};
	"app.grant": { params: { id: string; allow: boolean }; result: AppSummary };
	/** A tools/call from an open app: its backend's tools, or the host's lab_* tools its permissions allow. */
	"app.call": { params: { token: string; name: string; arguments?: Record<string, unknown> }; result: AppToolResult };
	/** ui/message: the app speaks for the person in its session. */
	"app.message": { params: { token: string; text: string }; result: { ok: true } };
	/** ui/update-model-context: what the app shows, for the model's next turn. */
	"app.context": { params: { token: string; text: string }; result: { ok: true } };
	"app.close": { params: { token: string }; result: { ok: true } };
	"engine.pair": { params: { next?: string }; result: { url: string } };
	"engine.stop": { params: Record<string, never>; result: { ok: true } };
}

/** What a surface needs to redraw a response that is still streaming when it attaches. */
export interface Partial_ {
	text: string;
	reasoning: string;
	tools: { index: number; name: string; args: string }[];
	/** Output so far of tools still running, by call id. */
	output: Record<string, string>;
}

export interface UiPrefs {
	theme: "auto" | "light" | "dark";
	showReasoning: boolean;
	/** How much new sessions ask (a session can set its own); kept in config.json as permissions.mode. */
	permissions: PermissionMode;
}

// ── The browser in a lab's sandbox ───────────────────────────────────────────────────────────────────────────────

/** What a lab's sandbox can reach on the web: nothing, the hosts listed, or anything its network policy allows. */
export type SandboxNetwork = "none" | "allowlist" | "open";

export interface BrowserPageState {
	sessionId: string;
	site: string;
	/** The lab's display name. */
	lab: string;
	url: string;
	title: string;
	loading: boolean;
	canBack: boolean;
	canForward: boolean;
	network?: SandboxNetwork;
	hosts?: string[];
}

export interface BrowserFrame {
	sessionId: string;
	/** base64 JPEG */
	data: string;
	/** The page's size in CSS pixels, for mapping the person's clicks onto it. */
	width: number;
	height: number;
}

/** Input in page CSS pixels. `modifiers` is a bit set: Alt 1, Control 2, Meta 4, Shift 8. */
export type BrowserInput =
	| { kind: "mouse"; type: "mouseMoved" | "mousePressed" | "mouseReleased"; x: number; y: number; button?: "left" | "middle" | "right" | "none"; clickCount?: number; modifiers?: number }
	| { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
	| { kind: "key"; type: "keyDown" | "keyUp"; key: string; code?: string; modifiers?: number }
	| { kind: "text"; text: string };

export type Method = keyof Requests;
export type Params<M extends Method> = Requests[M]["params"];
export type Result<M extends Method> = Requests[M]["result"];

// ── Notifications (engine to surface) ────────────────────────────────────────────────────────────────────────────

export interface Notifications {
	"session.event": { sessionId: string; event: SessionEvent };
	"session.delta": {
		sessionId: string;
		/** text and reasoning stream the answer; tool streams a call's arguments; output streams a running tool's output. */
		kind: "text" | "reasoning" | "tool" | "output";
		text: string;
		index?: number;
		name?: string;
		callId?: string;
	};
	"session.status": SessionStatus;
	"session.updated": SessionSummary;
	"permission.request": PermissionRequest;
	"permission.settled": { requestId: string; decision: PermissionDecision | "cancelled" };
	"site.auth": { name: string; url: string; instructions: string };
	/** A lab's event, in words, for the window and terminal to show. */
	"lab.notice": LabNotice;
	/** Open this sign-in page in the system browser (it comes back to the engine on 127.0.0.1). */
	"provider.auth": { service: string; url: string };
	"local.pull.progress": LocalPullProgress;
	"term.output": { termId: string; data: string };
	"term.exit": { termId: string; code: number | null };
	"site.updated": SiteSummary;
	"canvas.updated": CanvasSummary;
	/** An app's files changed: open views reload. */
	"app.changed": { id: string };
	/** Another device asks to use the person's sign-in at a lab. */
	"lab.device.pending": DeviceRequest;
	/** A lab's app list changed (read again, or an app was published or withdrawn). */
	"lab.apps.changed": { site: string };
	/** The agent opened an app in a session: surfaces show it. */
	"app.opened": { sessionId: string; app: AppSummary };
	"ui.updated": UiPrefs;
	/** Something in this session needs a window (a plot, a table, an app, the browser) and none shows it. */
	"surface.wanted": { sessionId: string; reason: string };
	/** The engine asks one surface showing this session to act (`capability` as declared in hello). */
	"surface.call": { callId: string; sessionId: string; capability: string; op: string; args: Record<string, unknown> };
	/** A newer release is out; surfaces offer it. */
	"update.available": UpdateStatus;
	/** Where the session's page in a lab's sandbox browser is: the window opens its pane on the first one. */
	"browser.page": BrowserPageState;
	/** A picture of that page (JPEG), while a window watches it. */
	"browser.frame": BrowserFrame;
	/** A picture of a lab's desktop after an action, the agent's or the person's. */
	"desktop.frame": DesktopFrame;
	/** A changed band of a watched desktop's screen: draw the JPEG at x, y (desktop pixels). */
	"desktop.band": DesktopBand;
	/** A watched desktop's live view started or ended. */
	"desktop.stream": DesktopStream;
}

export type Notification = keyof Notifications;

// ── Wire ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RpcRequest {
	jsonrpc: "2.0";
	id: number | string;
	method: string;
	params?: unknown;
}

export interface RpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface RpcResponse {
	jsonrpc: "2.0";
	id: number | string;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export const ErrorCodes = {
	parse: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internal: -32603,
	busy: -32001,
	notFound: -32004,
	unauthorized: -32010,
} as const;

/** Where a running engine says it can be reached: `<home>/run/engine.json`. */
export interface EngineFile {
	pid: number;
	port: number;
	token: string;
	version: string;
	started: string;
	/** From a health check, not the file: a turn is running. */
	busy?: boolean;
}
