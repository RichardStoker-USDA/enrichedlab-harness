// shell: one command through the workspace's shell, with a timeout, streamed output and a stored copy of long output.

import { plainCommands } from "./shell_syntax.ts";
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
const VERSION_ONLY = /^(--version|-V)$/;

/**
 * How glob words and git are judged. `expand`: the names a glob pattern matches here (undefined when it can't
 * say); without it a glob word isn't read-only. `defer`: a glob whose fixed part is inside may pass, because the
 * place checks each name it expands to before the command runs (a lab sandbox's fence). `gitSafe`: git's settings
 * here make no read command run a program; without it git isn't read-only.
 */
export interface Judging {
	expand?: (pattern: string) => string[] | undefined;
	defer?: boolean;
	gitSafe?: () => boolean;
}

/** A glob path component starting with a literal dot can match "." or ".." (bash 3.2's .? and .*): it could leave. */
function couldClimb(pattern: string): boolean {
	return pattern.split("/").some((part) => part.startsWith(".") && /(^|[^\\])[*?[]/.test(part));
}

/** The folder part of a glob before its first glob component, escapes taken out ("" for the current folder). */
export function globBase(pattern: string): string {
	const parts = pattern.split("/");
	const first = parts.findIndex((part) => /(^|[^\\])[*?[]/.test(part));
	return parts.slice(0, first < 0 ? parts.length : first).join("/").replace(/\\(.)/g, "$1");
}

/** Every name a word stands for is judged by `ok`: its matches for a glob, else itself. */
function eachName(text: string, pattern: string | undefined, ok: (path: string) => boolean, judging: Judging): boolean {
	if (!pattern) return ok(text);
	if (couldClimb(pattern)) return false;
	if (judging.expand) {
		const matches = judging.expand(pattern);
		if (!matches) return false;
		// No match: bash passes the pattern on as it is.
		return matches.length ? matches.every(ok) : ok(text);
	}
	if (!judging.defer) return false;
	const base = globBase(pattern);
	return ok(base || ".");
}


const looksLikePath = (t: string) => /^(~|\/|\\\\|[A-Za-z]:[\\/])/.test(t) || /(^|[\\/])\.\.([\\/]|$)/.test(t);

/** True when every part of a command only reads, inside the project when `inside` is given. Anything unusual
 * (variables, substitution, writing redirection, background jobs, environment prefixes) is not. */
export function isReadOnlyCommand(command: string, extra: string[] = [], inside?: (path: string) => boolean, judging: Judging = {}): boolean {
	const text = command.trim();
	if (!text) return false;
	if (extra.some((prefix) => text === prefix || text.startsWith(`${prefix} `)) && !/[;&|<>`$\n]/.test(text)) return true;
	// The check below parses POSIX shell. PowerShell escapes with a backtick and treats \ as a path separator, so on
	// Windows nothing runs unasked except the person's own allowCommands.
	if (process.platform === "win32") return false;
	// The words each command gets, as the shell reads the line (shell_syntax.ts): anything that isn't plain text asks.
	const commands = plainCommands(text);
	if (!commands) return false;
	for (const c of commands) {
		if (c.background || c.assigns.length) return false;
		for (const r of c.redirects) {
			// Only discarding output or merging streams (>/dev/null, 2>&1), and reading a file inside the project.
			if ((r.op === ">&" || r.op === "<&") && /^[012]$/.test(r.target)) continue;
			if ([">", ">>", "&>", "&>>", ">|"].includes(r.op) && (r.target === "/dev/null" || r.target === "NUL")) continue;
			if (r.op === "<" && (!inside || inside(r.target))) continue;
			return false;
		}
	}
	return commands.length > 0 && commands.every(({ words, patterns }) => {
		const joined = words.join(" ");
		if (extra.some((prefix) => joined === prefix || joined.startsWith(`${prefix} `)) && !patterns.some(Boolean)) return true;
		const [cmd, ...args] = words;
		const argPatterns = patterns.slice(1);
		if (!cmd || patterns[0] !== undefined || /^\w+=/.test(cmd)) return false;
		// "--version" says nothing about a program the project holds: only a bare name found on PATH counts.
		if (args.length === 1 && VERSION_ONLY.test(args[0]!) && /^[A-Za-z0-9][\w.+-]*$/.test(cmd)) return true;
		if (cmd === "git") {
			// A repository's settings can make even git status run a program (core.fsmonitor, filter and diff drivers).
			if (!judging.gitSafe?.() || argPatterns.some(Boolean)) return false;
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
		if (TEXT_ONLY.has(cmd)) return !argPatterns.some(Boolean);
		return paths(args, inside, PATTERN_FIRST.has(cmd), cmd, argPatterns, judging);
	});
}

/** True when the command can be parsed and every word shaped like a path (every name a glob matches) is inside. */
export function pathsInside(command: string, inside: (path: string) => boolean, posix = process.platform !== "win32", strict = false, judging: Judging = {}): boolean {
	// Only POSIX shell words are read; a Windows shell's command asks.
	if (!posix) return false;
	const words = wordsOf(command);
	if (!words.length) return false;
	return words.every(({ text, pattern }) => {
		// Where named paths are the only fence, a quoted word holding several words and a path or shell syntax is code
		// or a list, not one path: it can't be judged.
		if (strict && /\s/.test(text) && /[/;|&$`(){}<>]|\.\./.test(text)) return false;
		const one = (name: string) => {
			const value = name.startsWith("-") && name.includes("=") ? name.slice(name.indexOf("=") + 1) : name;
			return !(looksLikePath(value) || value.includes("/")) || inside(value);
		};
		return eachName(text, pattern, one, judging);
	});
}

/** Every word of a command with its glob pattern when it is one: assignment values, words and redirection targets. */
export function wordsOf(command: string): { text: string; pattern?: string }[] {
	return (plainCommands(command.trim()) ?? []).flatMap((c) => [
		...c.assigns.map((a) => ({ text: a.value })),
		...c.words.map((text, i) => (c.patterns[i] ? { text, pattern: c.patterns[i] } : { text })),
		...c.redirects.map((r) => ({ text: r.target })),
	]);
}

/** Every word of a command, quotes taken out (for naming the files a step read); empty when it can't be read. */
export function commandWords(command: string): string[] {
	return wordsOf(command).map((w) => w.text);
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

/** Every path argument (and every --flag=path value, and every name a glob argument matches) must be inside. */
function paths(args: string[], inside: ((path: string) => boolean) | undefined, skipFirst: boolean, cmd = "", patterns: (string | undefined)[] = [], judging: Judging = {}): boolean {
	let skipped = !skipFirst;
	const pathFlags = PATH_FLAGS[cmd];
	const one = (path: string) => (inside ? inside(path) : !looksLikePath(path));
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		const pattern = patterns[i];
		// A glob is expanded by the shell before the program sees it: each name it matches is a path to judge, even
		// where the program would read the word as its pattern.
		if (pattern) {
			if (!eachName(arg, pattern, one, judging)) return false;
			if (!skipped) skipped = true;
			continue;
		}
		if (pathFlags?.has(arg) && args[i + 1] !== undefined) {
			// "grep -f FILE": FILE is a path to check, and it isn't the pattern.
			i++;
			if (patterns[i] ? !eachName(args[i]!, patterns[i], one, judging) : !one(args[i]!)) return false;
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
		if (!one(arg)) return false;
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
		const result = await ctx.workspace.exec(command, { timeoutMs: timeout * 1_000, signal: ctx.signal, onOutput: ctx.output, unsandboxed: args.unsandboxed === true, ...(ctx.fence ? { fence: wordsOf(command) } : {}) });
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
