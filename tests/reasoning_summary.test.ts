// Reading summaries of each step's reasoning: the full reasoning stays on the step, and the summary (like compaction)
// is made only by a model in the same place as the session's model, so lab reasoning never goes to a cloud service.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type LabConfig } from "../packages/engine/src/config.ts";
import type { ModelRegistry } from "../packages/engine/src/models/registry.ts";
import type { ModelProfile } from "../packages/engine/src/models/types.ts";
import { SessionLog } from "../packages/engine/src/session/log.ts";
import { pickHelper, type RuntimeDeps, SessionRuntime } from "../packages/engine/src/session/runtime.ts";
import { LocalWorkspace } from "../packages/engine/src/tools/workspace.ts";
import type { ModelWhere } from "../packages/protocol/src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "el-summary-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const THOUGHT = "I need to compare the two plots before writing anything. ".repeat(20);

/** A model server that answers a step with long reasoning and a summary request with one sentence. */
function server(name: string) {
	const asked: string[] = [];
	const chunk = (delta: Record<string, unknown>, finish?: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;
	const s = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const body = (await request.json()) as { messages: { role: string; content: string }[] };
			const system = body.messages[0]?.content ?? "";
			const kind = system.startsWith("You summarize") ? "summary" : system.startsWith("You name") ? "title" : "step";
			asked.push(kind);
			const parts = kind === "step" ? [chunk({ reasoning_content: THOUGHT }), chunk({ content: "Done." }), chunk({}, "stop")] : [chunk({ content: kind === "summary" ? `${name} summary.` : "Plots" }), chunk({}, "stop")];
			return new Response(parts.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
		},
	});
	afterAll(() => s.stop(true));
	return { asked, url: `http://127.0.0.1:${s.port}/v1` };
}

const profile = (ref: string, baseUrl: string, where: ModelWhere): ModelProfile => ({
	ref,
	provider: ref.split("/")[0]!,
	id: ref.split("/")[1]!,
	label: ref,
	source: where.kind === "lab" ? "site" : "config",
	api: "openai-chat",
	baseUrl,
	where,
	context: 32_768,
	maxOutput: 1024,
	vision: false,
	efforts: [],
	effortField: "none",
	replayReasoning: false,
	headers: async () => ({}),
});

function session(name: string, models: ModelProfile[], config: LabConfig): SessionRuntime {
	const registry = { resolve: (ref?: string) => models.find((m) => m.ref === ref), preferred: () => models[0], all: () => models } as unknown as ModelRegistry;
	const deps = {
		config: () => config,
		registry,
		tools: () => [],
		allows: () => true,
		spawn: () => "",
		waitAgents: async () => [],
		cancelChildren: () => undefined,
		canvas: { publish: () => undefined },
		notify: () => undefined,
		ask: async () => "allow",
	} as unknown as RuntimeDeps;
	const { log } = SessionLog.create(join(dir, name), dir, models[0]!.ref, "You help.");
	return new SessionRuntime(log, new LocalWorkspace(dir), deps);
}

async function summaryOf(runtime: SessionRuntime): Promise<{ of: string; text: string; model: string } | undefined> {
	runtime.prompt("Compare the plots.");
	for (let i = 0; i < 300; i++) {
		const found = runtime.events.find((e) => e.t === "reasoning_summary");
		if (found && found.t === "reasoning_summary") return found;
		await Bun.sleep(10);
	}
	return undefined;
}

describe("reasoning summaries", () => {
	test("a lab session's reasoning is summarized by the lab's model, not a cloud helper", async () => {
		const lab = server("lab");
		const cloud = server("cloud");
		const model = profile("field/reasoner", lab.url, { kind: "lab", name: "Field Lab" });
		const helper = profile("chatgpt/mini", cloud.url, { kind: "cloud", name: "ChatGPT" });
		const runtime = session("s1", [model, helper], { ...DEFAULT_CONFIG, summaryModel: helper.ref });
		const summary = await summaryOf(runtime);
		const step = runtime.events.find((e) => e.t === "assistant");
		expect(summary?.text).toBe("lab summary.");
		expect(summary?.of).toBe(step?.id);
		expect(summary?.model).toBe(model.ref);
		expect(step && step.t === "assistant" ? step.reasoning : "").toBe(THOUGHT);
		expect(cloud.asked).toEqual([]);
	});

	test("a smaller model at the same lab makes them when it's set", async () => {
		const lab = server("lab");
		const small = server("small");
		const model = profile("field/reasoner", lab.url, { kind: "lab", name: "Field Lab" });
		const helper = profile("field/small", small.url, { kind: "lab", name: "Field Lab" });
		const runtime = session("s2", [model, helper], { ...DEFAULT_CONFIG, summaryModel: helper.ref });
		expect((await summaryOf(runtime))?.text).toBe("small summary.");
		expect(lab.asked).not.toContain("summary");
	});

	test("are off when the person turns them off", async () => {
		const lab = server("lab");
		const model = profile("field/reasoner", lab.url, { kind: "lab", name: "Field Lab" });
		const runtime = session("s3", [model], { ...DEFAULT_CONFIG, reasoningSummaries: false });
		runtime.prompt("Compare the plots.");
		for (let i = 0; i < 100 && (runtime.isRunning || !runtime.events.some((e) => e.t === "assistant")); i++) await Bun.sleep(10);
		await Bun.sleep(50);
		expect(lab.asked).not.toContain("summary");
	});

	test("not chosen, summaries go to a fast model in the same place, never elsewhere, and on this computer to the session's own", () => {
		const lab: ModelWhere = { kind: "lab", name: "Field Lab" };
		const big = profile("lab/qwen3-235b", "https://lab.example.org/v1", lab);
		const small = profile("lab/qwen3-4b", "https://lab.example.org/v1", lab);
		const elsewhere = profile("cloud/gpt-mini", "https://api.example.com/v1", { kind: "cloud", name: "Example" });
		const embed = profile("lab/embed-small", "https://lab.example.org/v1", lab);
		const all = [big, elsewhere, embed, small];
		expect(pickHelper(big, undefined, all, () => true).ref).toBe("lab/qwen3-4b");
		expect(pickHelper(big, undefined, all, (m) => m !== small).ref).toBe("lab/qwen3-235b");
		// A chosen model in another place isn't used: the session's own writes them.
		expect(pickHelper(big, elsewhere, [], () => true).ref).toBe("lab/qwen3-235b");
		const here: ModelWhere = { kind: "device", name: "this computer" };
		expect(pickHelper(profile("local/qwen3-30b", "http://127.0.0.1:1234/v1", here), undefined, [profile("local/qwen3-4b", "http://127.0.0.1:1234/v1", here)], () => true).ref).toBe("local/qwen3-30b");
	});
});
