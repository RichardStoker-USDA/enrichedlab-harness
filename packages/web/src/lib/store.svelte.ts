// The web surface's state. Everything comes from the engine; this file mirrors it and sends requests. The workbench
// layout is the one piece kept here: it belongs to this person's screen, per session, in local storage.

import { pageMenu } from "./menu.svelte.ts";
import type { AppSummary, BrowserFrame, BrowserInput, BrowserPageState, CanvasSummary, DesktopBand, DesktopFrame, DesktopStream, DeviceRequest, LabApp, ModelInfo, Part, Partial_, PermissionDecision, PermissionRequest, SessionEvent, SessionStatus, SessionSummary, SiteSummary, UiPrefs } from "@enrichedlab/protocol";
import { close as closeTab, emptyLayout, move, place, type Node, open as openTab, resize as resizeSplit, revive, sync, type Edge, type PaneKind, type Tab, uid, activate, groups } from "./layout.ts";
import { computerName, placeOf, places, type Place } from "./places.ts";
import { adoptCarried } from "./carried.ts";
import { rpc } from "./rpc.ts";

const emptyPartial = (): Partial_ => ({ text: "", reasoning: "", tools: [], output: {} });

const store = {
	get(key: string): string | null {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	},
	set(key: string, value: string): void {
		try {
			localStorage.setItem(key, value);
		} catch {
			// Private windows and blocked storage: the layout isn't remembered.
		}
	},
};

const TITLES: Record<PaneKind, string> = { view: "View", table: "Table", plot: "Plot", browser: "Browser", screen: "Sandbox browser", desktop: "Desktop", terminal: "Terminal", files: "Files", app: "App" };

class Lab {
	connected = $state(false);
	lost = $state(false);
	sessions = $state<SessionSummary[]>([]);
	sites = $state<SiteSummary[]>([]);
	/** The person's apps: the library, bundles, and project apps opened before. */
	apps = $state<AppSummary[]>([]);
	/** Apps the person's labs offer, every listed version (newest first per app). */
	labApps = $state<LabApp[]>([]);
	/** The open session's page in a lab's sandbox browser, as the engine last described it. */
	screen = $state<BrowserPageState | undefined>();
	private frames = new Set<(frame: BrowserFrame) => void>();
	/** The newest picture of each lab's desktop sandbox, and whether an action on it is on its way. */
	desktops = $state<Record<string, DesktopFrame>>({});
	desktopBusy = $state<Record<string, boolean>>({});
	/** Each watched lab desktop's live view, when the lab streams it. */
	desktopLive = $state<Record<string, DesktopStream>>({});
	/** Panes drawing a desktop's live bands; kept out of reactive state, as bands arrive many times a second. */
	private desktopBands = new Map<string, Set<(band: DesktopBand) => void>>();
	/** Other devices asking to use the person's sign-in at a lab, oldest first; the window asks about each. */
	deviceRequests = $state<DeviceRequest[]>([]);
	/** How much history the sidebar holds; Show Older Sessions raises it. */
	sessionLimit = $state(200);
	get moreSessions(): boolean {
		return this.sessions.length >= this.sessionLimit;
	}
	async loadOlderSessions(): Promise<void> {
		this.sessionLimit += 200;
		try {
			this.sessions = await rpc.call("session.list", { limit: this.sessionLimit });
		} catch (error) {
			this.say((error as Error).message);
		}
	}
	/** Search all history, past what the sidebar holds. */
	/** Older sessions matching a search; a search that couldn't run says so rather than finding nothing. */
	async searchSessions(query: string): Promise<{ found: SessionSummary[]; error?: string }> {
		return rpc.call("session.list", { query, limit: 40 }).then(
			(found) => ({ found }),
			(error: Error) => ({ found: [], error: error.message }),
		);
	}
	/** Requests the person chose to decide later: kept, counted on the lab's row, and opened again from there. */
	deferredDevices = $state<DeviceRequest[]>([]);

	/** Open a lab's deferred device requests again (all labs' without a name). */
	reviewDevices(site?: string): void {
		const again = this.deferredDevices.filter((r) => !site || r.site === site);
		this.deferredDevices = this.deferredDevices.filter((r) => !again.includes(r));
		this.deviceRequests = [...this.deviceRequests, ...again];
	}
	/** Lab apps being installed, by "site/name". */
	installing = $state(new Set<string>());
	models = $state<ModelInfo[]>([]);
	/** The model a new session gets when none is chosen. */
	defaultModel = $state<string | undefined>();
	ui = $state<UiPrefs>({ theme: "auto", showReasoning: true, permissions: "auto" });
	current = $state<string | undefined>();
	summary = $state<SessionSummary | undefined>();
	events = $state<SessionEvent[]>([]);
	status = $state<SessionStatus | undefined>();
	partial = $state<Partial_>(emptyPartial());
	pending = $state<PermissionRequest[]>([]);
	canvases = $state<CanvasSummary[]>([]);
	flash = $state<string | undefined>();
	/** A page the flash points to, opened with its link. */
	flashUrl = $state<string | undefined>();
	/** Set when a compaction lands, so the context ring can sweep once. */
	compactedAt = $state(0);
	/** The workbench: open or not, and its panes for the current session. */
	workbench = $state(false);
	/** A workbench tab is being dragged: the panes let the drag through to the groups' drop targets. */
	draggingTab = $state(false);
	layout = $state<Node>(emptyLayout());
	/** A move between places that is running (it can carry a repository), and the session it moves. */
	private movingFor = $state<{ sessionId: string; place: string } | undefined>();
	/** Where the open session is moving to, while it moves. */
	get moving(): string | undefined {
		return this.movingFor && this.movingFor.sessionId === this.current ? this.movingFor.place : undefined;
	}
	palette = $state(false);
	/** The model services sheet (add a key for OpenAI, Gemini and the like). */
	services = $state(false);
	/** The Model Services section to show when it next opens ("Models on This Computer…" opens its own). */
	servicesTab = $state<"plan" | "local" | "keys" | undefined>();
	/** An invite being joined (from an enrichedlab://join link or "Add a lab"). */
	join = $state<{ url?: string; name?: string; title?: string; isolated?: boolean } | undefined>();
	/** The settings sheet: appearance, labs, models. */
	settings = $state(false);
	/** The person's choice: View > Toggle Sidebar. */
	private sidebarChoice = $state(true);
	/** The window is 861 to 983 px wide: room for the session and the workbench, not for the sidebar as well. */
	private compactWidth = $state(false);
	/** The sidebar was asked for while the workbench was open in a compact window: it stays, the workbench floats. */
	private sidebarOverBench = $state(false);

	/**
	 * Whether the sidebar shows. In a compact window it steps aside while the workbench is open, as a Mac app's
	 * sidebar does for an inspector, and comes back when the workbench closes.
	 */
	get sidebar(): boolean {
		return this.sidebarChoice && (!(this.compactWidth && this.workbench) || this.sidebarOverBench);
	}
	set sidebar(on: boolean) {
		this.sidebarChoice = on;
		this.sidebarOverBench = on && this.compactWidth && this.workbench;
	}
	get compactWindow(): boolean {
		return this.compactWidth;
	}
	set compactWindow(on: boolean) {
		this.compactWidth = on;
		this.sidebarOverBench = false;
	}
	/** A question that needs a yes before something that can't be undone. */
	confirming = $state<{ title: string; detail?: string; facts?: { label: string; text: string; path?: boolean }[]; action: string; tone?: "danger" | "plain"; run: () => unknown } | undefined>();
	/** The place the new-session screen starts on (the rail's "New session in <place>"). */
	newPlace = $state<string | undefined>();
	/** The sidebar as a drawer, on a narrow window. */
	drawer = $state(false);
	/** The session whose title is being edited, in its sidebar row: the one place titles are edited. */
	renaming = $state<string | undefined>();

	/** Rename a session: the sidebar opens (or slides in on a narrow window) with its row ready to edit. */
	startRename(sessionId: string | undefined = this.current): void {
		if (!sessionId) return;
		if (typeof window !== "undefined" && window.matchMedia("(max-width: 860px)").matches) this.drawer = true;
		else this.sidebar = true;
		this.renaming = sessionId;
	}
	private flashTimer?: ReturnType<typeof setTimeout>;

	get busy(): boolean {
		return Boolean(this.status && this.status.activity !== "idle");
	}

	get model(): ModelInfo | undefined {
		return this.models.find((m) => m.ref === this.status?.model);
	}

	get places(): Place[] {
		return places(this.sites);
	}

	/** Where the open session works. */
	get place(): Place {
		return placeOf(this.places, this.summary?.place);
	}

	/** A lab that keeps its sessions' work in its sandbox can't be left. */
	/** A sheet, the palette or a page menu covers the window: native browser views hide, since nothing draws over them. */
	/** Menus drawn in the page that may lie over a pane (the workbench's Browser and Apps menus), counted while open. */
	overlays = $state(0);

	/**
	 * Something drawn in the page lies over the panes. A browser pane is a native view that page content can't cover,
	 * so it steps aside while this is true.
	 */
	get covered(): boolean {
		return Boolean(this.palette || this.settings || this.services || this.join || this.confirming || this.deviceRequests.length || pageMenu.current || this.overlays > 0 || this.drawer);
	}

	get pinned(): boolean {
		const site = this.summary?.site;
		return Boolean(site && this.sites.find((s) => s.name === site)?.isolated);
	}

	/** A short message at the bottom of the window; one with a page to open stays longer. */
	say(text: string, url?: string): void {
		this.flash = text;
		this.flashUrl = url;
		clearTimeout(this.flashTimer);
		this.flashTimer = setTimeout(() => ((this.flash = undefined), (this.flashUrl = undefined)), url ? 20_000 : 6_000);
	}

	async init(): Promise<void> {
		// Drafts and layouts the desktop shell carried across an engine restart, before anything reads them.
		adoptCarried();
		rpc.onState = (connected, reconnected) => {
			this.connected = connected;
			this.lost = !connected;
			// Inside the desktop app this window can drive its browser pane for the agent.
			if (connected) void rpc.call("hello", { client: "web", version: "1", capabilities: window.labDesktop?.browser?.agent ? ["browser"] : [] }).catch(() => undefined);
			if (connected && reconnected) void this.reload();
		};
		this.listen();
		rpc.connect();
		await this.reload();
		window.addEventListener("hashchange", () => void this.route());
		await this.route();
	}

	private async reload(): Promise<void> {
		// Each part shows as it arrives: the theme and the history never wait on model discovery, and one failure
		// doesn't hold back the rest.
		const parts = await Promise.allSettled([
			rpc.call("ui.get", {}).then((ui) => (this.ui = ui)),
			rpc.call("session.list", { limit: this.sessionLimit }).then((sessions) => (this.sessions = sessions)),
			rpc.call("site.list", {}).then((sites) => (this.sites = sites)),
			rpc.call("model.list", {}).then((models) => ((this.models = models.models), (this.defaultModel = models.default))),
			rpc.call("app.list", {}).then((apps) => (this.apps = apps)),
		]);
		void rpc
			.call("lab.apps", {})
			.then((offered) => (this.labApps = offered))
			.catch(() => undefined);
		const failed = parts.find((p): p is PromiseRejectedResult => p.status === "rejected");
		if (failed) this.say(`Part of the app didn't load: ${(failed.reason as Error)?.message ?? failed.reason}. It tries again when the engine reconnects.`);
		if (this.current) await this.open(this.current);
		// The engine forgets a window's live views when it reconnects: ask again for those still drawn.
		for (const site of this.desktopBands.keys()) void this.desktopWatch(site, true);
	}

	/** Set when a native window shows one pane of this page (#/embed/app/<id>?session=<sid>): no sidebar, no session view. */
	embed = $state<{ app: string; session?: string } | undefined>();

	private async route(): Promise<void> {
		const embedded = /^#\/embed\/app\/([^?]+)(?:\?(.*))?$/.exec(location.hash);
		if (embedded) {
			const q = new URLSearchParams(embedded[2] ?? "");
			const theme = q.get("theme");
			if (theme === "light" || theme === "dark") this.ui = { ...this.ui, theme };
			this.embed = { app: decodeURIComponent(embedded[1]!), session: q.get("session") ?? undefined };
			if (this.embed.session && this.embed.session !== this.current) await this.open(this.embed.session);
			return;
		}
		const match = /^#\/s\/(s[0-9a-z]+)/.exec(location.hash);
		if (match) {
			if (match[1] !== this.current) await this.open(match[1]);
		} else if (location.hash.startsWith("#/join")) {
			// An invite: the desktop app turns enrichedlab://join?… into this route.
			const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
			this.join = { url: q.get("url") ?? "", name: q.get("name") ?? undefined, title: q.get("title") ?? undefined, isolated: q.get("isolated") === "1" };
			history.replaceState(null, "", this.current ? `#/s/${this.current}` : "#/new");
		} else if (location.hash === "#/new") {
			this.leave();
		} else if (this.sessions[0] && !this.current) {
			location.hash = `#/s/${this.sessions[0].id}`;
		}
	}

	go(id: string): void {
		location.hash = `#/s/${id}`;
	}

	/** Bumped each time New Session is chosen, so the new-session screen starts over even when it's already showing. */
	startCount = $state(0);

	/** The project the new-session screen starts on, when the command named one ("New Session in <project>"). */
	newFolder = $state<string | undefined>();

	/**
	 * Every New Session command goes through here (⌘N, the sidebar, a place's or a project's menu, the palette): the
	 * same screen opens on the place and project it names, and a task already typed there stays.
	 */
	beginNew(options: { place?: string; folder?: string } = {}): void {
		this.newPlace = options.place;
		this.newFolder = options.folder;
		this.startNew();
	}

	/** The new-session screen. */
	startNew(): void {
		this.startCount++;
		location.hash = "#/new";
	}

	private leave(): void {
		if (this.current) void rpc.call("session.close", { sessionId: this.current }).catch(() => undefined);
		// A slow open still on its way must not bring back the session the person just left.
		this.openGeneration++;
		this.opening = undefined;
		this.current = undefined;
		this.summary = undefined;
		this.events = [];
		this.status = undefined;
		this.pending = [];
		this.canvases = [];
		this.screen = undefined;
		this.layout = emptyLayout();
	}

	/** While a session opens, what arrives for it waits here and joins after the snapshot, without repeats. */
	private opening?: { id: string; events: SessionEvent[]; requests: PermissionRequest[] };
	/** When the open session loaded; steps logged before it render without the enter motion. */
	openedAt = 0;

	/** Counts opens, so a slow answer for a session the person already left never replaces the one they chose. */
	private openGeneration = 0;

	async open(id: string): Promise<void> {
		if (this.current && this.current !== id) void rpc.call("session.close", { sessionId: this.current }).catch(() => undefined);
		const generation = ++this.openGeneration;
		this.opening = { id, events: [], requests: [] };
		try {
			const snap = await rpc.call("session.open", { sessionId: id });
			if (generation !== this.openGeneration) return;
			const held = this.opening;
			this.opening = undefined;
			if (this.current !== id) this.screen = undefined;
			this.current = id;
			this.openedAt = Date.now();
			this.summary = snap.summary;
			const known = new Set(snap.events.map((e) => e.id));
			this.events = [...snap.events, ...(held?.id === id ? held.events.filter((e) => !known.has(e.id)) : [])];
			this.status = snap.status;
			const asked = new Set(snap.pending.map((p) => p.requestId));
			this.pending = [...snap.pending, ...(held?.id === id ? held.requests.filter((r) => !asked.has(r.requestId)) : [])];
			this.partial = snap.partial ?? emptyPartial();
			const canvases = await rpc.call("canvas.list", { sessionId: id });
			if (generation !== this.openGeneration) return;
			this.canvases = canvases;
			this.restoreLayout(id);
		} catch (error) {
			if (generation === this.openGeneration) this.say((error as Error).message);
		}
	}

	// ── Workbench ──────────────────────────────────────────────────────────────────────────────────────────────────

	private restoreLayout(id: string): void {
		const saved = store.get(`enrichedlab.layout.${id}`);
		let layout: Node = emptyLayout();
		try {
			if (saved) layout = revive(JSON.parse(saved));
		} catch {
			// A damaged layout starts fresh.
		}
		layout = sync(layout, new Map(this.canvases.map((c) => [c.id, c.title])));
		// A session with views and no saved layout opens all of them, newest in front.
		if (!saved) for (const view of [...this.canvases].reverse().slice(-8)) layout = openTab(layout, this.tabFor(view));
		this.layout = layout;
		// Opened again on its own wherever it can sit beside the session (see App.svelte), never over it.
		const wide = window.matchMedia("(min-width: 720px)").matches;
		this.sidebarOverBench = false;
		this.workbench = wide && (store.get(`enrichedlab.bench.${id}`) ?? (groups(layout).some((g) => g.tabs.length) ? "1" : "0")) === "1";
	}

	/** Layout saves wait for a pause (a dragged gutter changes the layout every frame), one timer per session. */
	private layoutSaves = new Map<string, ReturnType<typeof setTimeout>>();
	private saveLayout(): void {
		const id = this.current;
		if (!id) return;
		const layout = JSON.stringify(this.layout);
		const bench = this.workbench ? "1" : "0";
		clearTimeout(this.layoutSaves.get(id));
		this.layoutSaves.set(
			id,
			setTimeout(() => {
				this.layoutSaves.delete(id);
				store.set(`enrichedlab.layout.${id}`, layout);
				store.set(`enrichedlab.bench.${id}`, bench);
			}, 250),
		);
	}

	setLayout(layout: Node): void {
		this.layout = layout;
		this.saveLayout();
	}

	toggleWorkbench(open = !this.workbench): void {
		this.workbench = open;
		if (!open) this.sidebarOverBench = false;
		this.saveLayout();
	}

	tabFor(view: CanvasSummary): Tab {
		const kind: PaneKind = view.kind === "table" ? "table" : view.kind === "plot" ? "plot" : view.kind === "page" ? "browser" : "view";
		return { id: uid("t"), kind, title: view.title, ref: kind === "browser" ? view.href : view.id };
	}

	/** Open a pane (or bring it forward) and show the workbench. */
	openPane(kind: PaneKind, ref?: string, title?: string): string {
		const view = ref ? this.canvases.find((c) => c.id === ref) : undefined;
		// A session drives one sandbox browser page: a pane for another lab's browser replaces the one open.
		if (kind === "screen") {
			const other = groups(this.layout)
				.flatMap((g) => g.tabs)
				.find((t) => t.kind === "screen" && t.ref !== ref);
			if (other) this.setLayout(closeTab(this.layout, other.id));
		}
		// Files, and each lab's sandbox browser, are one pane each: opening again brings it forward.
		const openFiles = (kind === "files" && !ref) || kind === "screen" || kind === "desktop" ? groups(this.layout).flatMap((g) => g.tabs).find((t) => t.kind === kind && (kind === "files" || t.ref === ref)) : undefined;
		if (openFiles) {
			this.focusPane(openFiles.id);
			this.workbench = true;
			this.saveLayout();
			return openFiles.id;
		}
		const tab: Tab = view ? this.tabFor(view) : { id: uid("t"), kind, title: title ?? TITLES[kind], ref };
		// Terminals and browsers are new each time; views and files come forward if open.
		const fresh = (kind === "terminal" || kind === "browser") && !ref ? { ...tab, id: uid("t") } : tab;
		// New panes join the group last used, when it's still there.
		const target = groups(this.layout).some((g) => g.id === this.lastGroup) ? this.lastGroup : undefined;
		this.layout = kind === "terminal" ? openTab(this.layout, { ...fresh, ref: fresh.id }, target) : openTab(this.layout, fresh, target);
		this.workbench = true;
		this.saveLayout();
		return fresh.id;
	}

	/** The agent's use of the browser pane: open (or reuse) one and let the desktop shell act on its page. */
	private async browse(call: { callId: string; op: string; args: Record<string, unknown> }): Promise<void> {
		const agent = window.labDesktop?.browser?.agent;
		try {
			if (!agent) throw new Error("This window has no browser.");
			let tab = groups(this.layout).flatMap((g) => g.tabs).find((t) => t.kind === "browser");
			if (!tab && call.op !== "open") throw new Error("No page is open; use browser_open first.");
			if (!tab) {
				const id = this.openPane("browser", "about:blank", "Browser");
				tab = groups(this.layout).flatMap((g) => g.tabs).find((t) => t.id === id)!;
			} else this.focusPane(tab.id);
			this.workbench = true;
			const result = await agent(tab.id, call.op, call.args);
			await rpc.call("surface.reply", { callId: call.callId, result });
		} catch (error) {
			await rpc.call("surface.reply", { callId: call.callId, error: (error as Error).message }).catch(() => undefined);
		}
	}

	/** Start or stop the screencast of the session's sandbox browser page; answers where the page is. */
	async watchScreen(on: boolean): Promise<void> {
		if (!this.current) return;
		const answer = await rpc.call("browser.watch", { sessionId: this.current, on }).catch(() => ({ page: undefined }));
		if (on && answer.page) this.screen = answer.page;
	}

	onFrame(listener: (frame: BrowserFrame) => void): () => void {
		this.frames.add(listener);
		return () => this.frames.delete(listener);
	}

	/** The pane's size: the page lays out to it, so it fills the pane at full sharpness. */
	screenResize(width: number, height: number): void {
		if (this.current) void rpc.call("browser.resize", { sessionId: this.current, width, height }).catch(() => undefined);
	}

	screenInput(event: BrowserInput): void {
		if (this.current) void rpc.call("browser.input", { sessionId: this.current, event }).catch(() => undefined);
	}

	/**
	 * One action on a lab's desktop from the pane, as the person's. The answer's picture arrives as desktop.frame too;
	 * a refusal is said once, not per click.
	 */
	async desktopAct(site: string, action: Record<string, unknown>): Promise<void> {
		this.desktopBusy = { ...this.desktopBusy, [site]: true };
		try {
			const { frame } = await rpc.call("desktop.act", { site, action });
			if (frame) this.desktops = { ...this.desktops, [site]: frame };
		} catch (error) {
			this.say((error as Error).message);
		} finally {
			this.desktopBusy = { ...this.desktopBusy, [site]: false };
		}
	}

	desktopUpdating = $state<Record<string, boolean>>({});

	/** Move an outdated lab desktop to the lab's current one, keeping its files; then a fresh picture. */
	async desktopUpdate(site: string): Promise<void> {
		this.desktopUpdating = { ...this.desktopUpdating, [site]: true };
		try {
			await rpc.call("desktop.update", { site });
			void this.desktopAct(site, { action: "screenshot" });
		} catch (error) {
			this.say((error as Error).message);
		} finally {
			this.desktopUpdating = { ...this.desktopUpdating, [site]: false };
		}
	}

	/** Watch a lab desktop live while `draw` is subscribed; the returned function stops. */
	watchDesktop(site: string, draw: (band: DesktopBand) => void): () => void {
		let listeners = this.desktopBands.get(site);
		if (!listeners) this.desktopBands.set(site, (listeners = new Set()));
		const first = listeners.size === 0;
		listeners.add(draw);
		if (first) void this.desktopWatch(site, true);
		return () => {
			listeners.delete(draw);
			if (listeners.size === 0) {
				this.desktopBands.delete(site);
				void rpc.call("desktop.watch", { site, on: false }).catch(() => undefined);
				this.desktopLive = { ...this.desktopLive, [site]: { site, live: false } };
			}
		};
	}

	private async desktopWatch(site: string, on: boolean): Promise<void> {
		const stream = await rpc.call("desktop.watch", { site, on }).catch(() => ({ site, live: false }) as DesktopStream);
		this.desktopLive = { ...this.desktopLive, [site]: stream };
	}

	async desktopOpen(site: string, target: string): Promise<void> {
		this.desktopBusy = { ...this.desktopBusy, [site]: true };
		try {
			const { frame } = await rpc.call("desktop.open", { site, target });
			if (frame) this.desktops = { ...this.desktops, [site]: frame };
		} catch (error) {
			this.say((error as Error).message);
		} finally {
			this.desktopBusy = { ...this.desktopBusy, [site]: false };
		}
	}

	async screenNavigate(site: string, to: { url?: string; step?: "back" | "forward" | "reload" }): Promise<void> {
		if (!this.current) return;
		try {
			await rpc.call("browser.navigate", { sessionId: this.current, site, ...to });
		} catch (error) {
			this.say((error as Error).message);
		}
	}

	closePane(tabId: string): void {
		this.setLayout(closeTab(this.layout, tabId));
		if (!groups(this.layout).some((g) => g.tabs.length)) this.toggleWorkbench(false);
	}

	/** The workbench group last used: ⌘W closes its front tab. */
	lastGroup = $state<string | undefined>();

	focusPane(tabId: string): void {
		this.lastGroup = groups(this.layout).find((g) => g.tabs.some((t) => t.id === tabId))?.id;
		this.setLayout(activate(this.layout, tabId));
	}

	/** Put a pane at a position in a group's tab strip. */
	placePane(tabId: string, groupId: string, index: number): void {
		this.setLayout(place(this.layout, tabId, groupId, index));
	}

	movePane(tabId: string, groupId: string, edge: Edge): void {
		this.setLayout(move(this.layout, tabId, groupId, edge));
	}

	resizeSplit(splitId: string, sizes: number[]): void {
		this.setLayout(resizeSplit(this.layout, splitId, sizes));
	}

	/** Open an app in the workbench: by id, as the agent or the palette names it. */
	openApp(app: AppSummary): void {
		if (!this.apps.some((a) => a.id === app.id)) this.apps = [...this.apps, app];
		this.openPane("app", app.id, app.title);
	}

	async refreshApps(): Promise<void> {
		const [apps, offered] = await Promise.all([rpc.call("app.list", {}).catch(() => this.apps), rpc.call("lab.apps", {}).catch(() => this.labApps)]);
		this.apps = apps;
		this.labApps = offered;
	}

	/** What each lab offers that isn't installed at its newest version: one entry per app. */
	get labOffers(): LabApp[] {
		const seen = new Set<string>();
		return this.labApps.filter((a) => {
			const key = `${a.site}/${a.name}`;
			if (seen.has(key) || a.withdrawn || a.signerRevoked) return false;
			seen.add(key);
			return a.installed !== a.version;
		});
	}

	/** Install (or update) an app from a lab's list, then open it. */
	async installLabApp(app: LabApp): Promise<void> {
		const key = `${app.site}/${app.name}`;
		this.installing = new Set([...this.installing, key]);
		try {
			const summary = await rpc.call("lab.app.install", { site: app.site, name: app.name, version: app.version });
			await this.refreshApps();
			this.say(`Installed ${summary.title} ${summary.version} from ${app.lab}.`);
			this.openApp(summary);
		} catch (error) {
			this.say((error as Error).message);
		} finally {
			this.installing = new Set([...this.installing].filter((k) => k !== key));
		}
	}

	/** Point at a view's step: open its pane. */
	showView(id: string): void {
		const view = this.canvases.find((c) => c.id === id);
		if (view) this.openPane(this.tabFor(view).kind, view.kind === "page" ? view.href : view.id);
	}

	async openFile(path: string): Promise<void> {
		const sessionId = this.current;
		if (!sessionId) return;
		try {
			const view = await rpc.call("view.open", { sessionId, path });
			// Opened for a session the person has since left: it's in that session's views when they go back.
			if (this.current !== sessionId) return;
			this.upsertView(view);
			this.showView(view.id);
		} catch (error) {
			this.say((error as Error).message);
		}
	}

	private upsertView(view: CanvasSummary): boolean {
		const first = !this.canvases.some((c) => c.id === view.id);
		this.canvases = [view, ...this.canvases.filter((c) => c.id !== view.id)];
		this.layout = sync(this.layout, new Map(this.canvases.map((c) => [c.id, c.title])));
		return first;
	}

	// ── Session actions ────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Every move starts here: the composer's switch, the rail and the palette. It's reviewed first (what goes along,
	 * where it runs, how work comes back), and the move then acts on the session that was reviewed.
	 */
	async requestMove(place: string): Promise<void> {
		const sessionId = this.current;
		const target = this.places.find((p) => p.id === place);
		if (!sessionId || !target || place === this.place.id || this.movingFor) return;
		if (target.site && !target.site.signedIn) return void this.login(place);
		const from = this.place;
		if (place !== "local" && from.id !== "local") return this.say(`Move back to ${computerName()} first: the work comes home as a branch, and then it can go to ${target.title}.`);
		const runs = { label: "Runs", text: `On Linux in the ${target.title} sandbox, with no network` };
		let facts: { label: string; text: string; path?: boolean }[];
		if (place === "local") {
			facts = [{ label: "Works in", text: this.summary?.cwd ?? "the project folder", path: true }];
			if (from.site) facts.push({ label: "Comes back", text: `New commits from the ${from.title} sandbox, as a branch for you to merge` }, { label: "Stays there", text: "Changes it didn't commit" });
		} else {
			let plan: { repo?: string };
			try {
				plan = await rpc.call("session.moveplan", { sessionId });
			} catch (error) {
				return this.say(`Couldn't check what would move: ${(error as Error).message}`);
			}
			if (this.current !== sessionId) return;
			facts = plan.repo
				? [
						{ label: "Goes along", text: "The git repository, uncommitted changes included. Files that look like secrets stay here." },
						{ label: "Repository", text: plan.repo, path: true },
						runs,
						{ label: "Comes back", text: "New commits, as a branch, when you move back" },
					]
				: [{ label: "Goes along", text: "Nothing: this folder isn't a git repository, so the sandbox starts empty. Make it a repository first to take its files." }, runs];
		}
		this.confirming = { title: place === "local" ? `Move back to ${target.title}?` : `Move this session to the ${target.title} sandbox?`, facts, action: "Move", tone: "plain", run: () => this.movePlace(place, sessionId) };
	}

	async movePlace(place: string, sessionId = this.current): Promise<void> {
		if (!sessionId || this.movingFor) return;
		this.movingFor = { sessionId, place };
		try {
			const result = await rpc.call("session.place", { sessionId, place });
			this.upsert(result.summary);
			if (this.current === sessionId) this.summary = result.summary;
			this.say(result.detail);
		} catch (error) {
			this.say((error as Error).message);
		} finally {
			this.movingFor = undefined;
		}
	}

	async undo(): Promise<void> {
		if (!this.current) return;
		try {
			const result = await rpc.call("session.undo", { sessionId: this.current });
			this.say(result.detail);
		} catch (error) {
			this.say(`Undo didn't work: ${(error as Error).message}`);
		}
	}

	/** Text a send couldn't deliver, for the composer of the session it was written for to show again. */
	returned = $state<{ sessionId: string; text: string } | undefined>();

	/**
	 * Start a session; `site` binds it to one lab (an isolated lab also keeps its work there). A `prompt` runs as the
	 * first turn once the session is in its place; if it can't start, it comes back in that session's composer.
	 */
	async create(cwd: string, options: { site?: string; place?: string; worktree?: boolean; model?: string; prompt?: string; progress?: (step: string) => void } = {}): Promise<string | undefined> {
		let id: string | undefined;
		try {
			let summary = await rpc.call("session.create", { cwd, site: options.site, worktree: options.worktree, model: options.model });
			id = summary.id;
			if (options.place && options.place !== "local" && summary.place !== options.place) {
				options.progress?.(this.places.find((p) => p.id === options.place)?.title ?? options.place);
				summary = (await rpc.call("session.place", { sessionId: summary.id, place: options.place })).summary;
			}
			this.upsert(summary);
		} catch (error) {
			// A session that never reached its place is removed, so the task isn't run somewhere else by mistake.
			if (id) void rpc.call("session.delete", { sessionId: id }).catch(() => undefined);
			this.say((error as Error).message);
			return undefined;
		}
		this.go(id);
		await this.open(id);
		if (options.prompt) {
			try {
				await this.send(options.prompt, undefined, id);
			} catch (error) {
				this.say(`The task didn't start: ${(error as Error).message}`);
				this.returned = { sessionId: id, text: options.prompt };
			}
		}
		return id;
	}

	async send(text: string, images?: Part[], sessionId = this.current): Promise<void> {
		if (!sessionId) return;
		await rpc.call("session.prompt", { sessionId, text, images });
	}

	/** Stop the turn; messages that were waiting to join it go back into the composer. */
	cancel(): void {
		const sessionId = this.current;
		if (!sessionId) return;
		void rpc
			.call("session.cancel", { sessionId })
			.then((result) => {
				if (result.returned?.length) this.returned = { sessionId, text: result.returned.join("\n\n") };
			})
			.catch((error: Error) => this.say(`Couldn't stop it: ${error.message}`));
	}

	/** Answer a permission request. If the answer doesn't reach the engine, the request comes back to answer again. */
	async answer(requestId: string, decision: PermissionDecision): Promise<void> {
		const request = this.pending.find((p) => p.requestId === requestId);
		this.pending = this.pending.filter((p) => p.requestId !== requestId);
		try {
			await rpc.call("permission.answer", { requestId, decision });
		} catch (error) {
			if (request && !this.pending.some((p) => p.requestId === requestId)) this.pending = [request, ...this.pending];
			this.say(`Your answer didn't reach the engine: ${(error as Error).message}`);
		}
	}

	async setModel(model?: string, effort?: string): Promise<void> {
		const sessionId = this.current;
		if (!sessionId) return;
		try {
			const status = await rpc.call("session.model", { sessionId, model, effort });
			if (this.current === sessionId) this.status = status;
		} catch (error) {
			this.say((error as Error).message);
		}
	}

	async compact(): Promise<void> {
		if (!this.current) return;
		try {
			const result = await rpc.call("session.compact", { sessionId: this.current });
			this.say(result.detail);
		} catch (error) {
			this.say(`Summarizing didn't work: ${(error as Error).message}`);
		}
	}

	/** Rename a session; false (with the reason said) when it didn't save. */
	async rename(title: string, sessionId = this.current): Promise<boolean> {
		if (!sessionId || !title.trim()) return false;
		try {
			await rpc.call("session.rename", { sessionId, title: title.trim() });
		} catch (error) {
			this.say(`The new name didn't save: ${(error as Error).message}`);
			return false;
		}
		const summary = this.sessions.find((s) => s.id === sessionId);
		if (summary) this.upsert({ ...summary, title: title.trim() });
		return true;
	}

	/** Ask first, then delete a session's record from this computer. Its project folder isn't touched. */
	deleteSession(sessionId: string): void {
		const summary = this.sessions.find((s) => s.id === sessionId);
		if (!summary) return;
		this.confirming = {
			title: `Delete “${summary.title}”?`,
			detail: "Its conversation and outputs are removed from this computer. Files in the project folder stay as they are.",
			action: "Delete",
			run: async () => {
				try {
					await rpc.call("session.delete", { sessionId });
					this.sessions = this.sessions.filter((s) => s.id !== sessionId);
					if (this.current === sessionId) this.startNew();
				} catch (error) {
					this.say((error as Error).message);
				}
			},
		};
	}

	async logout(name: string): Promise<void> {
		try {
			await rpc.call("site.logout", { name });
			await this.refreshModels();
			this.say(`Signed out of ${this.sites.find((s) => s.name === name)?.title ?? name}.`);
		} catch (error) {
			this.say((error as Error).message);
		}
	}

	/** Ask first, then forget a lab on this computer. */
	removeLab(name: string): void {
		const title = this.sites.find((s) => s.name === name)?.title ?? name;
		this.confirming = {
			title: `Remove ${title}?`,
			detail: `You're signed out of ${title} and it leaves this computer. Its sessions stay here, without its models and tools. You can add it again from its invite.`,
			action: "Remove",
			run: async () => {
				try {
					await rpc.call("site.remove", { name });
					await this.refreshModels();
					this.say(`Removed ${title}.`);
				} catch (error) {
					this.say((error as Error).message);
				}
			},
		};
	}

	async reconnect(name?: string): Promise<void> {
		try {
			this.sites = await rpc.call("site.refresh", name ? { name } : {});
			({ models: this.models, default: this.defaultModel } = await rpc.call("model.list", { refresh: true }));
		} catch (error) {
			this.say((error as Error).message);
		}
	}

	/** Show a folder in Finder or Explorer (desktop app only). */
	reveal(path: string): void {
		void window.labDesktop?.reveal?.(path);
	}

	copy(text: string, what: string): void {
		void navigator.clipboard.writeText(text).then(
			() => this.say(`Copied ${what}.`),
			() => this.say(`Couldn't copy ${what}.`),
		);
	}

	async refreshModels(): Promise<void> {
		({ models: this.models, default: this.defaultModel } = await rpc.call("model.list", { refresh: true }));
		this.sites = await rpc.call("site.list", {});
	}

	/** Sign in to a lab in the browser. Says whether it worked, so a form can stay open to try again. */
	async login(name: string): Promise<{ ok: boolean; error?: string }> {
		try {
			const site = await rpc.call("site.login", { name });
			this.say(site.signedIn ? `Signed in to ${site.title} as ${site.who}.` : `Not signed in: ${site.error}`);
			await this.refreshModels();
			return site.signedIn ? { ok: true } : { ok: false, error: site.error ?? "The sign-in didn't finish." };
		} catch (error) {
			this.say((error as Error).message);
			return { ok: false, error: (error as Error).message };
		}
	}

	/** Applied at once, then saved; if saving fails the choice goes back and says why. */
	async setTheme(theme: UiPrefs["theme"]): Promise<void> {
		await this.setUi({ theme });
	}

	async setUi(prefs: Partial<UiPrefs>): Promise<void> {
		const before = this.ui;
		this.ui = { ...this.ui, ...prefs };
		try {
			this.ui = await rpc.call("ui.set", prefs);
		} catch (error) {
			this.ui = before;
			this.say(`Couldn't save that setting: ${(error as Error).message}`);
		}
	}

	private upsert(summary: SessionSummary): void {
		const rest = this.sessions.filter((s) => s.id !== summary.id);
		this.sessions = [summary, ...rest].sort((a, b) => b.updated.localeCompare(a.updated));
		if (summary.id === this.current) this.summary = summary;
	}

	private listen(): void {
		rpc.on("session.event", ({ sessionId, event }) => {
			if (sessionId === this.opening?.id) return void this.opening.events.push(event);
			if (sessionId !== this.current) return;
			if (this.events.at(-1)?.id === event.id || this.events.some((e) => e.id === event.id)) return;
			this.events.push(event);
			if (event.t === "assistant") this.partial = emptyPartial();
			if (event.t === "compaction") this.compactedAt = Date.now();
		});
		rpc.on("session.delta", (delta) => {
			if (delta.sessionId !== this.current) return;
			const p = this.partial;
			if (delta.kind === "text") p.text += delta.text;
			else if (delta.kind === "reasoning") p.reasoning += delta.text;
			else if (delta.kind === "tool") {
				if (delta.name !== undefined) p.tools.push({ index: delta.index ?? 0, name: delta.name, args: "" });
				else {
					const call = p.tools.find((c) => c.index === delta.index);
					if (call) call.args += delta.text;
				}
			} else if (delta.kind === "output" && delta.callId) {
				p.output[delta.callId] = ((p.output[delta.callId] ?? "") + delta.text).slice(-20_000);
			}
		});
		rpc.on("session.status", (status) => {
			if (status.sessionId !== this.current) return;
			this.status = status;
			if (status.activity === "idle") this.partial = emptyPartial();
		});
		rpc.on("session.updated", (summary) => this.upsert(summary));
		rpc.on("surface.call", (call) => {
			if (call.capability === "browser") void this.browse(call);
		});
		rpc.on("permission.request", (request) => {
			if (request.sessionId === this.opening?.id) return void this.opening.requests.push(request);
			// The open session's own questions, and those of its subagents (the engine sends those to the lead's windows).
			const mine = request.sessionId === this.current || (!!request.lead && request.lead === this.current);
			if (mine && !this.pending.some((p) => p.requestId === request.requestId)) this.pending.push(request);
		});
		rpc.on("permission.settled", ({ requestId }) => {
			this.pending = this.pending.filter((p) => p.requestId !== requestId);
		});
		rpc.on("site.updated", (site) => {
			const before = this.sites.find((s) => s.name === site.name);
			this.sites = before ? this.sites.map((s) => (s.name === site.name ? site : s)) : [...this.sites, site];
			// A lab that signed in, out, or changed what it grants changes which models are offered.
			if (!before || before.signedIn !== site.signedIn || before.models !== site.models) {
				void rpc.call("model.list", {}).then((r) => ((this.models = r.models), (this.defaultModel = r.default)), () => undefined);
			}
		});
		rpc.on("lab.notice", (notice) => this.say(notice.text, notice.url));
		rpc.on("lab.apps.changed", () => void this.refreshApps());
		rpc.on("lab.device.pending", (request) => {
			const same = (r: DeviceRequest) => r.site === request.site && r.id === request.id;
			if (!this.deviceRequests.some(same) && !this.deferredDevices.some(same)) this.deviceRequests = [...this.deviceRequests, request];
		});
		rpc.on("provider.auth", (auth) => {
			window.open(auth.url, "_blank", "noopener");
		});
		rpc.on("site.auth", (auth) => {
			window.open(auth.url, "_blank", "noopener");
			this.say(`Sign in to ${auth.name} in the browser window that opened. The first time, it may ask you to set up a second step: a passkey, a security key or an authenticator app.`);
		});
		rpc.on("canvas.updated", (view) => {
			if (view.sessionId !== this.current) return;
			// A new view opens as a tab, and the workbench opens for it; an update refreshes in place.
			if (this.upsertView(view)) {
				this.layout = openTab(this.layout, this.tabFor(view));
				this.workbench = true;
				this.saveLayout();
			}
		});
		rpc.on("ui.updated", (ui) => (this.ui = ui));
		// The agent's page in a lab's sandbox browser: its pane opens on the first sign of it.
		rpc.on("browser.page", (page) => {
			if (page.sessionId !== this.current) return;
			const fresh = this.screen?.site !== page.site;
			this.screen = page;
			// The first sign of the agent browsing there brings the pane forward, opening the workbench if needed.
			if (fresh) this.openPane("screen", page.site, `${page.lab} browser`);
		});
		// A lab's desktop after an action. The agent's first one in the open session's lab brings the pane forward.
		rpc.on("desktop.frame", (frame) => {
			this.desktops = { ...this.desktops, [frame.site]: frame };
			const shown = groups(this.layout).flatMap((g) => g.tabs).some((t) => t.kind === "desktop" && t.ref === frame.site);
			if (frame.by === "agent" && !shown && this.summary?.place === frame.site) this.openPane("desktop", frame.site, `${this.place.title} desktop`);
		});
		rpc.on("desktop.band", (band) => {
			for (const draw of this.desktopBands.get(band.site) ?? []) draw(band);
		});
		rpc.on("desktop.stream", (stream) => {
			this.desktopLive = { ...this.desktopLive, [stream.site]: stream };
		});
		rpc.on("browser.frame", (frame) => {
			if (frame.sessionId === this.current) for (const listener of this.frames) listener(frame);
		});
		rpc.on("app.opened", ({ sessionId, app }) => {
			if (sessionId === this.current) this.openApp(app);
		});
	}
}

export const lab = new Lab();

/** Where a person reviews and limits their ChatGPT plan's use in other apps. */
export const USAGE_URL = "https://chatgpt.com/settings/usage";
