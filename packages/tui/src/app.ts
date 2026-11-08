// The terminal surface. It attaches to the person's engine like every other surface, so the same session can be
// watched and steered from the desktop window at the same time.

import {
	CombinedAutocompleteProvider,
	wrapTextWithAnsi,
	type Component,
	Container,
	Editor,
	matchesKey,
	ProcessTerminal,
	SelectList,
	type SelectItem,
	type TUI,
	TuiMainScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ModelInfo, PermissionRequest, SessionEvent, SessionStatus, SessionSummary, SiteSummary } from "@enrichedlab/protocol";
import { EngineClient, ensureEngine, NEWS, VERSION } from "@enrichedlab/engine";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { type Appearance, type Theme, theme as makeTheme } from "./theme.ts";
import { answerView, Lines, LiveView, modelView, noticeView, permissionView, promptView, ruleView, statusLine, toolView, welcomeView } from "./views.ts";

export interface TuiOptions {
	cwd: string;
	sessionId?: string;
	resume?: boolean;
	/** New sessions work with this site only. */
	site?: string;
	/** New sessions work in their own git worktree and branch. */
	worktree?: boolean;
	/** Open the EnrichedLab window on a session (the desktop app, else a browser app window); says which opened. */
	openWindow?: (pairUrl: string, sessionId: string) => string;
}

const COMMANDS = [
	{ name: "model", description: "Choose the model for this session" },
	{ name: "effort", description: "Set the reasoning level", argumentHint: "<level>" },
	{ name: "undo", description: "Put back the files changed since your last message" },
	{ name: "new", description: "Start a new session in this folder (/new <lab> to work in that lab's sandbox)" },
	{ name: "resume", description: "Open an earlier session" },
	{ name: "compact", description: "Summarize older turns now" },
	{ name: "window", description: "Open this session in the EnrichedLab window; /window off keeps it in the terminal" },
	{ name: "sites", description: "Your labs and what each grants you" },
	{ name: "login", description: "Sign in to a lab", argumentHint: "<lab>" },
	{ name: "canvas", description: "Open the latest view the agent showed" },
	{ name: "theme", description: "Use light or dark colors", argumentHint: "light|dark" },
	{ name: "help", description: "Keys and commands" },
	{ name: "quit", description: "Leave (the session keeps running if busy)" },
];

function openUrl(url: string): void {
	const [file, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
	try {
		spawn(file as string, args as string[], { detached: true, stdio: "ignore", windowsHide: true }).unref();
	} catch {
		// The address is printed too.
	}
}

const shortPath = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);

export async function runTui(options: TuiOptions): Promise<void> {
	const file = await ensureEngine();
	const client = new EngineClient(file, "lab-terminal");
	await client.ready();

	const terminal = new ProcessTerminal();
	const tui: TUI = new TuiMainScreen(terminal);
	tui.start();
	let appearance: Appearance = process.env.LAB_THEME === "light" ? "light" : process.env.LAB_THEME === "dark" ? "dark" : "dark";
	if (!process.env.LAB_THEME) {
		try {
			const colors = await tui.queryTerminalColors({ timeoutMs: 250 });
			const bg = colors.background;
			if (bg) appearance = 0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b > 140 ? "light" : "dark";
			else if (/;(7|15)$/.test(process.env.COLORFGBG ?? "")) appearance = "light";
		} catch {
			// Keep the default.
		}
	}
	let t: Theme = makeTheme(appearance);

	let sessionId = "";
	let summary: SessionSummary | undefined;
	let status: SessionStatus | undefined;
	let started: number | undefined;
	let expanded = false;
	let sites: SiteSummary[] = [];
	/** Approvals waiting for an answer, oldest first; the first one is on screen. Parallel calls can ask at once. */
	let approvals: PermissionRequest[] = [];
	/** While a session opens, its events and approvals wait here and join after the snapshot (without repeats). */
	let opening: { id: string; events: SessionEvent[]; requests: PermissionRequest[] } | undefined;
	let lastCtrlC = 0;
	const isExpanded = () => expanded;

	const header = new Lines(
		(width) => {
			const left = `${t.prompt("EnrichedLab")} ${t.faint(VERSION)}  ${t.muted(summary?.title && summary.title !== "New session" ? summary.title : "new session")}`;
			const path = shortPath(options.cwd);
			const room = Math.max(12, width - visibleWidth(left) - 6);
			const right = t.faint(path.length > room ? `…${path.slice(path.length - room + 1)}` : path);
			// Two columns in, like everything below it, and the version beside the name.
			const gap = Math.max(2, width - visibleWidth(left) - visibleWidth(right) - 3);
			return ["", `  ${left}${" ".repeat(gap)}${right}`];
		},
		() => `${summary?.title}|${appearance}`,
	);
	const transcript = new Container();
	const live = new LiveView(t);
	const permission = new Container();
	const spacer = new Lines(() => [""]);
	const editor = new Editor(tui, t.editor, { paddingX: 1, autocompleteMaxVisible: 8 });
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider(COMMANDS, options.cwd));
	const statusBar: Component = {
		render: (width) => [statusLine(t, status, { started, cwd: options.cwd, site: sites.filter((s) => s.signedIn).map((s) => `${s.name} ✓`).join(" ") }, width)],
		invalidate: () => undefined,
	};
	// Choices from a command (a model, a level, a session) open here, right under the prompt, as the slash list does.
	const pickerHost = new Container();
	for (const c of [header, transcript, live, permission, spacer, editor, pickerHost, statusBar]) tui.addChild(c);
	tui.setFocus(editor);

	const render = () => tui.requestRender();
	const add = (component: Component) => {
		transcript.addChild(component);
		render();
	};
	const say = (text: string, level: "info" | "warn" | "error" = "info") => add(noticeView(t, { t: "notice", id: "", at: "", level, text }));
	/** Stop the turn; messages that were waiting to join it come back into the editor, ahead of anything typed since. */
	const stop = () =>
		void client
			.call("session.cancel", { sessionId })
			.then((result) => {
				if (!result.returned?.length) return;
				const typed = editor.getText();
				editor.setText([...result.returned, typed].filter(Boolean).join("\n\n"));
				say(`${result.returned.length === 1 ? "The waiting message is" : `${result.returned.length} waiting messages are`} back in the editor.`);
			})
			.catch((error: Error) => say(`Couldn't stop it: ${error.message}`, "error"));

	function viewFor(event: SessionEvent): Component | undefined {
		switch (event.t) {
			case "user":
				return promptView(t, event.text);
			case "assistant":
				return event.text || event.reasoning || event.stop === "error" || event.stop === "cancelled" ? answerView(t, event, isExpanded) : undefined;
			case "tool":
				return toolView(t, event, isExpanded);
			case "notice":
				return noticeView(t, event);
			case "compaction":
				return ruleView(t, `earlier turns summarized (${Math.round(event.tokensBefore / 1000)}k tokens)`);
			case "undo":
				return ruleView(t, `undone: ${event.files.join(", ")}`);
			case "model":
				return modelView(t, event.model, event.effort, origins.get(event.model));
			case "reasoning_summary":
				return ruleView(t, `thought: ${event.text}`);
			case "discovery":
				return ruleView(t, event.on ? "discovery mode on: the agent works without asking at the lab" : "discovery mode off");
			default:
				return undefined;
		}
	}

	async function openSession(id: string): Promise<void> {
		if (sessionId) await client.call("session.close", { sessionId }).catch(() => undefined);
		opening = { id, events: [], requests: [] };
		const snap = await client.call("session.open", { sessionId: id });
		const held = opening;
		opening = undefined;
		sessionId = id;
		summary = snap.summary;
		status = snap.status;
		started = snap.status.activity !== "idle" ? Date.now() : undefined;
		transcript.clear();
		live.reset();
		live.running.clear();
		permission.clear();
		approvals = [];
		// Model names in the transcript read as the window's do.
		const [listed, siteList] = await Promise.all([client.call("model.list", {}).catch(() => ({ models: [] as ModelInfo[] })), client.call("site.list", {}).catch(() => [])]);
		learnOrigins(listed.models, siteList);
		if (!snap.events.some((e) => e.t === "user")) {
			const sites = siteList;
			const placed = [...snap.events].reverse().find((e) => e.t === "place") as Extract<SessionEvent, { t: "place" }> | undefined;
			const place = !placed || placed.place === "local" ? `${process.platform === "darwin" ? "this Mac" : "this computer"}, contained` : `the ${sites.find((s) => s.name === placed.place)?.title ?? placed.place} sandbox`;
			const labs = sites.map((s) => `${s.title}${s.signedIn ? ` ${t.muted(`(${s.who ?? "signed in"})`)}` : ` ${t.muted("(sign in: el login " + s.name + ")")}`}`);
			transcript.addChild(welcomeView(t, { version: VERSION, place, labs, news: NEWS }));
		}
		for (const event of snap.events) {
			const view = viewFor(event);
			if (view) transcript.addChild(view);
		}
		if (snap.partial) {
			live.text = snap.partial.text;
			live.reasoning = snap.partial.reasoning;
			live.calls = snap.partial.tools;
		}
		const lastAssistant = [...snap.events].reverse().find((e) => e.t === "assistant") as Extract<SessionEvent, { t: "assistant" }> | undefined;
		if (snap.summary.running && lastAssistant?.toolCalls) {
			const done = new Set(snap.events.filter((e) => e.t === "tool").map((e) => (e as Extract<SessionEvent, { t: "tool" }>).callId));
			for (const call of lastAssistant.toolCalls) if (!done.has(call.id)) live.running.set(call.id, { view: { verb: call.name, target: "" }, started: Date.now(), output: "", waiting: false });
		}
		for (const request of snap.pending) showPermission(request);
		const known = new Set(snap.events.map((e) => e.id));
		for (const event of held?.events ?? []) if (!known.has(event.id)) onEvent(event);
		for (const request of held?.requests ?? []) showPermission(request);
		header.invalidate();
		render();
	}

	async function newSession(siteArg?: string): Promise<void> {
		const created = await client.call("session.create", { cwd: options.cwd, site: siteArg ?? options.site, worktree: options.worktree });
		await openSession(created.id);
	}

	function showPermission(request: PermissionRequest): void {
		if (!approvals.some((r) => r.requestId === request.requestId)) approvals.push(request);
		const run = live.running.get(request.callId);
		if (run) run.waiting = true;
		else live.running.set(request.callId, { view: request.view, started: Date.now(), output: "", waiting: true });
		showFirstApproval();
	}

	function showFirstApproval(): void {
		permission.clear();
		const first = approvals[0];
		if (first) permission.addChild(permissionView(t, first, approvals.length - 1));
		render();
	}

	async function answer(decision: "allow" | "allow_session" | "allow_folder" | "deny"): Promise<void> {
		const request = approvals.shift();
		if (!request) return;
		showFirstApproval();
		const run = live.running.get(request.callId);
		if (run) {
			run.waiting = false;
			run.started = Date.now();
		}
		render();
		await client.call("permission.answer", { requestId: request.requestId, decision }).catch((error) => say(String(error.message ?? error), "error"));
	}

	// ── Engine notifications ───────────────────────────────────────────────────────────────────────────────────────

	client.on("session.event", ({ sessionId: id, event }) => {
		if (id === opening?.id) {
			opening.events.push(event);
			return;
		}
		if (id !== sessionId) return;
		onEvent(event);
	});

	function onEvent(event: SessionEvent): void {
		if (event.t === "assistant") {
			live.reset();
			for (const call of event.toolCalls ?? []) {
				const preview = /"(path|command|pattern|url|title)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(call.args)?.[2] ?? "";
				live.running.set(call.id, { view: { verb: call.name, target: preview.replace(/\\n/g, " ") }, started: Date.now(), output: "", waiting: false });
			}
		}
		if (event.t === "tool") live.running.delete(event.callId);
		if (event.t === "user") live.queued = live.queued.filter((q) => q !== event.text);
		if (event.t === "title" && summary) {
			summary = { ...summary, title: event.title };
			header.invalidate();
		}
		const view = viewFor(event);
		if (view) add(view);
		else render();
	}

	client.on("session.delta", (delta) => {
		if (delta.sessionId !== sessionId) return;
		if (delta.kind === "text") live.text += delta.text;
		else if (delta.kind === "reasoning") live.reasoning += delta.text;
		else if (delta.kind === "tool") {
			if (delta.name !== undefined) live.calls.push({ index: delta.index ?? 0, name: delta.name, args: "" });
			else {
				const call = live.calls.find((c) => c.index === delta.index);
				if (call) call.args += delta.text;
			}
		} else if (delta.kind === "output" && delta.callId) {
			const run = live.running.get(delta.callId);
			if (run) run.output = (run.output + delta.text).slice(-8_000);
		}
		render();
	});
	client.on("session.status", (next) => {
		if (next.sessionId !== sessionId) return;
		if (next.activity !== "idle" && !started) started = Date.now();
		if (next.activity === "idle") {
			started = undefined;
			live.reset();
			live.running.clear();
		}
		status = next;
		render();
	});
	client.on("permission.request", (request) => {
		if (request.sessionId === opening?.id) opening.requests.push(request);
		else if (request.sessionId === sessionId) showPermission(request);
	});
	client.on("permission.settled", ({ requestId }) => {
		if (!approvals.some((r) => r.requestId === requestId)) return;
		approvals = approvals.filter((r) => r.requestId !== requestId);
		showFirstApproval();
	});
	client.on("site.updated", (site) => {
		sites = [...sites.filter((s) => s.name !== site.name), site];
		render();
	});
	client.on("lab.notice", (notice) => say(notice.url ? `${notice.text} ${notice.url}` : notice.text));
	client.on("site.auth", (auth) => {
		say(`Opening your browser to sign in to ${auth.name}. If it doesn't open: ${auth.url}`);
		openUrl(auth.url);
	});
	client.on("canvas.updated", (canvas) => {
		if (canvas.sessionId === sessionId && canvas.version === 1) say(`Showing "${canvas.title}"`);
	});
	// The agent showed something (a plot, a table, an app) or needs the browser: open the window beside the terminal.
	// "/window off" keeps everything in the terminal.
	let windowAuto = process.env.EL_WINDOW !== "off";
	client.on("surface.wanted", async (want) => {
		if (want.sessionId !== sessionId || !windowAuto || !options.openWindow) return;
		const { url } = await client.call("engine.pair", { next: `/#/s/${sessionId}` });
		const how = options.openWindow(url, sessionId);
		if (how !== "none") say(`Opened the EnrichedLab window for ${want.reason}. /window off keeps this session in the terminal.`);
	});
	client.onClose = () => {
		tui.stop();
		process.stderr.write("The engine connection closed. Run el again to reconnect.\n");
		process.exit(1);
	};

	const ticker = setInterval(() => {
		if (status && status.activity !== "idle") render();
	}, 1_000);

	// ── Commands ───────────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Where each model runs, as the window says it: private (a lab's own servers, this computer, the person's network)
	 * or cloud (a service, where what's sent may be kept by its terms).
	 */
	const origins = new Map<string, string>();
	function learnOrigins(models: ModelInfo[], _sites: { name: string; title: string }[]): void {
		for (const m of models) origins.set(m.ref, `${m.where.kind === "cloud" ? "cloud" : "private"} · ${m.where.kind === "device" ? "this computer" : m.where.name}`);
	}

	/** A line under the prompt while a command looks something up; the returned function clears it. */
	function working(text: string): () => void {
		pickerHost.clear();
		pickerHost.addChild(new Lines(() => [`  ${t.faint(text)}`]));
		render();
		return () => {
			pickerHost.clear();
			render();
		};
	}

	function pick(title: string, items: SelectItem[], onPick: (item: SelectItem) => void, current?: string): void {
		const list = new SelectList(items, Math.min(10, items.length), t.select);
		const at = current ? items.findIndex((i) => i.value === current) : -1;
		if (at > 0) list.setSelectedIndex(at);
		const done = () => {
			pickerHost.clear();
			tui.setFocus(editor);
			render();
		};
		list.onSelect = (item) => {
			done();
			onPick(item);
		};
		list.onCancel = done;
		pickerHost.clear();
		pickerHost.addChild(new Lines(() => ["", `  ${t.text(title)}  ${t.faint("↑↓ to move · Enter to choose · Esc to leave")}`]));
		pickerHost.addChild(list);
		pickerHost.addChild(new Lines(() => [""]));
		tui.setFocus(list);
		render();
	}

	async function command(line: string): Promise<void> {
		const [name, ...args] = line.slice(1).trim().split(/\s+/);
		const arg = args.join(" ");
		switch (name) {
			case "model": {
				const stop = working("Looking for models on this computer, your keys and your labs…");
				const [{ models }, sites] = await Promise.all([client.call("model.list", { refresh: true }), client.call("site.list", {}).catch(() => [])]).finally(stop);
				if (!models.length) return say("No models found. Start a local model server, add a provider, or /login to a lab.", "warn");
				learnOrigins(models, sites);
				const origin = (m: ModelInfo) => origins.get(m.ref) ?? m.provider;
				const choose = (m: ModelInfo) => client.call("session.model", { sessionId, model: m.ref }).then((s) => {
					status = s;
					render();
				});
				if (arg) {
					const m = models.find((x) => x.ref === arg || x.id === arg);
					return m ? void (await choose(m)) : say(`No model ${arg}.`, "warn");
				}
				return pick(
					"Model for this session",
					models.map((m) => ({ value: m.ref, label: m.id, description: `${origin(m)} · ${Math.round(m.context / 1024)}k context${m.vision ? " · sees images" : ""}${m.ref === status?.model ? " · current" : ""}` })),
					(item) => void choose(models.find((m) => m.ref === item.value)!).catch((e) => say(e.message, "error")),
					status?.model,
				);
			}
			case "effort": {
				const { models } = await client.call("model.list", {});
				const model = models.find((m) => m.ref === status?.model);
				if (!model?.efforts.length) return say("This model has no reasoning levels.", "warn");
				const set = (level: string) => client.call("session.model", { sessionId, effort: level }).then((s) => {
					status = s;
					render();
				});
				if (arg) return void (await set(arg).catch((e) => say(e.message, "error")));
				return pick("Reasoning level", model.efforts.map((e) => ({ value: e, label: e, description: e === status?.effort ? "current" : "" })), (item) => void set(item.value), status?.effort);
			}
			case "new":
				return newSession(arg || undefined);
			case "undo": {
				if (!sessionId) return;
				const result = await client.call("session.undo", { sessionId });
				return say(result.detail, result.ok ? "info" : "warn");
			}
			case "resume": {
				const list = await client.call("session.list", { cwd: options.cwd, limit: 30 });
				if (!list.length) return say("No earlier sessions in this folder.");
				return pick(
					"Earlier sessions in this folder",
					list.map((s) => ({ value: s.id, label: s.title, description: `${s.updated.slice(0, 16).replace("T", " ")}${s.running ? " · running" : ""}` })),
					(item) => void openSession(item.value),
				);
			}
			case "compact": {
				const result = await client.call("session.compact", { sessionId });
				return say(result.detail);
			}
			case "app":
			case "window": {
				if (arg === "off" || arg === "on") {
					windowAuto = arg === "on";
					return say(windowAuto ? "The window opens when the agent shows something." : "Everything stays in the terminal; /window opens it.");
				}
				const { url } = await client.call("engine.pair", { next: `/#/s/${sessionId}` });
				const how = options.openWindow?.(url, sessionId) ?? (openUrl(url), "browser");
				return say(`Opened this session in the ${how === "desktop" ? "EnrichedLab window" : how}. Both stay in step.`);
			}
			case "sites": {
				sites = await client.call("site.refresh", {});
				if (!sites.length) return say("No labs yet. Add one with its invite link, or: el site add <name> <https://address>");
				for (const s of sites) say(`${s.name}: ${s.signedIn ? `signed in as ${s.who} (${s.via}); ${s.models} models, ${s.tools} tools${s.sandbox ? ", sandbox" : ""}${s.warning ? `. ${s.warning}` : ""}` : s.error ?? "not signed in"}`);
				return;
			}
			case "login": {
				if (!arg) return say("Which lab? /login <lab>", "warn");
				say(`Signing in to ${arg}…`);
				const site = await client.call("site.login", { name: arg });
				return say(site.signedIn ? `Signed in to ${arg} as ${site.who}.` : `Not signed in: ${site.error}`, site.signedIn ? "info" : "warn");
			}
			case "canvas": {
				const list = await client.call("canvas.list", { sessionId });
				if (!list.length) return say("Nothing shown yet in this session.");
				const { url } = await client.call("engine.pair", { next: new URL(list[0].url).pathname });
				openUrl(url);
				return say(`Opened "${list[0].title}".`);
			}
			case "theme": {
				appearance = arg === "light" ? "light" : arg === "dark" ? "dark" : appearance === "dark" ? "light" : "dark";
				t = makeTheme(appearance);
				return say(`Using ${appearance} colors. Restart el to redraw earlier lines.`);
			}
			case "help": {
				// Two aligned tables, keys then commands, wrapped to the terminal's width.
				const keys: [string, string][] = [
					["Enter", "send"],
					["Shift+Enter, Ctrl+J", "new line"],
					["Esc", "stop the agent"],
					["Ctrl+O", "open steps, output and reasoning"],
					["Tab", "complete a path or command"],
					["Ctrl+C", "clear the prompt; twice to leave"],
					["y  a  n", "answer a permission request: once, remembered (its line says for what), no"],
				];
				const rows = (title: string, list: [string, string][], width: number) => {
					const pad = Math.max(...list.map(([k]) => k.length)) + 3;
					return ["", `  ${t.text(title)}`, ...list.flatMap(([k, v]) => wrapTextWithAnsi(v, Math.max(20, width - pad - 2)).map((line, i) => `  ${t.muted((i ? "" : k).padEnd(pad))}${line}`))];
				};
				transcript.addChild(new Lines((width) => [...rows("Keys", keys, width), ...rows("Commands", COMMANDS.map((c) => [`/${c.name}${"argumentHint" in c && c.argumentHint ? ` ${c.argumentHint}` : ""}`, c.description]), width)]));
				return render();
			}
			case "quit":
			case "exit":
				return quit();
			// Not in /help or completion: a lab grants it to chosen people, who type it (docs/research.md).
			case "discover": {
				if (!sessionId) return;
				const { detail } = await client.call("session.discovery", { sessionId, on: arg.toLowerCase() !== "off" });
				return say(detail);
			}
			default:
				return say(`Unknown command /${name}. /help lists them.`, "warn");
		}
	}

	function quit(): void {
		clearInterval(ticker);
		tui.stop();
		client.close();
		process.exit(0);
	}

	editor.onSubmit = (text) => {
		const value = text.trim();
		if (!value) return;
		editor.addToHistory(value);
		editor.setText("");
		if (value.startsWith("/") && !value.startsWith("//")) {
			void command(value).catch((error) => say(error instanceof Error ? error.message : String(error), "error"));
			return;
		}
		void client
			.call("session.prompt", { sessionId, text: value })
			.then(({ queued }) => {
				if (queued) {
					live.queued.push(value);
					render();
				}
			})
			.catch((error) => say(error.message, "error"));
	};

	tui.addInputListener((data) => {
		if (approvals.length && editor.getText() === "") {
			if (data === "y" || data === "Y") return void answer("allow"), { consume: true };
			if ((data === "a" || data === "A") && approvals[0]?.folder) return void answer("allow_folder"), { consume: true };
			if ((data === "a" || data === "A") && !approvals[0]?.once) return void answer("allow_session"), { consume: true };
			if (data === "n" || data === "N") return void answer("deny"), { consume: true };
		}
		if (matchesKey(data, "ctrl+o")) {
			expanded = !expanded;
			transcript.invalidate();
			tui.requestRender(true);
			return { consume: true };
		}
		if (matchesKey(data, "escape") && status && status.activity !== "idle" && !editor.isShowingAutocomplete()) {
			stop();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+c")) {
			if (editor.getText()) {
				editor.setText("");
				render();
			} else if (status && status.activity !== "idle") {
				stop();
			} else if (Date.now() - lastCtrlC < 1_500) {
				quit();
			} else {
				lastCtrlC = Date.now();
				say("Press Ctrl+C again to leave.");
			}
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+d") && !editor.getText()) {
			quit();
			return { consume: true };
		}
		return undefined;
	});

	sites = await client.call("site.list", {});
	if (options.sessionId) await openSession(options.sessionId);
	else if (options.resume) {
		const [latest] = await client.call("session.list", { cwd: options.cwd, limit: 1 });
		if (latest) await openSession(latest.id);
		else await newSession();
	} else await newSession();
	if (!status?.model) say("No model is available yet. Start Ollama or LM Studio, add a provider to ~/.el/config.json, or /login to a lab.", "warn");
}
