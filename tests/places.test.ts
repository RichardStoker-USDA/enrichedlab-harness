// Boundaries around where work runs: credential folders, the sandbox console, and labs that keep data inside.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Terminals } from "../packages/engine/src/terminal.ts";
import { showTool } from "../packages/engine/src/tools/harness.ts";
import { LocalWorkspace, type Workspace } from "../packages/engine/src/tools/workspace.ts";
import { type SandboxApi, SandboxWorkspace } from "../packages/engine/src/sites/sandbox_workspace.ts";

const made: string[] = [];
function scratch(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), `lab-${name}-`));
	made.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("credential folders", () => {
	// Bun's homedir() ignores a changed HOME, so this uses the real ~/.ssh path with a name that doesn't exist and
	// never writes: the guard refuses before any file is touched.
	test("file tools refuse ~/.ssh by path and through a link in the project", async () => {
		const project = scratch("project");
		symlinkSync(join(homedir(), ".ssh"), join(project, "keys"));
		const ws = new LocalWorkspace(project);
		await expect(ws.read("~/.ssh/enriched_absent")).rejects.toThrow("never reads or writes");
		await expect(ws.read("keys/enriched_absent")).rejects.toThrow("never reads or writes");
		if (existsSync(join(homedir(), ".ssh"))) expect(await ws.stat("keys")).toBeUndefined();
		writeFileSync(join(project, "notes.md"), "fine");
		expect((await ws.read("notes.md")).toString()).toBe("fine");
	});
});

describe("sandbox console", () => {
	test("stderr is shown and the folder survives it", async () => {
		const commands: string[] = [];
		const fake = {
			kind: "sandbox",
			root: "/sandbox/work/p",
			async exec(command: string) {
				commands.push(command);
				const marker = command.match(/__enriched_cwd_\w+/)![0];
				return { exitCode: 1, timedOut: false, output: `listed\n\n${marker}/sandbox/work/p/sub\nls: cannot access 'x'` };
			},
		} as unknown as Workspace;
		let shown = "";
		const terms = new Terminals((_name, params) => void (shown += params.data ?? ""));
		const { termId } = terms.start(fake, "EnrichedLab", 80, 24);
		terms.input(termId, "cd sub; ls x\r");
		await new Promise((r) => setTimeout(r, 20));
		expect(shown).toContain("listed");
		expect(shown).toContain("cannot access 'x'");
		expect(shown).toContain("EnrichedLab\x1b[0m:~/sub$ ");
		terms.input(termId, "\x1b[Apwd\r");
		await new Promise((r) => setTimeout(r, 20));
		expect(commands[1]).toContain("cd '/sandbox/work/p/sub' && { pwd\n}");
		terms.closeAll();
	});
});

describe("isolated labs", () => {
	test("show refuses addresses in a sealed session", async () => {
		const ctx = { sessionId: "s", sealed: true, project: "/p" } as never;
		await expect(showTool.run({ title: "App", url: "https://example.org" }, ctx)).rejects.toThrow("keeps its data inside");
	});
});

describe("contained commands", () => {
	test("run without the engine's keys and tokens in their environment", async () => {
		const { withoutSecrets } = await import("../packages/engine/src/util.ts");
		const env = withoutSecrets({ PATH: "/usr/bin", HOME: "/h", OPENAI_API_KEY: "k", GITHUB_TOKEN: "t", AWS_PROFILE: "p", DATABASE_URL: "postgres://", SSH_AUTH_SOCK: "/s", GIT_AUTHOR_NAME: "Pat", LANG: "C", MY_SECRET: "x", HF_TOKEN: "h" });
		expect(env).toEqual({ PATH: "/usr/bin", HOME: "/h", GIT_AUTHOR_NAME: "Pat", LANG: "C" });
	});

	test("printenv in a contained shell doesn't show a token the engine has", async () => {
		// Seatbelt and bubblewrap: Windows contains writes only, and its shell has no printenv.
		const ws = new LocalWorkspace(scratch("env"), "workspace");
		if (!ws.sandboxed || process.platform === "win32") return;
		process.env.ENRICHED_TEST_TOKEN = "never-shown";
		try {
			const result = await ws.exec("printenv", { timeoutMs: 10_000, signal: new AbortController().signal });
			expect(result.output).not.toContain("never-shown");
			expect(result.output).toContain("PATH=");
		} finally {
			delete process.env.ENRICHED_TEST_TOKEN;
		}
	});
});

describe("files written into a lab's sandbox", () => {
	test("a small file goes in a few short commands; one the lab refuses as a command goes by upload", async () => {
		const commands: string[] = [];
		const uploads: string[] = [];
		const refuseLong = (limit: number) =>
			({
				title: "Field Lab",
				run: async (command: string) => {
					if (command.length > limit) throw new Error("Sandboxes aren't available right now. Try again in a few minutes.");
					commands.push(command);
					return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
				},
				put: async (local: string) => {
					uploads.push(local);
					return { path: "/sandbox/in/x", bytes: 0 };
				},
			}) as unknown as SandboxApi;
		const page = "<p>dashboard</p>\n".repeat(1_700); // about 27 KB, like the page in the session that failed
		await new SandboxWorkspace(refuseLong(32_000), "/sandbox/work/p").write("app/index.html", page);
		expect(uploads).toEqual([]);
		expect(Math.max(...commands.map((c) => c.length))).toBeLessThan(17_000);
		commands.length = 0;
		await new SandboxWorkspace(refuseLong(8_000), "/sandbox/work/p").write("app/index.html", page);
		expect(uploads).toHaveLength(1);
		expect(commands.at(-1)).toContain("mv -fT -- '/sandbox/in/x' '/sandbox/work/p/app/index.html'");
	});
});
