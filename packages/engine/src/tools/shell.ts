// shell: one command through the workspace's shell, with a timeout, streamed output and a stored copy of long output.

import { num, str, type Tool, ToolError } from "./types.ts";

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 1_800;

// Commands that only read. Anything that can write, run another program or reach the network is left out on purpose:
// env (runs its arguments), sed and awk (w, e and system()), yq -i, uniq's output argument, pagers and man.
const READ_ONLY = new Set([
	"ls", "pwd", "cat", "head", "tail", "wc", "rg", "grep", "egrep", "fgrep", "echo", "printf", "which", "whereis", "type",
	"date", "uname", "whoami", "id", "tree", "file", "stat", "du", "df", "sort", "cut", "tr", "diff", "cmp", "basename",
	"dirname", "realpath", "readlink", "nl", "jq", "bat", "eza", "fd", "find", "true", "false", "test", "uptime", "ps",
	"procs", "dust",
	"Get-ChildItem", "Get-Content", "Get-Location", "Select-String", "Get-Item", "Test-Path", "Resolve-Path",
]);
/** Flags that turn a reading command into one that writes or runs something. */
const UNSAFE_FLAGS: Record<string, RegExp> = {
	find: /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/,
	fd: /^(-[a-zA-Z]*[xX]|--exec|--exec-batch)(=|$)/,
	rg: /^--pre(=|$)/,
	sort: /^(-[a-zA-Z]*o|--output)/,
	tree: /^-[a-zA-Z]*o/,
	file: /^-[a-zA-Z]*C/,
	date: /^(-[a-zA-Z]*s|--set)/,
};
/** The first argument of these is a pattern or text, not a path. */
const PATTERN_FIRST = new Set(["rg", "grep", "egrep", "fgrep", "fd", "jq", "Select-String"]);
const TEXT_ONLY = new Set(["echo", "printf", "true", "false", "pwd", "date", "uname", "whoami", "id", "uptime", "which", "whereis", "type"]);
const GIT_READ = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog"]);
const GIT_LIST_ONLY: Record<string, RegExp> = {
	branch: /^(-l|--list|-a|--all|-r|--remotes|-v|-vv|--verbose|--show-current|--merged|--no-merged|--contains|--sort=.*|--format=.*|--color.*|--no-color)$/,
	remote: /^(-v|--verbose)$/,
	tag: /^(-l|--list|-n\d*|--sort=.*|--contains|--points-at|--format=.*)$/,
	config: /^(--get|--get-all|--get-regexp|--list|-l|--show-origin|--name-only|--local|--null|-z)$/,
};
const VERSION_ONLY = /^(--version|-V|version)$/;

type Token = { text: string; op?: undefined } | { op: string; text?: undefined };

/** Split a command line the way a POSIX shell would, far enough to judge it: words with quotes removed and the
 * operators between them. Returns undefined when the line expands variables or runs a substitution. */
export function tokenize(command: string): Token[] | undefined {
	const tokens: Token[] = [];
	let word = "";
	let started = false;
	let quote: "'" | '"' | undefined;
	const flush = () => {
		if (started) tokens.push({ text: word });
		word = "";
		started = false;
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i]!;
		if (quote === "'") {
			if (c === "'") quote = undefined;
			else word += c;
			continue;
		}
		if (c === "`" || c === "$") return undefined; // single-quoted text was handled above
		// A comment at the start of a word: its quotes aren't quotes, so a line holding one can't be judged here.
		if (!quote && c === "#" && !started) return undefined;
		// Unquoted ( ) { } run code: PowerShell subexpressions and script blocks, POSIX subshells and groups.
		if (!quote && "(){}".includes(c)) return undefined;
		if (quote === '"') {
			if (c === '"') quote = undefined;
			else if (c === "\\" && i + 1 < command.length) word += command[++i];
			else word += c;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			started = true;
			continue;
		}
		if (c === "\\") {
			if (i + 1 < command.length) word += command[++i];
			started = true;
			continue;
		}
		if (c === " " || c === "\t") {
			flush();
			continue;
		}
		const two = command.slice(i, i + 2);
		if (["&&", "||", ">>", "<<", "&>", "<(", ">("].includes(two)) {
			flush();
			tokens.push({ op: two });
			i++;
			continue;
		}
		if ("|;&<>\n\r".includes(c)) {
			// "2>" and "1>": the digit belongs to the redirection.
			if ((c === ">" || c === "<") && /^\d$/.test(word) && started) {
				word = "";
				started = false;
			} else flush();
			tokens.push({ op: c === "\r" ? "\n" : c });
			continue;
		}
		word += c;
		started = true;
	}
	if (quote) return undefined;
	flush();
	return tokens;
}

const looksLikePath = (t: string) => /^(~|\/|\\\\|[A-Za-z]:[\\/])/.test(t) || /(^|[\\/])\.\.([\\/]|$)/.test(t);

/** True when every part of a command only reads, inside the project when `inside` is given. Anything unusual
 * (variables, substitution, writing redirection, background jobs, environment prefixes) is not. */
export function isReadOnlyCommand(command: string, extra: string[] = [], inside?: (path: string) => boolean): boolean {
	const text = command.trim();
	if (!text) return false;
	if (extra.some((prefix) => text === prefix || text.startsWith(`${prefix} `)) && !/[;&|<>`$\n]/.test(text)) return true;
	// The check below parses POSIX shell. PowerShell escapes with a backtick and treats \ as a path separator, so on
	// Windows nothing runs unasked except the person's own allowCommands.
	if (process.platform === "win32") return false;
	const tokens = tokenize(text);
	if (!tokens) return false;
	const segments: string[][] = [[]];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!;
		if (t.op === undefined) {
			segments.at(-1)!.push(t.text);
			continue;
		}
		if (t.op === "&&" || t.op === "||" || t.op === ";" || t.op === "|" || t.op === "\n") {
			segments.push([]);
			continue;
		}
		if (t.op === ">" || t.op === "&>" || t.op === ">>") {
			// Only discarding output or merging streams is allowed: >/dev/null, 2>&1.
			const next = tokens[i + 1];
			if (next?.op === "&" && tokens[i + 2]?.text && /^[12]$/.test(tokens[i + 2]!.text!)) {
				i += 2;
				continue;
			}
			if (next?.text === "/dev/null" || next?.text === "NUL") {
				i += 1;
				continue;
			}
			return false;
		}
		if (t.op === "<") {
			const next = tokens[i + 1];
			if (!next?.text || (inside && !inside(next.text))) return false;
			i += 1;
			continue;
		}
		return false; // a background "&", here-documents, process substitution
	}
	return segments.filter((s) => s.length).every((words) => {
		const joined = words.join(" ");
		if (extra.some((prefix) => joined === prefix || joined.startsWith(`${prefix} `))) return true;
		const [cmd, ...args] = words;
		if (!cmd || /^\w+=/.test(cmd)) return false;
		if (args.length === 1 && VERSION_ONLY.test(args[0]!)) return true;
		if (cmd === "git") {
			const [sub, ...rest] = args;
			if (!sub || /^-/.test(sub)) return false;
			if (rest.some((a) => /^(--output|--ext-diff|--exec|-c$|--upload-pack|--receive-pack)/.test(a))) return false;
			if (GIT_READ.has(sub)) return paths(rest, inside, false);
			const list = GIT_LIST_ONLY[sub];
			if (!list) return false;
			const flags = rest.filter((a) => a.startsWith("-"));
			const names = rest.filter((a) => !a.startsWith("-"));
			if (!flags.every((a) => list.test(a))) return false;
			// config reads only with an explicit read flag; a bare "git config key value" writes.
			if (sub === "config") return flags.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a));
			// remote: list, or show/get-url of a named remote; add, rename, remove and set-url write.
			if (sub === "remote") return names.length === 0 || /^(show|get-url)$/.test(names[0]!);
			// branch and tag with a name create one.
			return names.length === 0 || (sub === "branch" && flags.some((a) => /^(--merged|--no-merged|--contains)$/.test(a)) && names.length === 1);
		}
		if (!READ_ONLY.has(cmd)) return false;
		const unsafe = UNSAFE_FLAGS[cmd];
		if (unsafe && args.some((a) => unsafe.test(a))) return false;
		if (TEXT_ONLY.has(cmd)) return true;
		return paths(args, inside, PATTERN_FIRST.has(cmd), cmd);
	});
}

/** True when the command can be parsed and every word shaped like a path is inside the project. */
export function pathsInside(command: string, inside: (path: string) => boolean, posix = process.platform !== "win32", strict = false): boolean {
	// Only POSIX shell words are read; a Windows shell's command asks.
	if (!posix) return false;
	const tokens = tokenize(command.trim());
	if (!tokens) return false;
	return tokens.every((t) => {
		if (t.text === undefined) return true;
		// Where named paths are the only fence, a quoted word holding several words and a path or shell syntax is code
		// or a list, not one path: it can't be judged.
		if (strict && /\s/.test(t.text) && /[/;|&$`(){}<>]|\.\./.test(t.text)) return false;
		const value = t.text.startsWith("-") && t.text.includes("=") ? t.text.slice(t.text.indexOf("=") + 1) : t.text;
		return !(looksLikePath(value) || value.includes("/")) || inside(value);
	});
}

/** The words of a command that name paths (as pathsInside judges them), for the lab sandbox's fence. */
export function pathWords(command: string): string[] {
	return (tokenize(command.trim()) ?? []).flatMap((t) => {
		if (t.text === undefined) return [];
		const value = t.text.startsWith("-") && t.text.includes("=") ? t.text.slice(t.text.indexOf("=") + 1) : t.text;
		return looksLikePath(value) || value.includes("/") ? [value] : [];
	});
}

/** Flags whose value (the next word) is a file or folder, for commands whose first word is a pattern. */
const PATH_FLAGS: Record<string, Set<string>> = {
	grep: new Set(["-f", "--file", "--exclude-from"]),
	egrep: new Set(["-f", "--file"]),
	fgrep: new Set(["-f", "--file"]),
	rg: new Set(["-f", "--file", "--ignore-file"]),
	fd: new Set(["--search-path", "--base-directory", "--ignore-file"]),
	jq: new Set(["-f", "--from-file", "--rawfile", "--slurpfile", "-L"]),
};

/** Every path argument (and every --flag=path value) must be inside the project. */
function paths(args: string[], inside: ((path: string) => boolean) | undefined, skipFirst: boolean, cmd = ""): boolean {
	let skipped = !skipFirst;
	const pathFlags = PATH_FLAGS[cmd];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (pathFlags?.has(arg) && args[i + 1] !== undefined) {
			// "grep -f FILE": FILE is a path to check, and it isn't the pattern.
			const value = args[++i]!;
			if (inside ? !inside(value) : looksLikePath(value)) return false;
			continue;
		}
		if (arg.startsWith("-")) {
			const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : "";
			if (value && looksLikePath(value) && (!inside || !inside(value))) return false;
			continue;
		}
		if (!skipped) {
			skipped = true;
			continue;
		}
		if (inside ? !inside(arg) : looksLikePath(arg)) return false;
	}
	return true;
}

export const shellTool: Tool = {
	name: "shell",
	kind: "exec",
	description:
		"Run one shell command in the project folder and return its combined output and exit code. Non-interactive: no prompts, no pagers. Use timeout (seconds) for long commands; the default is 120.",
	parameters: {
		type: "object",
		properties: {
			command: { type: "string" },
			timeout: { type: "integer", description: "Seconds before the command is stopped (max 1800)." },
			unsandboxed: { type: "boolean", description: "Only when commands are sandboxed and this one needs the network or files outside the project: run it outside the sandbox (asks the person)." },
		},
		required: ["command"],
		additionalProperties: false,
	},
	view: (a) => ({ verb: "shell", target: String(a.command ?? "") }),
	async run(args, ctx) {
		const command = str(args, "command");
		if (!command.trim()) throw new ToolError("The command is empty.");
		const timeout = Math.min(MAX_TIMEOUT_S, Math.max(1, num(args, "timeout") ?? DEFAULT_TIMEOUT_S));
		const started = Date.now();
		const result = await ctx.workspace.exec(command, { timeoutMs: timeout * 1_000, signal: ctx.signal, onOutput: ctx.output, unsandboxed: args.unsandboxed === true, ...(ctx.fence ? { fence: pathWords(command) } : {}) });
		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		const status = result.timedOut ? `stopped after ${timeout}s` : ctx.signal.aborted ? "cancelled" : `exit ${result.exitCode ?? "?"}`;
		const output = result.output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
		return {
			ok: !result.timedOut && result.exitCode === 0,
			content: `${output}${output.endsWith("\n") || !output ? "" : "\n"}[${status}, ${seconds}s]`,
			view: { result: status, detail: output },
		};
	},
};
