<script lang="ts">
	import { onMount, tick } from "svelte";
	import { z } from "zod";
	import Artifact from "./Artifact.svelte";
	import { budgetPath, eventSchema, project, readDeliveryView, readRunSnapshot, runPath, runSchema, type Run, type RunEvent, type View } from "./contract.ts";
	let { id }: { id: string } = $props();
	let run = $state<Run>(), view = $state<View>(), error = $state(""), connection = $state("");
	let action = $state<"messages" | "budget" | "stop" | undefined>(), text = $state(""), minutes = $state<number>();
	let sending = $state(false), notice = $state(""), theme = $state("system");
	let opened = $state<number>(), loading = $state(true);
	let steeringForm = $state<HTMLFormElement>(), statusNotice = $state<HTMLParagraphElement>();
	let steeringTrigger: HTMLButtonElement | undefined;
	const terminal = $derived(!!run && ["finished", "failed", "stopped"].includes(run.status));
	const time = (s: string) => new Intl.DateTimeFormat(undefined, { dateStyle:"medium", timeStyle:"short" }).format(new Date(s));
	function applyTheme(value: string) {
		theme = value;
		if (value === "system") delete document.documentElement.dataset.theme;
		else document.documentElement.dataset.theme = value;
	}
	function chooseTheme(value: string) {
		applyTheme(value);
		try { localStorage.setItem("enrichedlab.run.theme", value); } catch { /* Browser storage may be disabled. */ }
	}
	onMount(() => {
		try { applyTheme(localStorage.getItem("enrichedlab.run.theme") ?? "system"); } catch { applyTheme("system"); }
		const request = new AbortController();
		let stream: EventSource | undefined, entries: RunEvent[] = [];
		let refreshTimer: ReturnType<typeof setInterval> | undefined, refreshing = false;
		async function load() {
			try {
				const base = runPath(id);
				const options: RequestInit = { signal:request.signal, credentials:"same-origin", cache:"no-store", redirect:"error" };
				const snapshot = await readRunSnapshot(id, options);
				const current = snapshot.summary;
				entries = snapshot.entries;
				if (request.signal.aborted) return;
				run = current; view = snapshot.view;
				const refresh = async () => {
					if (refreshing || request.signal.aborted) return;
					refreshing = true;
					try {
						const reply = await fetch(base, options);
						if ([401,403,404].includes(reply.status)) {
							stream?.close(); clearInterval(refreshTimer); entries=[]; run=undefined; view=undefined;
							error="The lab no longer allows this run to be opened."; return;
						}
						if (!reply.ok) return;
						const latest = runSchema.parse(await reply.json());
						if (request.signal.aborted) return;
						if (latest.id !== id) {
							stream?.close(); clearInterval(refreshTimer); entries=[]; run=undefined; view=undefined;
							error="The lab returned another run."; return;
						}
						if (["finished","failed","stopped"].includes(latest.status) && !terminal) {
							try {
								const completed = await readDeliveryView(latest, options);
								if (request.signal.aborted) return;
								entries = completed.entries; run = latest; view = completed.view;
								stream?.close(); connection = ""; action = undefined;
							} catch {
								if (request.signal.aborted) return;
								stream?.close(); clearInterval(refreshTimer);
								entries = []; run = undefined; view = undefined; action = undefined;
								error = "The final delivery log could not be verified. Reload the run to check again.";
							}
							return;
						}
						run = latest; view = project(latest, entries);
						if (["finished","failed","stopped"].includes(latest.status)) action = undefined;
					} catch { /* The event stream still retries on a temporary network failure. */ }
					finally { refreshing = false; }
				};
				refreshTimer = setInterval(() => void refresh(), 30000);
				if (["finished","failed","stopped"].includes(current.status)) return;
				stream = new EventSource(base+"/events");
				stream.onopen = () => { connection = ""; void refresh(); };
				stream.onerror = () => { connection = "Reconnecting to the run…"; };
				stream.onmessage = m => {
					try {
						const event = eventSchema.parse(JSON.parse(m.data));
						if (event.seq <= entries.length) return;
						if (event.seq !== entries.length+1 || entries.length >= 20000) throw Error();
						entries.push(event);
						view = project(run ?? current, entries);
						notice = "";
					} catch { stream?.close(); error = "The run log changed unexpectedly. Reload to read it again."; }
				};
			} catch (e) {
				if (!request.signal.aborted) error = e instanceof z.ZodError ? "The lab returned an unreadable run record." : e instanceof Error ? e.message : "Could not open the run.";
			} finally { if (!request.signal.aborted) loading = false; }
		}
		void load();
		return () => { request.abort(); clearInterval(refreshTimer); stream?.close(); };
	});
	function closeSteering() {
		const trigger = steeringTrigger;
		steeringTrigger = undefined;
		action = undefined;
		void tick().then(() => {
			if (action) return;
			if (trigger?.isConnected && !trigger.disabled) trigger.focus();
			else statusNotice?.focus();
		});
	}
	async function select(next: NonNullable<typeof action>, trigger: HTMLButtonElement) {
		if (sending) return;
		if (action === next) { closeSteering(); return; }
		steeringTrigger = trigger;
		action = next;
		notice = "";
		if (action === "budget") minutes = view?.minutes;
		await tick();
		if (action === next) {
			const first = next === "stop" ? 'button[type="button"]' : "textarea, input";
			steeringForm?.querySelector<HTMLElement>(first)?.focus();
		}
	}
	function handleEscape(event: KeyboardEvent) {
		if (event.key === "Escape" && action && !sending && !event.defaultPrevented &&
			(event.target === steeringTrigger || (event.target instanceof Node && steeringForm?.contains(event.target)))) {
			event.preventDefault();
			closeSteering();
		}
	}
	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!run || !action || terminal || view?.stopping || sending) return;
		const grant = run["x-steering"], base = runPath(run.id);
		let path: string | undefined, body: object;
		if (action === "messages" && grant?.messages && text.trim()) { path = base+"/messages"; body = { text:text.trim() }; }
		else if (action === "stop" && grant?.stop) { path = base+"/stop"; body = {}; }
		else if (action === "budget" && minutes !== undefined && Number.isSafeInteger(minutes) && minutes > 0) {
			path = budgetPath(run); body = { minutes };
		} else return;
		if (!path) return;
		sending = true; notice = "";
		try {
			const response = await fetch(path,{ method:"POST", credentials:"same-origin", redirect:"error",
				headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) });
			if (!response.ok) throw Error();
			notice = "Request received. The run log records the change.";
			text = "";
			closeSteering();
		} catch { notice = "The change could not be confirmed. Check the event history before retrying."; }
		finally { sending = false; }
	}
</script>
<svelte:window onkeydown={handleEscape} />
<svelte:head><title>{run?.title ?? "Research run"} · EnrichedLab</title></svelte:head>
<main class="run-page">
	<header><a href="/runs">Research runs</a><label>Appearance <select value={theme} onchange={e => chooseTheme(e.currentTarget.value)}>
		<option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label></header>
	{#if error}<p role="alert">{error}</p><button onclick={() => location.reload()}>Reload run</button>
	{:else if loading}<p role="status">Opening run…</p>
	{:else if run && view}
	<article>
		<p class="state">{view.stopping && !terminal ? "Stop requested" : run.status}</p>
		<h1>{view.objective}</h1>
		{#if view.step}<section class="open-step"><h2>Open step</h2><p>{view.step}</p></section>{/if}
		{#if !terminal}
			<div class="controls" aria-label="Run controls">
				{#if run["x-steering"]?.messages}<button disabled={view.stopping || sending} aria-expanded={action==="messages"} onclick={e => select("messages", e.currentTarget)}>Add direction</button>{/if}
				{#if budgetPath(run)}<button disabled={view.stopping || sending} aria-expanded={action==="budget"} onclick={e => select("budget", e.currentTarget)}>Change budget{view.minutes ? " · "+view.minutes+" min" : ""}</button>{/if}
				{#if run["x-steering"]?.stop}<button disabled={view.stopping || sending} aria-expanded={action==="stop"} onclick={e => select("stop", e.currentTarget)}>Stop run</button>{/if}
			</div>
			{#if action}<form bind:this={steeringForm} onsubmit={submit}>
				{#if action==="messages"}<label>Direction for the next step<textarea bind:value={text} required maxlength="2000" rows="3"></textarea></label>
				{:else if action==="budget"}<label>Run budget in minutes<input bind:value={minutes} type="number" min="1" step="1" required /></label>
				{:else}<p>Request a stop at the next safe boundary? Delivered versions will remain available.</p>{/if}
				<div class="controls"><button class="primary" disabled={sending}>{action==="messages"?"Send direction": action==="budget"?"Save budget":"Request stop"}</button>
				<button type="button" disabled={sending} onclick={closeSteering}>Cancel</button></div>
			</form>{/if}
		{/if}
		<p class="notice" role="status" tabindex="-1" bind:this={statusNotice}>{notice || connection}</p>
		<section class="versions"><h2>Delivered versions</h2>
		{#if !view.versions.length}<p>The first version is still pending.</p>{/if}
		{#each view.versions as version (version.n)}
			<div class="version">
				<h3><button aria-expanded={opened===version.n} aria-controls={"version-"+version.n} onclick={() => {opened=opened===version.n?undefined:version.n;}}>
				<span class="n">v{version.n}</span><span>{version.milestone}</span><span class="indicator" aria-hidden="true">{opened===version.n?"−":"+"}</span></button></h3>
				<time datetime={version.time}>{time(version.time)}</time>
				<div id={"version-"+version.n} hidden={opened!==version.n}>
					{#if opened===version.n}
						{#if version.note}<p>{version.note}</p>{/if}
						{#each version.artifacts as item (item.uri+item.sha256)}<Artifact {item} />{/each}
						<details><summary>Verification receipt</summary><code>{version.receipt}</code></details>
					{/if}
				</div>
			</div>
		{/each}</section>
		{#if view.activity.length}<section class="history"><h2>Run history</h2><ol>{#each view.activity as item (item.seq)}
			<li><time datetime={item.time}>{time(item.time)}</time><span>{item.text}</span></li>{/each}</ol></section>{/if}
	</article>{/if}
</main>
<style>
	.run-page { height:100dvh; overflow:auto; background:var(--canvas); color:var(--text); padding:0 max(1.1rem,4vw) 4rem; }
	header,article { max-width:58rem; margin:auto; } header { display:flex; align-items:center; justify-content:space-between; min-height:4rem; border-bottom:1px solid var(--rule); }
	header a { font-weight:650; color:var(--prompt); } header label { color:var(--text-faint); font-size:.8rem; }
	select,input,textarea { background:var(--canvas); color:var(--text); font:inherit; } select { min-height:44px; border:0; }
	article { padding:clamp(1.5rem,5vw,4rem) 0; } h1,h2,h3,p { margin:0; } h1 { max-width:24ch; font-size:clamp(2rem,4.6vw,3.75rem); letter-spacing:-.045em; line-height:1.05; color:var(--prompt); }
	h2,.state { font-size:.82rem; font-weight:640; color:var(--text-muted); } .state { margin-bottom:.7rem; text-transform:capitalize; }
	.open-step { margin:1.9rem 0 1rem; border-inline-start:3px solid var(--accent); padding:.15rem 0 .15rem .85rem; }
	.open-step p { margin-top:.32rem; font-size:1.04rem; } .controls { display:flex; gap:.25rem 1.1rem; flex-wrap:wrap; }
	button,summary { min-height:44px; color:var(--link); font:inherit; cursor:pointer; } button:disabled { cursor:default; opacity:.6; }
	form { margin:.5rem 0; padding:1rem 0; border-block:1px solid var(--rule); } form label { display:grid; gap:.4rem; }
	textarea,input { border:1px solid var(--edge); padding:.55rem; max-width:100%; } textarea { width:min(38rem,100%); } input { width:8rem; }
	form .controls { margin-top:.55rem; } .primary { background:var(--primary-bg); color:var(--primary-fg); padding:0 .9rem; border-radius:.35rem; }
	.notice:not(:empty) { margin:.8rem 0; } .versions,.history { margin-top:2.2rem; } .versions h2,.history h2 { margin-bottom:.75rem; }
	.version { position:relative; border-top:1px solid var(--rule); padding:.4rem 0 1.05rem 3.1rem; }
	h3 button { width:100%; display:grid; grid-template-columns:1fr auto; align-items:center; text-align:left; font-size:clamp(1.12rem,2vw,1.5rem); font-weight:590; color:var(--text); }
	.n { position:absolute; left:0; font: .93rem ui-monospace, monospace; color:var(--accent-text); } .indicator { padding-inline:.35rem; color:var(--text-faint); }
	time,code { font: .79rem ui-monospace,monospace; color:var(--text-faint); } code { overflow-wrap:anywhere; }
	.version p { margin:1rem 0 .4rem; } summary { display:list-item; align-content:center; width:fit-content; } .history ol { list-style:none; padding:0; }
	.history li { display:grid; grid-template-columns:12rem 1fr; align-items:baseline; gap:.35rem 1rem; padding:.65rem 0; border-top:1px solid var(--rule); }
	:where(button,a,summary,input,select,textarea):focus-visible { outline:2px solid var(--focus-inner); outline-offset:2px; }
	@media(max-width:38rem){ .history li { grid-template-columns:1fr; } .version { padding-left:2.25rem; } }
</style>
