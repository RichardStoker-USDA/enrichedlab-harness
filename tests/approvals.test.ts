// Approvals (packages/engine/src/permissions.ts): an "allow for this session" answer covers the programs a command
// runs, not its exact text, and outlasts a restart because it's in the log; "allow changes in this folder" is saved
// for every later session; auto mode asks once per folder, then file changes there run.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionDecision, PermissionRequest } from "../packages/protocol/src/index.ts";
import { DEFAULT_CONFIG, type LabConfig } from "../packages/engine/src/config.ts";
import type { ModelRegistry } from "../packages/engine/src/models/registry.ts";
import type { ModelProfile } from "../packages/engine/src/models/types.ts";
import { identity } from "../packages/engine/src/permissions.ts";
import { SessionLog } from "../packages/engine/src/session/log.ts";
import { reproduceStep, verifyPackage, writePackage } from "../packages/engine/src/session/package.ts";
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
		// Answers hold where they were given: after a move to another place they're asked again, and on reopening too.
		const other = join(dir, "p1-moved");
		mkdirSync(other);
		again.runtime.moveTo(new LocalWorkspace(other, "off"), { place: "local", label: "p1-moved", root: other });
		await turn(again.runtime, "shell: touch e.txt && rm e.txt");
		expect(again.asked).toHaveLength(2);
		const reopened = runtime(new SessionLog(join(dir, "logs"), log.id), other, () => ask, () => "deny");
		await turn(reopened.runtime, "shell: touch f.txt && rm f.txt");
		expect(reopened.asked).toHaveLength(1);
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
		config = { ...config, folders: { [realpathSync(root)]: { access: "change", at: new Date().toISOString(), id: identity(realpathSync(root)) } } };
		await turn(session.runtime, "write: more.txt");
		expect(session.asked).toHaveLength(1);
		// A session's own "ask" mode still asks there.
		session.runtime.setPermissionMode("ask");
		expect(session.runtime.summary().permissions).toBe("ask");
		await turn(session.runtime, "write: third.txt");
		expect(session.asked).toHaveLength(2);
	});

	test("every step is kept: going back to before a shell step brings back what it deleted, and the model is told", async () => {
		const root = join(dir, "p3");
		mkdirSync(root);
		const full = { ...DEFAULT_CONFIG, permissions: { ...DEFAULT_CONFIG.permissions, mode: "full" as const } };
		const { log } = SessionLog.create(join(dir, "logs"), root, model.ref, "You help.");
		const { runtime: session } = runtime(log, root, () => full, () => "allow");
		await turn(session, "write: notes.txt");
		await turn(session, "shell: rm notes.txt");
		expect(existsSync(join(root, "notes.txt"))).toBe(false);
		const step = session.events.findLast((e) => e.t === "tool" && e.name === "shell")!;
		// The timeline asks which files each step changed.
		expect(await session.stepFiles(step.id)).toMatchObject({ files: ["notes.txt"], with: 1, history: true });
		const back = await session.rewind(step.id);
		expect(back).toMatchObject({ ok: true, files: ["notes.txt"] });
		expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("x\n");
		const went = session.events.at(-1)!;
		expect(went).toMatchObject({ t: "rewind", before: step.id, restored: ["notes.txt"] });
		// Going back from the go-back returns to the present it kept.
		expect((await session.rewind(went.id)).ok).toBe(true);
		expect(existsSync(join(root, "notes.txt"))).toBe(false);
		// Each step that changed files left a point to go back to, and the history is outside the folder.
		expect(session.events.filter((e) => e.t === "checkpoint" && e.history).length).toBeGreaterThanOrEqual(3);
		expect(existsSync(join(root, ".git"))).toBe(false);
	});

	test("undo after a move touches nothing where the session was", async () => {
		const root = join(dir, "p4");
		const other = join(dir, "p4-moved");
		mkdirSync(root);
		mkdirSync(other);
		const full = { ...DEFAULT_CONFIG, permissions: { ...DEFAULT_CONFIG.permissions, mode: "full" as const } };
		const { log } = SessionLog.create(join(dir, "logs"), root, model.ref, "You help.");
		const { runtime: session } = runtime(log, root, () => full, () => "allow");
		await turn(session, "write: notes.txt");
		writeFileSync(join(root, "notes.txt"), "the person's later work\n");
		session.moveTo(new LocalWorkspace(other, "off"), { place: "local", label: "p4-moved", root: other });
		const undone = await session.undo();
		expect(undone.ok).toBe(false);
		expect(undone.detail).toContain("moved");
		expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("the person's later work\n");
	});

	test("undo never falls back to an earlier turn when this turn's history couldn't be kept", async () => {
		const root = join(dir, "p5");
		mkdirSync(root);
		const full = { ...DEFAULT_CONFIG, permissions: { ...DEFAULT_CONFIG.permissions, mode: "full" as const } };
		const { log } = SessionLog.create(join(dir, "logs"), root, model.ref, "You help.");
		const { runtime: session } = runtime(log, root, () => full, () => "allow");
		await turn(session, "write: first.txt");
		// The history store breaks before the second turn: its start isn't kept.
		(session as unknown as { historyOff: boolean }).historyOff = true;
		await turn(session, "write: second.txt");
		const undone = await session.undo();
		// The per-file copies of this turn put back only this turn's file.
		expect(undone.files).toEqual(["second.txt"]);
		expect(existsSync(join(root, "first.txt"))).toBe(true);
		expect(existsSync(join(root, "second.txt"))).toBe(false);
	});

	test("a run package carries the step history: it verifies, a command step reproduces, and a changed file is caught", async () => {
		const root = join(dir, "p6");
		mkdirSync(root);
		const full = { ...DEFAULT_CONFIG, permissions: { ...DEFAULT_CONFIG.permissions, mode: "full" as const } };
		const { log } = SessionLog.create(join(dir, "logs"), root, model.ref, "You help.");
		const { runtime: session } = runtime(log, root, () => full, () => "allow");
		await turn(session, "write: notes.txt");
		await turn(session, "shell: cp notes.txt copy.txt");
		const out = join(dir, "p6-package");
		const made = writePackage(out, { summary: session.summary(), events: session.events, log: [], attachments: {}, history: session.historyHandle(), version: "test" });
		expect(made.history).toBe(true);
		expect(verifyPackage(out).filter((row) => !row.ok)).toEqual([]);
		// The command step names what it read and what it changed, by content id.
		const graph = (JSON.parse(readFileSync(join(out, "ro-crate-metadata.json"), "utf8")) as { "@graph": Record<string, unknown>[] })["@graph"];
		const call = graph.find((e) => (e["@id"] as string).startsWith("#call-") && typeof e["https://enrichedlab.org/contract/2026-11/terms#command"] === "string")!;
		const named = (refs: unknown) => (refs as { "@id": string }[]).map((r) => graph.find((e) => e["@id"] === r["@id"])?.name);
		expect(named(call.object)).toEqual(["notes.txt"]);
		expect(named(call.result)).toEqual(["copy.txt"]);
		const again = await reproduceStep(out, call["@id"] as string);
		expect(again).toMatchObject({ same: ["copy.txt"], differ: [], extra: [], exitCode: 0 });
		// A file changed after packaging fails its checksum.
		writeFileSync(join(out, "files", "copy.txt"), "changed\n");
		expect(verifyPackage(out).find((row) => row.check === "files")?.ok).toBe(false);
	});
});
