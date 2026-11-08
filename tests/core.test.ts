// Focused checks for the parts most likely to break quietly: context derivation, compaction cut points, elision,
// the read-only command check and permission keys, diffs and globs.

import { afterAll, describe, expect, test } from "bun:test";
import type { SessionEvent } from "../packages/protocol/src/index.ts";
import { budget, cutPoint, derive, elisionCandidates, SUMMARY_PREFIX } from "../packages/engine/src/session/context.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LabConfig } from "../packages/engine/src/config.ts";
import { allowKey, allowKeys, canonical, decide, folderAccess, identity } from "../packages/engine/src/permissions.ts";
import { isReadOnlyCommand } from "../packages/engine/src/tools/shell.ts";
import type { Tool } from "../packages/engine/src/tools/types.ts";
import { LocalWorkspace } from "../packages/engine/src/tools/workspace.ts";
import { type SandboxApi, SandboxWorkspace } from "../packages/engine/src/sites/sandbox_workspace.ts";
import { openPort } from "../packages/engine/src/sites/port_proxy.ts";
import { unifiedDiff } from "../packages/engine/src/tools/diff.ts";
import { editTool, globToRegex } from "../packages/engine/src/tools/files.ts";
import { splitBlocks } from "../packages/web/src/lib/blocks.ts";
import { Sites } from "../packages/engine/src/sites/sites.ts";
import { Checkpoints } from "../packages/engine/src/session/checkpoint.ts";
import { findSkills } from "../packages/engine/src/skills.ts";
import { runHooks } from "../packages/engine/src/hooks.ts";

// The shell checks and hooks below are written for sh-style shells; on Windows every command asks.
const posix = process.platform !== "win32";
import { searchTool } from "../packages/engine/src/tools/search.ts";

/** A temporary folder for one test; all of them are removed when the file's tests finish. */
const made: string[] = [];
function scratch(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), `lab-${name}-`));
	made.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const at = "2026-11-03T00:00:00Z";
const user = (text: string): SessionEvent => ({ t: "user", id: `e${n++}`, at, text });
const say = (text: string, calls?: { id: string; name: string; args: string }[]): SessionEvent => ({ t: "assistant", id: `e${n++}`, at, model: "m", text, toolCalls: calls, stop: calls ? "tool_use" : "end" });
const tool = (callId: string, content: string, handle?: string): SessionEvent => ({ t: "tool", id: `e${n++}`, at, callId, name: "read", ok: true, content, handle });

describe("context", () => {
	test("derives messages and answers calls that never finished", () => {
		const events = [user("hi"), say("", [{ id: "c1", name: "read", args: "{}" }]), user("again")];
		const { messages } = derive(events);
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
	});

	test("a compaction replaces older turns with the summary and keeps the tail", () => {
		const events = [user("one"), say("a"), user("two"), say("b")];
		const keep = events[2];
		events.push({ t: "compaction", id: `e${n++}`, at, summary: "## Goal\nx", firstKeptId: keep.id, tokensBefore: 10, model: "m" });
		events.push(user("three"));
		const { messages } = derive(events);
		expect(messages[0].role).toBe("user");
		expect((messages[0] as { content: { text: string }[] }).content[0].text.startsWith(SUMMARY_PREFIX)).toBe(true);
		expect(messages.length).toBe(4);
	});

	test("elision stubs old large outputs and stops replaying earlier reasoning data", () => {
		const big = "x".repeat(5_000);
		const events: SessionEvent[] = [user("1"), say("", [{ id: "c1", name: "read", args: "{}" }]), tool("c1", big, "oabc"), user("2"), say("b"), user("3"), say("c"), user("4")];
		const candidates = elisionCandidates(events);
		expect(candidates.length).toBe(1);
		events.push({ t: "elide", id: `e${n++}`, at, ids: candidates.map((c) => c.id), tokensBefore: 1 });
		const toolMessage = derive(events).messages.find((m) => m.role === "tool") as { content: string };
		expect(toolMessage.content).toContain('handle "oabc"');
	});

	test("cut points land on a turn boundary and keep recent work", () => {
		const events: SessionEvent[] = [];
		for (let i = 0; i < 6; i++) events.push(user(`q${i} ${"w".repeat(4_000)}`), say(`a${i} ${"w".repeat(4_000)}`));
		const derived = derive(events);
		const cut = cutPoint(events, derived, 3_000)!;
		expect(derived.messages[cut].role).toBe("user");
		expect(cut).toBeGreaterThan(0);
	});

	test("with only a few turns, nothing is elided, not even large outputs", () => {
		const events: SessionEvent[] = [user("1"), say("", [{ id: "c9", name: "read", args: "{}" }]), tool("c9", "x".repeat(9_000), "o9"), user("2")];
		expect(elisionCandidates(events)).toEqual([]);
	});

	test("a short history keeps the current turn whole and summarizes what came before", () => {
		const events = [user("one"), say("a"), user("two"), say("b")];
		const derived = derive(events);
		expect(cutPoint(events, derived, 50_000)).toBe(2);
	});

	test("an oversized current turn is cut inside, at a step", () => {
		const events: SessionEvent[] = [user("old"), say("ok"), user("big task")];
		for (let i = 0; i < 8; i++) events.push(say("", [{ id: `b${i}`, name: "read", args: "{}" }]), tool(`b${i}`, "y".repeat(8_000)));
		const derived = derive(events);
		const cut = cutPoint(events, derived, 3_000)!;
		expect(cut).toBeGreaterThan(2);
		expect(derived.messages[cut].role).toBe("assistant");
	});

	test("budget keeps a reserve and honors compactAt", () => {
		expect(budget(262_144).threshold).toBe(262_144 - Math.round(262_144 * 0.15));
		expect(budget(32_768).threshold).toBe(32_768 - 8_192);
		expect(budget(1_000_000, 0.5).threshold).toBe(500_000);
	});
});

describe("shell", () => {
	const root = scratch("shell");
	mkdirSync(join(root, "src"));
	symlinkSync(tmpdir(), join(root, "escape"));
	const ws = new LocalWorkspace(root);
	const inside = (p: string) => ws.inside(p);

	test.if(posix)("everyday reading runs without asking", () => {
		for (const c of [
			"ls -la", "git status && git diff", "rg foo src | head", "cat src/a.txt 2>/dev/null", "node --version",
			"rg 'a|b' src", "git log --oneline -5", "git branch", "git branch -a", "git config --get user.name",
			"find src -name '*.ts'", "sort src/a.txt", "fd ts src", "rg -n '/api/v1' src", "git remote -v", "wc -l < src/a.txt",
		]) expect([c, isReadOnlyCommand(c, [], inside)]).toEqual([c, true]);
	});

	test("anything that writes, runs a program or substitutes asks", () => {
		for (const c of [
			"rm -rf x", "echo hi > f", "git push", "sed -i s/a/b/ f", "find . -delete", "ls $(pwd)", "npm install",
			"echo hi & rm -rf /tmp/x", "env rm -rf x", "sed --in-place s/a/b/ f", "sed -ni p f", "sed 'w out' f",
			"sort -o out f", "uniq in out", "fd -x rm", "fd . -X rm", "rg --pre ./evil x", "yq -i .a=1 f", "PATH=/tmp/evil ls",
			"git branch x", "git remote add o url", "git config diff.external evil", "git config core.hooksPath h",
			"git config user.name foo", "find . -fls out", "git tag v1", "cat $HOME/.ssh/id_ed25519", "echo `id`",
			"git log --output=out", "git -c core.pager=evil log", "ls &", "cat <<EOF", "printenv",
			"echo (New-Item -ItemType File -Path x)", "env sh -c 'touch x'", "(rm -rf x)", "{ rm -rf x; }", "Get-Content @(x)",
		]) expect([c, isReadOnlyCommand(c, [], inside)]).toEqual([c, false]);
	});

	test("reading outside the project asks, through a symlink too", () => {
		for (const c of ["cat ~/.ssh/id_ed25519", "cat /etc/passwd", "head ../other/file", "cat escape/x", "rg key ~/.secrets", "wc -l < /etc/hosts"])
			expect([c, isReadOnlyCommand(c, [], inside)]).toEqual([c, false]);
		expect(ws.inside("src/new_file.ts")).toBe(true);
		expect(ws.inside("escape/anything")).toBe(false);
	});
});

describe("permissions", () => {
	const ws = new LocalWorkspace(scratch("perm"));
	// Grants are saved by real path (folder.access), as the engine saves them.
	const home = realpathSync(ws.root);
	const config = { permissions: { mode: "ask", allowCommands: [] } } as unknown as LabConfig;
	const shell = { name: "shell", kind: "exec" } as unknown as Tool;
	const fetchT = { name: "fetch", kind: "net" } as unknown as Tool;

	test("a file edit allowed for the session doesn't allow browser actions", () => {
		const edit = { name: "edit", kind: "write" } as unknown as Tool;
		const click = { name: "browser_click", kind: "write" } as unknown as Tool;
		expect(allowKey(edit, { path: "a.ts" })).toBe("write");
		expect(allowKey(click, { ref: "e3" })).toBe("write:browser_click");
		const allowed = new Set(["write"]);
		expect(decide(edit, { path: "a.ts" }, ws, config, allowed).action).toBe("run");
		expect(decide(click, { ref: "e3" }, ws, config, allowed)).toMatchObject({ action: "ask", reason: "It clicks in the browser, where you may be signed in.", scope: "clicks in the browser" });
	});

	test("auto mode changes files without asking only in a folder the person let EnrichedLab change", () => {
		const edit = { name: "edit", kind: "write" } as unknown as Tool;
		const click = { name: "browser_click", kind: "write" } as unknown as Tool;
		const auto = (folders?: Record<string, { access: string; at: string }>) => ({ permissions: { mode: "auto", allowCommands: [] }, folders }) as unknown as LabConfig;
		// Not asked yet: the question offers the folder.
		expect(decide(edit, { path: "a.ts" }, ws, auto(), new Set())).toMatchObject({ action: "ask", folder: ws.root });
		expect(decide(edit, { path: "a.ts" }, ws, auto({ [home]: { access: "change", at: "" } }), new Set()).action).toBe("run");
		// A parent folder's answer covers the folders inside it.
		expect(decide(edit, { path: "a.ts" }, ws, auto({ [dirname(home)]: { access: "change", at: "" } }), new Set()).action).toBe("run");
		const readOnly = decide(edit, { path: "a.ts" }, ws, auto({ [home]: { access: "read", at: "" } }), new Set());
		expect(readOnly).toMatchObject({ action: "ask", reason: "It changes a file in a folder you set to read only." });
		expect("folder" in readOnly).toBe(false);
		// A signed-in browser can't be taken back: it asks whatever the folder allows.
		expect(decide(click, { ref: "e3" }, ws, auto({ [home]: { access: "change", at: "" } }), new Set()).action).toBe("ask");
		// What the write lands on decides: a read-only folder inside a folder that may change stays read only.
		mkdirSync(join(ws.root, "raw"), { recursive: true });
		const nested = auto({ [home]: { access: "change", at: "" }, [join(home, "raw")]: { access: "read", at: "" } });
		expect(decide(edit, { path: "raw/data.csv" }, ws, nested, new Set()).action).toBe("ask");
		expect(decide(edit, { path: "notes.md" }, ws, nested, new Set()).action).toBe("run");
		// Contained commands can't be told apart there, so they ask too.
		const sealed = Object.assign(Object.create(ws), { sandboxed: "seatbelt" });
		expect(decide(shell, { command: "touch notes.md" }, sealed, nested, new Set()).action).toBe("ask");
		// The same folder by another spelling (a symlink) is the same folder.
		const link = join(scratch("perm-link-parent"), "link");
		symlinkSync(ws.root, link);
		expect(decide(edit, { path: "raw/data.csv" }, new LocalWorkspace(link), nested, new Set()).action).toBe("ask");
		// A link to a file that doesn't exist yet counts where it points.
		symlinkSync(join(ws.root, "raw", "new.csv"), join(ws.root, "dangling"));
		expect(decide(edit, { path: "dangling" }, ws, nested, new Set()).action).toBe("ask");
		// A read-only answer on / covers everything under it.
		expect(decide(shell, { command: "touch notes.md" }, sealed, auto({ "/": { access: "read", at: "" } }), new Set()).action).toBe("ask");
		// A filled PDF or a new app can land outside the folder: they ask, whatever the folder allows.
		const pdf = { name: "pdf_fill", kind: "write" } as unknown as Tool;
		expect(decide(pdf, { path: "form.pdf", out: "../elsewhere.pdf" }, ws, auto({ [home]: { access: "change", at: "" } }), new Set()).action).toBe("ask");
		// "edits", the older name, reads as auto.
		const edits = { permissions: { mode: "edits", allowCommands: [] }, folders: { [home]: { access: "change", at: "" } } } as unknown as LabConfig;
		expect(decide(edit, { path: "a.ts" }, ws, edits, new Set()).action).toBe("run");
	});

	test("full mode runs everything but a push and an unreviewed lab tool; a session's own mode wins", () => {
		const plain = new LocalWorkspace(scratch("perm-full"), "off");
		const full = { permissions: { mode: "full", allowCommands: [] } } as unknown as LabConfig;
		const unreviewed = { name: "field_new", kind: "site-write", site: "field", unreviewed: true } as unknown as Tool;
		expect(decide(shell, { command: "rm -rf build && curl https://example.org" }, plain, full, new Set()).action).toBe("run");
		expect(decide(shell, { command: "git push origin main" }, plain, full, new Set())).toMatchObject({ action: "ask", keys: ["shell!push"] });
		expect(decide(unreviewed, {}, plain, full, new Set()).action).toBe("ask");
		expect(decide(shell, { command: "rm -rf build" }, plain, config, new Set(), undefined, "full").action).toBe("run");
		expect(decide(shell, { command: "rm -rf build" }, plain, full, new Set(), undefined, "ask").action).toBe("ask");
	});

	test("a lab sandbox whose whole disk is checkpointed runs any command in auto mode", () => {
		const api = { title: "Field Lab", run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } as unknown as SandboxApi;
		const whole = { ...api, checkpoints: () => ({ make: async () => "k1", restore: async () => undefined }) } as unknown as SandboxApi;
		const lab = new SandboxWorkspace(whole, "/sandbox/work/project-1");
		expect(lab.checkpointed).toBe("filesystem");
		const auto = { permissions: { mode: "auto", allowCommands: [] } } as unknown as LabConfig;
		expect(decide(shell, { command: "rm -rf /sandbox/data/raw" }, lab, auto, new Set()).action).toBe("run");
		expect(decide(shell, { command: "rm -rf /sandbox/data/raw" }, new SandboxWorkspace(api, "/sandbox/work/project-1"), auto, new Set()).action).toBe("ask");
	});

	test("in a lab's sandbox, code handed to an interpreter or a quoted script asks: its paths aren't in its words", () => {
		const api = { title: "Field Lab", run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } as unknown as SandboxApi;
		const lab = new SandboxWorkspace(api, "/sandbox/work/project-1");
		const auto = { permissions: { mode: "auto", allowCommands: [] } } as unknown as LabConfig;
		for (const command of ["sh -c 'rm /sandbox/work/other/user-work.txt'", "python3 -c 'import shutil; shutil.rmtree(chr(47)+\"sandbox\")'", "cat list.txt | xargs rm", "awk 'BEGIN{system(\"rm -rf ../other\")}'", "rm 'a b/../../other/x'"]) {
			expect([command, decide(shell, { command }, lab, auto, new Set()).action]).toEqual([command, "ask"]);
		}
		expect(decide(shell, { command: "rm notes.txt && python3 run.py" }, lab, auto, new Set()).action).toBe("run");
	});

	test("auto asks as ask does when the folder's history can't be kept", () => {
		const edit = { name: "edit", kind: "write" } as unknown as Tool;
		const auto = { permissions: { mode: "auto", allowCommands: [] }, folders: { [home]: { access: "change", at: "" } } } as unknown as LabConfig;
		expect(decide(edit, { path: "a.ts" }, ws, auto, new Set()).action).toBe("run");
		expect(decide(edit, { path: "a.ts" }, ws, auto, new Set(), undefined, undefined, false).action).toBe("ask");
	});

	test("a grant to change holds only while its path leads to the folder answered for", () => {
		const parent = realpathSync(scratch("grant"));
		const sub = join(parent, "sub");
		mkdirSync(sub);
		const elsewhere = realpathSync(scratch("elsewhere"));
		const granted = { permissions: { mode: "auto", allowCommands: [] }, folders: { [sub]: { access: "change", at: "", id: identity(sub) } } } as unknown as LabConfig;
		expect(folderAccess(granted, join(sub, "a.txt"))).toBe("change");
		// sub replaced by a link to "/": the grant doesn't follow it anywhere.
		rmSync(sub, { recursive: true });
		symlinkSync("/", sub);
		expect(folderAccess(granted, join(elsewhere, "a.txt"))).toBeUndefined();
		expect(folderAccess(granted, join(sub, "a.txt"))).toBeUndefined();
		// Another folder moved into its place isn't the one answered for either.
		rmSync(sub);
		mkdirSync(sub);
		expect(folderAccess(granted, join(sub, "a.txt"))).toBeUndefined();
	});

	test("a path through a link and then .. is judged where the system takes it", () => {
		const root = realpathSync(scratch("walk"));
		const deep = join(realpathSync(scratch("deep")), "one", "two");
		mkdirSync(deep, { recursive: true });
		symlinkSync(deep, join(root, "link"));
		const local = new LocalWorkspace(root);
		expect(local.inside("link/../x")).toBe(false);
		expect(local.inside("sub/../x")).toBe(true);
		expect(canonical(`${root}/link/../x`)).toBe(join(dirname(deep), "x"));
	});

	test("in a lab's sandbox, commands and file edits in the project run; work comes home as a branch to merge", () => {
		const api = { title: "Field Lab", run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } as unknown as SandboxApi;
		const lab = new SandboxWorkspace(api, "/sandbox/work/project-1");
		const edit = { name: "edit", kind: "write" } as unknown as Tool;
		expect(decide(shell, { command: "cd app && python3 server.py" }, lab, config, new Set()).action).toBe("run");
		expect(decide(edit, { path: "app/index.html" }, lab, config, new Set()).action).toBe("run");
		// Lab data outside the project still asks before a command changes it.
		expect(decide(shell, { command: "rm -rf /sandbox/data/raw" }, lab, config, new Set()).action).toBe("ask");
		// On this computer, without containment, a command that changes things still asks.
		expect(decide(shell, { command: "rm -rf build" }, new LocalWorkspace(scratch("perm-plain"), "off"), config, new Set()).action).toBe("ask");
	});

	test("in Discovery mode, what acts inside the lab runs without asking; this computer, pushes and unreviewed tools still ask", () => {
		const api = { title: "Field Lab", run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } as unknown as SandboxApi;
		const lab = new SandboxWorkspace(api, "/sandbox/work/project-1");
		const labTool = { name: "field_query", kind: "site-write", site: "field" } as unknown as Tool;
		const otherLab = { name: "home_query", kind: "site-write", site: "home" } as unknown as Tool;
		const remember = { name: "remember", kind: "write" } as unknown as Tool;
		const unreviewed = { name: "field_new_method", kind: "site-write", site: "field", unreviewed: true } as unknown as Tool;
		// Without it, changing lab data outside the project and a lab tool that writes both ask.
		expect(decide(shell, { command: "rm -rf /sandbox/data/scratch" }, lab, config, new Set()).action).toBe("ask");
		expect(decide(labTool, {}, lab, config, new Set()).action).toBe("ask");
		expect(decide(shell, { command: "rm -rf /sandbox/data/scratch" }, lab, config, new Set(), "field").action).toBe("run");
		expect(decide(labTool, {}, lab, config, new Set(), "field").action).toBe("run");
		// Another lab's tool, this computer's memory, the web from this computer, a push and an unreviewed tool still ask.
		expect(decide(otherLab, {}, lab, config, new Set(), "field").action).toBe("ask");
		expect(decide(remember, { text: "x" }, lab, config, new Set(), "field").action).toBe("ask");
		expect(decide(fetchT, { url: "https://example.org/" }, lab, config, new Set(), "field").action).toBe("ask");
		expect(decide(shell, { command: "git push origin main" }, lab, config, new Set(), "field").action).toBe("ask");
		expect(decide(unreviewed, {}, lab, config, new Set(), "field").action).toBe("ask");
		// On this computer, Discovery mode changes nothing for the built-in tools.
		expect(decide(shell, { command: "rm -rf build" }, new LocalWorkspace(scratch("perm-discovery"), "off"), config, new Set(), "field").action).toBe("ask");
	});

	test("opening one of the engine's own app ports doesn't ask; other local addresses do", async () => {
		const open = { name: "browser_open", kind: "net" } as unknown as Tool;
		const opened = openPort({ url: (p) => `http://127.0.0.1:9/${p}`, headers: async () => ({}) });
		try {
			expect(decide(open, { url: `${opened.origin}/` }, ws, config, new Set()).action).toBe("run");
			expect(decide(open, { url: "http://127.0.0.1:5432/" }, ws, config, new Set()).action).toBe("ask");
		} finally {
			opened.close();
		}
	});

	test("an answer about a path outside the project covers that path only", () => {
		const write = { name: "write", kind: "write", ask: (a: Record<string, unknown>) => (String(a.path).startsWith("/") ? "It writes outside the project." : undefined) } as unknown as Tool;
		const first = decide(write, { path: "/tmp/one.txt" }, ws, config, new Set());
		expect(first.action).toBe("ask");
		const allowed = new Set(first.action === "ask" ? first.keys : []);
		expect(decide(write, { path: "/tmp/one.txt" }, ws, config, allowed).action).toBe("run");
		expect(decide(write, { path: "/Users/someone/.zshrc" }, ws, config, allowed).action).toBe("ask");
	});

	test("an answer for the session covers each program a command runs, and says so", () => {
		expect(allowKeys(shell, { command: "python3 run.py" })).toEqual({ keys: ["shell:python3"], scope: "“python3” commands" });
		expect(allowKey(shell, { command: "git commit -m x" })).toBe("shell:git commit");
		expect(allowKey(shell, { command: "pytest -q" })).toBe("shell:pytest");
		expect(allowKeys(shell, { command: "cd app && FOO=1 python3 a.py 2>&1 | grep -v x" })).toEqual({ keys: ["shell:python3", "shell:grep"], scope: "“python3” and “grep” commands" });
		expect(allowKeys(shell, { command: "ls 2>/dev/null; make 2>&1 | tee -a log" }).keys).toEqual(["shell:ls", "shell:make", "shell:tee"]);
		expect(allowKeys(shell, { command: "/usr/bin/touch a" }).keys).toEqual(["shell:/usr/bin/touch"]);
		expect(allowKeys(shell, { command: "echo 'a; rm -rf x' | wc -l" }).keys).toEqual(["shell:wc"]);
		// A variable that changes which program runs, or what it loads, is remembered exactly; others pass data.
		for (const command of ["PATH=./bin touch scratch", "LD_PRELOAD=./x.so touch a", "NODE_OPTIONS=--require=./x.js node a.js", "CC=./cc make", "GIT_SSH_COMMAND=./x git fetch", "PYTHONPATH=. python3 a.py", "PATH=./bin; touch a"]) {
			expect([command, allowKeys(shell, { command }).scope]).toEqual([command, "this exact command"]);
		}
		expect(allowKeys(shell, { command: "SEED=42 OMP_NUM_THREADS=8 python3 run.py" }).keys).toEqual(["shell:python3"]);
		expect(allowKeys(shell, { command: "git \\\npush origin main" }).keys).toEqual(["shell!push"]);
		// A full path is the same program for the subcommand rule, and a push is a push however it's quoted.
		expect(allowKeys(shell, { command: "/usr/bin/git status" }).keys).toEqual(["shell:/usr/bin/git status"]);
		for (const command of ["git 'push' origin main", "/usr/bin/git push", "g\\it push", "cd x && git -C . push"]) expect([command, allowKeys(shell, { command }).keys]).toEqual([command, ["shell!push"]]);
		// A redirection before a program still shows the program.
		expect(allowKeys(shell, { command: "touch a; 2>&1 rm -rf ../victim" }).keys).toEqual(["shell:touch", "shell:rm"]);
		// Code the words don't show, output written to a file, control flow, wrappers, programs named by a variable or a
		// relative path, options before a subcommand, and programs that hand the line to something else: exact.
		for (const command of [
			"echo $(curl x)", "echo `id`", "diff <(ls a) <(ls b)", "sudo make install", "ssh host ls", "bash <<EOF", "touch a; : >../victim",
			"echo hi > out.txt", "if true; then touch a; fi", "f() { rm -rf x; }; f", "(cd x && rm y)", "C=touch; $C a", "timeout -s TERM touch a",
			"./tools/touch a", "git -C x reset --hard", "env -S 'rm -rf x'", "echo 'unbalanced",
			"echo safe # '\nrm -f raw/data.csv\n# '", "wc -c <`rm${IFS}-f${IFS}x`", "/usr/bin/env sh -c 'rm x'", "ACTION=reset; git $ACTION --hard",
		])
			expect([command, allowKeys(shell, { command }).scope]).toEqual([command, "this exact command"]);
		// Once both programs are allowed, a different command using them runs; one adding another program asks.
		const plain = new LocalWorkspace(scratch("perm-keys"), "off");
		const allowed = new Set(["shell:python3", "shell:grep"]);
		expect(decide(shell, { command: "python3 other.py | grep y" }, plain, config, allowed).action).toBe("run");
		expect(decide(shell, { command: "python3 other.py | rm y" }, plain, config, allowed)).toMatchObject({ action: "ask", keys: ["shell:python3", "shell:rm"] });
	});

	test("fetch asks once per host and names local addresses", () => {
		const first = decide(fetchT, { url: "https://example.org/a" }, ws, config, new Set());
		expect(first.action).toBe("ask");
		expect(decide(fetchT, { url: "https://example.org/b" }, ws, config, new Set(["net:example.org"])).action).toBe("run");
		const local = decide(fetchT, { url: "http://169.254.169.254/latest" }, ws, config, new Set());
		expect(local.action === "ask" && local.reason).toContain("your network");
	});

	test("local addresses are named in every spelling, and public names that only look alike are not", () => {
		const reason = (url: string) => {
			const verdict = decide(fetchT, { url }, ws, config, new Set());
			return verdict.action === "ask" ? verdict.reason : "";
		};
		const local = ["http://[::ffff:169.254.169.254]/", "http://[64:ff9b::a9fe:a9fe]/", "http://[2002:c0a8:101::1]/", "http://[fd00:ec2::254]/", "http://[fe80::1]:8080/", "http://[::1]/", "http://100.100.100.100/", "http://2852039166/", "http://printer.home.arpa/", "http://172.20.0.1/"];
		for (const url of local) expect(reason(url)).toContain("your network");
		const remote = ["https://fcc.gov/", "https://fdic.gov/", "https://fe80.example.com/", "https://[2606:4700:4700::1111]/", "https://[2002:808:808::1]/", "http://100.128.0.1/", "http://172.32.0.1/"];
		for (const url of remote) expect(reason(url)).not.toContain("your network");
	});

	test.if(posix)("a read-only command outside the project says why it asks", () => {
		const verdict = decide(shell, { command: "cat /etc/hosts" }, ws, config, new Set());
		expect(verdict.action === "ask" && verdict.reason).toBe("It reads outside the project folder.");
	});
});

describe("edit", () => {
	test("CRLF files take LF edits and keep their line endings", async () => {
		const root = scratch("edit");
		const ws = new LocalWorkspace(root);
		await ws.write("a.txt", "one\r\ntwo\r\nthree\r\n");
		const result = await editTool.run({ path: "a.txt", edits: [{ old: "two\nthree", new: "2\n3" }] }, { workspace: ws } as never);
		expect(result.ok).toBe(true);
		expect((await ws.read("a.txt")).toString()).toBe("one\r\n2\r\n3\r\n");
	});
});

describe("diff and glob", () => {
	test("a new file diff counts its lines once", () => {
		const { added, removed } = unifiedDiff("", "hello\n", "f");
		expect([added, removed]).toEqual([1, 0]);
	});
	test("an edit shows one hunk", () => {
		const { diff } = unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "f");
		expect(diff).toContain("-b\n+B");
	});
	test("globs match paths", () => {
		expect(globToRegex("**/*.ts").test("src/a/b.ts")).toBe(true);
		expect(globToRegex("src/*.{js,ts}").test("src/x.js")).toBe(true);
		expect(globToRegex("*.py").test("src/x.py")).toBe(false);
	});
});

describe("streaming blocks", () => {
	test("a blank line outside a code fence ends a block; the tail stays open", () => {
		const text = "# Title\n\nPara one.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nPara two still go";
		const { settled, open } = splitBlocks(text);
		expect(settled).toEqual(["# Title", "Para one.", "```js\nconst a = 1;\n\nconst b = 2;\n```"]);
		expect(open).toBe("Para two still go");
	});
});

describe("sites", () => {
	test("a bound session sees one site; isolated sites stay out of unbound sessions", () => {
		const home = scratch("sites");
		const p = { sites: join(home, "sites.json"), credentials: join(home, "credentials") } as never;
		const sites = new Sites(p, () => undefined);
		sites.add({ name: "home", url: "https://gate.example.org", kind: "gate" });
		sites.add({ name: "research", url: "https://broker.example.org", kind: "gate", isolated: true });
		const model = (provider: string) => ({ source: "site", provider }) as never;
		expect(sites.allows(model("home"))).toBe(true);
		expect(sites.allows(model("research"))).toBe(false);
		expect(sites.allows(model("research"), "research")).toBe(true);
		expect(sites.allows(model("home"), "research")).toBe(false);
		// An isolated site's sessions use its models only; other bound sessions may still use the person's own.
		expect(sites.allows({ source: "local", provider: "ollama" } as never, "research")).toBe(false);
		expect(sites.allows({ source: "local", provider: "ollama" } as never, "home")).toBe(true);
	});

	test("a lab that says it keeps data inside is isolated, however it was joined, and stays so while offline", async () => {
		const { SITE_KINDS } = await import("../packages/engine/src/sites/adapter.ts");
		const home = scratch("sites-inside");
		writeFileSync(join(home, "lab.key"), "k");
		const p = { home, run: join(home, "run"), sites: join(home, "sites.json"), credentials: join(home, "credentials") } as never;
		SITE_KINDS.inside = () =>
			({ descriptor: { contract: "2026-11", name: "research", title: "Research Lab", policy: { keep_data_inside: true } }, models: [], tools: [], sandboxOn: false, connect: async () => undefined, describe: () => "Research Lab", detach: async () => undefined, close: async () => undefined }) as never;
		try {
			const sites = new Sites(p, () => undefined);
			sites.add({ name: "research", url: "https://research.example.org", kind: "inside", lan: { url: "https://10.0.0.9", keyFile: join(home, "lab.key") } });
			expect(sites.isolated("research")).toBe(false);
			expect((await sites.connect("research")).isolated).toBe(true);
			expect(sites.allows({ source: "local", provider: "ollama" } as never, "research")).toBe(false);
			// A later start that can't reach the lab still treats it as isolated.
			expect(new Sites(p, () => undefined).isolated("research")).toBe(true);
		} finally {
			delete SITE_KINDS.inside;
		}
	});
});

describe("checkpoints", () => {
	test("restoring puts every file back as it was before the earliest change, and removes new files", () => {
		const root = scratch("undo");
		const store = new Checkpoints(join(root, ".checkpoints"));
		const a = join(root, "a.txt");
		const b = join(root, "b.txt");
		writeFileSync(a, "one");
		const first = store.capture([a, b]);
		writeFileSync(a, "two");
		writeFileSync(b, "new");
		const second = store.capture([a]);
		writeFileSync(a, "three");
		expect(store.restore([first, second]).sort()).toEqual([a, b].sort());
		expect(readFileSync(a, "utf8")).toBe("one");
		expect(existsSync(b)).toBe(false);
	});
});

describe("skills, hooks and search", () => {
	test("skills come from SKILL.md front matter; a project skill replaces a personal one of the same name", () => {
		const root = scratch("skills");
		for (const [dir, description] of [["personal/review", "personal"], ["project/review", "project"], ["project/plots", "Make figures"]] as const) {
			mkdirSync(join(root, dir), { recursive: true });
			writeFileSync(join(root, dir, "SKILL.md"), `---\nname: ${dir.split("/")[1]}\ndescription: ${description}\n---\n\nSteps.`);
		}
		const skills = findSkills([join(root, "personal"), join(root, "project")]);
		expect(skills.map((s) => `${s.name}:${s.description}`)).toEqual(["plots:Make figures", "review:project"]);
	});

	test.if(posix)("a before-tool hook that exits 2 blocks the call with its message", async () => {
		const outcome = await runHooks([{ match: "shell", command: "echo 'no deploys from here' >&2; exit 2" }], { tool: "shell", args: { command: "deploy" } }, tmpdir());
		expect(outcome.blocked).toBe("no deploys from here");
		expect((await runHooks([{ match: "edit", command: "exit 2" }], { tool: "shell", args: {} }, tmpdir())).blocked).toBeUndefined();
	});

	test("web search asks once per provider host", () => {
		const tool = searchTool({ provider: "brave", keyFile: "/nonexistent" });
		expect(allowKey(tool, { query: "x" })).toBe("net:api.search.brave.com");
	});
});

describe("sandbox", () => {
	test.if(posix)("sandboxed commands run without asking; unsandboxed ones go through the usual question", () => {
		const config = { permissions: { mode: "ask", allowCommands: [] } } as unknown as LabConfig;
		const shell = { name: "shell", kind: "exec" } as unknown as Tool;
		const ws = { sandboxed: "seatbelt", inside: () => true } as never;
		expect(decide(shell, { command: "npm test" }, ws, config, new Set()).action).toBe("run");
		expect(decide(shell, { command: "npm install", unsandboxed: true }, ws, config, new Set()).action).toBe("ask");
	});
});

describe("second review", () => {
	const ws = new LocalWorkspace(scratch("r2"));
	const inside = (p: string) => ws.inside(p);
	const config = { permissions: { mode: "ask", allowCommands: [] } } as unknown as LabConfig;
	const read = { name: "read", kind: "read", ask: (a: { path?: string }) => (ws.inside(String(a.path)) ? undefined : "outside") } as unknown as Tool;

	test("other accounts' homes and paths given as patterns or flag values ask", () => {
		for (const c of ["cat ~rich/.ssh/id_rsa", "grep -f /etc/passwd README.md", "rg -f /etc/hosts .", "fd --search-path /etc passwd", "echo safe # '\nrm -f raw/data.csv\n# '"])
			expect([c, isReadOnlyCommand(c, [], inside)]).toEqual([c, false]);
	});

	test("an outside read allowed for the session isn't asked again", () => {
		const first = decide(read, { path: "/etc/hosts" }, ws, config, new Set());
		expect(first.action).toBe("ask");
		const keys = first.action === "ask" ? first.keys : [];
		expect(decide(read, { path: "/etc/hosts" }, ws, config, new Set(keys)).action).toBe("run");
	});

	test.if(posix)("a sandboxed command still asks when it names a path outside the project", () => {
		const shell = { name: "shell", kind: "exec" } as unknown as Tool;
		const sandboxed = Object.assign(Object.create(ws), { sandboxed: "seatbelt" });
		expect(decide(shell, { command: "make test" }, sandboxed, config, new Set()).action).toBe("run");
		expect(decide(shell, { command: "cat ~/.ssh/id_rsa" }, sandboxed, config, new Set()).action).toBe("ask");
		expect(decide(shell, { command: "cat $HOME/.ssh/id_rsa" }, sandboxed, config, new Set()).action).toBe("ask");
	});
});

describe("git", () => {
	test("snapshots leave the index alone and restore shell-made changes; worktrees get their own branch", async () => {
		const { execFileSync } = await import("node:child_process");
		const { snapshot, restoreSnapshot, createWorktree, removeWorktree } = await import("../packages/engine/src/git.ts");
		const root = scratch("git");
		const run = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
		run("init", "-q", "-b", "main");
		run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start");
		writeFileSync(join(root, "a.txt"), "one");
		run("add", "a.txt");
		const before = snapshot(root, "s1", "turn 1");
		writeFileSync(join(root, "a.txt"), "two");
		writeFileSync(join(root, "new.txt"), "made by a shell command");
		expect(restoreSnapshot(root, before).sort()).toEqual(["a.txt", "new.txt"]);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one");
		expect(existsSync(join(root, "new.txt"))).toBe(false);
		expect(run("diff", "--cached", "--name-only")).toBe("a.txt");
		const wt = createWorktree(root, "s0abc123", "Fix the parser");
		expect(wt.branch).toBe("enrichedlab/fix-the-parser-abc123");
		expect(existsSync(wt.path)).toBe(true);
		removeWorktree(root, wt.path, wt.branch, true);
		expect(existsSync(wt.path)).toBe(false);
	}, 30_000);
});

describe("git push", () => {
	test("a push asks even after the person allowed it for the session", () => {
		const ws = new LocalWorkspace(scratch("push"));
		const config = { permissions: { mode: "ask", allowCommands: [] } } as unknown as LabConfig;
		const shell = { name: "shell", kind: "exec" } as unknown as Tool;
		expect(allowKey(shell, { command: "git push origin main" })).toBe("shell!push");
		expect(decide(shell, { command: "git push origin main" }, ws, config, new Set(["shell!push"])).action).toBe("ask");
		const full = { permissions: { mode: "full", allowCommands: [] } } as unknown as LabConfig;
		expect(decide(shell, { command: "git push origin main" }, ws, full, new Set()).action).toBe("ask");
	});
});

describe("own-branch commits", () => {
	test.if(posix)("in a session's own worktree, add and commit run; push, amend and commits elsewhere ask", () => {
		const config = { permissions: { mode: "ask", allowCommands: [] } } as unknown as LabConfig;
		const shell = { name: "shell", kind: "exec" } as unknown as Tool;
		const repo = scratch("own");
		const tree = join(repo, ".git", "enrichedlab-worktrees", "w1");
		mkdirSync(tree, { recursive: true });
		const own = new LocalWorkspace(tree);
		const plain = new LocalWorkspace(repo);
		const run = (ws: LocalWorkspace, command: string) => decide(shell, { command }, ws, config, new Set()).action;
		expect(run(own, "git add -A && git commit -m 'Fix the parser'")).toBe("run");
		expect(run(own, "git commit --amend -m x")).toBe("ask");
		expect(run(own, "git push origin HEAD")).toBe("ask");
		expect(run(plain, "git commit -m 'Fix the parser'")).toBe("ask");
	});
});

describe("repository handoff", () => {
	test("send carries uncommitted work without secrets; fetch returns new commits as a branch", async () => {
		const { execFileSync } = await import("node:child_process");
		const { packForSend, fetchBundle } = await import("../packages/engine/src/git.ts");
		const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" }).trim();
		// The person's global ignore rules (often .env already) mustn't decide this test.
		const saved = { global: process.env.GIT_CONFIG_GLOBAL, xdg: process.env.XDG_CONFIG_HOME };
		process.env.GIT_CONFIG_GLOBAL = "/dev/null";
		process.env.XDG_CONFIG_HOME = scratch("xdg");
		const repo = scratch("send");
		git(repo, "init", "-q", "-b", "main");
		writeFileSync(join(repo, "a.txt"), "one\n");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "start");
		writeFileSync(join(repo, "a.txt"), "two\n");
		writeFileSync(join(repo, ".env"), "TOKEN=x\n");
		const bundle = join(scratch("bundle"), "r.bundle");
		const sent = packForSend(repo, bundle);
		expect(sent.skipped).toEqual([".env"]);
		const far = scratch("far");
		git(far, "init", "-q");
		git(far, "fetch", "-q", bundle, `${sent.ref}:refs/heads/work`);
		git(far, "checkout", "-q", "work");
		// git may check files out with CRLF on Windows.
		expect(readFileSync(join(far, "a.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("two\n");
		expect(existsSync(join(far, ".env"))).toBe(false);
		writeFileSync(join(far, "b.txt"), "made far away\n");
		git(far, "add", ".");
		git(far, "commit", "-q", "-m", "Add b");
		const back = join(far, "..", `${sent.id}.bundle`);
		git(far, "bundle", "create", "-q", back, `${sent.commit}..work`);
		expect(fetchBundle(repo, back, "refs/heads/work", "enrichedlab/far", sent.commit).map((l) => l.split(" ").slice(1).join(" "))).toEqual(["Add b"]);
		expect(git(repo, "branch", "--show-current")).toBe("main");
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("two\n");
		for (const [key, value] of [["GIT_CONFIG_GLOBAL", saved.global], ["XDG_CONFIG_HOME", saved.xdg]] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}, 30_000);
});

describe("bundles", () => {
	const base = { permissions: { mode: "ask", allowCommands: [] }, mcpServers: { mine: { url: "https://mine.example/mcp" } }, models: {}, skills: { dirs: [] }, instructions: { global: [] }, hooks: {} } as unknown as LabConfig;

	test("both layouts install, and their skills, instructions, servers and hooks join the person's settings", async () => {
		const { installBundle, listBundles, applyBundles, readBundle } = await import("../packages/engine/src/bundles.ts");
		const { paths } = await import("../packages/engine/src/paths.ts");
		const p = paths(scratch("bundles"));
		const own = scratch("own-bundle");
		mkdirSync(join(own, "skills", "plots"), { recursive: true });
		writeFileSync(join(own, "skills", "plots", "SKILL.md"), "---\nname: plots\ndescription: Make plots\n---\n");
		writeFileSync(join(own, "AGENTS.md"), "Use metric units.\n");
		writeFileSync(join(own, "bundle.json"), JSON.stringify({ name: "lab-basics", version: "1.2.0", instructions: "AGENTS.md", mcpServers: { mine: { url: "https://other" }, tools: { command: "${BUNDLE_ROOT}/bin/serve" } } }));
		const plugin = scratch("plugin");
		mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
		mkdirSync(join(plugin, "hooks"), { recursive: true });
		writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "formatter", version: "0.3.0" }));
		writeFileSync(join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/fmt.sh" }] }] } }));
		installBundle(p, own);
		installBundle(p, plugin);
		expect(listBundles(p).map((b) => `${b.name} ${b.version}`)).toEqual(["formatter 0.3.0", "lab-basics 1.2.0"]);
		const merged = applyBundles(base, listBundles(p));
		const basics = join(p.bundles, "lab-basics");
		expect(merged.skills.dirs).toEqual([join(basics, "skills")]);
		expect(merged.instructions.global).toEqual([join(basics, "AGENTS.md")]);
		expect(merged.mcpServers.mine).toEqual({ url: "https://mine.example/mcp" });
		expect(merged.mcpServers.tools).toEqual({ command: join(basics, "bin", "serve") });
		expect(merged.hooks.afterTool).toEqual([{ match: "write|edit", command: join(p.bundles, "formatter", "fmt.sh"), timeout: undefined }]);
		expect(readBundle(join(p.bundles, "formatter")).name).toBe("formatter");
	});

	test("a site's bundles can't run programs here, apply to isolated sessions only, and leave when ungranted", async () => {
		const { syncSiteBundles, listBundles, applyBundles } = await import("../packages/engine/src/bundles.ts");
		const { paths } = await import("../packages/engine/src/paths.ts");
		const p = paths(scratch("site-bundles"));
		const manifest = { name: "assays", version: "2", mcpServers: { lims: { url: "https://lims.example/mcp" }, local: { command: "/bin/sh" } }, hooks: { beforeTool: [{ command: "/bin/sh -c 'curl x'" }] } };
		const grant = { name: "assays", version: "2", files: [{ path: "bundle.json", content: JSON.stringify(manifest) }, { path: "skills/qc/SKILL.md", content: "---\nname: qc\n---\n" }] };
		expect(() => syncSiteBundles(p, "research", [{ ...grant, files: [{ path: "../escape.txt", content: "x" }] }])).toThrow();
		syncSiteBundles(p, "research", [grant]);
		const bundles = listBundles(p);
		expect(bundles.map((b) => [b.name, b.source])).toEqual([["research.assays", "site:research"]]);
		const open = applyBundles(base, bundles);
		expect(Object.keys(open.mcpServers).sort()).toEqual(["lims", "mine"]);
		expect(open.hooks.beforeTool).toEqual([]);
		expect(applyBundles(base, bundles, ["research"]).skills.dirs).toEqual([]);
		expect(applyBundles(base, bundles, ["research"], "research").skills.dirs).toHaveLength(1);
		syncSiteBundles(p, "research", []);
		expect(listBundles(p)).toEqual([]);
	});
});

describe("memory", () => {
	test("remember adds a dated line to the project's notes outside the repository, and refuses secrets", async () => {
		const { rememberTool, readNotes, notesPath } = await import("../packages/engine/src/memory.ts");
		const home = scratch("memory-home");
		const saved = process.env.EL_HOME;
		process.env.EL_HOME = home;
		try {
			const project = scratch("memory-project");
			const ctx = { project } as never;
			await rememberTool.run({ note: "Run tests with pixi run test" }, ctx);
			expect(readNotes(project)).toContain("- Run tests with pixi run test (");
			expect(notesPath(project).startsWith(home)).toBe(true);
			await expect(rememberTool.run({ note: "api_key = sk-abcdefghijklmnop" }, ctx)).rejects.toThrow();
		} finally {
			if (saved === undefined) delete process.env.EL_HOME;
			else process.env.EL_HOME = saved;
		}
	});
});

describe("lab invites", () => {
	test("an invite link from a lab's /join page gives its address, short name and title", async () => {
		const { parseInvite } = await import("../packages/engine/src/sites/invite.ts");
		// Gate encodes the title with the url crate: spaces as +, & as %26.
		expect(parseInvite("enrichedlab://join?url=https%3A%2F%2Fgate.fieldlab.example.org&name=fieldlab&title=Test+%26+Lab")).toEqual({ url: "https://gate.fieldlab.example.org", name: "fieldlab", title: "Test & Lab", isolated: undefined });
		expect(parseInvite("enrichedlab://join?url=https://gate.whnrc.example.edu/join&name=WHNRC Lab&isolated=1")).toEqual({ url: "https://gate.whnrc.example.edu", name: "whnrc-lab", title: undefined, isolated: true });
	});

	test("a lab's own address works too, named from its host; anything not https is refused", async () => {
		const { parseInvite } = await import("../packages/engine/src/sites/invite.ts");
		expect(parseInvite("https://gate.whnrc.example.edu/join")).toEqual({ url: "https://gate.whnrc.example.edu", name: "whnrc" });
		expect(parseInvite("https://gate.fieldlab.example.org")).toEqual({ url: "https://gate.fieldlab.example.org", name: "fieldlab" });
		expect(parseInvite("http://gate.fieldlab.example.org")).toBeUndefined();
		expect(parseInvite("enrichedlab://join?url=http://evil.example")).toBeUndefined();
		expect(parseInvite("enrichedlab://open?url=https://gate.fieldlab.example.org")).toBeUndefined();
		expect(parseInvite("not a link")).toBeUndefined();
	});
});

describe("repository handoff with secret-looking files in the history", () => {
	test("only the current files go; returned work comes home on the person's history with their tracked files", async () => {
		const { execFileSync } = await import("node:child_process");
		const { packForSend, fetchBundle } = await import("../packages/engine/src/git.ts");
		const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" }).trim();
		const saved = { global: process.env.GIT_CONFIG_GLOBAL, xdg: process.env.XDG_CONFIG_HOME };
		process.env.GIT_CONFIG_GLOBAL = "/dev/null";
		process.env.XDG_CONFIG_HOME = scratch("xdg");
		const repo = scratch("history");
		git(repo, "init", "-q", "-b", "main");
		writeFileSync(join(repo, "a.txt"), "one\n");
		mkdirSync(join(repo, "keys"));
		writeFileSync(join(repo, "keys", "id_ed25519"), "PRIVATE KEY\n");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "start, with a key by mistake");
		git(repo, "rm", "-q", "keys/id_ed25519");
		writeFileSync(join(repo, ".env.example"), "TOKEN=\n");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "Drop the key, add an example");
		writeFileSync(join(repo, "a.txt"), "two\n");
		const bundle = join(scratch("bundle"), "r.bundle");
		const sent = packForSend(repo, bundle);
		expect(sent.history).toBe(false);
		expect(sent.skipped).toEqual([".env.example"]);
		// Nothing the bundle carries reaches the key or the example.
		const far = scratch("far-history");
		git(far, "init", "-q");
		git(far, "fetch", "-q", bundle, `${sent.ref}:refs/heads/work`);
		git(far, "checkout", "-q", "work");
		const objects = git(far, "rev-list", "--objects", "--all");
		expect(objects).not.toContain("id_ed25519");
		expect(objects).not.toContain(".env.example");
		expect(git(far, "rev-list", "--count", "work")).toBe("1");
		writeFileSync(join(far, "b.txt"), "made far away\n");
		git(far, "add", ".");
		git(far, "commit", "-q", "-m", "Add b");
		const back = join(far, "..", `${sent.id}-h.bundle`);
		git(far, "bundle", "create", "-q", back, `${sent.commit}..work`);
		expect(fetchBundle(repo, back, "refs/heads/work", "enrichedlab/far", sent.commit, sent.home).map((l) => l.split(" ").slice(1).join(" "))).toEqual(["Add b"]);
		// The branch grows from main, keeps the tracked example, and carries the work.
		expect(git(repo, "merge-base", "--is-ancestor", "main", "enrichedlab/far")).toBe("");
		expect(git(repo, "show", "enrichedlab/far:.env.example")).toBe("TOKEN=");
		expect(git(repo, "show", "enrichedlab/far:b.txt")).toBe("made far away");
		expect(git(repo, "log", "-1", "--format=%s", "enrichedlab/far")).toBe("Add b");
		expect(git(repo, "branch", "--show-current")).toBe("main");
		for (const [key, value] of [["GIT_CONFIG_GLOBAL", saved.global], ["XDG_CONFIG_HOME", saved.xdg]] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}, 30_000);
});
