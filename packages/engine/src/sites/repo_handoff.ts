// Moving a git repository between the person's computer and a lab sandbox as git bundles. The send carries
// uncommitted work (secret-looking files stay behind); the fetch brings new sandbox commits back as a local branch.
// Used by the sandbox repo tools and when a session moves to a lab with its work.

import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fetchBundle, identity, packForSend } from "../git.ts";
import { type SandboxApi, SandboxWorkspace, shq } from "./sandbox_workspace.ts";

export interface Sent {
	/** The local repository. */
	repo: string;
	/** The commit sent: new work in the sandbox is everything after it. */
	base: string;
	/** The same work on the person's history; returned commits are made again on it when it differs from `base`. */
	home?: string;
	/** False when only the current files went, because secret-looking files are in the history. */
	history?: boolean;
	/** Short id, used in the folder and branch names. */
	id: string;
	skipped: string[];
}

/** Send `repo` into the sandbox folder `dir` on branch work. */
export async function sendRepo(api: SandboxApi, repo: string, dir: string, signal?: AbortSignal): Promise<Sent & { head: string }> {
	const scratch = await mkdtemp(join(tmpdir(), "enrichedlab-send-"));
	try {
		const bundle = join(scratch, `${basename(repo)}.bundle`);
		const pack = packForSend(repo, bundle);
		const who = identity(repo);
		const placed = await api.put(bundle, signal);
		const unpack = [
			"set -e",
			`mkdir -p ${shq(dir)}`,
			`cd ${shq(dir)}`,
			"git init -q . 2>/dev/null || true",
			`git fetch -q ${shq(placed.path)} ${pack.ref}:refs/heads/work`,
			"git checkout -q -f work",
			// Commits made there are the person's.
			`git config user.name ${shq(who.name)}`,
			`git config user.email ${shq(who.email)}`,
			`rm -f ${shq(placed.path)}`,
			"git log --oneline -1",
		].join("; ");
		const result = await api.run(unpack, 300, signal);
		if (result.exitCode !== 0) throw new Error(`The ${api.title} sandbox couldn't unpack the repository: ${result.stderr || result.stdout}`);
		return { repo, base: pack.commit, home: pack.home, history: pack.history, id: pack.id, skipped: pack.skipped, head: result.stdout.trim() };
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/** Commit what's left in `dir` (as the person) and fetch commits after `sent.base` as local `branch`. */
export async function fetchRepo(api: SandboxApi, dir: string, sent: Pick<Sent, "repo" | "base" | "home">, branch: string, signal?: AbortSignal): Promise<string[]> {
	if (!/^[0-9a-f]{7,64}$/.test(sent.base) || (sent.home !== undefined && !/^[0-9a-f]{7,64}$/.test(sent.home))) throw new Error("The record of what was sent is damaged.");
	const who = identity(sent.repo);
	// Inside the folder, so the fence lets it be written; fetched and removed below.
	const out = `${dir}/.git/enrichedlab-out-${randomBytes(3).toString("hex")}.bundle`;
	// The repository's settings there are the agent's to change, so the whole step (committing what's left, then
	// bundling) runs under the sandbox's fence, with no hook, fsmonitor or signing program. Without the fence it
	// doesn't run.
	const safe = "git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgSign=false";
	const script = [
		"set -e",
		`${safe} add -A`,
		`if ! ${safe} diff-index --cached --quiet HEAD --; then ${safe} -c user.name=${shq(who.name)} -c user.email=${shq(who.email)} commit -q --no-verify -m ${shq(`Work from the ${api.title} sandbox`)}; fi`,
		`if [ "$(${safe} rev-list --count ${sent.base}..work)" = 0 ]; then echo nothing-new; exit 0; fi`,
		`${safe} bundle create -q ${shq(out)} ${sent.base}..work`,
	].join("\n");
	const fenced = await new SandboxWorkspace(api, dir).fencedScript(script);
	if (!fenced) throw new Error(`The ${api.title} sandbox can't fence commands (it needs Landlock ABI 3 or later and a root-owned python3), so the work wasn't packed there. Commit it in the sandbox (that asks), then copy the branch out.`);
	const pack = `cd ${shq(dir)} && ${fenced}`;
	const result = await api.run(pack, 300, signal);
	if (result.exitCode !== 0) throw new Error(`The ${api.title} sandbox couldn't pack the work: ${result.stderr || result.stdout}`);
	if (result.stdout.includes("nothing-new")) return [];
	const scratch = await mkdtemp(join(tmpdir(), "enrichedlab-fetch-"));
	try {
		const local = join(scratch, "work.bundle");
		await api.get(out, local, signal);
		const commits = fetchBundle(sent.repo, local, "refs/heads/work", branch, sent.base, sent.home);
		await api.run(`rm -f ${shq(out)}`, 30).catch(() => undefined);
		return commits;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}
