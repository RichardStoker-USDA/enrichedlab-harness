// Which tool calls run, which ask, and how an answer is remembered for the rest of a session. This guards against a
// model steered by text it read; the OS containment (Seatbelt, bubblewrap, a lab's sandbox) is what holds commands in.
//
// Three modes (docs/security.md, "How much it asks"):
// - ask:  asks before file changes and commands that can change things.
// - auto: asks only for what the session's history can't take back: commands that run outside the containment,
//         requests to a new host, changes outside the folder, signed-in browser actions, publishing. File changes in a
//         folder the person let EnrichedLab change, and contained commands, run; every step is kept in history.
// - full: never asks, except pushing to a remote and lab tools the lab hasn't reviewed.
// "Allow for this session" is remembered per program (python, git commit), per host, per tool, and kept in the log.

import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { FolderAccess, LabConfig, PermissionMode } from "./config.ts";
import { isReadOnlyCommand, pathsInside } from "./tools/shell.ts";
import type { Tool } from "./tools/types.ts";
import { isOpenPort } from "./sites/port_proxy.ts";
import { FULL_CONTAINMENT, physical } from "./tools/workspace.ts";
import type { Workspace } from "./tools/workspace.ts";

export type Verdict =
	/** `fence`: it runs because of the paths it names, in a lab's sandbox, so the sandbox checks where they lead first. */
	| { action: "run"; fence?: boolean }
	| {
			action: "ask";
			reason: string;
			/** What an "allow for this session" answer remembers; every key must be allowed for the call to run. */
			keys: string[];
			/** What those keys cover, in words for the button: "python and grep commands", "requests to example.org". */
			scope: string;
			/** Set when the call changes files in a folder the person hasn't let EnrichedLab change: the folder to offer. */
			folder?: string;
	  };

/** "edits", the old name for auto, reads as auto. */
export function modeOf(mode: string | undefined): PermissionMode {
	return mode === "full" ? "full" : mode === "ask" ? "ask" : "auto";
}

/**
 * A path as the disk knows it: symlinks followed and letters in the disk's own case (so /tmp and /private/tmp, or
 * /Project and /project on a case-insensitive disk, are one folder). A path that doesn't exist yet takes its nearest
 * existing parent's.
 */
export function canonical(path: string, depth = 0): string {
	let at = physical(isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`);
	const rest: string[] = [];
	for (;;) {
		try {
			return join(realpathSync.native(at), ...rest.reverse());
		} catch {
			// A link to somewhere that doesn't exist yet: a write through it lands where it points.
			try {
				if (depth < 40 && lstatSync(at).isSymbolicLink()) return join(canonical(resolve(dirname(at), readlinkSync(at)), depth + 1), ...rest.reverse());
			} catch {
				// Not there at all: its parent decides.
			}
			const up = dirname(at);
			if (up === at) return resolve(path);
			rest.push(basename(at));
			at = up;
		}
	}
}

/** True when `path` is `folder` or inside it ("/" holds everything). */
function within(path: string, folder: string): boolean {
	return path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

/** What the person let EnrichedLab do at `path`: the nearest folder they answered for decides. */
/** A folder's identity on disk (device and inode), so a grant can tell its folder from another one put in its place. */
export function identity(path: string): string | undefined {
	const s = statSync(path, { bigint: true, throwIfNoEntry: false });
	return s ? `${s.dev}:${s.ino}` : undefined;
}

/**
 * The folders a grant covers now. A grant to change is saved by its real path and identity when answered; it holds only
 * while that path still leads to that folder, so a part of it replaced by a link (to "/", say) or another folder moved
 * into its place drops it. A read-only grant only ever asks more, so it covers both its path and where that leads.
 */
function grantFolders(saved: string, grant: { access: FolderAccess; id?: string }): string[] {
	const now = canonical(saved);
	if (grant.access === "read") return now === saved ? [saved] : [saved, now];
	// A grant saved before identities (0.2.30) asks once more and is saved again with one.
	if (now !== saved || !grant.id || identity(saved) !== grant.id) return [];
	return [saved];
}

export function folderAccess(config: LabConfig, path: string): FolderAccess | undefined {
	const target = canonical(path);
	let best: { folder: string; access: FolderAccess } | undefined;
	for (const [saved, grant] of Object.entries(config.folders ?? {})) {
		for (const folder of grantFolders(saved, grant)) {
			if (!within(target, folder)) continue;
			// The closest folder answers; at the same folder, read only wins.
			if (!best || folder.length > best.folder.length || (folder.length === best.folder.length && grant.access === "read")) best = { folder, access: grant.access };
		}
	}
	return best?.access;
}

/** A folder inside `root` (or `root` itself) set to read only: contained commands there can't be told apart, so they ask. */
function readOnlyWithin(config: LabConfig, root: string): boolean {
	const base = canonical(root);
	return Object.entries(config.folders ?? {}).some(([saved, grant]) => grant.access === "read" && grantFolders(saved, grant).some((folder) => within(folder, base) || within(base, folder)));
}

/** Tools whose first argument names the action: keyed by both words, so "git status" doesn't allow "git push". */
const SUBCOMMANDS = new Set([
	"git", "npm", "pnpm", "yarn", "npx", "bunx", "cargo", "go", "pixi", "uv", "pip", "pip3", "docker", "podman", "kubectl", "helm",
	"make", "just", "brew", "gh", "terraform", "dotnet", "swift", "mvn", "gradle",
]);

/** Tools that change files in the project. Other writes (browser actions, apps, memory, PDF forms) are each their own. */
const FILE_EDITS = new Set(["write", "edit"]);

/** Shell words that only move around or say something: no answer of their own (nothing they print is redirected). */
const QUIET = new Set(["cd", "pushd", "popd", "pwd", "true", "false", "echo", "printf", "test", "[", ":"]);
/**
 * Words that start shell syntax (control flow, grouping, functions) or run what follows them (another program, an
 * admin, another computer, AppleScript): a command holding one is remembered exactly.
 */
const EXACT = new Set([
	"if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "function", "select", "coproc",
	"{", "}", "!", "[[", "]]", "time", "exec", "eval", "source", ".", "alias", "sudo", "doas", "su", "ssh", "osascript", "xargs",
	"env", "watch", "timeout", "nohup", "nice", "command", "builtin", "open", "start", "cmd", "Invoke-Expression", "iex",
	"export", "declare", "typeset", "local", "readonly", "set", "unset", "hash", "enable", "trap", "shopt", "setopt", "emulate",
]);

/**
 * Variables that change which program runs or what code it loads, set in front of a command: the command is then
 * remembered exactly. Judged broadly: a toolchain's own prefix (PHP*, PYTHON*, GIT_*, LD_*), or any part of the name
 * that says path, folder, library, config, startup or command (PATH, DIR, LIB, INI, RC, CONFIG, OPTS, PRELOAD, CMD).
 * Data variables (SEED=42, OMP_NUM_THREADS=8, LOG_LEVEL=debug) share the program's answer.
 */
const LOADER_NAMES = /^(IFS|PS4|PROMPT_COMMAND|ENV|SHELLOPTS|BASHOPTS|CC|CXX|CPP|LD|AR|AS|FC|NM|RANLIB|STRIP|MAKE|TMPDIR|SHELL|EDITOR|VISUAL|PAGER|BROWSER|HOME|TERMINFO)$/;
const LOADER_PREFIXES = /^(PHP|PYTHON|PERL|RUBY|GEM|BUNDLE|NODE|NPM|YARN|PNPM|BUN|DENO|JAVA|_JAVA|JDK|MAVEN|GRADLE|JULIA|LUA|TCL|GUILE|ERL|ELIXIR|CONDA|MAMBA|PIXI|PIP|CARGO|RUSTUP|RUSTC|DOTNET|COMPOSER|DYLD|ZDOT)|^(LD|GIT|BASH|ZSH|KSH|R|RSTUDIO|MIX|UV|GO|SSH|GPG|XDG|KUBE|DOCKER|MAKE|CMAKE)_/;
const LOADER_PARTS = new Set(["PATH", "DIR", "HOME", "ROOT", "LIB", "LIBS", "LIBRARY", "LIBRARIES", "INI", "RC", "CONF", "CONFIG", "CFG", "OPT", "OPTS", "OPTIONS", "FLAGS", "PRELOAD", "INSERT", "PROFILE", "ENV", "ENVIRON", "STARTUP", "HOOK", "HOOKS", "PLUGIN", "PLUGINS", "MODULE", "MODULES", "INCLUDE", "LOAD", "INIT", "SITE", "EXEC", "CMD", "COMMAND", "SHELL", "PREFIX", "USERBASE", "PROGRAM", "BIN", "TOOL", "TOOLCHAIN", "SCAN", "PAGER", "EDITOR"]);
function loads(name: string): boolean {
	const upper = name.toUpperCase();
	return LOADER_NAMES.test(upper) || LOADER_PREFIXES.test(upper) || upper.split("_").some((part) => LOADER_PARTS.has(part)) || /(PATH|RC|DIR|HOME|LIBS?|OPTS?|INI)$/.test(upper);
}

/**
 * The simple commands of a shell line, as their words, quote-aware. Undefined when the line holds anything whose effect
 * the words don't show: substitutions, process substitution, here-documents, subshells or groups, unbalanced quotes,
 * or output written to a file (descriptor copies like 2>&1 and writes to /dev/null are fine).
 */
function simpleCommands(line: string): string[][] | undefined {
	const commands: string[][] = [];
	let words: string[] = [];
	let word = "";
	let quoted = false;
	let quote: "'" | '"' | undefined;
	const endWord = () => {
		if (word || quoted) words.push(word);
		word = "";
		quoted = false;
	};
	const endCommand = () => {
		endWord();
		if (words.length) commands.push(words);
		words = [];
	};
	for (let i = 0; i < line.length; i++) {
		const c = line[i]!;
		if (quote) {
			if (c === quote) quote = undefined;
			else if (quote === '"' && (c === "$" || c === "`")) return undefined;
			else if (quote === '"' && c === "\\") word += line[++i] ?? "";
			else word += c;
			continue;
		}
		if (c === "#" && !word && !quoted) return undefined;
		if (c === "'" || c === '"') {
			quote = c;
			quoted = true;
		} else if (c === "\\") {
			const next = line[++i];
			if (next === "\n") continue;
			word += next ?? "";
		} else if (c === "`" || c === "(" || c === ")" || (c === "$" && line[i + 1] === "(")) return undefined;
		else if (c === " " || c === "\t") endWord();
		else if (c === ";" || c === "\n") endCommand();
		else if (c === "|" || (c === "&" && line[i + 1] === "&")) {
			endCommand();
			if (line[i + 1] === c || line[i + 1] === "&") i++;
		} else if (c === ">" || c === "<" || (c === "&" && line[i + 1] === ">")) {
			// A redirection: an optional descriptor number before it, the operator, then its target.
			const fd = /^\d+$/.test(word) ? word : "";
			if (fd) word = "";
			else endWord();
			let op = c;
			while (">&|<".includes(line[i + 1] ?? "x") && op.length < 3) op += line[++i];
			if (op.startsWith("<<") || line[i + 1] === "(") return undefined;
			let target = "";
			while (line[i + 1] === " ") i++;
			while (i + 1 < line.length && !" \t;|&<>()\n".includes(line[i + 1]!)) target += line[++i];
			// A target that expands or quotes runs or hides something before the file opens.
			if (/[`$'"\\#]/.test(target)) return undefined;
			const copy = /&$/.test(op) && /^(\d+|-)$/.test(target);
			const writes = op.includes(">") && !copy && target !== "/dev/null";
			if (writes || (!copy && !target)) return undefined;
		} else if (c === "&") endCommand();
		else word += c;
	}
	if (quote) return undefined;
	endCommand();
	return commands;
}

/** The programs a shell line runs, keyed as an answer remembers them; undefined when it must be remembered exactly. */
function commandKeys(command: string): { keys: string[]; names: string[] } | undefined {
	const commands = simpleCommands(command);
	if (!commands) return undefined;
	const keys = new Set<string>();
	const names = new Set<string>();
	for (const all of commands) {
		const words = [...all];
		for (; words.length && /^[A-Za-z_]\w*=/.test(words[0]!); words.shift()) if (loads(words[0]!.slice(0, words[0]!.indexOf("=")))) return undefined;
		const first = words[0];
		if (!first) continue;
		// A program named by a variable, a pattern or a relative path depends on more than the words: exact. A full path
		// is the same program as its name for these rules (/usr/bin/env, /usr/bin/git).
		const name = first.replace(/^.*\//, "");
		if (EXACT.has(name) || /[$*?[\]{}~]/.test(first) || (first.includes("/") && !first.startsWith("/"))) return undefined;
		if (QUIET.has(first)) continue;
		if (SUBCOMMANDS.has(name) && words[1]) {
			// Options before the action (git -C dir reset), or an action that expands, would hide which action it is.
			if (!/^[A-Za-z0-9][\w.:-]*$/.test(words[1])) return undefined;
			keys.add(`shell:${first} ${words[1]}`);
			names.add(`${first} ${words[1]}`);
		} else {
			keys.add(`shell:${first}`);
			names.add(first);
		}
	}
	return keys.size ? { keys: [...keys], names: [...names] } : undefined;
}

/**
 * A line that may push: git ... push with quotes, escapes, $'..' quoting and continuations taken out, or a line where
 * git or a push could hide behind expansion or indirection ($, backquotes, eval, alias, source, functions), which
 * is treated as a push.
 */
export function pushes(command: string): boolean {
	const plain = command.replace(/\\\r?\n/g, "").replace(/\$(?=['"])/g, "").replace(/['"\\]/g, "");
	if (/(^|[;&|\n(`]\s*|\/)git(\s+\S+)*\s+push\b/.test(plain)) return true;
	// Single quotes hold text literally ($'..' aside, whose $ stays outside them), so a $ inside them hides nothing.
	const unquoted = command.replace(/'[^']*'/g, "''");
	const hidden = /[$`]|\b(eval|alias|source|function)\b|^\s*\.\s|[;&|]\s*\.\s|\(\s*\)/.test(unquoted);
	return hidden && /\bgit\b|\bpush\b/.test(plain);
}

/** "a", "a and b", "a, b and c". */
function list(items: string[]): string {
	return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** What an "allow for this session" answer remembers for this call, and what that covers in words. */
export function allowKeys(tool: Tool, args: Record<string, unknown>): { keys: string[]; scope: string } {
	if (tool.kind === "sandbox" && typeof args.command === "string") {
		// Remembered per program like a shell command, apart from this computer's answers.
		const found = commandKeys(args.command.trim());
		if (!found) return { keys: [`sandbox=${args.command.trim()}`], scope: "this exact command in the lab's sandbox" };
		return { keys: found.keys.map((key) => key.replace(/^shell:/, "sandbox:")), scope: `${list(found.names.map((n) => `“${n}”`))} commands in the lab's sandbox` };
	}
	if (tool.kind === "exec") {
		const command = String(args.command ?? "").trim();
		// Pushing publishes work: it asks every time, whatever was allowed before. Judged on the words with quotes and
		// escapes taken out, so git 'push' and g\it push are pushes too.
		if (pushes(command)) return { keys: ["shell!push"], scope: "pushing" };
		const found = commandKeys(command);
		if (!found) return { keys: [`shell=${command}`], scope: "this exact command" };
		return { keys: found.keys, scope: `${list(found.names.map((n) => `“${n}”`))} commands` };
	}
	if (tool.kind === "write") return FILE_EDITS.has(tool.name) ? { keys: ["write"], scope: "file changes" } : { keys: [`write:${tool.name}`], scope: SCOPES[tool.name] ?? tool.name };
	if (tool.kind === "net") {
		const name = tool.host?.(args) ?? host(args);
		return { keys: [`net:${name}`], scope: `requests to ${name}` };
	}
	return { keys: [`tool:${tool.name}`], scope: SCOPES[tool.name] ?? tool.name };
}

/** The one key for a call, for callers that keep a single key (kept for the web window's older answers). */
export function allowKey(tool: Tool, args: Record<string, unknown>): string {
	return allowKeys(tool, args).keys.join(" ");
}

/** What a session answer covers for writes that aren't file edits. */
const SCOPES: Record<string, string> = {
	browser_click: "clicks in the browser",
	browser_type: "typing in the browser",
	app_create: "new apps",
	environment: "package installs in this project's environment",
	remember: "notes to memory",
	skill_create: "new skills",
	pdf_fill: "filling PDF forms",
};

function host(args: Record<string, unknown>): string {
	try {
		return new URL(String(args.url ?? "")).host.toLowerCase();
	} catch {
		return "?";
	}
}

/** An IPv4 address in loopback, private, carrier NAT (Tailscale's range too), link-local and metadata, or "this network". */
function localV4(a: number, b: number): boolean {
	return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** An IPv6 address as eight 16-bit groups, or undefined when it isn't one. Takes a dotted IPv4 tail too. */
function v6Groups(text: string): number[] | undefined {
	if (!text.includes(":") || !/^[0-9a-f:.]+$/i.test(text)) return undefined;
	let address = text;
	const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
	if (dotted) {
		const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
		address = `${address.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const halves = address.split("::");
	if (halves.length > 2) return undefined;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
	if (fill < 0 || (halves.length === 1 && head.length !== 8)) return undefined;
	const groups = [...head, ...Array<string>(fill).fill("0"), ...tail].map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? Number.parseInt(g, 16) : Number.NaN));
	return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : undefined;
}

/**
 * Loopback, private, carrier NAT, link-local and cloud metadata addresses get a sharper question, in IPv6 too: ULA,
 * link-local, and the mapped, NAT64 and 6to4 forms that carry an IPv4 address.
 */
/** This computer: localhost, 127/8, ::1. */
export function loopbackHost(name: string): boolean {
	const h = (name.startsWith("[") ? name.slice(1, name.indexOf("]")) : name.replace(/:\d+$/, "")).toLowerCase().replace(/\.$/, "");
	return h === "localhost" || h.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(h) || h === "::1";
}

export function localHost(name: string): boolean {
	const h = (name.startsWith("[") ? name.slice(1, name.indexOf("]")) : name.replace(/:\d+$/, "")).toLowerCase().replace(/\.$/, "");
	if (/^(localhost|.+\.(localhost|local|internal|lan|home\.arpa))$/.test(h)) return true;
	const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
	if (v4) return localV4(Number(v4[1]), Number(v4[2]));
	const g = v6Groups(h);
	if (!g) return false;
	const embedded = (hi: number) => localV4(hi >> 8, hi & 0xff);
	if (g.slice(0, 7).every((x) => x === 0)) return g[7]! <= 1; // :: and ::1
	if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embedded(g[6]!); // ::ffff:a.b.c.d
	if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6]!); // NAT64
	if (g[0] === 0x2002) return embedded(g[1]!); // 6to4
	return (g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xffc0) === 0xfe80; // ULA, link-local
}

/** The question a push asks; headless runs refuse it unless the person passed --push. */
export const PUSH_REASON = "It pushes to a remote.";

/** Built-in tools that, in a lab's sandbox, act only there: reading, file edits and commands. */
const IN_SANDBOX = new Set(["read", "sandbox", "exec"]);

/**
 * `discovery`: the lab where Discovery mode applies to this session now (docs/research.md). `mode`: the session's
 * own mode, when the person set one for it; otherwise the configured one.
 */
export function decide(tool: Tool, args: Record<string, unknown>, workspace: Workspace, config: LabConfig, allowed: Set<string>, discovery?: string, sessionMode?: PermissionMode, recoverable = true): Verdict {
	const chosen = modeOf(sessionMode ?? config.permissions.mode);
	// auto rests on history: without it (the store failed), it asks as ask does.
	const mode = chosen === "auto" && !recoverable ? "ask" : chosen;
	const extra = tool.ask?.(args, { workspace });
	const { keys, scope } = allowKeys(tool, args);
	const ask = (reason: string, folder?: string): Verdict => ({ action: "ask", reason, keys, scope, ...(folder ? { folder } : {}) });
	// Pushing publishes work, and an unreviewed lab tool hasn't been checked by anyone: both ask in every mode, every time.
	if (keys[0] === "shell!push") return ask(PUSH_REASON);
	if (tool.unreviewed) return { action: "ask", reason: "The lab hasn't reviewed this tool yet, so it asks every time.", keys: [`unreviewed!${tool.name}`], scope: "this call" };
	if (mode === "full") return { action: "run" };
	// Discovery mode: what acts inside the lab the session works at runs without asking (the lab's filters, checks and
	// audit stay on there). Anything on this computer still asks.
	if (discovery && (tool.site === discovery || (!tool.site && workspace.kind === "sandbox" && (IN_SANDBOX.has(tool.kind) || keys[0] === "write")))) return { action: "run" };
	// An answer about something outside the project is remembered for that path only; "!" keys never are.
	const outside = `${keys.join(" ")}:outside:${String(args.path ?? args.url ?? "")}`;
	const remembered = (list: string[]) => list.every((key) => !key.includes("!") && allowed.has(key));
	if (extra ? allowed.has(outside) : remembered(keys)) return { action: "run" };
	const askOutside = (reason: string): Verdict => ({ action: "ask", reason, keys: [outside], scope: "this path" });
	const local = workspace.kind === "local";
	const access = local ? folderAccess(config, workspace.root) : undefined;
	// What a write lands on decides, not the session's folder: a read-only folder inside it stays read only.
	const named = tool.touches?.(args) ?? (typeof args.path === "string" ? [args.path] : []);
	const targets = local && tool.kind === "write" ? named.filter(Boolean).map((path) => workspace.resolve(path)) : [];
	const targetAccess = targets.length ? (targets.some((path) => folderAccess(config, path) !== "change") ? (targets.some((path) => folderAccess(config, path) === "read") ? "read" : undefined) : "change") : access;
	switch (tool.kind) {
		case "net": {
			// The engine's own ports show the person's sandbox apps; nothing goes anywhere the person didn't send it.
			if (typeof args.url === "string" && isOpenPort(args.url)) return { action: "run" };
			if (extra) return askOutside(extra);
			const name = tool.host?.(args) ?? host(args);
			return ask(localHost(name) ? `It reaches ${name}, an address on this computer or your network.` : `It sends a request to ${name}.`);
		}
		case "sandbox": {
			const command = typeof args.command === "string" ? args.command : undefined;
			if (!command) return extra ? askOutside(extra) : { action: "run" };
			// A lab tool that runs a command in the person's sandbox, outside any session's project folder (where other
			// sessions' projects live): read-only commands run; in auto, a sandbox whose whole disk is checkpointed runs
			// anything; the rest asks, remembered per program.
			if (isReadOnlyCommand(command, config.permissions.allowCommands, () => true)) return { action: "run" };
			if (mode === "auto" && workspace.kind === "sandbox" && workspace.checkpointed === "filesystem") return { action: "run" };
			return ask("It runs a command in the lab's sandbox, outside this session's project folder, where other sessions' work can be.");
		}
		case "read":
		case "local":
		case "site-read":
			return extra ? askOutside(extra) : { action: "run" };
		case "write": {
			if (extra) return askOutside(extra);
			const edit = keys[0] === "write";
			// File edits in a session's own worktree go to its own branch, and work in a lab's sandbox comes home as a
			// branch: the person reviews them when they merge.
			if (edit && (ownWorktree(workspace) || workspace.sandboxed === "site")) return { action: "run" };
			if (mode === "auto" && edit) {
				// Kept in history, so it can be taken back: runs where the person let EnrichedLab change the folder.
				if (!local || targetAccess === "change") return { action: "run" };
				if (targetAccess === "read") return ask("It changes a file in a folder you set to read only.");
				return ask(`It changes a file in “${basename(workspace.root)}”, a folder you haven't let EnrichedLab change yet.`, access === undefined ? workspace.root : undefined);
			}
			// Other writes (a click in the browser, a note to memory, a filled PDF) ask in every mode until allowed.
			return ask(edit ? "It changes a file." : `It ${WRITES[tool.name] ?? (tool.name.endsWith("_sandbox_download") ? "copies a file from the sandbox into the project" : "changes something")}.`, edit && local && access === undefined ? workspace.root : undefined);
		}
		case "exec": {
			const command = String(args.command ?? "");
			// In its own worktree the agent commits to its own branch; the person merges it.
			if (ownBranchCommit(command, workspace)) return { action: "run" };
			// Contained by the OS: writes stay in the project and temp folders, no network. Runs without asking unless it
			// names a path outside the project or expands variables (the sandbox can still read most of the disk).
			// Windows contains writes only, so there it still asks. A folder set to read only asks for everything.
			// In a lab's sandbox the paths a command names are the only fence, so a command whose paths can't be read
			// from its words (a script handed to an interpreter, arguments read from input) asks unless the whole
			// sandbox can be taken back.
			const lab = workspace.kind === "sandbox";
			const contained = workspace.sandboxed && FULL_CONTAINMENT.has(workspace.sandboxed) && args.unsandboxed !== true && !(lab && !plainLine(command));
			// Without history (its store failed) a contained change can't be taken back either: it asks.
			if (contained && recoverable && !(local && readOnlyWithin(config, workspace.root)) && pathsInside(command, (path) => workspace.inside(path), workspace.kind === "sandbox" || process.platform !== "win32", lab)) return lab ? { action: "run", fence: true } : { action: "run" };
			if (isReadOnlyCommand(command, config.permissions.allowCommands, (path) => workspace.inside(path))) return { action: "run" };
			// In a lab's sandbox whose whole disk is checkpointed, any command can be taken back.
			if (mode === "auto" && workspace.kind === "sandbox" && workspace.checkpointed === "filesystem" && args.unsandboxed !== true) return { action: "run" };
			const reads = isReadOnlyCommand(command, config.permissions.allowCommands, () => true);
			if (reads) return ask("It reads outside the project folder.");
			return ask(contained || workspace.kind === "sandbox" ? "It runs a command that changes things outside the project folder." : "It runs a command on this computer outside the sandbox, where it can change anything you can.");
		}
		case "site-write":
			return ask("The lab doesn't mark this tool read-only.");
		case "packages":
			// Listing reads; the rest downloads packages whose install scripts run here (contained, into the project only).
			if (args.action === "list") return { action: "run" };
			return ask("It installs packages into this project's own environment. Their install scripts run on this computer, contained to the project.");
	}
}

/** What a write that isn't a file edit does, for its question. */
const WRITES: Record<string, string> = {
	browser_click: "clicks in the browser, where you may be signed in",
	browser_type: "types into a page in the browser, where you may be signed in",
	app_create: "makes an app in the project",
	remember: "saves a note to memory that later sessions read",
	skill_create: "saves a skill that later sessions use",
	pdf_fill: "fills in a PDF form",
};

/** True when the session works in a worktree EnrichedLab made for it. */
/**
 * A command whose paths aren't in its words: code handed to an interpreter (sh -c, python -c, node -e, Rscript -e),
 * an awk program, or arguments read from input (xargs, parallel).
 */
export function scripted(command: string): boolean {
	const start = String.raw`(^|[;&|(\s])(\S*/)?`;
	const interpreters = "sh|bash|zsh|dash|ksh|mksh|fish|python[\\d.]*|node|deno|bun|perl|ruby|php|lua|Rscript|R|julia|pwsh|powershell|tclsh|osascript";
	const code = new RegExp(String.raw`${start}(${interpreters})\s+(\S+\s+)*(-[a-zA-Z]*[ceE]|--command|--eval|--expr|-r)(\s|=|$)`);
	// Judged with quotes and escapes taken out: '-c' and "python3" are what the shell passes on.
	const plain = command.replace(/['"\\]/g, "");
	return code.test(plain) || new RegExp(String.raw`${start}(awk|gawk|mawk|nawk|xargs|parallel)(\s|$)`).test(plain);
}

/** Shells: handed a script, a startup file or -c, they run what their words don't show. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "csh", "tcsh", "busybox", "rbash"]);

/**
 * A line whose words are all there is to it, for a lab's sandbox, where the paths a command names are the fence: no
 * expansion of any kind ($, backquotes, even quoted), no here-documents or here-strings, no variables set in front,
 * no shell, eval, source or other program that runs what follows, and no code handed to an interpreter.
 */
export function plainLine(command: string): boolean {
	if (/[$`]|<</.test(command) || scripted(command)) return false;
	for (const segment of command.split(/&&|\|\||[;|&\n]/)) {
		const words = segment.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/['"\\]/g, ""));
		if (!words.length) continue;
		if (/^[A-Za-z_]\w*=/.test(words[0]!)) return false;
		const name = words[0]!.replace(/^.*\//, "");
		if (EXACT.has(name) || SHELLS.has(name)) return false;
	}
	return true;
}

function ownWorktree(workspace: Workspace): boolean {
	return /[/\\]\.git[/\\]enrichedlab-worktrees[/\\]/.test(workspace.root);
}

/** `git add` and `git commit` (alone or joined with &&) inside a worktree EnrichedLab made for this session. */
function ownBranchCommit(command: string, workspace: Workspace): boolean {
	if (!ownWorktree(workspace)) return false;
	const parts = command.split("&&").map((part) => part.trim());
	return parts.every((part) => /^git\s+(add|commit|status|diff|log)\b/.test(part) && !/[;|<>`$\n&]/.test(part) && !/\s--(amend|no-verify)\b/.test(part) && pathsInside(part, (path) => workspace.inside(path)));
}
