// read, write, edit, ls, glob and grep, all through the workspace.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { unifiedDiff } from "./diff.ts";
import { num, str, type Tool, ToolError } from "./types.ts";
import type { Workspace } from "./workspace.ts";

const READ_MAX_LINES = 2_000;
const READ_MAX_CHARS = 80_000;
const LINE_MAX = 2_000;
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".pixi", "dist", "build", "target", ".next", ".cache"]);

const outsideReason = (path: string, ws: Workspace) => (ws.inside(path) ? undefined : `${ws.display(path)} is outside the project folder.`);

function looksBinary(buffer: Buffer): boolean {
	const sample = buffer.subarray(0, 8_000);
	for (const byte of sample) if (byte === 0) return true;
	return false;
}

export const readTool: Tool = {
	name: "read",
	kind: "read",
	description:
		"Read a text file with line numbers, or an image. Use offset and limit (1-based line numbers) for large files. Returns at most 2,000 lines per call.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "File path, relative to the project folder or absolute." },
			offset: { type: "integer", description: "First line to read (1-based)." },
			limit: { type: "integer", description: "Number of lines to read." },
		},
		required: ["path"],
		additionalProperties: false,
	},
	view: (a) => ({ verb: "read", target: String(a.path ?? "") }),
	ask: (a, { workspace }) => outsideReason(String(a.path ?? ""), workspace),
	async run(args, ctx) {
		const path = str(args, "path");
		const ws = ctx.workspace;
		const info = await ws.stat(path);
		if (!info) throw new ToolError(`${ws.display(path)} doesn't exist.`);
		if (info.type === "dir") throw new ToolError(`${ws.display(path)} is a folder. Use ls.`);
		const ext = path.split(".").pop()?.toLowerCase() ?? "";
		const data = await ws.read(path);
		if (IMAGE_TYPES[ext]) {
			if (!ctx.vision) return { ok: true, content: `${ws.display(path)} is an image (${data.length} bytes). This model can't see images.`, view: { result: "image" } };
			return {
				ok: true,
				content: `Image ${ws.display(path)} (${data.length} bytes).`,
				images: [{ type: "image", mime: IMAGE_TYPES[ext], data: data.toString("base64") }],
				view: { result: "image" },
			};
		}
		if (looksBinary(data)) return { ok: false, content: `${ws.display(path)} looks binary (${data.length} bytes). Use shell tools to inspect it.` };
		const lines = data.toString("utf8").split("\n");
		const offset = Math.max(1, Math.floor(num(args, "offset") ?? 1));
		const limit = Math.max(1, Math.min(READ_MAX_LINES, Math.floor(num(args, "limit") ?? READ_MAX_LINES)));
		const out: string[] = [];
		let chars = 0;
		let last = offset - 1;
		for (let i = offset - 1; i < Math.min(lines.length, offset - 1 + limit); i++) {
			let line = lines[i];
			if (line.length > LINE_MAX) line = `${line.slice(0, LINE_MAX)}… [line truncated]`;
			const row = `${String(i + 1).padStart(6)}\t${line}`;
			if (chars + row.length > READ_MAX_CHARS) break;
			out.push(row);
			chars += row.length + 1;
			last = i + 1;
		}
		const total = lines.length;
		const more = last < total ? `\n[Lines ${offset}-${last} of ${total}. Continue with offset ${last + 1}.]` : "";
		return { ok: true, content: (out.join("\n") || "(empty file)") + more, view: { result: last < total ? `${last - offset + 1} of ${total} lines` : `${total} lines` } };
	},
};

export const writeTool: Tool = {
	name: "write",
	kind: "write",
	description: "Create or replace a whole file. Prefer edit for changes to an existing file.",
	parameters: {
		type: "object",
		properties: { path: { type: "string" }, content: { type: "string", description: "The complete new file content." } },
		required: ["path", "content"],
		additionalProperties: false,
	},
	view: (a) => ({ verb: "write", target: String(a.path ?? ""), detail: typeof a.content === "string" ? a.content.slice(0, 4_000) : undefined }),
	touches: (a) => [String(a.path ?? "")],
	ask: (a, { workspace }) => outsideReason(String(a.path ?? ""), workspace),
	async run(args, ctx) {
		const path = str(args, "path");
		const content = str(args, "content");
		const ws = ctx.workspace;
		const before = (await ws.stat(path)) ? (await ws.read(path)).toString("utf8") : "";
		await ws.write(path, content, { outside: ctx.outside });
		const { diff, added, removed } = unifiedDiff(before, content, ws.display(path));
		const lines = content.split("\n").length;
		return { ok: true, content: `Wrote ${ws.display(path)} (${lines} lines).`, view: { result: before ? `+${added} -${removed}` : `${lines} lines, new`, diff } };
	},
};

export const editTool: Tool = {
	name: "edit",
	kind: "write",
	description:
		"Replace exact text in a file. Each edit's old text must match the file exactly once (including whitespace) unless all is true. Edits apply in order. Read the file first.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string" },
			edits: {
				type: "array",
				items: {
					type: "object",
					properties: { old: { type: "string" }, new: { type: "string" }, all: { type: "boolean", description: "Replace every match." } },
					required: ["old", "new"],
					additionalProperties: false,
				},
			},
		},
		required: ["path", "edits"],
		additionalProperties: false,
	},
	view: (a) => ({
		verb: "edit",
		target: String(a.path ?? ""),
		diff: Array.isArray(a.edits)
			? a.edits
					.slice(0, 6)
					.map((e: Record<string, unknown>) => [...String(e.old ?? "").split("\n").map((l) => `-${l}`), ...String(e.new ?? "").split("\n").map((l) => `+${l}`)].join("\n"))
					.join("\n")
			: undefined,
	}),
	touches: (a) => [String(a.path ?? "")],
	ask: (a, { workspace }) => outsideReason(String(a.path ?? ""), workspace),
	async run(args, ctx) {
		const path = str(args, "path");
		const ws = ctx.workspace;
		if (!(await ws.stat(path))) throw new ToolError(`${ws.display(path)} doesn't exist. Use write to create it.`);
		const edits = args.edits;
		if (!Array.isArray(edits) || !edits.length) throw new ToolError(`"edits" must be a non-empty list.`);
		const raw = (await ws.read(path)).toString("utf8");
		// Windows files use CRLF; models write LF. Match on LF and put the file's own line endings back.
		const crlf = raw.includes("\r\n") && !/(^|[^\r])\n/.test(raw);
		const before = crlf ? raw.replace(/\r\n/g, "\n") : raw;
		let text = before;
		edits.forEach((edit: Record<string, unknown>, n) => {
			const oldText = str(edit, "old").replace(/\r\n/g, "\n");
			const newText = str(edit, "new").replace(/\r\n/g, "\n");
			if (!oldText) throw new ToolError(`Edit ${n + 1}: old text is empty.`);
			const count = text.split(oldText).length - 1;
			if (count === 0) {
				const loose = text.replace(/[ \t]+/g, " ").includes(oldText.replace(/[ \t]+/g, " "));
				throw new ToolError(
					`Edit ${n + 1}: old text not found in ${ws.display(path)}.${loose ? " It matches if whitespace is ignored; copy the exact indentation." : " Read the file again; it may have changed."}`,
				);
			}
			if (count > 1 && edit.all !== true) throw new ToolError(`Edit ${n + 1}: old text matches ${count} places. Add surrounding lines to make it unique, or set all.`);
			text = edit.all === true ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
		});
		if (text === before) return { ok: true, content: "No change: the new text equals the old.", view: { result: "no change" } };
		await ws.write(path, crlf ? text.replace(/\n/g, "\r\n") : text, { outside: ctx.outside });
		const { diff, added, removed } = unifiedDiff(before, text, ws.display(path));
		return { ok: true, content: `Edited ${ws.display(path)}.\n${diff}`, view: { result: `+${added} -${removed}`, diff } };
	},
};

export const lsTool: Tool = {
	name: "ls",
	kind: "read",
	description: "List a folder: names, with a trailing slash for folders, and file sizes.",
	parameters: { type: "object", properties: { path: { type: "string", description: "Defaults to the project folder." } }, additionalProperties: false },
	view: (a) => ({ verb: "ls", target: String(a.path ?? ".") }),
	ask: (a, { workspace }) => outsideReason(String(a.path ?? "."), workspace),
	async run(args, ctx) {
		const path = str(args, "path", false) || ".";
		const entries = await ctx.workspace.list(path);
		const shown = entries.slice(0, 500).map((e) => (e.type === "dir" ? `${e.name}/` : e.type === "file" ? `${e.name}  ${e.size}` : `${e.name}  (${e.type})`));
		const more = entries.length > 500 ? `\n… ${entries.length - 500} more` : "";
		return { ok: true, content: (shown.join("\n") || "(empty)") + more, view: { result: `${entries.length} entries` } };
	},
};

/** Walk files under a folder, skipping build and dependency folders. */
async function* walk(ws: Workspace, dir: string, depth = 0): AsyncGenerator<string> {
	if (depth > 25) return;
	let entries;
	try {
		entries = await ws.list(dir);
	} catch {
		return;
	}
	for (const e of entries) {
		const path = dir === "." ? e.name : `${dir}/${e.name}`;
		if (e.type === "dir") {
			if (!SKIP_DIRS.has(e.name)) yield* walk(ws, path, depth + 1);
		} else if (e.type === "file") yield path;
	}
}

/** A glob to a regular expression: **, *, ?, {a,b} and character classes. */
export function globToRegex(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
				i += glob[i + 2] === "/" ? 2 : 1;
			} else re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else if (c === "{") {
			const end = glob.indexOf("}", i);
			if (end > i) {
				re += `(?:${glob.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`;
				i = end;
			} else re += "\\{";
		} else if (c === "[") {
			const end = glob.indexOf("]", i);
			if (end > i) {
				re += glob.slice(i, end + 1);
				i = end;
			} else re += "\\[";
		} else re += c.replace(/[.+^$()|\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`);
}

export const globTool: Tool = {
	name: "glob",
	kind: "read",
	description: "Find files by glob pattern, e.g. **/*.ts or src/**/test_*.py. Skips .git, node_modules and build folders.",
	parameters: {
		type: "object",
		properties: { pattern: { type: "string" }, path: { type: "string", description: "Folder to search, default the project folder." } },
		required: ["pattern"],
		additionalProperties: false,
	},
	view: (a) => ({ verb: "glob", target: String(a.pattern ?? "") }),
	ask: (a, { workspace }) => outsideReason(String(a.path ?? "."), workspace),
	async run(args, ctx) {
		const pattern = str(args, "pattern");
		const base = str(args, "path", false) || ".";
		if (ctx.workspace.glob) {
			const matched = await ctx.workspace.glob(pattern.replace(/^\.\//, ""), base);
			return { ok: true, content: matched.join("\n") || "No files matched.", view: { result: `${matched.length} files` } };
		}
		const re = globToRegex(pattern.replace(/^\.\//, ""));
		const found: string[] = [];
		for await (const file of walk(ctx.workspace, base)) {
			const rel = base === "." ? file : file.slice(base.length + 1);
			if (re.test(rel) || (!pattern.includes("/") && re.test(rel.split("/").pop()!))) found.push(file);
			if (found.length >= 1_000) break;
		}
		return { ok: true, content: found.join("\n") || "No files matched.", view: { result: `${found.length} files` } };
	},
};

function ripgrep(): string | undefined {
	const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
	const name = process.platform === "win32" ? "rg.exe" : "rg";
	for (const dir of dirs) if (dir && existsSync(join(dir, name))) return join(dir, name);
	return undefined;
}

export const grepTool: Tool = {
	name: "grep",
	kind: "read",
	description:
		"Search file contents with a regular expression. Returns path:line: text. Use glob to limit files (e.g. *.py). Uses ripgrep when installed.",
	parameters: {
		type: "object",
		properties: {
			pattern: { type: "string" },
			path: { type: "string", description: "File or folder, default the project folder." },
			glob: { type: "string", description: "Only files matching this glob." },
			ignoreCase: { type: "boolean" },
		},
		required: ["pattern"],
		additionalProperties: false,
	},
	view: (a) => ({ verb: "grep", target: `${a.pattern ?? ""}${a.glob ? `  ${a.glob}` : ""}` }),
	ask: (a, { workspace }) => outsideReason(String(a.path ?? "."), workspace),
	async run(args, ctx) {
		const pattern = str(args, "pattern");
		const base = str(args, "path", false) || ".";
		const glob = str(args, "glob", false);
		const ignoreCase = args.ignoreCase === true;
		const ws = ctx.workspace;
		const limit = 300;
		const rg = ws.kind === "local" ? ripgrep() : undefined;
		let lines: string[] = [];
		if (ws.grep) {
			lines = await ws.grep(pattern, base, { glob, ignoreCase, limit });
		} else if (rg) {
			const rgArgs = ["--line-number", "--no-heading", "--color=never", "--max-columns=400", "--max-count=50"];
			if (ignoreCase) rgArgs.push("-i");
			if (glob) rgArgs.push("--glob", glob);
			rgArgs.push("-e", pattern, ws.resolve(base));
			const text = await new Promise<string>((done) => {
				const child = spawn(rg, rgArgs, { cwd: ws.root, windowsHide: true });
				let out = "";
				child.stdout.on("data", (d: Buffer) => {
					if (out.length < 2_000_000) out += d.toString("utf8");
				});
				child.on("close", () => done(out));
				child.on("error", () => done(out));
				ctx.signal.addEventListener("abort", () => child.kill(), { once: true });
			});
			lines = text.split("\n").filter(Boolean).map((l) => (l.startsWith(ws.root) ? l.slice(ws.root.length + 1) : l));
		} else {
			let re: RegExp;
			try {
				re = new RegExp(pattern, ignoreCase ? "i" : "");
			} catch (error) {
				throw new ToolError(`Not a valid regular expression: ${(error as Error).message}`);
			}
			const fileRe = glob ? globToRegex(glob) : undefined;
			const info = await ws.stat(base);
			const files = info?.type === "file" ? [base] : walk(ws, base);
			for await (const file of files as AsyncIterable<string> | string[]) {
				if (fileRe && !fileRe.test(file.split("/").pop()!) && !fileRe.test(file)) continue;
				const data = await ws.read(file).catch(() => undefined);
				if (!data || looksBinary(data)) continue;
				data.toString("utf8").split("\n").forEach((line, i) => {
					if (lines.length < limit * 2 && re.test(line)) lines.push(`${file}:${i + 1}:${line.slice(0, 400)}`);
				});
				if (lines.length >= limit * 2) break;
			}
		}
		const shown = lines.slice(0, limit);
		const more = lines.length > limit ? `\n… more matches; narrow the pattern or path.` : "";
		return { ok: true, content: shown.join("\n") + more || "No matches.", view: { result: `${Math.min(lines.length, limit)}${lines.length > limit ? "+" : ""} matches` } };
	},
};
