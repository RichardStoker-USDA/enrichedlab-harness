// A session as a run package (docs/research.md, "A run package"): one RO-Crate 1.3 folder, Process Run Crate profile,
// that a scientist can read, check and rerun from. It holds the shared session log (every message, model step with
// its full reasoning, tool call and output), its images, the files the session changed with their checksums, the
// project's package environment, and every model step and tool call as an action: its tool, input, the files it read
// and changed (content ids from step history), times, who allowed it and a reading summary. On this computer it also
// carries the session's step history as a git bundle, so every file state any step saw can be checked out offline;
// verifyPackage checks it all, and reproduceStep reruns a command step from its exact inputs and compares the files.
// WHNRC's evidence exports pin the same RO-Crate versions, so both read the same way.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { SessionEvent, SessionSummary } from "@enrichedlab/protocol";
import { commandWords } from "../tools/shell.ts";
import { contained, physical } from "../tools/workspace.ts";

const CRATE = "https://w3id.org/ro/crate/1.3";
const PROFILE = "https://w3id.org/ro/wfrun/process/0.6";
/** EnrichedLab's own terms, as absolute IRIs (RO-Crate's ad hoc terms). */
const TERMS = "https://enrichedlab.org/contract/2026-11/terms#";

type Ev<T extends SessionEvent["t"]> = Extract<SessionEvent, { t: T }>;
type Entity = Record<string, unknown> & { "@id": string; "@type": string | string[] };

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The session's step history: its store and its line of commits. */
export interface PackageHistory {
	store: string;
	ref: string;
}

export interface PackageInput {
	summary: SessionSummary;
	/** The engine's own events, for times, models, checkpoints and summaries. */
	events: SessionEvent[];
	/** The shared log (session.export) and the images it refers to. */
	log: unknown[];
	attachments: Record<string, { mime: string; data: string }>;
	/** Step history on this computer; absent for a lab session or one from before it. */
	history?: PackageHistory;
	/** Leave the history bundle out (it holds every kept file state, so it can be large). */
	withoutHistory?: boolean;
	/** Where each model ran, by ref: "this computer", "Field Lab", "OpenAI". */
	modelPlaces?: Record<string, string>;
	/** EnrichedLab's version. */
	version: string;
}

function git(store: string, args: string[], input?: string): string {
	const r = spawnSync("git", ["--git-dir", store, "-c", "core.quotepath=false", ...args], { encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024 });
	if (r.status !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || "").trim()}`);
	return r.stdout;
}

/** path → blob id at a commit, for the paths that are files there. */
function blobs(store: string, commit: string, paths: string[]): Map<string, string> {
	const out = new Map<string, string>();
	if (!paths.length) return out;
	for (let i = 0; i < paths.length; i += 200) {
		const listed = git(store, ["ls-tree", "-z", commit, "--", ...paths.slice(i, i + 200).map((p) => `:(literal)${p}`)]);
		for (const line of listed.split("\0").filter(Boolean)) {
			const [meta, path] = [line.slice(0, line.indexOf("\t")), line.slice(line.indexOf("\t") + 1)];
			const [, type, id] = meta.split(" ");
			if (type === "blob" && id && path) out.set(path, id);
		}
	}
	return out;
}

/** Each tool call's history points: the newest kept point before it, and the one its group of calls left. */
function points(events: SessionEvent[]): Map<string, { before?: string; after?: string }> {
	const out = new Map<string, { before?: string; after?: string }>();
	let last: string | undefined;
	for (const e of events) {
		if (e.t === "place") last = undefined;
		if (e.t === "tool") out.set(e.callId, { before: last });
		if (e.t === "checkpoint" && e.history) {
			for (const id of e.calls ?? []) {
				const p = out.get(id);
				if (p) p.after = e.history;
			}
			last = e.history;
		}
	}
	return out;
}

/** The paths a call's arguments name, relative to the project, for its inputs. */
function named(name: string, args: Record<string, unknown>, cwd: string): string[] {
	const words: string[] = [];
	for (const key of ["path", "file", "paths", "files", "source", "out"]) {
		const v = args[key];
		if (typeof v === "string") words.push(v);
		if (Array.isArray(v)) for (const x of v) if (typeof x === "string") words.push(x);
	}
	if (typeof args.command === "string" && (name === "shell" || name.endsWith("_sandbox_run"))) words.push(...commandWords(args.command));
	const out = new Set<string>();
	for (const word of words) {
		if (!word || word.startsWith("-")) continue;
		const rel = relative(cwd, isAbsolute(word) ? word : resolve(cwd, word)).split("\\").join("/");
		if (rel && !rel.startsWith("..") && !isAbsolute(rel)) out.add(rel);
	}
	return [...out];
}

/**
 * git for a package someone else may have made: none of the person's or the system's config (no url rewrites,
 * helpers or fsmonitor), no hooks, every object checked as it arrives.
 */
const UNTRUSTED_GIT = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "transfer.fsckObjects=true", "-c", "fetch.fsckObjects=true", "-c", "core.symlinks=false", "-c", "core.autocrlf=false", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always"];
/** Only what git needs: no GIT_DIR, object or alternate directories, templates or injected config from the caller. */
const UNTRUSTED_ENV: Record<string, string> = {
	...Object.fromEntries(["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : []))),
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_TERMINAL_PROMPT: "0",
	GIT_NO_REPLACE_OBJECTS: "1",
	GIT_TEMPLATE_DIR: "",
};

/** Open a history bundle into a new, empty bare repository, every ref in it (a plain clone takes branches and tags only). */
function openBundle(bundle: string, repo: string): { ok: boolean; error: string } {
	const init = spawnSync("git", [...UNTRUSTED_GIT, "init", "--quiet", "--bare", "--template=", repo], { encoding: "utf8", env: UNTRUSTED_ENV });
	if (init.status !== 0) return { ok: false, error: (init.stderr || "git init failed").trim() };
	const fetched = spawnSync("git", [...UNTRUSTED_GIT, "--git-dir", repo, "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", bundle, "refs/sessions/*:refs/sessions/*"], { encoding: "utf8", env: UNTRUSTED_ENV });
	return { ok: fetched.status === 0, error: (fetched.stderr || "").trim() };
}

/**
 * A file the package names, inside the package folder: a relative path with no "..", no backslash and no link on the
 * way. Undefined for anything else, which verify reports.
 */
function packaged(folder: string, id: string): string | undefined {
	if (!id || isAbsolute(id) || id.includes("\\") || id.split("/").some((part) => part === ".." || part === "")) return undefined;
	let at = folder;
	for (const part of id.split("/")) {
		at = join(at, part);
		const info = lstatSync(at, { throwIfNoEntry: false });
		if (!info || info.isSymbolicLink()) return undefined;
	}
	return statSync(at).isFile() ? at : undefined;
}

/** A package file's bytes, opened without following a link and checked again once open; undefined when it isn't safe. */
function readPackaged(folder: string, id: string): Buffer | undefined {
	const at = packaged(folder, id);
	if (!at) return undefined;
	const fd = openSync(at, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = fstatSync(fd);
		const there = lstatSync(at, { throwIfNoEntry: false });
		if (!opened.isFile() || !there || there.ino !== opened.ino || there.dev !== opened.dev || packaged(folder, id) !== at) return undefined;
		return readFileSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Write the package into `folder`; answers what it holds. */
export function writePackage(folder: string, input: PackageInput): { files: number; actions: number; history: boolean } {
	mkdirSync(join(folder, "images"), { recursive: true });
	const graph: Entity[] = [];
	const parts: { "@id": string }[] = [];
	const file = (path: string, bytes: Buffer, extra: Record<string, unknown>) => {
		mkdirSync(join(folder, path, ".."), { recursive: true });
		writeFileSync(join(folder, path), bytes);
		graph.push({ "@id": path, "@type": "File", contentSize: String(bytes.length), sha256: sha256(bytes), ...extra });
		parts.push({ "@id": path });
	};

	file("session.jsonl", Buffer.from(input.log.map((e) => JSON.stringify(e)).join("\n") + "\n"), { name: "Session log", description: "Every message, model step with its full reasoning, tool call and output, in the shared log format v1.", encodingFormat: "application/jsonl" });
	for (const [hash, image] of Object.entries(input.attachments)) {
		file(`images/${hash}.${image.mime.split("/")[1] ?? "bin"}`, Buffer.from(image.data, "base64"), { encodingFormat: image.mime });
	}

	const local = !input.summary.place || input.summary.place === "local";
	const cwd = input.summary.cwd;

	// The project's package environment, exactly: pixi.toml and pixi.lock (docs/apps.md).
	// What goes in is read where it really is, and only when that's inside the project and a plain file: a link to a
	// file elsewhere (a private one, say) is left out.
	const home = local ? physical(cwd) : cwd;
	const own = (path: string): Buffer | undefined => {
		const real = physical(isAbsolute(path) ? path : `${cwd}/${path}`);
		const inside = relative(home, real);
		if (!inside || inside.startsWith("..") || isAbsolute(inside)) return undefined;
		const info = lstatSync(real, { throwIfNoEntry: false });
		return info?.isFile() ? readFileSync(real) : undefined;
	};
	if (local) {
		for (const name of ["pixi.toml", "pixi.lock"]) {
			const bytes = own(name);
			if (bytes) file(`environment/${name}`, bytes, { name, description: name === "pixi.lock" ? "The exact package versions the project's environment had when this was packaged." : "The project's package environment: what it asks for, from which channels." });
		}
	}

	// Files the session changed, as they are now, when they are on this computer. A lab session's files stay in the
	// lab's sandbox; the log names them.
	const changed = new Set<string>();
	for (const e of input.events) if (e.t === "checkpoint") for (const f of e.files) changed.add(f.path);
	const p = points(input.events);
	const history = local && input.history && existsSync(input.history.store) ? input.history : undefined;
	if (history) {
		for (const { before, after } of p.values()) {
			if (before && after) for (const path of git(history.store, ["diff", "--name-only", "--no-renames", "-z", before, after]).split("\0").filter(Boolean)) changed.add(path);
		}
	}
	let copied = 0;
	if (local) {
		for (const path of [...changed].sort()) {
			const full = isAbsolute(path) ? path : resolve(cwd, path);
			const inside = relative(cwd, full);
			const bytes = inside.startsWith("..") || isAbsolute(inside) ? undefined : own(path);
			if (!bytes) continue;
			const target = join("files", inside).split("\\").join("/");
			mkdirSync(join(folder, target, ".."), { recursive: true });
			writeFileSync(join(folder, target), bytes);
			graph.push({ "@id": target, "@type": "File", name: inside, contentSize: String(bytes.length), sha256: sha256(bytes), description: "A file the session changed, as it is now." });
			parts.push({ "@id": target });
			copied++;
		}
	}

	// The step history: every kept state of the folder, one commit per point, offline.
	let bundled = false;
	if (history && !input.withoutHistory && git(history.store, ["rev-parse", "--verify", "--quiet", history.ref]).trim()) {
		mkdirSync(join(folder, "history"), { recursive: true });
		git(history.store, ["bundle", "create", join(folder, "history", "steps.bundle"), history.ref]);
		const bytes = readFileSync(join(folder, "history", "steps.bundle"));
		graph.push({ "@id": "history/steps.bundle", "@type": "File", name: "Step history", contentSize: String(bytes.length), sha256: sha256(bytes), encodingFormat: "application/x-git-bundle", description: `Every state of the project folder the session kept, one commit per point, on ${history.ref}. Check one out with: git init steps && git -C steps fetch ../history/steps.bundle "refs/*:refs/*" && git -C steps checkout <commit>. Files over 25 MB and rebuilt folders aren't in it; each commit lists what it left out.` });
		parts.push({ "@id": "history/steps.bundle" });
		bundled = true;
	}

	// Every model step and tool call as an action: what ran, with what, on which files, when, and how it ended.
	const summaries = new Map<string, string>();
	for (const e of input.events) if (e.t === "reasoning_summary") summaries.set(e.of, e.text);
	const tools = new Map<string, Ev<"tool">>();
	for (const e of input.events) if (e.t === "tool") tools.set(e.callId, e);
	const contextual = new Map<string, Entity>();
	const entity = (e: Entity) => {
		if (!contextual.has(e["@id"])) contextual.set(e["@id"], e);
		return { "@id": e["@id"] };
	};
	const actions: Entity[] = [];
	let previous = input.events[0]?.at;
	for (const e of input.events) {
		if (e.t === "user") previous = e.at;
		if (e.t !== "assistant") continue;
		const where = input.modelPlaces?.[e.model];
		const model = entity({ "@id": `#model-${e.model}`, "@type": "SoftwareApplication", name: e.model, description: `The model that wrote this step${where ? `, running at ${where}` : ""}.` });
		actions.push({
			"@id": `#step-${e.id}`,
			"@type": "CreateAction",
			name: e.toolCalls?.length ? `Model step: ${e.toolCalls.length} tool call${e.toolCalls.length === 1 ? "" : "s"}` : "Model step: answer",
			instrument: model,
			startTime: previous,
			endTime: e.at,
			actionStatus: e.stop === "error" ? "FailedActionStatus" : "CompletedActionStatus",
			...(summaries.has(e.id) ? { description: summaries.get(e.id) } : {}),
			...(e.error ? { error: e.error } : {}),
		});
		for (const call of e.toolCalls ?? []) {
			const result = tools.get(call.id);
			let args: Record<string, unknown> = {};
			try {
				args = JSON.parse(call.args || "{}") as Record<string, unknown>;
			} catch {
				// The model sent arguments that aren't JSON; the log has them as written.
			}
			const at = p.get(call.id);
			const inputs: { "@id": string }[] = [];
			const outputs: { "@id": string }[] = [];
			if (history && at?.before) {
				const read = blobs(history.store, at.before, named(call.name, args, cwd));
				for (const [path, id] of read) inputs.push(entity({ "@id": `#blob-${id}-${path}`, "@type": "File", name: path, identifier: `git-blob:${id}`, description: "A file this step named, as it was before the step (in the step history)." }));
				if (at.after) {
					const lines = git(history.store, ["diff", "--name-status", "--no-renames", "-z", at.before, at.after]).split("\0").filter(Boolean);
					const paths: string[] = [];
					for (let i = 0; i + 1 < lines.length; i += 2) paths.push(lines[i + 1]!);
					const made = blobs(history.store, at.after, paths);
					for (const path of paths) {
						const id = made.get(path);
						outputs.push(entity(id ? { "@id": `#blob-${id}-${path}`, "@type": "File", name: path, identifier: `git-blob:${id}`, description: "A file this step changed, as it left it (in the step history)." } : { "@id": `#removed-${at.after}-${path}`, "@type": "File", name: path, description: "A file this step removed." }));
					}
				}
			}
			actions.push({
				"@id": `#call-${call.id}`,
				"@type": "CreateAction",
				name: result?.view ? `${result.view.verb} ${result.view.target ?? ""}`.trim() : call.name,
				instrument: entity({ "@id": `#tool-${call.name}`, "@type": "SoftwareApplication", name: call.name, description: "A tool the agent called." }),
				[`${TERMS}model`]: e.model,
				startTime: e.at,
				...(result ? { endTime: result.at } : {}),
				actionStatus: !result ? "PotentialActionStatus" : result.ok ? "CompletedActionStatus" : "FailedActionStatus",
				...(inputs.length ? { object: inputs } : {}),
				...(outputs.length ? { result: outputs } : {}),
				...(result?.decision ? { [`${TERMS}permission`]: result.decision } : {}),
				...(typeof args.command === "string" ? { [`${TERMS}command`]: args.command } : {}),
				...(at?.before ? { [`${TERMS}historyBefore`]: at.before } : {}),
				...(at?.after ? { [`${TERMS}historyAfter`]: at.after } : {}),
				[`${TERMS}arguments`]: call.args,
				...(summaries.has(e.id) ? { description: summaries.get(e.id) } : {}),
			});
		}
		previous = e.at;
	}

	const harness = entity({ "@id": "#enrichedlab", "@type": "SoftwareApplication", name: "EnrichedLab", version: input.version, description: `The agent harness that ran the session, on ${process.platform} ${process.arch}.` });
	const metadata = {
		"@context": `${CRATE}/context`,
		"@graph": [
			{ "@id": "ro-crate-metadata.json", "@type": "CreativeWork", conformsTo: { "@id": CRATE }, about: { "@id": "./" } },
			{
				"@id": "./",
				"@type": "Dataset",
				name: input.summary.title,
				description: `An EnrichedLab session${local ? "" : ` that worked in the ${input.summary.place} sandbox`}: its log with full reasoning, ${copied ? "the files it changed, " : ""}${bundled ? "every kept state of its folder, " : ""}and every model step and tool call with what it read and changed.`,
				datePublished: new Date().toISOString(),
				conformsTo: [{ "@id": PROFILE }],
				hasPart: parts,
				mentions: actions.map((a) => ({ "@id": a["@id"] })),
				publisher: harness,
			},
			{ "@id": PROFILE, "@type": "CreativeWork", name: "Process Run Crate", version: "0.6" },
			...graph,
			...contextual.values(),
			...actions,
		],
	};
	writeFileSync(join(folder, "ro-crate-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
	return { files: copied, actions: actions.length, history: bundled };
}

export interface CheckRow {
	check: string;
	ok: boolean;
	detail: string;
}

/** Check a run package: every file against its checksum, the history bundle, and every content id the steps name. */
export function verifyPackage(folder: string): CheckRow[] {
	const rows: CheckRow[] = [];
	const meta = readPackaged(folder, "ro-crate-metadata.json");
	if (!meta) return [{ check: "metadata", ok: false, detail: "no ro-crate-metadata.json as a plain file in the package" }];
	const graph = (JSON.parse(meta.toString("utf8")) as { "@graph": Entity[] })["@graph"];
	const root = graph.find((e) => e["@id"] === "./");
	rows.push({ check: "metadata", ok: !!root && JSON.stringify(root.conformsTo ?? "").includes(PROFILE), detail: root ? "RO-Crate 1.3, Process Run Crate 0.6" : "no root dataset" });
	let bad = 0;
	let checked = 0;
	for (const e of graph) {
		if (e["@type"] !== "File" || typeof e.sha256 !== "string" || e["@id"].startsWith("#")) continue;
		checked++;
		const bytes = readPackaged(folder, e["@id"]);
		if (!bytes) {
			bad++;
			rows.push({ check: e["@id"], ok: false, detail: "missing, outside the package, or reached through a link" });
		} else if (sha256(bytes) !== e.sha256) {
			bad++;
			rows.push({ check: e["@id"], ok: false, detail: "checksum differs" });
		}
	}
	rows.push({ check: "files", ok: bad === 0, detail: bad ? `${bad} of ${checked} don't match` : `all ${checked} match their checksums` });
	const bundle = packaged(folder, "history/steps.bundle");
	if (existsSync(join(folder, "history", "steps.bundle")) && !bundle) rows.push({ check: "step history", ok: false, detail: "history/steps.bundle isn't a plain file in the package" });
	else if (bundle) {
		const scratch = mkdtempSync(join(tmpdir(), "el-verify-"));
		try {
			const repo = join(scratch, "steps.git");
			const opened = openBundle(bundle, repo);
			rows.push({ check: "step history", ok: opened.ok, detail: opened.ok ? "the bundle opens" : opened.error || "the bundle doesn't open" });
			if (opened.ok) {
				const ids = new Set<string>();
				for (const e of graph) if (typeof e.identifier === "string" && e.identifier.startsWith("git-blob:")) ids.add(e.identifier.slice(9));
				for (const e of graph) for (const key of [`${TERMS}historyBefore`, `${TERMS}historyAfter`]) if (e[key] !== undefined) ids.add(String(e[key]));
				const listed = [...ids];
				const malformed = listed.filter((id) => !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(id));
				const asked = listed.filter((id) => !malformed.includes(id));
				const r = asked.length ? spawnSync("git", [...UNTRUSTED_GIT, "--git-dir", repo, "cat-file", "--batch-check"], { input: `${asked.join("\n")}\n`, encoding: "utf8", env: UNTRUSTED_ENV }) : { status: 0, stdout: "" };
				// Every id asked must come back present, one line each, from a git that finished cleanly.
				const answers = r.stdout.split("\n").filter(Boolean);
				const present = answers.filter((line) => !line.endsWith(" missing")).length;
				const ok = r.status === 0 && !malformed.length && answers.length === asked.length && present === asked.length;
				rows.push({ check: "content ids", ok, detail: ok ? `all ${listed.length} are in the history` : `${malformed.length ? `${malformed.length} malformed; ` : ""}${asked.length - present} of ${asked.length} not found in the history` });
			}
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	} else rows.push({ check: "step history", ok: true, detail: "not included (a lab session, an older one, or packaged without it)" });
	return rows;
}

export interface Reproduced {
	command: string;
	/** Files the step changed then, and whether rerunning it changed them the same way. */
	same: string[];
	differ: { path: string; expected?: string; got?: string }[];
	/** Files the rerun changed that the step didn't. */
	extra: string[];
	exitCode: number | null;
	output: string;
}

const SKIP = [".git", "node_modules", ".venv", "venv", ".pixi", "__pycache__", ".ipynb_checkpoints", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".DS_Store"].flatMap((n) => [`:(exclude,glob)**/${n}`, `:(exclude,glob)**/${n}/**`]);

/**
 * Rerun a command step from the package: its folder as it was just before the step, from the step history, in a
 * scratch folder. The command may come from someone else's package, so it runs contained like any agent command:
 * writes only there and in temp folders, no network, credential folders hidden, no keys or tokens in its
 * environment. Links in the history come out as plain files. `prepare` runs first (e.g. to build the project's
 * environment). Then every file is compared with what the step left. The scratch folder is removed afterwards.
 */
export async function reproduceStep(folder: string, step: string, options: { prepare?: (dir: string) => Promise<void>; timeoutMs?: number } = {}): Promise<Reproduced> {
	const meta = readPackaged(folder, "ro-crate-metadata.json");
	if (!meta) throw new Error("The package has no ro-crate-metadata.json as a plain file.");
	const graph = (JSON.parse(meta.toString("utf8")) as { "@graph": Entity[] })["@graph"];
	const action = graph.find((e) => e["@id"] === step || e["@id"] === `#call-${step}`);
	if (!action) throw new Error(`No step ${step} in this package. Its steps are the #call-… entries in ro-crate-metadata.json.`);
	const command = action[`${TERMS}command`];
	const before = action[`${TERMS}historyBefore`];
	const after = action[`${TERMS}historyAfter`];
	if (typeof command !== "string") throw new Error("That step isn't a command, so there's nothing to rerun (a file edit carries its content in the log).");
	if (typeof before !== "string") throw new Error("The package has no step history from before that step.");
	if (!/^[0-9a-f]{40,64}$/.test(before) || (typeof after === "string" && !/^[0-9a-f]{40,64}$/.test(after))) throw new Error("That step's history points aren't commit ids.");
	const bundle = packaged(folder, "history/steps.bundle");
	if (!bundle) throw new Error("The package has no step history (history/steps.bundle as a plain file).");
	const scratch = mkdtempSync(join(tmpdir(), "el-reproduce-"));
	try {
		const repo = join(scratch, "steps.git");
		const work = join(scratch, "work");
		mkdirSync(work);
		const run = (args: string[], env: Record<string, string> = {}) => {
			const r = spawnSync("git", [...UNTRUSTED_GIT, "--git-dir", repo, "--work-tree", work, ...args], { encoding: "utf8", cwd: work, env: { ...UNTRUSTED_ENV, ...env } });
			if (r.status !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || "").trim()}`);
			return r.stdout;
		};
		const opened = openBundle(bundle, repo);
		if (!opened.ok) throw new Error(`The step history bundle doesn't open: ${opened.error}`);
		mkdirSync(join(repo, "info"), { recursive: true });
		writeFileSync(join(repo, "info", "attributes"), "* -text -eol -filter -ident -working-tree-encoding\n");
		const index = { GIT_INDEX_FILE: join(scratch, "index") };
		run(["read-tree", before], index);
		run(["checkout-index", "-a", "-f"], index);
		await options.prepare?.(work);
		// Its own policy: writes only in the scratch folder (not the system's temp folders), no network, and an
		// environment of a few plain variables, nothing inherited. No facility here: it doesn't run.
		const temp = join(work, ".tmp");
		mkdirSync(temp);
		const launch = contained("/bin/sh", ["-c", command], { writable: [work], network: "none" });
		if (!launch.facility || launch.facility === "restricted-token") throw new Error("This computer can't contain the rerun (it needs Seatbelt on macOS or bubblewrap on Linux), so it didn't run.");
		const env: Record<string, string> = { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", HOME: work, TMPDIR: temp, LANG: process.env.LANG ?? "C.UTF-8", TZ: "UTC" };
		const timeout = options.timeoutMs ?? 600_000;
		const proc = spawnSync(launch.file, launch.args, { cwd: work, env, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
		const ran = { exitCode: proc.status, output: `${proc.stdout ?? ""}${proc.stderr ?? ""}` };
		rmSync(temp, { recursive: true, force: true });
		run(["add", "--all", "--force", "--", ".", ...SKIP], index);
		const now = run(["write-tree"], index).trim();
		const changedNow = run(["diff", "--name-only", "--no-renames", "-z", before, now]).split("\0").filter(Boolean);
		const changedThen = typeof after === "string" ? run(["diff", "--name-only", "--no-renames", "-z", before, after]).split("\0").filter(Boolean) : [];
		const id = (commit: string, path: string) => run(["ls-tree", "-z", commit, "--", `:(literal)${path}`]).split("\t")[0]?.split(" ")[2];
		const same: string[] = [];
		const differ: Reproduced["differ"] = [];
		for (const path of changedThen) {
			const expected = id(after as string, path);
			const got = id(now, path);
			if (expected === got) same.push(path);
			else differ.push({ path, ...(expected ? { expected } : {}), ...(got ? { got } : {}) });
		}
		const extra = changedNow.filter((path) => !changedThen.includes(path));
		return { command, same, differ, extra, exitCode: ran.exitCode, output: ran.output.slice(-4000) };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
