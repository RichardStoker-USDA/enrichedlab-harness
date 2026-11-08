// The system prompt, written once when a session starts and kept for its life so prompt caches stay valid.
// Instructions come from AGENTS.md files only: the person's global ones from config, then the project's from the
// repository root down to the working folder.

import { existsSync, readFileSync } from "node:fs";
import { release } from "node:os";
import { dirname, join, parse } from "node:path";
import { expandHome } from "./util.ts";

const INSTRUCTION_MAX = 40_000;

function osName(): string {
	if (process.platform === "darwin") return `macOS (Darwin ${release()})`;
	if (process.platform === "win32") return `Windows (${release()})`;
	return `Linux (${release()})`;
}

/** The repository root above `cwd`, or `cwd` itself outside a repository. */
export function projectRoot(cwd: string): string {
	return gitRoot(cwd) ?? cwd;
}

function gitRoot(cwd: string): string | undefined {
	let dir = cwd;
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function readInstruction(path: string): string | undefined {
	try {
		const text = readFileSync(path, "utf8").trim();
		return text ? text.slice(0, INSTRUCTION_MAX) : undefined;
	} catch {
		return undefined;
	}
}

/** AGENTS.md from the repository root (or the folder itself outside a repository) down to cwd. An
 * AGENTS.override.md in a folder takes that folder's place. */
export function projectInstructionFiles(cwd: string): string[] {
	const root = gitRoot(cwd) ?? cwd;
	const chain: string[] = [];
	let dir = cwd;
	while (true) {
		chain.unshift(dir);
		if (dir === root || dir === parse(dir).root) break;
		dir = dirname(dir);
	}
	const files: string[] = [];
	for (const folder of chain) {
		const override = join(folder, "AGENTS.override.md");
		const normal = join(folder, "AGENTS.md");
		if (existsSync(override)) files.push(override);
		else if (existsSync(normal)) files.push(normal);
	}
	return files;
}

export interface PromptInput {
	cwd: string;
	shell: string;
	workspaceLabel: string;
	globalInstructions: string[];
	sites: string[];
	/** Set for a subagent: how much it may do. */
	subagent?: "read" | "full";
	/** Skills the model can load with the skill tool. */
	skills?: { name: string; description: string }[];
	/** Set when the session works in its own git worktree. */
	worktree?: { branch: string; repo: string };
	/** Notes saved with remember in earlier sessions in this project. */
	notes?: string;
}

export function systemPrompt(input: PromptInput): string {
	const date = new Date().toLocaleDateString("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const root = gitRoot(input.cwd);
	const lines = [
		`You are the agent in EnrichedLab, an agent harness. You work with one person on their tasks: code, research, data and everyday work. You act through tools, and the person watches each step from a terminal, a desktop window or a browser.`,
		"",
		"# Environment",
		`- Date: ${date} (${zone})`,
		`- System: ${osName()}, ${process.arch}; shell: ${input.shell}`,
		`- Working folder: ${input.cwd}${root ? ` (git repository at ${root})` : ""}`,
		`- Tools act on: ${input.workspaceLabel}`,
	];
	if (input.sites.length) lines.push(`- Signed-in sites: ${input.sites.join("; ")}`);
	lines.push(
		"",
		"# How to work",
		"- Read before you change anything. Prefer edit for changes to existing files; use write for new files.",
		"- Shell commands already run in the working folder; don't cd into it. Use paths relative to it.",
		"- Keep changes to what was asked. Match the project's existing style.",
		"- Check your work by running the project's tests or the command that proves it. Say plainly what passed, what failed and what you did not check.",
		"- When a step needs the person (a decision that changes the result, credentials, physical action), ask once, clearly. Otherwise make a reasonable choice, say what you chose, and continue.",
		"- Use plan for work with several steps, and keep it current.",
		"- Use show for anything better seen than read: charts, tables, previews, diagrams, small interactive tools. Update a view by passing its id.",
		"- Long outputs come back clipped with a handle; earlier large outputs may be elided to save context. recall with the handle returns the exact text.",
		"- Never print secrets. Refer to credentials by their file path.",
		`- Packages: on this computer, add R, Python and command-line tools with environment, into this project's own environment (pixi; R packages are r-<name>), and shell commands run inside it. Don't install into the system or another project (brew, sudo, pip install --user, install.packages). In a lab's sandbox, use what the lab's image has, and say what's missing.${existsSync(join(input.cwd, "pixi.toml")) ? " This project already has an environment (pixi.toml): list it before assuming a package is missing." : ""}`,
		"- Write answers in plain, direct language. Lead with the result.",
		"- When you learn something durable about this project or how the person works (how to build or test it, a convention, a correction), save one line with remember. After a multi-step task they are likely to repeat, offer to save it as a skill.",
	);
	if (root || input.worktree) {
		lines.push(
			"",
			"# Git",
			"- Commit messages: one imperative subject line under 80 characters, a body only when the diff doesn't explain itself. No AI attribution, co-author or \"generated with\" lines.",
			"- Never push, force-push, rebase or merge into a branch you didn't create unless the person asks. Undo restores the working tree, so don't stash or reset to get back to a clean state.",
		);
		if (input.worktree)
			lines.push(
				`- You work in your own worktree on branch ${input.worktree.branch}; the person's checkout at ${input.worktree.repo} is untouched. Commit here when a piece of work is done and tested; the person merges the branch.`,
			);
	}
	if (input.notes?.trim()) lines.push("", "# Notes from earlier sessions in this project", "", input.notes.trim());
	const blocks: string[] = [];
	for (const path of input.globalInstructions) {
		const text = readInstruction(expandHome(path));
		if (text) blocks.push(`## ${path}\n\n${text}`);
	}
	for (const path of projectInstructionFiles(input.cwd)) {
		const text = readInstruction(path);
		if (text) blocks.push(`## ${path}\n\n${text}`);
	}
	if (blocks.length) {
		lines.push("", "# Instructions", "These come from the person's AGENTS.md files. Later files are more specific and take precedence.", "", blocks.join("\n\n"));
	}
	if (input.skills?.length) {
		lines.push("", "# Skills", "Load one with the skill tool when a task matches its description.");
		for (const s of input.skills) lines.push(`- ${s.name}: ${s.description}`);
	}
	if (input.subagent) {
		lines.push(
			"",
			"# You are a subagent",
			"Another agent started you on one task and reads only your final answer. Work the task to the end without asking questions, then answer with what you found or did: results, file paths with line numbers, commands and their outcomes, and anything you couldn't finish and why.",
			input.subagent === "read"
				? "You work read-only: reading, searching and read-only commands run; anything that would change files or need the person's permission is refused. Say in your answer what should change instead of trying."
				: "You may change files; changes ask the person for permission the same way the lead's do.",
		);
	}
	return lines.join("\n");
}
