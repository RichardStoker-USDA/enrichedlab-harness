// POSIX shell lines are read with mvdan/sh's parser (compiled to WebAssembly, through sh-syntax), which gives the
// syntax tree and the words each command receives once quotes and escapes are done. A word is literal only when its
// text alone decides it; anything that expands, substitutes or runs code isn't. The publishing gate uses the
// constrained PowerShell reader below on Windows (docs/security.md, "Approvals").

import { readFileSync } from "node:fs";
// Go's WebAssembly runtime (it defines globalThis.Go). sh-syntax's sideEffects list leaves it out, so a bundle drops a
// bare import; it is used below so a compiled build keeps it.
import * as goRuntime from "sh-syntax/vendors/wasm_exec.cjs";
import { getProcessorSync } from "sh-syntax";
import wasm from "sh-syntax/main.wasm" with { type: "file" };

/** A redirection, its operator as written ("<", ">", ">>", ">&", "&>", ...) and its literal target. */
export interface Redirect {
	op: string;
	fd?: string;
	target: string;
}

/** One simple command: what it sets in front, the words it runs, and where its streams go. */
export interface Simple {
	assigns: { name: string; value: string }[];
	/** Each word's text; a glob word's text is its pattern as written, quotes taken out. */
	words: string[];
	/** For each word, its glob pattern when it is one (the shell replaces it with the names it matches). */
	patterns: (string | undefined)[];
	redirects: Redirect[];
	background: boolean;
}

/** A command anywhere in a line, with each word's text when literal (undefined when it isn't). */
export interface AnyCommand {
	words: (string | undefined)[];
	/** For each word, its glob pattern when it is one. */
	patterns: (string | undefined)[];
	/** The names of the variables set in front of it. */
	assigns: string[];
}

const REDIRECTS: Record<number, string> = { 63: ">", 64: ">>", 65: "<", 66: "<>", 67: "<&", 68: ">&", 69: ">|", 70: ">>|", 71: "<<", 72: "<<-", 73: "<<<", 74: "&>", 75: "&>|", 76: "&>>", 77: "&>>|" };
const HEREDOCS = new Set([71, 72, 73]);
const SEQUENCES = new Set([11, 12, 13, 14]);

// deno-lint-ignore no-explicit-any
type Node = any;

let processor: ((text: string) => Node) | undefined;
const cache = new Map<string, Node | null>();

/**
 * The syntax tree, or undefined when the line doesn't parse as bash (or the parser can't start: then every line is
 * unreadable, so commands ask). Remembered for recent lines. Each parse runs in a fresh WebAssembly instance, freed
 * once the event loop turns, so a long session's memory stays flat.
 */
export function parseShell(line: string): Node | undefined {
	if (cache.has(line)) return cache.get(line) ?? undefined;
	let file: Node | null;
	try {
		if (!("Go" in globalThis)) throw new Error(`Go's WebAssembly runtime didn't load (${Object.keys(goRuntime).length} exports).`);
		processor ??= getProcessorSync(readFileSync(wasm)) as (text: string) => Node;
		file = processor(line);
	} catch {
		file = null;
	}
	if (cache.size >= 256) cache.delete(cache.keys().next().value!);
	cache.set(line, file);
	return file ?? undefined;
}

/** bash's $'..' escapes. A NUL ends the quoted text there, as bash cuts it. */
function ansiC(text: string): string {
	const named: Record<string, string> = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
	const point = (n: number) => (n > 0x10ffff ? "�" : String.fromCodePoint(n));
	const decoded = text.replace(/\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|c[\s\S]|[\s\S])/g, (all, e: string) => {
		if (/^[xuU]/.test(e) && e.length > 1) return point(Number.parseInt(e.slice(1), 16));
		if (/^[0-7]/.test(e)) return String.fromCharCode(Number.parseInt(e, 8) & 0xff);
		if (e[0] === "c" && e.length === 2) return String.fromCharCode(e.charCodeAt(1) & 31);
		return named[e] ?? all;
	});
	const nul = decoded.indexOf("\0");
	return nul < 0 ? decoded : decoded.slice(0, nul);
}

const GLOB = new Set(["*", "?", "["]);
const SPECIAL = new Set(["*", "?", "[", "]", "\\", "{", "}", "!"]);

/** A word as the shell reads it: its text, and when unquoted glob characters make it a pattern, the pattern. */
export interface Word {
	text: string;
	/** A glob pattern with the word's quoted characters escaped (\*): the shell expands it to matching names. */
	pattern?: string;
}

/**
 * A word as the program receives it, or undefined when more than its text and the names it matches decide it: a
 * variable, a command, process or arithmetic substitution, an extended glob, brace expansion, a "~user" home, or
 * (in zsh) a leading "=". `assignment`: the value of NAME=value, where a ~ after = or : expands too.
 */
export function wordOf(word: Node, assignment = false): Word | undefined {
	// Each character with whether the shell treats it as quoted.
	const chars: { c: string; quoted: boolean }[] = [];
	for (const part of word?.parts ?? []) {
		if (part.type === "Lit") {
			const raw = String(part.value);
			for (let i = 0; i < raw.length; i++) {
				if (raw[i] === "\\" && i + 1 < raw.length) {
					i++;
					if (raw[i] !== "\n") chars.push({ c: raw[i]!, quoted: true });
				} else chars.push({ c: raw[i]!, quoted: false });
			}
		} else if (part.type === "SglQuoted") {
			for (const c of part.dollar ? ansiC(String(part.value)) : String(part.value)) chars.push({ c, quoted: true });
		} else if (part.type === "DblQuoted" && !part.dollar) {
			for (const inner of part.parts ?? []) {
				if (inner.type !== "Lit") return undefined;
				for (const c of String(inner.value).replace(/\\([$`"\\\n])/g, (_, x: string) => (x === "\n" ? "" : x))) chars.push({ c, quoted: true });
			}
		} else return undefined;
	}
	const text = chars.map((x) => x.c).join("");
	const shape = chars.map((x) => (x.quoted ? "q" : x.c)).join("");
	if (/\{[^{}]*(,|\.\.)[^{}]*\}/.test(shape) || /^=\w/.test(shape)) return undefined;
	// "~" alone or "~/..." is the home folder (resolved where paths are judged); "~user", "~+" and "~-" aren't text.
	if (shape.startsWith("~") && !/^~(\/|$)/.test(shape)) return undefined;
	if (assignment && /(^|:)~/.test(shape)) return undefined;
	const glob = chars.some((x, i) => !x.quoted && GLOB.has(x.c) && (x.c !== "[" || chars.slice(i + 1).some((y) => !y.quoted && y.c === "]")));
	if (!glob) return { text };
	const pattern = chars.map((x) => (x.quoted && SPECIAL.has(x.c) ? `\\${x.c}` : x.c)).join("");
	return { text, pattern };
}

/** A word's text when it is plain text: no expansion, and no glob pattern either. */
export function literal(word: Node): string | undefined {
	const w = wordOf(word);
	return w && !w.pattern ? w.text : undefined;
}

/**
 * The simple commands of a line, in order, when every part of it is plain: literal words and assignments, literal
 * redirection targets, joined by ; && || | or newlines. Undefined for anything else (compound commands, functions,
 * substitutions, here-documents and here-strings, arrays) and for a line that doesn't parse.
 */
export function plainCommands(line: string): Simple[] | undefined {
	const file = parseShell(line);
	if (!file) return undefined;
	const out: Simple[] = [];
	const statement = (stmt: Node): boolean => {
		if (stmt.coprocess || stmt.disown) return false;
		const redirects: Redirect[] = [];
		for (const r of stmt.redirs ?? []) {
			if (HEREDOCS.has(r.op) || !REDIRECTS[r.op]) return false;
			const target = literal(r.word);
			if (target === undefined) return false;
			redirects.push({ op: REDIRECTS[r.op]!, ...(r.n ? { fd: String(r.n.value) } : {}), target });
		}
		const cmd = stmt.cmd;
		if (cmd?.type === "BinaryCmd" && SEQUENCES.has(cmd.op)) return !redirects.length && !stmt.background && statement(cmd.x) && statement(cmd.y);
		if (cmd && cmd.type !== "CallExpr") return false;
		const words: string[] = [];
		const patterns: (string | undefined)[] = [];
		for (const w of cmd?.args ?? []) {
			const read = wordOf(w);
			if (read === undefined) return false;
			words.push(read.text);
			patterns.push(read.pattern);
		}
		const assigns: Simple["assigns"] = [];
		for (const a of cmd?.assigns ?? []) {
			if (a.append || a.index || a.array || a.naked || !a.name) return false;
			const read = a.value ? wordOf(a.value, true) : { text: "" };
			const value = read && !read.pattern ? read.text : undefined;
			if (value === undefined) return false;
			assigns.push({ name: String(a.name.value), value });
		}
		out.push({ assigns, words, patterns, redirects, background: Boolean(stmt.background) });
		return true;
	};
	for (const stmt of file.stmts ?? []) if (!statement(stmt)) return undefined;
	return out;
}

/**
 * Every command anywhere in a line (inside groups, conditions, loops, functions and substitutions too), and the text
 * of its here-documents; undefined when the line doesn't parse.
 */
export function everyCommand(line: string): { commands: AnyCommand[]; heredocs: string[]; functions: boolean } | undefined {
	const file = parseShell(line);
	if (!file) return undefined;
	const commands: AnyCommand[] = [];
	const heredocs: string[] = [];
	let functions = false;
	const visit = (node: Node): void => {
		if (Array.isArray(node)) return node.forEach(visit);
		if (!node || typeof node !== "object") return;
		if (node.type === "CallExpr") {
			const read = (node.args ?? []).map((w: Node) => wordOf(w));
			commands.push({ words: read.map((w: Word | undefined) => w?.text), patterns: read.map((w: Word | undefined) => w?.pattern), assigns: (node.assigns ?? []).map((a: Node) => String(a.name?.value ?? "")) });
		}
		if (node.type === "FuncDecl") functions = true;
		// export, declare, local, readonly: the variables they set count like ones set in front of a command.
		if (node.type === "DeclClause") commands.push({ words: [], patterns: [], assigns: (node.args ?? []).map((a: Node) => String(a.name?.value ?? "")) });
		if (node.type === "Redirect" && node.hdoc) heredocs.push(rawText(node.hdoc));
		for (const value of Object.values(node)) if (value && typeof value === "object") visit(value);
	};
	visit(file.stmts);
	return { commands, heredocs, functions };
}

/**
 * Literal native-command words from PowerShell. Backslashes are ordinary characters there, unlike in bash. This
 * intentionally accepts only the part of PowerShell whose executed argv is fixed by the line. Variables,
 * expressions, splatting, script blocks and the stop-parsing token return undefined so publishing fails closed.
 */
export function everyPowerShellCommand(line: string): { commands: AnyCommand[]; heredocs: string[]; functions: boolean } | undefined {
	const commands: AnyCommand[] = [];
	let words: string[] = [];
	let patterns: (string | undefined)[] = [];
	let word = "";
	let active = false;
	let patterned = false;
	let quote: "single" | "double" | undefined;
	const add = (character: string, quoted: boolean) => {
		word += character;
		active = true;
		if (!quoted && GLOB.has(character)) patterned = true;
	};
	const finishWord = () => {
		if (!active) return;
		words.push(word);
		patterns.push(patterned ? word : undefined);
		word = "";
		active = false;
		patterned = false;
	};
	const finishCommand = () => {
		finishWord();
		if (!words.length) return;
		if (words.includes("--%")) throw new Error("PowerShell's stop-parsing token hides the command arguments.");
		commands.push({ words, patterns, assigns: [] });
		words = [];
		patterns = [];
	};
	try {
		for (let i = 0; i < line.length; i++) {
			const character = line[i]!;
			if (character === "\0") return undefined;
			if (quote === "single") {
				if (character === "'" && line[i + 1] === "'") {
					add("'", true);
					i++;
				} else if (character === "'") quote = undefined;
				else add(character, true);
				continue;
			}
			if (quote === "double") {
				if (character === "`") {
					if (i + 1 >= line.length) return undefined;
					if (line[i + 1] === "\r" && line[i + 2] === "\n") i += 2;
					else if (line[i + 1] === "\n") i++;
					else add(line[++i]!, true);
				} else if (character === '"') quote = undefined;
				else if (character === "$") return undefined;
				else add(character, true);
				continue;
			}
			if (character === "`") {
				if (i + 1 >= line.length) return undefined;
				if (line[i + 1] === "\r" && line[i + 2] === "\n") i += 2;
				else if (line[i + 1] === "\n") i++;
				else add(line[++i]!, true);
			} else if (character === "'") {
				active = true;
				quote = "single";
			} else if (character === '"') {
				active = true;
				quote = "double";
			} else if (character === "#") {
				finishCommand();
				while (i + 1 < line.length && line[i + 1] !== "\n") i++;
			} else if (/\s/.test(character)) {
				finishWord();
				if (character === "\n") finishCommand();
			} else if (character === ";" || character === "|") {
				finishCommand();
				if (line[i + 1] === character) i++;
			} else if (character === "&") {
				// At the start of a command this is PowerShell's call operator. Else it separates/backgrounds commands.
				if (active || words.length) finishCommand();
				if (line[i + 1] === "&") i++;
			} else if ("$@{}()".includes(character)) return undefined;
			else add(character, false);
		}
		if (quote) return undefined;
		finishCommand();
	} catch {
		return undefined;
	}
	return { commands, heredocs: [], functions: false };
}

/** A word's source text as far as it is literal, for scanning (here-document bodies). */
function rawText(node: Node): string {
	if (Array.isArray(node)) return node.map(rawText).join("");
	if (!node || typeof node !== "object") return "";
	if (node.type === "Lit" || node.type === "SglQuoted") return String(node.value);
	return Object.values(node).map(rawText).join("");
}
