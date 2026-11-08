// Approvals (packages/engine/src/permissions.ts): an "allow for this session" answer covers the programs a command
// runs, not its exact text, and outlasts a restart because it's in the log; "allow changes in this folder" is saved
// for every later session; auto mode asks once per folder, then file changes there run.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionDecision, PermissionRequest } from "../packages/protocol/src/index.ts";
import { DEFAULT_CONFIG, type LabConfig } from "../packages/engine/src/config.ts";
import type { ModelRegistry } from "../packages/engine/src/models/registry.ts";
import type { ModelProfile } from "../packages/engine/src/models/types.ts";
import { SessionLog } from "../packages/engine/src/session/log.ts";
import { type RuntimeDeps, SessionRuntime } from "../packages/engine/src/session/runtime.ts";
import { writeTool } from "../packages/engine/src/tools/files.ts";
import { shellTool } from "../packages/engine/src/tools/shell.ts";
import { LocalWorkspace } from "../packages/engine/src/tools/workspace.ts";

const dir = mkdtempSync(join(tmpdir(), "el-approvals-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A model that runs the tool call the person's message names ("shell: <command>" or "write: <path>"), then says Done. */
const model = (() => {
	const chunk = (delta: Record<string, unknown>, finish?: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;
	const s = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const body = (await request.json()) as { messages: { role: string; content: unknown }[]; tools?: unknown[] };
			const last = body.messages.at(-1)!;
			const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
			let parts: string[];
			if (!body.tools?.length || last.role !== "user") parts = [chunk({ content: "Done." }), chunk({}, "stop")];
			else {
				const [, name, value] = /(shell|write): ([^"\\]+)/.exec(text) ?? [];
				const args = name === "shell" ? { command: value } : { path: value, content: "x\n" };
				parts = [chunk({ tool_calls: [{ index: 0, id: `c${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }), chunk({}, "tool_calls")];
			}
			return new Response(`${parts.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
		},
	});
	afterAll(() => s.stop(true));
	const profile: ModelProfile = {
		ref: "local/scripted",
		provider: "local",
		id: "scripted",
		label: "scripted",
		source: "config",
		api: "openai-chat",
		baseUrl: `http://127.0.0.1:${s.port}/v1`,
		context: 32_768,
		maxOutput: 1024,
		vision: false,
		efforts: [],
		effortField: "none",
		replayReasoning: false,
		headers: async () => ({}),
	};
	return profile;
})();

function runtime(log: SessionLog, root: string, config: () => LabConfig, answer: (r: PermissionRequest) => PermissionDecision, granted: string[] = []): { runtime: SessionRuntime; asked: PermissionRequest[] } {
	const asked: PermissionRequest[] = [];
	const registry = { resolve: () => model, preferred: () => model, all: () => [model] } as unknown as ModelRegistry;
	const deps = {
		config,
		registry,
		tools: () => [shellTool, writeTool],
		allows: () => true,
		spawn: () => "",
		waitAgents: async () => [],
		cancelChildren: () => undefined,
		canvas: { publish: () => undefined },
		notify: () => undefined,
		ask: async (request: PermissionRequest) => (asked.push(request), answer(request)),
		grantFolder: (folder: string) => granted.push(folder),
	} as unknown as RuntimeDeps;
	// Commands run uncontained here, so each one that changes things would ask.
	return { runtime: new SessionRuntime(log, new LocalWorkspace(root, "off"), deps), asked };
}

async function turn(session: SessionRuntime, text: string): Promise<void> {
	session.prompt(text);
	await Bun.sleep(20);
	for (let i = 0; i < 500 && session.isRunning; i++) await Bun.sleep(10);
}

describe("approvals", () => {
	test("an answer for the session covers the programs, outlasts a restart, and the question names its scope", async () => {
		const root = join(dir, "p1");
		mkdirSync(root);
		const ask = { ...DEFAULT_CONFIG, permissions: { ...DEFAULT_CONFIG.permissions, mode: "ask" as const } };
		const { log } = SessionLog.create(join(dir, "logs"), root, model.ref, "You help.");
		const first = runtime(log, root, () => ask, () => "allow_session");
		await turn(first.runtime, "shell: touch a.txt && rm a.txt");
		expect(first.asked.map((r) => r.scope)).toEqual(["“touch” and “rm” commands"]);
		// Another command with the same programs runs without asking.
		await turn(first.runtime, "shell: touch b.txt && rm b.txt");
		expect(first.asked).toHaveLength(1);
		// Reopened from its log (an engine restart): still remembered.
		const again = runtime(new SessionLog(join(dir, "logs"), log.id), root, () => ask, () => "deny");
		await turn(again.runtime, "shell: touch c.txt && rm c.txt");
		expect(again.asked).toHaveLength(0);
		// A program not covered asks.
		await turn(again.runtime, "shell: mkdir d && rmdir d");
		expect(again.asked.map((r) => r.scope)).toEqual(["“mkdir” and “rmdir” commands"]);
	});

	test("auto mode asks once per folder; allowing the folder saves it, and file changes there then run", async () => {
		const root = join(dir, "p2");
		mkdirSync(root);
		let config: LabConfig = { ...DEFAULT_CONFIG };
		const granted: string[] = [];
		const { log } = SessionLog.create(join(dir, "logs"), root, model.ref, "You help.");
		const session = runtime(log, root, () => config, () => "allow_folder", granted);
		await turn(session.runtime, "write: notes.txt");
		expect(session.asked).toHaveLength(1);
		expect(session.asked[0]!.folder).toBe(root);
		expect(granted).toEqual([root]);
		// The engine saves the grant to config (folder.access); then the next change runs without asking.
		config = { ...config, folders: { [root]: { access: "change", at: new Date().toISOString() } } };
		await turn(session.runtime, "write: more.txt");
		expect(session.asked).toHaveLength(1);
		// A session's own "ask" mode still asks there.
		session.runtime.setPermissionMode("ask");
		expect(session.runtime.summary().permissions).toBe("ask");
		await turn(session.runtime, "write: third.txt");
		expect(session.asked).toHaveLength(2);
	});
});
