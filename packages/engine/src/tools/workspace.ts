// The workspace seam. File and shell tools act through a Workspace, so a session can move into a site sandbox
// without changing its tools. The local workspace acts in the project folder with the person's own rights.

import { spawn } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, readlinkSync, realpathSync, statSync, writeSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { withoutSecrets } from "../util.ts";
import { holdFolder, mkdirPhysical, openPhysical } from "./anchored.ts";

export interface Entry {
	name: string;
	type: "file" | "dir" | "link" | "other";
	size: number;
}

export interface ExecResult {
	exitCode: number | null;
	output: string;
	timedOut: boolean;
}

export interface Workspace {
	kind: "local" | "sandbox";
	/** Shown to the model and the person. */
	label: string;
	root: string;
	resolve(path: string): string;
	inside(path: string): boolean;
	display(path: string): string;
	read(path: string): Promise<Buffer>;
	/** `outside`: the call was approved for a path outside the project; otherwise the write must still land inside it. */
	write(path: string, data: string | Buffer, options?: { outside?: boolean }): Promise<void>;
	stat(path: string): Promise<{ type: Entry["type"]; size: number } | undefined>;
	list(path: string): Promise<Entry[]>;
	/**
	 * `fence` (lab sandboxes): the command runs under the sandbox's file fence (sandbox_fence.ts), and the paths it names
	 * must lead inside the project, links followed, or it doesn't run.
	 */
	/** `readOnly`: the command runs contained with nothing in the project writable (a read-only subagent), or not at all. */
	exec(command: string, options: { timeoutMs: number; signal: AbortSignal; onOutput?: (text: string) => void; unsandboxed?: boolean; env?: Record<string, string>; fence?: { text: string; pattern?: string }[]; readOnly?: boolean }): Promise<ExecResult>;
	/** The worktree EnrichedLab made for this session (known from the session's own record, never from the path). */
	readonly worktree?: { path: string; gitDir: string };
	/** Set when commands run contained: by the OS ("seatbelt", "bwrap") or in a site's sandbox ("site"). */
	readonly sandboxed?: string;
	/** The names a glob pattern matches here, relative as the shell gives them; undefined when it can't say. */
	expand?(pattern: string): string[] | undefined;
	/** git's settings here make no read command (status, diff, log) run a program. */
	gitSafe?(): boolean;
	/** Commands can run under an OS file fence here (a lab sandbox where Landlock holds): known once prepared. */
	readonly fenced?: boolean;
	/** Whatever a place checks before its first decision (a lab sandbox's fence probe). */
	prepare?(): Promise<void>;
	/** What the session's history can bring back here: "filesystem" (a lab's whole-disk checkpoints) or "folder". */
	readonly checkpointed?: "filesystem" | "folder";
	shellName: string;
	/** Content search done where the files are, for places where reading file by file is slow. */
	grep?(pattern: string, base: string, options: { glob?: string; ignoreCase?: boolean; limit: number }): Promise<string[]>;
	/** File names matching a glob, done where the files are. */
	glob?(pattern: string, base: string): Promise<string[]>;
}

const MAX_EXEC_OUTPUT = 4 * 1024 * 1024;

function pickShell(): { file: string; args: (command: string) => string[]; name: string } {
	if (process.platform === "win32") {
		const pwsh = (process.env.PATH ?? "").split(";").some((dir) => dir && existsSync(join(dir, "pwsh.exe")));
		const file = pwsh ? "pwsh.exe" : "powershell.exe";
		return { file, args: (c) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", c], name: pwsh ? "PowerShell 7" : "Windows PowerShell" };
	}
	// Always the system's bash, the language the approvals parse (shell_syntax.ts), never a shell named by $SHELL.
	const file = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
	return { file, args: (c) => ["-c", c], name: file.split("/").pop() ?? "sh" };
}

/** realpath of the longest existing prefix, with the rest appended: works for files that don't exist yet. */
function real(path: string, depth = 0): string {
	const rest: string[] = [];
	let current = path;
	for (;;) {
		try {
			return join(realpathSync.native(current), ...rest);
		} catch {
			// A link whose target doesn't exist yet still says where a write would land: follow it.
			if (depth < 16) {
				try {
					const target = readlinkSync(current);
					return real(join(isAbsolute(target) ? target : join(dirname(current), target), ...rest), depth + 1);
				} catch {
					// Not a link: look at the parent.
				}
			}
			const parent = dirname(current);
			if (parent === current) return path;
			rest.unshift(basename(current));
			current = parent;
		}
	}
}

/** How local commands are contained. "workspace": writes only inside the project and temp folders, no network. */
export type SandboxMode = "off" | "workspace";

let bwrapWorks: boolean | undefined;
let windowsWorks: boolean | undefined;

/** This program, as a command: the compiled binary, or bun with the CLI's source. */
function selfCommand(): string[] {
	return /^bun(\.exe)?$/i.test(basename(process.execPath)) ? [process.execPath, join(import.meta.dir, "..", "..", "..", "cli", "src", "main.ts")] : [process.execPath];
}

/**
 * The environment without what makes bash run something other than the line: startup files (BASH_ENV, ENV,
 * ZDOTDIR), options and traces (SHELLOPTS, BASHOPTS, PS4), prompt and cd hooks, and functions passed in.
 */
export function shellSafe(env: Record<string, string | undefined>): Record<string, string> {
	const drop = /^(BASH_ENV|ENV|ZDOTDIR|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|CDPATH|GLOBIGNORE|BASH_XTRACEFD|EXECIGNORE|IFS)$|^BASH_FUNC_/;
	return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !drop.test(entry[0]) && !entry[1].startsWith("() {")));
}

/** The temp folder commands may write: the system's, unless it is / or holds the home folder (then /tmp). */
export function safeTemp(): string {
	const fallback = process.platform === "darwin" ? "/private/tmp" : "/tmp";
	let temp: string;
	try {
		temp = realpathSync(tmpdir());
	} catch {
		return fallback;
	}
	const home = (() => {
		try {
			return realpathSync(homedir());
		} catch {
			return homedir();
		}
	})();
	const holds = (outer: string, inner: string) => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
	return temp === sep || holds(temp, home) || temp.split(sep).filter(Boolean).length < 2 ? fallback : temp;
}

/** Where a trusted git may really live: the system's and Homebrew's own folders (a link from them must stay there). */
const GIT_HOMES = ["/usr/bin/", "/bin/", "/usr/libexec/", "/Library/Developer/CommandLineTools/", "/Applications/Xcode.app/", "/opt/homebrew/", "/usr/local/Cellar/", "/usr/local/bin/", "/usr/local/opt/"];

/**
 * git from the system's or Homebrew's own folders, never one found on the caller's PATH. The program it leads to
 * must also be there, owned by root or the person and writable by no one else: a link into a project isn't git.
 */
export function trustedGit(): string | undefined {
	// macOS's /usr/bin/git is a stub that asks to install the developer tools when they're missing.
	const tools = process.platform !== "darwin" || existsSync("/Library/Developer/CommandLineTools/usr/bin/git") || existsSync("/Applications/Xcode.app");
	const uid = process.getuid?.() ?? 0;
	return ["/opt/homebrew/bin/git", "/usr/local/bin/git", ...(tools ? ["/usr/bin/git"] : []), "/bin/git"].find((at) => {
		try {
			const target = realpathSync(at);
			const s = statSync(target);
			const dir = statSync(dirname(target));
			const owned = (x: { uid: number; mode: number }) => (x.uid === 0 || x.uid === uid) && (x.mode & 0o022) === 0;
			return GIT_HOMES.some((home) => target.startsWith(home)) && s.isFile() && owned(s) && owned(dir);
		} catch {
			return false;
		}
	});
}

/** git settings that make a read command (status, diff, log, show, blame) run a program. */
const GIT_READ_RUNS = /^(diff\.external|diff\..+\.(command|textconv)|filter\..+\.(clean|smudge|process)|gpg\.(.+\.)?program|log\.showsignature|core\.alternaterefscommand)$/;

/** bubblewrap from the system's own folders, owned by root and writable by nobody else, never one found on PATH. */
function trustedBwrap(): string | undefined {
	for (const at of ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"]) {
		try {
			const s = statSync(at);
			const dir = statSync(dirname(at));
			if (s.isFile() && s.uid === 0 && (s.mode & 0o022) === 0 && dir.uid === 0 && (dir.mode & 0o022) === 0) return at;
		} catch {
			// Not there.
		}
	}
	return undefined;
}

export type Facility = "seatbelt" | "bubblewrap" | "restricted-token";

/** Facilities that contain reads and the network as well as writes; commands under them run without asking. */
// "site": a lab's sandbox, a separate Linux machine with no network; nothing a command does there reaches this computer.
export const FULL_CONTAINMENT = new Set<string>(["seatbelt", "bubblewrap", "site"]);

/** The OS facility that contains a command, when this machine has one that works. */
export function sandboxer(): Facility | undefined {
	if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) return "seatbelt";
	if (process.platform === "win32") {
		// Check once that a command starts and reports its exit code under the restricted token; if not, commands
		// run as they are and ask first.
		if (windowsWorks === undefined) {
			const self = selfCommand();
			const probe = Bun.spawnSync([...self, "__contain", JSON.stringify([tmpdir()]), "--", "cmd.exe", "/d", "/c", "exit 7"], { stdout: "ignore", stderr: "ignore" });
			windowsWorks = probe.exitCode === 7;
		}
		return windowsWorks ? "restricted-token" : undefined;
	}
	if (process.platform === "linux") {
		// bubblewrap needs user namespaces; some hosts (nested containers, locked-down nodes) don't allow them. Try
		// once: without a working sandbox, commands ask first instead of failing.
		if (bwrapWorks === undefined) {
			const bwrap = trustedBwrap();
			bwrapWorks = bwrap !== undefined && Bun.spawnSync([bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-all", "true"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
		}
		if (bwrapWorks) return "bubblewrap";
	}
	return undefined;
}

/** Folders a contained command may never read: credentials, and the engine's keys, sessions, notes and its run
 * folder (which holds the engine's own key). Installed apps and the app runtime under ~/.el stay readable. */
const PRIVATE_DIRS = [
	".ssh", ".secrets", ".aws", ".gnupg", ".config/gcloud", ".kube", ".docker", ".netrc",
	".npmrc", ".pypirc", ".git-credentials", ".cargo/credentials.toml", ".config/gh", ".claude", ".codex", ".cache/huggingface",
	".zsh_history", ".bash_history", "Library/Keychains", "Library/Cookies",
	"Library/Application Support/Google/Chrome", "Library/Application Support/Firefox", "Library/Application Support/com.apple.TCC",
	".el/credentials", ".el/keys", ".el/sessions", ".el/run", ".el/memory", ".el/canvases", ".el/app-data",
];

/** What a contained program may reach: nothing, this computer's own loopback (a local web app), or the network. */
export type NetworkAccess = "none" | "loopback" | "all";

/** Seatbelt profile: writes only to `writable`, the credential folders unreadable, and the network as `network`
 * allows ("none" includes local sockets: Docker, ssh-agent). */
function seatbeltProfile(writable: string[], network: NetworkAccess, readable: string[] = [], protect: string[] = []): string {
	const quote = (p: string) => JSON.stringify(p);
	const hidden = PRIVATE_DIRS.map((d) => `(subpath ${quote(join(homedir(), d))})`).join(" ");
	const net =
		network === "all"
			? []
			: network === "loopback"
				? ["(deny network*)", '(allow network-bind (local ip "localhost:*"))', '(allow network-inbound (local ip "localhost:*"))', '(allow network-outbound (remote ip "localhost:*"))']
				: ["(deny network*)"];
	return [
		"(version 1)",
		"(allow default)",
		"(deny file-write*)",
		`(allow file-write* ${writable.map((p) => `(subpath ${quote(p)})`).join(" ")} (literal "/dev/null") (regex #"^/dev/(tty|fd/|stdout|stderr)"))`,
		// Later rules win: protected paths inside a writable folder stay read only, existing or not.
		...(protect.length ? [`(deny file-write* ${protect.map((p) => `(subpath ${quote(p)})`).join(" ")})`] : []),
		`(deny file-read* ${hidden})`,
		// Paths inside a hidden folder that this program needs (an app's runner and data); later rules win.
		...(readable.length ? [`(allow file-read* ${readable.map((p) => `(subpath ${quote(p)})`).join(" ")})`] : []),
		...net,
	].join("\n");
}

/** The program and arguments that run `file args` contained by the OS: writes only to `writable` (and temp folders),
 * credential folders hidden, the network as given. Returned unchanged where this computer has no facility
 * (Windows today); `facility` says which one applied. */
/** `temp: false` leaves the system's temp folders out of what may be written (a replay writes only its own folder). */
/**
 * `exact`: each writable path must already be where it leads (physical); one that now leads elsewhere refuses, and
 * what is granted is that checked folder itself (bubblewrap binds a handle opened without following links, not the
 * name, so a link swapped in afterwards grants nothing; Seatbelt judges the real path of every write). The caller
 * hands `pass` to the program as its file descriptors 3, 4, ... (after stdin, stdout, stderr) and calls `release`
 * once it has exited. `protect`: paths inside the writable ones that stay read only (a
 * repository's settings and hooks).
 */
export function contained(file: string, args: string[], options: { writable: string[]; network: NetworkAccess; readable?: string[]; server?: boolean; temp?: boolean; exact?: boolean; protect?: string[] }): { file: string; args: string[]; facility?: Facility; pass?: number[]; release?: () => void } {
	// Each path resolved once: the check and the grant are the same answer.
	const resolved = options.writable.map(real);
	if (options.exact) resolved.forEach((p, i) => {
		if (p !== options.writable[i]) throw new Error(`${options.writable[i]} now leads somewhere else (a link may have moved); nothing ran.`);
	});
	const facility = sandboxer();
	if (!facility) return { file, args };
	if (facility === "restricted-token") {
		// Long-running servers (app backends) speaking MCP over stdio stall under the Windows helper after their
		// first messages; until that's solved they run as the person, and the consent card says so.
		if (options.server) return { file, args };
		// This program runs the command under a write-restricted token (windows_contain.ts): the compiled binary
		// itself, or bun with the CLI's source.
		const self = selfCommand();
		const writable = [...options.writable, ...(options.temp === false ? [] : [safeTemp()])].map((p) => resolve(p));
		return { file: self[0]!, args: [...self.slice(1), "__contain", JSON.stringify(writable), "--", file, ...args], facility };
	}
	const writable = [...resolved, ...(options.temp === false ? [] : [safeTemp(), "/private/tmp", "/tmp"])].filter((p, i, all) => existsSync(p) && all.indexOf(p) === i);
	const readable = [...resolved, ...(options.readable ?? []).map(real)].filter((p) => existsSync(p));
	const protect = (options.protect ?? []).map(real);
	if (facility === "seatbelt") return { file: "/usr/bin/sandbox-exec", args: ["-p", seatbeltProfile(writable, options.network, readable, protect), file, ...args], facility };
	// Read-only root, the writable folders bound, a private /tmp, credential folders hidden, every namespace unshared
	// (network, pids, IPC, user) so host sockets under /tmp and /run are out of reach. Loopback can't be split from
	// the network in a namespace, so "loopback" shares the network here.
	const hidden = PRIVATE_DIRS.map((d) => join(homedir(), d)).filter((p) => existsSync(p)).flatMap((p) => ["--tmpfs", p]);
	const held: number[] = [];
	// An exact folder is bound from a handle on the checked folder, passed to bubblewrap as an open file descriptor
	// (--bind-fd), so it can't follow a link put in its place after the check.
	const bind = (p: string) => {
		if (!options.exact || !resolved.includes(p)) return ["--bind", p, p];
		held.push(holdFolder(p));
		return ["--bind-fd", String(2 + held.length), p];
	};
	let binds: string[];
	try {
		binds = [
			...writable.filter((p) => p !== "/tmp" && p !== "/private/tmp").flatMap(bind),
			...(options.readable ?? []).map(real).filter((p) => existsSync(p)).flatMap((p) => ["--ro-bind", p, p]),
			// Bound read only over the writable folder (only what exists: bubblewrap can't protect a missing path).
			...protect.filter((p) => existsSync(p)).flatMap((p) => ["--ro-bind", p, p]),
		];
	} catch (error) {
		for (const fd of held) closeSync(fd);
		throw error;
	}
	const net = options.network === "none" ? [] : ["--share-net"];
	// Without temp folders (a replay), the private /tmp and /run that hide the host's sockets can't be written either.
	const sealed = options.temp === false ? ["--remount-ro", "/tmp", "--remount-ro", "/run"] : [];
	return {
		file: trustedBwrap() ?? "/usr/bin/bwrap",
		args: ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/run", ...sealed, ...hidden, ...binds, "--unshare-all", ...net, "--die-with-parent", "--new-session", "--", file, ...args],
		facility,
		...(held.length ? { pass: [...held], release: () => held.splice(0).forEach((fd) => closeSync(fd)) } : {}),
	};
}

export class LocalWorkspace implements Workspace {
	readonly kind = "local" as const;
	readonly label: string;
	private shell = pickShell();
	readonly shellName = this.shell.name;

	/** Set when commands run contained (see SandboxMode): the facility in use. */
	readonly sandboxed?: Facility;

	/** The session's own worktree: its folder, and the repository's git folder it commits into. */
	readonly worktree?: { path: string; gitDir: string };

	/** `worktree`: the one EnrichedLab made for this session, from the session's record (engine.ts). */
	constructor(
		readonly root: string,
		sandbox: SandboxMode = "off",
		worktree?: { path: string; repo: string },
	) {
		this.label = `this computer, in ${root}`;
		if (sandbox === "workspace") this.sandboxed = sandboxer();
		if (worktree) {
			const gitDir = real(join(worktree.repo, ".git"));
			const path = real(worktree.path);
			const here = real(root);
			// Only a worktree inside the repository's own .git, holding this folder.
			if (statSync(gitDir, { throwIfNoEntry: false })?.isDirectory() && path.startsWith(`${gitDir}${sep}`) && (here === path || here.startsWith(`${path}${sep}`))) this.worktree = { path, gitDir };
		}
	}

	/**
	 * What contained commands may write: the project, and in the session's worktree the repository's git folder too
	 * (commits go there). Never a repository's settings, hooks or info folder, which make git run programs later.
	 */
	private writable(): { writable: string[]; protect: string[] } {
		const writable = [this.root, ...(this.worktree ? [this.worktree.gitDir] : [])];
		const gitDirs = [...(this.worktree ? [this.worktree.gitDir] : []), ...writable.map((w) => join(w, ".git")).filter((g) => statSync(g, { throwIfNoEntry: false })?.isDirectory())];
		const protect = [...new Set(gitDirs)].flatMap((g) => [join(g, "config"), join(g, "hooks"), join(g, "info")]);
		if (this.worktree) protect.push(join(this.worktree.gitDir, "worktrees", basename(this.worktree.path), "config.worktree"));
		return { writable, protect };
	}

	/** The program and arguments that run `command`, contained when the workspace is sandboxed. */
	private launch(command: string, contain: boolean, readOnly = false): { file: string; args: string[] } {
		const plain = { file: this.shell.file, args: this.shell.args(command) };
		if (!contain || !this.sandboxed) return plain;
		if (readOnly) return contained(plain.file, plain.args, { writable: [], network: "none" });
		return contained(plain.file, plain.args, { ...this.writable(), network: "none" });
	}

	resolve(path: string): string {
		if (path.includes("\0")) throw new Error("A path can't hold a NUL character.");
		const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
		const joined = isAbsolute(expanded) ? expanded : `${this.root}${sep}${expanded}`;
		// A ".." goes where the system takes it (after following the link before it), the same way inside() judges it,
		// so what was allowed and what is opened are one place.
		return /(^|[\\/])\.\.([\\/]|$)/.test(expanded) ? physical(joined) : resolve(joined);
	}

	/** Credential folders (PRIVATE_DIRS) stay closed to the file tools, whatever was allowed, symlinks followed. */
	private open(path: string): string {
		const full = this.resolve(path);
		const home = homedir();
		for (const dir of PRIVATE_DIRS) {
			const blocked = join(home, dir);
			if ([full, real(full)].some((p) => p === blocked || p.startsWith(blocked + sep))) throw new Error(`${this.display(full)} is in ~/${dir}, which EnrichedLab never reads or writes.`);
		}
		return full;
	}

	/** Inside the project after following symlinks, so a link in the project can't reach the rest of the disk. */
	inside(path: string): boolean {
		// "~name/…" is another account's home to the shell; never inside a project.
		if (/^~[^/\\]/.test(path)) return false;
		this.realRoot ??= real(this.root);
		const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
		const rel = relative(this.realRoot, physical(isAbsolute(expanded) ? expanded : `${this.root}${sep}${expanded}`));
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	}
	private realRoot?: string;

	display(path: string): string {
		const full = this.resolve(path);
		const rel = relative(this.root, full);
		if (rel === "") return ".";
		if (!rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep).join("/");
		const home = homedir();
		return full.startsWith(home + sep) ? `~/${relative(home, full).split(sep).join("/")}` : full;
	}

	async read(path: string): Promise<Buffer> {
		return readFile(this.open(path));
	}

	/**
	 * Written where the path leads, links followed once here, never following a link at the end, and checked again
	 * after opening: a link changed meanwhile can't send the bytes somewhere else.
	 */
	expand(pattern: string): string[] | undefined {
		const parts = pattern.split("/");
		const first = parts.findIndex((part) => /(^|[^\\])[*?[]/.test(part));
		if (first < 0) return [pattern.replace(/\\(.)/g, "$1")];
		const prefix = parts.slice(0, first).join("/");
		const plain = prefix.replace(/\\(.)/g, "$1");
		const base = pattern.startsWith("/") ? plain || "/" : plain === "~" || plain.startsWith("~/") ? join(homedir(), plain.slice(1)) : resolve(this.root, plain || ".");
		const out: string[] = [];
		try {
			for (const match of new Bun.Glob(parts.slice(first).join("/")).scanSync({ cwd: base, dot: true, onlyFiles: false, followSymlinks: false })) {
				out.push(prefix || pattern.startsWith("/") ? `${plain === "/" ? "" : plain}/${match}` : match);
				// More names than can be judged one by one: the command asks.
				if (out.length > 2_000) return undefined;
			}
		} catch {
			return undefined;
		}
		return out;
	}

	gitSafe(): boolean {
		const git = trustedGit();
		if (!git) return false;
		const r = Bun.spawnSync([git, "config", "--list", "--show-scope", "--includes", "-z"], { cwd: this.root, env: shellSafe({ PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG }), stdout: "pipe", stderr: "ignore", timeout: 5_000 });
		if (r.exitCode !== 0) return false;
		const fields = r.stdout.toString().split("\0");
		for (let i = 0; i + 1 < fields.length; i += 2) {
			// The repository's own settings (which a file edit can change), not the person's global or system ones
			// (git lfs install sets a filter there for every repository).
			if (!["local", "worktree", "command"].includes(fields[i]!)) continue;
			const [key = "", value = ""] = fields[i + 1]!.split("\n");
			const name = key.toLowerCase();
			if (GIT_READ_RUNS.test(name)) return false;
			// core.fsmonitor names a program to run unless it's true (git's own daemon) or false.
			if (name === "core.fsmonitor" && !/^(true|false|yes|no|on|off|1|0|)$/i.test(value)) return false;
		}
		return true;
	}

	async write(path: string, data: string | Buffer, options: { outside?: boolean } = {}): Promise<void> {
		const full = this.open(path);
		// Where it leads now, links followed once, judged before anything is made: a link changed since the decision
		// isn't followed out of the project.
		const real = physical(full);
		const home = physical(this.root);
		const rest = relative(home, real);
		if (!options.outside && (rest.startsWith("..") || isAbsolute(rest))) throw new Error(`${this.display(full)} now leads outside the project (a link may have moved); nothing was written.`);
		// Then made and opened at that physical path without following a link anywhere (anchored.ts): a folder swapped
		// for a link meanwhile makes it fail instead of writing somewhere else.
		let fd: number;
		try {
			mkdirPhysical(dirname(real));
			fd = openPhysical(real, constants.O_WRONLY | constants.O_CREAT, 0o666);
		} catch {
			throw new Error(`${this.display(full)} changed while it was being written (a link may have moved); nothing was written.`);
		}
		try {
			const opened = fstatSync(fd);
			if (!opened.isFile()) throw new Error(`${this.display(full)} isn't a file; nothing was written.`);
			// Another name for the same file (a hard link) may sit outside the project: writing here would change it there.
			if (opened.nlink > 1 && !options.outside) throw new Error(`${this.display(full)} has another name elsewhere (a hard link); nothing was written.`);
			ftruncateSync(fd, 0);
			writeSync(fd, typeof data === "string" ? Buffer.from(data) : data, 0, undefined, 0);
		} finally {
			closeSync(fd);
		}
	}

	async stat(path: string) {
		try {
			const s = await stat(this.open(path));
			return { type: (s.isDirectory() ? "dir" : s.isFile() ? "file" : "other") as Entry["type"], size: s.size };
		} catch {
			return undefined;
		}
	}

	async list(path: string): Promise<Entry[]> {
		const full = this.open(path);
		const entries = await readdir(full, { withFileTypes: true });
		const out: Entry[] = [];
		for (const e of entries) {
			let size = 0;
			if (e.isFile()) size = (await stat(join(full, e.name)).catch(() => ({ size: 0 }))).size;
			out.push({ name: e.name, type: e.isDirectory() ? "dir" : e.isFile() ? "file" : e.isSymbolicLink() ? "link" : "other", size });
		}
		return out.sort((a, b) => (a.type === "dir" ? 0 : 1) - (b.type === "dir" ? 0 : 1) || a.name.localeCompare(b.name));
	}

	exec(command: string, options: { timeoutMs: number; signal: AbortSignal; onOutput?: (text: string) => void; unsandboxed?: boolean; env?: Record<string, string>; readOnly?: boolean }): Promise<ExecResult> {
		if (options.signal.aborted) return Promise.resolve({ exitCode: null, output: "", timedOut: false });
		// Read only is the OS's to enforce: where nothing can contain the command, it doesn't run.
		if (options.readOnly && (!this.sandboxed || !FULL_CONTAINMENT.has(this.sandboxed) || options.unsandboxed)) return Promise.resolve({ exitCode: 125, output: "A read-only subagent runs commands only where the OS can keep them from writing (macOS Seatbelt, Linux bubblewrap), so this didn't run.", timedOut: false });
		const { file, args } = this.launch(command, !options.unsandboxed, options.readOnly);
		// A contained command runs without asking, so it never sees the engine's keys and tokens: `env` would show them.
		const base = shellSafe(options.env ?? process.env);
		const env = this.sandboxed && !options.unsandboxed ? withoutSecrets(base) : base;
		return new Promise((done) => {
			const child = spawn(file, args, {
				cwd: this.root,
				// Inside the project's own package environment when it has one (tools/environment.ts), for contained
				// commands only: its programs are the project's, so they never run uncontained in place of the system's.
				env: { ...(this.sandboxed && !options.unsandboxed ? activated(this.root, env) : env), LAB_AGENT: "1", PAGER: "cat", GIT_PAGER: "cat", TERM: "dumb", NO_COLOR: "1" },
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
				detached: process.platform !== "win32",
			});
			// Keep the start and the end of long output; the middle is what a person scrolls past anyway.
			const half = MAX_EXEC_OUTPUT / 2;
			let head = "";
			let tail = "";
			let omitted = 0;
			let timedOut = false;
			let closed = false;
			const take = (chunk: Buffer) => {
				const text = chunk.toString("utf8");
				if (head.length < half) {
					const room = half - head.length;
					head += text.slice(0, room);
					tail += text.slice(room);
				} else tail += text;
				if (tail.length > half) {
					omitted += tail.length - half;
					tail = tail.slice(tail.length - half);
				}
				options.onOutput?.(text);
			};
			child.stdout.on("data", take);
			child.stderr.on("data", take);
			const kill = () => {
				if (closed || !child.pid) return;
				try {
					if (process.platform === "win32") {
						// PowerShell's children aren't in its "group": end the whole tree.
						spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
						return;
					}
					// The whole process group, so a pipeline's children stop too; SIGKILL if it ignores SIGTERM.
					process.kill(-child.pid, "SIGTERM");
					setTimeout(() => {
						if (!closed) {
							try {
								process.kill(-child.pid!, "SIGKILL");
							} catch {
								// Already gone.
							}
						}
					}, 3_000).unref();
				} catch {
					child.kill("SIGKILL");
				}
			};
			const timer = setTimeout(() => {
				timedOut = true;
				kill();
			}, options.timeoutMs);
			const onAbort = () => kill();
			options.signal.addEventListener("abort", onAbort, { once: true });
			let failure = "";
			child.on("error", (error) => {
				failure = `\n${error.message}`;
			});
			child.on("close", (code) => {
				closed = true;
				clearTimeout(timer);
				options.signal.removeEventListener("abort", onAbort);
				const output = omitted ? `${head}\n[… ${omitted} characters of output omitted …]\n${tail}` : head + tail;
				done({ exitCode: code, output: output + failure, timedOut });
			});
		});
	}
}

/**
 * A path the way the system walks it: one part at a time, following each link before the next "..", so "link/.."
 * means the link target's parent, not the link's folder. Parts that don't exist yet are joined as written.
 */
export function physical(path: string, depth = 0): string {
	// A backslash separates folders on Windows only; elsewhere it's part of a name.
	const parts = path.split(process.platform === "win32" ? /[/\\]+/ : /\/+/).filter((p) => p && p !== ".");
	let at = isAbsolute(path) ? (path.match(/^[A-Za-z]:/)?.[0] ?? "") + sep : process.cwd();
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		if (part === "..") {
			at = dirname(at);
			continue;
		}
		const next = join(at, part);
		let link: string | undefined;
		try {
			if (depth < 40 && lstatSync(next).isSymbolicLink()) link = readlinkSync(next);
		} catch {
			// Not there yet: the rest is joined as written.
			return join(next, ...parts.slice(i + 1));
		}
		// Joined as text, not with join(): join would settle a ".." before the walk can follow the link before it.
		at = link === undefined ? next : physical(isAbsolute(link) ? link : `${at}${sep}${link}`, depth + 1);
	}
	return at;
}

/** The project's environment, when it has one built: its folder of programs. */
export function projectEnvironment(root: string): string | undefined {
	const prefix = join(root, ".pixi", "envs", "default");
	return existsSync(join(root, "pixi.toml")) && existsSync(join(prefix, "conda-meta")) ? prefix : undefined;
}

/** Commands run inside the project's environment: its programs first on PATH, as `pixi shell` would set. */
export function activated(root: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const prefix = projectEnvironment(root);
	if (!prefix) return env;
	const bins = process.platform === "win32" ? [prefix, join(prefix, "Library", "bin"), join(prefix, "Scripts")] : [join(prefix, "bin")];
	return { ...env, PATH: [...bins, env.PATH ?? ""].filter(Boolean).join(delimiter), CONDA_PREFIX: prefix, PIXI_PROJECT_ROOT: root, PIXI_ENVIRONMENT_NAME: "default" };
}
