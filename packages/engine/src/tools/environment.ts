// The project's own package environment (docs/apps.md, "A project's own environment"): R, Python and other tools from conda-forge (or the
// lab's vetted channels), installed with pixi into the project's .pixi folder. Nothing goes into the system or into
// another project, the install is contained, and pixi.toml with pixi.lock records exactly what is there, so step
// history can take a change back and a lab can build the same environment.

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pixi, pixiPresent } from "../apps/environments.ts";
import { type Tool, ToolError } from "./types.ts";
import { contained, physical } from "./workspace.ts";

/** Where a lab's vetted packages come from (its descriptor's `packages`). */
export interface PackageSources {
	conda?: string[];
	pypi?: string;
	only?: boolean;
}

/** conda's names for this computer's platforms. */
const CONDA_PLATFORMS: Record<string, string> = { "darwin-arm64": "osx-arm64", "darwin-x64": "osx-64", "linux-x64": "linux-64", "linux-arm64": "linux-aarch64", "win32-x64": "win-64" };

/** A new pixi.toml: the lab's channels when it names them (only them when it says so), else conda-forge. */
export function manifest(name: string, sources?: PackageSources): string {
	const channels = [...(sources?.conda ?? []), ...(sources?.only && sources.conda?.length ? [] : ["conda-forge"])];
	const here = CONDA_PLATFORMS[`${process.platform}-${process.arch}`];
	// This computer, and Linux, so a lab can build the same environment into a sandbox.
	const platforms = [...new Set([here, "linux-64"].filter(Boolean))];
	const pypi = sources?.pypi ? `\n[pypi-options]\nindex-url = ${JSON.stringify(sources.pypi)}\n` : "";
	return `[workspace]\nname = ${JSON.stringify(name)}\nchannels = ${JSON.stringify(channels)}\nplatforms = ${JSON.stringify(platforms)}\n\n[dependencies]\n${pypi}`;
}

/** Each installed package and its version, from `pixi list`. */
async function installed(program: string, root: string, env: Record<string, string>): Promise<Map<string, string>> {
	const out = await run(program, ["list", "--json", "--manifest-path", join(root, "pixi.toml")], root, env, () => undefined).catch(() => "[]");
	const list = new Map<string, string>();
	try {
		for (const p of JSON.parse(out) as { name: string; version: string }[]) list.set(p.name, p.version);
	} catch {
		// Not built yet.
	}
	return list;
}

/** Run pixi contained: it may write the project (pixi.toml, pixi.lock, .pixi) and its own caches, and reach the indexes. */
async function run(program: string, args: string[], root: string, env: Record<string, string>, log: (line: string) => void): Promise<string> {
	const caches = env.PIXI_CACHE_DIR!;
	const launch = contained(program, args, { writable: [root, caches], readable: [program], network: "all" });
	// Package install scripts never run uncontained: no facility here, no install.
	if (!launch.facility) throw new ToolError("This computer has no sandbox to contain package installs (Seatbelt on macOS, bubblewrap on Linux), so nothing was installed.");
	const child = Bun.spawn([launch.file, ...launch.args], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe", env });
	let out = "";
	let err = "";
	const read = async (stream: ReadableStream<Uint8Array>, keep: (text: string) => void) => {
		for await (const chunk of stream) {
			const text = new TextDecoder().decode(chunk);
			keep(text);
			for (const line of text.split(/\r|\n/)) if (line.trim()) log(line.trim());
		}
	};
	await Promise.all([read(child.stdout, (t) => (out += t)), read(child.stderr, (t) => (err += t)), child.exited]);
	if (child.exitCode !== 0) throw new ToolError(`pixi ${args[0]} failed:\n${(err || out).trim().split("\n").slice(-25).join("\n")}`);
	return out;
}

type Action = "list" | "add" | "remove" | "update" | "sync";

export const environmentTool: Tool<{ action: Action; packages?: string[]; pypi?: boolean; folder?: string }> = {
	name: "environment",
	description:
		"The project's own package environment (pixi): R, Python, command-line tools and libraries from conda-forge (R packages are r-<name>, e.g. r-shiny, r-ggplot2) or from PyPI (pypi: true). Use it instead of installing into the system (no brew, sudo, pip install --user or install.packages): everything goes into this project's .pixi folder, kept apart from other projects, and pixi.lock records exact versions. Shell commands then run inside it. Actions: list (what's installed), add, remove, update (newest allowed versions; name packages to update only those), sync (install what pixi.toml and pixi.lock say, e.g. after going back to an earlier step). `folder` is a subfolder with its own pixi.toml, such as an app (apps/<name>).",
	parameters: {
		type: "object",
		properties: {
			action: { type: "string", enum: ["list", "add", "remove", "update", "sync"] },
			packages: { type: "array", items: { type: "string" }, description: 'Package names, with an optional version: "r-shiny", "pandas>=2.2", "python=3.13".' },
			pypi: { type: "boolean", description: "Add from PyPI instead of conda-forge (Python packages conda-forge lacks)." },
			folder: { type: "string", description: "A subfolder with its own environment (an app's folder); the project's when absent." },
		},
		required: ["action"],
	},
	kind: "packages",
	localOnly: true,
	view: (args) => ({ verb: args.action === "list" ? "Packages" : args.action === "sync" ? "Sync packages" : `${args.action[0]!.toUpperCase()}${args.action.slice(1)} packages`, target: [args.folder, ...(args.packages ?? [])].filter(Boolean).join(" ") || "the project" }),
	touches: (args) => [join(args.folder ?? ".", "pixi.toml"), join(args.folder ?? ".", "pixi.lock")],
	async run(args, ctx) {
		if (ctx.workspace.kind !== "local") throw new ToolError("A lab's sandbox has no network: its packages come from the lab's image. Ask the lab for what's missing.");
		if (args.folder && !ctx.workspace.inside(args.folder)) throw new ToolError("The folder must be inside the project.");
		// Pinned to where the folder leads now, links followed, and kept inside the project for every step below.
		const root = physical(ctx.workspace.resolve(args.folder ?? "."));
		const pinned = () => {
			if (!ctx.workspace.inside(root) || physical(ctx.workspace.resolve(args.folder ?? ".")) !== root) throw new ToolError("The environment's folder moved outside the project (a link may have changed); nothing was installed.");
			for (const name of ["pixi.toml", "pixi.lock"]) if (lstatSync(join(root, name), { throwIfNoEntry: false })?.isSymbolicLink()) throw new ToolError(`${name} is a link; the environment's files must be the project's own.`);
		};
		pinned();
		const packages = (args.packages ?? []).map((p) => p.trim()).filter(Boolean);
		for (const p of packages) if (!/^[A-Za-z0-9][A-Za-z0-9_.\-]*(\[[A-Za-z0-9_,.\-]+\])?\s*([=<>!~]=?\s*[A-Za-z0-9_.*+!\-]+(\s*,\s*[=<>!~]=?\s*[A-Za-z0-9_.*+!\-]+)*)?$/.test(p)) throw new ToolError(`“${p}” isn't a package name with an optional version.`);
		if ((args.action === "add" || args.action === "remove") && !packages.length) throw new ToolError(`Name the packages to ${args.action}.`);
		const tools = ctx.tools ?? join(tmpdir(), "el-tools");
		// Listing reads what's there: it never downloads pixi or makes an environment.
		if (args.action === "list" && !existsSync(join(root, "pixi.toml"))) return { ok: true, content: "This project has no environment yet. Add packages to make one." };
		if (args.action === "list" && !pixiPresent(tools)) return { ok: true, content: `pixi isn't on this computer yet, so this is what pixi.toml asks for (nothing is built):\n${readFileSync(join(root, "pixi.toml"), "utf8")}` };
		const program = await pixi(tools, (line) => ctx.output(`${line}\n`));
		const caches = join(tools, "pixi-cache");
		// Made first: containment can only let the install write a folder that exists.
		mkdirSync(caches, { recursive: true });
		const env: Record<string, string> = { PIXI_NO_PATH_UPDATE: "1", PIXI_CACHE_DIR: caches, PIXI_HOME: caches };
		for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT", "SSL_CERT_FILE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) if (process.env[key]) env[key] = process.env[key]!;
		const file = join(root, "pixi.toml");
		pinned();
		const made = !existsSync(file);
		if (made) {
			if (args.action === "list" || args.action === "remove") return { ok: true, content: "This project has no environment yet. Add packages to make one." };
			writeFileSync(file, manifest(basename(root).replace(/[^A-Za-z0-9_-]/g, "-") || "project", ctx.packages));
		}
		const manifestPath = ["--manifest-path", file];
		const before = made ? new Map<string, string>() : await installed(program, root, env);
		const log = (line: string) => ctx.output(`${line}\n`);
		pinned();
		switch (args.action) {
			case "list":
				break;
			case "add":
				await run(program, ["add", ...(args.pypi ? ["--pypi"] : []), ...manifestPath, "--", ...packages], root, env, log);
				break;
			case "remove":
				await run(program, ["remove", ...(args.pypi ? ["--pypi"] : []), ...manifestPath, "--", ...packages], root, env, log);
				break;
			case "update":
				await run(program, ["update", ...manifestPath, "--", ...packages], root, env, log);
				break;
			case "sync":
				await run(program, ["install", ...manifestPath], root, env, log);
				break;
		}
		if (args.action !== "list") await run(program, ["install", ...manifestPath], root, env, log);
		const after = await installed(program, root, env);
		const sources = /channels\s*=\s*\[([^\]]*)\]/.exec(readFileSync(file, "utf8"))?.[1]?.replace(/"/g, "").trim() || "conda-forge";
		const where = args.folder ?? "the project";
		if (args.action === "list") {
			const names = [...after].map(([name, version]) => `${name} ${version}`);
			return { ok: true, content: names.length ? `${where} environment (channels: ${sources}):\n${names.join("\n")}` : `${where} has an environment with nothing installed yet.` };
		}
		const changes: string[] = [];
		for (const [name, version] of after) {
			const was = before.get(name);
			if (was === undefined) changes.push(`+ ${name} ${version}`);
			else if (was !== version) changes.push(`~ ${name} ${was} → ${version}`);
		}
		for (const [name, version] of before) if (!after.has(name)) changes.push(`- ${name} ${version}`);
		// The packages asked for first, then what came with them.
		const asked = (line: string) => packages.some((p) => line.split(" ")[1] === p.split(/[=<>!~[\s]/)[0]);
		const ordered = [...changes.filter(asked), ...changes.filter((line) => !asked(line))];
		const list = ordered.length ? `${ordered.length} package change${ordered.length === 1 ? "" : "s"}:\n${ordered.slice(0, 60).join("\n")}${ordered.length > 60 ? `\n… and ${ordered.length - 60} more` : ""}` : "Nothing changed.";
		return {
			ok: true,
			content: `${made ? `Made ${where}'s environment (pixi.toml; channels: ${sources}).\n` : ""}${list}\nShell commands in ${where} run inside this environment. pixi.lock records the exact versions; going back to before this step and running sync puts the previous versions back.`,
		};
	},
};
