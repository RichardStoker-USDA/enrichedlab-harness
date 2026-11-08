// Step history (packages/engine/src/session/history.ts): a store of EnrichedLab's own per folder, so any step can be
// brought back, shell changes included, without touching the person's repository.

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localHistory, MAX_FILE } from "../packages/engine/src/session/history.ts";

const dir = mkdtempSync(join(tmpdir(), "el-history-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("step history", () => {
	test("brings back a step: edits, new and deleted files, and data the repository ignores; leaves the rest", async () => {
		const folder = join(dir, "project");
		mkdirSync(join(folder, "data"), { recursive: true });
		mkdirSync(join(folder, "node_modules", "x"), { recursive: true });
		execFileSync("git", ["init", "-q", folder]);
		writeFileSync(join(folder, ".gitignore"), "data/\n");
		writeFileSync(join(folder, "analysis.R"), "x <- 1\n");
		writeFileSync(join(folder, "data", "raw.csv"), "plot,moisture\n1,0.3\n");
		writeFileSync(join(folder, "notes.md"), "keep me\n");
		const history = localHistory(join(dir, "store"), folder, "s1");
		const before = await history.snapshot("start of turn");
		expect(before.changed).toBe(true);

		// What a shell command might do: edit, create, delete, write a huge file, rebuild node_modules.
		writeFileSync(join(folder, "analysis.R"), "x <- 2\n");
		writeFileSync(join(folder, "new.txt"), "made by the agent\n");
		rmSync(join(folder, "data", "raw.csv"));
		rmSync(join(folder, "notes.md"));
		writeFileSync(join(folder, "huge.bin"), "");
		truncateSync(join(folder, "huge.bin"), MAX_FILE + 1);
		writeFileSync(join(folder, "node_modules", "x", "index.js"), "module.exports = 1\n");
		const after = await history.snapshot("after shell");
		expect(after.changed).toBe(true);
		expect(after.skipped).toEqual(["huge.bin"]);
		expect((await history.changes(before.commit, after.commit)).sort()).toEqual(["analysis.R", "data/raw.csv", "new.txt", "notes.md"]);

		const back = await history.restore(before.commit, "before the shell step");
		expect(back.restored.sort()).toEqual(["analysis.R", "data/raw.csv", "notes.md"]);
		expect(back.removed).toEqual(["new.txt"]);
		expect(readFileSync(join(folder, "analysis.R"), "utf8")).toBe("x <- 1\n");
		expect(readFileSync(join(folder, "data", "raw.csv"), "utf8")).toBe("plot,moisture\n1,0.3\n");
		expect(existsSync(join(folder, "new.txt"))).toBe(false);
		// Never kept, so left as they are.
		expect(existsSync(join(folder, "huge.bin"))).toBe(true);
		expect(existsSync(join(folder, "node_modules", "x", "index.js"))).toBe(true);

		// Going back is a step too: the present before it comes back the same way.
		await history.restore(back.saved, "undo going back");
		expect(readFileSync(join(folder, "analysis.R"), "utf8")).toBe("x <- 2\n");
		expect(existsSync(join(folder, "new.txt"))).toBe(true);
		expect(existsSync(join(folder, "notes.md"))).toBe(false);

		// The person's own repository is untouched: no commits, no refs, nothing staged.
		expect(execFileSync("git", ["-C", folder, "for-each-ref"], { encoding: "utf8" })).toBe("");
		expect(execFileSync("git", ["-C", folder, "status", "--porcelain"], { encoding: "utf8" })).not.toContain("A ");
	});

	test("a snapshot with nothing new is the last one, and sessions in one folder keep their own lines", async () => {
		const folder = join(dir, "shared");
		mkdirSync(folder);
		writeFileSync(join(folder, "a.txt"), "1\n");
		const one = localHistory(join(dir, "store"), folder, "s1");
		const two = localHistory(join(dir, "store"), folder, "s2");
		const first = await one.snapshot("one");
		expect((await one.snapshot("again")).changed).toBe(false);
		expect((await one.snapshot("again")).commit).toBe(first.commit);
		writeFileSync(join(folder, "a.txt"), "2\n");
		const [a, b] = await Promise.all([one.snapshot("one, later"), two.snapshot("two")]);
		expect(a.changed && b.changed).toBe(true);
		expect(await one.head()).toBe(a.commit);
		expect(await two.head()).toBe(b.commit);
	});
});
