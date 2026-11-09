// Starting an app's backend. Three kinds speak MCP on stdio and become a client connection: "bun" (a module on the
// Bun runtime inside EnrichedLab), "command" (any MCP server the person can run) and "container" (an MCP server in a
// container). "serve" starts a web app on a free loopback port and the page is that address.
//
// Containment: bun and command backends run under the OS sandbox (writes only to the app's data folder, credential
// folders hidden, no network unless the app was allowed origins). A serve backend gets its separately named network
// grant. A container is its own boundary: no network unless allowed, the app folder read-only, the data folder writable.
//
// In a session that works in a lab, the backend runs in that lab's sandbox instead (startInSandbox), so the lab's data
// stays inside the lab: the app's folder is copied in once per version and the process is attached (sites/attach.ts).

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { Client, type Transport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { AppToolResult } from "@enrichedlab/protocol";
import { contained, containedTempEnvironment, type NetworkAccess } from "../tools/workspace.ts";
import { VERSION } from "../util.ts";
import type { AppManifest } from "./manifest.ts";
import { hasEnvironment, inEnvironment } from "./environments.ts";
import { RUNNER_SOURCE } from "./runner.ts";
import { AttachTransport } from "../sites/attach.ts";
import { type SandboxApi, shq } from "../sites/sandbox_workspace.ts";

/**
 * A backend runs contained, or not at all: on Windows it runs as the person (its servers stall under the restricted
 * token), which the consent card says before anything starts; anywhere else without a sandbox it doesn't start.
 */
function uncontainedOk(launch: { facility?: string }): void {
	if (launch.facility || process.platform === "win32") return;
	throw new Error("This computer has no sandbox to contain the app's backend (bubblewrap on Linux, Seatbelt on macOS), so it didn't start.");
}

export interface BackendTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	/** "model" and/or "app" (MCP Apps visibility); both when unset. */
	visibility: string[];
}

export interface McpBackend {
	kind: "mcp";
	/** The process or its connection ended (a lab closes an idle attach); the host starts it again on next use. */
	readonly closed?: boolean;
	tools: BackendTool[];
	/** `project` names the calling session's project, for a backend that sessions in one lab sandbox share. */
	call(name: string, args: Record<string, unknown>, signal?: AbortSignal, project?: string): Promise<AppToolResult>;
	close(): Promise<void>;
}

export interface ServedBackend {
	kind: "serve";
	url: string;
	close(): Promise<void>;
}

export type Backend = McpBackend | ServedBackend;

export interface BackendContext {
	/** The app's folder. */
	dir: string;
	/** Its writable folder. */
	dataDir: string;
	/** The project of the session that opened it, when there is one. */
	projectDir?: string;
	/** Where the runner script is written. */
	runDir: string;
	/** Where shared tools (pixi) are kept. */
	toolsDir: string;
	/** Allow network for the backend (the app was allowed origins). */
	network: boolean;
	/** The app consent named network access for a local container build. */
	buildNetwork?: boolean;
	/** The app consent named the listening network for a local served backend. */
	serveNetwork?: boolean;
	/** Recent stderr lines, for error messages. */
	log: (line: string) => void;
	/** The lab sandbox of the session's place, when the session works in a lab. */
	sandbox?: SandboxApi;
	/** The lab keeps its data inside: the backend must run in its sandbox, never on this computer. */
	sandboxOnly?: boolean;
}

/** The container runtime the person has, if any: Docker, Podman or nerdctl on the PATH. */
export function containerRuntime(): string | undefined {
	for (const name of ["docker", "podman", "nerdctl"]) {
		const found = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" });
		if (found.status === 0 && found.stdout.trim()) return found.stdout.trim().split(/\r?\n/)[0];
	}
	return undefined;
}

/** Container-build network arguments. The app host sets `allowed` only after the consent card names this access. */
export function containerBuildNetworkArgs(allowed: boolean): string[] {
	return ["--network", allowed ? "default" : "none"];
}

/** Keep a networkless container start from asking the runtime to pull a missing image. */
export function containerPullArgs(allowed: boolean): string[] {
	return allowed ? [] : ["--pull=never"];
}

/** Network available to a local served backend after its app grant has been checked. */
export function servedBackendNetwork(declared: boolean, consented: boolean): NetworkAccess {
	if (declared) return "all";
	if (!consented) throw new Error(process.platform === "linux"
		? "A served backend on Linux needs explicit consent for the whole network because bubblewrap cannot provide loopback by itself, so it didn't start."
		: "A served backend needs explicit consent to listen on this computer's loopback, so it didn't start.");
	return process.platform === "linux" ? "all" : "loopback";
}

function runnerPath(runDir: string): string {
	const digest = createHash("sha256").update(RUNNER_SOURCE).digest("hex").slice(0, 12);
	const file = join(runDir, `app_runner_${digest}.mjs`);
	mkdirSync(runDir, { recursive: true, mode: 0o700 });
	if (!existsSync(file)) writeFileSync(file, RUNNER_SOURCE, { mode: 0o600 });
	return file;
}

function baseEnv(manifest: AppManifest, ctx: BackendContext): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "SYSTEMROOT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "R_LIBS_USER", "R_HOME"]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return containedTempEnvironment({ ...env, APP_NAME: manifest.name, APP_VERSION: manifest.version, APP_DATA_DIR: ctx.dataDir, ...(ctx.projectDir ? { PROJECT_DIR: ctx.projectDir } : {}) });
}

async function connectStdio(command: string, args: string[], env: Record<string, string>, cwd: string, ctx: BackendContext): Promise<McpBackend> {
	const transport = new StdioClientTransport({ command, args, env, cwd, stderr: "pipe" });
	const stderr = transport.stderr;
	stderr?.on("data", (chunk: Buffer) => {
		for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) ctx.log(line);
	});
	return connectTransport(transport);
}

/** The MCP `_meta` key that names the calling session's project folder. */
export const PROJECT_META = "org.enrichedlab/project";

async function connectTransport(transport: Transport): Promise<McpBackend> {
	const client = new Client({ name: "enrichedlab-app-host", version: VERSION }, { capabilities: {} });
	await client.connect(transport);
	const listed = await client.listTools();
	const tools: BackendTool[] = listed.tools.map((t) => {
		const ui = (t._meta as { ui?: { visibility?: string[] } } | undefined)?.ui;
		return { name: t.name, description: t.description ?? t.name, inputSchema: t.inputSchema as Record<string, unknown>, visibility: ui?.visibility ?? ["model", "app"] };
	});
	let closed = false;
	const ended = transport.onclose;
	transport.onclose = () => {
		closed = true;
		ended?.();
	};
	return {
		kind: "mcp",
		get closed() {
			return closed;
		},
		tools,
		async call(name, args, signal, project) {
			const result = await client.callTool({ name, arguments: args, ...(project ? { _meta: { [PROJECT_META]: project } } : {}) }, { signal, timeout: 300_000 });
			return { content: (result.content ?? []) as AppToolResult["content"], structuredContent: result.structuredContent as Record<string, unknown> | undefined, isError: result.isError === true };
		},
		close: () => client.close(),
	};
}

/** A free TCP port on loopback. */
async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

async function waitForPort(url: string, proc: ChildProcess, ms: number): Promise<void> {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (proc.exitCode !== null) throw new Error(`The app's server stopped (exit ${proc.exitCode}).`);
		try {
			await fetch(url, { signal: AbortSignal.timeout(1_000) });
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 250));
		}
	}
	throw new Error(`The app's server didn't answer at ${url} within ${Math.round(ms / 1000)} s.`);
}

function stop(proc: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		if (proc.exitCode !== null || !proc.pid) return resolve();
		proc.once("exit", () => resolve());
		try {
			if (process.platform === "win32") spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
			else process.kill(-proc.pid, "SIGTERM");
		} catch {
			proc.kill("SIGKILL");
		}
		setTimeout(() => {
			if (proc.exitCode === null) proc.kill("SIGKILL");
			resolve();
		}, 3_000).unref();
	});
}

/** Start the backend `manifest` declares. */
/** Run the backend in the lab sandbox: copy the app in (once per version), then attach to its process there. */
async function startInSandbox(manifest: AppManifest, ctx: BackendContext, lab: SandboxApi): Promise<Backend> {
	const backend = manifest.backend!;
	if (!lab.attach) throw Object.assign(new Error(`${lab.title} doesn't stream sandbox processes.`), { unsupported: true });
	if (backend.runtime === "container") throw new Error(`This app's backend is a container image, which runs on this computer. In a ${lab.title} session, give the app a command backend.`);
	const runner = backend.runtime === "bun" ? runnerPath(ctx.runDir) : undefined;
	mkdirSync(ctx.runDir, { recursive: true, mode: 0o700 });
	const packed = join(ctx.runDir, `app_${manifest.name.replace(/[^\w.-]/g, "_")}_${process.pid}.tgz`);
	const tar = spawnSync(
		"tar",
		["-czf", packed, "--exclude=.pixi", "--exclude=node_modules", "--exclude=.git", "-C", ctx.dir, ".", ...(runner ? ["-C", dirname(runner), basename(runner)] : [])],
		{ encoding: "utf8" },
	);
	if (tar.status !== 0) throw new Error(`Couldn't pack the app for ${lab.title}: ${(tar.stderr || tar.error?.message || "").trim()}`);
	const digest = createHash("sha256").update(readFileSync(packed)).digest("hex").slice(0, 16);
	const name = manifest.name.replace(/[^\w.-]/g, "_");
	let sent: { path: string };
	try {
		sent = await lab.put(packed);
	} finally {
		rmSync(packed, { force: true });
	}
	const needsBun = runner ? `command -v bun >/dev/null || exit 4; ` : "";
	const unpacked = await lab.run(
		`command -v tar >/dev/null || exit 5; set -e; D="$HOME/.el-apps/${name}"; mkdir -p "$D/data" "$D/${digest}"; tar -xzf ${shq(sent.path)} -C "$D/${digest}"; rm -f ${shq(sent.path)}; ${needsBun}printf %s "$D"`,
		120,
	);
	if (unpacked.exitCode === 5) throw new Error(`${lab.title}'s sandbox image has no tar, which copying an app into it needs. Ask the lab to add it.`);
	if (unpacked.exitCode === 4) throw new Error(`This app's backend runs on Bun, which ${lab.title}'s sandbox doesn't have. Give the app a command backend to run it there.`);
	if (unpacked.exitCode !== 0) throw new Error(`Couldn't copy the app into ${lab.title}'s sandbox: ${(unpacked.stderr || unpacked.stdout).trim().slice(0, 300)}`);
	const home = unpacked.stdout.trim();
	const workdir = `${home}/${digest}`;
	const env: Record<string, string> = { APP_NAME: manifest.name, APP_VERSION: manifest.version, APP_DATA_DIR: `${home}/data`, NO_COLOR: "1", ...(ctx.projectDir ? { PROJECT_DIR: ctx.projectDir } : {}) };
	if (hasEnvironment(ctx.dir)) ctx.log(`The sandbox has no network, so the app's own environment isn't installed there; the command runs with what ${lab.title}'s image has.`);
	switch (backend.runtime) {
		case "bun":
		case "command": {
			const argv = backend.runtime === "bun" ? ["bun", basename(runner!), backend.main] : backend.command;
			const transport = new AttachTransport(() => lab.attach!({ argv, workdir, env }), ctx.log);
			// The lab's own reason (busy, refused) beats the MCP client's "connection closed".
			return connectTransport(transport).catch((error: Error) => {
				throw transport.failure ?? error;
			});
		}
		case "serve": {
			if (!lab.openPort) throw Object.assign(new Error(`${lab.title} doesn't open sandbox ports.`), { unsupported: true });
			// One port per app version, so two versions never collide.
			const port = 20_000 + (Number.parseInt(digest.slice(0, 4), 16) % 10_000);
			const started = await lab.attach({ argv: backend.command, workdir, env: { ...env, PORT: String(port), HOST: "0.0.0.0" } });
			// A web app reads no input: close stdin at once (a lab may hold the process until stdin closes).
			started.end();
			const decoder = new TextDecoder();
			const lines = (chunk: Uint8Array) => {
				for (const line of decoder.decode(chunk).split("\n")) if (line.trim()) ctx.log(line);
			};
			started.onStdout(lines);
			started.onStderr(lines);
			let ended: string | undefined;
			started.exit.then(
				(code) => (ended = `The app's server stopped (exit ${code ?? "stopped"}).`),
				(error: Error) => (ended = error.message),
			);
			const opened = await lab.openPort(port, backend.path ?? "/");
			for (const until = Date.now() + 90_000; ; ) {
				if (ended) throw new Error(ended);
				const status = await opened.probe();
				if (status && status !== 502 && status !== 503 && status !== 504) break;
				if (Date.now() > until) throw new Error(`The app's server in ${lab.title}'s sandbox didn't answer on port ${port}.`);
				await new Promise((r) => setTimeout(r, 700));
			}
			return {
				kind: "serve",
				url: opened.url,
				close: async () => {
					started.signal("TERM");
					started.close();
				},
			};
		}
	}
}

export async function startBackend(manifest: AppManifest, ctx: BackendContext): Promise<Backend> {
	const backend = manifest.backend;
	if (!backend) throw new Error("This app has no backend.");
	if (ctx.sandbox) {
		try {
			return await startInSandbox(manifest, ctx, ctx.sandbox);
		} catch (error) {
			// A lab that can't attach yet: run here, unless the lab keeps its data inside.
			if (ctx.sandboxOnly || !(error as { unsupported?: boolean }).unsupported) throw error;
		}
	}
	mkdirSync(ctx.dataDir, { recursive: true, mode: 0o700 });
	const env = baseEnv(manifest, ctx);
	const network: NetworkAccess = ctx.network ? "all" : "none";
	const appData = { root: dirname(ctx.dataDir), current: ctx.dataDir };
	switch (backend.runtime) {
		case "bun": {
			// The compiled binary is Bun; BUN_BE_BUN makes it act as the bun command. From source, execPath is bun.
			const runner = runnerPath(ctx.runDir);
			const launch = contained(process.execPath, [runner, join(ctx.dir, backend.main)], { writable: [ctx.dataDir], readable: [runner, ctx.dir], network, server: true, appData });
			uncontainedOk(launch);
			return connectStdio(launch.file, launch.args, { ...env, BUN_BE_BUN: "1", NO_COLOR: "1" }, ctx.dir, ctx);
		}
		case "command": {
			const command = hasEnvironment(ctx.dir) ? await inEnvironment(ctx.dir, backend.command, ctx.toolsDir, ctx.log) : backend.command;
			const [program, ...args] = command;
			const launch = contained(program!, args, { writable: [ctx.dataDir, join(ctx.dir, ".pixi")], readable: [ctx.dir, ctx.toolsDir], network, server: true, appData });
			uncontainedOk(launch);
			return connectStdio(launch.file, launch.args, env, ctx.dir, ctx);
		}
		case "container": {
			const runtime = containerRuntime();
			if (!runtime) throw new Error("This app's backend runs in a container, and no container runtime (Docker, Podman, nerdctl) was found.");
			let image = backend.image;
			if (backend.build !== undefined) {
				const tag = `enrichedlab-app-${manifest.name}:${manifest.version.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
				// Async, so a long build never stalls the engine; its output goes to the app's log.
				const proc = spawn(runtime, ["build", "-q", ...containerBuildNetworkArgs(ctx.buildNetwork === true), "-t", tag, join(ctx.dir, backend.build)], { stdio: ["ignore", "pipe", "pipe"] });
				let tail = "";
				for (const stream of [proc.stdout, proc.stderr]) stream?.on("data", (chunk: Buffer) => ((tail = (tail + chunk.toString("utf8")).slice(-2_000)), ctx.log(chunk.toString("utf8").trim())));
				const code = await new Promise<number | null>((done) => proc.on("close", done));
				if (code !== 0) throw new Error(`Building the app's image failed: ${tail.trim().slice(-600)}`);
				image = tag;
			}
			const name = `enrichedlab-app-${manifest.name}-${Date.now().toString(36)}`;
			const args = [
				"run", "-i", "--rm", "--name", name,
				...containerPullArgs(ctx.network),
				"--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp",
				"--pids-limit", "512", "--memory", "4g",
				"--network", ctx.network ? "bridge" : "none",
				"-v", `${ctx.dir}:/app:ro`,
				"-v", `${ctx.dataDir}:/data`,
				"-w", "/app",
				"-e", `APP_NAME=${manifest.name}`, "-e", "APP_DATA_DIR=/data",
				image,
				...(backend.command ?? []),
			];
			const connected = await connectStdio(runtime, args, env, ctx.dir, ctx);
			// Closing the client ends the CLI; remove the container too, in case the runtime kept it.
			return { ...connected, close: async () => (await connected.close(), void spawnSync(runtime, ["rm", "-f", name], { stdio: "ignore" })) };
		}
		case "serve": {
			const port = await freePort();
			// "$PORT" in the command is the port the app serves on (it's also in the environment as PORT).
			const wanted = backend.command.map((part) => part.replaceAll("$PORT", String(port)));
			const command = hasEnvironment(ctx.dir) ? await inEnvironment(ctx.dir, wanted, ctx.toolsDir, ctx.log) : wanted;
			const [program, ...args] = command;
			// Writes go to the data folder (and the environment's own cache), so history files don't touch the app's
			// folder and its reload.
			const launch = contained(program!, args, { writable: [ctx.dataDir, join(ctx.dir, ".pixi")], readable: [ctx.dir, ctx.toolsDir], network: servedBackendNetwork(ctx.network, ctx.serveNetwork === true), server: true, appData });
			uncontainedOk(launch);
			const proc = spawn(launch.file, launch.args, { cwd: ctx.dir, env: { ...env, PORT: String(port), HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
			for (const stream of [proc.stdout, proc.stderr]) stream?.on("data", (chunk: Buffer) => chunk.toString("utf8").split("\n").forEach((line) => line.trim() && ctx.log(line)));
			const url = `http://127.0.0.1:${port}${backend.path ?? "/"}`;
			try {
				await waitForPort(url, proc, 90_000);
			} catch (error) {
				await stop(proc);
				throw error;
			}
			return { kind: "serve", url, close: () => stop(proc) };
		}
	}
}
