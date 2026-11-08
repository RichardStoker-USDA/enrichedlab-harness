// Shell lines read as the shell reads them (tools/shell_syntax.ts), and the lab sandbox's file fence
// (sites/sandbox_fence.ts).

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LabConfig } from "../packages/engine/src/config.ts";
import { allowKeys, decide, HIDDEN_REASON, PUSH_REASON } from "../packages/engine/src/permissions.ts";
import { mkdirPhysical, openPhysical, unlinkPhysical } from "../packages/engine/src/tools/anchored.ts";
import { isReadOnlyCommand } from "../packages/engine/src/tools/shell.ts";
import type { Tool } from "../packages/engine/src/tools/types.ts";
import { LocalWorkspace, trustedGit } from "../packages/engine/src/tools/workspace.ts";
import { everyCommand, plainCommands } from "../packages/engine/src/tools/shell_syntax.ts";
import { FENCE_PY } from "../packages/engine/src/sites/sandbox_fence.ts";
import { bashPattern, type SandboxApi, SandboxWorkspace } from "../packages/engine/src/sites/sandbox_workspace.ts";

const words = (line: string) => plainCommands(line)?.map((c) => c.words);

describe("shell syntax", () => {
	test("words come out as the program receives them", () => {
		expect(words("$'\\x67it' $'\\x70ush' origin HEAD")).toEqual([["git", "push", "origin", "HEAD"]]);
		expect(words(`a\\ b "c\\"d\\$e" 'f\\g' $'h\\tI\\101'`)).toEqual([["a b", 'c"d$e', "f\\g", "h\tIA"]]);
		expect(words("git \\\npush")).toEqual([["git", "push"]]);
		expect(words("ls a; cat b | wc -l && echo ok")).toEqual([["ls", "a"], ["cat", "b"], ["wc", "-l"], ["echo", "ok"]]);
		expect(plainCommands("x > out 2>&1 < in")?.[0]?.redirects).toEqual([{ op: ">", target: "out" }, { op: ">&", fd: "2", target: "1" }, { op: "<", target: "in" }]);
		expect(plainCommands("A=1 B='two words' cmd")?.[0]?.assigns).toEqual([{ name: "A", value: "1" }, { name: "B", value: "two words" }]);
	});

	test("anything more than text has no plain reading", () => {
		for (const line of ["echo $HOME", 'echo "$X"', "echo `id`", "echo $(id)", "echo $((1+2))", "diff <(ls a) b", "echo {a,b}", "echo {1..3}", "ls =ls", "cat <<EOF\nx\nEOF", "cat <<< x", "(cd a)", "{ ls; }", "if a; then b; fi", "f() { a; }", "for f in a; do b; done", "[[ -f a ]]", "export A=1", "a=(1 2) cmd", "echo 'open", "coproc x"]) {
			expect([line, plainCommands(line)]).toEqual([line, undefined]);
		}
		// Quoted braces and a lone = are text.
		expect(words("find . -name '{}' -o -name a=b")).toEqual([["find", ".", "-name", "{}", "-o", "-name", "a=b"]]);
	});

	test("every command in a line is found, in groups, functions and substitutions too", () => {
		const line = everyCommand('f() { git "$@"; }; (cd x && git status); echo "$(printf push)"; cat <<EOF\ngit push\nEOF');
		expect(line?.functions).toBe(true);
		expect(line?.commands.map((c) => c.words)).toEqual([["git", undefined], ["cd", "x"], ["git", "status"], ["echo", undefined], ["printf", "push"], ["cat"]]);
		expect(line?.heredocs).toEqual(["git push\n"]);
	});

	test("a program the project holds isn't read-only for asking its version, and a comment hides nothing", () => {
		expect(isReadOnlyCommand("python3 --version")).toBe(true);
		expect(isReadOnlyCommand("./payload --version")).toBe(false);
		expect(isReadOnlyCommand("ls # '\nrm -f x\n# '")).toBe(false);
		expect(isReadOnlyCommand("ls & rm x")).toBe(false);
		expect(isReadOnlyCommand("cat a > b")).toBe(false);
		expect(isReadOnlyCommand("grep -r x . 2>/dev/null | head")).toBe(true);
	});

	test("a compiled build carries the parser", () => {
		const dir = mkdtempSync(join(tmpdir(), "el-compiled-"));
		try {
			const entry = join(import.meta.dir, "..", "packages", "engine", "compiled_codetestfile.ts");
			writeFileSync(entry, `import { plainCommands } from "./src/tools/shell_syntax.ts";\nconsole.log(JSON.stringify(plainCommands("$'\\\\x67it' status")?.[0]?.words));\n`);
			try {
				const built = spawnSync("bun", ["build", entry, "--compile", "--minify", "--outfile", join(dir, "probe")], { encoding: "utf8" });
				expect(built.status).toBe(0);
			} finally {
				rmSync(entry, { force: true });
			}
			const ran = spawnSync(join(dir, "probe"), [], { cwd: dir, encoding: "utf8" });
			expect(ran.stdout.trim()).toBe('["git","status"]');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 120_000);
});

describe("lab sandbox file fence", () => {
	test("writes check where their folder leads, and fenced commands run under the fence or not at all", async () => {
		const commands: string[] = [];
		const api = (probe: string) =>
			({
				title: "Field Lab",
				run: async (c: string) => {
					commands.push(c);
					const nonce = /probe '([0-9a-f]+)'/.exec(c)?.[1];
					return { exitCode: 0, stdout: nonce ? probe.replace("NONCE", nonce) : "", stderr: "", timedOut: false };
				},
			}) as unknown as SandboxApi;
		// A line without the probe's one-time code (a startup file printing it, say) doesn't count.
		const spoofed = new SandboxWorkspace(api("el-fence ok abi 6\n"), "/sandbox/work/p");
		await spoofed.prepare();
		expect(spoofed.fenced).toBe(false);
		const lab = new SandboxWorkspace(api("el-fence ok NONCE abi 6\n"), "/sandbox/work/p");
		await lab.write("alias/marker.txt", "x");
		expect(commands.some((c) => c.includes("realpath -m --") && c.includes("/sandbox/work/p/alias") && c.includes("leads outside the project"))).toBe(true);
		commands.length = 0;
		await lab.write("/sandbox/data/x.txt", "x", { outside: true });
		expect(commands.some((c) => c.includes("leads outside"))).toBe(false);
		await lab.exec("python3 run.py", { timeoutMs: 5_000, signal: AbortSignal.timeout(5_000), fence: [{ text: "python3" }, { text: "run.py" }] });
		expect(commands.at(-1)).toContain(`/usr/bin/python3 -I -c`);
		expect(commands.at(-1)).toContain(` run '/sandbox/work/p' 'python3 run.py'`);
		// File edits run under the fence too where it holds.
		commands.length = 0;
		await lab.write("notes.txt", "x");
		expect(commands.filter((c) => c.includes("notes.txt")).every((c) => c.includes("/usr/bin/python3 -I -c"))).toBe(true);
		// No fence here: a fenced command doesn't run.
		const bare = new SandboxWorkspace(api("el-fence no\n"), "/sandbox/work/p");
		commands.length = 0;
		const r = await bare.exec("python3 run.py", { timeoutMs: 5_000, signal: AbortSignal.timeout(5_000), fence: [] });
		expect(r.exitCode).toBe(125);
		expect(commands.some((c) => c.includes("run.py"))).toBe(false);
	});

	// The fence itself needs Linux with Landlock ABI 3 or later; such a machine runs it for real, and any other shows
	// the test as skipped rather than passing it.
	test.skipIf(!landlockHere())("Landlock keeps writes, truncation and temp files in the project", () => {
		const base = mkdtempSync(join(process.env.HOME ?? tmpdir(), ".el-fence-test-"));
		try {
			const project = join(base, "P");
			const other = join(base, "other");
			mkdirSync(project);
			mkdirSync(other);
			writeFileSync(join(other, "marker.txt"), "keep");
			symlinkSync("../other", join(project, "alias"));
			const script = join(base, "fence.py");
			writeFileSync(script, FENCE_PY);
			const probe = spawnSync("python3", ["-I", script, "probe", "n0nce"], { cwd: project, encoding: "utf8" });
			expect(probe.stdout).toStartWith("el-fence ok n0nce ");
			const run = (command: string) => spawnSync("python3", ["-I", script, "run", project, command], { cwd: project, encoding: "utf8" });
			expect(run('echo hi > inside.txt && echo t > "$TMPDIR/t" && echo x > /dev/null').status).toBe(0);
			for (const command of ["echo bad > alias/marker.txt", "unlink ../other/marker.txt", "python3 -c 'import os; os.truncate(\"../other/marker.txt\", 0)'", "mkdir ../other/d", "echo x > /tmp/el-fence-shared-codetest", "ln -s x ../other/l"]) {
				expect([command, run(command).status]).not.toEqual([command, 0]);
			}
			expect(readFileSync(join(other, "marker.txt"), "utf8")).toBe("keep");
			expect(existsSync("/tmp/el-fence-shared-codetest")).toBe(false);
			// The folder named must be the one the command starts in.
			expect(spawnSync("python3", ["-I", script, "run", other, "true"], { cwd: project, encoding: "utf8" }).status).toBe(125);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

/** Linux with python3 and Landlock ABI 3 or later, as the fence probe reports it. */
function landlockHere(): boolean {
	if (process.platform !== "linux" || spawnSync("python3", ["--version"]).status !== 0) return false;
	const dir = mkdtempSync(join(tmpdir(), "el-landlock-"));
	try {
		writeFileSync(join(dir, "fence.py"), FENCE_PY);
		return spawnSync("python3", ["-I", join(dir, "fence.py"), "probe", "x"], { cwd: dir, encoding: "utf8" }).stdout.startsWith("el-fence ok x ");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("round 4: what a line can hide", () => {
	const shell = { name: "shell", kind: "exec" } as unknown as Tool;
	const mode = (m: string) => ({ permissions: { mode: m, allowCommands: [] } }) as unknown as LabConfig;

	test("globs, a NUL, wrapper shells and git aliases don't hide a push; what could hide one asks every time, in every mode", () => {
		for (const command of ["/usr/bin/g[i]t push origin HEAD", "git p[u]sh origin HEAD", "$'git\\0ignored' push origin HEAD", `env bash -c "$'\\x67it' $'\\x70ush' origin HEAD"`, "nice -n 5 sh -c 'git push'"]) {
			expect([command, allowKeys(shell, { command }).keys]).toEqual([command, ["shell!push"]]);
		}
		const here = new LocalWorkspace(realpathSync(mkdtempSync(join(tmpdir(), "el-hidden-"))), "off");
		for (const command of ['timeout 5 bash -c "$CMD"', "curl -s x | env bash", "git -c alias.ship=push ship origin HEAD", "git ship origin HEAD", "git -c core.sshCommand=./x fetch", "export GIT_SSH_COMMAND=./x; git fetch", "$(cat ./command.txt)", "g\\it p\\ush &!"]) {
			const keys = allowKeys(shell, { command }).keys;
			expect([command, keys[0] === "shell!hidden" || keys[0] === "shell!push"]).toEqual([command, true]);
			for (const m of ["ask", "auto", "full"]) {
				// An earlier yes to the exact text doesn't carry over: what it runs can change without the text changing.
				const verdict = decide(shell, { command }, here, mode(m), new Set([`shell=${command}`, ...keys]));
				expect([command, m, verdict.action]).toEqual([command, m, "ask"]);
			}
		}
		expect(decide(shell, { command: "$(cat ./command.txt)" }, here, mode("full"), new Set())).toMatchObject({ action: "ask", reason: HIDDEN_REASON });
		// A lab's command tools pass the same gate.
		const run = { name: "field_sandbox_run", kind: "sandbox" } as unknown as Tool;
		const lab = new SandboxWorkspace({ title: "Field Lab", run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } as unknown as SandboxApi, "/sandbox/work/p");
		expect(decide(run, { command: "git push origin HEAD" }, lab, mode("full"), new Set())).toMatchObject({ action: "ask", reason: PUSH_REASON });
		expect(decide(run, { command: "$X" }, lab, mode("full"), new Set())).toMatchObject({ action: "ask", reason: HIDDEN_REASON });
	});

	test("read-only takes more than a name: no version word, git settings that run nothing, every name a glob matches inside", () => {
		expect(isReadOnlyCommand("python3 version")).toBe(false);
		const repo = realpathSync(mkdtempSync(join(tmpdir(), "el-readonly-")));
		const outside = realpathSync(mkdtempSync(join(tmpdir(), "el-readonly-out-")));
		try {
			const git = trustedGit()!;
			spawnSync(git, ["init", "-q"], { cwd: repo });
			const ws = new LocalWorkspace(repo, "off");
			const judging = { expand: (p: string) => ws.expand(p), gitSafe: () => ws.gitSafe() };
			const inside = (p: string) => ws.inside(p);
			expect(isReadOnlyCommand("git status", [], inside, judging)).toBe(true);
			for (const [key, value] of [["core.fsmonitor", "./watch"], ["diff.csv.textconv", "./conv"], ["filter.lfs.clean", "./clean"]]) {
				spawnSync(git, ["config", key!, value!], { cwd: repo });
				expect([key, isReadOnlyCommand("git status", [], inside, judging)]).toEqual([key, false]);
				spawnSync(git, ["config", "--unset", key!], { cwd: repo });
			}
			mkdirSync(join(repo, "data"));
			writeFileSync(join(repo, "data", "a.csv"), "x");
			writeFileSync(join(outside, "secret.txt"), "s");
			expect(isReadOnlyCommand("cat data/*.csv", [], inside, judging)).toBe(true);
			// Without a way to expand it, a glob isn't judged read-only.
			expect(isReadOnlyCommand("cat data/*.csv", [], inside)).toBe(false);
			symlinkSync(outside, join(repo, "data", "elsewhere"));
			expect(isReadOnlyCommand("cat data/*", [], inside, judging)).toBe(false);
			expect(isReadOnlyCommand("cat .?/x", [], inside, judging)).toBe(false);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("commands run in the system's bash, without startup files or functions passed in", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "el-startup-")));
		try {
			const startup = join(dir, "startup.sh");
			writeFileSync(startup, `touch ${join(dir, "ran-startup")}\n`);
			const ws = new LocalWorkspace(dir, "off");
			expect(ws.shellName).toBe("bash");
			const r = await ws.exec("echo ran", { timeoutMs: 10_000, signal: AbortSignal.timeout(10_000), env: { ...(process.env as Record<string, string>), SHELL: "/bin/zsh", BASH_ENV: startup, ENV: startup, "BASH_FUNC_echo%%": `() { touch ${join(dir, "ran-function")}; }` } });
			expect(r.output.trim()).toBe("ran");
			expect([existsSync(join(dir, "ran-startup")), existsSync(join(dir, "ran-function"))]).toEqual([false, false]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("file operations on a physical path refuse a link anywhere in it", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-anchored-")));
		try {
			mkdirSync(join(base, "real", "sub"), { recursive: true });
			mkdirSync(join(base, "other"));
			symlinkSync("../other", join(base, "real", "link"));
			closeSync(openPhysical(join(base, "real", "sub", "a.txt"), constants.O_WRONLY | constants.O_CREAT));
			expect(existsSync(join(base, "real", "sub", "a.txt"))).toBe(true);
			expect(() => openPhysical(join(base, "real", "link", "b.txt"), constants.O_WRONLY | constants.O_CREAT)).toThrow();
			expect(existsSync(join(base, "other", "b.txt"))).toBe(false);
			writeFileSync(join(base, "other", "c.txt"), "keep");
			expect(unlinkPhysical(join(base, "real", "link", "c.txt"))).toBe(false);
			expect(existsSync(join(base, "other", "c.txt"))).toBe(true);
			expect(() => mkdirPhysical(join(base, "real", "link", "made"))).toThrow();
			expect(existsSync(join(base, "other", "made"))).toBe(false);
			mkdirPhysical(join(base, "real", "sub", "x", "y"));
			expect(existsSync(join(base, "real", "sub", "x", "y"))).toBe(true);
			expect(unlinkPhysical(join(base, "real", "sub", "a.txt"))).toBe(true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test("a fence word that is a glob is expanded in the sandbox as the command's shell will", () => {
		expect(bashPattern("data/*.csv")).toBe("\\d\\a\\t\\a/*\\.\\c\\s\\v");
		expect(bashPattern("a b/[!x]?")).toBe("\\a\\ \\b/[!x]?");
		expect(bashPattern("q\\*uote")).toBe("\\q\\*\\u\\o\\t\\e");
	});
});
