// One live session: the agent loop, steering, cancel, permissions, context management and fan-out to surfaces.
//
// A turn is one or more steps. A step is one model request plus the tool calls it made. Read-only calls in a step
// run together; anything that changes state runs in order. A message sent while a turn runs joins the next step.

import type {
	Activity,
	Notifications,
	Partial_,
	Part,
	PermissionDecision,
	PermissionRequest,
	SessionEvent,
	SessionStatus,
	SessionSummary,
	StepView,
	ToolCall,
	Usage,
} from "@enrichedlab/protocol";
import type { LabConfig, PermissionMode } from "../config.ts";
import { adapterFor, type ModelRegistry, whereOf } from "../models/registry.ts";
import { ModelHttpError, type ModelProfile, type ToolSchema } from "../models/types.ts";
import { Checkpoints } from "./checkpoint.ts";
import { changedSince, restoreSnapshot } from "../git.ts";
import { runHooks } from "../hooks.ts";
import { projectRoot } from "../prompt.ts";
import { findSkills, type Skill, skillDirs, skillTool } from "../skills.ts";
import { DEFER_ABOVE, findTools, foundNames, offered } from "../catalog.ts";
import { builtinSkillsDir } from "../builtin_skills.ts";
import type { AgentResult } from "../tools/agents.ts";
import { dirname, join } from "node:path";
import { type History, localHistory, type Snapshot, sandboxHistory, storeFor } from "./history.ts";
import { canonical, decide } from "../permissions.ts";
import type { CanvasPublisher, Tool, ToolContext } from "../tools/types.ts";
import { ToolError } from "../tools/types.ts";
import { FULL_CONTAINMENT, type Workspace } from "../tools/workspace.ts";
import { SandboxWorkspace } from "../sites/sandbox_workspace.ts";
import { clip, errorText, estimateTokens, newId, now, redact, sleep } from "../util.ts";
import { summarize } from "./compaction.ts";
import { budget, cutPoint, derive, ELIDE_MIN_CHARS, elisionCandidates, gauge, INLINE_MAX_CHARS } from "./context.ts";
import { type SessionLog, type SessionMeta, toSummary } from "./log.ts";

const MAX_STEPS = 400;
/** Reasoning shorter than this reads well as it is. */
const SUMMARY_MIN_CHARS = 600;
const REASONING_SUMMARY_SYSTEM =
	"You summarize an AI agent's private reasoning for the scientist reviewing its work. Write one or two plain sentences, under 45 words, saying what the agent was working out and what it decided to do next. Name the files, tools, methods and numbers it relied on. No preamble, quotes or markdown.";
const MAX_ATTEMPTS = 5;
const DELTA_FLUSH_MS = 24;
const PARALLEL_KINDS = new Set(["read", "net", "site-read"]);
/** Tool kinds that may change the folder: a snapshot follows each step that used one. */
const CHANGES = new Set(["write", "exec", "sandbox", "packages"]);
/** Model names that say small and fast: mini, flash, haiku, nano, a few billion parameters (4b, 7b). */
const QUICK = /(^|[-_.:/\s])(mini|small|flash|lite|haiku|nano|fast|instant|tiny|turbo|[1-9](\.\d)?b)([-_.:/\s]|$)/i;
/** Models that don't chat. */
const NOT_CHAT = /embed|rerank|whisper|tts|transcribe|moderation|image|guard/i;

/**
 * The model that writes summaries for a session on `model`: the one chosen (`configured`), or else a fast one among
 * `all` (a lab's or a provider's small model), only in the same place, so a summary never goes anywhere the
 * session's model doesn't. On this computer the session's own model writes them: no second model loads beside it.
 */
export function pickHelper(model: ModelProfile, configured: ModelProfile | undefined, all: ModelProfile[], allows: (m: ModelProfile) => boolean): ModelProfile {
	const b = whereOf(model);
	const usable = (helper: ModelProfile | undefined): helper is ModelProfile => {
		if (!helper || helper.ref === model.ref || !allows(helper)) return false;
		const a = whereOf(helper);
		return a.kind === b.kind && a.name === b.name && (b.kind === "device" || b.kind === "network" || helper.provider === model.provider);
	};
	if (configured) return usable(configured) ? configured : model;
	if (b.kind === "device") return model;
	return all.find((helper) => QUICK.test(`${helper.id} ${helper.label}`) && !NOT_CHAT.test(`${helper.id} ${helper.label}`) && usable(helper)) ?? model;
}

export interface RuntimeDeps {
	config(): LabConfig;
	registry: ModelRegistry;
	/** Every tool a session can use right now: built-ins, MCP tools, and the tools of the sites it sees. */
	tools(site?: string): Tool[];
	/** Whether a session bound to `site` (or unbound) may use this model. */
	allows(model: ModelProfile, site?: string): boolean;
	/** Subagents: start a child session on a task, wait for children, stop a session's children. */
	spawn(parent: SessionRuntime, task: string, options: { mode: "read" | "full"; model?: string }): string;
	waitAgents(parent: string, agents: string[], timeoutMs: number, signal: AbortSignal): Promise<AgentResult[]>;
	/** True for a session bound to an isolated lab. */
	sealed?(site: string | undefined): boolean;
	/** What a lab says about this person: its title, their named grants, and whose agents may use its sandboxes. */
	lab?(site: string): { title: string; capabilities: string[]; sandboxAgents?: "lab" | "any" } | undefined;
	/** Apps for a tool call in this session: opening one in the workbench, showing an MCP server's view. */
	apps?(sessionId: string): ToolContext["apps"];
	surface?(sessionId: string): ToolContext["surface"];
	browser?(sessionId: string): ToolContext["browser"];
	cancelChildren(parent: string): void;
	canvas: CanvasPublisher;
	notify<N extends keyof Notifications>(name: N, params: Notifications[N]): void;
	ask(request: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision | "cancelled">;
	/** Let EnrichedLab change files in a folder from now on (the person answered allow_folder). */
	grantFolder?(folder: string): void;
	/** Where step history for folders on this computer is kept (`~/.el/history`). */
	historyRoot?: string;
	/** Where shared tools (pixi) are kept. */
	toolsDir?: string;
	/** A lab's vetted package sources (its descriptor's `packages`). */
	packageSources?: (site?: string) => { conda?: string[]; pypi?: string; only?: boolean } | undefined;
}

type Ev<T extends SessionEvent["t"]> = Extract<SessionEvent, { t: T }>;

export class SessionRuntime {
	readonly id: string;
	events: SessionEvent[];
	meta: SessionMeta;
	activity: Activity = "idle";
	private queue: { text: string; images?: Part[] }[] = [];
	private abort?: AbortController;
	private running?: Promise<void>;
	private allowed = new Set<string>();
	private partial: Partial_ = { text: "", reasoning: "", tools: [], output: {} };
	private pendingDelta: { kind: "text" | "reasoning"; text: string } | undefined;
	private deltaTimer?: ReturnType<typeof setTimeout>;
	private rate?: number;
	private detail?: string;
	readonly pending = new Map<string, PermissionRequest>();

	private checkpoints: Checkpoints;
	/** Steps whose reasoning waits for a summary, and the one being summarized now. */
	private toSummarize: Ev<"assistant">[] = [];
	private summarizing = false;

	private current: Workspace;
	/** Set while the session moves between places; prompts wait for the move to finish. */
	moving = false;
	/** What the last turn changed, worked out when it ends; undo offers to put these back. */
	private changed?: string[];
	/** The step history of the place the session works in now (docs/history.md). */
	private history?: History;
	private historyPlace?: Workspace;
	private historyOff = false;

	constructor(
		readonly log: SessionLog,
		workspace: Workspace,
		private deps: RuntimeDeps,
	) {
		this.current = workspace;
		this.checkpoints = new Checkpoints(join(log.dir, "checkpoints"));
		this.id = log.id;
		this.events = log.read();
		// "Allow for this session" answers outlast a restart: they're in the log.
		// They hold where they were given: a move to another place starts the answers over.
		for (const e of this.events) {
			if (e.t === "place") this.allowed.clear();
			else if (e.t === "allow") for (const key of e.keys) this.allowed.add(key);
		}
		this.meta = log.meta() ?? {
			id: log.id,
			cwd: workspace.root,
			title: "Session",
			created: this.events[0]?.at ?? now(),
			updated: now(),
			model: "",
			turns: 0,
		};
	}

	get system(): string {
		return this.header?.system ?? "";
	}

	/** The site this session is bound to, if any. */
	get site(): string | undefined {
		return this.header?.site;
	}

	/** Set when this session is a subagent. */
	get parent(): string | undefined {
		return this.header?.parent;
	}

	private get agentMode(): "read" | "full" | undefined {
		return this.header?.parent ? (this.header.mode ?? "read") : undefined;
	}

	/**
	 * Tools this session can use: a subagent can't start agents of its own; tools that work only on this computer
	 * aren't offered while it works in a lab (a model calls what it's offered); skills when the project has any.
	 */
	private visibleTools(): Tool[] {
		const local = this.place === "local";
		const visible = this.deps.tools(this.site).filter((t) => !(this.parent && t.name.startsWith("agent_")) && (local || !t.localOnly));
		const all = this.skills().length ? [...visible, this.skillTool] : visible;
		// Many tools: the agent searches for the ones it needs (catalog.ts).
		return all.length > DEFER_ABOVE ? [...all, this.findTool] : all;
	}

	private findTool = findTools(() => this.visibleTools());

	/** Tools the agent has found or used in this session, from its log: they stay in its requests. */
	private loadedTools(): Set<string> {
		const names = new Set<string>();
		for (const e of this.events) {
			if (e.t === "assistant") for (const call of e.toolCalls ?? []) names.add(call.name);
			else if (e.t === "tool" && e.name === "find_tools" && e.ok) for (const name of foundNames(e.content)) names.add(name);
		}
		return names;
	}

	private skillTool = skillTool(() => this.skills());
	private skillCache?: { at: number; skills: Skill[] };

	/** The person's and the project's skills, read again at most every 10 seconds. */
	skills(): Skill[] {
		if (!this.skillCache || Date.now() - this.skillCache.at > 10_000) {
			// Built-in skills first, so the person's and the project's skills of the same name replace them.
			let builtin: string[] = [];
			try {
				builtin = [builtinSkillsDir()];
			} catch {
				// An unwritable home: the session works without the built-in skills.
			}
			this.skillCache = { at: Date.now(), skills: findSkills([...builtin, ...skillDirs(this.deps.config().skills.dirs, projectRoot(this.cwd))]) };
		}
		return this.skillCache.skills;
	}

	/** The worktree EnrichedLab made for this session, as its record says. */
	get worktree(): { repo: string; path: string; branch: string } | undefined {
		return this.header?.worktree;
	}

	private get header(): Ev<"header"> | undefined {
		return this.events.find((e) => e.t === "header") as Ev<"header"> | undefined;
	}

	get modelRef(): string | undefined {
		for (let i = this.events.length - 1; i >= 0; i--) {
			const e = this.events[i];
			if (e.t === "model") return e.model;
		}
		return this.meta.model || undefined;
	}

	get effort(): string | undefined {
		for (let i = this.events.length - 1; i >= 0; i--) {
			const e = this.events[i];
			if (e.t === "model") return e.effort;
		}
		return undefined;
	}

	get isRunning(): boolean {
		return this.running !== undefined;
	}

	summary(): SessionSummary {
		return toSummary(this.meta, this.isRunning);
	}

	/** Where files and commands act now. */
	get workspace(): Workspace {
		return this.current;
	}

	/** The latest move: "local" or a site name, and what came along. */
	get placement(): Ev<"place"> | undefined {
		return [...this.events].reverse().find((e) => e.t === "place") as Ev<"place"> | undefined;
	}

	get place(): string {
		return this.placement?.place ?? "local";
	}

	/** The lab where the person turned Discovery mode on, while it's on. */
	get discovery(): string | undefined {
		const last = [...this.events].reverse().find((e) => e.t === "discovery") as Ev<"discovery"> | undefined;
		return last?.on ? last.site : undefined;
	}

	/** Discovery mode applies now: it's on, the session works at that lab, and the lab still grants it. */
	private get discovering(): string | undefined {
		const site = this.discovery;
		return site && site === this.place && this.deps.lab?.(site)?.capabilities.includes("discovery") ? site : undefined;
	}

	/** How much this session asks, when the person set it for this session. */
	get permissionMode(): PermissionMode | undefined {
		const last = [...this.events].reverse().find((e) => e.t === "permissions") as Ev<"permissions"> | undefined;
		return last?.mode;
	}

	/** Set how much this session asks; undefined returns it to the configured mode. */
	setPermissionMode(mode: PermissionMode | undefined): void {
		this.append({ t: "permissions", id: newId("e"), at: now(), ...(mode ? { mode } : {}) });
		this.touch({ permissions: mode });
	}

	/** Turn Discovery mode on or off; the engine checks the lab's grant before turning it on. */
	setDiscovery(on: boolean, site: string): void {
		this.append({ t: "discovery", id: newId("e"), at: now(), on, site });
		this.touch({ discovery: on ? site : undefined });
	}

	/** Reattach the place a reopened session last worked in (no event: it is already in the log). */
	useWorkspace(workspace: Workspace): void {
		this.current = workspace;
	}

	/** Act somewhere else from the next turn on. The model is told in its next request. */
	moveTo(workspace: Workspace, move: Omit<Ev<"place">, "t" | "id" | "at">): void {
		if (this.running) throw new Error("Wait for the current turn to finish, or cancel it.");
		this.current = workspace;
		this.allowed.clear();
		this.append({ t: "place", id: newId("e"), at: now(), ...move });
		this.touch({ place: move.place });
	}

	snapshot() {
		return { summary: this.summary(), events: this.events, status: this.status(), pending: [...this.pending.values()], partial: this.isRunning ? this.partial : undefined };
	}

	model(): ModelProfile | undefined {
		return this.deps.registry.resolve(this.modelRef) ?? undefined;
	}

	private toolSchemas(): ToolSchema[] {
		return offered(this.visibleTools(), this.loadedTools()).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
	}

	status(): SessionStatus {
		const model = this.model();
		const window = model?.context ?? 32_768;
		const b = budget(window, this.compactAt());
		const derived = derive(this.events);
		const fixed = estimateTokens(this.system) + estimateTokens(JSON.stringify(this.toolSchemas()));
		return {
			sessionId: this.id,
			activity: this.activity,
			model: this.modelRef ?? "",
			effort: this.effort ?? model?.defaultEffort,
			context: gauge(this.events, derived, fixed, b, this.modelRef),
			undoable: this.changed?.length ? this.changed : undefined,
			rate: this.rate,
			queued: this.queue.length,
			detail: this.detail,
		};
	}

	private compactAt(): number | undefined {
		const value = this.deps.config().compactAt;
		return typeof value === "number" && value > 0 ? value : undefined;
	}

	// ── Writing events ─────────────────────────────────────────────────────────────────────────────────────────────

	append(event: SessionEvent): void {
		this.log.append(event);
		this.events.push(event);
		this.deps.notify("session.event", { sessionId: this.id, event });
	}

	private setActivity(activity: Activity, detail?: string): void {
		this.activity = activity;
		this.detail = detail;
		this.deps.notify("session.status", this.status());
	}

	private touch(changes: Partial<SessionMeta> = {}): void {
		this.meta = { ...this.meta, ...changes, updated: now() };
		this.log.writeMeta(this.meta);
		this.deps.notify("session.updated", this.summary());
	}

	notice(level: "info" | "warn" | "error", text: string): void {
		this.append({ t: "notice", id: newId("e"), at: now(), level, text: redact(text) });
	}

	private delta(kind: "text" | "reasoning", text: string): void {
		if (kind === "text") this.partial.text += text;
		else this.partial.reasoning += text;
		if (this.pendingDelta && this.pendingDelta.kind !== kind) this.flushDelta();
		if (this.pendingDelta) this.pendingDelta.text += text;
		else this.pendingDelta = { kind, text };
		this.deltaTimer ??= setTimeout(() => this.flushDelta(), DELTA_FLUSH_MS);
	}

	private flushDelta(): void {
		if (this.deltaTimer) clearTimeout(this.deltaTimer);
		this.deltaTimer = undefined;
		const pending = this.pendingDelta;
		this.pendingDelta = undefined;
		if (pending?.text) this.deps.notify("session.delta", { sessionId: this.id, kind: pending.kind, text: pending.text });
	}

	// ── Controls ───────────────────────────────────────────────────────────────────────────────────────────────────

	setModel(model: string | undefined, effort: string | undefined): void {
		const ref = model ?? this.modelRef;
		if (!ref) throw new Error("Choose a model first.");
		const profile = this.deps.registry.resolve(ref);
		if (!profile) throw new Error(`No model named ${ref} is available.`);
		if (!this.deps.allows(profile, this.site)) {
			throw new Error(this.site ? `This session works with ${this.site}; ${profile.ref} belongs elsewhere.` : `${profile.ref} is only for sessions bound to ${profile.provider}.`);
		}
		const level = effort ?? (model && model !== this.modelRef ? profile.defaultEffort : this.effort);
		if (level && profile.efforts.length && !profile.efforts.includes(level)) {
			throw new Error(`${profile.id} takes reasoning levels ${profile.efforts.join(", ")}.`);
		}
		this.append({ t: "model", id: newId("e"), at: now(), model: profile.ref, effort: level });
		this.touch({ model: profile.ref });
		this.deps.notify("session.status", this.status());
	}

	prompt(text: string, images?: Part[]): { queued: boolean } {
		if (!text.trim() && !images?.length) throw new Error("The message is empty.");
		if (this.moving) throw new Error("The session is moving; send this once the move finishes.");
		this.queue.push({ text, images });
		if (this.running) {
			this.deps.notify("session.status", this.status());
			return { queued: true };
		}
		this.startDrain();
		return { queued: false };
	}

	private startDrain(): void {
		this.running = this.drain().finally(() => {
			this.running = undefined;
			this.setActivity("idle");
			// Summaries that waited for the turn (a model on this computer) go now.
			void this.pumpSummaries();
		});
	}

	/** Stop the turn. Messages still waiting to join it are handed back, never dropped. */
	cancel(): string[] {
		const waiting = this.queue.splice(0).map((m) => m.text);
		this.abort?.abort(new Error("Cancelled by the person."));
		this.deps.cancelChildren(this.id);
		this.deps.notify("session.status", this.status());
		return waiting;
	}

	/** Where the session stands, for a lead agent waiting on it. */
	result(): AgentResult {
		const last = [...this.events].reverse().find((e) => e.t === "assistant") as Ev<"assistant"> | undefined;
		const state = this.isRunning ? "running" : last?.stop === "error" ? "failed" : last?.stop === "cancelled" ? "cancelled" : "done";
		return { agent: this.id, state, answer: clip(last?.text ?? "", 20_000) };
	}

	/** The folder the session works in. */
	get cwd(): string {
		return this.header?.cwd ?? "";
	}

	/** What an open app reports (MCP Apps ui/update-model-context); the model reads the newest on its next request. */
	appContext(app: string, title: string, text: string): void {
		this.append({ t: "app_context", id: newId("e"), at: now(), app, title, text });
	}

	/**
	 * The configured summary model when it runs in the same place as `model` and this session may use it; otherwise
	 * `model` itself. Summaries carry the conversation, so they never go anywhere the session's model doesn't.
	 */
	private helperModel(model: ModelProfile): ModelProfile {
		const configured = this.deps.config().summaryModel;
		return pickHelper(model, configured ? this.deps.registry.resolve(configured) : undefined, configured ? [] : this.deps.registry.all(), (m) => this.deps.allows(m, this.site));
	}

	/**
	 * The files a step changed, from step history: between the point before it and the one its group of calls left.
	 * Calls that ran together share that point, so their changes come together (`with`).
	 */
	async stepFiles(id: string): Promise<{ files: string[]; with: number; history: boolean; commit?: string }> {
		const at = this.events.findIndex((e) => e.id === id);
		const step = this.events[at];
		if (!step || step.t !== "tool") return { files: [], with: 0, history: false };
		const after = this.events.slice(at).find((e): e is Ev<"checkpoint"> => e.t === "checkpoint" && !!e.history && (e.calls?.includes(step.callId) ?? false));
		const before = this.events.slice(0, at).findLast((e): e is Ev<"checkpoint"> => e.t === "checkpoint" && !!e.history);
		// No point after it: it changed nothing history saw. A move since: its history is where it was then.
		if (!before?.history) return { files: [], with: 1, history: false };
		if (!after?.history) return { files: [], with: 1, history: true };
		if (this.events.slice(this.events.indexOf(before)).some((e) => e.t === "place")) return { files: [], with: after.calls?.length ?? 1, history: false };
		const history = this.stepHistory();
		const files = history ? await history.changes(before.history, after.history).catch(() => []) : [];
		return { files, with: after.calls?.length ?? 1, history: !!history, commit: after.history };
	}

	/** Queue a step's reasoning for a reading summary (docs/research.md); the full text stays on the step. */
	private queueSummary(step: Ev<"assistant">): void {
		if (this.deps.config().reasoningSummaries === false || (step.reasoning?.trim().length ?? 0) < SUMMARY_MIN_CHARS) return;
		this.toSummarize.push(step);
		void this.pumpSummaries();
	}

	/**
	 * Summarize queued steps one at a time. A model on this computer usually serves one request at a time, so there
	 * the summaries wait until the turn ends instead of slowing it.
	 */
	private async pumpSummaries(): Promise<void> {
		if (this.summarizing || !this.toSummarize.length) return;
		this.summarizing = true;
		try {
			while (this.toSummarize.length) {
				// Each step's reasoning goes only where the model that wrote it runs: its helper is chosen for that step,
				// just before the request, never carried over from an earlier one.
				const step = this.toSummarize[0]!;
				const writer = this.deps.registry.resolve(step.model);
				if (!writer || !this.deps.allows(writer, this.site)) {
					this.toSummarize.shift();
					continue;
				}
				const helper = this.helperModel(writer);
				// A model on this computer serves one request at a time: wait for the turn to end.
				if (this.running && whereOf(helper).kind === "device") return;
				this.toSummarize.shift();
				const text = await this.summarizeReasoning(helper, step.reasoning ?? "").catch(() => "");
				if (text) this.append({ t: "reasoning_summary", id: newId("e"), at: now(), of: step.id, text, model: helper.ref });
			}
		} finally {
			this.summarizing = false;
		}
	}

	private async summarizeReasoning(model: ModelProfile, reasoning: string): Promise<string> {
		const body = reasoning.length > 16_000 ? `${reasoning.slice(0, 8_000)}\n[…]\n${reasoning.slice(-8_000)}` : reasoning;
		const quick = ["off", "none", "minimal", "low"].find((e) => model.efforts.includes(e)) ?? model.efforts[0];
		const request = {
			model,
			system: REASONING_SUMMARY_SYSTEM,
			messages: [{ role: "user" as const, content: [{ type: "text" as const, text: body }] }],
			tools: [],
			toolChoice: "none" as const,
			effort: quick,
			maxTokens: Math.min(1_024, model.maxOutput),
		};
		let text = "";
		for await (const event of adapterFor(model).stream(request, AbortSignal.timeout(90_000))) {
			if (event.type === "text") text += event.delta;
			if (event.type === "done" && event.stop === "error") return "";
		}
		return clip(text.trim().replace(/^["'“”*\s]+|["'“”*\s]+$/g, "").replace(/\s+/g, " "), 400);
	}

	/** One answer from the session's model, outside the conversation: an app's lab.ask(). */
	async ask(prompt: string, system: string | undefined, signal: AbortSignal): Promise<string> {
		const model = this.model() ?? this.fallbackModel();
		if (!model) throw new Error("This session has no model to ask.");
		const request = {
			model,
			system: system ?? "Answer the request from an app the person is using. Be brief and exact.",
			messages: [{ role: "user" as const, content: [{ type: "text" as const, text: prompt }] }],
			tools: [],
			toolChoice: "none" as const,
			effort: model.efforts.includes("low") ? "low" : model.efforts[0],
			maxTokens: Math.min(4_096, model.maxOutput),
		};
		let text = "";
		for await (const event of adapterFor(model).stream(request, signal)) {
			if (event.type === "text") text += event.delta;
			if (event.type === "done" && event.stop === "error") throw new Error(event.error ?? "The model request failed.");
		}
		return text.trim();
	}

	/** Files changed since the person's last message: from the step history, the turn's git snapshot, or file copies. */
	private async changesSinceUser(): Promise<string[]> {
		const since: Ev<"checkpoint">[] = [];
		for (let i = this.events.length - 1; i >= 0; i--) {
			const e = this.events[i]!;
			if (e.t === "user" || e.t === "undo" || e.t === "rewind") break;
			if (e.t === "checkpoint") since.unshift(e);
		}
		const start = since.find((c) => c.callId === "turn" && c.history)?.history;
		const last = since.findLast((c) => c.history)?.history;
		if (start && last) return start === last ? [] : this.stepHistory()?.changes(start, last).catch(() => []) ?? [];
		if (this.workspace.kind !== "local") return [];
		const git = since.find((c) => c.git)?.git;
		try {
			if (git) return changedSince(this.cwd, git);
		} catch {
			// Fall back to the per-file record.
		}
		return [...new Set(since.flatMap((c) => c.files.map((f) => this.workspace.display(f.path))))];
	}

	/** The step history of where the session works now: git here, or in the lab's sandbox through its shell. */
	private stepHistory(): History | undefined {
		const place = this.workspace;
		if (this.historyPlace !== place) {
			this.historyPlace = place;
			this.history =
				place.kind === "local"
					? localHistory(this.deps.historyRoot ?? join(dirname(dirname(this.log.dir)), "history"), canonical(place.root), this.id)
					: sandboxHistory((command) => place.exec(command, { timeoutMs: 120_000, signal: AbortSignal.timeout(130_000) }), place.root, this.id);
		}
		return this.historyOff ? undefined : this.history;
	}

	/** Where this session's step history is on this computer, for a run package; absent at a lab. */
	historyHandle(): { store: string; ref: string } | undefined {
		if (this.workspace.kind !== "local") return undefined;
		return { store: storeFor(this.deps.historyRoot ?? join(dirname(dirname(this.log.dir)), "history"), canonical(this.workspace.root)), ref: `refs/sessions/${this.id}` };
	}

	/** Keep the folder as it is now in the step history, as a point the person or the agent can go back to. */
	private async keepStep(label: string, callId: string, calls?: string[]): Promise<void> {
		const history = this.stepHistory();
		// A lab that checkpoints whole sandboxes keeps the whole disk too, changed in git's view or not, and goes on
		// doing so if git history fails.
		const sandbox = this.workspace instanceof SandboxWorkspace && this.workspace.checkpoints ? this.workspace : undefined;
		// A turn's start is marked even when nothing could be kept, so undo never takes an earlier turn's start for it.
		const mark = () => callId === "turn" && this.append({ t: "checkpoint", id: newId("e"), at: now(), callId, files: [] });
		if (!history && !sandbox) return void mark();
		let shot: Snapshot | undefined;
		if (history) {
			try {
				shot = await history.snapshot(label);
			} catch (error) {
				this.historyOff = true;
				this.notice("warn", `Step history is off for this session, so its steps can't be taken back: ${redact(errorText(error))}`);
			}
		}
		if (shot && !shot.changed && callId !== "turn" && !sandbox) return;
		const lab = sandbox ? await sandbox.checkpoint(label) : undefined;
		if (sandbox && !lab && !this.labCheckpointWarned) this.notice("warn", "The lab couldn't checkpoint the sandbox for this step, so commands outside the project ask until it can again.");
		if (sandbox) this.labCheckpointWarned = !lab;
		if (!shot && !lab) return void mark();
		// For showing: the commit itself names everything it left out (history.ts keptOut).
		const left = shot ? [...shot.skipped, ...shot.nested.map((path) => `${path}/ (its own repository)`)] : [];
		this.append({ t: "checkpoint", id: newId("e"), at: now(), callId, files: [], ...(shot ? { history: shot.commit } : {}), ...(lab ? { lab } : {}), ...(calls ? { calls } : {}), ...(left.length ? { skipped: left.slice(0, 200) } : {}) });
	}
	private labCheckpointWarned = false;

	/**
	 * Put the folder back as it was before a step (an event in the log): the newest history point before it. The present
	 * is kept first, so this can be taken back too. The model is told on its next request.
	 */
	async rewind(before: string, wholeSandbox = false): Promise<{ ok: boolean; files: string[]; detail: string; whole?: boolean }> {
		if (this.running) return { ok: false, files: [], detail: "Wait for the current turn to finish, or cancel it." };
		// Held like a turn while it works: no prompt or second rewind starts meanwhile.
		let release = () => {};
		this.running = new Promise<void>((done) => (release = done));
		try {
			return await this.goBack(before, wholeSandbox);
		} finally {
			this.running = undefined;
			release();
			if (this.queue.length) this.startDrain();
		}
	}

	/**
	 * By default the project folder goes back, from its own history. `wholeSandbox` puts a lab's whole sandbox back from
	 * its checkpoint, which the person chooses knowing it takes every folder there back, other sessions' too.
	 */
	private async goBack(before: string, wholeSandbox: boolean): Promise<{ ok: boolean; files: string[]; detail: string; whole?: boolean }> {
		const at = this.events.findIndex((e) => e.id === before);
		if (at < 0) return { ok: false, files: [], detail: "That step isn't in this session." };
		const chosen = this.events[at]!;
		// Going back from a go-back returns to the present it kept: a lab checkpoint or a history commit, as it says.
		const fromRewind = chosen.t === "rewind" ? chosen : undefined;
		if (fromRewind?.whole && !wholeSandbox) return { ok: false, files: [], detail: "That go-back put the whole sandbox back, so going back from it does too: choose Go Back the Whole Sandbox." };
		const found = fromRewind ? undefined : (this.events.slice(0, at).findLast((e) => e.t === "checkpoint" && (wholeSandbox ? e.lab : e.history)) as Ev<"checkpoint"> | undefined);
		const point: { history?: string; lab?: string; skipped?: string[] } | undefined = fromRewind ? (fromRewind.whole ? { lab: fromRewind.saved } : { history: fromRewind.saved }) : found;
		if (!point) return { ok: false, files: [], detail: "This session kept no history before that step." };
		if (wholeSandbox && !point.lab) return { ok: false, files: [], detail: "There's no whole-sandbox checkpoint before that step." };
		if (!wholeSandbox && !point.history) {
			const lab = this.events.slice(0, at).some((e) => e.t === "checkpoint" && e.lab);
			return { ok: false, files: [], detail: lab ? "The project's own history has nothing before that step; the lab kept a whole-sandbox checkpoint. Go Back the Whole Sandbox puts every folder there back, other sessions' projects included." : "This session kept no history before that step." };
		}
		// History belongs to the place it was kept in: a step before a move can't be brought back here.
		if (this.events.slice(found ? this.events.indexOf(found) : at).some((e) => e.t === "place")) return { ok: false, files: [], detail: "The session moved since that step; its history is where it was then." };
		try {
			// The whole sandbox at a lab that checkpoints it: the present is kept as a checkpoint first.
			const whole = this.workspace instanceof SandboxWorkspace ? this.workspace.checkpoints : undefined;
			if (wholeSandbox && point.lab && whole) {
				const saved = await whole.make(`before going back: ${before}`);
				await whole.restore(point.lab);
				this.append({ t: "rewind", id: newId("e"), at: now(), before, to: point.lab, saved, whole: true, restored: [], removed: [] });
				this.changed = undefined;
				return { ok: true, whole: true, files: [], detail: `The ${this.workspace.label.replace(/^the /, "")} is back as it was before that step.` };
			}
			if (wholeSandbox) return { ok: false, files: [], detail: "This sandbox can't use the lab's checkpoints now." };
			if (!point.history) return { ok: false, files: [], detail: "This session kept no history before that step." };
			const history = this.stepHistory();
			if (!history) return { ok: false, files: [], detail: "Step history is off for this session." };
			// Old points named what they left out only in the event; newer commits name it themselves.
			const back = await history.restore(point.history, `before ${before}`, point.skipped?.filter((path) => !path.endsWith(" (its own repository)")) ?? []);
			this.append({ t: "rewind", id: newId("e"), at: now(), before, to: point.history, saved: back.saved, restored: back.restored, removed: back.removed, ...(back.left.length ? { left: back.left.slice(0, 200) } : {}) });
			this.changed = undefined;
			const files = [...back.restored, ...back.removed];
			const kept = back.left.length ? ` ${back.left.length} left as ${back.left.length === 1 ? "it is" : "they are"}: too large to keep, or a folder holding such files.` : "";
			return { ok: true, files, detail: (files.length ? `Put back ${files.length} file${files.length === 1 ? "" : "s"} as they were before that step.` : "The files were already as they were before that step.") + kept };
		} catch (error) {
			return { ok: false, files: [], detail: `Couldn't go back: ${redact(errorText(error))}` };
		}
	}

	/** Put back the files this session changed since the person's last message (or the last undo). */
	async undo(): Promise<{ ok: boolean; files: string[]; detail: string }> {
		if (this.running) return { ok: false, files: [], detail: "Wait for the current turn to finish, or cancel it." };
		// With step history: back to the start of the last turn, shell changes included, here or at a lab. Only that
		// turn's own start counts: a turn whose history couldn't be kept never falls back to an earlier turn's.
		const own = this.events.findLast((e) => e.t === "checkpoint" && e.callId === "turn") as Ev<"checkpoint"> | undefined;
		if (own && !own.history && own.lab) return { ok: false, files: [], detail: "This turn was kept only as a whole-sandbox checkpoint. Go Back the Whole Sandbox, from a step's menu, puts every folder there back." };
		const start = own?.history ? own : undefined;
		const after = start ? this.events.slice(this.events.indexOf(start)) : [];
		if (start && !after.some((e) => e.t === "undo" || e.t === "rewind")) {
			// Moved since: the files are where it was then, and nothing here is touched.
			if (after.some((e) => e.t === "place")) return { ok: false, files: [], detail: "The session moved since your last message; its history is where it was then." };
			const first = after.find((e) => e.t !== "checkpoint");
			// Files changed outside the folder were kept one by one. They come back first, while every link in the folder
			// still leads where it did when they were kept (going back may change a link).
			// Records from before they named where their path led can't be checked that way, so they stay as they are.
			const outside = after.filter((e): e is Ev<"checkpoint"> => e.t === "checkpoint").map((e) => e.files.filter((f) => f.real !== undefined && !this.workspace.inside(f.path))).filter((files) => files.length);
			const put = outside.length ? this.checkpoints.restore(outside) : { restored: [], kept: [] };
			const elsewhere = put.restored.map((path) => this.workspace.display(path));
			const result: { ok: boolean; files: string[]; detail: string; whole?: boolean } = first ? await this.rewind(first.id) : { ok: false, files: [], detail: "" };
			if (!result.ok) {
				if (elsewhere.length) this.append({ t: "undo", id: newId("e"), at: now(), files: elsewhere, kept: put.kept });
				return { ok: elsewhere.length > 0, files: elsewhere, detail: `${result.detail}${elsewhere.length ? ` Put back outside the folder: ${elsewhere.join(", ")}.` : ""}`.trim() };
			}
			const files = [...result.files, ...elsewhere];
			if (!files.length && !result.whole) return { ok: false, files: [], detail: "Nothing changed since your last message." };
			this.append({ t: "undo", id: newId("e"), at: now(), files, all: true, ...(put.kept.length ? { kept: put.kept } : {}) });
			return { ok: true, files, detail: result.whole ? result.detail : `Restored ${files.length} file${files.length === 1 ? "" : "s"}: ${files.join(", ")}.` };
		}
		if (this.workspace.kind !== "local") return { ok: false, files: [], detail: "Undo works on this computer; in a lab sandbox, ask the agent to revert with git." };
		const changes: Ev<"checkpoint">["files"][] = [];
		for (let i = this.events.length - 1; i >= 0; i--) {
			const e = this.events[i]!;
			if (e.t === "undo" || e.t === "user") break;
			// Moved since these copies were kept: their paths are where it was then, and nothing there is touched.
			if (e.t === "place") return { ok: false, files: [], detail: "The session moved since your last message; its history is where it was then." };
			if (e.t === "checkpoint") changes.unshift(e.files);
		}
		// A git snapshot taken before the turn covers everything, shell changes included; otherwise the per-file copies.
		const turn = [...this.events].reverse().find((e, k, all) => e.t === "checkpoint" && e.git && !all.slice(0, k).some((x) => x.t === "user" || x.t === "undo")) as Ev<"checkpoint"> | undefined;
		if (turn?.git) {
			const files = restoreSnapshot(this.cwd, turn.git);
			if (!files.length) return { ok: false, files: [], detail: "Nothing changed since your last message." };
			this.append({ t: "undo", id: newId("e"), at: now(), files, all: true });
			this.changed = undefined;
			return { ok: true, files, detail: `Restored ${files.length} file${files.length === 1 ? "" : "s"}: ${files.join(", ")}.` };
		}
		if (!changes.length) return { ok: false, files: [], detail: "No file changes to undo since your last message." };
		const put = this.checkpoints.restore(changes);
		const files = put.restored.map((path) => this.workspace.display(path));
		this.append({ t: "undo", id: newId("e"), at: now(), files, ...(put.kept.length ? { kept: put.kept } : {}) });
		this.changed = undefined;
		return { ok: true, files, detail: `Restored ${files.length} file${files.length === 1 ? "" : "s"}: ${files.join(", ")}.` };
	}

	async compactNow(): Promise<{ ok: boolean; detail: string }> {
		if (this.running) return { ok: false, detail: "Wait for the current turn to finish, or cancel it." };
		const model = this.model();
		if (!model) return { ok: false, detail: "Choose a model first." };
		const controller = new AbortController();
		this.abort = controller;
		// Holds the session like a turn does: a message sent meanwhile waits in the queue and runs after.
		let done = false;
		const work = this.compact(model, controller.signal, true).then((ok) => {
			done = ok;
		});
		this.running = work.finally(() => {
			this.abort = undefined;
			this.running = undefined;
			if (this.queue.length) this.startDrain();
			else this.setActivity("idle");
		});
		await this.running;
		return { ok: done, detail: done ? "Compacted." : "Nothing old enough to summarize yet." };
	}

	// ── The loop ───────────────────────────────────────────────────────────────────────────────────────────────────

	private async drain(): Promise<void> {
		while (this.queue.length) {
			const next = this.queue.splice(0, this.queue.length);
			const controller = new AbortController();
			this.abort = controller;
			try {
				for (const message of next) this.appendUser(message);
				await this.keepStep(`start of turn ${this.meta.turns + 1}`, "turn");
				await this.turn(controller.signal);
			} catch (error) {
				if (!controller.signal.aborted) this.notice("error", errorText(error));
			} finally {
				this.abort = undefined;
				this.changed = await this.changesSinceUser();
				const first = this.meta.turns === 0;
				this.touch({ turns: this.meta.turns + 1 });
				if (first) this.naming = this.nameSession();
			}
		}
	}

	/** The title request after the first turn, so a one-off run can wait for it before exiting. */
	naming?: Promise<void>;

	/**
	 * After the first turn, the session's model names it in a few words. The first line of the request stays the title
	 * if the model can't, and a title the person set is never replaced.
	 */
	private async nameSession(): Promise<void> {
		const firstUser = this.events.find((e) => e.t === "user") as Ev<"user"> | undefined;
		const model = this.model() ?? this.fallbackModel();
		if (!firstUser || !model) return;
		const auto = clip(firstUser.text.trim().split("\n")[0] || "Session", 72);
		const quick = ["off", "none", "minimal", "low"].find((e) => model.efforts.includes(e)) ?? model.efforts[0];
		let text = "";
		try {
			const request = {
				model,
				system: "You name conversations so a person can find them again. Reply with the name only: 3 to 6 words, sentence case, file and product names written as they are, no quotes, no ending punctuation.",
				messages: [{ role: "user" as const, content: [{ type: "text" as const, text: `Name this conversation by what it's about:\n\n${clip(firstUser.text, 1_200)}` }] }],
				tools: [],
				toolChoice: "none" as const,
				effort: quick,
				maxTokens: Math.min(1_024, model.maxOutput),
			};
			for await (const event of adapterFor(model).stream(request, AbortSignal.timeout(45_000))) {
				if (event.type === "text") text += event.delta;
				if (event.type === "done" && event.stop === "error") return;
			}
		} catch {
			return;
		}
		const title = text.trim().split("\n")[0]!.replace(/^["'“”‘’`*#\s]+|["'“”‘’`*.!?:;\s]+$/g, "").trim();
		if (title.length < 3 || title.length > 70 || this.meta.title !== auto) return;
		this.append({ t: "title", id: newId("e"), at: now(), title });
		this.touch({ title });
	}

	private appendUser(message: { text: string; images?: Part[] }): void {
		this.changed = undefined;
		const first = !this.events.some((e) => e.t === "user");
		this.append({ t: "user", id: newId("e"), at: now(), text: message.text, images: message.images });
		if (first) {
			const title = clip(message.text.trim().split("\n")[0] || "Session", 72);
			this.append({ t: "title", id: newId("e"), at: now(), title });
			this.touch({ title });
		}
	}

	private async turn(signal: AbortSignal): Promise<void> {
		for (let step = 0; step < MAX_STEPS; step++) {
			if (signal.aborted) return;
			// The session's model gone (its server stopped, or a lab took it away): stop and say so. Moving the
			// conversation to another model on its own could send it somewhere the person never chose.
			if (this.modelRef && !this.model()) {
				this.notice("error", `${this.modelRef} isn't available now: its server may have stopped, or your access to it changed. Pick another model to go on.`);
				return;
			}
			const model = this.model() ?? this.fallbackModel();
			if (!model) {
				this.notice("error", "No model is available. Start a local model server, add a provider to ~/.el/config.json, or sign in to a site with el login.");
				return;
			}
			// A lab that keeps its sandboxes for its own agents: commands there come from its own models only.
			const lab = this.place !== "local" ? this.deps.lab?.(this.place) : undefined;
			if (lab?.sandboxAgents === "lab" && !(model.source === "site" && model.provider === this.place)) {
				this.notice("error", `${lab.title} runs its sandboxes for its own models only. Pick one of ${lab.title}'s models to go on.`);
				return;
			}
			if (model.ref !== this.modelRef) this.setModel(model.ref, undefined);
			// Context is managed where a turn starts. Inside a tool round only the hard limit triggers a summary: an edit
			// there throws away the round's reasoning and the prompt cache.
			await this.manageContext(model, signal, step === 0);
			const assistant = await this.request(model, signal);
			this.append(assistant);
			this.queueSummary(assistant);
			if (assistant.stop === "cancelled" || assistant.stop === "error") return;
			if (assistant.stop === "length" && !assistant.toolCalls?.length) {
				this.notice("warn", "The answer reached the output limit and stopped.");
				return;
			}
			if (!assistant.toolCalls?.length) {
				if (this.queue.length) for (const message of this.queue.splice(0)) this.appendUser(message);
				else return;
				continue;
			}
			await this.runTools(assistant.toolCalls, model, signal);
			if (signal.aborted) return;
			// Steering: messages sent during the step join before the next request.
			for (const message of this.queue.splice(0)) this.appendUser(message);
		}
		this.notice("warn", `Stopped after ${MAX_STEPS} steps in one turn.`);
	}

	/** The default model when the session has none, among those it may use. */
	private fallbackModel(): ModelProfile | undefined {
		const preferred = this.deps.registry.preferred();
		if (preferred && this.deps.allows(preferred, this.site)) return preferred;
		return this.deps.registry.all().find((m) => this.deps.allows(m, this.site));
	}

	private effortFor(model: ModelProfile): string | undefined {
		const effort = this.effort ?? model.defaultEffort ?? this.deps.config().effort;
		return effort && model.efforts.includes(effort) ? effort : model.defaultEffort;
	}

	/** One model request, retried on rate limits, overload and network errors before any output arrives. */
	private async request(model: ModelProfile, signal: AbortSignal): Promise<Ev<"assistant">> {
		let overflowRetried = false;
		for (let attempt = 1; ; attempt++) {
			this.partial = { text: "", reasoning: "", tools: [], output: {} };
			this.setActivity("thinking");
			const started = Date.now();
			let firstByte = 0;
			let text = "";
			let reasoning = "";
			let reasoningData: unknown;
			const calls = new Map<number, ToolCall>();
			let usage: Usage | undefined;
			let stop: Ev<"assistant">["stop"] = "end";
			let error: string | undefined;
			let produced = false;
			try {
				const derived = derive(this.events);
				const stream = adapterFor(model).stream(
					{ model, system: this.system, messages: derived.messages, tools: this.toolSchemas(), effort: this.effortFor(model) },
					signal,
				);
				for await (const event of stream) {
					if (!firstByte && event.type !== "usage") firstByte = Date.now();
					switch (event.type) {
						case "text":
							produced = true;
							if (this.activity !== "writing") this.setActivity("writing");
							text += event.delta;
							this.delta("text", event.delta);
							break;
						case "reasoning":
							produced = true;
							reasoning += event.delta;
							this.delta("reasoning", event.delta);
							break;
						case "reasoning_data":
							reasoningData = event.data;
							break;
						case "tool_start":
							produced = true;
							this.flushDelta();
							calls.set(event.index, { id: event.id, name: event.name, args: "" });
							this.partial.tools.push({ index: event.index, name: event.name, args: "" });
							this.deps.notify("session.delta", { sessionId: this.id, kind: "tool", text: "", index: event.index, name: event.name });
							break;
						case "tool_args": {
							const call = calls.get(event.index);
							if (call) call.args += event.delta;
							const shown = this.partial.tools.find((t) => t.index === event.index);
							if (shown) shown.args += event.delta;
							this.deps.notify("session.delta", { sessionId: this.id, kind: "tool", text: event.delta, index: event.index });
							break;
						}
						case "usage":
							usage = event.usage;
							break;
						case "done":
							stop = event.stop === "error" ? "error" : event.stop;
							error = event.error;
							break;
					}
				}
			} catch (caught) {
				this.flushDelta();
				if (signal.aborted) {
					stop = "cancelled";
				} else if (caught instanceof ModelHttpError && caught.contextOverflow && !overflowRetried && !produced) {
					overflowRetried = true;
					this.notice("info", "The model refused the request as too long; compacting and retrying.");
					await this.compact(model, signal, true);
					continue;
				} else if (!produced && attempt < MAX_ATTEMPTS && (caught instanceof ModelHttpError ? caught.retryable : transient(caught))) {
					const wait = caught instanceof ModelHttpError && caught.retryAfterMs ? Math.min(caught.retryAfterMs, 60_000) : 1_000 * 2 ** (attempt - 1);
					this.setActivity("retrying", `${redact(errorText(caught))}; retrying in ${Math.round(wait / 1000)}s`);
					try {
						await sleep(wait, signal);
					} catch {
						stop = "cancelled";
						break;
					}
					continue;
				} else if (caught instanceof ModelHttpError && caught.status === 404 && caught.code === "model_not_found" && model.source === "site") {
					// A lab answers a model outside the person's grant as absent: their access changed since it was listed.
					stop = "error";
					error = `${model.provider} no longer offers ${model.id} to you; your access changed. Pick another model to go on.`;
				} else {
					stop = "error";
					error = redact(errorText(caught));
				}
			}
			this.flushDelta();
			const ms = Date.now() - started;
			if (usage?.output && firstByte) {
				const seconds = Math.max(0.05, (Date.now() - firstByte) / 1000);
				this.rate = Math.round((usage.output / seconds) * 10) / 10;
			}
			// A cancelled answer keeps its text but drops calls that never finished streaming.
			const toolCalls = stop === "cancelled" ? [] : [...calls.values()];
			if (toolCalls.length && stop !== "error") stop = "tool_use";
			return {
				t: "assistant",
				id: newId("e"),
				at: now(),
				model: model.ref,
				text,
				reasoning: reasoning || undefined,
				reasoningData,
				toolCalls: toolCalls.length ? toolCalls : undefined,
				usage,
				stop,
				error,
				ms,
			};
		}
		return { t: "assistant", id: newId("e"), at: now(), model: model.ref, text: "", stop: "cancelled" };
	}

	// ── Tools ──────────────────────────────────────────────────────────────────────────────────────────────────────

	private async runTools(calls: ToolCall[], model: ModelProfile, signal: AbortSignal): Promise<void> {
		const tools = new Map(this.visibleTools().map((t) => [t.name, t]));
		// Group consecutive read-only calls so they run at once; everything else runs alone, in order.
		const groups: ToolCall[][] = [];
		for (const call of calls) {
			const parallel = PARALLEL_KINDS.has(tools.get(call.name)?.kind ?? "");
			const last = groups[groups.length - 1];
			if (parallel && last && last.every((c) => PARALLEL_KINDS.has(tools.get(c.name)?.kind ?? ""))) last.push(call);
			else groups.push([call]);
		}
		for (const group of groups) {
			if (signal.aborted) {
				for (const call of group) this.appendToolResult(call, { ok: false, content: "Cancelled before it ran.", decision: "refused" });
				continue;
			}
			this.setActivity("tool", group.map((c) => c.name).join(", "));
			const results = await Promise.all(group.map((call) => this.runOne(call, tools.get(call.name), model, signal)));
			results.forEach((result, i) => this.appendToolResult(group[i], result));
			// Every step that may have changed files is kept, so it can be taken back.
			if (group.some((call) => CHANGES.has(tools.get(call.name)?.kind ?? ""))) await this.keepStep(`after ${group.map((c) => c.name).join(", ")}`, group[0]!.id, group.map((c) => c.id));
		}
	}

	private async runOne(
		call: ToolCall,
		tool: Tool | undefined,
		model: ModelProfile,
		signal: AbortSignal,
	): Promise<{ ok: boolean; content: string; images?: Part[]; view?: Partial<StepView>; decision?: Ev<"tool">["decision"]; tool?: Tool; args?: Record<string, unknown> }> {
		if (!tool) return { ok: false, content: `There is no tool named "${call.name}".`, decision: "refused" };
		let args: Record<string, unknown>;
		try {
			const parsed = JSON.parse(call.args || "{}");
			args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
		} catch (error) {
			return { ok: false, content: `The arguments were not valid JSON (${errorText(error)}). Send the call again with valid JSON.`, decision: "refused", tool };
		}
		let decision: Ev<"tool">["decision"] = "auto";
		// A lab sandbox's fence probe runs once, before its first decision (what can run unasked depends on it).
		await this.workspace.prepare?.().catch(() => undefined);
		const verdict = decide(tool, args, this.workspace, this.deps.config(), this.allowed, this.discovering, this.permissionMode, !this.historyOff);
		// A read-only subagent is read-only whatever the person's permission mode or sandbox would allow.
		if (this.agentMode === "read" && !readOnlyCall(tool, args, this.workspace)) {
			return { ok: false, content: "Refused: this subagent works read-only. Say in your answer what should change.", decision: "refused", tool, args };
		}
		if (verdict.action === "ask") {
			const request: PermissionRequest = {
				requestId: newId("p"),
				// A subagent's question goes to whoever watches the session that started it.
				sessionId: this.parent ?? this.id,
				callId: call.id,
				tool: tool.name,
				view: safeView(tool, args),
				reason: this.parent ? `A subagent asks: ${verdict.reason}` : verdict.reason,
				...(verdict.keys.some((key) => key.includes("!")) ? { once: true } : { scope: verdict.scope }),
				...(verdict.folder && this.deps.grantFolder ? { folder: verdict.folder } : {}),
			};
			this.pending.set(request.requestId, request);
			this.setActivity("waiting", tool.name);
			const answer = await this.deps.ask(request, signal);
			this.pending.delete(request.requestId);
			if (answer === "cancelled") return { ok: false, content: "Cancelled while waiting for the person.", decision: "refused", tool, args };
			if (answer === "deny") return { ok: false, content: "The person declined this call. Ask what they would like instead, or take another approach.", decision: "denied", tool, args };
			if (answer === "allow_session" && !verdict.keys.some((key) => key.includes("!"))) {
				for (const key of verdict.keys) this.allowed.add(key);
				this.append({ t: "allow", id: newId("e"), at: now(), keys: verdict.keys, scope: verdict.scope });
			}
			if (answer === "allow_folder" && verdict.folder) this.deps.grantFolder?.(verdict.folder);
			decision = answer === "allow" ? "allowed" : "allowed_session";
			this.setActivity("tool", tool.name);
		}
		const hooks = this.deps.config().hooks;
		if (hooks.beforeTool?.length) {
			const pre = await runHooks(hooks.beforeTool, { tool: tool.name, args }, this.cwd);
			if (pre.blocked) return { ok: false, content: `Blocked by a hook: ${pre.blocked}`, decision: "refused", tool, args };
		}
		// Keep the files this call may change, so the turn can be undone.
		const touched = this.workspace.kind === "local" ? (tool.touches?.(args).filter(Boolean).map((path) => this.workspace.resolve(path)) ?? []) : [];
		const before = touched.length ? this.checkpoints.capture(touched) : [];
		if (before.length) this.append({ t: "checkpoint", id: newId("e"), at: now(), callId: call.id, files: before });
		// Decided again just before it runs: a path that now leads elsewhere (a link changed meanwhile) isn't followed.
		if (verdict.action === "run" && decide(tool, args, this.workspace, this.deps.config(), this.allowed, this.discovering, this.permissionMode, !this.historyOff).action !== "run") {
			return { ok: false, content: "Refused: where this call acts changed while it waited (a link may have moved). Send it again.", decision: "refused", tool, args };
		}
		try {
			const result = await tool.run(args, {
				sessionId: this.id,
				callId: call.id,
				workspace: this.workspace,
				place: this.place,
				project: projectRoot(this.cwd),
				sealed: this.deps.sealed?.(this.site),
				fence: verdict.action === "run" && verdict.fence === true,
				readOnly: this.agentMode === "read" || (verdict.action === "run" && verdict.readOnly === true),
				outside: Boolean(tool.ask?.(args, { workspace: this.workspace })),
				tools: this.deps.toolsDir,
				packages: this.deps.packageSources?.(this.site),
				apps: this.deps.apps?.(this.id),
				surface: this.deps.surface?.(this.id),
				browser: this.deps.browser?.(this.id),
				log: this.log,
				signal,
				vision: model.vision,
				canvas: this.deps.canvas,
				agents: this.parent
					? undefined
					: {
							start: (task, options) => this.deps.spawn(this, task, options),
							wait: (agents, timeoutMs, waitSignal) => this.deps.waitAgents(this.id, agents, timeoutMs, waitSignal),
						},
				output: (text) => {
					this.partial.output[call.id] = clip((this.partial.output[call.id] ?? "") + text, 200_000);
					this.deps.notify("session.delta", { sessionId: this.id, kind: "output", text, callId: call.id });
				},
			});
			if (hooks.afterTool?.length) {
				const post = await runHooks(hooks.afterTool, { tool: tool.name, args, result: { ok: result.ok } }, this.cwd);
				if (post.note) return { ...result, content: `${result.content}\n\n[hook] ${post.note}`, decision, tool, args };
			}
			return { ...result, decision, tool, args };
		} catch (error) {
			const message = error instanceof ToolError ? error.message : `${tool.name} failed: ${redact(errorText(error))}`;
			return { ok: false, content: message, decision, tool, args };
		} finally {
			delete this.partial.output[call.id];
		}
	}

	private appendToolResult(
		call: ToolCall,
		result: { ok: boolean; content: string; images?: Part[]; view?: Partial<StepView>; decision?: Ev<"tool">["decision"]; tool?: Tool; args?: Record<string, unknown> },
	): void {
		let content = result.content;
		let handle: string | undefined;
		if (content.length >= ELIDE_MIN_CHARS) handle = this.log.storeOutput(content);
		if (content.length > INLINE_MAX_CHARS) {
			const head = content.slice(0, 12_000);
			const tail = content.slice(-6_000);
			content = `${head}\n\n[… ${((content.length - 18_000) / 1024).toFixed(0)} KB not shown. recall with handle "${handle}" pages the full output …]\n\n${tail}`;
		}
		const base = result.tool && result.args ? safeView(result.tool, result.args) : { verb: call.name, target: "" };
		const view: StepView = { ...base, ...result.view };
		if (!result.ok && !view.result) view.result = "failed";
		if (!view.detail && !result.ok) view.detail = result.content.slice(0, 4_000);
		this.append({
			t: "tool",
			id: newId("e"),
			at: now(),
			callId: call.id,
			name: call.name,
			ok: result.ok,
			content,
			images: result.images,
			view: { ...view, detail: view.detail ? clip(view.detail, 20_000) : undefined },
			handle,
			decision: result.decision,
		});
	}

	// ── Context ────────────────────────────────────────────────────────────────────────────────────────────────────

	private async manageContext(model: ModelProfile, signal: AbortSignal, boundary: boolean): Promise<void> {
		const b = budget(model.context, this.compactAt());
		const fixed = estimateTokens(this.system) + estimateTokens(JSON.stringify(this.toolSchemas()));
		let g = gauge(this.events, derive(this.events), fixed, b, model.ref);
		if (!boundary) {
			const hard = b.threshold + Math.round((b.window - b.threshold) / 2);
			if (g.used >= hard) await this.compact(model, signal, false);
			return;
		}
		if (g.used >= b.elideAt && g.used < b.threshold) {
			const candidates = elisionCandidates(this.events);
			if (candidates.length) {
				this.append({ t: "elide", id: newId("e"), at: now(), ids: candidates.map((c) => c.id), tokensBefore: g.used });
				g = gauge(this.events, derive(this.events), fixed, b, model.ref);
			}
		}
		if (g.used >= b.threshold) await this.compact(model, signal, false);
	}

	private async compact(model: ModelProfile, signal: AbortSignal, force: boolean): Promise<boolean> {
		const b = budget(model.context, this.compactAt());
		const fixed = estimateTokens(this.system) + estimateTokens(JSON.stringify(this.toolSchemas()));
		const derived = derive(this.events);
		const before = gauge(this.events, derived, fixed, b, this.modelRef).used;
		const keep = Math.min(20_000, Math.round(b.threshold * 0.25));
		const cut = cutPoint(this.events, derived, keep);
		if (cut === undefined || cut <= 0) {
			if (force) this.notice("info", "Nothing old enough to summarize yet.");
			return false;
		}
		const firstKept = this.events[derived.sources[cut]];
		if (!firstKept) return false;
		this.setActivity("compacting", `summarizing ${derived.messages.slice(0, cut).length} messages`);
		const summaryModel = this.helperModel(model);
		try {
			const summary = await summarize(summaryModel, derived.messages.slice(0, cut), signal, this.toolSchemas());
			this.append({ t: "compaction", id: newId("e"), at: now(), summary, firstKeptId: firstKept.id, tokensBefore: before, model: summaryModel.ref });
			return true;
		} catch (error) {
			if (signal.aborted) return false;
			this.notice("warn", `Compaction failed: ${redact(errorText(error))}. Continuing without it.`);
			return false;
		}
	}
}

/** A tool's step line, guarded against a view function that throws on odd arguments. */
function safeView(tool: Tool, args: Record<string, unknown>): StepView {
	try {
		const view = tool.view(args);
		return { ...view, target: clip(view.target, 2_000) };
	} catch {
		return { verb: tool.name, target: "" };
	}
}

/** Network trouble worth another try; a bug in the adapter or a bad request is not. */
function transient(error: unknown): boolean {
	const e = error as { code?: string; name?: string; message?: string };
	if (e?.code && /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR_.*|ConnectionRefused|ConnectionClosed|ConnectionReset)$/.test(e.code)) return true;
	return /network|socket|connection|timed? ?out|terminated|fetch failed|ended early|EOF|ECONN/i.test(e?.message ?? "");
}

/**
 * What a read-only subagent may do: read, search, look things up, and run commands where the OS keeps them from
 * writing (contained with nothing in the project writable, or under a lab's fence with no project rights): the
 * command's words decide nothing.
 */
function readOnlyCall(tool: Tool, args: Record<string, unknown>, workspace: Workspace): boolean {
	if (tool.kind === "exec") return args.unsandboxed !== true && (workspace.fenced === true || (workspace.kind === "local" && workspace.sandboxed !== undefined && FULL_CONTAINMENT.has(workspace.sandboxed)));
	return tool.kind === "read" || tool.kind === "site-read" || tool.kind === "net" || (tool.kind === "local" && !tool.name.startsWith("agent_") && tool.name !== "remember");
}
