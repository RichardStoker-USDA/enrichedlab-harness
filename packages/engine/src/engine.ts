// The engine: one per person. It owns sessions, models, tools, sites and canvases, and answers the Lab protocol.
// Surfaces (terminal, desktop, browser, editor bridge) attach over the server in server.ts, or a headless run calls
// it in-process.

import { createHash } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type {
	DesktopStream,
	Method,
	Notification,
	Notifications,
	Params,
	PermissionDecision,
	PermissionRequest,
	Result,
	SessionSummary,
	SurfaceAnswer,
	UiPrefs,
} from "@enrichedlab/protocol";
import { type LogV1Event, PROTOCOL_VERSION } from "@enrichedlab/protocol";
import { type Attachments, fromV1, importProblem, toV1 } from "./session/log_v1.ts";
import { AppHost, type AppSession } from "./apps/host.ts";
import { CanvasStore } from "./canvas.ts";
import { applyBundles, listBundles } from "./bundles.ts";
import { DEFAULT_CONFIG, type LabConfig, loadConfig, type PermissionMode, type ProviderConfig, saveConfig } from "./config.ts";
import { folderAccess, modeOf } from "./permissions.ts";
import { McpManager } from "./mcp.ts";
import { ModelRegistry } from "./models/registry.ts";
import { LocalModels } from "./models/local_service.ts";
import { ensureHome, type Paths, paths as labPaths } from "./paths.ts";
import { projectRoot, systemPrompt } from "./prompt.ts";
import { listSessions, SessionLog, toSummary } from "./session/log.ts";
import { type RuntimeDeps, SessionRuntime } from "./session/runtime.ts";
import { Sites } from "./sites/sites.ts";
import { checkAction } from "./sites/desktop.ts";
import { createWorktree, repoRoot } from "./git.ts";
import { fetchRepo, sendRepo } from "./sites/repo_handoff.ts";
import { type SandboxApi, SandboxWorkspace, shq } from "./sites/sandbox_workspace.ts";
import { findSkills, skillDirs } from "./skills.ts";
import { type SearchConfig, searchTool } from "./tools/search.ts";
import type { AgentResult } from "./tools/agents.ts";
import { agentStartTool, agentWaitTool } from "./tools/agents.ts";
import type { ModelProfile } from "./models/types.ts";
import { editTool, globTool, grepTool, lsTool, readTool, writeTool } from "./tools/files.ts";
import { fetchTool, planTool, recallTool, showTool } from "./tools/harness.ts";
import { shellTool } from "./tools/shell.ts";
import { appCreateTool, appOpenTool } from "./tools/apps.ts";
import type { Tool } from "./tools/types.ts";
import { readNotes, rememberTool, skillCreateTool } from "./memory.ts";
import { Terminals } from "./terminal.ts";
import { LocalWorkspace, type Workspace } from "./tools/workspace.ts";
import { applyUpdate, checkForUpdate } from "./update.ts";
import { BROWSER_TOOLS, type BrowserLanes } from "./tools/browser.ts";
import { SandboxBrowsers } from "./sites/sandbox_browser.ts";
import { pdfFieldsTool, pdfFillTool } from "./tools/pdf.ts";
import { forgetKey, PROVIDER_PRESETS, storeKey, testProvider } from "./models/providers.ts";
import { RESOURCE as CHATGPT_API, signIn as chatgptSignIn, signOut as chatgptSignOut, summaries as chatgptAccounts, useAccount as useChatgpt } from "./models/chatgpt.ts";
import { errorText, newId, readJson, sleep, VERSION, writeJson } from "./util.ts";

export const BUILT_IN_TOOLS: Tool[] = [readTool, writeTool, editTool, lsTool, globTool, grepTool, shellTool, fetchTool, showTool, recallTool, planTool, agentStartTool, agentWaitTool, rememberTool, skillCreateTool, appCreateTool, appOpenTool, pdfFieldsTool, pdfFillTool, ...BROWSER_TOOLS];

export class RpcError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
	}
}

export interface EngineOptions {
	paths?: Paths;
	/** How permission questions are answered when no surface is attached (a headless run). */
	headlessAnswer?: (request: PermissionRequest) => PermissionDecision;
	origin?: () => string;
	/** Look for a newer release once a day (the long-lived engine does; one-off runs and tests don't). */
	checkUpdates?: boolean;
}

type Listener = <N extends Notification>(name: N, params: Notifications[N], sessionId?: string) => void;

interface Waiting {
	request: PermissionRequest;
	resolve: (decision: PermissionDecision | "cancelled") => void;
}

const VIEW_DATA_MAX = 64 * 1024 * 1024;
const MAX_RUNNING_AGENTS = 4;
const NEEDS_READY = new Set<string>(["session.create", "session.prompt", "session.model", "session.compact", "model.list", "model.default", "site.list", "site.refresh"]);

export class Engine {
	readonly paths: Paths;
	config: LabConfig;
	readonly registry: ModelRegistry;
	private localModels: LocalModels;
	readonly mcp = new McpManager();
	readonly sites: Sites;
	readonly canvas: CanvasStore;
	readonly apps: AppHost;
	/** Each session's page in a lab sandbox's browser (the sandbox lane of the browser tools). */
	private browsers: SandboxBrowsers;
	/** Set by the server: whether a desktop window shows a session. */
	windowFor?: (sessionId: string) => boolean;
	private windowAsked = new Map<string, number>();

	/** Ask the session's terminal to open a window when something needs one and none shows the session. */
	wantWindow(sessionId: string | undefined, reason: string, now = false): void {
		if (!sessionId || !this.windowFor || this.windowFor(sessionId)) return;
		// Once a minute at most for things to look at; a call that waits on the window (the browser) asks every time.
		if (!now && Date.now() - (this.windowAsked.get(sessionId) ?? 0) < 60_000) return;
		this.windowAsked.set(sessionId, Date.now());
		this.emit("surface.wanted", { sessionId, reason }, sessionId);
	}

	/** Set by the server: ask a window showing a session to act (the desktop's browser pane). */
	surfaces?: (sessionId: string, capability: string, op: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<SurfaceAnswer>;
	private sessions = new Map<string, SessionRuntime>();
	private listeners = new Set<Listener>();
	private waiting = new Map<string, Waiting>();
	private origin: () => string;

	constructor(private options: EngineOptions = {}) {
		this.paths = options.paths ?? labPaths();
		ensureHome(this.paths);
		this.config = this.loadAll();
		this.registry = new ModelRegistry(() => this.config, this.paths.credentials);
		this.localModels = new LocalModels(this.registry, (progress) => this.emit("local.pull.progress", progress));
		this.origin = options.origin ?? (() => "http://127.0.0.1");
		this.sites = new Sites(this.paths, (summary) => {
			// A connect may have brought new or changed bundles from the site.
			this.reloadConfig();
			for (const source of this.sites.modelSources()) this.registry.addSource(source);
			this.emit("site.updated", summary);
		}, (notice) => this.emit("lab.notice", notice));
		this.sites.onAppsChanged = (site) => this.emit("lab.apps.changed", { site });
		this.sites.onDesktopFrame = (frame) => this.emit("desktop.frame", frame);
		this.sites.onDeviceRequest = (request) => this.emit("lab.device.pending", request);
		this.terminals = new Terminals((name, params) => this.emit(name, params as never));
		this.canvas = new CanvasStore(this.paths.canvases, () => this.origin(), (summary) => {
			this.emit("canvas.updated", summary, summary.sessionId);
			if (summary.version === 1) this.wantWindow(summary.sessionId, `"${summary.title}"`);
		});
		this.registry.aliases = () => this.sites.aliases();
		this.apps = new AppHost({
			paths: this.paths,
			emit: (name, params, sessionId) => {
				this.emit(name, params, sessionId);
				if (name === "app.opened") this.wantWindow(sessionId, `the app ${(params as { app: { title: string } }).app.title}`);
			},
			session: (id) => this.appSession(id),
			sandbox: (site) => (this.sites.sandbox(site) ? this.sandboxFor(site) : undefined),
			isolated: (site) => this.sites.isolated(site),
			bundles: () => listBundles(this.paths).map((b) => ({ name: b.name, dir: b.dir })),
			origin: () => this.origin(),
			labAppBlocked: (origin) => this.sites.appBlocked(origin),
			resolveLab: (name) => this.sites.resolve(name),
		});
		this.browsers = new SandboxBrowsers({
			connect: (site, signal) => {
				const api = this.sites.sandbox(site);
				if (!api?.cdp) throw new Error(`${this.sites.title(site)}'s sandbox has no browser.`);
				return api.cdp(signal);
			},
			prepare: async (site, dir, signal) => void (await this.sites.sandbox(site)?.run(`mkdir -p ${shq(dir)}`, 30, signal)),
			lane: (site) => this.sites.sandbox(site)?.browser?.(),
			title: (site) => this.sites.title(site),
			emit: (name: "browser.page" | "browser.frame", params: never, sessionId: string) => {
				this.emit(name, params, sessionId);
				if (name === "browser.page") this.wantWindow(sessionId, "the sandbox browser");
			},
		});
	}

	/** The browser tools' lanes for a session: the desktop window's browser, and the labs' sandbox browsers. */
	private browserLanes(sessionId: string): BrowserLanes {
		return {
			device: () => Boolean(this.windowFor?.(sessionId)),
			labs: () =>
				this.sites
					.list()
					.filter((s) => s.signedIn)
					.flatMap((s) => {
						const lane = this.sites.sandbox(s.name)?.browser?.();
						return lane ? [{ site: s.name, title: s.title, network: lane.network, hosts: lane.hosts }] : [];
					}),
			page: (site, signal) => this.browsers.page(sessionId, site, signal),
			last: () => this.browsers.lane(sessionId),
			remember: (where, site) => this.browsers.remember(sessionId, where, site),
		};
	}

	/** A session as the app host sees it. */
	private appSession(id: string): AppSession | undefined {
		let runtime: SessionRuntime;
		try {
			runtime = this.session(id);
		} catch {
			return undefined;
		}
		return {
			project: projectRoot(runtime.cwd),
			workspace: runtime.workspace,
			place: runtime.place,
			site: runtime.site,
			sealed: Boolean(runtime.site && this.sites.isolated(runtime.site)),
			modelRef: runtime.modelRef,
			prompt: (text) => void runtime.prompt(text),
			context: (app, title, text) => runtime.appContext(app, title, text),
			ask: (prompt, system, signal) => runtime.ask(prompt, system, signal),
		};
	}

	private starting?: Promise<void>;
	private terminals: Terminals;

	/** Discover models, connect sites and MCP servers. Requests that need models wait for this (at most 15 s). */
	start(): Promise<void> {
		this.starting ??= (async () => {
			await Promise.all([this.registry.refresh(), this.sites.connectAll(), this.mcp.sync(this.config.mcpServers)]);
			for (const source of this.sites.modelSources()) this.registry.addSource(source);
			// Sites may have granted bundles with MCP servers while the first sync ran.
			await this.mcp.sync(this.config.mcpServers);
			// A daily look for a newer release, off the start path; surfaces offer it when one is out.
			if (this.options.checkUpdates) {
				void checkForUpdate(this.paths.update).then((status) => status.latest && this.emit("update.available", status)).catch(() => undefined);
			}
		})();
		return this.starting;
	}

	private async ready(): Promise<void> {
		if (!this.starting) return;
		await Promise.race([this.starting.catch(() => undefined), new Promise((r) => setTimeout(r, 15_000))]);
	}

	async stop(): Promise<void> {
		this.terminals.closeAll();
		await this.browsers.closeAll();
		await this.apps.stop();
		for (const session of this.sessions.values()) session.cancel();
		await Promise.all([this.mcp.close(), this.sites.close()]);
	}

	onNotify(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit<N extends Notification>(name: N, params: Notifications[N], sessionId?: string): void {
		for (const listener of this.listeners) listener(name, params, sessionId);
	}

	get hasRunningSessions(): boolean {
		return [...this.sessions.values()].some((s) => s.isRunning);
	}

	/** Built-ins, the person's MCP servers, and the tools of the sites a session sees (see Sites.tools). */
	tools(site?: string): Tool[] {
		// An isolated site keeps code and data in its sandbox: no web, no personal MCP servers, and nothing downloaded
		// out of the sandbox. Its results are looked at in the surface's panes.
		if (site && this.sites.isolated(site)) {
			// Notes and skills are files on the person's computer that later sessions read; lab data stays out of them.
			const keeps = (t: Tool) => !/_sandbox_(download|repo_fetch)$/.test(t.name);
			const local = (t: Tool) => t.kind !== "net" && t.name !== "remember" && t.name !== "skill_create" && !t.name.startsWith("browser_");
			// The lab's own sandbox browser stays inside the lab: the browser tools use only it there (tools/browser.ts).
			const browser = this.sites.sandbox(site)?.browser?.() ? BROWSER_TOOLS : [];
			return [...BUILT_IN_TOOLS.filter(local), ...browser, ...this.sites.tools(site).filter(keeps)];
		}
		const search = this.config.search ? [this.searchTool(this.config.search)] : [];
		return [...BUILT_IN_TOOLS, ...search, ...this.mcp.tools(), ...this.sites.tools(site)];
	}

	/** A site's sandbox, looked up at each call so a session outlives reconnects and sign-ins. */
	private sandboxFor(site: string): SandboxApi {
		const sites = this.sites;
		const live = (): SandboxApi => {
			const api = sites.sandbox(site);
			if (!api) throw new Error(`${sites.title(site)} isn't connected, or its sandbox isn't on for you. Sign in again, or move this session back to this computer.`);
			return api;
		};
		return {
			get title() {
				return sites.title(site);
			},
			run: (command, timeout, signal) => live().run(command, timeout, signal),
			put: (path, signal) => live().put(path, signal),
			get: (path, target, signal) => live().get(path, target, signal),
			attach: (spec, signal) => {
				const api = live();
				if (!api.attach) throw Object.assign(new Error(`${sites.title(site)} doesn't stream sandbox processes.`), { unsupported: true });
				return api.attach(spec, signal);
			},
			openPort: (port, path, signal) => {
				const api = live();
				if (!api.openPort) throw Object.assign(new Error(`${sites.title(site)} doesn't open sandbox ports.`), { unsupported: true });
				return api.openPort(port, path, signal);
			},
		};
	}

	/** Read a table or plot's data file from where it lives. Text formats come as text, Parquet as base64. */
	private async viewData(source: { path: string; place: string }): Promise<{ name: string; size: number; text?: string; base64?: string }> {
		const workspace: Workspace = source.place === "local" ? new LocalWorkspace(dirname(source.path)) : new SandboxWorkspace(this.sandboxFor(source.place), "/sandbox");
		const info = await workspace.stat(source.path);
		if (info?.type !== "file") throw new RpcError(-32602, `${source.path} is gone.`);
		if (info.size > VIEW_DATA_MAX) throw new RpcError(-32602, `${basename(source.path)} is ${Math.round(info.size / 1_048_576)} MB; views read files up to ${VIEW_DATA_MAX / 1_048_576} MB. Ask for a sample or a summary.`);
		const data = await workspace.read(source.path);
		const name = basename(source.path);
		return /\.parquet$/i.test(name) ? { name, size: data.length, base64: data.toString("base64") } : { name, size: data.length, text: data.toString("utf8") };
	}

	/** The folder a session works in inside a site's sandbox. */
	private sandboxRoot(cwd: string, sessionTail: string): string {
		return `/sandbox/work/${basename(cwd).replace(/[^\w.-]/g, "_") || "work"}-${sessionTail}`;
	}

	/** A new session from shared-log records, held to the import limits; the conversation only (log_v1.ts). */
	private importLog(input: unknown[], attachments: Attachments, cwd: string | undefined, model: string | undefined): SessionSummary {
		const problem = importProblem(input, attachments);
		if (problem) throw new RpcError(-32602, problem);
		const { events, cwd: written } = fromV1(input as LogV1Event[], attachments);
		const folder = cwd || written;
		if (!folder) throw new RpcError(-32602, "The log doesn't say which folder it worked in: pass cwd.");
		const session = this.createSession(folder, model ?? events.findLast((e) => e.t === "model")?.model);
		for (const event of events) session.append(event);
		const title = events.findLast((e) => e.t === "title");
		session.meta = { ...session.meta, title: title?.t === "title" ? title.title : "Imported session", turns: events.filter((e) => e.t === "user").length, updated: new Date().toISOString() };
		session.log.writeMeta(session.meta);
		return session.summary();
	}

	/**
	 * Turn Discovery mode on or off for a session (docs/research.md). On only at a lab that grants this person
	 * `discovery`; it applies while the session works there.
	 */
	discover(runtime: SessionRuntime, on: boolean): string {
		const current = runtime.discovery;
		if (!on) {
			if (!current) return "Discovery mode is off.";
			runtime.setDiscovery(false, current);
			return "Discovery mode is off. Commands that change things ask you first again.";
		}
		const site = runtime.place;
		if (site === "local") throw new RpcError(-32602, "Discovery mode works in a session at a lab. Move this session to the lab first.");
		const lab = this.sites.lab(site);
		const title = lab?.title ?? this.sites.title(site);
		if (!lab) throw new RpcError(-32602, `${title} isn't connected. Sign in again (el login ${site}), then turn Discovery mode on.`);
		if (!lab.capabilities.includes("discovery")) throw new RpcError(-32602, `${title} hasn't given you Discovery mode.`);
		if (current === site) return "Discovery mode is already on.";
		runtime.setDiscovery(true, site);
		return `Discovery mode is on. At ${title}, the agent works without asking: its commands, file changes and ${title}'s tools. Anything on this computer still asks. Type /discover off to stop.`;
	}

	/** Move a session between this computer and a site's sandbox; a git repository comes along unless `carry` is false. */
	async movePlace(runtime: SessionRuntime, place: string, carry = true): Promise<string> {
		if (runtime.isRunning) throw new RpcError(-32010, "Wait for the current turn to finish, or cancel it.");
		if (runtime.moving) throw new RpcError(-32010, "The session is already moving.");
		runtime.moving = true;
		try {
			return await this.move(runtime, place, carry);
		} finally {
			runtime.moving = false;
		}
	}

	private async move(runtime: SessionRuntime, place: string, carry: boolean): Promise<string> {
		const from = runtime.place;
		if (place === from) return "It already works there.";
		const site = runtime.site;
		if (site && this.sites.isolated(site) && place !== site) throw new RpcError(-32602, `${this.sites.title(site)} keeps this session's work in its sandbox.`);
		if (place === "local") {
			const local = new LocalWorkspace(runtime.cwd, this.config.permissions.sandbox);
			const carried = runtime.placement?.carried;
			let detail = "Files and commands act on this computer again.";
			if (carried && from !== "local") {
				const branch = `enrichedlab/${from}-${carried.id}`;
				const commits = await fetchRepo(this.sandboxFor(from), runtime.workspace.root, carried, branch);
				detail = commits.length ? `The sandbox's work is on branch ${branch} (${commits.length} commit${commits.length === 1 ? "" : "s"}); merge it to keep going with it.` : "The sandbox had no new commits.";
			}
			runtime.moveTo(local, { place, label: local.label, root: local.root });
			// Where the work came home stays in the record, not only in a passing notice.
			if (carried && from !== "local") runtime.notice("info", detail);
			return detail;
		}
		if (!this.sites.exists(place)) throw new RpcError(-32602, `No site named ${place}.`);
		if (from !== "local") throw new RpcError(-32602, "Move back to this computer first; the work comes home as a branch, then it can go to another lab.");
		const api = this.sandboxFor(place);
		const workspace = new SandboxWorkspace(api, this.sandboxRoot(runtime.cwd, `${runtime.id.slice(-6)}-${newId("m").slice(-4)}`));
		const repo = carry && from === "local" ? repoRoot(runtime.cwd) : undefined;
		let carried: { repo: string; base: string; home?: string; id: string } | undefined;
		let detail = `Files and commands now act in ${workspace.label}.`;
		if (repo) {
			const sent = await sendRepo(api, repo, workspace.root);
			carried = { repo, base: sent.base, home: sent.home, id: sent.id };
			const left = sent.skipped.length ? `; left here as likely secrets: ${sent.skipped.join(", ")}` : "";
			const alone = sent.history ? "" : " Its history stayed here, since files that look like secrets are in it; the work comes home on your history all the same.";
			detail = `The repository moved to ${api.title} (${sent.head})${left}.${alone}`;
		}
		runtime.moveTo(workspace, { place, label: workspace.label, root: workspace.root, carried });
		if (carried && detail.includes("secret")) runtime.notice("info", detail);
		return detail;
	}

	private searchCache?: { config: SearchConfig; tool: Tool };
	private searchTool(config: SearchConfig): Tool {
		if (this.searchCache?.config !== config) this.searchCache = { config, tool: searchTool(config) };
		return this.searchCache.tool;
	}

	private deps(): RuntimeDeps {
		return {
			config: () => this.config,
			registry: this.registry,
			tools: (site) => this.tools(site),
			allows: (model, site) => this.sites.allows(model, site),
			spawn: (parent, task, options) => this.spawn(parent, task, options),
			waitAgents: (parent, agents, timeoutMs, signal) => this.waitAgents(parent, agents, timeoutMs, signal),
			sealed: (site) => Boolean(site && this.sites.isolated(site)),
			lab: (site) => this.sites.lab(site),
			apps: (sessionId) => ({ open: (path) => this.apps.openForSession(sessionId, path), publishView: (view) => this.apps.publishView(sessionId, view) }),
			surface: (sessionId) => (this.surfaces ? { call: (capability, op, args, signal) => this.surfaces!(sessionId, capability, op, args, signal) } : undefined),
			browser: (sessionId) => this.browserLanes(sessionId),
			cancelChildren: (parent) => {
				for (const session of this.sessions.values()) if (session.parent === parent) session.cancel();
			},
			canvas: this.canvas,
			notify: (name, params) => {
				const sessionId = (params as { sessionId?: string }).sessionId;
				this.emit(name, params, sessionId);
				// A session nobody watches leaves memory once its turn ends; its log stays on disk.
				if (name === "session.status" && (params as { activity?: string }).activity === "idle" && sessionId && this.unwatched.has(sessionId)) {
					this.release(sessionId);
				}
			},
			ask: (request, signal) => this.ask(request, signal),
			grantFolder: (folder) => this.setFolderAccess(folder, "change"),
		};
	}

	/** Save what EnrichedLab may do in a folder (asked once, when the person adds it); "none" forgets the folder. */
	private setFolderAccess(path: string, access: "change" | "read" | "none"): void {
		const folder = resolve(path);
		const folders = { ...this.config.folders };
		if (access === "none") delete folders[folder];
		else folders[folder] = { access, at: new Date().toISOString() };
		saveConfig(this.paths, { folders });
		this.reloadConfig();
	}

	/** Ask whichever surface answers first. A headless run answers by its own rule. */
	private ask(request: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision | "cancelled"> {
		if (this.options.headlessAnswer) return Promise.resolve(this.options.headlessAnswer(request));
		// A subagent's question goes to the windows showing its lead session, where the person is, and to any showing
		// the subagent itself; a window holding both gets it twice and keeps one (by requestId).
		const lead = this.leadOf(request.sessionId);
		if (lead !== request.sessionId) request = { ...request, lead };
		const scopes = lead === request.sessionId ? [lead] : [lead, request.sessionId];
		return new Promise((done) => {
			const finish = (decision: PermissionDecision | "cancelled") => {
				if (!this.waiting.delete(request.requestId)) return;
				for (const scope of scopes) this.emit("permission.settled", { requestId: request.requestId, decision }, scope);
				done(decision);
			};
			this.waiting.set(request.requestId, { request, resolve: finish });
			signal.addEventListener("abort", () => finish("cancelled"), { once: true });
			for (const scope of scopes) this.emit("permission.request", request, scope);
		});
	}

	/** Each lab desktop's live view while any window watches it: one stream from the lab, passed to those windows. */
	private desktopStreams = new Map<string, { watchers: number; width?: number; height?: number; close?: () => void; starting?: Promise<unknown> }>();

	private async desktopWatch(site: string, on: boolean): Promise<DesktopStream> {
		const current = this.desktopStreams.get(site);
		if (!on) {
			if (current && --current.watchers <= 0) {
				current.close?.();
				this.desktopStreams.delete(site);
			}
			return { site, live: false };
		}
		if (current) {
			current.watchers++;
			await current.starting?.catch(() => undefined);
			return { site, live: Boolean(current.close), width: current.width, height: current.height };
		}
		const api = this.sites.desktop(site);
		if (!api?.desktopStream || !api.desktop()?.stream) return { site, live: false };
		const stream: { watchers: number; width?: number; height?: number; close?: () => void; starting?: Promise<unknown> } = { watchers: 1 };
		this.desktopStreams.set(site, stream);
		stream.starting = api.desktopStream({
			band: (b) => this.emit("desktop.band", { site, x: b.x, y: b.y, w: b.w, h: b.h, jpeg: Buffer.from(b.jpeg).toString("base64") }),
			end: (reason) => {
				if (this.desktopStreams.get(site) === stream) this.desktopStreams.delete(site);
				this.emit("desktop.stream", { site, live: false, reason });
			},
		});
		try {
			const opened = (await stream.starting) as { width: number; height: number; close(): void };
			// Every window stopped watching while it started.
			if (stream.watchers <= 0) {
				opened.close();
				return { site, live: false };
			}
			Object.assign(stream, { width: opened.width, height: opened.height, close: opened.close });
			this.emit("desktop.stream", { site, live: true, width: opened.width, height: opened.height });
			return { site, live: true, width: opened.width, height: opened.height };
		} catch {
			if (this.desktopStreams.get(site) === stream) this.desktopStreams.delete(site);
			return { site, live: false };
		}
	}

	/** The session a subagent works for (itself when it isn't one), following parents to the top. */
	private leadOf(sessionId: string): string {
		let id = sessionId;
		for (let depth = 0; depth < 8; depth++) {
			const parent = this.sessions.get(id)?.parent;
			if (!parent) return id;
			id = parent;
		}
		return id;
	}

	/** Sessions no surface has open. */
	private unwatched = new Set<string>();

	/** Drop a session's in-memory state when no surface has it open and it isn't working; later opens reload it. */
	release(id: string): void {
		const session = this.sessions.get(id);
		if (!session) return;
		if (session.isRunning || session.pending.size) {
			this.unwatched.add(id);
			return;
		}
		this.unwatched.delete(id);
		this.sessions.delete(id);
		void this.browsers.close(id);
	}

	/** A surface has the session open again. */
	watched(id: string): void {
		this.unwatched.delete(id);
	}

	session(id: string): SessionRuntime {
		let session = this.sessions.get(id);
		if (session) return session;
		const log = new SessionLog(this.paths.sessions, id);
		if (!/^s[0-9a-z]+$/.test(id) || !log.exists()) throw new RpcError(-32004, `No session ${id}.`);
		const meta = log.meta();
		session = new SessionRuntime(log, new LocalWorkspace(meta?.cwd ?? process.cwd(), this.config.permissions.sandbox), this.deps());
		// A session that last worked in a site's sandbox picks up there.
		const placed = session.placement;
		if (placed && placed.place !== "local") session.useWorkspace(new SandboxWorkspace(this.sandboxFor(placed.place), placed.root));
		this.sessions.set(id, session);
		return session;
	}

	/** Start a subagent: a child session in the parent's folder, with its site binding and model, on one task. */
	private spawn(parent: SessionRuntime, task: string, options: { mode: "read" | "full"; model?: string }): string {
		const running = [...this.sessions.values()].filter((s) => s.parent === parent.id && s.isRunning).length;
		if (running >= MAX_RUNNING_AGENTS) throw new Error(`${running} subagents are already running; wait for one first.`);
		// A subagent that may change files gets its own worktree and branch when the folder is a git repository, so
		// parallel agents never write over each other or the person's checkout.
		const child = this.createSession(parent.cwd, options.model ?? parent.modelRef, parent.site, { parent: parent.id, mode: options.mode }, options.mode === "full");
		child.prompt(task);
		return child.id;
	}

	/** Wait until every named subagent is idle, the timeout passes, or the caller stops; report each one. */
	private async waitAgents(parent: string, agents: string[], timeoutMs: number, signal: AbortSignal): Promise<AgentResult[]> {
		const runtimes = agents.map((id) => {
			const runtime = this.session(id);
			if (runtime.parent !== parent) throw new Error(`${id} isn't a subagent of this session.`);
			return runtime;
		});
		const deadline = Date.now() + timeoutMs;
		while (runtimes.some((r) => r.isRunning) && Date.now() < deadline && !signal.aborted) await sleep(250, signal).catch(() => undefined);
		const results = runtimes.map((r) => r.result());
		// A finished subagent nobody has open leaves memory; its log stays.
		for (const r of runtimes) if (!r.isRunning) this.release(r.id);
		return results;
	}

	createSession(cwd: string, model?: string, site?: string, agent?: { parent: string; mode: "read" | "full" }, worktree = false): SessionRuntime {
		let folder = resolve(cwd);
		if (!existsSync(folder)) throw new RpcError(-32602, `${folder} doesn't exist.`);
		const repo = worktree ? repoRoot(folder) : undefined;
		let tree: { repo: string; path: string; branch: string } | undefined;
		if (repo) {
			const made = createWorktree(repo, newId("w"), agent ? "subagent" : "session");
			tree = { repo, ...made };
			// The same place inside the repository, in the new worktree.
			folder = join(made.path, relative(repo, folder));
		}
		if (site && !this.sites.exists(site)) throw new RpcError(-32602, `No site named ${site}.`);
		// A session bound to an isolated site works in that site's sandbox from the start.
		const pinned = site && this.sites.isolated(site) ? site : undefined;
		if (pinned && !this.sites.sandbox(pinned)) throw new RpcError(-32602, `Sign in to ${this.sites.title(pinned)} first; its work happens in its sandbox.`);
		const tail = newId("p").slice(-6);
		const workspace: Workspace = pinned ? new SandboxWorkspace(this.sandboxFor(pinned), this.sandboxRoot(folder, tail)) : new LocalWorkspace(folder, this.config.permissions.sandbox);
		const allowed = (m: ModelProfile | undefined) => (m && this.sites.allows(m, site) ? m : undefined);
		const profile = allowed(this.registry.resolve(model)) ?? allowed(this.registry.preferred()) ?? this.registry.all().find((m) => this.sites.allows(m, site));
		// An isolated site's bundles reach only the sessions bound to that site.
		const scoped = site ? this.loadAll(site) : this.config;
		const system = systemPrompt({
			cwd: folder,
			shell: workspace.shellName,
			workspaceLabel: workspace.label,
			globalInstructions: scoped.instructions.global,
			sites: this.sites.descriptions(site),
			subagent: agent?.mode,
			skills: findSkills(skillDirs(scoped.skills.dirs, projectRoot(folder))),
			worktree: tree && { branch: tree.branch, repo: tree.repo },
			notes: readNotes(projectRoot(folder)),
		});
		const { log } = SessionLog.create(this.paths.sessions, folder, profile?.ref ?? "", system, { site, agent, worktree: tree });
		const session = new SessionRuntime(log, workspace, this.deps());
		if (pinned) session.moveTo(workspace, { place: pinned, label: workspace.label, root: workspace.root, initial: true });
		this.sessions.set(session.id, session);
		if (profile) session.setModel(profile.ref, this.config.model === profile.ref ? (this.config.effort ?? profile.defaultEffort) : profile.defaultEffort);
		this.emit("session.updated", session.summary());
		return session;
	}

	listSessions(cwd?: string, limit = 50, query?: string): SessionSummary[] {
		const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
		// Subagent sessions open from the step that started them, not from the session list.
		return listSessions(this.paths.sessions)
			.filter((m) => !m.parent && (!cwd || resolve(m.cwd) === resolve(cwd)))
			.filter((m) => !words.length || words.every((w) => `${m.title ?? ""} ${m.cwd}`.toLowerCase().includes(w)))
			.slice(0, limit)
			.map((m) => toSummary(m, this.sessions.get(m.id)?.isRunning ?? false));
	}

	uiPrefs(): UiPrefs {
		const { theme = "auto", showReasoning = true } = readJson<Partial<UiPrefs>>(this.paths.ui, {});
		return { theme, showReasoning, permissions: modeOf(this.config.permissions.mode) };
	}

	/** ChatGPT plan models are offered while an account is signed in; config.json records only that. */
	private setChatgptProvider(on: boolean): void {
		const raw = readJson<Record<string, unknown>>(this.paths.config, {});
		const providers = { ...(raw.providers as Record<string, unknown>) };
		if (on) providers.chatgpt = { api: "openai-responses", baseUrl: CHATGPT_API, auth: "chatgpt", label: "ChatGPT" } satisfies ProviderConfig;
		else delete providers.chatgpt;
		raw.providers = providers;
		writeJson(this.paths.config, raw);
		this.reloadConfig();
	}

	reloadConfig(): void {
		this.config = this.loadAll();
	}

	/** config.json plus installed bundles. `site`: a session bound to it also gets an isolated site's bundles. */
	private loadAll(site?: string): LabConfig {
		const isolated = (readJson<{ sites?: { name: string; isolated?: boolean }[] }>(this.paths.sites, {}).sites ?? []).filter((s) => s.isolated).map((s) => s.name);
		return applyBundles(loadConfig(this.paths), listBundles(this.paths), isolated, site);
	}

	/** Answer one protocol request. */
	async handle<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
		const p = (params ?? {}) as Record<string, unknown>;
		const need = (key: string): string => {
			const value = p[key];
			if (typeof value !== "string" || !value) throw new RpcError(-32602, `"${key}" is required.`);
			return value;
		};
		// Only what needs models or site tools waits for discovery and sign-in; opening and reading sessions never does,
		// so a surface shows its history at once even when a site is slow.
		if (NEEDS_READY.has(method)) await this.ready();
		const out = async (): Promise<unknown> => {
			switch (method) {
				case "hello":
					return { engine: VERSION, protocol: PROTOCOL_VERSION, home: this.paths.home, pid: process.pid };
				case "session.list":
					return this.listSessions(p.cwd as string | undefined, (p.limit as number | undefined) ?? 50, typeof p.query === "string" ? p.query : undefined);
				case "session.create": {
					// A model the person asked for by name is used or refused, never quietly swapped for another.
					const model = typeof p.model === "string" && p.model ? p.model : undefined;
					const site = p.site as string | undefined;
					if (model) {
						const asked = this.registry.resolve(model);
						if (!asked) throw new RpcError(-32602, `${model} isn't offered now. Choose another model.`);
						if (!this.sites.allows(asked, site)) throw new RpcError(-32602, `${model} can't be used in ${site ? `a ${this.sites.title(site)} session` : "a session on this computer"}.`);
					}
					return this.createSession(need("cwd"), model, site, undefined, p.worktree === true).summary();
				}
				case "session.open": {
					const id = need("sessionId");
					const snap = this.session(id).snapshot();
					// A subagent's questions go to whoever watches its parent; a reopened surface needs them too.
					const children = [...this.sessions.values()].filter((s) => s.parent === id).flatMap((s) => [...s.pending.values()]);
					return { ...snap, pending: [...snap.pending, ...children] };
				}
				case "session.close":
					return { ok: true };
				case "session.prompt": {
					const runtime = this.session(need("sessionId"));
					const text = String(p.text ?? "");
					// Discovery mode is turned on by typing it, not from a menu.
					const typed = /^\/discover(?:\s+(on|off))?$/i.exec(text.trim());
					if (typed && !p.images) {
						this.discover(runtime, typed[1]?.toLowerCase() !== "off");
						return { queued: false };
					}
					return runtime.prompt(text, p.images as never);
				}
				case "desktop.update": {
					const site = need("site");
					const api = this.sites.desktop(site);
					if (!api?.desktopUpdate) throw new RpcError(-32602, `${this.sites.title(site)} can't update its desktop.`);
					await api.desktopUpdate();
					return { ok: true } as never;
				}
				case "desktop.watch":
					return (await this.desktopWatch(need("site"), p.on === true || p.on === "again")) as never;
				case "desktop.act":
				case "desktop.open": {
					const site = need("site");
					const api = this.sites.desktop(site);
					const info = api?.desktop();
					if (!api || !info) throw new RpcError(-32602, `${this.sites.title(site)} has no desktop for you.`);
					if (method === "desktop.open") {
						const target = need("target").trim();
						if (!/^https:\/\//.test(target) && !target.startsWith("/sandbox/")) throw new RpcError(-32602, "Open an https address or a file under /sandbox.");
						return api.desktopOpen(target, "person");
					}
					// The person's input goes through the same checks as the agent's, marked as the person's.
					return api.desktopAct(checkAction((p.action ?? {}) as Record<string, unknown>, info), "person");
				}
				case "session.discovery": {
					const runtime = this.session(need("sessionId"));
					const detail = this.discover(runtime, p.on === true);
					return { summary: runtime.summary(), detail };
				}
				case "session.permissions": {
					const runtime = this.session(need("sessionId"));
					const mode = p.mode as string | undefined;
					if (mode !== undefined && !["ask", "auto", "full"].includes(mode)) throw new RpcError(-32602, "mode must be ask, auto or full.");
					runtime.setPermissionMode(mode as PermissionMode | undefined);
					return runtime.summary();
				}
				case "folder.access": {
					const path = need("path");
					if (!isAbsolute(path)) throw new RpcError(-32602, "path must be absolute.");
					const access = p.access as string | undefined;
					if (access !== undefined) {
						if (!["change", "read", "none"].includes(access)) throw new RpcError(-32602, "access must be change, read or none.");
						this.setFolderAccess(path, access as "change" | "read" | "none");
					}
					const now = folderAccess(this.config, resolve(path));
					return { path: resolve(path), ...(now ? { access: now } : {}) };
				}
				case "folder.list":
					return Object.entries(this.config.folders ?? {})
						.map(([path, grant]) => ({ path, access: grant.access, at: grant.at }))
						.sort((a, b) => a.path.localeCompare(b.path));
				case "session.cancel": {
					const returned = this.session(need("sessionId")).cancel();
					return returned.length ? { ok: true, returned } : { ok: true };
				}
				case "session.model": {
					const session = this.session(need("sessionId"));
					session.setModel(p.model as string | undefined, p.effort as string | undefined);
					return session.status();
				}
				case "session.undo":
					return this.session(need("sessionId")).undo();
				case "session.compact":
					return this.session(need("sessionId")).compactNow();
				case "session.rename": {
					const session = this.session(need("sessionId"));
					const title = need("title").slice(0, 120);
					session.append({ t: "title", id: `e${Date.now().toString(36)}`, at: new Date().toISOString(), title });
					session.meta = { ...session.meta, title };
					session.log.writeMeta(session.meta);
					this.emit("session.updated", session.summary());
					return { ok: true };
				}
				case "permission.answer": {
					const waiting = this.waiting.get(need("requestId"));
					if (!waiting) return { ok: false };
					const decision = p.decision as PermissionDecision;
					if (!["allow", "allow_session", "allow_folder", "deny"].includes(decision)) throw new RpcError(-32602, "decision must be allow, allow_session, allow_folder or deny.");
					waiting.resolve(decision);
					return { ok: true };
				}
				case "model.list":
					if (p.refresh) {
						this.reloadConfig();
						await Promise.all([this.registry.refresh(), this.sites.connectAll()]);
					}
					return { models: this.registry.list(), default: this.registry.preferred()?.ref };
				case "config.reload":
					this.reloadConfig();
					await this.mcp.sync(this.config.mcpServers);
					return { bundles: listBundles(this.paths).map(({ name, version, description, source, sha256 }) => ({ name, version, description, source, sha256 })) };
				case "fs.list": {
					const runtime = this.session(need("sessionId"));
					const path = typeof p.path === "string" && p.path ? p.path : ".";
					if (!runtime.workspace.inside(path)) throw new RpcError(-32602, "Files lists folders inside the session's folder.");
					const entries = (await runtime.workspace.list(path)).filter((e) => e.name !== ".git").sort((a, b) => (a.type === "dir" ? 0 : 1) - (b.type === "dir" ? 0 : 1) || a.name.localeCompare(b.name));
					return { root: runtime.workspace.root, place: runtime.place, entries };
				}
				case "fs.read": {
					const runtime = this.session(need("sessionId"));
					const path = need("path");
					if (!runtime.workspace.inside(path)) throw new RpcError(-32602, "Files reads inside the session's folder.");
					const info = await runtime.workspace.stat(path);
					if (info?.type !== "file") throw new RpcError(-32602, `${path} isn't a file.`);
					if (info.size > 2 * 1024 * 1024) return { path, size: info.size, binary: true };
					const data = await runtime.workspace.read(path);
					const binary = data.subarray(0, 8000).includes(0);
					return { path, size: info.size, binary, text: binary ? undefined : data.toString("utf8") };
				}
				case "view.open": {
					const runtime = this.session(need("sessionId"));
					const path = need("path");
					if (!runtime.workspace.inside(path)) throw new RpcError(-32602, "Views open files inside the session's folder.");
					const result = await showTool.run(
						{ title: basename(path), path, ...(p.plot ? { plot: p.plot } : {}) },
						{ sessionId: runtime.id, callId: "person", workspace: runtime.workspace, place: runtime.place, project: runtime.cwd, log: runtime.log, signal: AbortSignal.timeout(120_000), vision: false, output: () => undefined, canvas: this.canvas },
					);
					const view = result.view?.canvas ? this.canvas.get(result.view.canvas) : undefined;
					if (!view) throw new RpcError(-32602, result.content);
					return view;
				}
				case "view.data": {
					const view = this.canvas.get(need("canvasId"));
					if (!view?.source) throw new RpcError(-32602, "That view has no data file.");
					return this.viewData(view.source);
				}
				case "session.export": {
					const session = this.session(need("sessionId"));
					return toV1(session.log.read());
				}
				case "session.import": {
					if (!Array.isArray(p.events)) throw new RpcError(-32602, "events must be a list of v1 session events.");
					return this.importLog(p.events, (p.attachments ?? {}) as Attachments, typeof p.cwd === "string" ? p.cwd : undefined, typeof p.model === "string" ? p.model : undefined);
				}
				case "session.push": {
					// A session to the lab's Rein, as the shared log's lines; Rein answers with the session it made.
					const session = this.session(need("sessionId"));
					const { events } = toV1(session.log.read());
					const rein = await this.sites.rein(need("site"));
					const result = await rein.reinImport(`${events.map((e) => JSON.stringify(e)).join("\n")}\n`, typeof p.title === "string" && p.title ? p.title : session.meta.title);
					return { records: events.length, result };
				}
				case "session.pull": {
					// A Rein session back into a new local session, through the same checks as an import.
					const rein = await this.sites.rein(need("site"));
					const text = await rein.reinExport(need("id"));
					const lines = text.split("\n").filter((l) => l.trim());
					const events = lines.map((l) => JSON.parse(l) as LogV1Event);
					return { records: lines.length, summary: this.importLog(events, {}, typeof p.cwd === "string" ? p.cwd : undefined, undefined) };
				}
				case "session.delete": {
					const id = need("sessionId");
					const runtime = this.session(id);
					if (runtime.isRunning) throw new RpcError(-32010, "Stop the session first.");
					this.sessions.delete(id);
					void this.browsers.close(id);
					rmSync(join(this.paths.sessions, id), { recursive: true, force: true });
					return { ok: true };
				}
				case "provider.list":
					return {
						presets: PROVIDER_PRESETS,
						added: Object.entries(this.config.providers)
							.filter(([, c]) => !c.auth)
							.map(([name, c]) => ({ name, label: c.label ?? name, baseUrl: c.baseUrl })),
						accounts: chatgptAccounts(this.paths.credentials).map((a) => ({ service: "chatgpt" as const, ...a })),
					};
				case "provider.signin": {
					if (p.service !== "chatgpt") throw new RpcError(-32602, "Unknown service.");
					const { account, welcome } = await chatgptSignIn({
						home: this.paths.home,
						credentials: this.paths.credentials,
						account: typeof p.account === "string" ? p.account : undefined,
						open: (url) => this.emit("provider.auth", { service: "chatgpt", url }),
					});
					this.setChatgptProvider(true);
					await this.registry.refresh();
					const problem = this.registry.problems.get("chatgpt");
					if (problem) throw new RpcError(-32000, `Signed in, but ChatGPT's models didn't load: ${problem}`);
					const summary = chatgptAccounts(this.paths.credentials).find((a) => a.id === account.id)!;
					return { account: { service: "chatgpt", ...summary }, models: this.registry.all().filter((m) => m.provider === "chatgpt").length, welcome };
				}
				case "provider.signout": {
					if (p.service !== "chatgpt") throw new RpcError(-32602, "Unknown service.");
					const result = await chatgptSignOut(this.paths.credentials, need("account"));
					this.setChatgptProvider(chatgptAccounts(this.paths.credentials).some((a) => a.active && a.signedIn));
					await this.registry.refresh();
					return result;
				}
				case "provider.use": {
					if (p.service !== "chatgpt") throw new RpcError(-32602, "Unknown service.");
					useChatgpt(this.paths.credentials, need("account"));
					this.setChatgptProvider(chatgptAccounts(this.paths.credentials).some((a) => a.active && a.signedIn));
					await this.registry.refresh();
					return { ok: true };
				}
				case "provider.add": {
					const preset = PROVIDER_PRESETS.find((x) => x.id === need("preset"));
					if (!preset) throw new RpcError(-32602, "Unknown service.");
					const baseUrl = preset.id === "custom" ? String(p.baseUrl ?? "").trim() : preset.baseUrl;
					if (!/^https?:\/\//.test(baseUrl)) throw new RpcError(-32602, "Give the service's address, starting with https://.");
					const name = (typeof p.name === "string" && p.name.trim()) || preset.id;
					if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new RpcError(-32602, "Use lowercase letters, digits and dashes for the name.");
					const key = need("key").trim();
					const provider: ProviderConfig = { api: preset.api, baseUrl, keychain: true, label: preset.id === "custom" ? new URL(baseUrl).host : preset.label };
					const models = await testProvider(provider, key);
					await storeKey(this.paths.credentials, name, key);
					const raw = readJson<Record<string, unknown>>(this.paths.config, {});
					raw.providers = { ...(raw.providers as object), [name]: provider };
					writeJson(this.paths.config, raw);
					this.reloadConfig();
					await this.registry.refresh();
					return { name, models };
				}
				case "provider.remove": {
					const name = need("name");
					await forgetKey(this.paths.credentials, name);
					const raw = readJson<Record<string, unknown>>(this.paths.config, {});
					const providers = { ...(raw.providers as Record<string, unknown>) };
					delete providers[name];
					raw.providers = providers;
					writeJson(this.paths.config, raw);
					this.reloadConfig();
					await this.registry.refresh();
					return { ok: true };
				}
				case "local.models":
					return this.localModels.status();
				case "local.pull":
					await this.localModels.pull(need("model")).catch((error) => {
						throw new RpcError(-32602, errorText(error));
					});
					return { ok: true };
				case "local.pull.cancel":
					this.localModels.cancel(need("model"));
					return { ok: true };
				case "local.remove":
					await this.localModels.remove(need("model"));
					return { ok: true };
				case "update.check":
					return checkForUpdate(this.paths.update, p.force === true);
				case "update.apply":
					return applyUpdate();
				case "app.list":
					return this.apps.list();
				case "app.open":
					return await this.apps.open({ sessionId: p.sessionId as string | undefined, id: p.id as string | undefined, path: p.path as string | undefined });
				case "app.grant":
					return this.apps.grant(need("id"), p.allow === true);
				case "app.call": {
					const args = p.arguments && typeof p.arguments === "object" ? (p.arguments as Record<string, unknown>) : {};
					return await this.apps.call(need("token"), need("name"), args, AbortSignal.timeout(300_000));
				}
				case "app.message":
					this.apps.message(need("token"), need("text"));
					return { ok: true };
				case "app.context":
					this.apps.context(need("token"), need("text"));
					return { ok: true };
				case "app.close":
					this.apps.close(need("token"));
					return { ok: true };
				case "term.open": {
					const sessionId = typeof p.sessionId === "string" ? p.sessionId : undefined;
					const runtime = sessionId ? this.session(sessionId) : undefined;
					const workspace = runtime?.workspace ?? new LocalWorkspace(resolve(typeof p.cwd === "string" ? p.cwd : homedir()));
					const title = runtime && runtime.place !== "local" ? this.sites.title(runtime.place) : "This computer";
					return this.terminals.start(workspace, title, Number(p.cols) || 100, Number(p.rows) || 30);
				}
				case "term.input":
					this.terminals.input(need("termId"), String(p.data ?? ""));
					return { ok: true };
				case "term.resize":
					this.terminals.resize(need("termId"), Number(p.cols), Number(p.rows));
					return { ok: true };
				case "term.close":
					this.terminals.close(need("termId"));
					return { ok: true };
				case "session.moveplan": {
					const runtime = this.session(need("sessionId"));
					return { repo: runtime.place === "local" ? repoRoot(runtime.cwd) : undefined };
				}
				case "session.place": {
					const runtime = this.session(need("sessionId"));
					const detail = await this.movePlace(runtime, need("place"), p.carry !== false);
					this.emit("session.updated", runtime.summary());
					return { summary: runtime.summary(), detail };
				}
				case "model.default": {
					const model = this.registry.resolve(need("model"));
					if (!model) throw new RpcError(-32602, `No model named ${p.model}.`);
					saveConfig(this.paths, { model: model.ref, effort: p.effort as string | undefined });
					this.reloadConfig();
					return { ok: true };
				}
				case "site.list":
					return this.sites.list();
				case "site.add": {
					const url = new URL(need("url"));
					if (url.protocol !== "https:") throw new RpcError(-32602, "A site's address must start with https://.");
					const wanted = need("name");
					if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(wanted)) throw new RpcError(-32602, "A lab's short name uses lowercase letters, digits and dashes.");
					// The same address again is the same lab: its sign-in resumes. A different lab never takes an existing
					// lab's name (that would drop its sign-in): it gets the next free one.
					const known = this.sites.configs();
					const same = known.find((c) => c.url === url.origin);
					if (same) return this.sites.connect(same.name);
					let name = wanted;
					for (let n = 2; known.some((c) => c.name === name); n++) name = `${wanted}-${n}`;
					this.sites.add({ name, url: url.origin, kind: "gate", title: typeof p.title === "string" ? p.title.slice(0, 40) : undefined, isolated: p.isolated === true || undefined });
					return this.sites.connect(name);
				}
				case "site.login": {
					const name = need("name");
					return this.sites.login(name, (url, instructions) => this.emit("site.auth", { name, url, instructions }));
				}
				case "lab.apps": {
					const installed = this.apps.list().filter((a) => a.source.startsWith("lab:"));
					return this.sites.labApps().map((a) => {
						const here = installed.find((i) => i.source === `lab:${a.site}` && i.name === a.name);
						return here ? { ...a, installed: here.version } : a;
					});
				}
				case "lab.app.install": {
					const done = await this.sites.installLabApp(need("site"), need("name"), typeof p.version === "string" ? p.version : undefined);
					this.emit("lab.apps.changed", { site: need("site") });
					const summary = this.apps.list().find((a) => a.name === done.name && a.source === `lab:${need("site")}`);
					if (!summary) throw new RpcError(-32000, `Installed ${done.name}, but it didn't load.`);
					return summary;
				}
				case "lab.devices":
					return (await this.sites.devices(need("name"))) as never;
				case "lab.device.approve":
					await this.sites.approveDevice(need("name"), need("id"));
					return { ok: true };
				case "lab.device.revoke":
					await this.sites.revokeDevice(need("name"), need("id"));
					return { ok: true };
				case "lab.sandboxes":
					return (await this.sites.sandboxes(need("name"))) as never;
				case "lab.sandbox.delete":
					return { status: await this.sites.deleteSandbox(need("name"), need("id")) } as never;
				case "lab.sandbox.create":
					return (await this.sites.createSandbox(need("name"), typeof p.image === "string" ? p.image : undefined, typeof p.network === "string" ? p.network : undefined)) as never;
				case "lab.sandbox.stop":
					return { status: await this.sites.stopSandbox(need("name"), need("id")) } as never;
				case "browser.watch": {
					// "again": a window that already watches asks for a fresh picture (it reloaded its pane).
					const page = await this.browsers.watch(need("sessionId"), p.on === "again" ? "again" : p.on === true);
					if (!page) return {};
					const info = await page.info().catch(() => undefined);
					const lane = this.sites.sandbox(page.site)?.browser?.();
					return info ? { page: { sessionId: need("sessionId"), site: page.site, lab: this.sites.title(page.site), network: lane?.network, hosts: lane?.hosts, ...info } } : {};
				}
				case "browser.resize": {
					await this.browsers.current(need("sessionId"))?.resize(Number(p.width), Number(p.height));
					return { ok: true };
				}
				case "browser.input": {
					const page = this.browsers.current(need("sessionId"));
					if (!page) throw new RpcError(-32602, "No sandbox browser page is open in this session.");
					await page.input(p.event as never);
					return { ok: true };
				}
				case "browser.navigate": {
					// The person can start the session's sandbox browser from the window; the agent then keeps using it.
					const id = need("sessionId");
					const site = typeof p.site === "string" ? p.site : undefined;
					// A session drives one sandbox page. Asked for another lab's, it opens there (closing the old one) rather
					// than steering the page the session has elsewhere.
					const current = this.browsers.current(id);
					let page = current && (!site || current.site === site) ? current : undefined;
					if (!page && site && this.sites.sandbox(site)?.browser?.()) page = await this.browsers.page(id, site);
					if (!page) throw new RpcError(-32602, "No sandbox browser page is open in this session.");
					if (site) this.browsers.remember(id, "sandbox", page.site);
					const step = p.step === "back" || p.step === "forward" || p.step === "reload" ? p.step : undefined;
					await page.navigate({ url: typeof p.url === "string" ? p.url : undefined, step });
					return { ok: true };
				}
				case "lab.check":
					return { rows: await this.sites.check(need("name")) };
				case "lab.usage":
					return this.sites.usage(need("name"), p.window === "7d" ? "7d" : "30d");
				case "site.save": {
					const runtime = this.session(need("sessionId"));
					if (runtime.workspace.kind !== "local") throw new RpcError(-32602, "Files from a lab are saved into sessions on this computer.");
					const uri = need("uri");
					const owner = this.sites.ownerOf(uri);
					if (!owner?.fetchFile) throw new RpcError(-32602, "That file isn't at a lab you're signed in to.");
					const bytes = await owner.fetchFile(uri, AbortSignal.timeout(300_000));
					const expected = typeof p.sha256 === "string" ? p.sha256.toLowerCase() : undefined;
					if (expected && createHash("sha256").update(bytes).digest("hex") !== expected) throw new RpcError(-32000, "The file that arrived doesn't match its checksum, so it wasn't saved.");
					// A plain file name in the project; an existing file is never replaced.
					const base = basename(need("name")).replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "") || "lab_file";
					const extension = extname(base);
					let target = join(runtime.cwd, base);
					for (let n = 2; existsSync(target); n++) target = join(runtime.cwd, `${base.slice(0, base.length - extension.length)} (${n})${extension}`);
					writeFileSync(target, bytes, { flag: "wx" });
					return { path: relative(runtime.cwd, target), bytes: bytes.length };
				}
				case "site.remove": {
					const name = need("name");
					await this.sites.remove(name);
					this.registry.removeSource(name);
					return { ok: true };
				}
				case "site.logout":
					await this.sites.logout(need("name"));
					return { ok: true };
				case "site.refresh":
					if (p.name) await this.sites.connect(String(p.name));
					else await this.sites.connectAll();
					return this.sites.list();
				case "canvas.list":
					return this.canvas.list(p.sessionId as string | undefined);
				case "ui.get":
					return this.uiPrefs();
				case "ui.set": {
					const next: UiPrefs = { ...this.uiPrefs() };
					if (p.theme === "auto" || p.theme === "light" || p.theme === "dark") next.theme = p.theme;
					if (typeof p.showReasoning === "boolean") next.showReasoning = p.showReasoning;
					writeJson(this.paths.ui, { theme: next.theme, showReasoning: next.showReasoning });
					if (p.permissions === "ask" || p.permissions === "auto" || p.permissions === "full") {
						const saved = readJson<Partial<LabConfig>>(this.paths.config, {});
						saveConfig(this.paths, { permissions: { ...DEFAULT_CONFIG.permissions, ...saved.permissions, mode: p.permissions } });
						this.reloadConfig();
						next.permissions = p.permissions;
					}
					this.emit("ui.updated", next);
					return next;
				}
				default:
					throw new RpcError(-32601, `Unknown method ${method}.`);
			}
		};
		return (await out()) as Result<M>;
	}
}
