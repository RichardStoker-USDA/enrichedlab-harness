import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { commandLine, quoteArg, runContained, systemCommand, systemPowerShell } from "../packages/engine/src/tools/windows_contain.ts";
import { contained } from "../packages/engine/src/tools/workspace.ts";

describe("Windows command lines", () => {
	test("arguments survive quoting", () => {
		expect(quoteArg("plain")).toBe("plain");
		expect(quoteArg("two words")).toBe('"two words"');
		expect(quoteArg('say "hi"')).toBe('"say \\"hi\\""');
		expect(quoteArg("C:\\path with space\\")).toBe('"C:\\path with space\\\\"');
		expect(quoteArg("")).toBe('""');
		expect(commandLine(["cmd.exe", "/d", "/c", 'echo hi> "C:\\a b\\x.txt"'])).toBe('cmd.exe /d /c echo hi> "C:\\a b\\x.txt"');
		expect(commandLine(["pwsh.exe", "-Command", "Get-Item 'a b'"])).toBe('pwsh.exe -Command "Get-Item \'a b\'"');
	});
});

describe.if(process.platform === "win32")("Windows containment", () => {
	test("the helper starts a command under the restricted token and returns its exit code", () => {
		const command = systemCommand()!;
		const helper = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "packages", "cli", "src", "main.ts"), "__contain", JSON.stringify([tmpdir()]), "--", command, "/d", "/c", "exit 7"]);
		expect({ code: helper.exitCode, stderr: helper.stderr.toString().slice(0, 1_500) }).toEqual({ code: 7, stderr: "" });
	}, 60_000);

	test("PowerShell and cmd come only from absolute OS installation paths", async () => {
		const project = mkdtempSync(join(tmpdir(), "shell-path-"));
		try {
			writeFileSync(join(project, "pwsh.exe"), "project controlled");
			writeFileSync(join(project, "powershell.exe"), "project controlled");
			const shell = systemPowerShell(project, { ...process.env, PATH: project });
			expect(shell).toBeDefined();
			expect(isAbsolute(shell!.file)).toBe(true);
			expect(shell!.file.toLowerCase().startsWith(project.toLowerCase())).toBe(false);
			expect(isAbsolute(systemCommand()!)).toBe(true);
			await expect(runContained(project, [project], ["pwsh.exe", "-Command", "exit 0"])).rejects.toThrow("absolute executable path");
		} finally {
			rmSync(project, { recursive: true, force: true });
		}
	});

	test("writes inside the project, not elsewhere in the home folder", () => {
		const project = mkdtempSync(join(tmpdir(), "contain-"));
		const outside = join(homedir(), "contain_outside_codetestfile.txt");
		try {
			const program = systemCommand()!;
			const run = (command: string) => {
				const c = contained(program, ["/d", "/c", command], { writable: [project], network: "none" });
				expect(c.facility).toBe("restricted-token");
				return Bun.spawnSync([c.file, ...c.args], { cwd: project });
			};
			const wrote = run(`echo inside> "${join(project, "a.txt")}"`);
			const acl = Bun.spawnSync(["icacls", project]).stdout.toString();
			expect({ code: wrote.exitCode, out: wrote.stdout.toString() + wrote.stderr.toString(), acl }).toMatchObject({ code: 0 });
			expect(readFileSync(join(project, "a.txt"), "utf8").trim()).toBe("inside");
			run(`echo outside> "${outside}"`);
			expect(() => readFileSync(outside)).toThrow();
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(outside, { force: true });
		}
	}, 60_000);

	test("stdin and stdout pass through the helper", () => {
		const c = contained(systemCommand()!, ["/d", "/c", "findstr", "x"], { writable: [tmpdir()], network: "none" });
		const piped = Bun.spawnSync([c.file, ...c.args], { stdin: Buffer.from("x marks\n") });
		expect({ code: piped.exitCode, out: piped.stdout.toString().trim(), err: piped.stderr.toString() }).toEqual({ code: 0, out: "x marks", err: "" });
	}, 60_000);
});
