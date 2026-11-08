import type { AgentHost } from "./agents.ts";
import type { BrowserLanes } from "./browser.ts";
import type { AppSummary, CanvasSummary, Part, StepView, SurfaceAnswer } from "@enrichedlab/protocol";
import type { McpView } from "../apps/host.ts";
import type { SessionLog } from "../session/log.ts";
import type { Workspace } from "./workspace.ts";

/** How a tool is gated. */
export type ToolKind =
	| "read" // reads inside the workspace: runs
	| "write" // changes files: asks unless allowed
	| "exec" // runs commands: asks unless read-only or allowed
	| "net" // reaches a host: asks once per host
	| "local" // harness-only effects (canvas, plan, recall): runs
	| "site-read" // a site tool marked read-only: runs
	| "site-write" // any other site tool: asks
	| "sandbox" // runs in an isolated site sandbox: runs
	| "packages"; // installs packages into the project's own environment: asks unless allowed

export interface ToolContext {
	sessionId: string;
	callId: string;
	workspace: Workspace;
	log: SessionLog;
	signal: AbortSignal;
	vision: boolean;
	/** Stream partial output to watching surfaces. */
	output(text: string): void;
	canvas: CanvasPublisher;
	/** Where the session works: "local" or a site name. */
	place: string;
	/** The project's folder on this computer (its git root, or the session's folder). */
	project: string;
	/** Set in a session bound to an isolated lab: nothing the tool makes may reach the network. */
	sealed?: boolean;
	/** Opening apps in this session's workbench, and showing an MCP server's view. */
	apps?: { open(path: string): Promise<AppSummary>; publishView(view: McpView): AppSummary };
	/** The browser tools' two browsers: the desktop app's and the one in a lab's sandbox (tools/browser.ts). */
	browser?: BrowserLanes;
	/** Asking the desktop window showing this session to act (its browser); absent when none is open. */
	surface?: { call(capability: string, op: string, args: Record<string, unknown>, signal: AbortSignal): Promise<SurfaceAnswer> };
	/** Starting and collecting subagents; absent inside a subagent. */
	agents?: AgentHost;
	/** It runs because of the paths it names, in a lab's sandbox: the sandbox checks where they lead first. */
	fence?: boolean;
	/** Where shared tools (pixi and its caches) are kept on this computer. */
	tools?: string;
	/** The vetted package sources of the session's lab, when it names them (its descriptor's `packages`). */
	packages?: { conda?: string[]; pypi?: string; only?: boolean };
}

export type CanvasInput = { sessionId: string; id?: string; title: string; kind: CanvasSummary["kind"]; content: string; sealed?: boolean } & Pick<CanvasSummary, "source" | "plot" | "href">;

export interface CanvasPublisher {
	publish(input: CanvasInput): CanvasSummary;
}

export interface ToolResult {
	ok: boolean;
	content: string;
	images?: Part[];
	view?: Partial<StepView>;
}

export interface Tool<A = Record<string, unknown>> {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	kind: ToolKind;
	/** A lab marked this tool unreviewed (model-extended, not checked by a person): it asks every time, in every mode. */
	unreviewed?: boolean;
	/** Works only while the session works on this computer: not offered while it works in a lab's sandbox. */
	localOnly?: boolean;
	/** The lab this tool acts at (its sandbox or its MCP tools); absent for tools of this computer. */
	site?: string;
	/** The step line, before it runs (also what a permission question shows). */
	view(args: A): StepView;
	/** Extra reason to ask even when the kind would run, e.g. a path outside the project. */
	/** For "net" tools without a url argument: the host a call reaches, for the once-per-host question. */
	host?(args: A): string;
	/** Files this call may change, so they can be checkpointed first (absolute or project-relative). */
	touches?(args: A): string[];
	ask?(args: A, ctx: { workspace: Workspace }): string | undefined;
	run(args: A, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolError extends Error {}

/** Read a required string argument or explain what was missing. */
export function str(args: Record<string, unknown>, key: string, required = true): string {
	const value = args[key];
	if (typeof value === "string") return value;
	if (value === undefined && !required) return "";
	throw new ToolError(`"${key}" must be a string.`);
}

export function num(args: Record<string, unknown>, key: string): number | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	const n = typeof value === "string" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isFinite(n)) throw new ToolError(`"${key}" must be a number.`);
	return n;
}
