// The person's own settings: providers they bring, MCP servers, default model and permission mode. Secrets are named
// by file or environment variable, never stored here.

import type { Hooks } from "./hooks.ts";
import type { SandboxMode } from "./tools/workspace.ts";
import type { SearchConfig } from "./tools/search.ts";
import type { Paths } from "./paths.ts";
import { readJson, writeJson } from "./util.ts";

/** `ollama` is Ollama's own chat API, which can set the context window (its OpenAI endpoint can't). */
export type ApiKind = "openai-chat" | "openai-responses" | "anthropic" | "ollama";

export interface ProviderConfig {
	api: ApiKind;
	baseUrl: string;
	keyFile?: string;
	keyEnv?: string;
	/** The key is in the OS credential store (or ~/.el/credentials), put there by `provider.add`. */
	keychain?: boolean;
	/** Signed in through the service's own sign-in instead of a key (ChatGPT plan use). */
	auth?: "chatgpt";
	/** A PEM file for a private certificate authority (a LAN service with its own CA). */
	caFile?: string;
	headers?: Record<string, string>;
	/** Models to offer when the provider can't list them. */
	models?: string[];
	label?: string;
}

/** Per-model overrides. Keys are model references (`provider/model`) or a model id. */
export interface ModelOverride {
	context?: number;
	maxOutput?: number;
	vision?: boolean;
	efforts?: string[];
	defaultEffort?: string;
	/** Where the reasoning level goes: `reasoning_effort` (top level) or `chat_template_kwargs`. */
	effortField?: "reasoning_effort" | "chat_template_kwargs" | "none";
	/** Send earlier reasoning back within a turn (needed by templates that interleave thinking with tool calls). */
	replayReasoning?: boolean;
	temperature?: number;
	instructions?: string;
}

export interface McpServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	/** Header value read from a file at connect time, e.g. { "authorization": "~/.secrets/x" } with a "Bearer " prefix. */
	bearerFile?: string;
	enabled?: boolean;
}

/** ask, auto (asks only for what history can't take back) or full. "edits", an older name, reads as auto. */
export type PermissionMode = "ask" | "auto" | "full";

/** What the person let EnrichedLab do in a folder they added: change its files, or only read them. */
export type FolderAccess = "change" | "read";

export interface LabConfig {
	model?: string;
	effort?: string;
	/**
	 * A smaller model for compaction and reasoning summaries. Used only where it runs in the same place as the session's
	 * model (the same lab, service or computer); otherwise the session's own model makes them.
	 */
	summaryModel?: string;
	/** Summarize each step's reasoning for reading (the full text stays in the log); on unless false. */
	reasoningSummaries?: boolean;
	/** Compact no later than this: a token count, or a fraction of the window (0 to 1). */
	compactAt?: number;
	providers: Record<string, ProviderConfig>;
	models: Record<string, ModelOverride>;
	mcpServers: Record<string, McpServerConfig>;
	/** sandbox "workspace" (the default): local commands run contained (macOS Seatbelt, Linux bubblewrap) and don't ask. */
	permissions: { mode: PermissionMode; allowCommands: string[]; sandbox?: SandboxMode };
	/** Folders the person added, by absolute path, with what they let EnrichedLab do there (asked once, when added). */
	folders?: Record<string, { access: FolderAccess; at: string }>;
	/** Look for model servers on this computer; `ports` replaces the default list (11434, 1234, 8080, 8000, 30000). */
	discovery: { local: boolean; ports?: number[] };
	instructions: { global: string[] };
	/** Skill folders: absolute or ~ paths, or paths inside the project. */
	skills: { dirs: string[] };
	hooks: Hooks;
	/** A web search provider for standalone use (sites can grant their own). */
	search?: SearchConfig;
}

export const DEFAULT_CONFIG: LabConfig = {
	providers: {},
	models: {},
	mcpServers: {},
	// Agent commands run contained where the OS allows it (macOS Seatbelt, Linux bubblewrap); "off" turns it off.
	permissions: { mode: "auto", allowCommands: [], sandbox: "workspace" },
	discovery: { local: true },
	instructions: { global: ["~/.el/AGENTS.md"] },
	skills: { dirs: ["~/.el/skills", ".agents/skills", ".el/skills"] },
	hooks: {},
};

export function loadConfig(p: Paths): LabConfig {
	const saved = readJson<Partial<LabConfig>>(p.config, {});
	return {
		...DEFAULT_CONFIG,
		...saved,
		providers: { ...saved.providers },
		models: { ...saved.models },
		mcpServers: { ...saved.mcpServers },
		permissions: { ...DEFAULT_CONFIG.permissions, ...saved.permissions },
		discovery: { ...DEFAULT_CONFIG.discovery, ...saved.discovery },
		instructions: { ...DEFAULT_CONFIG.instructions, ...saved.instructions },
		skills: { ...DEFAULT_CONFIG.skills, ...saved.skills },
		hooks: { ...saved.hooks },
	};
}

/** Merge a change into the saved file without writing defaults the person never chose. */
export function saveConfig(p: Paths, change: Partial<LabConfig>): void {
	const saved = readJson<Partial<LabConfig>>(p.config, {});
	writeJson(p.config, { ...saved, ...change });
}
