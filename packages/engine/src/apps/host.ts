// The app host: the person's app library, consent, serving app pages, the lab_* tools apps call, backends, and live
// reload. One per engine. Surfaces draw the page in a pane and carry its MCP Apps messages to app.* requests.
//
// Where apps come from:
//   project   a folder with an app.json in a project, opened by the agent (app_open) or the person
//   library   ~/.el/apps/<name>, installed from a package (el app add)
//   bundle    <bundle>/apps/<name>, from an installed or site-granted bundle
//   mcp       a view an MCP server's tool returned (an MCP Apps ui:// resource)
//
// An app that asks for permissions, or runs a program of its own (command, container, serve), shows the person what
// it asks first. The grant is kept per app and covers exactly what was asked; asking for more asks again.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, type FSWatcher, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AppPermissions, AppSummary, AppToolResult, Notification, Notifications } from "@enrichedlab/protocol";
import type { Paths } from "../paths.ts";
import type { SandboxApi } from "../sites/sandbox_workspace.ts";
import type { Workspace } from "../tools/workspace.ts";
import { readJson, writeJson } from "../util.ts";
import { type AppOrigin, ORIGIN_FILE } from "./package.ts";
import { type Backend, type McpBackend, startBackend } from "./backends.ts";
import { describeEnvironment, environmentPlan } from "./environments.ts";
import { type AppManifest, describePermissions, permissionKey, readManifest } from "./manifest.ts";

/** What the host needs from the session an app opens in. */
export interface AppSession {
	/** The project folder on this computer. */
	project: string;
	workspace: Workspace;
	place: string;
	/** The lab the session is bound to, if any. */
	site?: string;
	/** True when that lab keeps its data inside: pages get no network, other labs are refused. */
	sealed: boolean;
	modelRef?: string;
	prompt(text: string): void;
	context(app: string, title: string, text: string): void;
	ask(prompt: string, system: string | undefined, signal: AbortSignal): Promise<string>;
}

export interface AppHostDeps {
	paths: Paths;
	emit: <N extends Notification>(name: N, params: Notifications[N], sessionId?: string) => void;
	session(id: string): AppSession | undefined;
	sandbox(site: string): SandboxApi | undefined;
	isolated(site: string): boolean;
	/** Installed bundles' folders. */
	bundles(): { name: string; dir: string }[];
	origin(): string;
	/** The local site for a lab name an app uses: its short name here, or the lab's own name from its descriptor. */
	resolveLab?(name: string): string | undefined;
	/** Why an app installed from a lab may not open (the lab withdrew it or revoked its signer), if so. */
	labAppBlocked?(origin: AppOrigin): string | undefined;
}

/** An MCP server's view: its HTML, its CSP request, and calls to its server's tools. */
export interface McpView {
	server: string;
	uri: string;
	title: string;
	html: string;
	csp?: { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[]; baseUriDomains?: string[] };
	toolInput?: Record<string, unknown>;
	toolResult?: AppToolResult;
	call(name: string, args: Record<string, unknown>): Promise<AppToolResult>;
}

interface Loaded {
	id: string;
	dir: string;
	manifest: AppManifest;
	source: string;
	signer?: string;
	/** Installed from a lab's app list. */
	origin?: AppOrigin;
}

interface Opened {
	token: string;
	id: string;
	sessionId?: string;
}

interface State {
	known: Record<string, { dir: string; source: string }>;
	grants: Record<string, { key: string; allow: boolean; at: string }>;
}

const MAX_READ = 32 * 1024 * 1024;
const MAX_STORE = 1024 * 1024;
const BACKEND_IDLE_MS = 5 * 60_000;

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".wasm": "application/wasm",
	".wgsl": "text/plain; charset=utf-8",
	".csv": "text/csv; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".woff2": "font/woff2",
	".glb": "model/gltf-binary",
};

/** The environment an app's commands get: enough to find programs, none of the engine's keys. */
function appEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM", "SYSTEMROOT", "R_LIBS_USER"]) if (process.env[key]) env[key] = process.env[key]!;
	return env;
}

const short = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 8);

/** CSP for an app page: an opaque origin (no access to the engine's pages or storage), its own files and the host's
 * SDK, and only the origins it was allowed. */
function appPolicy(network: string[]): string {
	return [
		// No popups, form posts or downloads: each would carry data past connect-src.
		"sandbox allow-scripts allow-modals",
		"default-src 'none'",
		"form-action 'none'",
		"script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"media-src 'self' data: blob:",
		"font-src 'self' data:",
		`connect-src ${["'self'", ...network].join(" ")}`,
		"worker-src 'self' blob:",
		"frame-src 'none'",
		"object-src 'none'",
		"base-uri 'self'",
	].join("; ");
}

/** CSP for an MCP server's view, from what its resource declared (MCP Apps: restrictive when it declared nothing). */
function viewPolicy(csp: McpView["csp"], sealed: boolean): string {
	const list = (domains: string[] | undefined) => (domains ?? []).filter((d) => /^(https?|wss?):\/\/[^\s;'"]+$/i.test(d)).join(" ");
	const resources = list(csp?.resourceDomains);
	return [
		"sandbox allow-scripts allow-modals",
		"default-src 'none'",
		"form-action 'none'",
		`script-src 'self' 'unsafe-inline' ${resources}`.trim(),
		`style-src 'self' 'unsafe-inline' ${resources}`.trim(),
		`img-src 'self' data: ${resources}`.trim(),
		`media-src 'self' data: ${resources}`.trim(),
		`font-src 'self' data: ${resources}`.trim(),
		`connect-src ${(!sealed && list(csp?.connectDomains)) || "'none'"}`,
		`frame-src ${(!sealed && list(csp?.frameDomains)) || "'none'"}`,
		`base-uri ${list(csp?.baseUriDomains) || "'self'"}`,
		"object-src 'none'",
	].join("; ");
}

export class AppHost {
	private state: State;
	private known = new Map<string, Loaded>();
	private views = new Map<string, McpView & { summary: AppSummary; sessionId: string }>();
	/** Apps whose backend is starting (see backend()). */
	private starting = new Set<string>();
	private opened = new Map<string, Opened>();
	private backends = new Map<string, Promise<Backend>>();
	/** Started backends, to notice one whose process ended. */
	private live = new Map<string, Backend>();
	private idle = new Map<string, ReturnType<typeof setTimeout>>();
	private watchers = new Map<string, FSWatcher>();
	private logs = new Map<string, string[]>();

	constructor(private deps: AppHostDeps) {
		this.state = readJson<State>(this.stateFile, { known: {}, grants: {} });
		this.state.known ??= {};
		this.state.grants ??= {};
	}

	private get stateFile(): string {
		return join(this.deps.paths.home, "apps.json");
	}

	get libraryDir(): string {
		return join(this.deps.paths.home, "apps");
	}

	private dataDir(id: string): string {
		return join(this.deps.paths.home, "app-data", id);
	}

	private save(): void {
		writeJson(this.stateFile, this.state);
	}

	// ── The library ──────────────────────────────────────────────────────────────────────────────────────────────

	/** Read an app folder and remember it. Project apps get an id from their name and folder. */
	register(dir: string, source: string): Loaded {
		const real = realpathSync(dir);
		const manifest = readManifest(real);
		const id = source === "library" ? manifest.name : source.startsWith("bundle:") ? `${source.slice(7)}.${manifest.name}` : `${manifest.name}-${short(real)}`;
		const signer = readJson<{ signer?: { fingerprint?: string } }>(join(real, ".lab", "lock.json"), {}).signer?.fingerprint;
		const origin = source === "library" ? readJson<AppOrigin | undefined>(join(real, ORIGIN_FILE), undefined) : undefined;
		const loaded: Loaded = { id, dir: real, manifest, source, signer, ...(origin?.lab ? { origin } : {}) };
		this.known.set(id, loaded);
		if (source === "project" && this.state.known[id]?.dir !== real) {
			this.state.known[id] = { dir: real, source };
			this.save();
		}
		return loaded;
	}

	/** Every app the person has: the library, bundles, and project apps opened before (still present). */
	list(): AppSummary[] {
		const out: AppSummary[] = [];
		const tryAdd = (dir: string, source: string) => {
			try {
				out.push(this.summary(this.register(dir, source)));
			} catch {
				// A broken or half-copied app folder is skipped; opening it directly says why.
			}
		};
		if (existsSync(this.libraryDir)) for (const name of readdirSync(this.libraryDir)) tryAdd(join(this.libraryDir, name), "library");
		for (const bundle of this.deps.bundles()) {
			const apps = join(bundle.dir, "apps");
			if (existsSync(apps)) for (const name of readdirSync(apps)) tryAdd(join(apps, name), `bundle:${bundle.name}`);
		}
		for (const [id, entry] of Object.entries(this.state.known)) {
			if (out.some((a) => a.id === id)) continue;
			if (existsSync(join(entry.dir, "app.json"))) tryAdd(entry.dir, entry.source);
		}
		return out.sort((a, b) => a.title.localeCompare(b.title));
	}

	private find(id: string): Loaded {
		const hit = this.known.get(id);
		if (hit && existsSync(join(hit.dir, "app.json"))) return this.register(hit.dir, hit.source);
		const listed = this.list().find((a) => a.id === id);
		if (!listed) throw new Error(`No app ${id}.`);
		return this.known.get(id)!;
	}

	/** What the consent card lists: permissions, and a program of its own when it runs one. */
	private asks(m: AppManifest, dir: string): { lines: string[]; key: string } {
		const lines = describePermissions(m.permissions);
		const b = m.backend;
		const plan = b?.runtime === "command" || b?.runtime === "serve" ? environmentPlan(dir) : undefined;
		if (plan) lines.push(...describeEnvironment(plan));
		if (b?.runtime === "command" || b?.runtime === "serve") lines.push(`Run ${b.command.join(" ")} on this computer${process.platform === "win32" ? " with your access" : ", contained"}`);
		// Elsewhere a Bun backend runs contained to its data folder, like the page; on Windows it runs as the person.
		if (b?.runtime === "bun" && process.platform === "win32") lines.push(`Run its backend (${b.main}) on this computer with your access`);
		// The page is held to the origins it names; the program behind it reaches the network as a whole.
		if (b && m.permissions.network?.length) lines.push("Let its program reach the network: any address, not only the ones named above");
		if (b?.runtime === "serve" && !m.permissions.network?.length) lines.push(process.platform === "linux"
			? "Let its served backend use this computer's whole network; bubblewrap cannot provide loopback alone"
			: "Let its served backend listen on this computer's loopback");
		if (b?.runtime === "container") {
			lines.push(`Run the container ${b.image}${b.build !== undefined ? " (built from its folder)" : ""}`);
			if (b.build !== undefined) lines.push("Let its container build reach the network: any address");
		}
		const program = b && (b.runtime !== "bun" || process.platform === "win32") ? JSON.stringify(b) : "";
		return { lines, key: `${permissionKey(m.permissions)}|${program}|${plan?.digest ?? ""}` };
	}

	/** An app from a lab that the lab withdrew, or whose signer it revoked, doesn't open or run. Its data stays. */
	private refuseBlocked(app: Loaded): void {
		const reason = app.origin ? this.deps.labAppBlocked?.(app.origin) : undefined;
		if (reason) throw new Error(`${reason} It won't open; your data for it is kept. Update or remove it (el apps).`);
	}

	private summary(app: Loaded): AppSummary {
		const asks = this.asks(app.manifest, app.dir);
		const grant = this.state.grants[app.id];
		return {
			id: app.id,
			name: app.manifest.name,
			title: app.manifest.title,
			version: app.manifest.version,
			description: app.manifest.description,
			dir: app.dir,
			source: app.origin ? `lab:${app.origin.lab}` : app.source,
			backend: app.manifest.backend?.runtime,
			permissions: app.manifest.permissions,
			granted: asks.lines.length === 0 || (grant?.allow === true && grant.key === asks.key),
			signer: app.signer,
		};
	}

	/** The plain lines the consent card shows for an app. */
	asksFor(id: string): string[] {
		const found = this.find(id);
		return this.asks(found.manifest, found.dir).lines;
	}

	grant(id: string, allow: boolean): AppSummary {
		const app = this.find(id);
		this.state.grants[id] = { key: this.asks(app.manifest, app.dir).key, allow, at: new Date().toISOString() };
		this.save();
		return this.summary(app);
	}

	// ── Opening ──────────────────────────────────────────────────────────────────────────────────────────────────

	/** Open an app for a session. A path is read relative to the session's project. */
	async open(params: { sessionId?: string; id?: string; path?: string }): Promise<{ app: AppSummary; token: string; url: string; kind: "view" | "page"; asks: string[]; toolInput?: Record<string, unknown>; toolResult?: AppToolResult }> {
		const view = params.id ? this.views.get(params.id) : undefined;
		if (view && view.sessionId !== params.sessionId) throw new Error("That view belongs to another session.");
		if (view) {
			const token = this.mint(view.summary.id, params.sessionId);
			return { app: view.summary, token, url: `${this.deps.origin()}/apps/${token}/index.html`, kind: "view", asks: [], toolInput: view.toolInput, toolResult: view.toolResult };
		}
		let app: Loaded;
		if (params.path) {
			const session = params.sessionId ? this.deps.session(params.sessionId) : undefined;
			const base = session?.project ?? process.cwd();
			const dir = isAbsolute(params.path) ? params.path : resolve(base, params.path);
			if (session && relative(session.project, dir).startsWith("..")) throw new Error("Open apps from inside the session's project, or install them with el app add.");
			app = this.register(dir, "project");
		} else if (params.id) app = this.find(params.id);
		else throw new Error("Which app? Give an id or a folder.");
		this.refuseBlocked(app);
		const summary = this.summary(app);
		const asks = this.asks(app.manifest, app.dir).lines;
		const token = this.mint(app.id, params.sessionId);
		this.watchApp(app);
		const kind = app.manifest.backend?.runtime === "serve" ? "page" : "view";
		if (!summary.granted) return { app: summary, token, url: "", kind, asks };
		if (kind === "page") {
			const backend = await this.backend(app, params.sessionId);
			return { app: summary, token, url: (backend as { url: string }).url, kind, asks };
		}
		return { app: summary, token, url: `${this.deps.origin()}/apps/${token}/${app.manifest.entry}`, kind, asks };
	}

	/** The agent opened an app: surfaces of that session show it. */
	async openForSession(sessionId: string, path: string): Promise<AppSummary> {
		const session = this.deps.session(sessionId);
		if (!session) throw new Error("No such session.");
		if (session.place !== "local") {
			// The project is in the lab's sandbox: apps installed here (or granted by the lab) open by id, and their
			// backends run in that sandbox.
			const listed = this.list().find((a) => a.id === path || a.name === path);
			if (!listed) throw new Error(`In a session that works in ${session.place}, open an installed app by its id (el apps lists them); ${path} isn't one.`);
			const summary = this.summary(this.find(listed.id));
			this.deps.emit("app.opened", { sessionId, app: summary }, sessionId);
			return summary;
		}
		const dir = isAbsolute(path) ? path : resolve(session.project, path);
		if (relative(session.project, dir).startsWith("..")) throw new Error("Open apps from inside the session's project.");
		const summary = this.summary(this.register(dir, "project"));
		this.deps.emit("app.opened", { sessionId, app: summary }, sessionId);
		return summary;
	}

	/** An MCP server's tool returned a view: keep it and show it in the session. */
	publishView(sessionId: string, view: McpView): AppSummary {
		const id = `mcp.${view.server}.${short(`${sessionId}|${view.uri}`)}`;
		const summary: AppSummary = { id, name: view.uri.replace(/^ui:\/\//, ""), title: view.title, version: "", description: `A view from ${view.server}`, dir: view.uri, source: `mcp:${view.server}`, permissions: {}, granted: true };
		this.views.set(id, { ...view, summary, sessionId });
		this.deps.emit("app.opened", { sessionId, app: summary }, sessionId);
		return summary;
	}

	/** One backend per app per session on this computer; sessions that work in the same lab share one per app. */
	private backendKey(id: string, sessionId: string | undefined): string {
		const place = sessionId ? this.deps.session(sessionId)?.place : undefined;
		return place && place !== "local" ? `${id}|lab:${place}` : `${id}|${sessionId ?? ""}`;
	}

	private mint(id: string, sessionId?: string): string {
		const token = randomBytes(18).toString("base64url");
		this.opened.set(token, { token, id, sessionId });
		const key = this.backendKey(id, sessionId);
		clearTimeout(this.idle.get(key));
		this.idle.delete(key);
		return token;
	}

	close(token: string): void {
		const open = this.opened.get(token);
		if (!open) return;
		this.opened.delete(token);
		const key = this.backendKey(open.id, open.sessionId);
		if ([...this.opened.values()].some((o) => this.backendKey(o.id, o.sessionId) === key)) return;
		// The last view using this backend closed: stop it after a while, in case it reopens.
		this.idle.set(key, setTimeout(() => void this.stopBackend(key), BACKEND_IDLE_MS));
		if (![...this.opened.values()].some((o) => o.id === open.id)) {
			this.watchers.get(open.id)?.close();
			this.watchers.delete(open.id);
		}
	}

	private watchApp(app: Loaded): void {
		if (this.watchers.has(app.id) || app.source.startsWith("mcp:")) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const watcher = watch(app.dir, { recursive: true }, (_event, file) => {
				// Tool output, not edits: git, packages, the package signature, and the environment pixi builds and locks.
				if (file && /(^|[\\/])(\.git|node_modules|\.lab|\.pixi)([\\/]|$)|(^|[\\/])pixi\.lock$/.test(String(file))) return;
				if (this.starting.has(app.id)) return;
				clearTimeout(timer);
				timer = setTimeout(() => {
					// New code: backends restart on their next call, pages reload now.
					for (const key of [...this.backends.keys()]) if (key.startsWith(`${app.id}|`)) void this.stopBackend(key);
					this.deps.emit("app.changed", { id: app.id });
				}, 150);
			});
			watcher.on("error", () => undefined);
			this.watchers.set(app.id, watcher);
		} catch {
			// Live reload is a convenience; the reload button still works.
		}
	}

	// ── Serving ──────────────────────────────────────────────────────────────────────────────────────────────────

	/** A file of an open app, for the server's /apps/<token>/<path> route. */
	file(token: string, path: string): { body: Buffer | string; headers: Record<string, string> } | undefined {
		const open = this.opened.get(token);
		if (!open) return undefined;
		const view = this.views.get(open.id);
		if (view) {
			if (path !== "index.html") return undefined;
			const sealed = open.sessionId ? Boolean(this.deps.session(open.sessionId)?.sealed) : false;
			return { body: view.html, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": viewPolicy(view.csp, sealed) } };
		}
		const app = this.known.get(open.id);
		if (!app || !this.summary(app).granted) return undefined;
		const full = resolve(app.dir, path);
		let real: string;
		try {
			real = realpathSync(full);
		} catch {
			return undefined;
		}
		if (real !== app.dir && !real.startsWith(app.dir + sep)) return undefined;
		if (!statSync(real).isFile()) return undefined;
		const session = open.sessionId ? this.deps.session(open.sessionId) : undefined;
		const network = session?.sealed ? [] : (app.manifest.permissions.network ?? []);
		return {
			body: readFileSync(real),
			headers: {
				"content-type": MIME[extname(real).toLowerCase()] ?? "application/octet-stream",
				"content-security-policy": appPolicy(network),
				// The page has an opaque origin, so its own modules load cross-origin.
				"access-control-allow-origin": "*",
				"cache-control": "no-store",
			},
		};
	}

	// ── Calls ────────────────────────────────────────────────────────────────────────────────────────────────────

	private backend(app: Loaded, sessionId: string | undefined): Promise<Backend> {
		// Sessions that work in the same lab share one backend per app: a lab sandbox has few long-running process slots.
		const key = this.backendKey(app.id, sessionId);
		const current = this.live.get(key);
		if (current?.kind === "mcp" && current.closed) {
			this.backends.delete(key);
			this.live.delete(key);
		}
		let running = this.backends.get(key);
		if (!running) {
			const session = sessionId ? this.deps.session(sessionId) : undefined;
			const log = (line: string) => {
				const lines = this.logs.get(app.id) ?? [];
				lines.push(line.slice(0, 400));
				this.logs.set(app.id, lines.slice(-40));
			};
			// A session that works in a lab runs the backend in that lab's sandbox, next to the project and its data.
			const lab = session && session.place !== "local" ? this.deps.sandbox(session.place) : undefined;
			const sealedAway = session && session.place !== "local" && !lab && this.deps.isolated(session.place);
			running = sealedAway
				? Promise.reject(new Error(`${session!.place} keeps its data inside, so this app's backend runs in its sandbox. Sign in to ${session!.place}, with its sandbox on, first.`))
				: startBackend(app.manifest, {
					dir: app.dir,
					dataDir: this.dataDir(app.id),
					// A shared lab backend sees the folder holding every session's project; each call names its own.
					projectDir: session?.place === "local" ? session.project : lab ? dirname(session!.workspace.root) : undefined,
					...(lab ? { sandbox: lab, sandboxOnly: this.deps.isolated(session!.place) } : {}),
					runDir: join(this.deps.paths.home, "runtime"),
					toolsDir: join(this.deps.paths.home, "tools"),
					network: !session?.sealed && (app.manifest.permissions.network?.length ?? 0) > 0,
					buildNetwork: app.manifest.backend?.runtime === "container" && app.manifest.backend.build !== undefined,
					serveNetwork: app.manifest.backend?.runtime === "serve",
					log,
				});
			const started = running;
			running.then(
				(backend) => this.backends.get(key) === started && this.live.set(key, backend),
				() => this.backends.get(key) === started && this.backends.delete(key),
			);
			// Starting can build the app's environment, whose install scripts write and remove files in the app's
			// folder: those aren't edits, so the watcher waits until two seconds after the backend is up.
			this.starting.add(app.id);
			void running.catch(() => undefined).finally(() => setTimeout(() => this.starting.delete(app.id), 2_000));
			this.backends.set(key, running);
		}
		return running;
	}

	private async stopBackend(key: string): Promise<void> {
		const running = this.backends.get(key);
		this.backends.delete(key);
		this.live.delete(key);
		this.idle.delete(key);
		await running?.then((b) => b.close()).catch(() => undefined);
	}

	/** Recent backend output, for errors. */
	backendLog(id: string): string {
		return (this.logs.get(id) ?? []).slice(-8).join("\n");
	}

	/** A tools/call from an open page. */
	async call(token: string, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<AppToolResult> {
		const open = this.opened.get(token);
		if (!open) throw new Error("This app view was closed; reload it.");
		const view = this.views.get(open.id);
		if (view) return view.call(name, args);
		const app = this.find(open.id);
		this.refuseBlocked(app);
		const summary = this.summary(app);
		if (!summary.granted) throw new Error("The person hasn't allowed this app yet.");
		if (name.startsWith("lab_")) return this.hostTool(app, open.sessionId, name, args, signal);
		if (!app.manifest.backend || app.manifest.backend.runtime === "serve") throw new Error(`This app has no tool ${name}.`);
		let backend: McpBackend;
		try {
			backend = (await this.backend(app, open.sessionId)) as McpBackend;
		} catch (error) {
			const log = this.backendLog(app.id);
			throw new Error(`The app's backend didn't start: ${(error as Error).message}${log ? `\n${log}` : ""}`);
		}
		const tool = backend.tools.find((t) => t.name === name);
		if (!tool) throw new Error(`The app's backend has no tool ${name}.`);
		if (!tool.visibility.includes("app")) throw new Error(`${name} is for the model only.`);
		const session = open.sessionId ? this.deps.session(open.sessionId) : undefined;
		return backend.call(name, args, signal, session && session.place !== "local" ? session.workspace.root : undefined);
	}

	message(token: string, text: string): void {
		const open = this.opened.get(token);
		const session = open?.sessionId ? this.deps.session(open.sessionId) : undefined;
		if (!session || !open) throw new Error("This app isn't open in a session.");
		const title = this.views.get(open.id)?.title ?? this.known.get(open.id)?.manifest.title ?? open.id;
		session.prompt(`(From the app "${title}") ${text}`);
	}

	context(token: string, text: string): void {
		const open = this.opened.get(token);
		const session = open?.sessionId ? this.deps.session(open.sessionId) : undefined;
		if (!session || !open) return;
		const title = this.views.get(open.id)?.title ?? this.known.get(open.id)?.manifest.title ?? open.id;
		session.context(open.id, title, text.slice(0, 8_000));
	}

	private async hostTool(app: Loaded, sessionId: string | undefined, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<AppToolResult> {
		const p: AppPermissions = app.manifest.permissions;
		const ok = (data: Record<string, unknown>, text?: string): AppToolResult => ({ content: [{ type: "text", text: text ?? JSON.stringify(data) }], structuredContent: data });
		const need = (allowed: unknown, what: string) => {
			if (!allowed) throw new Error(`This app didn't ask to ${what}. Add it to permissions in app.json.`);
		};
		const arg = (key: string) => {
			const v = args[key];
			if (typeof v !== "string" || !v) throw new Error(`${name} needs "${key}".`);
			return v;
		};
		if (name === "lab_store_get" || name === "lab_store_set") {
			const file = join(this.dataDir(app.id), "store.json");
			const store = readJson<Record<string, unknown>>(file, {});
			if (name === "lab_store_get") return ok({ value: store[arg("key")] ?? null });
			store[arg("key")] = args.value;
			const text = JSON.stringify(store);
			if (text.length > MAX_STORE) throw new Error("The app's store is over 1 MB; keep larger data in files.");
			mkdirSync(this.dataDir(app.id), { recursive: true, mode: 0o700 });
			writeFileSync(file, text, { mode: 0o600 });
			return ok({ ok: true });
		}
		const session = sessionId ? this.deps.session(sessionId) : undefined;
		if (!session) throw new Error(`${name} works in a session: open the app from one.`);
		const ws = session.workspace;
		const insideProject = (path: string) => {
			if (!ws.inside(path)) throw new Error(`${path} is outside the project.`);
			return path;
		};
		switch (name) {
			case "lab_session":
				return ok({ project: basename(session.project), place: session.place, model: session.modelRef ?? null });
			case "lab_read_file": {
				need(p.files, "read files");
				const path = insideProject(arg("path"));
				const stat = await ws.stat(path);
				if (!stat || stat.type !== "file") throw new Error(`No file ${path}.`);
				if (stat.size > MAX_READ) throw new Error(`${path} is over 32 MB; read it in a backend or with a command.`);
				const data = await ws.read(path);
				const binary = args.encoding === "base64" || data.subarray(0, 8192).includes(0);
				return { content: [{ type: "text", text: `${path} (${data.length} bytes)` }], structuredContent: binary ? { base64: data.toString("base64"), size: data.length } : { text: data.toString("utf8"), size: data.length } };
			}
			case "lab_list_files": {
				need(p.files, "read files");
				const path = insideProject(typeof args.path === "string" && args.path ? args.path : ".");
				return ok({ entries: await ws.list(path) });
			}
			case "lab_write_file": {
				need(p.files === "write", "change files");
				const path = insideProject(arg("path"));
				await ws.write(path, typeof args.text === "string" ? args.text : "");
				return ok({ ok: true, path });
			}
			case "lab_run": {
				need(p.commands, "run commands");
				const result = await ws.exec(arg("command"), { timeoutMs: 300_000, signal, env: appEnv() });
				return ok({ exitCode: result.exitCode, output: result.output.slice(-200_000), timedOut: result.timedOut });
			}
			case "lab_ask": {
				need(p.models, "ask the model");
				const text = await session.ask(arg("prompt"), typeof args.system === "string" ? args.system : undefined, signal);
				return ok({ text }, text);
			}
			case "lab_cluster_run": {
				// Apps a lab publishes name it by its own name; the person's apps may use the short name here.
				const named = arg("lab");
				const lab = this.deps.resolveLab?.(named) ?? named;
				need(p.labs?.some((l) => l === named || (this.deps.resolveLab?.(l) ?? l) === lab), `run commands in ${named}`);
				if (this.deps.isolated(lab) && session.site !== lab) throw new Error(`${lab} keeps its data inside; open this app in a ${lab} session.`);
				if (session.sealed && session.site !== lab) throw new Error("This session's lab keeps its data inside; other labs are out of reach.");
				const api = this.deps.sandbox(lab);
				if (!api) throw new Error(`Sign in to ${lab}, with its sandbox on, first.`);
				const r = await api.run(arg("command"), 300, signal);
				return ok({ exitCode: r.exitCode, output: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.slice(-200_000), timedOut: r.timedOut });
			}
			default:
				throw new Error(`No host tool ${name}.`);
		}
	}

	async stop(): Promise<void> {
		for (const w of this.watchers.values()) w.close();
		this.watchers.clear();
		for (const t of this.idle.values()) clearTimeout(t);
		await Promise.all([...this.backends.keys()].map((key) => this.stopBackend(key)));
	}
}
