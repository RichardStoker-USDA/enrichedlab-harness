// Shell lines read as the shell reads them (tools/shell_syntax.ts), and the lab sandbox's file fence
// (sites/sandbox_fence.ts).

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, readdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { LabConfig } from "../packages/engine/src/config.ts";
import { inEnvironment, type EnvironmentInstaller } from "../packages/engine/src/apps/environments.ts";
import { allowKeys, decide, HIDDEN_REASON, PUSH_REASON, windowsInterpreterHandoff } from "../packages/engine/src/permissions.ts";
import { restoreSnapshot, snapshot } from "../packages/engine/src/git.ts";
import { holdGitEntries, mkdirPhysical, openPhysical, removeEmptyTreePhysical, unlinkPhysical } from "../packages/engine/src/tools/anchored.ts";
import { allowedCommand, isReadOnlyCommand } from "../packages/engine/src/tools/shell.ts";
import type { Tool } from "../packages/engine/src/tools/types.ts";
import { contained, containedTempEnvironment, createEngineWriteGrant, engineEnvironment, engineTemp, gitQuarantineFolder, gitQuarantineMarker, LocalWorkspace, privateBindPath, projectGitPaths, projectGitPattern, recoverGitQuarantine, safeTemp, sandboxer, trustedGit } from "../packages/engine/src/tools/workspace.ts";
import { everyCommand, everyPowerShellCommand, plainCommands } from "../packages/engine/src/tools/shell_syntax.ts";
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

	test("PowerShell keeps native Windows paths intact and fails closed on dynamic command words", () => {
		expect(everyPowerShellCommand(String.raw`C:\Tools\Git\cmd\git.exe push origin main`)?.commands[0]?.words).toEqual([String.raw`C:\Tools\Git\cmd\git.exe`, "push", "origin", "main"]);
		expect(everyPowerShellCommand(String.raw`& 'C:\Program Files\Git\bin\Git.exe' push origin main`)?.commands[0]?.words).toEqual([String.raw`C:\Program Files\Git\bin\Git.exe`, "push", "origin", "main"]);
		expect(everyPowerShellCommand("Write-Output x#; git push")?.commands.map((command) => command.words)).toEqual([["Write-Output", "x#"], ["git", "push"]]);
		expect(everyPowerShellCommand(String.raw`& $program push origin main`)).toBeUndefined();
		for (const command of ["<##> git push", '& "`u{0067}it" push', "& 'g'+'it' push", "powershell.exe -EncodedCommand Z2l0IHB1c2g="]) {
			expect([command, everyPowerShellCommand(command)]).toEqual([command, undefined]);
		}
		for (const command of [
			"cmd.exe /c powershell.exe -EncodedCommand ZwBpAHQAIABwAHUAcwBoAA==",
			"env powershell.exe -ec ZwBpAHQAIABwAHUAcwBoAA==",
			"env.exe powershell.exe -ec ZwBpAHQAIABwAHUAcwBoAA==",
			"xargs.exe pwsh.exe -EncodedCommand ZwBpAHQAIABwAHUAcwBoAA==",
			"saps powershell.exe -ArgumentList '-EncodedCommand ZwBpAHQAIABwAHUAcwBoAA=='",
			"saps cmd.exe -ArgumentList '/d /c g^it p^ush origin main'",
			"Start-Process -FilePath cmd.exe -ArgumentList @('/d','/c','g^it p^ush origin main')",
			"start -Fi cmd.exe -Arg '/d /c g^it p^ush origin main'",
			"saps -Path cmd.exe -Args '/d /c g^it p^ush origin main'",
			`Start-Process -ArgumentList '"push" origin main' -FilePath git.exe`,
			"Start-Process git -ArgumentList push,origin,main",
			"saps cmd.exe -ArgumentList @('/d',$unreadable)",
			"saps cmd.exe -ArgumentList ‘/c g^it p^ush origin main’",
			"Write-Output safe^value",
			`iex '& ("g"+"it") ("p"+"ush") origin main'`,
			"Invoke-Expression 'git push origin main'",
			"cmd.exe /d /c g^it p^ush origin main",
			"bash -lc 'git push origin main'",
			"wsl git push origin main",
			"pwsh -NoProfile -Command 'git push origin main'",
		]) expect([command, windowsInterpreterHandoff(command)]).toEqual([command, true]);
		for (const quote of "‘’‚‛“”„") expect(windowsInterpreterHandoff(`Write-Output ${quote}safe${quote}`)).toBe(true);
		for (const command of ["Write-Output safe", "Write-Output powershell", "git status", "git -e path", "cmd.exe /?", "sh script.sh", "saps cmd.exe -ArgumentList '/d /q'", "saps -Path cmd.exe -Args '/d /q'", "Start-Process git -ArgumentList status"]) expect([command, windowsInterpreterHandoff(command)]).toEqual([command, false]);
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
		const lab = new SandboxWorkspace(api("el-fence ok NONCE abi 6 py /usr/bin/python3\n"), "/sandbox/work/p");
		await expect(lab.write("nested/.GiT/config", "x")).rejects.toThrow(".git path");
		await lab.write("alias/marker.txt", "x");
		expect(commands.some((c) => c.includes("realpath -m --") && c.includes("/sandbox/work/p/alias") && c.includes("leads outside the project"))).toBe(true);
		expect(commands.some((c) => c.includes("[gG][iI][tT]") && c.includes("leads through a .git path"))).toBe(true);
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
			const run = (command: string, mode = "write") => spawnSync("python3", ["-I", script, "run", project, command, mode], { cwd: project, encoding: "utf8" });
			expect(run('echo hi > inside.txt && echo t > "$TMPDIR/t" && echo x > /dev/null').status).toBe(0);
			for (const command of ["echo bad > alias/marker.txt", "unlink ../other/marker.txt", "python3 -c 'import os; os.truncate(\"../other/marker.txt\", 0)'", "mkdir ../other/d", "echo x > /tmp/el-fence-shared-codetest", "ln -s x ../other/l"]) {
				expect([command, run(command).status]).not.toEqual([command, 0]);
			}
			expect(readFileSync(join(other, "marker.txt"), "utf8")).toBe("keep");
			expect(existsSync("/tmp/el-fence-shared-codetest")).toBe(false);
			const flags = "python3 -c 'import array,fcntl,os; f=open(\"inside.txt\",\"rb\"); a=array.array(\"I\",[0]); fcntl.ioctl(f,0x80086601,a,True); a[0]^=0x40; fcntl.ioctl(f,0x40086602,a)'";
			expect(run(flags, "read").status).not.toBe(0);
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

	test.skipIf(process.platform === "win32")("empty-directory cleanup stays anchored and never follows a replacement link", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-empty-tree-")));
		try {
			const project = join(base, "project");
			const outside = join(base, "outside");
			mkdirSync(join(project, "empty", "nested"), { recursive: true });
			mkdirSync(outside);
			writeFileSync(join(outside, "keep"), "keep\n");
			expect(removeEmptyTreePhysical(join(project, "empty"))).toBe(true);
			mkdirSync(join(project, "empty"));
			rmSync(join(project, "empty"), { recursive: true });
			symlinkSync(outside, join(project, "empty"));
			expect(removeEmptyTreePhysical(join(project, "empty"))).toBe(false);
			expect(readFileSync(join(outside, "keep"), "utf8")).toBe("keep\n");
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

describe("round 5: one boundary", () => {
	const shell = { name: "shell", kind: "exec" } as unknown as Tool;
	const mode = (m: string, allow: string[] = []) => ({ permissions: { mode: m, allowCommands: allow } }) as unknown as LabConfig;

	test("nothing runs uncontained unasked unless the person listed it", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "el-uncontained-")));
		try {
			const off = new LocalWorkspace(root, "off");
			expect(decide(shell, { command: "ls" }, off, mode("ask"), new Set()).action).toBe("ask");
			expect(decide(shell, { command: "ls" }, off, mode("ask", ["ls"]), new Set()).action).toBe("run");
			expect(decide(shell, { command: "ls *" }, off, mode("ask", ["ls"]), new Set()).action).toBe("ask");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("wrapper words, split strings, pager commands and git settings handed to env can't hide a push", () => {
		for (const command of [`env -S 'bash -c "g\\it p\\ush origin HEAD"'`, `bat --paging=always --pager "bash -c 'git push origin HEAD'" README.md`, 'command "$CMD" push', `sort --compress-program "sh -c 'git push'" x`]) {
			expect([command, allowKeys(shell, { command }).keys[0]]).toEqual([command, "shell!push"]);
		}
		for (const command of ["env GIT_SSH_COMMAND=./x git fetch", "git -ccore.alternateRefsCommand=./x fetch", `env -S "$X"`, 'xargs "$P"']) {
			expect([command, allowKeys(shell, { command }).keys[0]]).toEqual([command, "shell!hidden"]);
		}
	});

	test("paths can't hold NUL, a hard-linked file isn't written, and a glob can't become an option", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "el-nul-")));
		const outside = realpathSync(mkdtempSync(join(tmpdir(), "el-nul-out-")));
		try {
			const ws = new LocalWorkspace(root, "off");
			expect(() => ws.resolve("sub/..\0a/..\0b/victim")).toThrow("NUL");
			expect(() => openPhysical(`${root}/a\0b`, constants.O_RDONLY)).toThrow("NUL");
			writeFileSync(join(outside, "keep.txt"), "keep");
			linkSync(join(outside, "keep.txt"), join(root, "twin.txt"));
			await expect(ws.write("twin.txt", "changed")).rejects.toThrow("hard link");
			expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
			writeFileSync(join(root, "-delete"), "");
			expect(isReadOnlyCommand("find . -[d]elete", [], (p) => ws.inside(p), { expand: (p) => ws.expand(p) })).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("a lab sandbox without the fence asks before each file edit", async () => {
		const edit = { name: "edit", kind: "write" } as unknown as Tool;
		const lab = new SandboxWorkspace({ title: "Field Lab", run: async () => ({ exitCode: 0, stdout: "el-fence no\n", stderr: "" }) } as unknown as SandboxApi, "/sandbox/work/p");
		await lab.prepare();
		expect(decide(edit, { path: "notes.txt" }, lab, mode("auto"), new Set()).action).toBe("ask");
	});

	test.skipIf(process.platform !== "darwin")("the engine's own git runs a project's filter drivers contained", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-gitfilter-")));
		const repo = join(base, "repo");
		const outside = join(base, "outside");
		mkdirSync(repo);
		mkdirSync(outside);
		try {
			const git = trustedGit()!;
			spawnSync(git, ["init", "-q"], { cwd: repo });
			// Project content an agent can write: a filter that tries to write outside the project.
			spawnSync(git, ["config", "filter.evil.clean", `sh -c 'touch ${outside}/pwned; cat'`], { cwd: repo });
			writeFileSync(join(repo, ".gitattributes"), "* filter=evil\n");
			writeFileSync(join(repo, "a.txt"), "x");
			try {
				snapshot(repo, "s1", "test");
			} catch {
				// A failing filter may fail the snapshot; what matters is where it could write.
			}
			expect(existsSync(join(outside, "pwned"))).toBe(false);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "darwin")("a .git file or core.worktree pointing elsewhere gives the engine's git nothing more to write", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-gitlayout-")));
		try {
			const git = trustedGit()!;
			// A .git file sending git to a repository outside the project.
			const outsideRepo = join(base, "outside");
			mkdirSync(outsideRepo);
			spawnSync(git, ["init", "-q"], { cwd: outsideRepo });
			const project = join(base, "project");
			mkdirSync(project);
			writeFileSync(join(project, ".git"), `gitdir: ${join(outsideRepo, ".git")}\n`);
			writeFileSync(join(project, "a.txt"), "x");
			const objects = () => spawnSync("find", [join(outsideRepo, ".git", "objects"), "-type", "f"], { encoding: "utf8" }).stdout;
			const before = objects();
			try {
				snapshot(project, "s1", "test");
			} catch {
				// Refused writes make it fail: closed, not open.
			}
			expect(objects()).toBe(before);
			// core.worktree naming a folder outside: a restore can't write there.
			const repo = join(base, "repo");
			const tree = join(base, "tree");
			mkdirSync(repo);
			mkdirSync(tree);
			spawnSync(git, ["init", "-q"], { cwd: repo });
			spawnSync(git, ["config", "core.worktree", tree], { cwd: repo });
			writeFileSync(join(tree, "f.txt"), "keep");
			let commit = "";
			try {
				commit = snapshot(repo, "s2", "test");
			} catch {
				// Either way, the folder outside must stay as it is.
			}
			rmSync(join(tree, "f.txt"));
			if (commit) {
				try {
					restoreSnapshot(repo, commit);
				} catch {
					// Refused.
				}
			}
			expect(existsSync(join(tree, "f.txt"))).toBe(false);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test("the engine's git runs only the reviewed subcommands, none of which merges or runs a diff driver", () => {
		// Adding a git command to git.ts means reviewing it here: merge, rebase, cherry-pick or checkout -m would run a
		// merge driver, and diff or show with content would run a textconv, which the no-facility fallback leaves on.
		const source = readFileSync(join(import.meta.dir, "..", "packages", "engine", "src", "git.ts"), "utf8");
		const calls = [...source.matchAll(/git\([a-zA-Z.]+, \[("[a-z-]+")([^\]]*)\]/g)].map((m) => ({ sub: JSON.parse(m[1]!) as string, rest: m[2]! }));
		const reviewed = new Set(["add", "branch", "bundle", "checkout-index", "commit", "commit-tree", "config", "diff", "fetch", "log", "ls-files", "ls-tree", "read-tree", "rev-list", "rev-parse", "rm", "show", "update-index", "update-ref", "worktree", "write-tree"]);
		expect(calls.length).toBeGreaterThan(20);
		expect(calls.map((c) => c.sub).filter((s) => !reviewed.has(s))).toEqual([]);
		for (const c of calls.filter((x) => x.sub === "diff")) expect(c.rest).toContain('"--name-only"');
		for (const c of calls.filter((x) => x.sub === "show")) expect(c.rest).toContain('"-s"');
		// fetch reads only a bundle file: no network or helper transport (ext::, a remote from project config).
		for (const m of source.matchAll(/git\([a-zA-Z.]+, \["fetch"[^\n]*/g)) expect(m[0]).toContain('GIT_ALLOW_PROTOCOL: "file"');
		for (const c of calls.filter((x) => x.sub === "log")) expect(c.rest).not.toMatch(/"-p"|"--patch"|"--stat"|textconv/);
		// Every process git.ts starts goes through its contained helper.
		expect((source.match(/execFileSync\(/g) ?? []).length).toBe(3);
		// Only under full containment: no direct run of git anywhere in the file.
		expect(source).toContain("FULL_CONTAINMENT.has(facility)");
		expect(source.match(/from "node:child_process"/g)?.length).toBe(1);
		expect(source).toContain('import { execFileSync } from "node:child_process";');
		expect(source).not.toMatch(/Bun\.spawn|spawnSync\(|execSync\(/);
	});
});

describe("round 6: containment is the boundary", () => {
	const shell = { name: "shell", kind: "exec" } as unknown as Tool;

	test("in a folder set to read only, a read runs with nothing writable", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "el-rofolder-")));
		try {
			const ws = new LocalWorkspace(root, "workspace");
			if (!ws.sandboxed) return;
			const config = { permissions: { mode: "auto", allowCommands: [] }, folders: { [root]: { access: "read" } } } as unknown as LabConfig;
			expect(decide(shell, { command: "cat a.txt" }, ws, config, new Set())).toEqual({ action: "run", readOnly: true });
			expect(decide(shell, { command: "cat a.txt" }, ws, { permissions: { mode: "auto", allowCommands: [] } } as unknown as LabConfig, new Set(), undefined, undefined, false)).toEqual({ action: "run", readOnly: true });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("git's other publishing commands are pushes", () => {
		for (const command of ["git send-pack origin HEAD", "/usr/libexec/git-core/git-send-pack ../r main", "git http-push https://h/r main", "git svn dcommit", "git send-email 0001.patch", "git p4 submit"]) {
			expect([command, allowKeys(shell, { command }).keys[0]]).toEqual([command, "shell!push"]);
		}
		expect(allowKeys(shell, { command: "git status" }).keys[0]).not.toBe("shell!push");
	});

	test.skipIf(process.platform !== "win32")("Windows Git names and backslash paths cannot hide a push", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "el-windows-publish-")));
		const workspace = new LocalWorkspace(root, "off");
		const full = { permissions: { mode: "full", allowCommands: [] } } as unknown as LabConfig;
		try {
			for (const command of ["Git push origin main", String.raw`C:\Tools\Git\cmd\git.exe push origin main`, String.raw`'C:\Program Files\Git\bin\Git.exe' push origin main`, String.raw`& 'C:\Program Files\Git\bin\Git.exe' push origin main`, "Write-Output x#; git push", "<##> git push", '& "`u{0067}it" push']) {
				expect(allowKeys(shell, { command }).keys[0]).toBe("shell!push");
				expect(decide(shell, { command }, workspace, full, new Set()).action).toBe("ask");
			}
			const encoded = "powershell.exe -EncodedCommand Z2l0IHB1c2g=";
			expect(allowKeys(shell, { command: encoded }).keys[0]).toBe("shell!push");
			expect(decide(shell, { command: encoded }, workspace, full, new Set()).action).toBe("ask");
			for (const command of [
				"cmd.exe /c powershell.exe -EncodedCommand ZwBpAHQAIABwAHUAcwBoAA==",
				"env powershell.exe -enc ZwBpAHQAIABwAHUAcwBoAA==",
				"env.exe powershell.exe -enc ZwBpAHQAIABwAHUAcwBoAA==",
				"xargs.exe pwsh.exe -EncodedCommand ZwBpAHQAIABwAHUAcwBoAA==",
				"saps powershell.exe -ArgumentList '-EncodedCommand ZwBpAHQAIABwAHUAcwBoAA=='",
				"powershell.exe -ec ZwBpAHQAIABwAHUAcwBoAA==",
				`iex '& ("g"+"it") ("p"+"ush") origin main'`,
				"Invoke-Expression 'git push origin main'",
				"cmd.exe /d /c g^it p^ush origin main",
				"bash -c 'git push origin main'",
				"wsl git push origin main",
				"pwsh -NoProfile -Command 'git push origin main'",
			]) {
				expect([command, allowKeys(shell, { command }).keys[0]]).toEqual([command, "shell!push"]);
				expect(decide(shell, { command }, workspace, full, new Set()).action).toBe("ask");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "win32")("Start-Process ArgumentList strings and arrays cannot hide a push", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "el-windows-start-process-")));
		const workspace = new LocalWorkspace(root, "off");
		const full = { permissions: { mode: "full", allowCommands: [] } } as unknown as LabConfig;
		try {
			for (const command of [
				"saps cmd.exe -ArgumentList '/d /c g^it p^ush origin main'",
				"Start-Process -FilePath cmd.exe -ArgumentList @('/d','/c','g^it p^ush origin main')",
				"start -Fi cmd.exe -Arg '/d /c g^it p^ush origin main'",
				"saps -Path cmd.exe -Args '/d /c g^it p^ush origin main'",
				`Start-Process -ArgumentList '"push" origin main' -FilePath git.exe`,
				"Start-Process git -ArgumentList push,origin,main",
				"saps cmd.exe -ArgumentList @('/d',$unreadable)",
			]) {
				expect([command, allowKeys(shell, { command }).keys[0]]).toEqual([command, "shell!push"]);
				expect(decide(shell, { command }, workspace, full, new Set()).action).toBe("ask");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "win32")("typographic quotes and caret escapes ask as pushes on Windows", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "el-windows-unreadable-")));
		const workspace = new LocalWorkspace(root, "off");
		const full = { permissions: { mode: "full", allowCommands: [] } } as unknown as LabConfig;
		try {
			const commands = [
				...Array.from("‘’‚‛“”„", (quote) => `Write-Output ${quote}safe${quote}`),
				"Write-Output safe^value",
				"saps cmd.exe -ArgumentList ‘/c g^it p^ush origin main’",
			];
			for (const command of commands) {
				expect([command, allowKeys(shell, { command }).keys[0]]).toEqual([command, "shell!push"]);
				expect(decide(shell, { command }, workspace, full, new Set()).action).toBe("ask");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "darwin")("a read-only subagent's commands run where nothing in the project can change, or not at all", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "el-readonly-")));
		try {
			writeFileSync(join(root, "a.txt"), "data\n");
			const opts = { timeoutMs: 30_000, signal: new AbortController().signal, readOnly: true };
			const ws = new LocalWorkspace(root, "workspace");
			expect((await ws.exec("cat a.txt", opts)).output).toContain("data");
			// A program the words don't show writing (a pager, a script) is stopped by the OS, not by reading the line.
			expect((await ws.exec("bat --paging=always --pager 'sh -c \"echo x > b.txt\"' a.txt 2>/dev/null; sh -c 'echo x > c.txt'", opts)).exitCode).not.toBe(0);
			expect(existsSync(join(root, "b.txt")) || existsSync(join(root, "c.txt"))).toBe(false);
			const off = new LocalWorkspace(root, "off");
			expect((await off.exec("cat a.txt", opts)).exitCode).toBe(125);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform === "win32")("bringing work back from a lab runs only under its fence, so none of the project's hooks or filter drivers run outside it", async () => {
		const { execFileSync } = await import("node:child_process");
		const { fetchRepo } = await import("../packages/engine/src/sites/repo_handoff.ts");
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-handoff-")));
		try {
			const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" }).trim();
			const repo = join(base, "home");
			const dir = join(base, "sandbox");
			const out = join(base, "out");
			const marks = join(base, "marks");
			for (const d of [repo, out, marks]) mkdirSync(d);
			git(repo, "init", "-q", "-b", "main");
			writeFileSync(join(repo, "a.txt"), "one\n");
			git(repo, "add", ".");
			git(repo, "commit", "-q", "-m", "start");
			const head = git(repo, "rev-parse", "HEAD");
			execFileSync("git", ["clone", "-q", repo, dir]);
			git(dir, "checkout", "-q", "-b", "work");
			// What an agent in the sandbox could leave: a filter driver and a hook in the repository's own settings.
			git(dir, "config", "filter.evil.clean", `sh -c 'touch ${marks}/filter; cat'`);
			writeFileSync(join(dir, ".gitattributes"), "* filter=evil\n");
			writeFileSync(join(dir, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch ${marks}/hook\n`, { mode: 0o755 });
			writeFileSync(join(dir, "b.txt"), "two\n");
			const api = {
				title: "Test Lab",
				run: async (command: string) => {
					const r = spawnSync("bash", ["-c", command.replaceAll("/sandbox/out", out)], { encoding: "utf8" });
					return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
				},
				get: async (from: string, to: string) => writeFileSync(to, readFileSync(from.replace("/sandbox/out", out))),
			} as unknown as SandboxApi;
			// This "lab" can't fence (no Landlock here), so nothing runs in it but the probe.
			// Where this computer can fence (Linux with Landlock), the work comes back fenced; elsewhere it refuses. Either
			// way, none of the project's hooks or filters ran.
			const outcome = await fetchRepo(api, dir, { repo, base: head, home: head }, "enrichedlab/test-1").then(
				(commits) => ({ commits }),
				(error: Error) => ({ error }),
			);
			if ("error" in outcome) expect(outcome.error.message).toContain("can't fence");
			else expect(outcome.commits.length).toBe(1);
			expect(readdirSync(marks)).toEqual([]);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test("round 8: allowCommands is one exact literal argv, and publishing forms stay visible", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "el-allow-")));
		try {
			const off = new LocalWorkspace(root, "off");
			const listed = { permissions: { mode: "ask", allowCommands: ["ls -la"] } } as unknown as LabConfig;
			for (const command of ["ls", "ls -la ", "ls\r-la", "ls ls", "ls\u0085x", "ls\tx\0", "ls $HOME", "ls *", "ls ~", "printf $'\\n'", "A=1 ls", "ls > out"]) {
				expect([JSON.stringify(command), decide(shell, { command }, off, listed, new Set()).action]).toEqual([JSON.stringify(command), "ask"]);
			}
			if (process.platform === "win32") expect(decide(shell, { command: "ls -la" }, off, listed, new Set()).action).toBe("ask");
			else expect(decide(shell, { command: "ls -la" }, off, listed, new Set())).toEqual({ action: "run", argv: ["ls", "-la"] });
			expect(allowedCommand("\u00a0/usr/bin/ls", ["\u00a0/usr/bin/ls"])).toBeUndefined();
			expect(allowedCommand("ls ~", ["ls ~"])).toBeUndefined();
			expect(allowedCommand("printf $'\\n'", ["printf $'\\n'"])).toBeUndefined();

			if (process.platform !== "win32") {
				const bin = join(root, "outside-bin");
				const project = join(root, "project");
				mkdirSync(bin);
				mkdirSync(project);
				const program = join(bin, "literal-argv");
				writeFileSync(program, "#!/bin/sh\nprintf '<%s>' \"$1\"\n");
				chmodSync(program, 0o755);
				writeFileSync(join(project, "pixi.toml"), "[workspace]\nchannels = []\n");
				const projectBin = join(project, ".pixi", "envs", "default", "bin");
				mkdirSync(join(project, ".pixi", "envs", "default", "conda-meta"), { recursive: true });
				mkdirSync(projectBin, { recursive: true });
				writeFileSync(join(projectBin, "literal-argv"), "#!/bin/sh\nexit 99\n");
				chmodSync(join(projectBin, "literal-argv"), 0o755);
				const command = "literal-argv 'a b; $HOME'";
				const argv = allowedCommand(command, [command]);
				expect(argv).toEqual(["literal-argv", "a b; $HOME"]);
				const result = await new LocalWorkspace(project, "off").exec(command, { argv, env: { PATH: bin }, timeoutMs: 5_000, signal: AbortSignal.timeout(5_000) });
				expect([result.exitCode, result.output]).toEqual([0, "<a b; $HOME>"]);
				const projectProgram = join(project, "owned");
				writeFileSync(projectProgram, "#!/bin/sh\nexit 0\n");
				chmodSync(projectProgram, 0o755);
				const refused = await new LocalWorkspace(project, "off").exec("owned", { argv: ["owned"], env: { PATH: project }, timeoutMs: 5_000, signal: AbortSignal.timeout(5_000) });
				expect([refused.exitCode, refused.output]).toEqual([126, expect.stringContaining("never runs a program from the project")]);
				const refusedRelative = await new LocalWorkspace(project, "off").exec("owned", { argv: ["owned"], env: { PATH: "." }, timeoutMs: 5_000, signal: AbortSignal.timeout(5_000) });
				expect([refusedRelative.exitCode, refusedRelative.output]).toEqual([126, expect.stringContaining("never runs a program from the project")]);
				symlinkSync(program, join(project, "linked-program"));
				const refusedLink = await new LocalWorkspace(project, "off").exec("linked-program", { argv: ["linked-program"], env: { PATH: project }, timeoutMs: 5_000, signal: AbortSignal.timeout(5_000) });
				expect([refusedLink.exitCode, refusedLink.output]).toEqual([126, expect.stringContaining("never runs a program from the project")]);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
		for (const command of ["/usr/lib/git-core/git-svn dcommit", "/usr/lib/git-core/git-svn d[c]ommit", "/usr/lib/git-core/git-p4 submit", "p4 submit", "p4 s[u]bmit"]) {
			expect([command, allowKeys(shell, { command }).keys[0]]).toEqual([command, "shell!push"]);
		}
		for (const command of ["env ./g[[:lower:]]t push origin main", "env ./p[[:digit:]] submit"]) {
			expect([command, allowKeys(shell, { command }).keys[0]]).toEqual([command, "shell!push"]);
		}
		expect(allowKeys(shell, { command: "env ./tool[[:lower:]] status" }).keys[0]).toBe("shell!hidden");
		expect(allowKeys(shell, { command: "env ./tool[[:unknown:]] status" }).keys[0]).toMatch(/^shell!/);
		for (const command of ["timeout 5 env GIT_SSH_COMMAND=./x git fetch", "nice env GIT_CONFIG_COUNT=1 git status", "export GIT_SSH_COMMAND", "declare -x GIT_CONFIG_COUNT", "readonly GIT_ASKPASS", "builtin export GIT_CONFIG_COUNT", "builtin declare -x GIT_SSH_COMMAND", "git -c gc.recentObjectsHook=./x gc", "git -c core.fsm[o]nitor=./x status", "git -c tar.x.command=./y archive HEAD", "git -c difftool.t.cmd=./y difftool"]) {
			expect([command, allowKeys(shell, { command }).keys[0]]).toEqual([command, "shell!hidden"]);
		}
		expect(FENCE_PY.match(/425, 426, 427/g)).toHaveLength(2);
		expect(FENCE_PY).toContain('"x86_64": (0xC000003E, [16,');
		expect(FENCE_PY).toContain("14, 15, 16, 29, 52");
	});

	test("temp grants and Linux metadata scans fail closed instead of following caller state", () => {
		const attack = realpathSync(mkdtempSync(join(tmpdir(), "el-attacker-temp-")));
		const before = process.env.TMPDIR;
		process.env.TMPDIR = attack;
		try {
			expect(safeTemp()).not.toBe(attack);
			expect(engineTemp()).not.toBe(safeTemp());
			expect(engineEnvironment().TMPDIR).toBe(engineTemp());
			expect(containedTempEnvironment({ TMPDIR: attack, TMP: attack, TEMP: attack })).toMatchObject({ TMPDIR: safeTemp(), TMP: safeTemp(), TEMP: safeTemp() });
		} finally {
			if (before === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = before;
			rmSync(attack, { recursive: true, force: true });
		}
		const root = realpathSync(mkdtempSync(join(tmpdir(), "el-scan-limit-")));
		try {
			writeFileSync(join(root, "a"), "a");
			writeFileSync(join(root, "b"), "b");
			writeFileSync(join(root, "c"), "c");
			expect(() => projectGitPaths(root, 2)).toThrow("couldn't be completed");
			mkdirSync(join(root, "deep", "deeper"), { recursive: true });
			expect(() => projectGitPaths(root, 100, 0)).toThrow("deeper than");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test.skipIf(!["seatbelt", "bubblewrap"].includes(sandboxer() ?? ""))("contained commands cannot write engine Git scratch", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "el-engine-temp-")));
		const marker = join(engineTemp(), "command-owned");
		try {
			const result = await new LocalWorkspace(root, "workspace").exec(`printf blocked > '${marker}'`, { timeoutMs: 5_000, signal: AbortSignal.timeout(5_000) });
			expect(result.exitCode).not.toBe(0);
			expect(existsSync(marker)).toBe(false);
		} finally {
			rmSync(marker, { force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("engine Git accepts only /dev/null caller config overrides", () => {
		const names = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_DIR", "LD_PRELOAD"];
		const saved = names.map((name) => process.env[name]);
		try {
			for (const name of names) process.env[name] = "/project/controlled";
			for (const name of names) expect(engineEnvironment()[name]).toBeUndefined();
			for (const name of names.slice(0, 2)) process.env[name] = "/dev/null";
			expect(engineEnvironment()).toMatchObject({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
		} finally {
			names.forEach((name, i) => {
				if (saved[i] === undefined) delete process.env[name];
				else process.env[name] = saved[i];
			});
		}
	});

	test.skipIf(process.platform !== "linux")("Linux .git quarantine uses held folders and preserves files, directories and links", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-git-quarantine-")));
		const root = join(base, "project");
		const outside = join(base, "outside");
		const quarantine = join(base, "quarantine");
		mkdirSync(join(root, "existing", ".git"), { recursive: true });
		mkdirSync(outside);
		writeFileSync(join(outside, ".git"), "outside\n");
		const held = holdGitEntries(root, 50_000, 64, undefined, quarantine);
		try {
			writeFileSync(join(root, ".git"), "gitdir: elsewhere\n");
			mkdirSync(join(root, "nested", ".GiT"), { recursive: true });
			writeFileSync(join(root, "nested", ".GiT", "config"), "keep\n");
			mkdirSync(join(root, "linked"));
			symlinkSync(outside, join(root, "linked", ".git"));
			// Replacing the project name cannot redirect cleanup to another directory.
			const movedRoot = join(base, "held-project");
			renameSync(root, movedRoot);
			symlinkSync(outside, root);
			const result = held.quarantine();
			expect(result.error).toBeUndefined();
			expect(result.moved.map((m) => m.from).sort()).toEqual([".git", "linked/.git", "nested/.GiT"]);
			for (const { from, to } of result.moved) {
				expect(existsSync(join(movedRoot, from))).toBe(false);
				expect(to).toMatch(/\/quarantine\/git-[a-f0-9]{24}$/);
				if (from === ".git") expect(readFileSync(to, "utf8")).toBe("gitdir: elsewhere\n");
				else if (from === "nested/.GiT") expect(readFileSync(join(to, "config"), "utf8")).toBe("keep\n");
				else expect(lstatSync(to).isSymbolicLink()).toBe(true);
			}
			expect(readFileSync(join(outside, ".git"), "utf8")).toBe("outside\n");
			expect(existsSync(join(movedRoot, "existing", ".git"))).toBe(true);
			expect(held.quarantine()).toEqual({ moved: [] });
			renameSync(join(movedRoot, "existing", ".git"), join(movedRoot, "existing", "original-metadata"));
			writeFileSync(join(movedRoot, "existing", ".git"), "replacement\n");
			const replacement = held.quarantine();
			expect(replacement.error).toBeUndefined();
			expect(replacement.moved.map((m) => m.from)).toEqual(["existing/.git"]);
			expect(readFileSync(replacement.moved[0]!.to, "utf8")).toBe("replacement\n");
			expect(() => holdGitEntries(movedRoot, 1, 64, undefined, quarantine)).toThrow("couldn't be completed");
			expect(() => holdGitEntries(movedRoot, 100, 0, undefined, quarantine)).toThrow("deeper than");
		} finally {
			held.release();
			rmSync(base, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "linux")("recovery completes a rename whose durable intent has no done record", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-git-intent-recovery-")));
		const project = join(base, "project");
		const home = join(base, "state");
		mkdirSync(project);
		try {
			const quarantine = gitQuarantineFolder(project, home);
			const held = holdGitEntries(project, 50_000, 64, undefined, quarantine);
			const baseline = held.baseline;
			held.release();
			mkdirSync(join(project, ".git"));
			writeFileSync(join(project, ".git", "config"), "survives\n");
			const itemStat = lstatSync(join(project, ".git"), { bigint: true });
			const item = `${itemStat.dev}:${itemStat.ino}`;
			const target = join(quarantine, "git-0123456789abcdef01234567");
			const marker = gitQuarantineMarker(project, home);
			mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
			const header = { version: 2, project, baseline, quarantine };
			const intent = { event: "intent", item, from: ".git", to: target };
			writeFileSync(marker, `${JSON.stringify(header)}\n${JSON.stringify(intent)}\n`, { mode: 0o600 });
			// This is the crash point: rename completed, but no done event reached the journal.
			renameSync(join(project, ".git"), target);

			const recovered = recoverGitQuarantine(project, home);
			expect(recovered.moved).toEqual([{ from: ".git", to: target }]);
			expect(readFileSync(join(target, "config"), "utf8")).toBe("survives\n");
			expect(existsSync(join(project, ".git"))).toBe(false);
			expect(existsSync(marker)).toBe(false);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "linux")("recovery reports a move whose done record was fsynced before the result was returned", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-git-done-recovery-")));
		const project = join(base, "project");
		const home = join(base, "state");
		mkdirSync(project);
		let held: ReturnType<typeof holdGitEntries> | undefined;
		try {
			const quarantine = gitQuarantineFolder(project, home);
			held = holdGitEntries(project, 50_000, 64, undefined, quarantine);
			const marker = gitQuarantineMarker(project, home);
			mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
			writeFileSync(marker, `${JSON.stringify({ version: 2, project, baseline: held.baseline, quarantine })}\n`, { mode: 0o600 });
			mkdirSync(join(project, ".git"));
			writeFileSync(join(project, ".git", "config"), "survives\n");
			const append = (event: Record<string, unknown>) => {
				const fd = openSync(marker, constants.O_WRONLY | constants.O_APPEND);
				try {
					writeSync(fd, `${JSON.stringify(event)}\n`);
					fsyncSync(fd);
				} finally {
					closeSync(fd);
				}
			};
			const result = held.quarantine(true, {
				intent: (move) => append({ event: "intent", ...move }),
				done: (move) => {
					append({ event: "done", ...move });
					throw new Error("simulated crash after done fsync");
				},
			});
			expect(result.moved).toEqual([]);
			expect(result.error).toContain("simulated crash");
			held.release();
			held = undefined;

			const recovered = recoverGitQuarantine(project, home);
			expect(recovered.moved).toHaveLength(1);
			expect(recovered.moved[0]!.from).toBe(".git");
			expect(readFileSync(join(recovered.moved[0]!.to, "config"), "utf8")).toBe("survives\n");
			expect(existsSync(marker)).toBe(false);
		} finally {
			held?.release();
			rmSync(base, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "linux")("quarantine fsyncs both rename directories before recording done", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-git-directory-fsync-")));
		const project = join(base, "project");
		const quarantine = join(base, "quarantine");
		mkdirSync(project);
		const order: string[] = [];
		const held = holdGitEntries(project, 50_000, 64, undefined, quarantine, {
			directoryFsynced: (directory) => order.push(directory),
		});
		try {
			mkdirSync(join(project, ".git"));
			const result = held.quarantine(true, {
				intent: () => order.push("intent"),
				done: () => order.push("done"),
			});
			expect(result.error).toBeUndefined();
			expect(order).toEqual(["intent", "source", "quarantine", "done"]);
		} finally {
			held.release();
			rmSync(base, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "linux" || process.getuid?.() === 0 || sandboxer() !== "bubblewrap")("a foreground journal append failure blocks the command and later project writes", async () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-git-foreground-journal-")));
		const project = join(base, "project");
		const home = join(base, "state");
		const savedHome = process.env.EL_HOME;
		mkdirSync(project);
		try {
			process.env.EL_HOME = home;
			const marker = gitQuarantineMarker(project, home);
			let locked = false;
			const workspace = new LocalWorkspace(project, "workspace");
			const command = await workspace.exec("mkdir .git; printf ready; sleep 0.2", {
				timeoutMs: 5_000,
				signal: AbortSignal.timeout(5_000),
				onOutput(text) {
					if (!locked && text.includes("ready")) {
						chmodSync(marker, 0o400);
						locked = true;
					}
				},
			});
			expect(locked).toBe(true);
			expect(command.exitCode).toBe(125);
			expect(command.output).toContain("foreground process exited");
			expect(existsSync(marker)).toBe(true);
			await expect(workspace.write("blocked", "bad")).rejects.toThrow("cleanup pending");
			expect(existsSync(join(project, "blocked"))).toBe(false);
			chmodSync(marker, 0o600);
			recoverGitQuarantine(project, home);
			expect(existsSync(marker)).toBe(false);
			expect(existsSync(join(project, ".git"))).toBe(false);
		} finally {
			if (existsSync(gitQuarantineMarker(project, home))) chmodSync(gitQuarantineMarker(project, home), 0o600);
			if (savedHome === undefined) delete process.env.EL_HOME;
			else process.env.EL_HOME = savedHome;
			rmSync(base, { recursive: true, force: true });
		}
	}, 15_000);

	test.skipIf(process.platform !== "linux" || process.getuid?.() === 0 || sandboxer() !== "bubblewrap")("the final pass resumes every intent after a transient foreground fsync failure", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-git-final-retry-")));
		const project = join(base, "project");
		const home = join(base, "state");
		mkdirSync(project);
		try {
			const marker = gitQuarantineMarker(project, home);
			const workspaceModule = join(import.meta.dir, "../packages/engine/src/tools/workspace.ts");
			const script = `import { mock } from "bun:test";
import * as fs from "node:fs";
const fsync = fs.fsyncSync;
let failed = false;
mock.module("node:fs", () => ({ ...fs, fsyncSync(fd) {
	let path = "";
	try { path = fs.readlinkSync("/proc/self/fd/" + fd); } catch {}
	if (!failed && path === ${JSON.stringify(marker)}) {
		const text = fs.readFileSync(${JSON.stringify(marker)}, "utf8");
		if (text.includes('"event":"intent"') && !text.includes('"event":"done"')) {
			failed = true;
			throw Object.assign(new Error("EIO: injected foreground fsync failure"), { code: "EIO" });
		}
	}
	return fsync(fd);
} }));
const { gitQuarantineFolder, LocalWorkspace } = await import(${JSON.stringify(workspaceModule)});
const project = ${JSON.stringify(project)};
const home = ${JSON.stringify(home)};
const workspace = new LocalWorkspace(project, "workspace");
const command = await workspace.exec("mkdir -p a/.git b/.git; printf a > a/.git/config; printf b > b/.git/config", { timeoutMs: 10_000, signal: AbortSignal.timeout(10_000) });
let write = "";
try { await workspace.write("after.txt", "ok"); write = "ok"; } catch (error) { write = String(error?.message ?? error); }
const quarantine = gitQuarantineFolder(project, home);
process.stdout.write(JSON.stringify({ failed, exitCode: command.exitCode, output: command.output, marker: fs.existsSync(${JSON.stringify(marker)}), a: fs.existsSync(project + "/a/.git"), b: fs.existsSync(project + "/b/.git"), quarantined: fs.readdirSync(quarantine).length, write }));`;
			const ran = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: { ...process.env, HOME: home, EL_HOME: home } });
			expect(ran.status, ran.stderr || ran.stdout).toBe(0);
			const result = JSON.parse(ran.stdout) as { failed: boolean; exitCode: number; output: string; marker: boolean; a: boolean; b: boolean; quarantined: number; write: string };
			expect(result.failed).toBe(true);
			expect(result.exitCode).toBe(125);
			expect(result.output).toContain("foreground process exited");
			expect(result).toMatchObject({ marker: false, a: false, b: false, quarantined: 2, write: "ok" });
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	}, 20_000);

	test.skipIf(process.platform !== "linux")("Linux refuses existing .git links and final quarantine survives hostile modes", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-git-hostile-")));
		const linked = join(base, "linked");
		const dangling = join(base, "dangling");
		const target = join(base, "metadata");
		const root = join(base, "project");
		const quarantine = join(base, "quarantine");
		mkdirSync(linked);
		mkdirSync(dangling);
		mkdirSync(target);
		mkdirSync(root);
		symlinkSync(target, join(linked, ".git"));
		symlinkSync(join(base, "missing"), join(dangling, ".GiT"));
		expect(() => holdGitEntries(linked)).toThrow("symbolic link");
		expect(() => holdGitEntries(dangling)).toThrow("symbolic link");
		const held = holdGitEntries(root, 50_000, 64, undefined, quarantine);
		try {
			mkdirSync(join(root, "sealed", "deeper", ".git"), { recursive: true });
			writeFileSync(join(root, "sealed", "deeper", ".git", "config"), "keep\n");
			writeFileSync(join(root, "extra-one"), "1");
			writeFileSync(join(root, "extra-two"), "2");
			chmodSync(join(root, "sealed"), 0);
			chmodSync(root, 0);
			expect(held.quarantine(false)).toEqual({ moved: [] });
			expect(lstatSync(root).mode & 0o777).toBe(0);
			const result = held.quarantine();
			expect(result.error).toBeUndefined();
			expect(result.moved.map((move) => move.from)).toEqual(["sealed/deeper/.git"]);
			expect(lstatSync(root).mode & 0o777).toBe(0);
			chmodSync(root, 0o700);
			chmodSync(join(root, "sealed"), 0o700);
			const blocked = result.moved[0]!.to;
			expect(readFileSync(join(blocked, "config"), "utf8")).toBe("keep\n");
		} finally {
			held.release();
			try {
				chmodSync(root, 0o700);
				chmodSync(join(root, "sealed"), 0o700);
			} catch {
				// The setup may have failed before changing modes.
			}
			rmSync(base, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "linux")("Linux bounds the final .git scan without moving or chmodding the project", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-git-bounded-final-")));
		const root = join(base, "project");
		const quarantine = join(base, "quarantine");
		mkdirSync(root, { mode: 0o700 });
		const held = holdGitEntries(root, 1, 64, undefined, quarantine);
		try {
			mkdirSync(join(root, ".git"));
			writeFileSync(join(root, ".git", "config"), "keep\n");
			writeFileSync(join(root, "extra"), "enough to exceed the final bound");
			const result = held.quarantine(true);
			expect(result.error).toContain("more than 1 entries");
			expect(existsSync(root)).toBe(true);
			expect(lstatSync(root).mode & 0o777).toBe(0o700);
		} finally {
			held.release();
			rmSync(base, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "linux")("Linux verifies the sibling quarantine owner and mode through a no-link handle", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-git-private-quarantine-")));
		const root = join(base, "project");
		const target = join(base, "target");
		mkdirSync(root);
		try {
			const quarantine = gitQuarantineFolder(root, join(base, "state"));
			rmSync(quarantine, { recursive: true });
			mkdirSync(quarantine, { mode: 0o777 });
			chmodSync(quarantine, 0o777);
			expect(() => gitQuarantineFolder(root, join(base, "state"))).toThrow("mode 0700");
			rmSync(quarantine, { recursive: true });
			if (process.getuid?.() === 0) {
				mkdirSync(quarantine, { mode: 0o700 });
				chownSync(quarantine, 65534, 65534);
				expect(() => gitQuarantineFolder(root, join(base, "state"))).toThrow("owned by this user");
				rmSync(quarantine, { recursive: true });
			}
			mkdirSync(target, { mode: 0o700 });
			symlinkSync(target, quarantine);
			expect(() => gitQuarantineFolder(root, join(base, "state"))).toThrow("could not verify");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "linux" || process.getuid?.() === 0)("Linux uses a verified per-user quarantine when the project parent is not writable", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-git-fallback-quarantine-")));
		const parent = join(base, "locked");
		const root = join(parent, "project");
		const home = join(base, "state");
		mkdirSync(root, { recursive: true });
		mkdirSync(home, { mode: 0o700 });
		chmodSync(parent, 0o555);
		let quarantine: string | undefined;
		try {
			quarantine = gitQuarantineFolder(root, home);
			expect(quarantine).toStartWith(join(home, "quarantine"));
			expect(statSync(quarantine, { bigint: true }).dev).toBe(statSync(root, { bigint: true }).dev);
			expect(statSync(quarantine).mode & 0o777).toBe(0o700);
			chmodSync(quarantine, 0o777);
			expect(() => gitQuarantineFolder(root, home)).toThrow(/same-filesystem sibling: .*per-user fallback: .*mode 0700/i);
		} finally {
			if (quarantine) chmodSync(quarantine, 0o700);
			chmodSync(parent, 0o700);
			rmSync(base, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "linux" || sandboxer() !== "bubblewrap")("Linux makes no advance probe and refuses a nested mount by held mount identity", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-git-bind-fallback-")));
		const projectSource = join(base, "project-source");
		const nestedSource = join(base, "nested-source");
		const stateSource = join(base, "state-source");
		const project = join(base, "views", "project");
		const state = join(base, "views", "state");
		mkdirSync(join(projectSource, "nested"), { recursive: true });
		mkdirSync(nestedSource);
		mkdirSync(stateSource);
		mkdirSync(project, { recursive: true });
		mkdirSync(state);
		try {
			const bwrap = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"].find(existsSync)!;
			const workspaceModule = join(import.meta.dir, "../packages/engine/src/tools/workspace.ts");
			const anchoredModule = join(import.meta.dir, "../packages/engine/src/tools/anchored.ts");
			const script = `import { gitQuarantineFolder } from ${JSON.stringify(workspaceModule)};\nimport { holdGitEntries } from ${JSON.stringify(anchoredModule)};\nconst quarantine = gitQuarantineFolder(${JSON.stringify(project)}, ${JSON.stringify(state)});\ntry { holdGitEntries(${JSON.stringify(project)}, 50_000, 64, undefined, quarantine); process.exit(2); } catch (error) { const message = String(error?.message ?? error); process.stdout.write(JSON.stringify({ quarantine, message })); if (!message.includes("mount boundary at nested") || !message.includes("mount ID")) process.exit(3); }`;
			const ran = spawnSync(bwrap, [
				"--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
				"--bind", projectSource, project, "--bind", nestedSource, join(project, "nested"), "--bind", stateSource, state,
				"--unshare-all", "--die-with-parent", "--new-session", "--", process.execPath, "-e", script,
			], { encoding: "utf8" });
			expect(ran.status, ran.stderr).toBe(0);
			const result = JSON.parse(ran.stdout) as { quarantine: string; message: string };
			expect(result.quarantine).toStartWith(join(state, "quarantine"));
			expect(result.message).toContain("mount boundary at nested");
			expect(readdirSync(projectSource)).toEqual(["nested"]);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "linux" || sandboxer() !== "bubblewrap")("a mid-pass move stays journaled through a later EXDEV and keeps the project blocked", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-git-mid-pass-mount-")));
		const source = join(base, "source");
		const projectSource = join(source, "project");
		const nestedSource = join(base, "nested-source");
		const stateSource = join(base, "state-source");
		const views = join(base, "views");
		const project = join(views, "project");
		const state = join(base, "state");
		const env = { ...process.env, HOME: state, EL_HOME: state, XDG_CONFIG_HOME: join(state, ".config"), GIT_CONFIG_GLOBAL: "/dev/null" };
		mkdirSync(join(projectSource, "a"), { recursive: true });
		mkdirSync(join(projectSource, "z-mount"));
		mkdirSync(nestedSource);
		mkdirSync(stateSource);
		mkdirSync(views);
		mkdirSync(state);
		try {
			const bwrap = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"].find(existsSync)!;
			const workspaceModule = join(import.meta.dir, "../packages/engine/src/tools/workspace.ts");
			const script = `import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";\nimport { dirname, join } from "node:path";\nimport { gitQuarantineFolder, gitQuarantineMarker, LocalWorkspace, recoverGitQuarantine } from ${JSON.stringify(workspaceModule)};\nconst project = ${JSON.stringify(project)}; const state = ${JSON.stringify(state)}; const root = statSync(project, { bigint: true }); const baseline = { root: String(root.dev) + ":" + String(root.ino), entries: [] }; const quarantine = gitQuarantineFolder(project, state); const marker = gitQuarantineMarker(project, state); mkdirSync(dirname(marker), { recursive: true, mode: 0o700 }); writeFileSync(marker, JSON.stringify({ version: 1, project, baseline, quarantine, moved: [] }) + "\\n"); mkdirSync(join(project, "a", ".git")); writeFileSync(join(project, "a", ".git", "config"), "moved"); let recovery = ""; try { recoverGitQuarantine(project, state); } catch (error) { recovery = String(error?.message ?? error); } const events = readFileSync(marker, "utf8").trim().split("\\n").map(JSON.parse); const moved = events.filter((event) => event.event === "done").map(({ from, to }) => ({ from, to })); const journal = { moved }; const workspace = new LocalWorkspace(project); let write = ""; try { await workspace.write("blocked", "bad"); } catch (error) { write = String(error?.message ?? error); } process.stdout.write(JSON.stringify({ recovery, write, journal, target: journal.moved[0] && readFileSync(join(journal.moved[0].to, "config"), "utf8"), marker: existsSync(marker), git: existsSync(join(project, "a", ".git")), file: existsSync(join(project, "blocked")) }));`;
			const ran = spawnSync(bwrap, [
				"--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
				"--bind", source, views, "--bind", nestedSource, join(project, "z-mount"), "--bind", stateSource, state,
				"--unshare-all", "--die-with-parent", "--new-session", "--", process.execPath, "-e", script,
			], { encoding: "utf8", env });
			expect(ran.status, ran.stderr).toBe(0);
			const result = JSON.parse(ran.stdout) as { recovery: string; write: string; journal: { moved: { from: string; to: string }[] }; target: string; marker: boolean; git: boolean; file: boolean };
			expect(result.recovery).toContain("mount boundary at z-mount");
			expect(result.write).toContain("cleanup pending");
			expect(result.journal.moved.map((move) => move.from)).toEqual(["a/.git"]);
			expect(result).toMatchObject({ target: "moved", marker: true, git: false, file: false });

			const quarantine = dirname(result.journal.moved[0]!.to);
			const quarantineSource = join(source, basename(quarantine));
			mkdirSync(join(projectSource, "second", ".git"), { recursive: true });
			writeFileSync(join(projectSource, "second", ".git", "config"), "keep");
			mkdirSync(project, { recursive: true });
			mkdirSync(quarantine);
			// The outer user namespace leaves system-root ownership unmapped, so the inner launcher cannot discover
			// trusted bubblewrap. Select its branch directly; journal lookup and the real kernel renames stay intact.
			const retry = `import { existsSync, readFileSync } from "node:fs";\nimport { join } from "node:path";\nimport { gitQuarantineMarker, LocalWorkspace, recoverGitQuarantine } from ${JSON.stringify(workspaceModule)};\nconst project = ${JSON.stringify(project)}; const state = ${JSON.stringify(state)}; let recovery = ""; try { recoverGitQuarantine(project, state); } catch (error) { recovery = String(error?.message ?? error); } const workspace = new LocalWorkspace(project); Object.defineProperty(workspace, "sandboxed", { value: "bubblewrap" }); let write = ""; try { await workspace.write("blocked", "bad"); } catch (error) { write = String(error?.message ?? error); } const command = await workspace.exec("printf bad > command", { timeoutMs: 5_000, signal: AbortSignal.timeout(5_000) }); const marker = gitQuarantineMarker(project, state); const events = readFileSync(marker, "utf8").trim().split("\\n").map(JSON.parse); const journal = { moved: events.filter((event) => event.event === "done").map(({ from, to }) => ({ from, to })) }; process.stdout.write(JSON.stringify({ recovery, write, command, journal, marker: existsSync(marker), git: existsSync(join(project, "second", ".git")), file: existsSync(join(project, "blocked")), commandFile: existsSync(join(project, "command")) }));`;
			const retried = spawnSync(bwrap, [
				"--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
				"--tmpfs", "/tmp",
				"--bind", projectSource, project, "--bind", quarantineSource, quarantine, "--bind", stateSource, state,
				"--unshare-all", "--die-with-parent", "--new-session", "--", process.execPath, "-e", retry,
			], { encoding: "utf8", env });
			expect(retried.status, retried.stderr).toBe(0);
			const retriedResult = JSON.parse(retried.stdout) as { recovery: string; write: string; command: { exitCode: number; output: string }; journal: { moved: { from: string }[] }; marker: boolean; git: boolean; file: boolean; commandFile: boolean };
			expect(retriedResult.recovery).toContain("EXDEV");
			expect(retriedResult.write).toContain("cleanup pending");
			expect(retriedResult.command.exitCode).toBe(125);
			expect(retriedResult.command.output).toContain("cleanup pending");
			expect(retriedResult.journal.moved.map((move) => move.from)).toEqual(["a/.git"]);
			expect(retriedResult).toMatchObject({ marker: true, git: true, file: false, commandFile: false });
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	}, 15_000);

	test.skipIf(process.platform !== "linux" || process.getuid?.() === 0 || sandboxer() !== "bubblewrap")("journal lookup errors block file writes and real contained commands after a failed pass", async () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-git-journal-lookup-")));
		const home = join(base, "state");
		const savedHome = process.env.EL_HOME;
		let directory: string | undefined;
		try {
			process.env.EL_HOME = home;
			for (const renamed of [false, true]) {
				const original = join(base, renamed ? "identity-project" : "direct-project");
				mkdirSync(original);
				const quarantine = gitQuarantineFolder(original);
				const held = holdGitEntries(original, 50_000, 64, undefined, quarantine);
				const marker = gitQuarantineMarker(original);
				directory = dirname(marker);
				try {
					mkdirSync(directory, { recursive: true, mode: 0o700 });
					writeFileSync(marker, `${JSON.stringify({ version: 1, project: original, baseline: held.baseline, quarantine, moved: [] })}\n`);
				} finally {
					held.release();
				}
				mkdirSync(join(original, ".git"));
				writeFileSync(join(original, ".git", "config"), "keep");
				chmodSync(quarantine, 0o777);
				expect(() => recoverGitQuarantine(original)).toThrow("cleanup pending");
				chmodSync(quarantine, 0o700);
				const root = renamed ? join(base, "renamed-project") : original;
				if (renamed) renameSync(original, root);
				const workspace = new LocalWorkspace(root, "workspace");
				expect(workspace.sandboxed).toBe("bubblewrap");
				// Search permission without enumeration tests the identity fallback; no search tests direct lookup.
				chmodSync(directory, renamed ? 0o100 : 0);
				await expect(workspace.write("blocked.txt", "bad")).rejects.toThrow("cleanup pending");
				const command = await workspace.exec("printf bad > command.txt", { timeoutMs: 5_000, signal: AbortSignal.timeout(5_000) });
				expect(command.exitCode).toBe(125);
				expect(command.output).toContain("cleanup pending");
				expect(existsSync(join(root, "blocked.txt"))).toBe(false);
				expect(existsSync(join(root, "command.txt"))).toBe(false);
				chmodSync(directory, 0o700);
				expect(existsSync(marker)).toBe(true);
				expect(readFileSync(join(root, ".git", "config"), "utf8")).toBe("keep");
				// The same unchanged record can recover once journal access is restored.
				await workspace.write("recovered.txt", "ok");
				expect(existsSync(marker)).toBe(false);
			}
		} finally {
			if (directory) chmodSync(directory, 0o700);
			if (savedHome === undefined) delete process.env.EL_HOME;
			else process.env.EL_HOME = savedHome;
			rmSync(base, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "linux" || process.getuid?.() === 0 || sandboxer() !== "bubblewrap")("renamed-project recovery refuses EACCES and EIO from every journal candidate", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-git-journal-candidate-errors-")));
		const original = join(base, "original");
		const project = join(base, "renamed");
		const home = join(base, "state");
		const savedHome = process.env.EL_HOME;
		mkdirSync(original);
		let marker = "";
		try {
			process.env.EL_HOME = home;
			const quarantine = gitQuarantineFolder(original, home);
			const held = holdGitEntries(original, 50_000, 64, undefined, quarantine);
			marker = gitQuarantineMarker(original, home);
			mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
			writeFileSync(marker, `${JSON.stringify({ version: 1, project: original, baseline: held.baseline, quarantine })}\n`, { mode: 0o600 });
			held.release();
			renameSync(original, project);

			chmodSync(marker, 0);
			expect(() => recoverGitQuarantine(project, home)).toThrow(/cleanup pending.*cleanup journal cannot be read/i);
			chmodSync(marker, 0o600);

			const workspaceModule = join(import.meta.dir, "../packages/engine/src/tools/workspace.ts");
			// Inject EIO at this candidate read. A /proc/self/mem bind can fail with EACCES under user namespaces.
			const script = `import { mock } from "bun:test";
import * as fs from "node:fs";
const readFile = fs.readFileSync;
mock.module("node:fs", () => ({ ...fs, readFileSync(file, ...args) {
	if (file === ${JSON.stringify(marker)}) throw Object.assign(new Error("EIO: input/output error"), { code: "EIO" });
	return readFile(file, ...args);
} }));
const { recoverGitQuarantine } = await import(${JSON.stringify(workspaceModule)});
try { recoverGitQuarantine(${JSON.stringify(project)}, ${JSON.stringify(home)}); process.exit(2); } catch (error) { const message = String(error?.message ?? error); process.stdout.write(message); if (!new RegExp("cleanup pending.*cleanup journal cannot be read.*(EIO|I/O error)", "i").test(message)) process.exit(3); }`;
			const ran = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: { ...process.env, HOME: home, EL_HOME: home } });
			expect(ran.status, ran.stderr || ran.stdout).toBe(0);
			expect(ran.stdout).toMatch(/cleanup journal cannot be read.*(EIO|I\/O error)/i);
			expect(existsSync(marker)).toBe(true);
		} finally {
			if (marker && existsSync(marker)) chmodSync(marker, 0o600);
			if (savedHome === undefined) delete process.env.EL_HOME;
			else process.env.EL_HOME = savedHome;
			rmSync(base, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "linux")("ordinary writes work when the engine home is inside the project home", async () => {
		const project = realpathSync(mkdtempSync(join(tmpdir(), "el-home-project-")));
		const home = join(project, ".el");
		const savedHome = process.env.EL_HOME;
		try {
			process.env.EL_HOME = home;
			const workspace = new LocalWorkspace(project);
			await workspace.write("ordinary.txt", "ok\n");
			expect(readFileSync(join(project, "ordinary.txt"), "utf8")).toBe("ok\n");
			expect(existsSync(join(home, "quarantine"))).toBe(false);
			expect(existsSync(gitQuarantineMarker(project, home))).toBe(false);
		} finally {
			if (savedHome === undefined) delete process.env.EL_HOME;
			else process.env.EL_HOME = savedHome;
			rmSync(project, { recursive: true, force: true });
		}
	});

	test("home-project file writes refuse engine state and trusted Git configuration through direct and linked names", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-home-file-tools-")));
		const home = join(base, "home");
		const engineHome = join(home, ".el");
		const xdg = join(home, ".config");
		mkdirSync(engineHome, { recursive: true });
		mkdirSync(join(xdg, "git"), { recursive: true });
		writeFileSync(join(engineHome, "config.json"), "engine\n");
		writeFileSync(join(home, ".gitconfig"), "global\n");
		writeFileSync(join(xdg, "git", "config"), "xdg\n");
		writeFileSync(join(home, "custom-git-config"), "custom\n");
		symlinkSync(engineHome, join(home, "engine-link"));
		linkSync(join(engineHome, "config.json"), join(home, "engine-hard"));
		try {
			const module = join(import.meta.dir, "../packages/engine/src/tools/workspace.ts");
			const script = `import { readFileSync } from "node:fs";\nimport { join } from "node:path";\nimport { LocalWorkspace } from ${JSON.stringify(module)};\nconst home = process.env.HOME; if (!home) process.exit(9); const workspace = new LocalWorkspace(home); const refused = []; for (const path of [".el/config.json", ".gitconfig", ".config/git/config", "custom-git-config", "engine-link/config.json", "engine-hard"]) { try { await workspace.write(path, "changed"); refused.push([path, "allowed"]); } catch (error) { refused.push([path, String(error?.message ?? error)]); } } await workspace.write("ordinary", "ok"); process.stdout.write(JSON.stringify({ refused, engine: readFileSync(join(home, ".el", "config.json"), "utf8"), global: readFileSync(join(home, ".gitconfig"), "utf8"), xdg: readFileSync(join(home, ".config", "git", "config"), "utf8"), custom: readFileSync(join(home, "custom-git-config"), "utf8"), ordinary: readFileSync(join(home, "ordinary"), "utf8") }));`;
			const ran = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: { ...process.env, HOME: home, EL_HOME: engineHome, XDG_CONFIG_HOME: xdg, GIT_CONFIG_GLOBAL: join(home, "custom-git-config") } });
			expect(ran.status, ran.stderr).toBe(0);
			const result = JSON.parse(ran.stdout) as { refused: [string, string][]; engine: string; global: string; xdg: string; custom: string; ordinary: string };
			expect(result.refused.every(([, message]) => message !== "allowed" && /trusted engine or Git configuration|hard link/.test(message))).toBe(true);
			expect(result).toMatchObject({ engine: "engine\n", global: "global\n", xdg: "xdg\n", custom: "custom\n", ordinary: "ok" });
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test.skipIf(!["darwin", "linux"].includes(process.platform) || !["seatbelt", "bubblewrap"].includes(sandboxer() ?? ""))("home-project contained commands cannot write, rename, symlink or hard-link into trusted state", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-home-trusted-")));
		const home = join(base, "home");
		const engineHome = join(home, ".el");
		const xdg = join(home, ".config");
		mkdirSync(join(engineHome, "app-data"), { recursive: true });
		mkdirSync(join(xdg, "git"), { recursive: true });
		writeFileSync(join(engineHome, "config.json"), "engine\n");
		writeFileSync(join(home, ".gitconfig"), "global\n");
		writeFileSync(join(xdg, "git", "config"), "xdg\n");
		writeFileSync(join(home, "safe"), "safe\n");
		symlinkSync(engineHome, join(home, "engine-link"));
		linkSync(join(engineHome, "config.json"), join(home, "engine-hard"));
		try {
			const module = join(import.meta.dir, "../packages/engine/src/tools/workspace.ts");
			const script = `import { existsSync, readFileSync } from "node:fs";\nimport { join } from "node:path";\nimport { LocalWorkspace } from ${JSON.stringify(module)};\nconst home = process.env.HOME; if (!home) process.exit(9); const workspace = new LocalWorkspace(home, "workspace");\nconst refused = []; for (const path of [".el/config.json", ".gitconfig", ".config/git/config", "engine-link/config.json", "engine-hard"]) { try { await workspace.write(path, "changed"); refused.push([path, "allowed"]); } catch (error) { refused.push([path, String(error?.message ?? error)]); } }\nawait workspace.write("ordinary-file", "ok");\nconst commands = ["printf bad > .el/config.json", "mv safe .el/config.json", "ln -s ../safe .el/new-link", "ln safe .el/new-hard", "printf bad > .gitconfig", "mv safe .gitconfig", "ln -s ../../safe .config/git/new-link", "ln safe .config/git/new-hard"]; const commandResults = []; for (const command of commands) commandResults.push(await workspace.exec(command, { timeoutMs: 5_000, signal: AbortSignal.timeout(5_000) }));\nconst ordinary = await workspace.exec("printf ok > ordinary-command", { timeoutMs: 5_000, signal: AbortSignal.timeout(5_000) });\nprocess.stdout.write(JSON.stringify({ refused, commandResults, ordinary, engine: readFileSync(join(home, ".el", "config.json"), "utf8"), global: readFileSync(join(home, ".gitconfig"), "utf8"), xdg: readFileSync(join(home, ".config", "git", "config"), "utf8"), safe: readFileSync(join(home, "safe"), "utf8"), made: [".el/new-link", ".el/new-hard", ".config/git/new-link", ".config/git/new-hard"].some((path) => existsSync(join(home, path))) }));`;
			const ran = spawnSync(process.execPath, ["-e", script], {
				encoding: "utf8",
				env: { ...process.env, HOME: home, EL_HOME: engineHome, XDG_CONFIG_HOME: xdg, GIT_CONFIG_GLOBAL: "/dev/null" },
			});
			expect(ran.status, ran.stderr).toBe(0);
			const result = JSON.parse(ran.stdout) as { refused: [string, string][]; commandResults: { exitCode: number }[]; ordinary: { exitCode: number; output: string }; engine: string; global: string; xdg: string; safe: string; made: boolean };
			expect(result.refused.every(([, message]) => message !== "allowed" && /trusted engine or Git configuration|hard link/.test(message))).toBe(true);
			expect(result.commandResults.every((command) => command.exitCode !== 0)).toBe(true);
			expect(result.ordinary.exitCode, result.ordinary.output).toBe(0);
			expect(result).toMatchObject({ engine: "engine\n", global: "global\n", xdg: "xdg\n", safe: "safe\n", made: false });
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	}, 30_000);

	test.skipIf(process.platform !== "linux" || sandboxer() !== "bubblewrap")("a pending .git journal blocks contained commands and file writes until an anchored pass succeeds", async () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-git-write-gate-")));
		const root = join(base, "project");
		const home = join(base, "state");
		const savedHome = process.env.EL_HOME;
		mkdirSync(root);
		try {
			process.env.EL_HOME = home;
			const quarantine = gitQuarantineFolder(root, home);
			const held = holdGitEntries(root, 50_000, 64, undefined, quarantine);
			const marker = gitQuarantineMarker(root, home);
			mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
			writeFileSync(marker, `${JSON.stringify({ version: 1, project: root, baseline: held.baseline, quarantine })}\n`);
			held.release();
			mkdirSync(join(root, ".git"));
			writeFileSync(join(root, ".git", "config"), "keep\n");
			chmodSync(quarantine, 0o777);
			const workspace = new LocalWorkspace(root, "workspace");
			await expect(workspace.write("blocked.txt", "blocked")).rejects.toThrow(/cleanup pending|could not verify its private \.git quarantine/);
			expect(existsSync(join(root, "blocked.txt"))).toBe(false);
			const command = await workspace.exec("printf blocked > command.txt", { timeoutMs: 5_000, signal: AbortSignal.timeout(5_000) });
			// Refused either at the quarantine check (its mode was broken above) or at the pending cleanup.
			expect(command.exitCode).toBe(125);
			expect(command.output).toMatch(/cleanup pending|could not verify its private \.git quarantine/);
			expect(existsSync(join(root, "command.txt"))).toBe(false);
			await expect(workspace.write("blocked.txt", "blocked")).rejects.toThrow(/cleanup pending|could not verify its private \.git quarantine/);
			expect(existsSync(join(root, "blocked.txt"))).toBe(false);
			expect(existsSync(marker)).toBe(true);
			chmodSync(quarantine, 0o700);
			await workspace.write("recovered.txt", "ok");
			expect(readFileSync(join(root, "recovered.txt"), "utf8")).toBe("ok");
			expect(existsSync(join(root, ".git"))).toBe(false);
			expect(existsSync(marker)).toBe(false);
		} finally {
			if (savedHome === undefined) delete process.env.EL_HOME;
			else process.env.EL_HOME = savedHome;
			rmSync(base, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "linux" || process.getuid?.() === 0 || sandboxer() !== "bubblewrap")("a pending fallback .git journal stays bound to its quarantine when a sibling becomes available", async () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-git-fallback-write-gate-")));
		const parent = join(base, "locked");
		const root = join(parent, "project");
		const home = join(base, "state");
		const savedHome = process.env.EL_HOME;
		mkdirSync(root, { recursive: true });
		mkdirSync(home, { mode: 0o700 });
		chmodSync(parent, 0o555);
		try {
			process.env.EL_HOME = home;
			const quarantine = gitQuarantineFolder(root, home);
			expect(quarantine).toStartWith(join(home, "quarantine"));
			const held = holdGitEntries(root, 50_000, 64, undefined, quarantine);
			const marker = gitQuarantineMarker(root, home);
			try {
				mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
				writeFileSync(marker, `${JSON.stringify({ version: 1, project: root, baseline: held.baseline, quarantine })}\n`);
			} finally {
				held.release();
			}
			mkdirSync(join(root, ".git"));
			writeFileSync(join(root, ".git", "config"), "keep\n");
			// A safe new sibling cannot replace the destination recorded by the pending cleanup.
			chmodSync(parent, 0o700);
			expect(gitQuarantineFolder(root, home)).not.toBe(quarantine);
			chmodSync(quarantine, 0o777);
			const workspace = new LocalWorkspace(root, "workspace");
			await expect(workspace.write("blocked.txt", "blocked")).rejects.toThrow("cleanup pending");
			expect(existsSync(join(root, "blocked.txt"))).toBe(false);
			const command = await workspace.exec("printf blocked > command.txt", { timeoutMs: 5_000, signal: AbortSignal.timeout(5_000) });
			expect(command.exitCode).toBe(125);
			expect(command.output).toContain("cleanup pending");
			expect(existsSync(join(root, "command.txt"))).toBe(false);
			expect(existsSync(marker)).toBe(true);
			expect(readFileSync(join(root, ".git", "config"), "utf8")).toBe("keep\n");
			chmodSync(quarantine, 0o700);
			await workspace.write("recovered.txt", "ok");
			expect(readFileSync(join(root, "recovered.txt"), "utf8")).toBe("ok");
			expect(existsSync(join(root, ".git"))).toBe(false);
			expect(existsSync(marker)).toBe(false);
			expect(readdirSync(quarantine).some((name) => readFileSync(join(quarantine, name, "config"), "utf8") === "keep\n")).toBe(true);
		} finally {
			if (savedHome === undefined) delete process.env.EL_HOME;
			else process.env.EL_HOME = savedHome;
			chmodSync(parent, 0o700);
			rmSync(base, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "linux")("file writes refuse an unsafe quarantine without a journal or a prior command check", async () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-git-write-quarantine-")));
		const root = join(base, "project");
		const home = join(base, "state");
		const savedHome = process.env.EL_HOME;
		mkdirSync(root);
		try {
			process.env.EL_HOME = home;
			const quarantine = gitQuarantineFolder(root, home);
			const marker = gitQuarantineMarker(root, home);
			const workspace = new LocalWorkspace(root);
			chmodSync(quarantine, 0o777);
			expect(existsSync(marker)).toBe(false);
			await expect(workspace.write("blocked.txt", "blocked")).rejects.toThrow(/cleanup pending|could not verify its private \.git quarantine/);
			expect(existsSync(join(root, "blocked.txt"))).toBe(false);
			chmodSync(quarantine, 0o700);
			await workspace.write("recovered.txt", "ok");
			expect(readFileSync(join(root, "recovered.txt"), "utf8")).toBe("ok");
		} finally {
			if (savedHome === undefined) delete process.env.EL_HOME;
			else process.env.EL_HOME = savedHome;
			rmSync(base, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "linux")("Linux bind checks follow links and case variants into hidden credential folders", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-private-bind-")));
		try {
			const home = join(base, "home");
			const project = join(base, "project");
			mkdirSync(join(home, ".ssh"), { recursive: true });
			mkdirSync(join(home, ".SSH"));
			mkdirSync(project);
			writeFileSync(join(home, ".ssh", "key"), "secret");
			symlinkSync(join(home, ".ssh"), join(project, "linked"));
			expect(privateBindPath(join(project, "linked", "key"), home)).toBe(true);
			expect(privateBindPath(join(home, ".SSH"), home)).toBe(true);
			expect(privateBindPath(home, home)).toBe(false);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform === "win32")("project .pixi links cannot become engine-home write grants", async () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-pixi-engine-grant-")));
		const state = join(base, "state");
		const project = join(base, "project");
		const other = join(state, "apps", "other", ".pixi");
		const config = join(state, "config.json");
		const savedHome = process.env.EL_HOME;
		try {
			process.env.EL_HOME = state;
			mkdirSync(project);
			mkdirSync(other, { recursive: true });
			writeFileSync(join(project, "pixi.toml"), "[workspace]\nname = \"project\"\nchannels = [\"conda-forge\"]\nplatforms = []\n\n[dependencies]\n");
			writeFileSync(config, "trusted\n");
			for (const target of [config, other]) {
				symlinkSync(target, join(project, ".pixi"));
				await expect(inEnvironment(project, ["true"], join(state, "tools"), () => undefined)).rejects.toThrow(".pixi is a link");
				expect(() => createEngineWriteGrant(join(project, ".pixi"))).toThrow("named below the engine home");
				rmSync(join(project, ".pixi"), { force: true });
			}

			const recorded = createEngineWriteGrant(other);
			const moved = join(state, "apps", "other", "saved-environment");
			renameSync(other, moved);
			symlinkSync(config, other);
			expect(() => contained("/bin/true", [], { writable: [], network: "none", engineWrite: [recorded] })).toThrow("link, missing, or no longer has its recorded identity");
		} finally {
			if (savedHome === undefined) delete process.env.EL_HOME;
			else process.env.EL_HOME = savedHome;
			rmSync(base, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform === "win32" || sandboxer() === undefined)("app package scripts cannot replace the recorded .pixi directory", async () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-pixi-install-identity-")));
		const state = join(base, "state");
		const home = join(base, "home");
		const target = join(base, "target");
		const savedHome = process.env.HOME;
		const savedState = process.env.EL_HOME;
		mkdirSync(home);
		mkdirSync(target);
		try {
			process.env.HOME = home;
			process.env.EL_HOME = state;
			for (const replacement of ["link", "directory"] as const) {
				const app = join(base, `app-${replacement}`);
				const recorded = join(app, "recorded_environment");
				mkdirSync(app);
				writeFileSync(join(app, "pixi.toml"), "[workspace]\nname = \"test\"\nchannels = []\nplatforms = []\n");
				const installer: EnvironmentInstaller = {
					program: async () => "/bin/true",
					run: async () => {
						renameSync(join(app, ".pixi"), recorded);
						if (replacement === "link") symlinkSync(target, join(app, ".pixi"));
						else mkdirSync(join(app, ".pixi"));
						return 0;
					},
				};
				await expect(inEnvironment(app, ["true"], join(state, "tools"), () => undefined, false, installer)).rejects.toThrow("became a link or changed identity");
				if (replacement === "link") expect(lstatSync(join(app, ".pixi")).isSymbolicLink()).toBe(true);
				else expect(lstatSync(join(app, ".pixi"), { bigint: true }).ino).not.toBe(lstatSync(recorded, { bigint: true }).ino);
			}
		} finally {
			if (savedHome === undefined) delete process.env.HOME;
			else process.env.HOME = savedHome;
			if (savedState === undefined) delete process.env.EL_HOME;
			else process.env.EL_HOME = savedState;
			rmSync(base, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "linux" || sandboxer() !== "bubblewrap")("bubblewrap masks private paths and recorded package-cache grants write without widening writable", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-private-mount-")));
		const savedHome = process.env.EL_HOME;
		try {
			const state = join(base, "state");
			const credentials = join(state, "credentials");
			const project = join(base, "project");
			mkdirSync(credentials, { recursive: true });
			mkdirSync(join(project, ".git"), { recursive: true });
			symlinkSync(credentials, join(project, ".git", "info"));
			process.env.EL_HOME = state;
			expect(() => contained("/bin/true", [], { writable: [], readable: [credentials], network: "none" })).toThrow("inside a hidden credential");
			expect(() => contained("/bin/true", [], { writable: [project], protect: [join(project, ".git", "info")], network: "none", exact: true })).toThrow("inside a hidden credential");
			const launch = contained("/bin/true", [], { writable: [base], network: "none" });
			const bind = launch.args.findIndex((item, index) => item === base && launch.args[index - 1] === "--bind");
			const mask = launch.args.findIndex((item) => item === credentials);
			expect(bind).toBeGreaterThan(0);
			expect(mask).toBeGreaterThan(bind);

			const appRoot = join(state, "app-data");
			const current = join(appRoot, "current");
			const sibling = join(appRoot, "sibling");
			mkdirSync(current, { recursive: true });
			mkdirSync(sibling);
			writeFileSync(join(sibling, "secret"), "sibling-secret");
			const app = contained("/bin/bash", ["-c", 'printf ok > "$1/result"; cat "$2/secret" 2>/dev/null || true', "--", current, sibling], {
				writable: [current],
				network: "none",
				appData: { root: appRoot, current },
			});
			try {
				const ran = spawnSync(app.file, app.args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", ...(app.pass ?? [])] });
				expect(ran.status).toBe(0);
				expect(ran.stdout).not.toContain("sibling-secret");
				expect(readFileSync(join(current, "result"), "utf8")).toBe("ok");
			} finally {
				app.release?.();
			}
			expect(() => contained("/bin/true", [], { writable: [sibling], network: "none", appData: { root: appRoot, current } })).toThrow("only its own direct app-data folder");

			const installed = join(state, "apps", "demo");
			const cache = join(state, "tools", "pixi-cache");
			mkdirSync(installed, { recursive: true });
			mkdirSync(cache, { recursive: true });
			writeFileSync(join(state, "config.json"), "trusted\n");
			const installedGrant = createEngineWriteGrant(installed);
			const cacheGrant = createEngineWriteGrant(cache);
			const installer = contained("/bin/bash", ["-c", 'printf app > "$1/result"; printf cache > "$2/result"; printf bad > "$3" 2>/dev/null || true', "--", installed, cache, join(state, "config.json")], {
				writable: [],
				network: "none",
				engineWrite: [installedGrant, cacheGrant],
			});
			try {
				const ran = spawnSync(installer.file, installer.args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", ...(installer.pass ?? [])] });
				expect(ran.status, ran.stderr).toBe(0);
				expect(readFileSync(join(installed, "result"), "utf8")).toBe("app");
				expect(readFileSync(join(cache, "result"), "utf8")).toBe("cache");
				expect(readFileSync(join(state, "config.json"), "utf8")).toBe("trusted\n");
			} finally {
				installer.release?.();
			}
		} finally {
			if (savedHome === undefined) delete process.env.EL_HOME;
			else process.env.EL_HOME = savedHome;
			rmSync(base, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "linux")("Linux retries a persisted .git quarantine before another launch and keeps invalid journals", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-git-recovery-")));
		const root = join(base, "project");
		const home = join(base, "state");
		const quarantine = join(base, "quarantine");
		mkdirSync(join(root, "existing", ".git"), { recursive: true });
		try {
			const held = holdGitEntries(root, 50_000, 64, undefined, quarantine);
			const marker = gitQuarantineMarker(root, home);
			mkdirSync(dirname(marker), { recursive: true });
			writeFileSync(marker, `${JSON.stringify({ version: 1, project: root, baseline: held.baseline, quarantine })}\n`);
			held.release();
			mkdirSync(join(root, "left", ".git"), { recursive: true });
			writeFileSync(join(root, "left", ".git", "config"), "keep");
			const recovered = recoverGitQuarantine(root, home);
			expect(recovered.moved.map((entry) => entry.from)).toEqual(["left/.git"]);
			expect(existsSync(marker)).toBe(false);
			expect(existsSync(join(root, "existing", ".git"))).toBe(true);
			expect(readFileSync(join(recovered.moved[0]!.to, "config"), "utf8")).toBe("keep");

			const renamedHeld = holdGitEntries(root, 50_000, 64, undefined, quarantine);
			writeFileSync(marker, `${JSON.stringify({ version: 1, project: root, baseline: renamedHeld.baseline, quarantine })}\n`);
			renamedHeld.release();
			const renamed = join(base, "renamed-project");
			renameSync(root, renamed);
			mkdirSync(join(renamed, "alias", ".git"), { recursive: true });
			writeFileSync(join(renamed, "alias", ".git", "config"), "alias");
			const foundByIdentity = recoverGitQuarantine(renamed, home);
			expect(foundByIdentity.moved.map((entry) => entry.from)).toEqual(["alias/.git"]);
			expect(existsSync(join(renamed, "alias", ".git"))).toBe(false);
			renameSync(renamed, root);
			writeFileSync(marker, "not json\n");
			expect(() => recoverGitQuarantine(root, home)).toThrow("No contained command ran");
			expect(existsSync(marker)).toBe(true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "linux" || sandboxer() !== "bubblewrap")("Linux commands write results, protect existing .git, and quarantine new metadata after foreground and background work", async () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-linux-metadata-")));
		const root = join(base, "project");
		const savedHome = process.env.EL_HOME;
		mkdirSync(root);
		process.env.EL_HOME = join(base, "state");
		try {
			const quarantine = gitQuarantineFolder(root, process.env.EL_HOME);
			mkdirSync(join(root, ".git"));
			writeFileSync(join(root, ".git", "config"), "existing\n");
			mkdirSync(join(root, "pointer"));
			writeFileSync(join(root, "pointer", ".git"), "gitdir: elsewhere\n");
			const ws = new LocalWorkspace(root, "workspace");
			const output: string[] = [];
			const options = { timeoutMs: 5_000, signal: AbortSignal.timeout(5_000), onOutput: (text: string) => output.push(text) };
			expect((await ws.exec("printf x > ordinary", options)).exitCode).toBe(0);
			expect(readFileSync(join(root, "ordinary"), "utf8")).toBe("x");
			expect((await ws.exec("printf bad > .git/config", options)).exitCode).not.toBe(0);
			expect((await ws.exec("printf bad > pointer/.git", options)).exitCode).not.toBe(0);
			expect(readFileSync(join(root, ".git", "config"), "utf8")).toBe("existing\n");
			expect(readFileSync(join(root, "pointer", ".git"), "utf8")).toBe("gitdir: elsewhere\n");
			const foreground = await ws.exec("mkdir -p made/.git && printf keep > made/.git/config", options);
			expect(foreground.exitCode).toBe(0);
			// Keep the launching shell alive for its job. The existing --die-with-parent rule kills orphaned jobs.
			const background = await ws.exec("(sleep 0.2; mkdir -p later; printf pointer > later/.git) >/dev/null 2>&1 & wait", options);
			expect(background.exitCode).toBe(0);
			for (const folder of ["made", "later"]) {
				expect(existsSync(join(root, folder, ".git"))).toBe(false);
				expect((folder === "made" ? foreground : background).output).toContain(`EnrichedLab moved "${folder}/.git"`);
			}
			const quarantined = readdirSync(quarantine).map((name) => join(quarantine, name)).filter((path) => basename(path) !== "project");
			expect(quarantined.some((path) => lstatSync(path).isDirectory() && readFileSync(join(path, "config"), "utf8") === "keep")).toBe(true);
			expect(quarantined.some((path) => lstatSync(path).isFile() && readFileSync(path, "utf8") === "pointer")).toBe(true);
			expect(output.join("")).toContain('EnrichedLab moved "later/.git"');
			const hostile = await ws.exec("mkdir -p sealed/deeper/.git && printf keep > sealed/deeper/.git/config && chmod 000 sealed && chmod 500 .", options);
			expect(hostile.exitCode).toBe(0);
			expect(existsSync(gitQuarantineMarker(root))).toBe(false);
			expect(lstatSync(root).mode & 0o777).toBe(0o500);
			chmodSync(root, 0o700);
			expect(lstatSync(join(root, "sealed")).mode & 0o777).toBe(0);
			chmodSync(join(root, "sealed"), 0o700);
			expect(existsSync(join(root, "sealed", "deeper", ".git"))).toBe(false);
			expect(readdirSync(quarantine).map((name) => join(quarantine, name)).some((path) => lstatSync(path).isDirectory() && readFileSync(join(path, "config"), "utf8") === "keep")).toBe(true);
		} finally {
			try {
				chmodSync(root, 0o700);
				chmodSync(join(root, "sealed"), 0o700);
			} catch {
				// The setup may not have reached its mode changes.
			}
			if (savedHome === undefined) delete process.env.EL_HOME;
			else process.env.EL_HOME = savedHome;
			rmSync(base, { recursive: true, force: true });
		}
	}, 15_000);

	test("round 8: file writes reject .git before and after following links, without blocking an ancestor .git", async () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "el-git-paths-")));
		try {
			const root = join(base, "repo", ".git", "enrichedlab-worktrees", "s1");
			mkdirSync(root, { recursive: true });
			mkdirSync(join(root, "nested", ".GiT"), { recursive: true });
			mkdirSync(join(root, "control"));
			writeFileSync(join(root, "control", ".git"), "gitdir: elsewhere\n");
			const ws = new LocalWorkspace(root);
			await ws.write("ok.txt", "ok\n");
			await expect(ws.write("nested/.GiT/config", "x")).rejects.toThrow(".git path");
			symlinkSync(join(root, "nested", ".GiT"), join(root, "alias"));
			await expect(ws.write("alias/config", "x")).rejects.toThrow(".git path");
			mkdirSync(join(root, "linked"));
			symlinkSync(join(root, "nested"), join(root, "linked", ".git"));
			expect(projectGitPaths(root)).toContain(join(root, "nested", ".GiT"));
			expect(projectGitPaths(root)).toContain(join(root, "control", ".git"));
			expect(projectGitPaths(root)).toContain(join(root, "linked", ".git"));
			const pattern = new RegExp(projectGitPattern(root));
			expect(pattern.test(join(root, ".git"))).toBe(true);
			expect(pattern.test(join(root, "a", ".GIT", "config"))).toBe(true);
			expect(pattern.test(join(base, "repo", ".git", "config"))).toBe(false);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test("listing packages never downloads pixi, and a copy that doesn't match its hash isn't run", async () => {
		const { PIXI_VERSION, pixiHere } = await import("../packages/engine/src/apps/environments.ts");
		const tools = realpathSync(mkdtempSync(join(tmpdir(), "el-pixi-")));
		try {
			expect(pixiHere(tools)).toBeUndefined();
			writeFileSync(join(tools, `pixi-${PIXI_VERSION}${process.platform === "win32" ? ".exe" : ""}`), "not pixi");
			expect(pixiHere(tools)).toBeUndefined();
		} finally {
			rmSync(tools, { recursive: true, force: true });
		}
	});
});
