<script lang="ts">
	// The sidebar: where this person can work (places), and their sessions by project. Its top row is the window's
	// title bar beside the traffic lights. Every row acts on click, and offers its other actions on right-click and
	// on its "More" button.
	import { untrack } from "svelte";
	import type { SessionSummary } from "@enrichedlab/protocol";
	import { lab } from "../lib/store.svelte.ts";
	import { ago, folderName } from "../lib/format.ts";
	import { mac, placeOf, type Place } from "../lib/places.ts";
	import { contextMenu, separator, showMenu, type MenuAction } from "../lib/menu.svelte.ts";

	let { open = $bindable(false) }: { open?: boolean } = $props();

	let filter = $state("");
	let expanded = $state<Record<string, boolean>>({});
	let draft = $state("");
	const desktop = typeof window !== "undefined" && Boolean(window.labDesktop);

	/** A session's project: its repository for worktree sessions, else its folder. */
	function projectOf(cwd: string): string {
		const worktree = /^(.*?)[\\/]\.git[\\/]enrichedlab-worktrees[\\/]/.exec(cwd);
		return worktree ? worktree[1]! : cwd;
	}

	const projects = $derived.by(() => {
		const query = filter.trim().toLowerCase();
		const byProject = new Map<string, SessionSummary[]>();
		for (const s of lab.sessions) {
			if (query && !s.title.toLowerCase().includes(query) && !folderName(s.cwd).toLowerCase().includes(query)) continue;
			const key = projectOf(s.cwd);
			let list = byProject.get(key);
			if (!list) byProject.set(key, (list = []));
			list.push(s);
		}
		return [...byProject.entries()].map(([path, sessions]) => ({ path, name: folderName(path), sessions }));
	});

	const currentProject = $derived(lab.summary ? projectOf(lab.summary.cwd) : undefined);

	function pick(id: string) {
		lab.go(id);
		open = false;
	}

	function fresh(place?: string) {
		lab.beginNew({ place });
		open = false;
	}

	/** One line under a place's name: who and what, or what to do next. */
	function status(place: Place): string {
		if (place.id === "local") return "Your files, contained";
		const site = place.site!;
		if (!site.signedIn) return site.error ? "Can't connect" : "Not signed in";
		const parts = [site.who, `${site.models} ${site.models === 1 ? "model" : "models"}`, site.sandbox ? "sandbox" : "no sandbox"];
		return parts.filter(Boolean).join(" · ");
	}

	function placeActions(place: Place): MenuAction[] {
		const name = place.title;
		const waiting = lab.deferredDevices.some((r) => r.site === place.id);
		if (waiting) return [{ label: "Review Device Requests…", run: () => lab.reviewDevices(place.id) }, separator, ...placeMenu(place, name)];
		return placeMenu(place, name);
	}

	function placeMenu(place: Place, name: string): MenuAction[] {
		if (place.id === "local") {
			return [
				{ label: `New Session on ${name}`, run: () => fresh("local") },
				separator,
				{ label: "Models on This Computer…", run: () => ((lab.servicesTab = "local"), (lab.services = true)) },
			];
		}
		const site = place.site!;
		if (!site.signedIn) {
			return [
				{ label: `Sign In to ${name}…`, run: () => lab.login(place.id) },
				{ label: "Try Connecting Again", run: () => lab.reconnect(place.id) },
				separator,
				{ label: `Remove ${name}…`, run: () => lab.removeLab(place.id) },
			];
		}
		return [
			{ label: `New Session in ${name}`, disabled: !place.ready && !site.isolated, run: () => fresh(place.id) },
			separator,
			{ label: "Reconnect", run: () => lab.reconnect(place.id) },
			...(site.docs ? [{ label: `${name} Help`, run: () => window.open(site.docs, "_blank", "noopener") }] : []),
			separator,
			{ label: `Sign Out of ${name}`, run: () => lab.logout(place.id) },
			{ label: `Remove ${name}…`, run: () => lab.removeLab(place.id) },
		];
	}

	function sessionActions(s: SessionSummary): MenuAction[] {
		const here = s.id === lab.current;
		const project = projectOf(s.cwd);
		return [
			{ label: "Open", disabled: here, run: () => pick(s.id) },
			{ label: "Rename", run: () => startRename(s) },
			...(here && !lab.pinned
				? [
						{
							label: "Run On",
							submenu: lab.places.map((p) => ({ label: p.id === "local" ? p.title : `${p.title} sandbox`, checked: p.id === lab.place.id, radio: true as const, disabled: !p.ready || Boolean(p.site?.isolated) || lab.busy, run: () => void lab.requestMove(p.id) })),
						},
					]
				: []),
			separator,
			{ label: `New Session in ${folderName(project)}`, run: () => lab.beginNew({ folder: project }) },
			...(desktop ? [{ label: mac ? "Show in Finder" : "Show in Folder", run: () => lab.reveal(s.cwd) }] : []),
			{ label: "Copy Folder Path", run: () => lab.copy(s.cwd, "the folder path") },
			separator,
			{ label: "Delete…", disabled: s.running, run: () => lab.deleteSession(s.id) },
		];
	}

	function projectActions(path: string): MenuAction[] {
		return [
			{ label: "New Session Here", run: () => lab.beginNew({ folder: path }) },
			...(desktop ? [{ label: mac ? "Show in Finder" : "Show in Folder", run: () => lab.reveal(path) }] : []),
			{ label: "Copy Folder Path", run: () => lab.copy(path, "the folder path") },
		];
	}

	function startRename(s: SessionSummary) {
		lab.startRename(s.id);
	}
	// However renaming starts (this row, the menu bar, the session's More menu), the draft starts from the title.
	// Only a new rename starts it: a session list update while the person types leaves their text alone.
	$effect(() => {
		const id = lab.renaming;
		if (id) untrack(() => (draft = lab.sessions.find((s) => s.id === id)?.title ?? ""));
	});

	async function finishRename(s: SessionSummary, keep: boolean) {
		if (lab.renaming !== s.id) return;
		const title = draft.trim();
		lab.renaming = undefined;
		if (!keep || !title || title === s.title) return;
		// A rename that doesn't save opens again with what was typed.
		if (!(await lab.rename(title, s.id))) {
			lab.renaming = s.id;
			draft = title;
		}
	}

	function focusInput(node: HTMLInputElement) {
		node.focus();
		node.select();
	}

	// On a narrow window the sidebar is a drawer: closed, it's out of the keyboard and screen reader's way.
	let narrow = $state(false);
	$effect(() => {
		const query = window.matchMedia("(max-width: 860px)");
		const update = () => (narrow = query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	});

	let now = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(timer);
	});
</script>

<svelte:window onkeydown={(e) => narrow && open && e.key === "Escape" && (open = false)} />
{#if open}
	<button class="scrim" aria-label="Close the sidebar" onclick={() => (open = false)}></button>
{/if}
<nav class="rail" class:open class:hidden={!lab.sidebar} aria-label="Places and sessions" inert={narrow && !open}>
	<div class="toolbar">
		{#if !window.labDesktop}<a class="runs-link" href="/runs">Research runs</a>{/if}
		<span class="spacer"></span>
		<button class="icon-btn wide-only" onclick={() => (lab.sidebar = false)} title={`Hide the sidebar (${mac ? "⌃⌘S" : "Ctrl+Shift+S"})`} aria-label="Hide the sidebar">
			<svg viewBox="0 0 16 16"><rect x="2" y="2.5" width="12" height="11" rx="2" /><path d="M6 2.5v11" /></svg>
		</button>
		<button class="icon-btn" onclick={() => fresh()} title={`New session (${mac ? "⌘N" : "Ctrl+N"})`} aria-label="New session">
			<svg viewBox="0 0 16 16"><path d="M8.5 2.5H4a1.5 1.5 0 0 0-1.5 1.5v8A1.5 1.5 0 0 0 4 13.5h8a1.5 1.5 0 0 0 1.5-1.5V7.5" /><path d="m7 9 .4-1.9L12.6 2a1.1 1.1 0 0 1 1.5 1.5L9 8.6Z" /></svg>
		</button>
	</div>

	<button class="search" onclick={() => (lab.palette = true)}>
		<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25" /><path d="m10.2 10.2 3 3" /></svg>
		<span>Search</span>
		<kbd>{mac ? "⌘K" : "Ctrl K"}</kbd>
	</button>

	<div class="scroll">
		<section aria-labelledby="places-label">
			<div class="section-head">
				<h2 id="places-label">Places</h2>
				<button class="icon-btn small" onclick={() => (lab.join = {})} title="Add a lab" aria-label="Add a lab">
					<svg viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9" /></svg>
				</button>
			</div>
			{#each lab.places as place (place.id)}
				{@const here = Boolean(lab.current) && lab.place.id === place.id}
				{@const needsSignIn = Boolean(place.site && !place.site.signedIn)}
				{@const waiting = lab.deferredDevices.filter((r) => r.site === place.id).length}
				<div class="place" class:here use:contextMenu={() => placeActions(place)}>
					<button class="place-main" onclick={(e) => (needsSignIn ? lab.login(place.id) : showMenu(placeActions(place), e.currentTarget as HTMLElement))} aria-haspopup={needsSignIn ? undefined : "menu"}>
						<span class="place-dot" class:local={place.id === "local"} style:--dot={`var(${place.color})`}></span>
						<span class="place-text">
							<span class="name">{place.title}</span>
							<span class="sub" class:attention={needsSignIn || place.site?.error} title={place.site?.warning ?? place.site?.error ?? ""}>{status(place)}</span>
						</span>
						{#if needsSignIn}
							<span class="sign-in">Sign In</span>
						{:else if here}
							<span class="here-mark">This session</span>
						{/if}
					</button>
					{#if waiting}
						<button class="devices" onclick={() => lab.reviewDevices(place.id)}>{waiting} {waiting === 1 ? "device asks" : "devices ask"} to use your sign-in</button>
					{/if}
				</div>
			{/each}
		</section>

		<section aria-labelledby="sessions-label">
			<div class="section-head">
				<h2 id="sessions-label">Sessions</h2>
			</div>
			{#if lab.sessions.length > 6}
				<input class="filter" placeholder="Filter" bind:value={filter} aria-label="Filter sessions" spellcheck="false" />
			{/if}
			{#each projects as project (project.path)}
				{@const showAll = expanded[project.path] || filter}
				{@const shown = showAll ? project.sessions : project.sessions.slice(0, project.path === currentProject ? 8 : 4)}
				<div class="project">
					<div class="project-name" title={project.path} use:contextMenu={() => projectActions(project.path)}>
						<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5A1.5 1.5 0 0 1 4 3h2.6l1.4 1.5h4A1.5 1.5 0 0 1 13.5 6v5.5A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5Z" /></svg>
						<span class="project-label">{project.name}</span>
						<!-- The same actions as right-click, for the keyboard and touch. -->
						<button class="project-more" aria-label={`Actions for ${project.name}`} aria-haspopup="menu" onclick={(e) => showMenu(projectActions(project.path), e.currentTarget as HTMLElement)}>
							<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12" cy="8" r="1.2" /></svg>
						</button>
					</div>
					{#each shown as s (s.id)}
						{@const place = s.place && s.place !== "local" ? placeOf(lab.places, s.place) : undefined}
						{#if lab.renaming === s.id}
							<input
								class="rename"
								bind:value={draft}
								use:focusInput
								onblur={() => finishRename(s, true)}
								onkeydown={(e) => {
									if (e.key === "Enter") finishRename(s, true);
									else if (e.key === "Escape") finishRename(s, false);
								}}
								aria-label="Session title"
							/>
						{:else}
							<button
								class="session"
								class:current={s.id === lab.current}
								class:away={Boolean(place)}
								style:--mark={place ? `var(${place.color})` : "var(--accent)"}
								aria-current={s.id === lab.current ? "page" : undefined}
								onclick={() => pick(s.id)}
								ondblclick={() => startRename(s)}
								use:contextMenu={() => sessionActions(s)}
							>
								<span class="title" title={place ? `${s.title} (runs in the ${place.title} sandbox)` : s.title}>{s.title}</span>
								{#if place}<span class="visually-hidden">, in the {place.title} sandbox</span>{/if}
								{#if s.running}
									<span class="live" aria-label="running"></span>
								{:else}
									<span class="when">{ago(s.updated, now)}</span>
								{/if}
							</button>
						{/if}
					{/each}
					{#if !showAll && project.sessions.length > shown.length}
						<button class="more" onclick={() => (expanded[project.path] = true)}>Show {project.sessions.length - shown.length} more</button>
					{:else if expanded[project.path] && !filter && project.sessions.length > (project.path === currentProject ? 8 : 4)}
						<button class="more" onclick={() => (expanded[project.path] = false)}>Show less</button>
					{/if}
				</div>
			{:else}
				<p class="empty">{filter ? "No sessions match." : "Sessions you start appear here, by project."}</p>
			{/each}
					{#if lab.moreSessions && !filter}
				<button class="more older" onclick={() => lab.loadOlderSessions()}>Show Older Sessions</button>
			{/if}
		</section>
	</div>

	<div class="foot">
		<button class="foot-btn" onclick={() => (lab.settings = true)}>
			<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2" /><path d="M8 1.8v1.6M8 12.6v1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M1.8 8h1.6M12.6 8h1.6M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" /></svg>
			Settings
		</button>
		<button class="foot-btn" onclick={() => (lab.services = true)}>
			<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2.5" /><path d="M6 6.5h4M6 9.5h2.5" /></svg>
			Models
		</button>
	</div>
</nav>

<style>
	.runs-link { display:inline-flex; align-items:center; min-height:44px; color:var(--link); font-weight:550; }
	.rail {
		display: flex;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
		background: var(--rail);
		font-size: 13px;
		user-select: none;
	}
	.rail.hidden {
		display: none;
	}
	.toolbar {
		padding: 0 10px;
		gap: 2px;
	}
	/* The traffic lights sit at the left of this row in the desktop app on macOS. */
	:global(.shell.mac.desktop) .toolbar {
		padding-left: var(--traffic-inset, 84px);
	}
	.spacer {
		flex: 1;
	}
	.search {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0 10px 6px;
		height: 30px;
		padding: 0 10px;
		border-radius: 8px;
		background: var(--fill);
		color: var(--text-muted);
		text-align: left;
		transition: background-color 120ms ease-out;
	}
	.search:hover {
		background: var(--hover);
	}
	.search span {
		flex: 1;
	}
	.search svg {
		width: 14px;
		height: 14px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
	}
	.search kbd {
		color: var(--text-faint);
	}
	.scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 0 8px 12px;
	}
	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 28px;
		margin: 10px 2px 2px 10px;
	}
	h2 {
		margin: 0;
		font-size: 11.5px;
		font-weight: 600;
		color: var(--text-muted);
	}
	.icon-btn.small {
		width: 24px;
		height: 24px;
	}
	.icon-btn.small svg {
		width: 14px;
		height: 14px;
	}
	.place-main {
		display: grid;
		grid-template-columns: 8px minmax(0, 1fr) auto;
		align-items: center;
		gap: 10px;
		width: 100%;
		min-height: 44px;
		padding: 5px 10px;
		border-radius: 8px;
		text-align: left;
		transition: background-color 120ms ease-out;
	}
	.place-main:hover {
		background: var(--hover);
	}
	/* The open session's place says so in words; only the session row is filled, so one thing reads as selected. */
	.place.here .here-mark {
		color: var(--text);
	}
	.place-text {
		display: grid;
		min-width: 0;
	}
	.name {
		font-weight: 600;
		font-size: 13px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.sub {
		font-size: 11.5px;
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.sub.attention {
		color: var(--bad);
	}
	.sign-in {
		height: 22px;
		padding: 0 9px;
		display: inline-flex;
		align-items: center;
		border-radius: 11px;
		background: var(--primary-bg);
		color: var(--primary-fg);
		font-size: 11.5px;
		font-weight: 600;
	}
	.devices {
		display: block;
		width: calc(100% - 16px);
		margin: 0 8px 4px;
		padding: 4px 10px 4px 28px;
		border-radius: 6px;
		text-align: left;
		font-size: 12px;
		font-weight: 600;
		color: var(--text);
	}
	.devices:hover {
		background: var(--hover);
	}
	.here-mark {
		font-size: 11px;
		color: var(--text-muted);
	}
	.filter {
		width: calc(100% - 20px);
		margin: 0 10px 6px;
		height: 26px;
		padding: 0 8px;
		border: 0;
		border-radius: 6px;
		background: var(--fill);
		font-size: 12.5px;
		outline: none;
	}
	.filter:focus {
		box-shadow: 0 0 0 2px var(--focus-inner);
	}
	.project + .project {
		margin-top: 8px;
	}
	.project-name {
		display: flex;
		align-items: center;
		gap: 7px;
		height: 26px;
		padding: 0 4px 0 10px;
		font-weight: 600;
		font-size: 12px;
		color: var(--text-muted);
		white-space: nowrap;
	}
	.project-label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.project-more {
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		border-radius: 6px;
		color: var(--text-muted);
		opacity: 0;
	}
	.project-more svg {
		width: 14px;
		height: 14px;
		fill: currentColor;
	}
	.project-name:hover .project-more,
	.project-more:focus-visible {
		opacity: 1;
	}
	.project-more:hover {
		background: var(--hover);
		color: var(--text);
	}
	@media (hover: none) {
		.project-more {
			opacity: 1;
		}
	}
	.project-name svg {
		width: 14px;
		height: 14px;
		flex: none;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.4;
		stroke-linejoin: round;
	}
	.project-name span {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.session {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
		width: 100%;
		height: 30px;
		padding: 0 10px 0 31px;
		border-radius: 7px;
		text-align: left;
		transition: background-color 120ms ease-out;
	}
	.session:hover {
		background: var(--hover);
	}
	/* The mark left of the title says where a session runs: a lab's sessions carry its color as a small dot, and the
	   open session's mark grows into a bar, so place and selection read in one spot without competing badges. */
	.session {
		position: relative;
	}
	.session.away::before,
	.session.current::before {
		content: "";
		position: absolute;
		left: 16px;
		top: calc(50% - 2.5px);
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--mark);
		transition: height 160ms var(--ease-out), top 160ms var(--ease-out), border-radius 160ms var(--ease-out);
	}
	.session.current {
		background: var(--selected);
		font-weight: 600;
	}
	.session.current::before {
		top: 8px;
		height: 14px;
		width: 3px;
		left: 17px;
		border-radius: 2px;
	}
	@media (prefers-reduced-motion: reduce) {
		.session::before {
			transition: none;
		}
	}
	.session.current .when {
		color: var(--text-muted);
	}
	.session .title {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.rename {
		width: 100%;
		height: 30px;
		padding: 0 10px 0 30px;
		border: 0;
		border-radius: 7px;
		background: var(--canvas);
		box-shadow: inset 0 0 0 2px var(--focus-inner);
		font-size: 13px;
		outline: none;
	}
	.when {
		font-size: 11.5px;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	.live {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--live);
	}
	.more {
		height: 26px;
		padding: 0 10px 0 31px;
		font-size: 12px;
		color: var(--text-muted);
	}
	.more:hover {
		color: var(--text);
	}
	.empty {
		margin: 4px 10px;
		color: var(--text-muted);
		font-size: 12.5px;
	}
	.foot {
		display: flex;
		gap: 2px;
		padding: 8px;
		border-top: 1px solid var(--rule);
	}
	.foot-btn {
		flex: 1;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		height: 30px;
		border-radius: 7px;
		font-size: 12.5px;
		color: var(--text-muted);
		transition: background-color 120ms ease-out, color 120ms ease-out;
	}
	.foot-btn:hover {
		background: var(--hover);
		color: var(--text);
	}
	.foot-btn svg {
		width: 15px;
		height: 15px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.scrim {
		display: none;
	}
	@media (max-width: 860px) {
		.wide-only {
			display: none;
		}
		.rail,
		.rail.hidden {
			display: flex;
			position: fixed;
			inset: 0 auto 0 0;
			z-index: 50;
			width: min(320px, 86vw);
			transform: translateX(-102%);
			transition: transform 220ms var(--ease-out);
			background: var(--canvas);
			border-right: 1px solid var(--rule);
		}
		.rail.open {
			transform: none;
		}
		.scrim {
			display: block;
			position: fixed;
			inset: 0;
			z-index: 49;
			background: rgb(0 0 0 / 0.32);
		}
	}
</style>
