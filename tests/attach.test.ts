// Processes in a lab sandbox over attach, and app backends that run there. The local lab here starts each attached
// process on this computer, so the frames, the MCP transport over them, and a backend copied into a stand-in sandbox
// folder are all exercised for real.

import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Subprocess } from "bun";
import { startBackend } from "../packages/engine/src/apps/backends.ts";
import { AppHost } from "../packages/engine/src/apps/host.ts";
import { paths } from "../packages/engine/src/paths.ts";
import type { Workspace } from "../packages/engine/src/tools/workspace.ts";
import type { AppManifest } from "../packages/engine/src/apps/manifest.ts";
import { attachSocket, retryingAttach } from "../packages/engine/src/sites/attach.ts";
import { GateSite } from "../packages/engine/src/sites/gate.ts";
import type { SandboxApi } from "../packages/engine/src/sites/sandbox_workspace.ts";

type Proc = Subprocess<"pipe", "pipe", "pipe">;
let busyOnce = 0;

const lab = Bun.serve<{ proc?: Proc }, never>({
	port: 0,
	hostname: "127.0.0.1",
	fetch(request, srv): Response | undefined {
		const url = new URL(request.url);
		if (request.headers.get("authorization") !== "Bearer test") return new Response("", { status: 401 });
		if (url.pathname === "/.well-known/enrichedlab-lab") return Response.json({ contract: "2026-11", name: "devlab", title: "Dev Lab", endpoints: { containers: true, attach: true }, sign_in: { kind: "key" } });
		if (url.pathname === "/v1/me") return Response.json({ subject: "u_1", handle: "pat", memberships: [] });
		if (url.pathname === "/v1/models") return Response.json({ data: [] });
		if (url.pathname === "/v1/containers/c1") return Response.json({ id: "c1", status: "running" });
		if (url.pathname === "/v1/containers/c1/attach") return srv.upgrade(request, { data: {} }) ? undefined : new Response("", { status: 400 });
		return new Response("", { status: 404 });
	},
	websocket: {
		message(ws, raw) {
			const frame = JSON.parse(String(raw)) as { argv?: string[]; workdir?: string; env?: Record<string, string>; stdin?: string; eof?: boolean; signal?: string };
			if (!ws.data.proc && (frame.argv?.[0] === "busy" || (frame.argv?.[0] === "busy-once" && busyOnce++ === 0))) {
				ws.send(JSON.stringify({ error: { code: "busy", message: "no free command slots" } }));
				ws.close();
				return;
			}
			if (!ws.data.proc) {
				const argv = frame.argv![0] === "busy-once" ? frame.argv!.slice(1) : frame.argv!;
				const proc = Bun.spawn(argv, { cwd: frame.workdir, env: { ...process.env, ...frame.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
				ws.data.proc = proc;
				const pump = async (stream: ReadableStream<Uint8Array>, name: string) => {
					for await (const chunk of stream) ws.send(JSON.stringify({ [name]: Buffer.from(chunk).toString("base64") }));
				};
				const pumped = Promise.all([pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr")]);
				void proc.exited.then(async (code) => {
					await pumped;
					ws.send(JSON.stringify({ exit_code: proc.signalCode ? null : code }));
					ws.close();
				});
				return;
			}
			const proc = ws.data.proc;
			if (frame.stdin) {
				proc.stdin.write(Buffer.from(frame.stdin, "base64"));
				void proc.stdin.flush();
			}
			if (frame.eof) void proc.stdin.end();
			if (frame.signal) proc.kill(frame.signal === "KILL" ? "SIGKILL" : "SIGTERM");
		},
		close(ws) {
			ws.data.proc?.kill();
		},
	},
});
const box = mkdtempSync(join(tmpdir(), "el-attach-"));
afterAll(() => {
	lab.stop(true);
	rmSync(box, { recursive: true, force: true });
});
const base = `http://127.0.0.1:${lab.port}`;
const attachUrl = `ws://127.0.0.1:${lab.port}/v1/containers/c1/attach`;
const site = new GateSite({ name: "devlab", url: base, kind: "gate" }, { base, via: "key", headers: async () => ({ authorization: "Bearer test" }) }, "c1");
const text = (chunks: Uint8Array[]) => new TextDecoder().decode(Buffer.concat(chunks));

describe("attach", () => {
	test("stdin goes in, stdout and stderr come back, and the exit code ends it", async () => {
		await site.connect();
		const script = "let s='';for await (const c of process.stdin) s+=c; console.log('got:'+s.trim()); console.error('note'); process.exit(3);";
		const process_ = await site.attach({ argv: [process.execPath, "-e", script] });
		const out: Uint8Array[] = [];
		const err: Uint8Array[] = [];
		process_.onStdout((c) => out.push(c));
		process_.onStderr((c) => err.push(c));
		process_.write("hello\n");
		process_.end();
		expect(await process_.exit).toBe(3);
		expect([text(out).trim(), text(err).trim()]).toEqual(["got:hello", "note"]);
	});

	test("a command the lab answers busy before it starts is opened again, with the input sent so far", async () => {
		const script = "let s='';for await (const c of process.stdin) s+=c; console.log('got:'+s.trim());";
		let opens = 0;
		const process_ = await retryingAttach(() => (opens++, attachSocket(attachUrl, { authorization: "Bearer test" }, { argv: ["busy-once", process.execPath, "-e", script] })), undefined, [10]);
		const out: Uint8Array[] = [];
		process_.onStdout((c) => out.push(c));
		process_.write("hello\n");
		process_.end();
		expect(await process_.exit).toBe(0);
		expect([opens, text(out).trim()]).toEqual([2, "got:hello"]);
		// A lab that stays busy: its answer stands once the waits run out.
		const full = await retryingAttach(() => attachSocket(attachUrl, { authorization: "Bearer test" }, { argv: ["busy"] }), undefined, [10, 10]);
		// Awaited directly: on Windows, Bun 1.4.3 crashes when expect().rejects waits on a promise a WebSocket close
		// settles through another promise (oven-sh/bun#44025).
		const why = await full.exit.then(
			() => "",
			(error: Error) => error.message,
		);
		expect(why).toContain("Close an app there, or try again in a minute.");
	});

	test("a signal stops the process and the exit code is null", async () => {
		const process_ = await attachSocket(attachUrl, { authorization: "Bearer test" }, { argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"] });
		process_.signal("TERM");
		expect(await process_.exit).toBeNull();
	});
});

// The stand-in sandbox: commands run under sh with their own HOME, files are copied into the box, processes attach
// through the lab above. sh and tar make this macOS and Linux only.
const home = join(box, "home");
mkdirSync(home, { recursive: true });
const sandbox: SandboxApi = {
	title: "Dev Lab",
	run: async (command) => {
		const r = Bun.spawnSync(["sh", "-c", command], { env: { ...process.env, HOME: home } });
		return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString(), timedOut: false };
	},
	put: async (path) => {
		const to = join(box, basename(path));
		copyFileSync(path, to);
		return { path: to, bytes: statSync(to).size };
	},
	get: async () => {
		throw new Error("unused");
	},
	attach: (spec) => attachSocket(attachUrl, { authorization: "Bearer test" }, { ...spec, env: { ...spec.env, PATH: `${join(process.execPath, "..")}:${process.env.PATH}`, HOME: home } }),
};

describe.skipIf(process.platform === "win32")("app backends in a lab sandbox", () => {
	test("an MCP backend is copied into the sandbox and answers from there", async () => {
		const app = join(box, "yield_app");
		mkdirSync(app, { recursive: true });
		writeFileSync(
			join(app, "backend.ts"),
			`export const tools = { where: { description: "Where it runs", async run(_args, app) { return "data at " + app.dataDir; } }, quit: { description: "Stop", async run() { setTimeout(() => process.exit(0), 50); return "bye"; } }, project: { description: "Project", async run(_args, app) { return String(app.projectDir); } } };\n`,
		);
		const manifest = { name: "yield_app", version: "1.0.0", backend: { runtime: "bun", main: "backend.ts" } } as unknown as AppManifest;
		const lines: string[] = [];
		const backend = await startBackend(manifest, { dir: app, dataDir: join(box, "local_data"), runDir: join(box, "run"), toolsDir: join(box, "tools"), network: false, log: (l) => lines.push(l), sandbox, sandboxOnly: true });
		if (backend.kind !== "mcp") throw new Error("expected an MCP backend");
		expect(backend.tools.map((t) => t.name)).toEqual(["where", "quit", "project"]);
		// One backend serves every session in the lab: each call names its session's project.
		expect((await backend.call("project", {}, undefined, "/sandbox/work/trial-a1")).content[0]).toEqual({ type: "text", text: "/sandbox/work/trial-a1" });
		expect((await backend.call("project", {}, undefined, "/sandbox/work/soil-b2")).content[0]).toEqual({ type: "text", text: "/sandbox/work/soil-b2" });
		const result = await backend.call("where", {});
		expect(result.content[0]).toEqual({ type: "text", text: `data at ${home}/.el-apps/yield_app/data` });
		// A process that ends (or a lab closing an idle connection) shows as closed, so the host starts it again.
		expect(backend.closed).toBe(false);
		await backend.call("quit", {});
		for (let i = 0; i < 60 && !backend.closed; i++) await Bun.sleep(50);
		expect(backend.closed).toBe(true);
		await backend.close();
	});

	test("a web app backend starts in the sandbox, answers on its port, and stops on close", async () => {
		const app = join(box, "plots_app");
		mkdirSync(app, { recursive: true });
		const manifest = {
			name: "plots_app",
			version: "1.0.0",
			backend: { runtime: "serve", command: [process.execPath, "-e", "Bun.serve({ port: Number(process.env.PORT), hostname: '127.0.0.1', fetch: () => new Response('served') })"] },
		} as unknown as AppManifest;
		let port = 0;
		const withPorts: SandboxApi = {
			...sandbox,
			openPort: async (p) => {
				port = p;
				const origin = `http://127.0.0.1:${p}`;
				return { url: `${origin}/`, origin, probe: () => fetch(`${origin}/`).then((r) => r.status, () => 0), serve: async () => undefined, close: () => undefined };
			},
		};
		const backend = await startBackend(manifest, { dir: app, dataDir: join(box, "local_data"), runDir: join(box, "run"), toolsDir: join(box, "tools"), network: false, log: () => undefined, sandbox: withPorts });
		if (backend.kind !== "serve") throw new Error("expected a served backend");
		expect(port).toBeGreaterThanOrEqual(20_000);
		expect(await (await fetch(backend.url)).text()).toBe("served");
		await backend.close();
		for (let i = 0; i < 50 && (await fetch(backend.url).then(() => true, () => false)); i++) await Bun.sleep(50);
		expect(await fetch(backend.url).then(() => "up", () => "down")).toBe("down");
	});

	test("sessions in the same lab share one backend per app, and each call sees its own project", async () => {
		const kit = join(box, "labkit");
		const app = join(kit, "apps", "shared");
		mkdirSync(app, { recursive: true });
		writeFileSync(join(app, "app.json"), JSON.stringify({ name: "shared", title: "Shared", version: "1.0.0", description: "", entry: "index.html", backend: { runtime: "bun", main: "backend.ts" }, permissions: {} }));
		writeFileSync(join(app, "index.html"), "<p>shared</p>");
		writeFileSync(join(app, "backend.ts"), `export const tools = { project: { description: "Project", async run(_args, app) { return String(app.projectDir); } } };\n`);
		let attaches = 0;
		const counted: SandboxApi = { ...sandbox, attach: (spec, signal) => (attaches++, sandbox.attach!(spec, signal)) };
		const session = (root: string) => ({ project: root, workspace: { root } as Workspace, place: "devlab", sealed: false, prompt: () => undefined, context: () => undefined, ask: async () => "" });
		const sessions: Record<string, ReturnType<typeof session>> = { s1: session("/sandbox/work/trial-a1"), s2: session("/sandbox/work/soil-b2") };
		const p = paths(join(box, "el_home"));
		mkdirSync(p.run, { recursive: true });
		const apps = new AppHost({ paths: p, emit: () => undefined, session: (id) => sessions[id], sandbox: () => counted, isolated: () => false, bundles: () => [{ name: "labkit", dir: kit }], origin: () => "http://127.0.0.1:9" });
		const first = await apps.open({ sessionId: "s1", id: "labkit.shared" });
		if (!first.app.granted) apps.grant(first.app.id, true);
		const one = await apps.open({ sessionId: "s1", id: "labkit.shared" });
		const two = await apps.open({ sessionId: "s2", id: "labkit.shared" });
		expect((await apps.call(one.token, "project", {}, AbortSignal.timeout(30_000))).content[0]).toEqual({ type: "text", text: "/sandbox/work/trial-a1" });
		expect((await apps.call(two.token, "project", {}, AbortSignal.timeout(30_000))).content[0]).toEqual({ type: "text", text: "/sandbox/work/soil-b2" });
		expect(attaches).toBe(1);
		await apps.stop();
	}, 60_000);

	test("a full lab says so instead of a closed connection", async () => {
		const app = join(box, "busy_app");
		mkdirSync(app, { recursive: true });
		const manifest = { name: "busy_app", version: "1.0.0", backend: { runtime: "command", command: ["busy"] } } as unknown as AppManifest;
		await expect(startBackend(manifest, { dir: app, dataDir: join(box, "busy_data"), runDir: join(box, "run"), toolsDir: join(box, "tools"), network: false, log: () => undefined, sandbox, sandboxOnly: true })).rejects.toThrow(
			"as many attached processes as it allows",
		);
	});

	test("a lab that can't attach falls back to this computer unless it keeps its data inside", async () => {
		const app = join(box, "plain_app");
		mkdirSync(app, { recursive: true });
		writeFileSync(join(app, "backend.ts"), `export const tools = { ping: { description: "ping", async run() { return "pong"; } } };\n`);
		const manifest = { name: "plain_app", version: "1.0.0", backend: { runtime: "bun", main: "backend.ts" } } as unknown as AppManifest;
		const noAttach: SandboxApi = { ...sandbox, attach: undefined };
		// Laid out as the engine lays it out: <home>/app-data/<app>.
		const ctx = { dir: app, dataDir: join(box, "app-data", "plain_app"), runDir: join(box, "run"), toolsDir: join(box, "tools"), network: false, log: () => undefined, sandbox: noAttach };
		await expect(startBackend(manifest, { ...ctx, sandboxOnly: true })).rejects.toThrow("doesn't stream sandbox processes");
		const local = await startBackend(manifest, ctx);
		if (local.kind !== "mcp") throw new Error("expected an MCP backend");
		expect((await local.call("ping", {})).content[0]).toEqual({ type: "text", text: "pong" });
		await local.close();
	});
});
