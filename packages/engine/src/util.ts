import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const VERSION = "0.2.33";

/**
 * How the harness names itself to a lab. Gate files every request under the User-Agent's first word, so the lab's
 * console can show which harness versions and systems each person uses without a separate report.
 */
export const CLIENT_AGENT = `EnrichedLab/${VERSION} (${process.platform}; ${process.arch})`;

/** What changed in this version, one line each, newest first. Surfaces show the first lines when a session opens. */
export const NEWS = [
	"0.2.33: allowCommands matches one exact literal POSIX argv and runs it without a shell (off on Windows); visible pushes include POSIX bracket classes behind wrappers, while unsupported PowerShell comments, escapes and expressions ask in every mode; Windows treats iex, encoded commands, direct interpreter handoffs and those behind env, start, Start-Process, saps, timeout or xargs as pushes, including native .exe wrappers, and starts PowerShell only by an absolute OS installation path; contained macOS shell commands cannot write a .git path below the project root; Linux commands keep project writes, refuse existing .git links, bind regular entries read only and move new ones to a same-filesystem sibling quarantine verified by descriptor for owner and mode 0700; every cleanup scan is bounded, and a failed pass leaves the project in place while later contained commands and file writes refuse to run until recovery succeeds; app consent names served-backend network access and container-build network access, networkless builds use --network none and networkless container runs do not pull images; bubblewrap applies credential masks after project-derived binds, refuses binds inside a hidden path and binds only the current app's data folder by its engine-owned path after those masks; file tools reject .git paths on every platform; git_commit binds approval to the checked repository and branch, stages in engine-only scratch without project helpers, and advances only that ref; contained commands, package installs and app backends use the temp folder their sandbox grants; engine git uses a separate minimal environment, accepting caller global and system config overrides only as /dev/null; local history cleanup stays on held folders and lab removal requires its fence; read-only lab commands block io_uring and ioctl metadata paths; the lab write-mode metadata limit remains accepted; file writes refuse hard links.",
	"0.2.32: commands are read by a real shell parser, so quoted and encoded pushes ask; in a lab's sandbox, commands run under a Linux file fence that keeps their writes in the project; run packages are read and replayed with stricter isolation; going back checks where a file leads before writing. Review found gaps in each of these, closed in 0.2.33. 0.2.31's changes, which were never published, are included.",
	"0.2.31: a Timeline of every step (Window ▸ Timeline, ⌥⌘T) with why it ran, its input and output, the files it changed and who allowed it; reasoning summaries from a fast model where the session's model runs; each project gets its own package environment, so Shiny and the rest install and update apart from the system; Export Run Package carries the step history, and el session verify and reproduce check and rerun it; This Mac's local sandbox explained; many safety fixes to approvals and going back.",
	"0.2.30: no more crash when resizing the window with a plot or dashboard open; the agent asks only for what can't be undone (choose Ask, Auto or Allow All beside the model), asks once per folder, and “allow for this session” names what it covers and sticks; every step is kept, so you can go back to before any step or try again from there; the conversation follows new output; UC Davis light and dark colors.",
	"0.2.29: el lab check reads a lab's published API description (OpenAPI 3.1) where the lab offers one.",
	"0.2.28: Update Desktop works whether the desktop is running, stopping, stopped or already archived.",
	"0.2.27: a lab desktop made before the lab updated its desktop shows Update Desktop in its pane, which moves it to the current one and keeps its files; the agent names each window by its app.",
	"0.2.26: a lab desktop shows live in its pane where the lab streams it, so you see the agent and your own clicks as they happen; the agent can copy a file from its workspace sandbox onto the desktop to open it there; el lab check opens a desktop's live view.",
	"0.2.25: on a lab desktop that offers it, the agent reads the windows and their buttons and fields before it clicks, starts apps by name and brings a window forward, so it clicks the right thing the first time; el lab check reads the desktop's state and starts and focuses an app.",
	"0.2.24: a table that changes while it's open shows its new rows and columns (the Mac app could quit on a wider table); a subagent's questions reach your window even after it reconnects; on the Mac, the workbench stays open when you drag its edge wider, and a terminal whose shell had ended stays ended after a reconnect.",
	"0.2.23: on macOS, EnrichedLab is now a native Mac app (macOS 15 and later) with the same sessions, labs, models and tools, and it opens room for the workbench instead of squeezing it; the window no longer slides when something inside it scrolls; agents search all their tools by what they need and come with skills for Shiny figure apps, data analysis in R or Python, Office files, PDF forms, a lab's desktop and research at a lab; a subagent's questions reach the window showing its session.",
	"0.2.22: el lab check also checks a lab's desktop sandboxes (the picture, no shell, no address with a password) and its runs list; the lab contract adds data scopes to /v1/me.",
	"0.2.21: the Desktop pane and the agent's desktop tools work with a lab desktop as Home Lab serves it: a fresh picture after each action, and an archived desktop is restored with its files instead of replaced.",
	"0.2.20: a lab can offer a desktop sandbox that you and the agent both use, in a Desktop pane; a lab can grant Discovery mode, turned on by typing /discover, where the agent works on its own inside the lab without asking; each step's reasoning gets a short summary made where its model runs, with the full text a click away, and compaction stays there too; el session package writes a session as an RO-Crate to check or rerun; a lab that says it keeps data inside stays isolated.",
	"0.2.19: connections into a lab sandbox (a terminal, its browser, a Shiny app's live updates) no longer fail once right after your lab sign-in renews itself.",
	"0.2.18: web apps an agent runs in a lab sandbox (Shiny, dashboards) work in the browser pane: their pages reach their own server, and the agent starts the server for you, which stops after 15 unused minutes and starts again on the next visit; commands and file edits inside a lab sandbox project no longer ask each time; your lab sandbox is paused, not deleted, when EnrichedLab quits; model menus say whether a model is private (your lab, this computer) or a cloud service; the window always fills with the page.",
	"0.2.17: a task typed after choosing New Session in a lab runs there; a calmer light theme and darker dark theme; moves are reviewed the same way from everywhere and keep secret-looking files and their history at home; Stop, a failed send and a rename never lose what you typed; terminals keep running when panes move; tables and plots keep values exactly as the file has them; commands that run without asking get no keys or tokens; el session push and pull move a session to your lab's Rein and back.",
	"0.2.16: an exported session keeps every event within the shared log's size limit, so a session with a very large file or command output still imports into Gate's Rein.",
	"0.2.15: sessions export in a form Gate's Rein always imports, however long they ran (el session export), and an empty session shows its project folder short enough to read.",
	"0.2.14: a lab that binds your sign-in to this computer now gets its proof on model requests too, so your lab's models answer instead of refusing with 401; the terminal version's pickers open under the prompt with names you know, and /help reads as a table.",
	"0.2.13: the workbench stays beside the conversation down to a 720 px window (the sidebar steps aside), the window comes back on the same session with your draft after the engine restarts, tables move by arrow keys with right-click copy, filter and sort, tabs reorder by drag or Alt+arrow, an ended terminal starts again, older sessions load and search, and labs see which harness version you run.",
	"0.2.12: the window rebuilt to feel like a Mac app: a native menu bar and right-click menus everywhere, title bars you can drag, AA contrast in light and dark, and where a session runs chosen beside its model, with a review before a move; Remove Lab, Jump to Latest and per-session drafts; hiding the workbench no longer stops its terminals; Foundry Local is found on its own; sessions export and import in the log format Gate also reads (el session export); Windows signing is ready for an Azure Artifact Signing account.",
	"0.2.11: sessions started before a lab was renamed find its models again.",
	"0.2.10: the terminal inside the window draws its text everywhere; its GPU renderer could leave it blank.",
	"0.2.9: models on this computer are found by how their server answers (Ollama, LM Studio, llama.cpp, MLX, oMLX, vLLM, SGLang), and each gets the context its server holds; Ollama models get their full planned context instead of Ollama's 4K default; el local and Model services suggest open models that fit your computer and download them (el model pull); el join adds a lab from its invite; a session whose model goes away stops and says so instead of switching models.",
	"0.2.8: a file downloaded from a lab sandbox that the lab cuts short no longer stops the engine or hangs; a full disk says so instead of trying again; el lab check proves a lab's internet sandboxes refuse private addresses in every IPv6 spelling, refuse sites with broken certificates, and that the lab's browser opens public pages there; a request to a public site whose name starts like a private address (fcc.gov) no longer says it is on your network.",
	"0.2.7: the browser in a lab sandbox runs in your own sandbox, made from the lab's browser image, so it opens the apps you run there (el sandbox create <lab> --image browser); el sandbox create makes a new sandbox to work in, with internet access where the lab allows it, and no lab files go into those; el sandboxes shows why the lab ended one.",
	"0.2.6: el sandboxes lists your sandboxes at a lab, and el sandbox stop or delete frees a place; when a lab refuses a new sandbox for too many, it says which one helps; a busy lab sandbox, a download cut short, or a sandbox the lab is still deleting is retried instead of failing.",
	"0.2.5: at labs that run one, the agent can browse in a browser in your lab sandbox, which has none of your sign-ins and which you watch and use live in a pane; files leaving a lab sandbox must match what the lab's malware scanner passed; a lab agent waiting for your approval links to where you approve it.",
	"0.2.4: apps your lab offers install from the Apps menu (el app add <lab>/<name>), checked against the lab's signers; lab sandboxes stop when idle and come back on use; a new computer at a lab waits for approval from one of your others.",
	"0.2.3: in a session that works in a lab, an app's backend runs in that lab's sandbox, so the lab's data stays there.",
	"0.2.2: at labs that ask for it, requests are bound to this computer with a device key kept in the OS credential store; web apps in a lab sandbox (Shiny, Streamlit) open in the browser pane.",
	"0.2.1: el lab check tests a lab against the lab contract; lab events show as notices; lab files save into your project with their checksum checked.",
	"0.2: the terminal command is now el (el app, el run, el login); settings moved from ~/.enriched to ~/.el.",
	"Use your ChatGPT plan: Continue with ChatGPT under Model services, or el service add chatgpt.",
	"0.1.1: Windows commands write only to the project; a quieter start; fixes found by testing on all three systems.",
	"Ask for an app and the agent builds one that runs beside the session, R and Python Shiny included.",
	"The agent can use the built-in browser, where your sign-ins persist, and fill PDF forms.",
	"Add your own OpenAI, Anthropic or Gemini key, or join a lab from its invite link.",
	"Signed installers for macOS, Windows and Linux, with no administrator; updates install the same way.",
];

/** Sortable, unique enough for one person's sessions and events: time then randomness. */
export function newId(prefix = ""): string {
	const time = Date.now().toString(36).padStart(9, "0");
	return `${prefix}${time}${randomBytes(5).toString("hex")}`;
}

export const now = (): string => new Date().toISOString();

/** `~` and `~/…` mean the home folder. Nothing else is changed. */
export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) return join(homedir(), path.slice(2));
	return path;
}

export function readJson<T>(path: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

/** Write a whole file through a temporary name so a reader never sees half of it. `secret` makes it owner-only. */
export function writeFileAtomic(path: string, data: string, secret = false): void {
	mkdirSync(dirname(path), { recursive: true, mode: secret ? 0o700 : 0o755 });
	const temp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
	writeFileSync(temp, data, { mode: secret ? 0o600 : 0o644 });
	if (secret) chmodSync(temp, 0o600);
	renameSync(temp, path);
}

export const writeJson = (path: string, value: unknown, secret = false): void =>
	writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, secret);

/** Read a secret named by a file path or an environment variable, at the moment of use. */
export function readSecret(ref: { keyFile?: string; keyEnv?: string }): string | undefined {
	if (ref.keyEnv && process.env[ref.keyEnv]) return process.env[ref.keyEnv]!.trim();
	if (ref.keyFile) {
		try {
			return readFileSync(expandHome(ref.keyFile), "utf8").trim();
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/** Rough token count for text the provider hasn't counted yet. Code and prose average near 3.6 characters a token. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3.6);

export function errorText(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/** Remove anything that looks like a bearer token or key from text that may reach a log or a surface. */
export function redact(text: string): string {
	return text
		.replace(/(authorization:\s*bearer\s+)[^\s"']+/gi, "$1[redacted]")
		.replace(/\b(gate_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g, "[redacted]");
}

export function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("aborted"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});

/** A tiny typed event emitter. */
export class Emitter<T extends Record<string, unknown>> {
	private listeners = new Map<keyof T, Set<(value: never) => void>>();
	on<K extends keyof T>(name: K, listener: (value: T[K]) => void): () => void {
		let set = this.listeners.get(name);
		if (!set) this.listeners.set(name, (set = new Set()));
		set.add(listener as (value: never) => void);
		return () => set!.delete(listener as (value: never) => void);
	}
	emit<K extends keyof T>(name: K, value: T[K]): void {
		for (const listener of this.listeners.get(name) ?? []) (listener as (value: T[K]) => void)(value);
	}
}

/** File names that usually hold secrets: never uploaded to a site, never sent in a repository handoff. */
export const SECRET_NAME = /(^|[\\/])(\.env(\..*)?|.*\.pem|.*\.key|id_[a-z0-9]+|credentials(\.json)?|.*\.tfstate|\.netrc|\.npmrc|\.pypirc)$/i;

/** Environment variable names that look like they hold a credential: keys, tokens, passwords, DSNs, agent sockets. */
export const SECRET_VAR = /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|(^|_)AUTH(_|$)|AUTHORIZATION|COOKIE|_KEY$|^KEY$|(^|_)DSN$|DATABASE_URL|CONNECTION_STRING|^AWS_|^AZURE_|^GOOGLE_APPLICATION_CREDENTIALS$|^SSH_AUTH_SOCK$|^GPG_AGENT_INFO$)/i;

/** An environment without the variables that look like credentials. */
export function withoutSecrets(env: Record<string, string | undefined>): Record<string, string> {
	return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !SECRET_VAR.test(entry[0])));
}
