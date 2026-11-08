// The lab contract: what a lab serves so EnrichedLab (and other clients) can use it the same way at every site. The
// JSON Schemas in contract/ are the source; docs/labs.md is the prose. A lab describes itself at
// GET /.well-known/enrichedlab-lab, and `el lab check <lab>` checks a lab against these schemas.

import appsSchema from "../../../../contract/apps.schema.json" with { type: "json" };
import bundleSchema from "../../../../contract/bundles.schema.json" with { type: "json" };
import containerSchema from "../../../../contract/container.schema.json" with { type: "json" };
import eventSchema from "../../../../contract/event.schema.json" with { type: "json" };
import guardSchema from "../../../../contract/guard.schema.json" with { type: "json" };
import labSchema from "../../../../contract/lab.schema.json" with { type: "json" };
import meSchema from "../../../../contract/me.schema.json" with { type: "json" };
import modelsSchema from "../../../../contract/models.schema.json" with { type: "json" };
import runSchema from "../../../../contract/run.schema.json" with { type: "json" };
import signersSchema from "../../../../contract/signers.schema.json" with { type: "json" };
import usageSchema from "../../../../contract/usage.schema.json" with { type: "json" };

/** The contract this client speaks. A lab on another major is refused; a newer minor ("2026-11.1") is fine. */
export const CONTRACT = "2026-11";
export const DESCRIPTOR_PATH = "/.well-known/enrichedlab-lab";

export const SCHEMAS = {
	lab: labSchema,
	me: meSchema,
	models: modelsSchema,
	bundles: bundleSchema,
	event: eventSchema,
	guard: guardSchema,
	usage: usageSchema,
	container: containerSchema,
	apps: appsSchema,
	signers: signersSchema,
	/** GET /v1/runs: the person's runs at the lab. */
	runs: { type: "object", required: ["data"] as string[], properties: { data: { type: "array", items: runSchema.$defs.run } } },
} as const;

/** One version of an app a lab offers (GET /v1/apps). */
export interface LabAppEntry {
	name: string;
	title: string;
	version: string;
	description?: string;
	signer: { fingerprint: string; name?: string };
	sha256: string;
	bytes: number;
	runtime?: string;
	permissions?: Record<string, unknown>;
	published?: string;
	withdrawn_at?: string | null;
	package: string;
}

/** A signer the lab vouches for (GET /v1/signers). */
export interface LabSigner {
	fingerprint: string;
	public_key: string;
	name?: string;
	added?: string;
	revoked_at?: string | null;
}

export type Endpoint = "models" | "mcp" | "bundles" | "events" | "guard" | "devices" | "containers" | "stop" | "ports" | "attach" | "files" | "apps" | "signers" | "usage" | "agents" | "runs" | "openapi" | "chat_completions" | "checkpoints";

export interface SandboxProfile {
	name: string;
	cpu: number;
	memory: string;
	gpu?: string;
	wall_minutes?: number;
	runtime_class?: string;
}

export interface LabDescriptor {
	contract: string;
	name: string;
	title: string;
	endpoints: Partial<Record<Endpoint, boolean>>;
	sign_in: { kind: string };
	policy?: { keep_data_inside?: boolean; device_proof?: "off" | "optional" | "required"; sandbox_agents?: SandboxAgents };
	support?: { url: string };
	docs?: { url: string };
	sandbox_profiles?: SandboxProfile[];
	/** A browser in the person's sandbox, reached through the lab's port path (the sandbox lane of the browser tools). */
	browser?: BrowserInfo;
	/** Images a sandbox can be made from (POST /v1/containers {image}); one may carry a browser. */
	sandbox_images?: { name: string; title?: string; description?: string; browser?: BrowserInfo }[];
	/** Networks a sandbox can be made on (POST /v1/containers {network}): always none, and internet where offered. */
	sandbox_networks?: { name: string; title?: string; description?: string }[];
	/** Whether the sandbox runs background jobs (/v1/containers/{id}/jobs); absent means it does. */
	sandbox_jobs?: boolean;
	/** What one exec takes: the longest single argument (a `command` is one), and how much stdin. */
	sandbox_exec?: { max_argument_bytes?: number; max_stdin_bytes?: number };
	conformance?: { foreign_scope?: string; scan_test?: boolean; data_tool?: { name: string; arguments?: Record<string, unknown> } };
	/** A desktop sandbox the person and the agent work in through checked actions (POST /v1/containers/{id}/desktop). */
	sandbox_desktop?: DesktopInfo;
	/** Every desktop the lab offers (sandbox_desktop repeats the first). */
	sandbox_desktops?: DesktopInfo[];
	/** Package sources the lab vets and scans, for sandbox and local environments. */
	packages?: { conda?: string[]; pypi?: string; cran?: string; npm?: string; only?: boolean };
}

/** Whose agents use a lab's sandboxes: only the lab's models, or a person's own agents too. */
export type SandboxAgents = "lab" | "any";

export interface DesktopInfo {
	image: string;
	/** "linux" or "macos"; linux when absent. */
	os?: string;
	title?: string;
	screen?: { width: number; height: number };
	actions: string[];
	/** Programs `launch` starts, by id (such as browser and text). */
	apps?: { id: string; title?: string }[];
	/** Apps `open` can open a target with (`with`); the browser when not named. */
	open_with?: string[];
	/** GET /v1/containers/{id}/desktop/stream serves a live view (subprotocol gate.desktop.v1). */
	stream?: boolean;
	/** POST /v1/containers/{id}/desktop/open is served, for these kinds of target (such as "https", "sandbox"). */
	open?: boolean;
	open_targets?: string[];
	/** The most one `type` action takes, and the longest `wait`. */
	max_type_chars?: number;
	max_wait_seconds?: number;
	/** The `by` labels the lab records. */
	labels?: string[];
}

export interface BrowserInfo {
	/** "cdp", the Chrome DevTools Protocol; a lab may add others later, and a client skips ones it doesn't speak. */
	protocol: string;
	/** The sandbox image the browser runs in (sandbox_images); without one, it runs in the person's own sandbox. */
	image?: string;
	port: number;
	version?: string;
	notes?: string;
}

/** Why this client can't use a lab on that contract, or undefined when it can. */
export function contractProblem(descriptor: LabDescriptor): string | undefined {
	const major = descriptor.contract.split(".")[0];
	if (major === CONTRACT) return undefined;
	return `${descriptor.title} speaks lab contract ${descriptor.contract}; this version of EnrichedLab speaks ${CONTRACT}. Update EnrichedLab (el update) or ask the lab.`;
}

type Schema = {
	type?: string | string[];
	required?: string[];
	properties?: Record<string, Schema>;
	items?: Schema;
	enum?: unknown[];
	pattern?: string;
	minLength?: number;
	maxLength?: number;
	minimum?: number;
	not?: Schema;
	format?: string;
};

const typeOf = (value: unknown): string =>
	value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;

/**
 * Check a value against one of the contract's schemas. Covers what contract/ uses (types, required, properties,
 * items, enum, pattern, lengths, minimum, not, date-time); returns one line per problem, empty when it fits.
 */
export function validate(schema: Schema, value: unknown, at = "$"): string[] {
	const problems: string[] = [];
	const actual = typeOf(value);
	const types = schema.type === undefined ? undefined : [schema.type].flat();
	if (types && !types.some((type) => type === actual || (type === "number" && actual === "integer"))) return [`${at} is ${actual}, expected ${types.join(" or ")}`];
	if (value === null) return problems;
	if (schema.enum && !schema.enum.includes(value)) problems.push(`${at} is ${JSON.stringify(value)}, expected one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
	if (typeof value === "string") {
		if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${at} is shorter than ${schema.minLength}`);
		if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${at} is longer than ${schema.maxLength}`);
		if (schema.pattern && !new RegExp(schema.pattern).test(value)) problems.push(`${at} doesn't match ${schema.pattern}`);
		if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) problems.push(`${at} isn't a date and time`);
	}
	if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) problems.push(`${at} is below ${schema.minimum}`);
	if (schema.not && validate(schema.not, value, at).length === 0) problems.push(`${at} must not match ${JSON.stringify(schema.not)}`);
	if (actual === "object") {
		const object = value as Record<string, unknown>;
		for (const key of schema.required ?? []) if (!(key in object)) problems.push(`${at}.${key} is missing`);
		for (const [key, sub] of Object.entries(schema.properties ?? {})) if (key in object) problems.push(...validate(sub, object[key], `${at}.${key}`));
	}
	if (actual === "array" && schema.items) (value as unknown[]).forEach((item, i) => problems.push(...validate(schema.items!, item, `${at}[${i}]`)));
	return problems;
}

/** One row of `el lab check`. */
export interface CheckRow {
	row: string;
	status: "pass" | "fail" | "skip";
	detail?: string;
}

/** An event from the lab's stream, as the engine passes it on. */
export interface LabEvent {
	type: string;
	at: string;
	id: string;
	session?: string;
	text?: string;
	[key: string]: unknown;
}
