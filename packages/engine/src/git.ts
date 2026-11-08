// Git for sessions: a worktree and branch per writing agent, so parallel agents never touch the person's checkout,
// and turn snapshots as commits on a hidden ref, so undo covers shell changes too. Every command here leaves the
// person's index, branch and history alone. See docs/bundles.md.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { contained, trustedGit } from "./tools/workspace.ts";
import { SECRET_NAME } from "./util.ts";

/** Each repository's folders git may write: the working folder, its top, and its git folders (main and worktree). */
const writableFor = new Map<string, string[]>();

/**
 * git on the project's own repository. Its settings and attributes are project content (an agent can write them),
 * and some make git run a program (filter and diff drivers, fsmonitor, hooks), so the engine's git runs contained
 * like the agent's commands: it may write the repository and nothing else, with no network. Hooks and fsmonitor are
 * off as well. Where this computer has no facility, it runs as before with those two turned off.
 */
function git(cwd: string, args: string[], env?: Record<string, string>): string {
	const program = trustedGit() ?? "git";
	const full = [program, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args];
	const options = { cwd, env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" }, encoding: "utf8" as const, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
	let writable = writableFor.get(cwd);
	if (!writable) {
		// Asked once per folder, contained to writing nothing: where the repository's folders are. Those answers come
		// from project content (a .git file, core.worktree), so they widen what git may write only in the layouts git
		// makes itself: the folder's own .git, a repository above it whose .git sits directly in its top folder, or an
		// EnrichedLab worktree inside the repository's .git.
		const probe = contained(full[0]!, ["rev-parse", "--show-toplevel", "--git-common-dir"], { writable: [], network: "none" });
		const real = (p: string) => {
			try {
				return realpathSync(p);
			} catch {
				return resolve(p);
			}
		};
		const within = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
		const here = real(cwd);
		writable = [cwd];
		try {
			const [top = "", common = ""] = execFileSync(probe.file, probe.args, options).trim().split("\n").map((p) => real(resolve(cwd, p)));
			if (common === join(top, ".git") && within(here, top)) writable = [cwd, top, common];
			else if (within(common, here) || within(here, common)) writable = [cwd, common];
		} catch {
			// Not a repository yet (git init comes next): the folder itself.
		}
		writableFor.set(cwd, writable);
	}
	// Where nothing contains it, the repository's filter drivers are turned off instead: none of them runs.
	if (!contained(full[0]!, [], { writable: [], network: "none" }).facility) {
		const names = (() => {
			try {
				return execFileSync(program, ["config", "--name-only", "--get-regexp", "^filter\\."], options).split("\n");
			} catch {
				return [];
			}
		})();
		const drivers = [...new Set(names.map((n) => /^filter\.(.+)\.[^.]+$/.exec(n.trim())?.[1]).filter((d): d is string => Boolean(d)))];
		const off = drivers.flatMap((d) => ["-c", `filter.${d}.clean=`, "-c", `filter.${d}.smudge=`, "-c", `filter.${d}.process=`, "-c", `filter.${d}.required=false`]);
		return execFileSync(program, [...full.slice(1, 5), ...off, ...full.slice(5)], options).trim();
	}
	const launch = contained(full[0]!, full.slice(1), { writable, network: "none" });
	return execFileSync(launch.file, launch.args, options).trim();
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
	const dir = join(root, ".git", "enrichedlab-worktrees");
	mkdirSync(dir, { recursive: true });
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
	const scratch = mkdtempSync(join(tmpdir(), "enrichedlab-index-"));
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
		const scratch = mkdtempSync(join(tmpdir(), "enrichedlab-index-"));
		try {
			const env = { GIT_INDEX_FILE: join(scratch, "index") };
			git(cwd, ["read-tree", commit], env);
			git(cwd, ["checkout-index", "-a", "-f"], env);
			for (const file of changed) {
				const inTarget = git(cwd, ["ls-tree", "--name-only", commit, "--", file]);
				if (!inTarget && existsSync(join(cwd, file))) rmSync(join(cwd, file), { force: true });
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
		try {
			return git(cwd, ["config", key]);
		} catch {
			return "";
		}
	};
	return { name: read("user.name") || "EnrichedLab", email: read("user.email") || "enrichedlab@localhost" };
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
	const scratch = mkdtempSync(join(tmpdir(), "enrichedlab-index-"));
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
		git(repo, ["bundle", "create", "-q", bundle, ref]);
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
	git(repo, ["fetch", "-q", bundle, `${source}:${temp}`]);
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
	const scratch = mkdtempSync(join(tmpdir(), "enrichedlab-rebuild-"));
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
