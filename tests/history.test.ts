// Step history (packages/engine/src/session/history.ts): a store of EnrichedLab's own per folder, so any step can be
// brought back, shell changes included, without touching the person's repository.

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checkpoints } from "../packages/engine/src/session/checkpoint.ts";
import { localHistory, MAX_FILE } from "../packages/engine/src/session/history.ts";
import { LocalWorkspace } from "../packages/engine/src/tools/workspace.ts";

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

	test("going back never deletes through a link, leaves files too large to keep, and keeps bytes exact", async () => {
		const folder = join(dir, "careful");
		const outside = join(dir, "outside");
		mkdirSync(join(folder, "link"), { recursive: true });
		mkdirSync(outside);
		writeFileSync(join(outside, "report.txt"), "not ours\n");
		writeFileSync(join(folder, ".gitattributes"), "*.txt text\n");
		writeFileSync(join(folder, "crlf.txt"), "a\r\nb\r\n");
		const history = localHistory(join(dir, "store"), folder, "s3");
		// The target: link is a link to a folder outside.
		rmSync(join(folder, "link"), { recursive: true });
		symlinkSync(outside, join(folder, "link"));
		const target = await history.snapshot("target");
		// The present: link is a real folder holding report.txt; crlf.txt edited; big.bin too large to keep.
		rmSync(join(folder, "link"));
		mkdirSync(join(folder, "link"));
		writeFileSync(join(folder, "link", "report.txt"), "ours\n");
		writeFileSync(join(folder, "crlf.txt"), "changed\r\n");
		writeFileSync(join(folder, "big.bin"), "");
		truncateSync(join(folder, "big.bin"), MAX_FILE + 1);
		const back = await history.restore(target.commit, "test");
		expect(readFileSync(join(outside, "report.txt"), "utf8")).toBe("not ours\n");
		expect(readFileSync(join(folder, "crlf.txt"), "utf8")).toBe("a\r\nb\r\n");
		expect(existsSync(join(folder, "big.bin"))).toBe(true);
		expect(back.removed).not.toContain("big.bin");
	});

	test("what a snapshot left out stays left out: through a file in its place, past 200 files, when it shrinks, and going back from going back", async () => {
		const folder = join(dir, "kept");
		mkdirSync(join(folder, "many"), { recursive: true });
		writeFileSync(join(folder, "data"), "a file named data\n");
		writeFileSync(join(folder, "grows.csv"), "small\n");
		const history = localHistory(join(dir, "store"), folder, "s4");
		const target = await history.snapshot("target");
		// Since: data became a folder holding a file too large to keep; 201 large files; a kept file grew too large.
		rmSync(join(folder, "data"));
		mkdirSync(join(folder, "data"));
		const big = (path: string) => (writeFileSync(path, ""), truncateSync(path, MAX_FILE + 1));
		big(join(folder, "data", "raw.bin"));
		for (let i = 0; i < 201; i++) big(join(folder, "many", `f${i}.bin`));
		big(join(folder, "grows.csv"));
		const grew = await history.snapshot("grew");
		expect(grew.changed).toBe(true);
		expect(await history.keptOut(grew.commit)).toHaveLength(203);
		// A nested repository made since isn't the history's to remove.
		mkdirSync(join(folder, "vendor"));
		execFileSync("git", ["init", "-q", join(folder, "vendor")]);
		writeFileSync(join(folder, "vendor", "lib.py"), "x = 1\n");
		execFileSync("git", ["-C", join(folder, "vendor"), "add", "."]);
		execFileSync("git", ["-C", join(folder, "vendor"), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x"]);
		const back = await history.restore(target.commit, "back");
		expect(readFileSync(join(folder, "data", "raw.bin")).length).toBe(MAX_FILE + 1);
		expect(existsSync(join(folder, "many", "f200.bin"))).toBe(true);
		expect(readFileSync(join(folder, "grows.csv")).length).toBe(MAX_FILE + 1);
		expect(existsSync(join(folder, "vendor", "lib.py"))).toBe(true);
		expect(back.left).toContain("data");
		// The 201st shrinks and grows.csv is small again. Going back from going back (to the present it kept) leaves them:
		// that present couldn't hold them, so it has nothing to put in their place.
		writeFileSync(join(folder, "many", "f200.bin"), "small now\n");
		writeFileSync(join(folder, "grows.csv"), "small again\n");
		const undo = await history.restore(back.saved, "undo going back");
		expect(undo.left).toEqual(expect.arrayContaining(["grows.csv", "many/f200.bin"]));
		expect(readFileSync(join(folder, "many", "f200.bin"), "utf8")).toBe("small now\n");
		expect(readFileSync(join(folder, "grows.csv"), "utf8")).toBe("small again\n");
	});

	test("a per-file copy comes back only while its path leads where it did", () => {
		const root = join(dir, "links");
		const a = join(dir, "outside-a");
		const b = join(dir, "outside-b");
		mkdirSync(root);
		mkdirSync(a);
		mkdirSync(b);
		symlinkSync(b, join(root, "link"));
		const copies = new Checkpoints(join(dir, "copies"));
		const kept = copies.capture([join(root, "link", "report.txt")]);
		// The link moves to a, where a file of that name was never kept; undo leaves it.
		rmSync(join(root, "link"));
		symlinkSync(a, join(root, "link"));
		writeFileSync(join(a, "report.txt"), "not ours\n");
		copies.restore([kept]);
		expect(readFileSync(join(a, "report.txt"), "utf8")).toBe("not ours\n");
	});

	test("a file comes back where only empty folders were left", async () => {
		const folder = join(dir, "emptied");
		mkdirSync(folder);
		writeFileSync(join(folder, "data"), "a file\n");
		const history = localHistory(join(dir, "store"), folder, "s5");
		const target = await history.snapshot("target");
		rmSync(join(folder, "data"));
		mkdirSync(join(folder, "data", "sub"), { recursive: true });
		writeFileSync(join(folder, "data", "sub", "new.txt"), "made since\n");
		const back = await history.restore(target.commit, "back");
		expect(readFileSync(join(folder, "data"), "utf8")).toBe("a file\n");
		expect(back.left).toEqual([]);
	});

	test("undo through a link to a file that didn't exist removes the file made there, not the link", () => {
		const root = join(dir, "dangling");
		const outside = join(dir, "dangling-outside");
		mkdirSync(root);
		mkdirSync(outside);
		symlinkSync(join(outside, "new.txt"), join(root, "link"));
		const copies = new Checkpoints(join(dir, "copies-2"));
		const kept = copies.capture([join(root, "link")]);
		writeFileSync(join(root, "link"), "written through the link\n");
		copies.restore([kept]);
		expect(existsSync(join(outside, "new.txt"))).toBe(false);
		expect(lstatSync(join(root, "link")).isSymbolicLink()).toBe(true);
	});

	test("undo keeps what it writes over, and writes land where the path leads", async () => {
		const root = join(dir, "kept-bytes");
		mkdirSync(root);
		const file = join(root, "notes.txt");
		writeFileSync(file, "before\n");
		const copies = new Checkpoints(join(dir, "copies-3"));
		const kept = copies.capture([file]);
		writeFileSync(file, "the person's later work\n");
		const back = copies.restore([kept]);
		expect(readFileSync(file, "utf8")).toBe("before\n");
		expect(back.kept).toHaveLength(1);
		copies.restore([back.kept]);
		expect(readFileSync(file, "utf8")).toBe("the person's later work\n");
		// A workspace write replaces the bytes in place.
		const ws = new LocalWorkspace(root);
		await ws.write("notes.txt", "short\n");
		expect(readFileSync(file, "utf8")).toBe("short\n");
	});

	test("undo leaves a file it couldn't keep first, and package names can't be options", async () => {
		const root = join(dir, "too-large");
		mkdirSync(root);
		const file = join(root, "data.bin");
		writeFileSync(file, "small\n");
		const copies = new Checkpoints(join(dir, "copies-4"));
		const kept = copies.capture([file]);
		truncateSync(file, MAX_FILE + 1);
		const back = copies.restore([kept]);
		expect(back.restored).toEqual([]);
		expect(readFileSync(file).length).toBe(MAX_FILE + 1);
		const { environmentTool } = await import("../packages/engine/src/tools/environment.ts");
		const ws = new LocalWorkspace(root);
		await expect(environmentTool.run({ action: "add", packages: ["python", "--tls-no-verify"] }, { workspace: ws, output: () => undefined } as never)).rejects.toThrow("isn't a package name");
		expect((await environmentTool.run({ action: "list" }, { workspace: ws, output: () => undefined, tools: join(dir, "no-tools") } as never)).content).toContain("no environment yet");
		expect(existsSync(join(dir, "no-tools"))).toBe(false);
	});
});
