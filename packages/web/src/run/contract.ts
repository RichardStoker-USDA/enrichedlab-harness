import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/);
const label = z.string().min(1).max(2000);
export const runSchema = z.object({
	id: safeId, session: z.string(), title: label.optional(),
	status: z.enum(["running", "waiting", "idle", "finished", "failed", "stopped"]),
	waiting: z.object({ text: label.optional() }).optional(),
	"x-campaign": z.string().optional(),
	"x-steering": z.object({
		messages: z.boolean().optional(), stop: z.boolean().optional(),
		budget: z.object({ path: z.string(), unit: z.literal("minutes") }).optional(),
	}).optional(),
});
export type Run = z.infer<typeof runSchema>;
const listedRuns = z.array(runSchema).max(100);
const cursor = z.string().max(100).nullable();
export const runPage = z.union([
	z.object({ runs: listedRuns, next: cursor }),
	z.object({ data: listedRuns, next: cursor.optional() }).transform(page => ({ runs: page.data, next: page.next ?? null })),
]);

type ReadRequest = (url: string, options: RequestInit) => Promise<Response>;
export async function readRunLog(base: string, options: RequestInit, read: ReadRequest = fetch) {
	const response = await read(base + "/log", options);
	if (!response.ok) throw Error("The lab could not open this run for your account.");
	return z.array(eventSchema).max(20000).parse(await response.json());
}

export async function readRunSnapshot(id: string, options: RequestInit, read: ReadRequest = fetch) {
	const base = runPath(id);
	const response = await read(base, options);
	if (!response.ok) throw Error("The lab could not open this run for your account.");
	const summary = runSchema.parse(await response.json());
	if (summary.id !== id) throw Error("The lab returned another run.");
	// A terminal summary includes all prior deliveries. Read its log afterwards.
	return { summary, entries: await readRunLog(base, options, read) };
}
export const artifactSchema = z.object({
	name: label, uri: z.string(), sha256: digest, mime: z.string(), bytes: z.number().int().nonnegative(),
});
export type Artifact = z.infer<typeof artifactSchema>;
const delivery = z.object({
	n: z.number().int().positive(), milestone: label, note: label.optional(), receipt: digest,
	artifacts: z.array(artifactSchema).max(64),
});
export const eventSchema = z.object({
	v: z.literal(1), seq: z.number().int().positive(), time: z.string().datetime({ offset: true }),
	kind: z.string(), data: z.record(z.string(), z.unknown()),
});
export type RunEvent = z.infer<typeof eventSchema>;
export type Version = z.infer<typeof delivery> & { time: string };
export type Activity = { seq: number; time: string; text: string };
export type View = { objective: string; step: string; versions: Version[]; activity: Activity[]; minutes?: number; stopping: boolean };

export function project(run: Run, events: readonly RunEvent[]): View {
	const view: View = { objective: "", step: run.waiting?.text ?? "", versions: [], activity: [], stopping: false };
	const versions = new Map<number, Version>();
	let expected = 1;
	for (const e of events) {
		if (e.seq !== expected++) throw Error("The run log has a gap.");
		const add = (text: string) => view.activity.push({ seq: e.seq, time: e.time, text });
		if (e.kind === "user") {
			const { text } = z.object({ text: z.string().min(1).max(256 * 1024) }).parse(e.data);
			if (!view.objective) view.objective = text;
			else add(text);
			continue;
		}
		// The candidate lab projects its named campaign events into the session-log extension envelope.
		if (e.kind !== "x-campaign-event") continue;
		switch (e.data.type) {
			case "delivery.published": {
				const version = delivery.parse(e.data);
				if (versions.has(version.n)) throw Error("Two publications claim the same version.");
				versions.set(version.n, { ...version, time: e.time });
				if (view.step === version.milestone) view.step = "";
				break;
			}
			case "milestone.revised": view.step = label.parse(e.data.milestone); break;
			case "feedback.received": add(label.parse(e.data.text)); break;
			case "budget.changed":
				view.minutes = z.number().int().positive().safe().parse(e.data.minutes);
				add(`Budget changed to ${view.minutes} minutes.`); break;
			case "stop.requested": view.stopping = true; add("Stop requested."); break;
		}
	}
	view.versions = [...versions.values()].sort((a, b) => b.n - a.n);
	view.activity.reverse();
	view.objective ||= run.title ?? "Research run";
	return view;
}

export function runPath(id: string) {
	return "/v1/runs/" + encodeURIComponent(safeId.parse(id));
}

/** Only the same-origin run's explicit budget grant can supply a budget writer. */
export function budgetPath(run: Run): string | undefined {
	const grant = run["x-steering"]?.budget;
	const expected = runPath(run.id) + "/budget";
	return grant?.path === expected ? expected : undefined;
}

export async function readArtifact(ref: Artifact, signal: AbortSignal): Promise<Blob> {
	const url = new URL(ref.uri, location.origin);
	if (url.origin !== location.origin || url.username || url.password || url.hash ||
		!/^\/v1\/artifacts\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(url.pathname))
		throw Error("This reference needs its lab's artifact resolver.");
	const max = 32 * 1024 * 1024;
	if (ref.bytes > max) throw Error("This artifact exceeds the 32 MiB preview limit.");
	const result = await fetch(url, { signal, credentials: "same-origin", redirect: "error", cache: "no-store" });
	if (!result.ok || !result.body) throw Error("The lab could not open this artifact.");
	const reader = result.body.getReader();
	const bytes = new Uint8Array(ref.bytes);
	let offset = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value.length > bytes.length - offset) throw Error("Artifact length differs from its receipt.");
			bytes.set(value, offset);
			offset += value.length;
		}
	} finally { await reader.cancel(); }
	if (offset !== bytes.length) throw Error("Artifact length differs from its receipt.");
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	if ([...hash].map(b => b.toString(16).padStart(2, "0")).join("") !== ref.sha256)
		throw Error("Artifact checksum differs from its receipt.");
	return new Blob([bytes], { type: ref.mime });
}
