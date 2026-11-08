// A session as a run package (el session package): an RO-Crate 1.3 folder in the Process Run Crate profile, with the
// shared log, the files the session changed and their checksums, and every model step and tool call as an action.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePackage } from "../packages/engine/src/session/package.ts";
import type { SessionEvent, SessionSummary } from "../packages/protocol/src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "el-package-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const at = (s: number) => new Date(Date.UTC(2026, 10, 6, 20, 0, s)).toISOString();
const events: SessionEvent[] = [
	{ t: "header", v: 1, id: "h", at: at(0), cwd: dir, created: at(0) },
	{ t: "user", id: "u1", at: at(1), text: "Summarize the plots." },
	{ t: "assistant", id: "a1", at: at(5), model: "field/reasoner", text: "", reasoning: "long thinking", toolCalls: [{ id: "c1", name: "write", args: "{}" }], stop: "tool_use" },
	{ t: "reasoning_summary", id: "s1", at: at(6), of: "a1", text: "It planned to write the summary table.", model: "field/reasoner" },
	{ t: "checkpoint", id: "k1", at: at(6), callId: "c1", files: [{ path: "summary.csv", existed: false }, { path: "../outside.txt", existed: false }] },
	{ t: "tool", id: "r1", at: at(7), callId: "c1", name: "write", ok: true, content: "wrote", view: { verb: "write", target: "summary.csv" }, decision: "auto" },
	{ t: "assistant", id: "a2", at: at(9), model: "field/reasoner", text: "Done.", stop: "end" },
];
const summary = (place?: string): SessionSummary => ({ id: "s0abc", cwd: dir, title: "Plot summary", created: at(0), updated: at(9), model: "field/reasoner", turns: 1, running: false, place });

describe("a run package", () => {
	test("holds the log, the changed files with checksums, and every step as an action", () => {
		writeFileSync(join(dir, "summary.csv"), "plot,moisture\nP1,0.31\n");
		const out = join(dir, "pkg");
		const made = writePackage(out, { summary: summary(), events, log: [{ v: 1, seq: 1, kind: "user", data: { text: "Summarize the plots." } }], attachments: {}, version: "test" });
		expect(made).toEqual({ files: 1, actions: 3, history: false });
		const crate = JSON.parse(readFileSync(join(out, "ro-crate-metadata.json"), "utf8")) as { "@context": string; "@graph": Record<string, unknown>[] };
		expect(crate["@context"]).toBe("https://w3id.org/ro/crate/1.3/context");
		const byId = new Map(crate["@graph"].map((e) => [e["@id"] as string, e]));
		expect(byId.get("ro-crate-metadata.json")?.conformsTo).toEqual({ "@id": "https://w3id.org/ro/crate/1.3" });
		expect(byId.get("./")?.conformsTo).toEqual([{ "@id": "https://w3id.org/ro/wfrun/process/0.6" }]);
		// The file as it is now, inside the session's folder only; a path outside it is left out.
		const copied = byId.get("files/summary.csv");
		expect(copied?.sha256).toBe(createHash("sha256").update("plot,moisture\nP1,0.31\n").digest("hex"));
		expect(readFileSync(join(out, "files", "summary.csv"), "utf8")).toBe("plot,moisture\nP1,0.31\n");
		expect([...byId.keys()].some((id) => id.includes("outside"))).toBe(false);
		// The model step carries its reading summary; the tool call its tool, times and outcome.
		expect(byId.get("#step-a1")).toMatchObject({ "@type": "CreateAction", instrument: { "@id": "#model-field/reasoner" }, startTime: at(1), endTime: at(5), description: "It planned to write the summary table." });
		expect(byId.get("#call-c1")).toMatchObject({ name: "write summary.csv", instrument: { "@id": "#tool-write" }, startTime: at(5), endTime: at(7), actionStatus: "CompletedActionStatus" });
		expect(byId.get("session.jsonl")?.encodingFormat).toBe("application/jsonl");
	});

	test("a lab session's files stay in the lab; the package holds its log and steps", () => {
		const out = join(dir, "pkg-lab");
		mkdirSync(out);
		const made = writePackage(out, { summary: summary("field"), events, log: [], attachments: {}, version: "test" });
		expect(made.files).toBe(0);
		expect(existsSync(join(out, "files"))).toBe(false);
		const crate = JSON.parse(readFileSync(join(out, "ro-crate-metadata.json"), "utf8")) as { "@graph": { "@id": string; description?: string }[] };
		expect(crate["@graph"].find((e) => e["@id"] === "./")?.description).toContain("worked in the field sandbox");
	});
});
