// What the model sees, derived from the log and nothing else. Two logged decisions change it: an `elide` event
// replaces old large outputs with one line and a handle, and a `compaction` event replaces older turns with a
// summary. Between those points the history only grows, so prompt caches stay warm and Anthropic thinking blocks
// stay valid. Each point is an edit: it resets the cache and the thinking blocks before it are no longer replayed
// (dropping a leading run is allowed; editing the middle is not). The runtime makes these edits where a turn starts,
// never inside a tool round unless the hard limit forces a summary.

import type { SessionEvent, ContextGauge } from "@enrichedlab/protocol";
import type { Msg } from "../models/types.ts";
import { estimateTokens } from "../util.ts";

export const SUMMARY_PREFIX =
	"Earlier in this session the conversation was summarized to save context. The summary below replaces it; files, " +
	"tool state and anything on disk are as the earlier work left them.";

/** Outputs this large or larger get a handle and can be elided later. */
export const ELIDE_MIN_CHARS = 2_048;
/** Outputs this large are stored whole and only their head and tail go inline. */
export const INLINE_MAX_CHARS = 24_000;
/** Turns kept intact when eliding. */
const ELIDE_KEEP_TURNS = 3;

type Ev<T extends SessionEvent["t"]> = Extract<SessionEvent, { t: T }>;

export interface Derived {
	messages: Msg[];
	/** Index in the log of the latest elide or compaction, or -1. Assistant events before it don't replay reasoning data. */
	checkpoint: number;
	/** Log indexes of the events that produced `messages`, in order (for compaction cut points). */
	sources: number[];
}

export function elisionStub(event: Ev<"tool">): string {
	const kb = (event.content.length / 1024).toFixed(1);
	return `[Earlier output of ${event.name} elided to save context (${kb} KB). recall with handle "${event.handle}" returns it.]`;
}

function conversational(e: SessionEvent): e is Ev<"user"> | Ev<"assistant"> | Ev<"tool"> | Ev<"undo"> | Ev<"rewind"> | Ev<"place"> | Ev<"app_context"> | Ev<"discovery"> {
	return e.t === "user" || e.t === "assistant" || e.t === "tool" || e.t === "undo" || e.t === "rewind" || e.t === "place" || e.t === "app_context" || e.t === "discovery";
}

export function derive(events: SessionEvent[]): Derived {
	let compactionAt = -1;
	let checkpoint = -1;
	const elided = new Set<string>();
	events.forEach((e, i) => {
		if (e.t === "compaction") {
			compactionAt = i;
			checkpoint = i;
		} else if (e.t === "elide") {
			checkpoint = i;
			for (const id of e.ids) elided.add(id);
		}
	});

	const indexes: number[] = [];
	if (compactionAt >= 0) {
		const compaction = events[compactionAt] as Ev<"compaction">;
		const keptFrom = events.findIndex((e) => e.id === compaction.firstKeptId);
		if (keptFrom >= 0 && keptFrom < compactionAt) for (let i = keptFrom; i < compactionAt; i++) indexes.push(i);
		for (let i = compactionAt + 1; i < events.length; i++) indexes.push(i);
	} else {
		for (let i = 0; i < events.length; i++) indexes.push(i);
	}

	const messages: Msg[] = [];
	const sources: number[] = [];
	if (compactionAt >= 0) {
		const compaction = events[compactionAt] as Ev<"compaction">;
		messages.push({ role: "user", content: [{ type: "text", text: `${SUMMARY_PREFIX}\n\n${compaction.summary}` }] });
		sources.push(compactionAt);
	}

	// Tool calls that never got a result (a crash or a cancel the log didn't finish) get one, so every provider
	// sees each call answered.
	let open: Map<string, string> | undefined;
	const closeOpen = (at: number) => {
		if (!open) return;
		for (const [callId, name] of open) {
			messages.push({ role: "tool", callId, name, content: "This call did not finish (cancelled or interrupted)." });
			sources.push(at);
		}
		open = undefined;
	};

	// Notes that wait for a tool round to finish before the model reads them.
	const notes: { text: string; at: number }[] = [];
	// An app's context counts only at its newest since the person's last message.
	const staleContext = new Set<number>();
	const seen = new Set<string>();
	for (let k = indexes.length - 1; k >= 0; k--) {
		const e = events[indexes[k]!]!;
		if (e.t === "user") seen.clear();
		else if (e.t === "app_context") {
			if (seen.has(e.app)) staleContext.add(indexes[k]!);
			seen.add(e.app);
		}
	}

	for (const i of indexes) {
		const e = events[i];
		if (!conversational(e)) continue;
		if (e.t === "user") {
			closeOpen(i);
			messages.push({ role: "user", content: [{ type: "text", text: e.text }, ...(e.images ?? [])] });
		} else if (e.t === "undo") {
			closeOpen(i);
			const text = `(The person undid your changes since their last message. These files are back as they were before: ${e.files.join(", ")}.${e.all ? "" : " Changes made by shell commands were not undone."})`;
			messages.push({ role: "user", content: [{ type: "text", text }] });
		} else if (e.t === "rewind") {
			closeOpen(i);
			const files = [...e.restored, ...e.removed];
			const text = `(The person put the folder back as it was before one of your earlier steps. ${files.length ? `These files changed: ${files.slice(0, 40).join(", ")}${files.length > 40 ? `, and ${files.length - 40} more` : ""}.` : "No files differed."} Work from the files as they are now.)`;
			messages.push({ role: "user", content: [{ type: "text", text }] });
		} else if (e.t === "app_context") {
			if (staleContext.has(i)) continue;
			closeOpen(i);
			messages.push({ role: "user", content: [{ type: "text", text: `(The app "${e.title}" is open beside the conversation. It reports: ${e.text})` }] });
		} else if (e.t === "discovery") {
			const text = e.on
				? "(The person turned on Discovery mode: work through the task on your own, step by step, until it is done. Don't stop to ask unless you are blocked or need a decision only they can make. Your commands, file changes and lab tool calls in the lab run without approval; anything on their computer still asks. Check each result before you build on it, and keep notes of what you did and why in the project.)"
				: "(Discovery mode is off. Commands that change things ask the person first again.)";
			// Turned on or off mid-turn: the note waits until the open calls are answered.
			if (open?.size) {
				notes.push({ text, at: i });
				continue;
			}
			messages.push({ role: "user", content: [{ type: "text", text }] });
		} else if (e.t === "place") {
			if (e.initial) continue;
			closeOpen(i);
			const carried = e.carried ? " The repository came along, uncommitted work included." : "";
			const text = `(The person moved this session. Your file, search and shell tools now act in ${e.label}; paths are relative to ${e.root}.${carried})`;
			messages.push({ role: "user", content: [{ type: "text", text }] });
		} else if (e.t === "assistant") {
			closeOpen(i);
			if (!e.text && !e.toolCalls?.length && !e.reasoning) continue;
			messages.push({
				role: "assistant",
				text: e.text,
				reasoning: e.reasoning,
				reasoningData: i > checkpoint ? e.reasoningData : undefined,
				toolCalls: e.toolCalls,
			});
			if (e.toolCalls?.length) open = new Map(e.toolCalls.map((c) => [c.id, c.name]));
		} else {
			open?.delete(e.callId);
			const content = elided.has(e.id) && e.handle ? elisionStub(e) : e.content;
			messages.push({ role: "tool", callId: e.callId, name: e.name, content, images: elided.has(e.id) ? undefined : e.images });
		}
		sources.push(i);
		if (notes.length && !open?.size) {
			for (const note of notes.splice(0)) {
				messages.push({ role: "user", content: [{ type: "text", text: note.text }] });
				sources.push(note.at);
			}
		}
	}
	// A call still open at the end is either running now or was cut off; only the second needs an answer, and the
	// loop never derives context while its own calls run.
	closeOpen(events.length);
	return { messages, checkpoint, sources };
}

export function messageTokens(m: Msg): number {
	if (m.role === "user") return m.content.reduce((n, p) => n + (p.type === "text" ? estimateTokens(p.text) : 1_000), 4);
	if (m.role === "assistant") {
		return 4 + estimateTokens(m.text) + estimateTokens(m.reasoning ?? "") + (m.toolCalls ?? []).reduce((n, c) => n + estimateTokens(c.args) + 8, 0);
	}
	return 4 + estimateTokens(m.content) + (m.images?.length ?? 0) * 1_000;
}

export interface Budget {
	window: number;
	threshold: number;
	elideAt: number;
}

/** Where to elide and compact. The reserve keeps room for the next answer: 15% of the window, at least 8k tokens,
 * at most half the window. `compactAt` from config caps the threshold (tokens, or a fraction of the window). */
export function budget(window: number, compactAt?: number): Budget {
	const reserve = Math.min(Math.max(Math.round(window * 0.15), 8_192), Math.round(window / 2));
	let threshold = window - reserve;
	if (compactAt) threshold = Math.min(threshold, compactAt <= 1 ? Math.round(window * compactAt) : compactAt);
	return { window, threshold, elideAt: Math.round(threshold * 0.6) };
}

/**
 * Tokens the next request will carry. The provider's count of the last request (prompt plus its answer) is exact;
 * anything appended since is estimated. A checkpoint after that request means the count no longer applies.
 */
export function gauge(events: SessionEvent[], derived: Derived, fixedTokens: number, b: Budget, modelRef?: string): ContextGauge {
	let lastUsage = -1;
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e.t === "assistant" && e.usage && e.usage.input > 0) {
			// Another model counts tokens with another tokenizer and system prompt: estimate instead.
			if (!modelRef || e.model === modelRef) lastUsage = i;
			break;
		}
	}
	if (lastUsage >= 0 && lastUsage > derived.checkpoint) {
		const usage = (events[lastUsage] as Ev<"assistant">).usage!;
		let used = usage.input + usage.output;
		derived.sources.forEach((source, k) => {
			if (source > lastUsage) used += messageTokens(derived.messages[k]);
		});
		return { used, threshold: b.threshold, window: b.window, estimated: false };
	}
	const used = fixedTokens + derived.messages.reduce((n, m) => n + messageTokens(m), 0);
	return { used, threshold: b.threshold, window: b.window, estimated: true };
}

/** Tool events worth eliding: large, not already elided, older than the last few turns. */
export function elisionCandidates(events: SessionEvent[]): Ev<"tool">[] {
	const elided = new Set<string>();
	let compactionAt = -1;
	events.forEach((e, i) => {
		if (e.t === "elide") for (const id of e.ids) elided.add(id);
		if (e.t === "compaction") compactionAt = i;
	});
	const userIndexes = events.map((e, i) => (e.t === "user" ? i : -1)).filter((i) => i >= 0);
	// The last few turns stay whole; with only that many turns, nothing is old enough yet.
	const keepFrom = userIndexes.length > ELIDE_KEEP_TURNS ? userIndexes[userIndexes.length - ELIDE_KEEP_TURNS]! : (userIndexes[0] ?? 0);
	const out: Ev<"tool">[] = [];
	events.forEach((e, i) => {
		// A recall answer is already a page of a stored output; stubbing it would send the model in circles.
		if (e.t === "tool" && e.name !== "recall" && i < keepFrom && i > compactionAt && e.handle && !elided.has(e.id) && e.content.length >= ELIDE_MIN_CHARS) out.push(e);
	});
	return out;
}

/**
 * Where to cut for a compaction: the earliest point that keeps about `keep` tokens of the most recent work intact,
 * at a user message, or at an assistant step inside the current turn when one turn is the whole history. Returns
 * the position in `derived.messages` of the first kept message, or undefined when nothing can be summarized.
 */
export function cutPoint(events: SessionEvent[], derived: Derived, keep: number): number | undefined {
	const { messages, sources } = derived;
	const start = messages.length && sources[0] !== undefined && events[sources[0]]?.t === "compaction" ? 1 : 0;
	const userCuts: number[] = [];
	const stepCuts: number[] = [];
	for (let k = start + 1; k < messages.length; k++) {
		if (messages[k].role === "user" && events[sources[k]]?.t === "user") userCuts.push(k);
		else if (messages[k].role === "assistant") stepCuts.push(k);
	}
	let tail = 0;
	const tailFrom = new Array<number>(messages.length + 1).fill(0);
	for (let k = messages.length - 1; k >= 0; k--) {
		tail += messageTokens(messages[k]);
		tailFrom[k] = tail;
	}
	const last = userCuts.at(-1);
	// The current turn alone is too big to keep whole: cut inside it, at the first step that leaves at most 2x keep.
	if (last !== undefined && tailFrom[last]! > keep * 2) {
		const inside = stepCuts.filter((k) => k > last && tailFrom[k]! <= keep * 2);
		if (inside.length) return inside[0];
	}
	// Otherwise a turn boundary: the latest one whose tail still holds at least `keep` tokens. When the whole
	// history is smaller than that, summarize everything before the current turn and keep the turn whole.
	const eligible = userCuts.filter((k) => tailFrom[k]! >= keep);
	if (eligible.length) return eligible[eligible.length - 1];
	if (last !== undefined) return last;
	const inside = stepCuts.filter((k) => tailFrom[k] <= keep * 2);
	return inside.length ? inside[0] : stepCuts.length > 1 ? stepCuts[stepCuts.length - 1] : undefined;
}
