// Every step's files, kept so the person or the agent can go back to any step and try again (docs/history.md).
//
// A git store of EnrichedLab's own, one per folder, separate from any repository the person keeps there: snapshots
// never touch their branches, index or refs. Each session keeps its own index (so sessions in one folder never wait
// on each other's lock) and its own line of commits, refs/sessions/<id>; objects are shared, so a file kept once is
// kept once. The index remembers each file's size and time, so a snapshot hashes only what changed since the last.
//
// What isn't kept, and says so: files larger than MAX_FILE, new data past MAX_STEP in one snapshot, and folders that
// are rebuilt rather than written (node_modules, virtual environments, caches). Ignore files don't apply: a data
// folder a repository ignores is exactly what a person would want back.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
}

export interface Snapshot {
	commit: string;
	/** False when nothing changed since the session's last snapshot (the commit is that one). */
	changed: boolean;
	/** Files left out: larger than MAX_FILE, or past MAX_STEP. */
	skipped: string[];
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
		const nested = (await this.place.git(["ls-files", "-s", "-z"], this.env())).split("\0").filter((line) => line.startsWith("160000 ")).map((line) => `${line.split("\t")[1]}/ (its own repository)`);
		skipped.push(...nested);
		const tree = await this.place.git(["write-tree"], this.env());
		if (parent && (await this.place.git(["rev-parse", `${parent}^{tree}`])) === tree) return { commit: parent, changed: false, skipped };
		const commit = await this.place.git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", label.slice(0, 200) || "step"], {
			GIT_AUTHOR_NAME: "EnrichedLab",
			GIT_AUTHOR_EMAIL: "history@enrichedlab.invalid",
			GIT_COMMITTER_NAME: "EnrichedLab",
			GIT_COMMITTER_EMAIL: "history@enrichedlab.invalid",
		});
		await this.place.git(["update-ref", this.ref, commit]);
		return { commit, changed: true, skipped };
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
	async restore(target: string, label: string, keep: string[] = []): Promise<{ saved: string; now: string; restored: string[]; removed: string[] }> {
		return locked(this.store, () => this.bringBack(target, label, keep));
	}

	private async bringBack(target: string, label: string, keep: string[]): Promise<{ saved: string; now: string; restored: string[]; removed: string[] }> {
		const present = await this.take(`before going back: ${label}`);
		const saved = present.commit;
		// Files the snapshots couldn't hold, then or now, stay as they are: their bytes were never kept.
		const untouched = new Set([...keep, ...present.skipped]);
		const lines = (await this.place.git(["diff", "--name-status", "--no-renames", "-z", target, saved])).split("\0").filter(Boolean);
		const restored: string[] = [];
		const removed: string[] = [];
		for (let i = 0; i + 1 < lines.length; i += 2) {
			const [status, path] = [lines[i]!, lines[i + 1]!];
			if (untouched.has(path)) continue;
			// Added since the target: it goes. Changed or deleted since: it comes back.
			if (status === "A") removed.push(path);
			else restored.push(path);
		}
		// Removals first, while the folder is as the present snapshot has it: a link the target brings back can't
		// carry a removal outside the folder.
		if (removed.length) await this.place.remove(removed);
		for (let i = 0; i < restored.length; i += 200) {
			await this.place.git(["restore", `--source=${target}`, "--worktree", "--", ...restored.slice(i, i + 200).map((path) => `:(literal)${path}`)], this.env());
		}
		// The index matches the target now (with fresh file times, so the next snapshot hashes only what changes), and
		// the session's line goes on from the present: going back is a step of its own, and the present stays reachable.
		await this.place.git(["read-tree", target], this.env());
		await this.place.git(["update-index", "-q", "--refresh"], this.env()).catch(() => "");
		const now = (await this.take(`went back: ${label}`)).commit;
		return { saved, now, restored, removed };
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
	const run = (args: string[], env: Record<string, string> = {}) =>
		new Promise<string>((resolve, reject) => {
			const child = spawn("git", [...base, ...args], { cwd: folder, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, k === "GIT_INDEX_FILE" ? join(store, v) : v])) } });
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
				// Never through a link: every folder above the file must be a real folder inside this one.
				const parts = path.split("/").slice(0, -1);
				let through = false;
				for (let i = 1; i <= parts.length && !through; i++) through = lstatSync(join(folder, ...parts.slice(0, i)), { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
				if (!through) rmSync(join(folder, path), { force: true });
			}
		},
	};
	return new History(store, place, session, async () => {
		const attributes = join(store, "info", "attributes");
		if (existsSync(join(store, "HEAD"))) {
			if (!existsSync(attributes)) writeFileSync(attributes, RAW_ATTRIBUTES);
			return;
		}
		mkdirSync(store, { recursive: true, mode: 0o700 });
		await new Promise<void>((resolve, reject) => {
			const child = spawn("git", ["init", "--quiet", "--bare", store]);
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

/**
 * git in a lab's sandbox, through its shell: the store sits beside the work at /sandbox/.el-history, so it lives as
 * long as the sandbox's files do.
 */
export function sandboxHistory(exec: (command: string) => Promise<{ exitCode: number | null; output: string }>, folder: string, session: string): History {
	const store = `/sandbox/.el-history/${createHash("sha256").update(folder).digest("hex").slice(0, 20)}`;
	const errors = `/tmp/el-history-err-${session}`;
	// The shell gives one stream back: errors go to a file, read only when a command fails.
	const run = async (command: string) => {
		const result = await exec(`{ ${command} ; } 2>${quote(errors)}`);
		if (result.exitCode !== 0) {
			const said = await exec(`cat ${quote(errors)} 2>/dev/null`).catch(() => ({ output: "" }));
			throw new Error(said.output.trim() || `exit ${result.exitCode}`);
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
			// Only where the file's folder resolves inside this one: never through a link.
			const root = quote(folder);
			for (let i = 0; i < paths.length; i += 200) {
				await run(`cd ${root} && for f in ${paths.slice(i, i + 200).map(quote).join(" ")}; do d=$(cd -P -- "$(dirname -- "$f")" 2>/dev/null && pwd -P) || continue; case "$d" in ${root}|${root}/*) rm -f -- "$f";; esac; done`);
			}
		},
	};
	return new History(store, place, session, async () => {
		await run(`mkdir -p /sandbox/.el-history && { test -f ${quote(`${store}/HEAD`)} || git init --quiet --bare ${quote(store)}; } && mkdir -p ${quote(`${store}/info`)} && printf %s ${quote(RAW_ATTRIBUTES)} > ${quote(`${store}/info/attributes`)}`);
	});
}
