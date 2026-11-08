// Shell lines read the way the shell reads them: mvdan/sh's parser (compiled to WebAssembly, through sh-syntax)
// gives the syntax tree, and the words each command receives come from it once quotes and escapes are done. A word
// is literal only when its text alone decides it; anything that expands, substitutes or runs code isn't, and a line
// that holds such a word, a compound command or a here-document has no plain reading (docs/security.md, "Approvals").

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
	words: string[];
	redirects: Redirect[];
	background: boolean;
}

/** A command anywhere in a line, with each word's text when literal (undefined when it isn't). */
export interface AnyCommand {
	words: (string | undefined)[];
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

/** bash's $'..' escapes. */
function ansiC(text: string): string {
	const named: Record<string, string> = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
	const point = (n: number) => (n > 0x10ffff ? "�" : String.fromCodePoint(n));
	return text.replace(/\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|c[\s\S]|[\s\S])/g, (all, e: string) => {
		if (/^[xuU]/.test(e) && e.length > 1) return point(Number.parseInt(e.slice(1), 16));
		if (/^[0-7]/.test(e)) return String.fromCharCode(Number.parseInt(e, 8) & 0xff);
		if (e[0] === "c" && e.length === 2) return String.fromCharCode(e.charCodeAt(1) & 31);
		return named[e] ?? all;
	});
}

/**
 * A word's text as the program receives it, or undefined when more than the text decides it: a variable, a command,
 * process or arithmetic substitution, an extended glob, brace expansion, or (in zsh) a leading "=".
 */
export function literal(word: Node): string | undefined {
	let text = "";
	// The word with quoted characters masked, to see what the shell itself would expand.
	let shape = "";
	for (const part of word?.parts ?? []) {
		if (part.type === "Lit") {
			const value = String(part.value).replace(/\\([\s\S])/g, (_, c: string) => (c === "\n" ? "" : c));
			text += value;
			shape += String(part.value);
		} else if (part.type === "SglQuoted") {
			const value = part.dollar ? ansiC(String(part.value)) : String(part.value);
			text += value;
			shape += "q".repeat(value.length);
		} else if (part.type === "DblQuoted" && !part.dollar) {
			for (const inner of part.parts ?? []) {
				if (inner.type !== "Lit") return undefined;
				const value = String(inner.value).replace(/\\([$`"\\\n])/g, (_, c: string) => (c === "\n" ? "" : c));
				text += value;
				shape += "q".repeat(value.length);
			}
		} else return undefined;
	}
	if (/\{[^{}]*(,|\.\.)[^{}]*\}/.test(shape) || /^=\w/.test(shape)) return undefined;
	return text;
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
		for (const w of cmd?.args ?? []) {
			const text = literal(w);
			if (text === undefined) return false;
			words.push(text);
		}
		const assigns: Simple["assigns"] = [];
		for (const a of cmd?.assigns ?? []) {
			if (a.append || a.index || a.array || a.naked || !a.name) return false;
			const value = a.value ? literal(a.value) : "";
			if (value === undefined) return false;
			assigns.push({ name: String(a.name.value), value });
		}
		out.push({ assigns, words, redirects, background: Boolean(stmt.background) });
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
		if (node.type === "CallExpr") commands.push({ words: (node.args ?? []).map(literal) });
		if (node.type === "FuncDecl") functions = true;
		if (node.type === "Redirect" && node.hdoc) heredocs.push(rawText(node.hdoc));
		for (const value of Object.values(node)) if (value && typeof value === "object") visit(value);
	};
	visit(file.stmts);
	return { commands, heredocs, functions };
}

/** A word's source text as far as it is literal, for scanning (here-document bodies). */
function rawText(node: Node): string {
	if (Array.isArray(node)) return node.map(rawText).join("");
	if (!node || typeof node !== "object") return "";
	if (node.type === "Lit" || node.type === "SglQuoted") return String(node.value);
	return Object.values(node).map(rawText).join("");
}
