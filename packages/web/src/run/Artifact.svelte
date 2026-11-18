<script lang="ts">
	import { onDestroy } from "svelte";
	import { readArtifact, type Artifact } from "./contract.ts";
	let { item }: { item: Artifact } = $props();
	let message = $state(""), url = $state(""), lines = $state<string[][]>([]), loading = $state(false);
	let request: AbortController | undefined;
	const isImage = $derived(["image/png", "image/jpeg", "image/webp"].includes(item.mime));
	const isTable = $derived(item.mime === "text/tab-separated-values");
	async function open() {
		loading = true;
		message = "";
		request = new AbortController();
		try {
			const blob = await readArtifact(item, request.signal);
			if (request.signal.aborted) return;
			if (isTable && blob.size <= 512_000) {
				lines = (await blob.text()).trimEnd().split(/\r?\n/).slice(0, 21).map(row => row.split("\t").slice(0, 12));
			}
			if (!request.signal.aborted) url = URL.createObjectURL(blob);
		} catch (e) { if (!request.signal.aborted) message = e instanceof Error ? e.message : "Could not open the artifact."; }
		finally { loading = false; }
	}
	onDestroy(() => { request?.abort(); if (url) URL.revokeObjectURL(url); });
</script>
<div class="artifact">
	{#if !url}<button onclick={open} disabled={loading}>{loading ? "Checking artifact…" : "Open " + item.name}</button>{:else}
		{#if isImage}<img src={url} alt={item.name} />{/if}
		{#if lines.length}
			<div class="table-scroll"><table><caption>{item.name}</caption><thead><tr>{#each lines[0] as cell}<th scope="col">{cell}</th>{/each}</tr></thead>
				<tbody>{#each lines.slice(1) as row}<tr>{#each row as cell}<td>{cell}</td>{/each}</tr>{/each}</tbody></table></div>
			<small>Preview up to 20 rows and 12 columns</small>
		{/if}
		<a href={url} download={item.name}>Download {item.name}</a>
	{/if}
	{#if message}<p role="alert">{message}</p>{/if}
</div>
<style>
	.artifact { margin:.55rem 0; }
	button,a { display:inline-flex; align-items:center; min-height:44px; color:var(--link); text-decoration:underline; text-underline-offset:.2em; }
	img { display:block; max-width:100%; max-height:28rem; object-fit:contain; }
	.table-scroll { overflow:auto; } table { border-collapse:collapse; font-variant-numeric:tabular-nums; }
	caption { text-align:left; font-weight:600; } th,td { text-align:left; border-bottom:1px solid var(--rule); padding:.5rem .9rem .5rem 0; }
	small { display:block; color:var(--text-faint); }
</style>
