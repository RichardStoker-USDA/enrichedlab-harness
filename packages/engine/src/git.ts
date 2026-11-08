// Git for sessions: a worktree and branch per writing agent, so parallel agents never touch the person's checkout,
// and turn snapshots as commits on a hidden ref, so undo covers shell changes too. Every command here leaves the
// person's index, branch and history alone. See docs/bundles.md.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { inflateSync } from "node:zlib";
import { mkdirPhysical, openPhysical, unlinkPhysical } from "./tools/anchored.ts";
import { contained, engineEnvironment, engineTemp, FULL_CONTAINMENT, GIT_SETTINGS_PATTERNS, physical, projectGitPattern, sandboxer, trustedGit, type CommitTarget } from "./tools/workspace.ts";
import { SECRET_NAME } from "./util.ts";

/**
 * git on the project's own repository. Its settings and attributes are project content (an agent can write them),
 * and some make git run a program (filter and diff drivers, fsmonitor, hooks), so the engine's git runs only under
 * full containment (Seatbelt or bubblewrap): it may write the repository and the temp folders and nothing else, with
 * no network, no keys or tokens in its environment, hooks and fsmonitor off, and the repository's settings, hooks and
 * info folder read only. Where this computer can't contain it, it doesn't run (snapshots and worktrees are off there).
 */
/** `scratch`: folders the call writes (a temporary index, a bundle being made). `readable`: files it only reads. */
function git(cwd: string, args: string[], env?: Record<string, string>, scratch: string[] = [], readable: string[] = []): string {
	const program = trustedGit();
	if (!program) throw new Error("No git from the system's or Homebrew's own folders was found, so the engine's git work didn't run.");
	const full = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args];
	const facility = sandboxer();
	if (!facility || !FULL_CONTAINMENT.has(facility)) throw new Error("This computer has no sandbox for the engine's git work (Seatbelt on macOS, bubblewrap on Linux), so it didn't run.");
	const probeOptions = { cwd, env: engineEnvironment({ ...env, GIT_TERMINAL_PROMPT: "0" }), encoding: "utf8" as const };
	const here = physical(cwd);
	// Where the repository's folders are, asked each time under containment that writes nothing. The answers are
	// project content (a .git file, core.worktree), so they widen what git may write only in layouts git makes itself:
	// the folder's own .git, a repository above it whose .git sits directly in its top folder, or an EnrichedLab
	// worktree inside the repository's .git.
	const within = (p: string, dir: string) => p === dir || p.startsWith(`${dir}${sep}`);
	const scratchFolders = [...scratch, ...(env?.GIT_INDEX_FILE ? [dirname(env.GIT_INDEX_FILE)] : [])].map(physical);
	let writable = [here, ...scratchFolders];
	const probe = contained(program, ["rev-parse", "--show-toplevel", "--git-common-dir"], { writable: [], readable: [here], network: "none" });
	try {
		const [top = "", common = ""] = execFileSync(probe.file, probe.args, { ...probeOptions, stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").map((p) => physical(resolve(cwd, p)));
		if (common === join(top, ".git") && within(here, top)) writable = [...new Set([here, top, common, ...scratchFolders])];
		else if (within(common, here) || within(here, common)) writable = [...new Set([here, common, ...scratchFolders])];
	} catch {
		// Not a repository yet: the folder itself.
	}
	const gitDirs = writable.filter((w) => basename(w) === ".git" || existsSync(join(w, "HEAD"))).concat(writable.map((w) => join(w, ".git")).filter((g) => existsSync(g)));
	const protect = [...new Set(gitDirs)].flatMap((g) => [join(g, "config"), join(g, "hooks"), join(g, "info")]);
	const processTemp = mkdtempSync(join(engineTemp(), "git-run-"));
	writable = [...new Set([...writable, processTemp])];
	const options = { cwd, env: engineEnvironment({ ...env, GIT_TERMINAL_PROMPT: "0", TMPDIR: processTemp, TMP: processTemp, TEMP: processTemp }), encoding: "utf8" as const };
	// Each folder granted as the one just checked (bubblewrap binds it by handle; Seatbelt judges real paths).
	try {
		const launch = contained(program, full, { writable, readable: readable.map(physical), network: "none", exact: true, protect, protectPatterns: GIT_SETTINGS_PATTERNS });
		try {
			return execFileSync(launch.file, launch.args, { ...options, stdio: ["ignore", "pipe", "pipe", ...(launch.pass ?? [])] }).trim();
		} finally {
			launch.release?.();
		}
	} finally {
		rmSync(processTemp, { recursive: true, force: true });
	}
}

/** Run trusted git with only the named write grants. No repository discovery can widen them. */
function exactGit(cwd: string, args: string[], writable: string[], env: Record<string, string> = {}, readable: string[] = [], protect: string[] = [], protectPatterns: string[] = []): string {
	const program = trustedGit();
	if (!program) throw new Error("No git from the system's or Homebrew's own folders was found, so the engine's git work didn't run.");
	const facility = sandboxer();
	if (!facility || !FULL_CONTAINMENT.has(facility)) throw new Error("This computer has no sandbox for the engine's git work (Seatbelt on macOS, bubblewrap on Linux), so it didn't run.");
	const full = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "gc.auto=0", ...args];
	const processTemp = mkdtempSync(join(engineTemp(), "git-run-"));
	try {
		const launch = contained(program, full, { writable: [...writable, processTemp], readable: readable.map(physical), network: "none", exact: true, protect, protectPatterns });
		try {
			return execFileSync(launch.file, launch.args, {
				cwd,
				env: engineEnvironment({ ...env, GIT_TERMINAL_PROMPT: "0", TMPDIR: processTemp, TMP: processTemp, TEMP: processTemp }),
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe", ...(launch.pass ?? [])],
			}).trim();
		} finally {
			launch.release?.();
		}
	} finally {
		rmSync(processTemp, { recursive: true, force: true });
	}
}

/** The repository's top folder, or undefined outside git. */
export function repoRoot(cwd: string): string | undefined {
	try {
		return git(cwd, ["rev-parse", "--show-toplevel"]);
	} catch {
		return undefined;
	}
}

/** A branch name from a session title: lowercase words joined by dashes, under the enrichedlab/ prefix. */
export function branchFor(sessionId: string, title: string): string {
	const words = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
	return `enrichedlab/${words || "session"}-${sessionId.slice(-6)}`;
}

/** Create a worktree on a new branch from the current HEAD. Returns its folder and branch. */
export function createWorktree(root: string, sessionId: string, title: string): { path: string; branch: string } {
	// Made without following a link anywhere on the way (a .git that is a link refuses).
	const dir = join(physical(root), ".git", "enrichedlab-worktrees");
	mkdirPhysical(dir);
	const path = join(dir, sessionId);
	const branch = branchFor(sessionId, title);
	git(root, ["worktree", "add", "-b", branch, path, "HEAD"]);
	return { path, branch };
}

/** Remove a worktree the engine made; refuses folders it didn't make. The branch stays unless `dropBranch`. */
export function removeWorktree(root: string, path: string, branch?: string, dropBranch = false): void {
	// Releases before 0.2 made them under .git/enriched-worktrees.
	if (![join(".git", "enrichedlab-worktrees"), join(".git", "enriched-worktrees")].some((d) => path.includes(d))) throw new Error(`${path} isn't a worktree EnrichedLab made.`);
	git(root, ["worktree", "remove", "--force", path]);
	if (dropBranch && branch) git(root, ["branch", "-D", branch]);
}

/**
 * Snapshot the working tree (tracked and untracked, honoring .gitignore) as a commit on
 * refs/enrichedlab/checkpoints/<session>, through a temporary index so the person's staging area is untouched.
 * Returns the commit id.
 */
export function snapshot(cwd: string, sessionId: string, message: string): string {
	const scratch = mkdtempSync(join(engineTemp(), "git-index-"));
	try {
		const env = { GIT_INDEX_FILE: join(scratch, "index") };
		git(cwd, ["add", "-A", "."], env);
		const tree = git(cwd, ["write-tree"], env);
		const ref = `refs/enrichedlab/checkpoints/${sessionId}`;
		let parent: string | undefined;
		try {
			parent = git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
		} catch {
			parent = undefined;
		}
		const commit = git(cwd, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], {
			GIT_AUTHOR_NAME: "EnrichedLab",
			GIT_AUTHOR_EMAIL: "checkpoints@enrichedlab.invalid",
			GIT_COMMITTER_NAME: "EnrichedLab",
			GIT_COMMITTER_EMAIL: "checkpoints@enrichedlab.invalid",
		});
		git(cwd, ["update-ref", ref, commit]);
		return commit;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** Put the working tree back to a snapshot: changed files restored, files created since removed. Index untouched. */
export function restoreSnapshot(cwd: string, commit: string): string[] {
	const now = snapshot(cwd, "restore-scratch", "before restore");
	const changed = git(cwd, ["diff", "--name-only", commit, now]).split("\n").filter(Boolean);
	if (changed.length) {
		const scratch = mkdtempSync(join(engineTemp(), "git-index-"));
		try {
			const env = { GIT_INDEX_FILE: join(scratch, "index") };
			git(cwd, ["read-tree", commit], env);
			git(cwd, ["checkout-index", "-a", "-f"], env);
			for (const file of changed) {
				const inTarget = git(cwd, ["ls-tree", "--name-only", commit, "--", file]);
				// Removed without following a link anywhere on the way: a folder swapped for one refuses.
				if (!inTarget) unlinkPhysical(join(physical(cwd), file));
			}
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}
	git(cwd, ["update-ref", "-d", "refs/enrichedlab/checkpoints/restore-scratch"]);
	return changed;
}

/** The person's git identity, so work made elsewhere is committed as theirs. */
export function identity(cwd: string): { name: string; email: string } {
	const read = (key: string) => {
		for (const scope of ["--global", "--system"]) try {
			const value = git(cwd, ["config", scope, key]);
			if (value) return value;
		} catch {
			// Try the next person-controlled scope.
		}
		return "";
	};
	return { name: read("user.name") || "EnrichedLab", email: read("user.email") || "enrichedlab@localhost" };
}

/** Validate and install one loose object made in the isolated staging repository. */
function installObject(target: CommitTarget, stage: string, id: string): void {
	const source = join(stage, "objects", id.slice(0, 2), id.slice(2));
	const destination = join(target.commonDir, "objects", id.slice(0, 2), id.slice(2));
	if (existsSync(destination)) return;
	const compressed = readFileSync(source);
	const actual = createHash(target.objectFormat).update(inflateSync(compressed)).digest("hex");
	if (actual !== id) throw new Error(`The staged git object ${id} changed before it could be installed.`);
	mkdirPhysical(dirname(destination));
	const temporary = join(dirname(destination), `.enrichedlab-${randomBytes(8).toString("hex")}`);
	let fd: number | undefined;
	try {
		fd = openPhysical(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o444);
		let offset = 0;
		while (offset < compressed.length) offset += writeSync(fd, compressed, offset);
		closeSync(fd);
		fd = undefined;
		try {
			// link(2) publishes without replacing an object another process installed after the existence check.
			linkSync(temporary, destination);
		} catch (error) {
			if (!existsSync(destination)) throw error;
		}
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(temporary, { force: true });
	}
}

/** Git against the recorded repository, for commands that cannot execute project code. */
function metadataGit(target: CommitTarget, args: string[], env: Record<string, string> = {}): string {
	const protect = [join(target.commonDir, "config"), join(target.commonDir, "hooks"), join(target.commonDir, "info"), join(target.adminDir, "config.worktree")];
	return exactGit(target.worktree, ["--git-dir", target.adminDir, "--work-tree", target.worktree, ...args], [target.commonDir], env, [], protect, GIT_SETTINGS_PATTERNS);
}

/** Stage in an isolated repository, then update only the branch named by the permission decision. */
export function commit(target: CommitTarget, message: string, verify: () => boolean): string {
	if (!verify()) throw new Error("The repository or branch changed after git_commit was allowed, so nothing was committed.");
	const scratch = mkdtempSync(join(engineTemp(), "git-commit-"));
	const stage = join(scratch, "repo.git");
	try {
		exactGit(scratch, ["init", "--quiet", "--bare", `--object-format=${target.objectFormat}`, stage], [scratch]);
		const alternate = join(target.commonDir, "objects");
		const prefix = ["--git-dir", stage, "--work-tree", target.worktree];
		const staged = (args: string[], env: Record<string, string> = {}) => exactGit(target.worktree, [...prefix, ...args], [scratch], { GIT_ALTERNATE_OBJECT_DIRECTORIES: alternate, ...env }, [target.worktree, target.commonDir], [], [projectGitPattern(target.worktree)]);
		staged(["read-tree", target.head]);
		// The staging repository has no project config, hooks or filter definitions. Project files decide what is
		// committed, but cannot start a helper while the real repository metadata is writable.
		staged(["add", "-A", "--", "."]);
		const tree = staged(["write-tree"]);
		if (tree === staged(["rev-parse", `${target.head}^{tree}`])) throw new Error("There are no changes to commit.");
		const who = identity(target.repo);
		const as = { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
		const made = staged(["commit-tree", tree, "-p", target.head, "-m", message], as);
		const objects = staged(["rev-list", "--objects", made, `^${target.head}`]).split("\n").map((line) => line.split(" ", 1)[0]!).filter((id) => new RegExp(`^[0-9a-f]{${target.objectFormat === "sha256" ? 64 : 40}}$`).test(id));
		for (const id of objects) installObject(target, stage, id);
		if (!verify()) throw new Error("The repository or branch changed while git_commit staged the files, so its branch was not updated.");
		metadataGit(target, ["update-ref", "-m", `git_commit: ${message.split("\n", 1)[0]}`, `refs/heads/${target.branch}`, made, target.head]);
		// Match ordinary git commit: the worktree's own index now describes the committed tree.
		metadataGit(target, ["read-tree", made], { GIT_INDEX_FILE: join(target.adminDir, "index") });
		return made;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** Git pathspecs for the names SECRET_NAME matches, so history is searched by name without walking every tree. */
const SECRET_SPECS = [".env", ".env.*", "*.pem", "*.key", "id_*", "credentials", "credentials.json", "*.tfstate", ".netrc", ".npmrc", ".pypirc"].map((g) => `:(glob,icase)**/${g}`);

/** Secret-looking paths anywhere in the history behind `head`, merges included. */
export function secretsInHistory(repo: string, head: string): string[] {
	const out = git(repo, ["log", "--full-history", "-m", "--format=", "--name-only", head, "--", ...SECRET_SPECS]);
	return [...new Set(out.split("\n").filter((f) => f && SECRET_NAME.test(f)))];
}

export interface Pack {
	id: string;
	/** refs/enrichedlab/send/<id>: the commit the bundle carries. */
	ref: string;
	/** The commit sent. */
	commit: string;
	/** The same work on the person's history, secret-looking files they track included: returned work goes on it. */
	home: string;
	/** Secret-looking files left out of the commit sent. */
	skipped: string[];
	/** False when the history stayed here because secret-looking files are in it: the commit sent stands alone. */
	history: boolean;
}

/**
 * The repository as it is now, ready to send elsewhere: HEAD plus one commit holding uncommitted and untracked
 * (not ignored) files, with secret-looking files left out. When any commit behind HEAD holds a secret-looking file,
 * only the current files go, as one commit without history: a bundle carries every object its history reaches.
 * Kept on refs/enrichedlab/send/<id>; the person's index and branch are untouched. Writes the bundle to `bundle`.
 */
export function packForSend(repo: string, bundle: string): Pack {
	const id = randomBytes(4).toString("hex");
	const ref = `refs/enrichedlab/send/${id}`;
	const scratch = mkdtempSync(join(engineTemp(), "git-index-"));
	try {
		const env = { GIT_INDEX_FILE: join(scratch, "index") };
		let head: string | undefined;
		try {
			head = git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]);
		} catch {
			head = undefined;
		}
		if (head) git(repo, ["read-tree", head], env);
		git(repo, ["add", "-A", "."], env);
		const files = git(repo, ["ls-files", "--cached"], env).split("\n").filter(Boolean);
		const skipped = files.filter((f) => SECRET_NAME.test(f));
		for (const file of skipped) git(repo, ["rm", "--cached", "-q", "--", file], env);
		const tree = git(repo, ["write-tree"], env);
		// The person's side: the same tree with the secret-looking files they track put back as HEAD has them, so
		// merging returned work never deletes them. Untracked ones stay untracked.
		for (const file of head ? skipped : []) {
			const entry = git(repo, ["ls-tree", head!, "--", file]);
			const [mode, , blob] = entry.split(/\s+/);
			if (mode && blob) git(repo, ["update-index", "--add", "--cacheinfo", `${mode},${blob},${file}`], env);
		}
		const homeTree = git(repo, ["write-tree"], env);
		const headTree = head ? git(repo, ["rev-parse", `${head}^{tree}`]) : "";
		const who = identity(repo);
		const as = { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
		// A clean tree is HEAD itself; otherwise one commit on top carries the uncommitted work.
		const home = head && homeTree === headTree ? head : git(repo, ["commit-tree", homeTree, ...(head ? ["-p", head] : []), "-m", "Uncommitted work"], as);
		const history = !head || secretsInHistory(repo, head).length === 0;
		const commit = history ? home : git(repo, ["commit-tree", tree, "-m", `The project at ${head!.slice(0, 7)}, without its history (it has files that look like secrets)`], as);
		git(repo, ["update-ref", ref, commit]);
		if (home !== commit) git(repo, ["update-ref", `${ref}-home`, home]);
		git(repo, ["bundle", "create", "-q", bundle, ref], undefined, [dirname(bundle)]);
		return { id, ref, commit, home, skipped, history };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * Bring commits from a bundle in as a new local branch and list the ones after `base`. Nothing else changes. When
 * the work went out as a commit other than `home` (without history, or without tracked secret-looking files), each
 * returned commit is made again on `home`: same message, author and dates, with those files as they were.
 */
export function fetchBundle(repo: string, bundle: string, source: string, branch: string, base: string, home = base): string[] {
	const temp = `refs/enrichedlab/fetch/${randomBytes(4).toString("hex")}`;
	// The bundle is a file EnrichedLab downloaded: only the file transport, never a network or helper transport.
	// A folder would make git start upload-pack there; only a plain file is a bundle.
	if (!isAbsolute(bundle) || !statSync(bundle, { throwIfNoEntry: false })?.isFile()) throw new Error(`${bundle} isn't a bundle file.`);
	// Fetching only reads the bundle: it's granted read only, wherever it sits (bubblewrap's /tmp is private).
	git(repo, ["fetch", "-q", "--no-recurse-submodules", bundle, `${source}:${temp}`], { GIT_ALLOW_PROTOCOL: "file" }, [], [bundle]);
	try {
		const tip = home === base ? git(repo, ["rev-parse", temp]) : rebuild(repo, base, home, temp);
		git(repo, ["update-ref", `refs/heads/${branch}`, tip]);
	} finally {
		git(repo, ["update-ref", "-d", temp]);
	}
	return git(repo, ["log", "--format=%h %s", `${home}..${branch}`]).split("\n").filter(Boolean);
}

/** The commits `from..tip` made again on `onto`, with the files `onto` has and `from` lacks put back. Returns the new tip. */
function rebuild(repo: string, from: string, onto: string, tip: string): string {
	const restore = git(repo, ["diff", "--name-only", "--diff-filter=A", "-z", from, onto]).split("\0").filter(Boolean);
	const scratch = mkdtempSync(join(engineTemp(), "git-rebuild-"));
	const env = { GIT_INDEX_FILE: join(scratch, "index") };
	const made = new Map([[from, onto]]);
	let last = onto;
	try {
		for (const line of git(repo, ["rev-list", "--reverse", "--topo-order", "--parents", `${from}..${tip}`]).split("\n").filter(Boolean)) {
			const [commit, ...parents] = line.split(" ") as [string, ...string[]];
			let tree = git(repo, ["rev-parse", `${commit}^{tree}`]);
			if (restore.length) {
				git(repo, ["read-tree", tree], env);
				for (const file of restore) {
					if (git(repo, ["ls-tree", commit, "--", file])) continue;
					const [mode, , blob] = git(repo, ["ls-tree", onto, "--", file]).split(/\s+/);
					if (mode && blob) git(repo, ["update-index", "--add", "--cacheinfo", `${mode},${blob},${file}`], env);
				}
				tree = git(repo, ["write-tree"], env);
			}
			const [an, ae, ad, cn, ce, cd] = git(repo, ["show", "-s", "--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI", commit]).split("\0");
			const message = git(repo, ["show", "-s", "--format=%B", commit]);
			const who = { GIT_AUTHOR_NAME: an ?? "", GIT_AUTHOR_EMAIL: ae ?? "", GIT_AUTHOR_DATE: ad ?? "", GIT_COMMITTER_NAME: cn ?? "", GIT_COMMITTER_EMAIL: ce ?? "", GIT_COMMITTER_DATE: cd ?? "" };
			last = git(repo, ["commit-tree", tree, ...parents.flatMap((p) => ["-p", made.get(p) ?? p]), "-m", message || "Work from the sandbox"], who);
			made.set(commit, last);
		}
		return last;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** Files that differ between a snapshot and the working tree now. Nothing in the repository changes. */
export function changedSince(cwd: string, commit: string): string[] {
	const now = snapshot(cwd, "compare-scratch", "now");
	try {
		return git(cwd, ["diff", "--name-only", commit, now]).split("\n").filter(Boolean);
	} finally {
		git(cwd, ["update-ref", "-d", "refs/enrichedlab/checkpoints/compare-scratch"]);
	}
}
