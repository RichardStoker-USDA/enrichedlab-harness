// Every step's files, kept so the person or the agent can go back to any step and try again (docs/history.md).
//
// A git store of EnrichedLab's own, one per folder, separate from any repository the person keeps there: snapshots
// never touch their branches, index or refs. Each session keeps its own index (so sessions in one folder never wait
// on each other's index) and its own line of commits, refs/sessions/<id>; objects are shared, so a file kept once is
// kept once. The index remembers each file's size and time, so a snapshot hashes only what changed since the last.
//
// What isn't kept, and says so: files larger than MAX_FILE, new data past MAX_STEP in one snapshot, and folders that
// are rebuilt rather than written (node_modules, virtual environments, caches). Ignore files don't apply: a data
// folder a repository ignores is exactly what a person would want back. Each commit names what it left out (its
// "el-kept-out" line), so going back to it, or from it, never deletes or overwrites what it couldn't hold.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeEmptyTreePhysical, unlinkPhysical } from "../tools/anchored.ts";
import { engineEnvironment, physical, trustedGit } from "../tools/workspace.ts";

/** Files larger than this aren't kept (25 MB, as the per-file copies before). */
export const MAX_FILE = 25 * 1024 * 1024;
/** New data one snapshot adds at most (1 GB): the first snapshot of a large data folder stops here and says so. */
export const MAX_STEP = 1024 * 1024 * 1024;

/** Attributes off in the store, so files come back byte for byte (no line-ending or filter conversions). */
export const RAW_ATTRIBUTES = "* -text -eol -filter -ident -working-tree-encoding\n";

/** One snapshot or restore at a time per store: sessions in one folder share its work tree. */
const locks = new Map<string, Promise<unknown>>();
function locked<T>(key: string, work: () => Promise<T>): Promise<T> {
	const before = locks.get(key) ?? Promise.resolve();
	const next = before.catch(() => undefined).then(work);
	locks.set(key, next.catch(() => undefined));
	return next;
}

/** Folders rebuilt by tools rather than written by hand, left out of every snapshot. */
const REBUILT = [".git", "node_modules", ".venv", "venv", ".pixi", "__pycache__", ".ipynb_checkpoints", ".Rproj.user", "renv/library", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".DS_Store", ".el-history"];

/** Where git runs: on this computer, or in a lab's sandbox through its shell. Paths are relative to the work tree. */
export interface GitPlace {
	git(args: string[], env?: Record<string, string>): Promise<string>;
	sizes(paths: string[]): Promise<Map<string, number>>;
	remove(paths: string[]): Promise<void>;
	/** Of these paths, the folders (not links) holding a file or link somewhere inside. */
	occupied(paths: string[]): Promise<Set<string>>;
	/** Remove these paths where they're folders holding only empty folders (never a file). */
	clearEmpty(paths: string[]): Promise<void>;
}

export interface Snapshot {
	commit: string;
	/** False when nothing changed since the session's last snapshot (the commit is that one). */
	changed: boolean;
	/** Files left out: larger than MAX_FILE, or past MAX_STEP. */
	skipped: string[];
	/** Repositories inside the folder: kept as a pointer, not their files. */
	nested: string[];
}

const KEPT_OUT = "el-kept-out: ";

export interface Restored {
	/** The present, kept just before going back. */
	saved: string;
	/** The folder after going back. */
	now: string;
	restored: string[];
	removed: string[];
	/** Differed, but left as they are: never kept, or a folder holding what was never kept. */
	left: string[];
}

/** True when `path` is `other`, inside it, or holds it. */
function overlaps(path: string, other: string): boolean {
	return path === other || path.startsWith(`${other}/`) || other.startsWith(`${path}/`);
}

export class History {
	private ready?: Promise<void>;

	constructor(
		/** The store, for its lock. */
		private store: string,
		private place: GitPlace,
		/** The session whose line of commits this is. */
		private session: string,
		/** Run once before first use (makes the store); absent when the place makes it itself. */
		private init?: () => Promise<void>,
		/** The session's own index file inside the store. */
		private index = `index-${session}`,
	) {}

	private get ref(): string {
		return `refs/sessions/${this.session}`;
	}

	private env(): Record<string, string> {
		return { GIT_INDEX_FILE: this.index };
	}

	private async prepare(): Promise<void> {
		this.ready ??= (this.init?.() ?? Promise.resolve()).catch((error) => {
			this.ready = undefined;
			throw error;
		});
		await this.ready;
	}

	/** The session's newest snapshot, if it has one. */
	async head(): Promise<string | undefined> {
		await this.prepare();
		const found = await this.place.git(["rev-parse", "--verify", "--quiet", this.ref]).catch(() => "");
		return found || undefined;
	}

	/** Keep the folder as it is now. */
	snapshot(label: string): Promise<Snapshot> {
		return locked(this.store, () => this.take(label));
	}

	private async take(label: string): Promise<Snapshot> {
		await this.prepare();
		const parent = await this.head();
		const excluded = REBUILT.flatMap((name) => [`:(exclude,glob)**/${name}`, `:(exclude,glob)**/${name}/**`]);
		// What changed since this session's index last looked, with sizes, so large files and runaway data stay out.
		const candidates = (await this.place.git(["ls-files", "-z", "--modified", "--others", "--", ".", ...excluded], this.env()))
			.split("\0")
			.filter(Boolean);
		const sizes = candidates.length ? await this.place.sizes(candidates) : new Map<string, number>();
		const skipped: string[] = [];
		let budget = MAX_STEP;
		for (const path of candidates) {
			// A name with a line break can't be measured through every shell: left out, and said so.
			if (path.includes("\n")) {
				skipped.push(path);
				continue;
			}
			const size = sizes.get(path);
			if (size === undefined) continue;
			if (size > MAX_FILE || size > budget) skipped.push(path);
			else budget -= size;
		}
		const left = skipped.map((path) => `:(exclude,literal)${path}`);
		await this.place.git(["add", "--all", "--force", "--", ".", ...excluded, ...left], this.env());
		// A repository inside the folder is kept as a pointer, not its files: said so.
		const nested = (await this.place.git(["ls-files", "-s", "-z"], this.env())).split("\0").filter((line) => line.startsWith("160000 ")).map((line) => line.slice(line.indexOf("\t") + 1));
		// Files kept out earlier and unchanged since aren't listed again by git: the parent's list carries them on.
		const before = parent ? await this.keptOut(parent) : [];
		const listed = new Set([...candidates, ...skipped, ...nested]);
		const still = before.filter((path) => !listed.has(path));
		const out = [...new Set([...skipped, ...nested, ...(await this.present(still))])].sort();
		const tree = await this.place.git(["write-tree"], this.env());
		const same = parent && (await this.place.git(["rev-parse", `${parent}^{tree}`])) === tree && JSON.stringify(out) === JSON.stringify(before);
		if (parent && same) return { commit: parent, changed: false, skipped, nested };
		const message = `${label.slice(0, 200) || "step"}${out.length ? `\n\n${KEPT_OUT}${JSON.stringify(out)}` : ""}`;
		const commit = await this.place.git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], {
			GIT_AUTHOR_NAME: "EnrichedLab",
			GIT_AUTHOR_EMAIL: "history@enrichedlab.invalid",
			GIT_COMMITTER_NAME: "EnrichedLab",
			GIT_COMMITTER_EMAIL: "history@enrichedlab.invalid",
		});
		await this.place.git(["update-ref", this.ref, commit]);
		return { commit, changed: true, skipped, nested };
	}

	/**
	 * What a snapshot left out, from its own message. A message that can't be read fails the caller: going back
	 * without knowing what was left out could overwrite it.
	 */
	async keptOut(commit: string): Promise<string[]> {
		const body = await this.place.git(["log", "-1", "--format=%B", commit]);
		const line = body.split("\n").find((l) => l.startsWith(KEPT_OUT));
		if (!line) return [];
		const list: unknown = JSON.parse(line.slice(KEPT_OUT.length));
		if (!Array.isArray(list)) throw new Error(`snapshot ${commit.slice(0, 10)} names what it left out in a form this version can't read`);
		return list.filter((p): p is string => typeof p === "string");
	}

	/** Of paths kept out before, the ones still on disk (a file or folder). */
	private async present(paths: string[]): Promise<string[]> {
		if (!paths.length) return [];
		const sizes = await this.place.sizes(paths);
		const folders = await this.place.occupied(paths);
		return paths.filter((path) => sizes.has(path) || folders.has(path));
	}

	/** Paths that differ between two snapshots. */
	async changes(from: string, to: string): Promise<string[]> {
		await this.prepare();
		return (await this.place.git(["diff", "--name-only", "--no-renames", "-z", from, to])).split("\0").filter(Boolean);
	}

	/**
	 * Put the folder back as it was at `target`. The present is kept first, so going back can itself be undone; files
	 * the snapshots never held (too large, rebuilt folders) are left as they are.
	 */
	async restore(target: string, label: string, keep: string[] = []): Promise<Restored> {
		return locked(this.store, () => this.bringBack(target, label, keep));
	}

	private async bringBack(target: string, label: string, keep: string[]): Promise<Restored> {
		const present = await this.take(`before going back: ${label}`);
		const saved = present.commit;
		// What either snapshot couldn't hold stays as it is, with whatever holds it or sits inside it: those bytes were
		// never kept, so neither overwritten nor removed.
		const untouched = [...new Set([...keep, ...present.skipped, ...present.nested, ...(await this.keptOut(target)), ...(await this.keptOut(saved))])];
		const lines = (await this.place.git(["diff", "--name-status", "--no-renames", "-z", target, saved])).split("\0").filter(Boolean);
		const restored: string[] = [];
		const removed: string[] = [];
		const left: string[] = [];
		for (let i = 0; i + 1 < lines.length; i += 2) {
			const [status, path] = [lines[i]!, lines[i + 1]!];
			if (untouched.some((kept) => overlaps(path, kept))) {
				left.push(path);
				continue;
			}
			// Added since the target: it goes. Changed or deleted since: it comes back.
			if (status === "A") removed.push(path);
			else restored.push(path);
		}
		// Removals first, while the folder is as the present snapshot has it: a link the target brings back can't
		// carry a removal outside the folder.
		if (removed.length) await this.place.remove(removed);
		// A file coming back where a folder still holds something (files never kept, a rebuilt folder) would take the
		// folder with it: that one stays.
		const blocked = await this.place.occupied(restored);
		left.push(...blocked);
		restored.splice(0, restored.length, ...restored.filter((path) => !blocked.has(path)));
		// Folders left empty by the removals give way to the file coming back.
		await this.place.clearEmpty(restored);
		for (let i = 0; i < restored.length; i += 200) {
			await this.place.git(["restore", `--source=${target}`, "--worktree", "--", ...restored.slice(i, i + 200).map((path) => `:(literal)${path}`)], this.env());
		}
		// The index matches the target now (with fresh file times, so the next snapshot hashes only what changes), and
		// the session's line goes on from the present: going back is a step of its own, and the present stays reachable.
		await this.place.git(["read-tree", target], this.env());
		await this.place.git(["update-index", "-q", "--refresh"], this.env()).catch(() => "");
		const now = (await this.take(`went back: ${label}`)).commit;
		return { saved, now, restored, removed, left };
	}
}

/** Where a folder's store lives on this computer: one per folder, named for its path. */
export function storeFor(root: string, folder: string): string {
	return join(root, createHash("sha256").update(folder).digest("hex").slice(0, 20));
}

/** git on this computer, for a folder here. The store keeps a note of which folder it holds. */
export function localHistory(storeRoot: string, folder: string, session: string): History {
	const store = storeFor(storeRoot, folder);
	const base = ["--git-dir", store, "--work-tree", folder, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.autocrlf=false", "-c", "core.quotepath=false", "-c", "gc.auto=0"];
	const program = trustedGit();
	const clean = engineEnvironment({
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_ATTR_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
	});
	const run = (args: string[], env: Record<string, string> = {}) =>
		new Promise<string>((resolve, reject) => {
			if (!program) return reject(new Error("No trusted system git was found, so step history is off."));
			const child = spawn(program, [...base, ...args], { cwd: folder, env: { ...clean, ...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, k === "GIT_INDEX_FILE" ? join(store, v) : v])) } });
			const out: Buffer[] = [];
			const err: Buffer[] = [];
			child.stdout.on("data", (d: Buffer) => out.push(d));
			child.stderr.on("data", (d: Buffer) => err.push(d));
			child.on("error", reject);
			child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out).toString("utf8").replace(/\n$/, "")) : reject(new Error(`git ${args[0]}: ${Buffer.concat(err).toString("utf8").trim()}`))));
		});
	const place: GitPlace = {
		git: run,
		async sizes(paths) {
			const sizes = new Map<string, number>();
			for (const path of paths) {
				try {
					const info = statSync(join(folder, path));
					if (info.isFile()) sizes.set(path, info.size);
				} catch {
					// Gone since it was listed.
				}
			}
			return sizes;
		},
		async remove(paths) {
			for (const path of paths) {
				// One anchored unlink. A folder or a link swapped into any parent makes it fail.
				unlinkPhysical(join(physical(folder), path));
			}
		},
		async occupied(paths) {
			// True when a folder holds anything but folders, however deep.
			const holds = (dir: string): boolean => readdirSync(dir, { withFileTypes: true }).some((entry) => !entry.isDirectory() || holds(join(dir, entry.name)));
			const found = new Set<string>();
			for (const path of paths) {
				const info = lstatSync(join(folder, path), { throwIfNoEntry: false });
				if (info?.isDirectory() && holds(join(folder, path))) found.add(path);
			}
			return found;
		},
		async clearEmpty(paths) {
			for (const path of paths) removeEmptyTreePhysical(join(physical(folder), path));
		},
	};
	return new History(store, place, session, async () => {
		if (!program) throw new Error("No trusted system git was found, so step history is off.");
		const attributes = join(store, "info", "attributes");
		if (existsSync(join(store, "HEAD"))) {
			if (!existsSync(attributes)) writeFileSync(attributes, RAW_ATTRIBUTES);
			return;
		}
		mkdirSync(store, { recursive: true, mode: 0o700 });
		await new Promise<void>((resolve, reject) => {
			const child = spawn(program, ["init", "--quiet", "--bare", store], { env: clean });
			child.on("error", reject);
			child.on("close", (code) => (code === 0 ? resolve() : reject(new Error("git init failed"))));
		});
		writeFileSync(join(store, "description"), `EnrichedLab history of ${folder}\n`);
		mkdirSync(join(store, "info"), { recursive: true });
		writeFileSync(join(store, "info", "attributes"), RAW_ATTRIBUTES);
	});
}

/** Quote a word for a POSIX shell. */
function quote(word: string): string {
	return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Wrap a lab history removal in its current fence when that fence holds. */
export async function fencedHistoryRemoval(script: string, fencedScript?: (script: string) => Promise<string | undefined>): Promise<string | undefined> {
	return fencedScript?.(script);
}

/**
 * git in a lab's sandbox, through its shell: the store sits beside the work at /sandbox/.el-history, so it lives as
 * long as the sandbox's files do.
 */
export function sandboxHistory(exec: (command: string) => Promise<{ exitCode: number | null; output: string }>, folder: string, session: string, fencedScript?: (script: string) => Promise<string | undefined>): History {
	const store = `/sandbox/.el-history/${createHash("sha256").update(folder).digest("hex").slice(0, 20)}`;
	// The shell gives one stream back: errors go to a file of their own, made fresh by mktemp (never a name someone
	// could have put a link at), and come back only when the command fails.
	const run = async (command: string) => {
		const result = await exec(`e=$(mktemp) || exit 97; { ${command} ; } 2>"$e"; s=$?; if [ $s -ne 0 ]; then head -c 4000 "$e"; fi; rm -f "$e"; exit $s`);
		if (result.exitCode !== 0) {
			const said = result.output.trim().split("\n").slice(-20).join("\n");
			throw new Error(said || `exit ${result.exitCode}`);
		}
		return result.output.replace(/\n$/, "");
	};
	const base = `git --git-dir=${quote(store)} --work-tree=${quote(folder)} -c core.hooksPath=/dev/null -c core.autocrlf=false -c core.quotepath=false -c gc.auto=0`;
	const place: GitPlace = {
		git: (args, env = {}) => {
			const vars = Object.entries(env)
				.map(([k, v]) => `${k}=${quote(k === "GIT_INDEX_FILE" ? `${store}/${v}` : v)}`)
				.join(" ");
			return run(`cd ${quote(folder)} && ${vars ? `${vars} ` : ""}${base} ${args.map(quote).join(" ")}`);
		},
		async sizes(paths) {
			const sizes = new Map<string, number>();
			for (let i = 0; i < paths.length; i += 200) {
				const out = await run(`cd ${quote(folder)} && stat --printf '%s\\t%n\\0' -- ${paths.slice(i, i + 200).map(quote).join(" ")} 2>/dev/null || true`);
				for (const entry of out.split("\0")) {
					const tab = entry.indexOf("\t");
					if (tab > 0) sizes.set(entry.slice(tab + 1), Number(entry.slice(0, tab)));
				}
			}
			return sizes;
		},
		async remove(paths) {
			// The fence closes the check-to-remove race when it holds in this sandbox.
			const root = quote(folder);
			for (let i = 0; i < paths.length; i += 200) {
				const script = `cd ${root} && for f in ${paths.slice(i, i + 200).map(quote).join(" ")}; do [ -d "$f" ] && [ ! -L "$f" ] && continue; d=$(cd -P -- "$(dirname -- "$f")" 2>/dev/null && pwd -P) || continue; case "$d" in ${root}|${root}/*) rm -f -- "$f";; esac; done`;
				const fenced = await fencedHistoryRemoval(script, fencedScript);
				if (fenced) await run(fenced);
			}
		},
		async occupied(paths) {
			const found = new Set<string>();
			for (let i = 0; i < paths.length; i += 200) {
				const out = await run(`cd ${quote(folder)} && for f in ${paths.slice(i, i + 200).map(quote).join(" ")}; do if [ -d "$f" ] && [ ! -L "$f" ] && [ -n "$(find "./$f" -mindepth 1 ! -type d -print -quit 2>/dev/null)" ]; then printf '%s\\0' "$f"; fi; done`);
				for (const path of out.split("\0")) if (path) found.add(path);
			}
			return found;
		},
		async clearEmpty(paths) {
			for (let i = 0; i < paths.length; i += 200) {
				const script = `cd ${quote(folder)} && for f in ${paths.slice(i, i + 200).map(quote).join(" ")}; do if [ -d "$f" ] && [ ! -L "$f" ]; then find "./$f" -depth -type d -empty -delete 2>/dev/null; fi; done; true`;
				const fenced = await fencedHistoryRemoval(script, fencedScript);
				if (fenced) await run(fenced);
			}
		},
	};
	return new History(store, place, session, async () => {
		await run(`mkdir -p /sandbox/.el-history && { test -f ${quote(`${store}/HEAD`)} || git init --quiet --bare ${quote(store)}; } && mkdir -p ${quote(`${store}/info`)} && printf %s ${quote(RAW_ATTRIBUTES)} > ${quote(`${store}/info/attributes`)}`);
	});
}
