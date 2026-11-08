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
import { isReadOnlyCommand, type Judging, pathsInside, personAllows } from "./tools/shell.ts";
import { everyCommand, plainCommands } from "./tools/shell_syntax.ts";
import type { Tool } from "./tools/types.ts";
import { isOpenPort } from "./sites/port_proxy.ts";
import { FULL_CONTAINMENT, physical } from "./tools/workspace.ts";
import type { Workspace } from "./tools/workspace.ts";

export type Verdict =
	/**
	 * `fence`: it runs because of the paths it names, in a lab's sandbox, so the sandbox checks where they lead first.
	 * `readOnly`: it runs contained with nothing in the project writable (it only reads, where nothing may change).
	 */
	| { action: "run"; fence?: boolean; readOnly?: boolean }
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
 * The simple commands of a shell line, as their words, as the shell reads them (shell_syntax.ts). Undefined when the
 * line holds anything whose effect the words don't show: substitutions, compound commands, here-documents, or output
 * written to a file (descriptor copies like 2>&1 and writes to /dev/null are fine).
 */
function simpleCommands(line: string): string[][] | undefined {
	const commands = plainCommands(line);
	if (!commands) return undefined;
	for (const c of commands)
		for (const r of c.redirects) {
			const copy = /&$/.test(r.op) && /^(\d+|-)$/.test(r.target);
			if (r.op.includes(">") && !copy && r.target !== "/dev/null") return undefined;
		}
	return commands.map((c) => [...c.assigns.map((a) => `${a.name}=${a.value}`), ...c.words]).filter((words) => words.length);
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

/** git's own commands: any other word after git could be an alias (from config the agent can write) or a git-* program. */
const GIT_COMMANDS = new Set(("add am annotate apply archive bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap " +
	"check-ref-format checkout checkout-index cherry cherry-pick clean clone column commit commit-graph commit-tree config count-objects " +
	"credential describe diagnose diff diff-files diff-index diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch " +
	"fmt-merge-msg for-each-ref for-each-repo format-patch fsck gc grep hash-object help hook index-pack init interpret-trailers log ls-files " +
	"ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-tree mergetool mktag mktree multi-pack-index " +
	"mv notes pack-objects pack-redundant pack-refs patch-id prune prune-packed pull push range-diff read-tree rebase receive-pack reflog " +
	"remote repack replace replay request-pull rerere reset restore rev-list rev-parse revert rm send-pack shortlog show show-branch show-index " +
	"show-ref sparse-checkout stage stash status stripspace submodule switch symbolic-ref tag unpack-file unpack-objects update-index " +
	"update-ref update-server-info upload-archive upload-pack var verify-commit verify-pack verify-tag version whatchanged worktree write-tree").split(" "));
/** git options whose value is the next word. */
const GIT_VALUE_OPTIONS = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--list-cmds", "--attr-source"]);
/** git subcommands that send work somewhere else: push and its plumbing, and patches mailed out. */
const PUBLISH = ["push", "send-pack", "http-push", "send-email", "imap-send"];
const GIT_PUBLISHERS = PUBLISH.flatMap((p) => [`git-${p}`, `git-${p}.exe`]);

/** Settings that make git run a program (or rename a command): set on the command line, git could push unseen. */
const GIT_RUNS = /^(alias\.|core\.(sshcommand|fsmonitor|pager|editor|askpass|hookspath|gitproxy|alternaterefscommand)|diff\.|filter\.|merge\.|gpg\.|credential\.|uploadpack\.|receivepack\.|sequence\.|interactive\.|remote\.|protocol\.|url\.|include|pager\.|log\.showsignature|submodule\.)/i;
/** Programs that never run their arguments, so a shell's name among them is just a name. */
// Not sort (--compress-program), bat (--pager), man (a pager) or find (-exec): those can run a program.
const NON_RUNNING = new Set(["ls", "cat", "head", "tail", "wc", "echo", "printf", "which", "whereis", "type", "file", "stat", "grep", "egrep", "fgrep", "cut", "tr", "diff", "cmp", "basename", "dirname", "realpath", "readlink", "nl", "jq", "eza", "tree", "du", "df", "apropos", "whatis", "test", "[", "true", "false", "pwd", "date", "uname", "id", "whoami"]);
/** Programs that run the program named in their arguments: an expanded word there could be git. */
const WRAPPERS = new Set(["command", "builtin", "exec", "env", "xargs", "nice", "nohup", "timeout", "sudo", "doas", "time", "stdbuf", "ionice", "chrt", "taskset", "setsid", "flock", "watch", "parallel", "script", "unbuffer", "caffeinate", "arch", "ssh", "su", "runuser", "find", "fd"]);

/** A glob pattern as a regular expression for one name, as bash matches it. */
function patternRegex(pattern: string): RegExp | undefined {
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i]!;
		if (c === "\\" && i + 1 < pattern.length) out += pattern[++i]!.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
		else if (c === "*") out += "[^/]*";
		else if (c === "?") out += "[^/]";
		else if (c === "[") {
			const end = pattern.indexOf("]", i + 2);
			if (end < 0) return undefined;
			let body = pattern.slice(i + 1, end);
			if (body.startsWith("!")) body = `^${body.slice(1)}`;
			out += `[${body.replace(/\\/g, "\\\\")}]`;
			i = end;
		} else out += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
	}
	try {
		return new RegExp(`^${out}$`);
	} catch {
		return undefined;
	}
}

/**
 * Whether a line publishes. Read as the shell reads it (shell_syntax.ts), every command anywhere in it counts.
 * "push": git and a push word in the same line (a glob that could match either counts), code handed to eval or a
 * shell that pushes, or git or push near a function, alias or sourced file. "hidden": what runs depends on more than
 * the line shows, so it could push unseen: a program named by expansion or a glob, git given an expanded word, a
 * setting that makes git run something, a word after git that isn't one of its commands (an alias), git settings
 * set in front, eval or a shell (started directly or through env, timeout, xargs and the like) handed code that
 * expands or arrives on its input, or a line that doesn't parse.
 */
function publishing(command: string, depth = 0): "push" | "hidden" | undefined {
	const line = everyCommand(command);
	if (!line || depth > 4) return /\bgit\b|\bpush\b|\bsend-pack\b/.test(command) ? "push" : "hidden";
	const name = (w: string) => w.replace(/^.*\//, "");
	const could = (text: string | undefined, pattern: string | undefined, names: string[]) => {
		if (text === undefined) return false;
		if (!pattern) return names.includes(name(text));
		const last = pattern.slice(pattern.lastIndexOf("/") + 1);
		const re = patternRegex(last);
		return !re || names.some((n) => re.test(n));
	};
	const isPush = (w: string | undefined, p: string | undefined) => (p ? could(w, p, PUBLISH) : w !== undefined && (/(^|\s)push\b/.test(w) || PUBLISH.includes(name(w))));
	const words: string[] = [];
	let hidden = false;
	let sawGit = false;
	let sawPush = false;
	for (const { words: argv, patterns, assigns } of line.commands) {
		if (assigns.some((a) => /^GIT_/.test(a))) hidden = true;
		if (!argv.length) continue;
		if (argv[0] === undefined || patterns[0] !== undefined) hidden = true;
		const lead = argv[0] === undefined ? "" : argv[0].replace(/^.*\//, "");
		// A wrapper given an expanded word (command "$CMD" push), env splitting a string into a command (env -S), or
		// git settings handed to env (env GIT_SSH_COMMAND=...): what runs depends on more than the line.
		if (WRAPPERS.has(lead) && argv.includes(undefined)) hidden = true;
		if (lead === "env" && argv.some((w) => w !== undefined && (/^(-[a-zA-Z]*S|--split-string)/.test(w) || /^GIT_/.test(w)))) hidden = true;
		for (let i = 0; i < argv.length; i++) {
			// git's publishing programs named directly (git-send-pack, git-push).
			if (could(argv[i], patterns[i], GIT_PUBLISHERS)) {
				sawGit = true;
				sawPush = true;
			}
			if (could(argv[i], patterns[i], ["git", "git.exe"])) {
				sawGit = true;
				let j = i + 1;
				for (; j < argv.length; j++) {
					const w = argv[j];
					if (w === undefined) break;
					if (w === "-c" && (argv[j + 1] === undefined || GIT_RUNS.test(argv[j + 1]!))) hidden = true;
					// Attached forms: -cname=value, --config-env=..., --exec-path=...
					if (/^-c./.test(w) && GIT_RUNS.test(w.slice(2))) hidden = true;
					if (/^--(exec-path|config-env)(=|$)/.test(w)) hidden = true;
					if (GIT_VALUE_OPTIONS.has(w)) j++;
					else if (!w.startsWith("-")) break;
				}
				const sub = argv[j];
				if (j < argv.length && (sub === undefined || patterns[j] !== undefined || !GIT_COMMANDS.has(sub))) hidden = true;
				// git svn dcommit and git p4 submit publish too.
				if ((sub === "svn" && argv.slice(j).includes("dcommit")) || (sub === "p4" && argv.slice(j).includes("submit"))) sawPush = true;
				if (argv.slice(i + 1).includes(undefined)) hidden = true;
			}
			if (isPush(argv[i], patterns[i])) sawPush = true;
		}
		// A shell or eval anywhere a wrapper could start it (env bash -c, timeout 5 sh -c, xargs sh), unless the program
		// is one that only reads its arguments.
		const first = argv[0] === undefined ? undefined : name(argv[0]);
		if (first === undefined || !NON_RUNNING.has(first)) {
			for (let i = 0; i < argv.length; i++) {
				const w = argv[i];
				if (w === undefined) continue;
				const rest = argv.slice(i + 1);
				if (name(w) === "eval") {
					const inner = rest.includes(undefined) ? "hidden" : publishing(rest.join(" "), depth + 1);
					if (inner === "push") return "push";
					if (inner) hidden = true;
					break;
				}
				if (SHELLS.has(name(w))) {
					const flag = rest.findIndex((x) => x !== undefined && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x));
					const script = flag >= 0 ? rest[flag + 1] : undefined;
					const inner = flag >= 0 ? (script === undefined ? "hidden" : publishing(script, depth + 1)) : undefined;
					if (inner === "push") return "push";
					// No -c and no script file: it runs whatever arrives on its input.
					if (inner || (flag < 0 && !rest.some((x) => x === undefined || !x.startsWith("-")))) hidden = true;
					if (flag < 0 && rest.includes(undefined)) hidden = true;
					break;
				}
			}
		}
		for (const w of argv) if (w !== undefined) words.push(w);
		// A word that is itself a command line (a pager, an editor, env -S, --compress-program) is read as one too.
		for (const w of argv) {
			if (w === undefined || !/\s/.test(w) || depth >= 3) continue;
			const inner = publishing(w, depth + 1);
			if (inner === "push") return "push";
			if (inner === "hidden" && everyCommand(w)) hidden = true;
		}
	}
	words.push(...line.heredocs);
	const text = words.join(" ");
	// Functions, aliases and sourced files run what the line can't show: a push when git or push is in it at all.
	if ((line.functions || words.some((w) => w === "alias" || w === "source" || w === ".")) && /\bgit\b|\bpush\b/.test(`${text} ${command}`)) return "push";
	if ((sawGit && sawPush) || words.some((w) => /\bgit\b[\s\S]*\b(push|send-pack|http-push|send-email|imap-send)\b/.test(w)) || (hidden && sawPush)) return "push";
	return hidden ? "hidden" : undefined;
}

/** A line that pushes (publishing). */
export function pushes(command: string): boolean {
	return publishing(command) === "push";
}

/** The question for a line whose program only expansion names: in full mode it could push unseen. */
export const HIDDEN_REASON = "What it runs depends on a variable or substitution, so it could push to a remote.";

/** "a", "a and b", "a, b and c". */
function list(items: string[]): string {
	return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** What an "allow for this session" answer remembers for this call, and what that covers in words. */
export function allowKeys(tool: Tool, args: Record<string, unknown>): { keys: string[]; scope: string } {
	if (tool.kind === "sandbox" && typeof args.command === "string") {
		// The same publishing gate as a shell command: a push, or a line that could push unseen, asks every time.
		const publishes = publishing(args.command.trim());
		if (publishes === "push") return { keys: ["sandbox!push"], scope: "pushing" };
		if (publishes === "hidden") return { keys: ["sandbox!hidden"], scope: "this command, every time" };
		// Remembered per program like a shell command, apart from this computer's answers.
		const found = commandKeys(args.command.trim());
		if (!found) return { keys: [`sandbox=${args.command.trim()}`], scope: "this exact command in the lab's sandbox" };
		return { keys: found.keys.map((key) => key.replace(/^shell:/, "sandbox:")), scope: `${list(found.names.map((n) => `“${n}”`))} commands in the lab's sandbox` };
	}
	if (tool.kind === "exec") {
		const command = String(args.command ?? "").trim();
		// Pushing publishes work: it asks every time, whatever was allowed before. Judged on the words as the shell reads
		// them, so git 'push', g\it push and $'\x67it' push are pushes too.
		const publishes = publishing(command);
		if (publishes === "push") return { keys: ["shell!push"], scope: "pushing" };
		// What it runs depends on more than the line shows: never remembered, so a changed file or variable can't ride
		// on an earlier yes.
		if (publishes === "hidden") return { keys: ["shell!hidden"], scope: "this command, every time" };
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
	if (keys[0] === "shell!push" || keys[0] === "sandbox!push") return ask(PUSH_REASON);
	if (keys[0] === "shell!hidden" || keys[0] === "sandbox!hidden") return ask(HIDDEN_REASON);
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
			// sessions' projects live) and outside the fence: only what the person listed in allowCommands runs; in auto,
			// a sandbox whose whole disk is checkpointed runs anything; the rest asks, remembered per program.
			if (personAllows(command, config.permissions.allowCommands)) return { action: "run" };
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
			if (edit && ownWorktree(workspace)) return { action: "run" };
			// In a lab's sandbox, file edits run under its fence; where the fence doesn't hold, each one asks.
			if (edit && workspace.sandboxed === "site") return workspace.fenced === true ? { action: "run" } : ask("This lab's sandbox can't fence file changes (no Landlock 3 or root-owned python3 there), so each one asks.");
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
			// Contained by the OS: writes stay in the project and temp folders, no network. Runs without asking unless it
			// names a path outside the project or expands variables (the sandbox can still read most of the disk).
			// Windows contains writes only, so there it still asks. A folder set to read only asks for everything.
			// In a lab's sandbox the OS fence is Landlock (sandbox_fence.ts): a sandbox where it doesn't hold asks.
			const lab = workspace.kind === "sandbox";
			const fenced = lab && workspace.fenced === true;
			const contained = workspace.sandboxed && FULL_CONTAINMENT.has(workspace.sandboxed) && args.unsandboxed !== true && (!lab || fenced);
			// Glob words are judged by the names they match: here (expanded now), or in a fenced lab sandbox, where each
			// name is checked just before the command runs. git reads run unasked only when its settings run nothing.
			const judging: Judging = { expand: workspace.expand?.bind(workspace), gitSafe: workspace.gitSafe?.bind(workspace), defer: fenced };
			const inside = (path: string) => workspace.inside(path);
			// Without history (its store failed) a contained change can't be taken back either: it asks.
			if (contained && recoverable && !(local && readOnlyWithin(config, workspace.root)) && pathsInside(command, inside, lab || process.platform !== "win32", false, judging)) return lab ? { action: "run", fence: true } : { action: "run" };
			// Reads run unasked only where they run contained (here under the OS sandbox, or under a lab's fence): what a
			// program does can't be read from its words, so nothing runs uncontained without a yes, except what the
			// person listed in allowCommands.
			const runsContained = fenced || Boolean(local && workspace.sandboxed && FULL_CONTAINMENT.has(workspace.sandboxed) && args.unsandboxed !== true);
			if (runsContained && isReadOnlyCommand(command, config.permissions.allowCommands, inside, judging)) {
				// In a folder set to read only, or without history to take a change back, the OS keeps it from writing:
				// what a program does isn't decided by its words.
				const sealed = !recoverable || (local && readOnlyWithin(config, workspace.root));
				return { action: "run", ...(fenced ? { fence: true } : {}), ...(sealed ? { readOnly: true } : {}) };
			}
			if (personAllows(command, config.permissions.allowCommands)) return { action: "run" };
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

/** Shells: handed a script or -c, they run what their words don't show. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "csh", "tcsh", "busybox", "rbash"]);

/** True when the session works in the worktree EnrichedLab made for it (from the session's record, not its path). */
function ownWorktree(workspace: Workspace): boolean {
	return workspace.worktree !== undefined;
}
