// Shell lines read as the shell reads them (tools/shell_syntax.ts), and the lab sandbox's file fence
// (sites/sandbox_fence.ts).

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isReadOnlyCommand } from "../packages/engine/src/tools/shell.ts";
import { everyCommand, plainCommands } from "../packages/engine/src/tools/shell_syntax.ts";
import { FENCE_PY } from "../packages/engine/src/sites/sandbox_fence.ts";
import { type SandboxApi, SandboxWorkspace } from "../packages/engine/src/sites/sandbox_workspace.ts";

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
					return { exitCode: 0, stdout: c.includes(" probe") ? probe : "", stderr: "", timedOut: false };
				},
			}) as unknown as SandboxApi;
		const lab = new SandboxWorkspace(api("el-fence ok abi 6\n"), "/sandbox/work/p");
		await lab.write("alias/marker.txt", "x");
		expect(commands.some((c) => c.includes("realpath -m -- '/sandbox/work/p/alias'") && c.includes("leads outside the project"))).toBe(true);
		commands.length = 0;
		await lab.write("/sandbox/data/x.txt", "x", { outside: true });
		expect(commands.some((c) => c.includes("leads outside"))).toBe(false);
		await lab.exec("python3 run.py", { timeoutMs: 5_000, signal: AbortSignal.timeout(5_000), fence: ["python3", "run.py"] });
		expect(commands.at(-1)).toContain(`run "$(pwd -P)" bash -c 'python3 run.py'`);
		// No fence here: a fenced command doesn't run.
		const bare = new SandboxWorkspace(api("el-fence no\n"), "/sandbox/work/p");
		commands.length = 0;
		const r = await bare.exec("python3 run.py", { timeoutMs: 5_000, signal: AbortSignal.timeout(5_000), fence: [] });
		expect(r.exitCode).toBe(125);
		expect(commands.some((c) => c.includes("run.py"))).toBe(false);
	});

	// The fence itself needs Linux (Landlock); a Linux machine runs it for real.
	test.skipIf(process.platform !== "linux" || spawnSync("python3", ["--version"]).status !== 0)("Landlock keeps writes in the project", () => {
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
			const probe = spawnSync("python3", ["-I", script, "probe"], { cwd: project, encoding: "utf8" });
			if (!probe.stdout.startsWith("el-fence ok")) return; // this kernel has no Landlock: the probe says so
			const run = (command: string) => spawnSync("python3", ["-I", script, "run", project, "bash", "-c", command], { cwd: project, encoding: "utf8" });
			expect(run("echo hi > inside.txt").status).toBe(0);
			for (const command of ["echo bad > alias/marker.txt", "unlink ../other/marker.txt", "python3 -c 'import os; os.remove(\"../other/marker.txt\")'", "mkdir ../other/d"]) expect([command, run(command).status]).not.toEqual([command, 0]);
			expect(readFileSync(join(other, "marker.txt"), "utf8")).toBe("keep");
			expect(existsSync(join(project, "inside.txt"))).toBe(true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
