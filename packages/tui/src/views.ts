// The run sheet in a terminal: the person's prompts set heavier, the agent's prose as Markdown, and every tool call
// as one ruled step line on a rail with its result at the right edge. Steps open in place (Ctrl+O), never in a modal.

import { type Component, Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { PermissionRequest, SessionEvent, SessionStatus, StepView } from "@enrichedlab/protocol";
import type { Theme } from "./theme.ts";

type Ev<T extends SessionEvent["t"]> = Extract<SessionEvent, { t: T }>;

const INDENT = "  ";

/** A component whose lines depend only on width (and a few flags it reads at render time). */
export class Lines implements Component {
	private cache?: { width: number; key: string; lines: string[] };
	constructor(
		private draw: (width: number) => string[],
		private key: () => string = () => "",
	) {}
	render(width: number): string[] {
		const key = this.key();
		if (this.cache && this.cache.width === width && this.cache.key === key) return this.cache.lines;
		const lines = this.draw(width).map((l) => truncateToWidth(l, width));
		this.cache = { width, key, lines };
		return lines;
	}
	invalidate(): void {
		this.cache = undefined;
	}
}

function wrap(text: string, width: number, style: (t: string) => string, indent = INDENT): string[] {
	const out: string[] = [];
	for (const raw of text.split("\n")) {
		const lines = wrapTextWithAnsi(raw, Math.max(10, width - visibleWidth(indent)));
		for (const line of lines.length ? lines : [""]) out.push(indent + style(line));
	}
	return out;
}

export function promptView(t: Theme, text: string, queued = false): Component {
	return new Lines((width) => {
		const lines = wrap(text, width - 2, t.prompt, "");
		return ["", ...lines.map((l, i) => (i === 0 ? `${t.promptMark("›")} ${l}` : `  ${l}`)), ...(queued ? [t.faint("  queued")] : [])];
	});
}

export function answerView(t: Theme, event: Ev<"assistant">, expanded: () => boolean): Component {
	const markdown = event.text ? new Markdown(event.text.trim(), 2, 0, t.markdown, { color: t.text }) : undefined;
	return {
		render(width) {
			const lines: string[] = [];
			if (event.reasoning) {
				const seconds = event.ms ? ` for ${(event.ms / 1000).toFixed(0)}s` : "";
				if (expanded()) {
					lines.push("", `${INDENT}${t.faint(`Reasoning${seconds}`)}`);
					lines.push(...wrap(event.reasoning.trim(), width, (s) => t.italic(t.faint(s)), `${INDENT}  `));
				}
			}
			if (markdown) lines.push("", ...markdown.render(width));
			if (event.stop === "error") lines.push(`${INDENT}${t.bad("✗")} ${t.bad(truncateToWidth(event.error ?? "The request failed.", width - 6))}`);
			if (event.stop === "cancelled") lines.push(`${INDENT}${t.faint("cancelled")}`);
			return lines.map((l) => truncateToWidth(l, width));
		},
		invalidate() {
			markdown?.invalidate();
		},
	};
}

/** One step line: the rail, the verb, the target, and the result at the right edge. */
export function stepLine(t: Theme, view: StepView, state: "ok" | "failed" | "denied" | "running" | "waiting", width: number, elapsed?: string): string {
	const mark = state === "ok" ? t.ok("✓") : state === "running" ? t.live("●") : state === "waiting" ? t.live("▲") : state === "denied" ? t.muted("■") : t.bad("✗");
	const verb = t.verb(view.verb.padEnd(7));
	const right = [view.result ?? (state === "running" ? "running" : state === "waiting" ? "waiting for you" : ""), elapsed].filter(Boolean).join(" · ");
	const rightText = right ? `${t.muted(right)} ${mark}` : mark;
	const rail = `${INDENT}${t.rule("│")} `;
	const room = width - visibleWidth(rail) - visibleWidth(verb) - 1 - visibleWidth(rightText) - 2;
	const target = truncateToWidth(view.target.replace(/\s+/g, " "), Math.max(8, room));
	const gap = Math.max(1, width - visibleWidth(rail) - visibleWidth(verb) - 1 - visibleWidth(target) - visibleWidth(rightText));
	return `${rail}${verb} ${target}${" ".repeat(gap)}${rightText}`;
}

function detailLines(t: Theme, view: StepView, width: number, max: number): string[] {
	const out: string[] = [];
	const pad = `${INDENT}${t.rule("│")}   `;
	if (view.diff) {
		const body = view.diff.split("\n").filter((l) => !l.startsWith("---") && !l.startsWith("+++"));
		for (const line of body.slice(0, max)) {
			const style = line.startsWith("+") ? t.added : line.startsWith("-") ? t.removed : line.startsWith("@@") ? t.faint : t.muted;
			out.push(pad + style(truncateToWidth(line, width - visibleWidth(pad))));
		}
		if (body.length > max) out.push(pad + t.faint(`… ${body.length - max} more lines (Ctrl+O)`));
	} else if (view.detail) {
		const body = view.detail.replace(/\s+$/, "").split("\n");
		for (const line of body.slice(-max)) out.push(pad + t.faint(truncateToWidth(line, width - visibleWidth(pad))));
		if (body.length > max) out.unshift(pad + t.faint(`… ${body.length - max} earlier lines (Ctrl+O)`));
	}
	return out;
}

export function toolView(t: Theme, event: Ev<"tool">, expanded: () => boolean): Component {
	return new Lines(
		(width) => {
			const view: StepView = event.view ?? { verb: event.name, target: "" };
			const state = event.decision === "denied" ? "denied" : event.ok ? "ok" : "failed";
			const lines = [stepLine(t, view, state, width)];
			const open = expanded();
			if (view.diff) lines.push(...detailLines(t, view, width, open ? 400 : 8));
			else if (open || !event.ok) lines.push(...detailLines(t, view, width, open ? 200 : 6));
			return lines;
		},
		() => String(expanded()),
	);
}

export function noticeView(t: Theme, event: Ev<"notice">): Component {
	return new Lines((width) => {
		const mark = event.level === "error" ? t.bad("✗") : event.level === "warn" ? t.live("▲") : t.muted("·");
		return wrap(event.text, width - 2, event.level === "error" ? t.bad : t.muted, "").map((l, i) => (i === 0 ? `${INDENT}${mark} ${l}` : `${INDENT}  ${l}`));
	});
}

const TIPS = [
	"Esc stops the agent; type while it works and your message joins after the current step.",
	"/undo puts back what the last turn changed, shell commands included in a git repository.",
	"el --worktree gives a session its own git branch, away from your checkout.",
	"el app opens this session in the desktop window: tables, plots, a browser and a terminal beside it.",
	"Ctrl+O opens a step's output or diff.",
	"The agent keeps notes on each project with remember; they live in ~/.el/memory.",
];

/** The opening lines of a new session: name, where work runs, the labs, what's new, and the day's tip. */
export function welcomeView(t: Theme, info: { version: string; place: string; labs: string[]; news: string[] }): Component {
	const tip = TIPS[Math.floor(Date.now() / 86_400_000) % TIPS.length]!;
	const row = (label: string, text: string) => `${INDENT}${t.muted(label.padEnd(9))}${text}`;
	return new Lines((width) => {
		const room = Math.max(20, width - INDENT.length - 9);
		// Long text breaks between words; past `max` lines the last one ends with an ellipsis instead of mid-word.
		const clip = (text: string, max: number, style: (s: string) => string = (s) => s) => {
			const lines = wrapTextWithAnsi(text, room);
			const kept = lines.slice(0, max);
			if (lines.length > max) kept[max - 1] = `${kept[max - 1]!.replace(/\s+\S*$/, "")}…`;
			return kept.map(style);
		};
		const labelled = (label: string, lines: string[]) => lines.map((line, i) => `${INDENT}${t.muted((i ? "" : label).padEnd(9))}${line}`);
		const latest = info.news[0];
		// The name and version sit in the header above; the news line says which version is new.
		return [
			"",
			row("Runs on", info.place),
			...(info.labs.length ? [row("Labs", info.labs.join(t.muted("  ·  ")))] : []),
			...(latest ? labelled("New", clip(latest, 2)) : [row("Version", info.version)]),
			...labelled("Tip", clip(tip, 2, t.muted)),
		];
	});
}

/** The session's model: a row in the opening lines, and a line of its own when it changes later. */
export function modelView(t: Theme, model: string, effort?: string, origin?: string): Component {
	const [provider, ...rest] = model.split("/");
	const name = rest.length ? rest.join("/") : model;
	const from = origin ?? (rest.length ? provider : "");
	return new Lines(() => [`${INDENT}${t.muted("Model".padEnd(9))}${t.text(name)}${t.muted(`${from ? `  ${from}` : ""}${effort ? ` · ${effort}` : ""}`)}`]);
}

export function ruleView(t: Theme, label: string): Component {
	return new Lines((width) => {
		const text = ` ${label} `;
		const side = Math.max(2, Math.floor((width - visibleWidth(text) - 4) / 2));
		return ["", `${INDENT}${t.rule("─".repeat(side))}${t.muted(text)}${t.rule("─".repeat(side))}`];
	});
}

/** What is happening right now: reasoning, the answer so far, calls being written, tools running. */
export class LiveView implements Component {
	reasoning = "";
	text = "";
	calls: { index: number; name: string; args: string }[] = [];
	running = new Map<string, { view: StepView; started: number; output: string; waiting: boolean }>();
	queued: string[] = [];
	private markdown?: Markdown;
	private markdownText = "";

	constructor(private t: Theme) {}

	reset(): void {
		this.reasoning = "";
		this.text = "";
		this.calls = [];
		this.markdown = undefined;
		this.markdownText = "";
	}

	render(width: number): string[] {
		const t = this.t;
		const lines: string[] = [];
		if (this.reasoning && !this.text) {
			const tail = this.reasoning.trimEnd().split("\n").slice(-2).join(" ");
			lines.push("", `${INDENT}${t.faint(t.italic(truncateToWidth(tail.slice(-width * 2), width - 4)))}`);
		}
		if (this.text) {
			if (!this.markdown) this.markdown = new Markdown("", 2, 0, t.markdown, { color: t.text });
			if (this.markdownText !== this.text) {
				this.markdown.setText(this.text);
				this.markdownText = this.text;
			}
			lines.push("", ...this.markdown.render(width));
		}
		for (const call of this.calls) {
			lines.push(stepLine(t, { verb: call.name || "…", target: preview(call.args) }, "running", width, "writing"));
		}
		for (const run of this.running.values()) {
			const elapsed = `${Math.floor((Date.now() - run.started) / 1000)}s`;
			lines.push(stepLine(t, run.view, run.waiting ? "waiting" : "running", width, run.waiting ? undefined : elapsed));
			if (run.output && !run.waiting) {
				const pad = `${INDENT}${t.rule("│")}   `;
				for (const line of run.output.replace(/\s+$/, "").split("\n").slice(-4)) lines.push(pad + t.faint(truncateToWidth(line, width - visibleWidth(pad))));
			}
		}
		for (const q of this.queued) lines.push(`${t.faint("› ")}${t.faint(truncateToWidth(q, width - 12))} ${t.faint("queued")}`);
		return lines.map((l) => truncateToWidth(l, width));
	}

	invalidate(): void {
		this.markdown?.invalidate();
	}
}

/** Show the useful part of arguments still streaming: a path or command if one has appeared. */
function preview(args: string): string {
	const match = /"(path|command|pattern|url|title|query)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(args);
	return match ? match[2].replace(/\\n/g, " ").replace(/\\"/g, '"') : "";
}

export function permissionView(t: Theme, request: PermissionRequest, waiting = 0): Component {
	return new Lines((width) => {
		const lines = ["", `${INDENT}${t.live("▲")} ${t.bold(`Allow ${request.tool}?`)}${request.view.unreviewed ? ` ${t.bold("[unreviewed]")}` : ""}  ${t.muted(request.reason)}`];
		const target = request.view.target || "";
		for (const line of target.split("\n").slice(0, 6)) lines.push(`${INDENT}  ${t.code(truncateToWidth(line, width - 6))}`);
		const detail = (request.view.diff ?? request.view.detail ?? "").replace(/\s+$/, "").split("\n").filter((l) => l && !l.startsWith("---") && !l.startsWith("+++"));
		for (const line of detail.slice(0, 14)) {
			const style = line.startsWith("+") ? t.added : line.startsWith("-") ? t.removed : t.muted;
			lines.push(`${INDENT}    ${style(truncateToWidth(line, width - 8))}`);
		}
		if (detail.length > 14) lines.push(`${INDENT}    ${t.faint(`… ${detail.length - 14} more lines`)}`);
		const folder = request.folder?.split(/[\\/]/).filter(Boolean).at(-1);
		const session = folder ? `   ${t.bold("a")} ${t.muted(`allow changes in “${folder}” from now on`)}` : request.once ? "" : `   ${t.bold("a")} ${t.muted(`allow ${request.scope ?? "this kind of step"} this session`)}`;
		lines.push(`${INDENT}  ${t.bold("y")} ${t.muted("allow once")}${session}   ${t.bold("n")} ${t.muted("decline")}${waiting ? t.faint(`   ${waiting} more waiting`) : ""}`);
		return lines;
	});
}

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));

export function statusLine(t: Theme, status: SessionStatus | undefined, extra: { site?: string; started?: number; cwd: string }, width: number): string {
	if (!status) return t.faint(`${INDENT}connecting…`);
	const active = status.activity !== "idle";
	const words: Record<string, string> = { idle: "ready", thinking: "thinking", writing: "writing", tool: "working", waiting: "waiting for you", compacting: "compacting", retrying: "retrying" };
	const elapsed = active && extra.started ? ` ${Math.floor((Date.now() - extra.started) / 1000)}s` : "";
	const activity = `${active ? t.live("●") : t.muted("○")} ${t.text(words[status.activity] ?? status.activity)}${t.muted(elapsed)}${status.detail && status.activity !== "writing" ? t.faint(` · ${truncateToWidth(status.detail, 40)}`) : ""}`;
	const g = status.context;
	const left = Math.max(0, Math.round((1 - g.used / g.threshold) * 100));
	const contextText = `${g.estimated ? "~" : ""}${left}% left · ${fmtTokens(g.used)} of ${fmtTokens(g.threshold)}`;
	const contextStyled = left < 15 ? t.bad(contextText) : left < 35 ? t.live(contextText) : t.muted(contextText);
	// OpenAI asks apps to say when requests use the person's ChatGPT plan (manage it at chatgpt.com/settings/usage).
	const plan = status.model.startsWith("chatgpt/") ? " · ChatGPT plan" : "";
	const model = `${status.model.split("/").pop()}${status.effort ? ` · ${status.effort}` : ""}${plan}`;
	const rate = status.rate ? t.faint(` · ${status.rate} tok/s`) : "";
	const leftPart = `${INDENT}${activity}`;
	const site = extra.site ? `  ${t.faint(extra.site)}` : "";
	// Drop the least important parts first when the line is narrow.
	for (const rightPart of [`${t.muted(model)}${rate}  ${contextStyled}${site}`, `${t.muted(model)}  ${contextStyled}${site}`, `${t.muted(model)}  ${contextStyled}`, contextStyled]) {
		const gap = width - visibleWidth(leftPart) - visibleWidth(rightPart) - 1;
		if (gap >= 2) return `${leftPart}${" ".repeat(gap)}${rightPart}`;
	}
	return truncateToWidth(`${leftPart}  ${contextStyled}`, width);
}
