<script lang="ts">
	import { onMount } from "svelte";
	import { z } from "zod";
	import { runSchema, type Run } from "./contract.ts";
	let runs = $state<Run[]>([]), after = $state<string | null>(null), error = $state(""), loading = $state(true);
	const request = new AbortController();
	async function more() {
		loading = true; error = "";
		try {
			const qs = new URLSearchParams({ limit:"50" }); if (after) qs.set("after", after);
			const response = await fetch("/v1/runs?"+qs, { signal:request.signal, credentials:"same-origin", redirect:"error", cache:"no-store" });
			if (!response.ok) throw Error();
			const page = z.object({runs:z.array(runSchema), next:z.string().nullable()}).parse(await response.json());
			const seen = new Set(runs.map(r => r.id));
			runs = [...runs, ...page.runs.filter(r => !seen.has(r.id))]; after = page.next;
		} catch { if (!request.signal.aborted) error = "This lab could not return your runs."; }
		finally { if (!request.signal.aborted) loading = false; }
	}
	onMount(() => { void more(); return () => request.abort(); });
</script>
<main><a href="/">EnrichedLab</a><h1>Research runs</h1>
	{#if error}<p role="alert">{error}</p><button onclick={more}>Try again</button>{/if}
	{#if loading}<p role="status">Opening runs…</p>{/if}
	{#if !error && !loading && !runs.length}<p>No research runs are available to your account.</p>{/if}
	<ul>{#each runs as run (run.id)}<li><a href={"/runs/"+run.id}>{run.title ?? run.id}</a><span>{run.status}</span></li>{/each}</ul>
	{#if !error && after}<button disabled={loading} onclick={more}>Load more</button>{/if}
</main>
<style>
	main { height:100dvh; overflow:auto; padding:clamp(1.2rem,6vw,5rem); } h1 { color:var(--prompt); }
	ul { max-width:52rem; list-style:none; padding:0; } li { border-top:1px solid var(--rule); display:flex; gap:1rem; justify-content:space-between; align-items:center; }
	a,button { display:inline-flex; align-items:center; min-height:44px; color:var(--link); } span { color:var(--text-faint); }
</style>
