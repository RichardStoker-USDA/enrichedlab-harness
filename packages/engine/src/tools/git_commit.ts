// Committing the session's work: agents' own commands can't write .git, so commits go through the engine's git,
// which runs contained with hooks and signing off. In the session's own worktree it runs without asking.

import { commit } from "../git.ts";
import { str, type Tool, ToolError } from "./types.ts";

export const gitCommitTool: Tool<{ message: string }> = {
	name: "git_commit",
	kind: "write",
	localOnly: true,
	description: "Stage all changes in the project and commit them on the current branch. Use this instead of git commit in the shell, which can't write .git. In the session's own worktree it runs without asking; elsewhere it asks.",
	parameters: {
		type: "object",
		properties: { message: { type: "string", description: "An imperative subject under 80 characters, with an optional body." } },
		required: ["message"],
		additionalProperties: false,
	},
	view: (args) => ({ verb: "git commit", target: String(args.message ?? "").split("\n", 1)[0] ?? "" }),
	async run(args, ctx) {
		if (ctx.workspace.kind !== "local") throw new ToolError("git_commit works only on this computer.");
		const message = str(args, "message");
		if (!message.trim()) throw new ToolError("The commit message is empty.");
		const output = commit(ctx.workspace.root, message);
		return { ok: true, content: output || "Committed.", view: { result: output.split("\n")[0] || "committed" } };
	},
};
