<script lang="ts">
	import type { PermissionRequest } from "@enrichedlab/protocol";
	import { lab } from "../lib/store.svelte.ts";

	let { request }: { request: PermissionRequest } = $props();
	let root: HTMLElement | undefined = $state();
	let full = $state(false);
	const lines = $derived(
		(request.view.diff ?? request.view.detail ?? "")
			.replace(/\s+$/, "")
			.split("\n")
			.filter((l) => l && !l.startsWith("---") && !l.startsWith("+++")),
	);
	const detail = $derived(full ? lines : lines.slice(0, 40));
	// The oldest waiting request is the one the keys answer; the others wait their turn.
	const first = $derived(lab.pending[0]?.requestId === request.requestId);
	$effect(() => {
		// Focus comes to the request itself, never to Allow, so a stray Return can't approve anything.
		if (first && (document.activeElement === document.body || !document.activeElement)) root?.focus({ preventScroll: true });
	});
	function key(e: KeyboardEvent) {
		if (!first || e.repeat || e.metaKey || e.ctrlKey || e.altKey || lab.covered) return;
		// Single keys answer only while focus is on the page or in this request, never while typing elsewhere.
		const at = document.activeElement;
		if (at && at !== document.body && !root?.contains(at)) return;
		const k = e.key.toLowerCase();
		if (k === "y") void lab.answer(request.requestId, "allow");
		else if (k === "a" && request.folder) void lab.answer(request.requestId, "allow_folder");
		else if (k === "a" && !request.once) void lab.answer(request.requestId, "allow_session");
		else if (k === "n") void lab.answer(request.requestId, "deny");
		else return;
		e.preventDefault();
	}
</script>

<svelte:window onkeydown={key} />

<section class="approval" bind:this={root} tabindex="-1" aria-label={`Allow ${request.tool}?`}>
	<p class="ask"><strong>Allow {request.tool}?</strong>{#if request.view.unreviewed}<span class="unreviewed">Unreviewed</span>{/if} <span>{request.reason}</span></p>
	{#if request.view.target}
		<pre class="target">{request.view.target}</pre>
	{/if}
	{#if detail.length}
		<pre class="detail">{#each detail as line}<span class:add={line.startsWith("+")} class:del={line.startsWith("-")}>{line}
</span>{/each}</pre>
		{#if lines.length > 40}
			<button class="more" onclick={() => (full = !full)}>{full ? "Show less" : `Show all ${lines.length} lines`}</button>
		{/if}
	{/if}
	<div class="actions">
		<button class="secondary" onclick={() => lab.answer(request.requestId, "deny")}>Decline <kbd>N</kbd></button>
		{#if request.folder}
			<!-- From now on, in every session: file changes in this folder run without asking, each kept in history. -->
			<button class="secondary" title={`From now on, in every session: file changes in ${request.folder} run without asking. Each one is kept in history.`} onclick={() => lab.answer(request.requestId, "allow_folder")}>Allow changes in “{request.folder.split(/[\\/]/).filter(Boolean).at(-1)}” <kbd>A</kbd></button>
		{:else if !request.once}
			<button class="secondary" title={`For the rest of this session, ${request.scope ?? "this kind of step"} run without asking.`} onclick={() => lab.answer(request.requestId, "allow_session")}>Allow {request.scope ?? "this kind of step"} this session <kbd>A</kbd></button>
		{/if}
		<button class="primary" onclick={() => lab.answer(request.requestId, "allow")}>Allow once <kbd>Y</kbd></button>
	</div>
</section>

<style>
	.approval {
		margin: 6px 0 14px 18px;
		padding: 12px 14px;
		border: 1px solid var(--rule-strong);
		border-radius: var(--radius);
		background: var(--raised);
		box-shadow: var(--shadow);
		animation: reveal 200ms var(--ease-out);
		overflow: hidden;
	}
	.approval:focus-visible {
		outline: 2px solid var(--focus-inner);
		outline-offset: 2px;
	}
	.more {
		margin: -2px 0 8px;
		font-size: 12px;
		color: var(--link);
	}
	.ask {
		margin: 0 0 8px;
		font-size: 14px;
	}
	.ask span {
		color: var(--text-muted);
		font-size: 13px;
		margin-left: 4px;
	}
	pre {
		margin: 0 0 10px;
		padding: 8px 10px;
		border-radius: 7px;
		background: var(--code-bg);
		font-size: 12.5px;
		line-height: 1.5;
		overflow-x: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		max-height: 300px;
		overflow-y: auto;
	}
	.detail {
		white-space: pre;
		font-size: 12px;
		color: var(--text-muted);
	}
	.add {
		color: var(--added);
	}
	.del {
		color: var(--removed);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		flex-wrap: wrap;
		gap: 8px;
	}
	.actions button {
		min-height: 34px;
		padding: 6px 14px;
		border-radius: 8px;
		font-size: 13.5px;
		font-weight: 500;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		transition: background 120ms, transform 80ms;
	}
	.actions button:active {
		transform: scale(0.98);
	}
	.secondary {
		background: var(--hover);
	}
	.secondary:hover {
		background: var(--selected);
	}
	.primary {
		background: var(--primary-bg);
		color: var(--primary-fg);
	}
	/* A key cap in the button's own color, so it reads on the filled Allow as well as the plain buttons. */
	kbd {
		display: inline-grid;
		place-items: center;
		min-width: 18px;
		height: 18px;
		margin-left: 2px;
		padding: 0 4px;
		border-radius: 4px;
		box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 40%, transparent);
		color: inherit;
		font: 600 10.5px var(--font-ui);
		opacity: 0.85;
	}
	@keyframes reveal {
		from {
			opacity: 0;
			clip-path: inset(0 0 100% 0);
		}
	}
	@media (max-width: 560px) {
		.approval {
			margin-left: 0;
		}
		kbd {
			display: none;
		}
		.actions button {
			flex: 1;
			justify-content: center;
		}
	}
	/* Text and a rule in the text colors, not a tinted badge: the word carries the meaning. */
	.unreviewed {
		margin-left: 8px;
		padding: 0 6px;
		border: 1px solid var(--rule-strong);
		border-radius: 4px;
		font-size: 11.5px;
		font-weight: 600;
		color: var(--text);
	}
</style>
