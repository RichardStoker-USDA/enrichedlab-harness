// The desktop window against a lab on this computer: a stand-in lab with a scripted model and a sandbox, a source
// engine on a throwaway home, and a git project with sessions in both places. For seeing every surface while
// changing it, and for checking the flows that cross between places.
//
//   bun scripts/dev_lab.ts --open            open the app on it, until the window closes
//   bun scripts/dev_lab.ts --shots <folder>  capture each scene in light and dark, and check the flows
//
// Development only. The stand-in sandbox is a temporary folder (its /sandbox paths are rewritten to it) and its
// commands run on this computer: the scripted model only asks for `uname`, `git log` and `ls`. Everything it makes is
// removed when it stops. Build the window first (bun run build:web): the source engine serves packages/web/dist.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import type { ServerWebSocket } from "bun";
import { EngineClient, findEngine } from "../packages/engine/src/index.ts";

const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const shotsAt = args.includes("--shots") ? resolve(args[args.indexOf("--shots") + 1] ?? join(root, "dist", "shots")) : undefined;
const only = args.includes("--scene") ? args[args.indexOf("--scene") + 1] : undefined;
/** --mac: the native macOS app (apps/macos, debug build) instead of the Electron window. */
const nativeMac = args.includes("--mac");
const work = mkdtempSync(join(tmpdir(), "el-dev-lab-"));
const home = join(work, "home");
const sandbox = join(work, "sandbox");
const project = join(work, "project");
const KEY = "dev-lab-key";

// ── The stand-in lab ─────────────────────────────────────────────────────────────────────────────────────────────

const toHost = (s: string) => s.replaceAll("/sandbox", sandbox);
const toLab = (s: string) => s.replaceAll(sandbox, "/sandbox");
const ANSWER = [
	"Both commands ran.",
	"",
	"| Check | Output |",
	"|---|---|",
	"| `uname -s` | the system's name |",
	"| `git log -1` | the commit that came along |",
	"",
	"The project has a **README** and one commit. Next I'd add a `tests/` folder:",
	"",
	"```sh",
	"mkdir -p tests && touch tests/test_basic.py",
	"```",
].join("\n");

type ChatBody = { messages: { role: string }[]; tools?: unknown[] };
function stream(chunks: unknown[]): Response {
	return new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}
const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });
const usage = (input: number, output: number) => ({ choices: [], usage: { prompt_tokens: input, completion_tokens: output } });

/** Chunks sent at a model's pace (about `perSecond`), as a real model streams a long tool call. */
function paced(chunks: unknown[], perSecond: number): Response {
	const encoder = new TextEncoder();
	let i = 0;
	const body = new ReadableStream({
		async pull(controller) {
			if (i >= chunks.length) {
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				return controller.close();
			}
			controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunks[i++])}\n\n`));
			await Bun.sleep(1000 / perSecond);
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** A long page written as one tool call: about 30 KB of arguments, a few characters per chunk. */
function bigWrite(): Response {
	const page = `<!doctype html>\n<title>Dashboard</title>\n${Array.from({ length: 600 }, (_, i) => `<div class="row" data-i="${i}">row ${i}</div>`).join("\n")}\n`;
	const args = JSON.stringify({ path: "dashboard.html", content: page });
	const id = `call_${Date.now()}`;
	const pieces = args.match(/[\s\S]{1,12}/g)!;
	return paced(
		[
			delta({ content: "Writing the page now." }),
			delta({ tool_calls: [{ index: 0, id, type: "function", function: { name: "write", arguments: "" } }] }),
			...pieces.map((part) => delta({ tool_calls: [{ index: 0, function: { arguments: part } }] })),
			delta({}, "tool_calls"),
			usage(2000, pieces.length),
		],
		150,
	);
}

/** A request for commands runs one; the command's result gets the answer; a request without tools is the naming one. */
function reply(body: ChatBody): Response {
	if (!body.tools?.length) return stream([delta({ content: "Project check" }), delta({}, "stop"), usage(40, 3)]);
	const last = body.messages.at(-1) as { role: string; content?: unknown };
	if (last?.role === "user" && JSON.stringify(last.content ?? "").includes("big page")) return bigWrite();
	// A long turn, like a real analysis: a dozen commands with output and thinking between, then a long answer.
	const asked = [...body.messages].reverse().find((m) => m.role === "user") as { content?: unknown } | undefined;
	if (JSON.stringify(asked?.content ?? "").includes("long analysis")) {
		const rounds = body.messages.filter((m) => m.role === "tool").length;
		if (rounds < 12) {
			const call = { index: 0, id: `call_${Date.now()}_${rounds}`, type: "function", function: { name: "shell", arguments: JSON.stringify({ command: `ls -la; echo "pass ${rounds + 1} of 12"` }) } };
			return paced([delta({ reasoning_content: `Pass ${rounds + 1}: checking the folder again before the next step. `.repeat(6) }), delta({ content: `Pass ${rounds + 1}: looking at the files.\n\n${"The soil moisture readings line up with the field notes. ".repeat(8)}` }), delta({ tool_calls: [call] }), delta({}, "tool_calls"), usage(1500, 80)], 40);
		}
		return paced([...`## Findings\n\n${Array.from({ length: 30 }, (_, i) => `${i + 1}. Plot ${i + 1} kept its moisture within the expected band across the season, with one dry week in August.`).join("\n")}\n`.match(/[\s\S]{1,60}/g)!.map((part) => delta({ content: part })), delta({}, "stop"), usage(3000, 900)], 60);
	}
	if (body.messages.at(-1)?.role === "user") {
		const call = { index: 0, id: `call_${Date.now()}`, type: "function", function: { name: "shell", arguments: JSON.stringify({ command: "uname -s; git log --oneline -1; ls" }) } };
		return stream([delta({ reasoning_content: "The person wants commands run in the project; the shell tool does that." }), delta({ content: "I'll run that in the project." }), delta({ tool_calls: [call] }), delta({}, "tool_calls"), usage(1200, 40)]);
	}
	return stream([...ANSWER.match(/[\s\S]{1,40}/g)!.map((part) => delta({ content: part })), delta({}, "stop"), usage(1500, 120)]);
}

function mcp(message: { id?: number; method: string }): Response {
	if (message.id === undefined) return new Response(null, { status: 202 });
	const tool = { name: "datasets_search", description: "Search the lab's datasets by keyword.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, annotations: { readOnlyHint: true } };
	const result =
		message.method === "initialize"
			? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "devlab", version: "1" } }
			: message.method === "tools/list"
				? { tools: [tool] }
				: message.method === "tools/call"
					? { content: [{ type: "text", text: "3 datasets: soil_moisture_2026, canopy_temp, yield_trials" }] }
					: {};
	return Response.json({ jsonrpc: "2.0", id: message.id, result });
}

function listFiles(): { id: string; path: string; bytes: number }[] {
	const found: { id: string; path: string; bytes: number }[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			const info = statSync(full);
			if (info.isDirectory()) walk(full);
			else found.push({ id: Buffer.from(toLab(full)).toString("base64url"), path: toLab(full), bytes: info.size });
		}
	};
	walk(join(sandbox, "work"));
	return found;
}

mkdirSync(join(sandbox, "work"), { recursive: true });
// ── A picture of the stand-in desktop: a panel, a window and a marker where the last click went ────────────────

const DESK = { width: 1280, height: 800 };
let lastClick: [number, number] | undefined;
let typedChars = 0;
function crc32(bytes: Uint8Array): number {
	let c = ~0;
	for (const b of bytes) {
		c ^= b;
		for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
	}
	return ~c >>> 0;
}
function desktopPng(): string {
	const { width, height } = DESK;
	const px = Buffer.alloc(width * height * 3);
	const rect = (x0: number, y0: number, w: number, h: number, [r, g, b]: [number, number, number]) => {
		for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) px.set([r, g, b], (y * width + x) * 3);
	};
	rect(0, 0, width, height, [44, 62, 80]);
	rect(0, 0, width, 28, [24, 28, 34]);
	rect(160, 90, 900, 560, [246, 247, 249]);
	rect(160, 90, 900, 34, [222, 226, 232]);
	for (let i = 0; i < 9; i++) rect(196, 160 + i * 34, 520 + ((i * 97) % 300), 12, [205, 211, 219]);
	rect(196, 520, 420, 36, [255, 255, 255]);
	for (let i = 0; i < Math.min(typedChars, 40); i++) rect(204 + i * 10, 532, 7, 12, [40, 40, 40]);
	if (lastClick) rect(lastClick[0] - 6, lastClick[1] - 6, 12, 12, [255, 191, 0]);
	const raw = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y++) px.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
	const chunk = (type: string, data: Buffer) => {
		const out = Buffer.alloc(12 + data.length);
		out.writeUInt32BE(data.length, 0);
		out.write(type, 4, "ascii");
		data.copy(out, 8);
		out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
		return out;
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

/** The stand-in desktop's live view (gate.desktop.v1): the whole screen as one band when it opens and after each action. */
const watching = new Set<ServerWebSocket<unknown>>();
function sendScreen(ws: ServerWebSocket<unknown>): void {
	const head = Buffer.alloc(8);
	head.writeUInt16BE(0, 0);
	head.writeUInt16BE(0, 2);
	head.writeUInt16BE(DESK.width, 4);
	head.writeUInt16BE(DESK.height, 6);
	// A PNG where Gate sends JPEG: the windows decode by content.
	ws.send(Buffer.concat([head, Buffer.from(desktopPng(), "base64")]));
}

const lab = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	websocket: {
		open(ws) {
			watching.add(ws);
			ws.send(JSON.stringify({ type: "hello", width: DESK.width, height: DESK.height, format: "jpeg-stripes", input: true, seq_ack: true, max_fps: 15 }));
			sendScreen(ws);
		},
		close(ws) {
			watching.delete(ws);
		},
		message() {},
	},
	async fetch(request, server) {
		const path = new URL(request.url).pathname;
		if (request.headers.get("authorization") !== `Bearer ${KEY}`) return new Response("", { status: 401 });
		if (path === "/v1/containers/d1/desktop/stream") {
			const asked = (request.headers.get("sec-websocket-protocol") ?? "").split(/,\s*/);
			if (!asked.includes("gate.desktop.v1")) return Response.json({ error: { code: "invalid_request", message: "subprotocol gate.desktop.v1" } }, { status: 400 });
			return server.upgrade(request, { headers: { "sec-websocket-protocol": "gate.desktop.v1" } }) ? undefined : new Response("", { status: 500 });
		}
		if (path === "/v1/chat/completions" && request.method === "POST") {
			await Bun.sleep(300);
			return reply((await request.json()) as ChatBody);
		}
		if (path === "/mcp") return request.method === "POST" ? mcp((await request.json()) as { id?: number; method: string }) : new Response("", { status: 405 });
		if (path === "/.well-known/enrichedlab-lab") {
			return Response.json({ contract: "2026-11", name: "devlab", title: "Field Lab", endpoints: { models: true, containers: true }, sign_in: { kind: "cloudflare-access-oauth" }, policy: { keep_data_inside: false }, sandbox_networks: [{ name: "none", title: "No network" }], sandbox_desktop: { image: "desktop", screen: DESK, actions: ["screenshot", "left_click", "right_click", "double_click", "left_click_drag", "type", "key", "scroll"], open: true, stream: true } });
		}
		if (path === "/v1/me") return Response.json({ subject: "u_dev", handle: "pat", memberships: [{ lab: "devlab", research_group: null, roles: ["member"] }], policy: { keep_data_inside: false }, sandbox_networks: ["none"], sandboxes: { enabled: true }, capabilities: ["discovery"] });
		if (path === "/v1/models") return Response.json({ data: [{ id: "field-coder", gate: { context: 131072, capabilities: ["reasoning", "tools"], efforts: ["low", "medium", "high"] } }] });
		if (path === "/v1/containers" && request.method === "POST") {
			const body = (await request.json()) as { image?: string };
			return Response.json(body.image === "desktop" ? { id: "d1", status: "running", image: "desktop" } : { id: "c1", status: "running" });
		}
		if (path === "/v1/containers") return Response.json({ data: [{ id: "c1", status: "running", name: "EnrichedLab" }] });
		if (path === "/v1/containers/d1/desktop" || path === "/v1/containers/d1/desktop/open") {
			const action = (await request.json()) as { action?: string; coordinate?: [number, number]; text?: string };
			if (action.coordinate && action.action?.includes("click")) lastClick = action.coordinate;
			if (action.action === "type") typedChars += action.text?.length ?? 0;
			if (action.action !== "screenshot") for (const ws of watching) sendScreen(ws);
			return Response.json({ ok: true, screenshot: { png: desktopPng(), ...DESK } });
		}
		if (path === "/v1/containers/c1") return Response.json({ id: "c1", status: "running", image: null, network: null });
		if (path === "/v1/containers/c1/exec") {
			const { command, timeout_seconds } = (await request.json()) as { command: string; timeout_seconds?: number };
			const run = Bun.spawn(["sh", "-c", toHost(command)], { cwd: join(sandbox, "work"), stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: sandbox } });
			const timer = setTimeout(() => run.kill(), (timeout_seconds ?? 120) * 1000);
			const [stdout, stderr] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
			clearTimeout(timer);
			return Response.json({ exit_code: await run.exited, stdout: toLab(stdout), stderr: toLab(stderr) });
		}
		if (path === "/v1/containers/c1/files" && request.method === "POST") {
			const file = (await request.formData()).get("file") as File;
			writeFileSync(join(sandbox, "work", file.name), Buffer.from(await file.arrayBuffer()));
			return Response.json({ path: `/sandbox/work/${file.name}`, bytes: file.size });
		}
		if (path === "/v1/containers/c1/files") return Response.json({ data: listFiles(), has_more: false });
		const content = /^\/v1\/containers\/c1\/files\/([^/]+)\/content$/.exec(path);
		if (content) return new Response(readFileSync(toHost(Buffer.from(content[1]!, "base64url").toString())));
		return new Response("", { status: 404 });
	},
});

// ── The engine, the project and its sessions ─────────────────────────────────────────────────────────────────────

mkdirSync(home, { recursive: true, mode: 0o700 });
writeFileSync(join(work, "lab.key"), KEY, { mode: 0o600 });
writeFileSync(join(home, "sites.json"), JSON.stringify({ sites: [{ name: "devlab", title: "Field Lab", url: "https://devlab.invalid", kind: "gate", lan: { url: `http://127.0.0.1:${lab.port}`, keyFile: join(work, "lab.key") }, preferLan: true }] }));
// A cloud service beside the lab (never called: its models are listed from config), so menus show both kinds.
writeFileSync(
	join(home, "config.json"),
	JSON.stringify({ model: "devlab/field-coder", discovery: { local: false }, providers: { cloudco: { api: "openai-chat", baseUrl: "https://api.cloudco.invalid/v1", keyEnv: "CLOUDCO_KEY", label: "CloudCo", models: ["cloud-large"] } } }),
);
mkdirSync(join(project, "src"), { recursive: true });
writeFileSync(join(project, "README.md"), "# Soil moisture analysis\n\nScripts for the 2026 field season.\n");
// 60,000 rows for a scatter plot, the size that crashed the window on November 7.
writeFileSync(
	join(project, "scored.csv"),
	`predicted_prob,usage_pct,risk_tier\n${Array.from({ length: 60_000 }, (_, i) => `${((i * 7919) % 10_000) / 10_000},${((i * 104_729) % 1000) / 10},${["low", "medium", "high"][i % 3]}`).join("\n")}\n`,
);
// A dashboard that lays itself out again at every width, as a Shiny or Plotly page does.
writeFileSync(
	// Its own name: the live scenes write dashboard.html.
	join(project, "field_dashboard.html"),
	`<!doctype html><meta charset="utf-8"><title>Field dashboard</title>
<style>body{font:14px system-ui;margin:0;padding:16px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}section{border:1px solid #ccc;border-radius:8px;padding:12px;min-height:140px}canvas{width:100%;height:160px}</style>
<h1>Soil moisture, 2026</h1><main>${Array.from({ length: 6 }, (_, i) => `<section><h2>Plot ${i + 1}</h2><canvas></canvas></section>`).join("")}</main>
<script>const draw=()=>document.querySelectorAll("canvas").forEach((c,k)=>{const r=c.getBoundingClientRect();c.width=r.width*devicePixelRatio;c.height=r.height*devicePixelRatio;const g=c.getContext("2d");g.scale(devicePixelRatio,devicePixelRatio);g.beginPath();for(let x=0;x<r.width;x+=4)g.lineTo(x,r.height/2+Math.sin((x+k*40)/30)*r.height/3);g.stroke();});new ResizeObserver(draw).observe(document.body);draw();</script>`,
);
writeFileSync(join(project, "src", "analysis.py"), "import pandas as pd\n\n\ndef load(path):\n    return pd.read_csv(path)\n");
writeFileSync(join(project, "plots.csv"), "plot,moisture\nP1,0.31\nP2,0.27\n");
const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=Pat", "-c", "user.email=pat@example.invalid", ...a], { cwd: project });
git("init", "-q");
git("add", ".");
git("commit", "-qm", "Start the field season scripts");

const env = { ...process.env, EL_HOME: home, EL_KEYSTORE: "file" };
const engine = Bun.spawn(["bun", join(root, "packages/cli/src/main.ts"), "serve", "--foreground"], { env, stdout: "ignore", stderr: "inherit" });
let app: ReturnType<typeof Bun.spawn> | undefined;
let failed = false;

async function main(): Promise<void> {
	process.env.EL_HOME = home;
	let found;
	for (let i = 0; i < 80 && !found; i++) {
		await Bun.sleep(250);
		found = await findEngine().catch(() => undefined);
	}
	if (!found) throw new Error("The engine didn't start.");
	const client = new EngineClient(found, "dev-lab");
	await client.ready();
	for (let i = 0; i < 40 && !(await client.call("site.list", {})).some((s) => s.sandbox); i++) await Bun.sleep(250);
	const turn = async (sessionId: string) => {
		let done = false;
		const stop = client.on("session.event", ({ sessionId: id, event }) => {
			if (id === sessionId && event.t === "assistant" && event.stop !== "tool_use") done = true;
		});
		await client.call("session.open", { sessionId });
		await client.call("session.prompt", { sessionId, text: "Run uname and show the last commit" });
		for (let i = 0; i < 120 && !done; i++) await Bun.sleep(250);
		stop();
		if (!done) throw new Error(`The seeded turn in ${sessionId} didn't finish.`);
	};
	const local = await client.call("session.create", { cwd: project });
	await turn(local.id);
	const moved = await client.call("session.create", { cwd: project });
	await client.call("session.place", { sessionId: moved.id, place: "devlab" });
	await turn(moved.id);
	console.log(`dev lab: engine on ${found.port}, lab on ${lab.port}, sessions ${local.id} (This Mac) and ${moved.id} (Field Lab)`);

	if (nativeMac) {
		await macScenes(client, found.version, { local: local.id, lab: moved.id });
		client.close();
		return;
	}
	if (!shotsAt) {
		app = electron({}, ["--session", moved.id]);
		await app.exited;
		return;
	}
	mkdirSync(shotsAt, { recursive: true });
	for (const theme of ["light", "dark"] as const) {
		await client.call("ui.set", { theme });
		for (const scene of SCENES) {
			if (only && scene.name !== only) continue;
			const sessionId = scene.session === "lab" ? moved.id : scene.session === "local" ? local.id : undefined;
			const before = new Set((await client.call("session.list", {})).map((s) => s.id));
			const file = join(shotsAt, `${scene.name}-${theme}.png`);
			app = electron(
				{
					EL_SHOT: file,
					EL_SHOT_DELAY: "2500",
					EL_SHOT_AFTER: String(scene.after ?? 1200),
					EL_SHOT_SIZE: scene.size ?? "1360x880",
					...(scene.route ? { EL_SHOT_ROUTE: scene.route } : {}),
					...(scene.js ? { EL_SHOT_JS: `(() => { ${HELPERS} ${scene.js} })()` } : {}),
					...(scene.type ? { EL_SHOT_TYPE: scene.type } : {}),
					...(scene.menu ? { EL_SHOT_MENU: scene.menu } : {}),
					...(scene.resize ? { EL_SHOT_RESIZE: scene.resize } : {}),
				},
				sessionId ? ["--session", sessionId] : [],
			);
			const code = await Promise.race([app.exited, Bun.sleep(90_000).then(() => "timeout")]);
			if (code === "timeout") app.kill();
			const problem = scene.check ? await scene.check(client, before) : undefined;
			if (problem) failed = true;
			console.log(`${scene.name} (${theme}): ${problem ? `FAILED: ${problem}` : "ok"}`);
		}
	}
	client.close();
}

// ── The native macOS app ─────────────────────────────────────────────────────────────────────────────────────────

/** One state of the native window: a session, a pane, Settings, a size (Automation.swift reads these). */
interface MacScene {
	name: string;
	/** Open the newest step in the timeline. */
	openStep?: boolean;
	session?: "lab" | "local";
	pane?: "files" | "timeline" | "terminal" | "browser" | "desktop" | "first";
	settings?: "general" | "models" | "labs" | "updates";
	size?: string;
	/** A size applied after the pane opens: narrowing a window with the workbench open. */
	resize?: string;
	/** A file in the session's folder opened as a view, and a drag of the window's edge or the workbench divider. */
	open?: string;
	drag?: "window" | "divider";
	/** Open the 60,000-point scatter plot view first. */
	plot?: boolean;
	/** Scroll the run sheet up partway through the live turn: it must stay where the reader put it. */
	scrollUp?: boolean;
	/** A message sent in the opened session; the scene waits for its question. */
	send?: string;
	/** Ask about the project folder, as a first session there does, and capture the question. */
	folder?: boolean;
	/** A task started from the window in a new session, run until it streams, asks, or is done. */
	prompt?: string;
	until?: "streaming" | "question" | "done";
	advanced?: boolean;
	after?: number;
}

const MAC_SCENES: MacScene[] = [
	{ name: "mac_new_session" },
	{ name: "mac_session_lab", session: "lab" },
	{ name: "mac_session_local", session: "local" },
	{ name: "mac_advanced", session: "lab", advanced: true },
	{ name: "mac_files", session: "local", pane: "files", after: 2500 },
	{ name: "mac_terminal", session: "local", pane: "terminal", after: 3000 },
	{ name: "mac_desktop", session: "lab", pane: "desktop", after: 4000 },
	{ name: "mac_narrow", session: "lab", pane: "desktop", size: "900x700", after: 3000 },
	{ name: "mac_narrowed", session: "lab", pane: "desktop", resize: "900x700", after: 3000 },
	{ name: "mac_dashboard_window", session: "local", open: "field_dashboard.html", drag: "window", after: 800 },
	{ name: "mac_dashboard_divider", session: "local", open: "field_dashboard.html", drag: "divider", after: 800 },
	{ name: "mac_plot_window", session: "local", plot: true, pane: "first", drag: "window", after: 800 },
	{ name: "mac_plot_divider", session: "local", plot: true, pane: "first", drag: "divider", after: 800 },
	{ name: "mac_question_folder", session: "local", send: "Write the big page", after: 800 },
	{ name: "mac_folder_question", folder: true, after: 800 },
	{ name: "mac_live_streaming", prompt: "Write the big page", until: "streaming", after: 300 },
	{ name: "mac_live_question", prompt: "Write the big page", until: "question", after: 800 },
	{ name: "mac_live_done", prompt: "Write the big page", until: "done", after: 800 },
	{ name: "mac_live_long", prompt: "Run a long analysis of the field data", until: "done", after: 800 },
	{ name: "mac_live_scrolled", prompt: "Run a long analysis of the field data", until: "done", scrollUp: true, after: 800 },
	{ name: "mac_timeline", prompt: "Run a long analysis of the field data", until: "done", pane: "timeline", openStep: true, after: 2000 },
	{ name: "mac_settings_general", settings: "general" },
	{ name: "mac_settings_models", settings: "models", after: 2500 },
	{ name: "mac_settings_labs", settings: "labs" },
];

async function macScenes(client: EngineClient, engineVersion: string, sessions: { local: string; lab: string }): Promise<void> {
	// EL_MAC_BINARY: another build, such as an optimized one built with -Xswiftc -DDEBUG to keep the scene hooks.
	const binary = process.env.EL_MAC_BINARY ?? join(root, "apps/macos/.build/debug/EnrichedLab");
	if (!statSync(binary, { throwIfNoEntry: false })) throw new Error("Build the app first: cd apps/macos && swift build");
	const out = shotsAt ?? join(root, "dist", "shots");
	mkdirSync(out, { recursive: true });
	for (const theme of ["light", "dark"] as const) {
		await client.call("ui.set", { theme });
		for (const scene of MAC_SCENES) {
			if (only && scene.name !== only) continue;
			const sessionId = scene.session ? sessions[scene.session] : undefined;
			if (scene.plot && sessionId) await client.call("view.open", { sessionId, path: join(project, "scored.csv"), plot: { x: "predicted_prob", y: "usage_pct", color: "risk_tier", type: "scatter" } });
			const proc = Bun.spawn([binary], {
				env: {
					...env,
					EL_APP_VERSION: engineVersion,
					EL_ENGINE_COMMAND: `bun ${join(root, "packages/cli/src/main.ts")}`,
					EL_SCENE: scene.name,
					EL_SCENE_SIZE: scene.size ?? "1360x880",
					EL_SCENE_AFTER: String(scene.after ?? 1800),
					...(sessionId ? { EL_SCENE_SESSION: sessionId } : {}),
					...(scene.pane ? { EL_SCENE_PANE: scene.pane } : {}),
					...(scene.resize ? { EL_SCENE_RESIZE: scene.resize } : {}),
					...(scene.open ? { EL_SCENE_OPEN: scene.open } : {}),
					...(scene.drag ? { EL_SCENE_DRAG: scene.drag } : {}),
					...(scene.send ? { EL_SCENE_SEND: scene.send } : {}),
					...(scene.scrollUp ? { EL_SCENE_SCROLLUP: "1" } : {}),
					...(scene.openStep ? { EL_SCENE_STEP: "last" } : {}),
					...(scene.folder ? { EL_SCENE_FOLDER: project } : {}),
					...(scene.prompt ? { EL_SCENE_PROMPT: scene.prompt, EL_SCENE_UNTIL: scene.until ?? "done" } : {}),
					...(scene.settings ? { EL_SCENE_SETTINGS: scene.settings } : {}),
					...(scene.advanced ? { EL_SCENE_ADVANCED: "1" } : {}),
				},
				stdout: "pipe",
				stderr: "ignore",
			});
			const windows: { id: string; name: string }[] = [];
			let ready = false;
			const reading = (async () => {
				let rest = "";
				for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
					// Whole lines only: a chunk can end partway through one.
					const lines = (rest + chunk).split("\n");
					rest = lines.pop() ?? "";
					for (const line of lines) {
						const w = /^scene: window (\d+) (.*)$/.exec(line);
						if (w) windows.push({ id: w[1]!, name: w[2]! });
						if (line === "scene: ready") ready = true;
						else if (line.startsWith("scene: ") && !w) console.log(`  ${scene.name}: ${line.slice(7)}`);
					}
					if (ready) break;
				}
			})();
			await Promise.race([reading, Bun.sleep(scene.prompt || scene.drag ? 180_000 : 60_000)]);
			if (!ready) {
				failed = true;
				const code = proc.exitCode ?? proc.signalCode;
				console.log(`${scene.name} (${theme}): FAILED: ${code !== null ? `the app ended (${code}) before it was ready` : "the app never said it was ready"}`);
				proc.kill();
				continue;
			}
			// Only this app's own windows: never the whole screen.
			const settings = windows.find((w) => /settings|general|models|labs|updates/i.test(w.name));
			// The folder question is a sheet: its own window, listed after the main one.
			const target = scene.settings ? settings : scene.folder ? windows.at(-1) : windows.find((w) => w !== settings);
			if (target) Bun.spawnSync(["screencapture", "-x", "-o", `-l${target.id}`, join(out, `${scene.name}-${theme}.png`)]);
			proc.kill();
			await proc.exited;
			console.log(`${scene.name} (${theme}): ${target ? "ok" : "FAILED: no window"}`);
			if (!target) failed = true;
		}
	}
}

function electron(extra: Record<string, string>, argv: string[]): ReturnType<typeof Bun.spawn> {
	const bin = join(root, "apps/desktop/node_modules/.bin", process.platform === "win32" ? "electron.cmd" : "electron");
	const proc = Bun.spawn([bin, ".", `--user-data-dir=${join(work, "electron")}`, "--use-mock-keychain", ...argv], { cwd: join(root, "apps/desktop"), env: { ...env, ...extra }, stdout: "pipe", stderr: "ignore" });
	// What a scene measured (shot: perf ...) goes to this script's output.
	void (async () => {
		for await (const line of proc.stdout.pipeThrough(new TextDecoderStream())) for (const l of line.split("\n")) if (l.startsWith("shot: perf") || l.startsWith("shot: check")) console.log(`  ${l.slice(6)}`);
	})().catch(() => undefined);
	return proc;
}

// ── Scenes ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** In each scene's script: q(selector), button(label or text), later(ms, fn). */
const HELPERS = `const q = (s) => document.querySelector(s);
const button = (t) => [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === t || b.textContent.trim() === t);
const later = (ms, f) => setTimeout(f, ms);`;

interface Scene {
	name: string;
	session?: "lab" | "local";
	route?: string;
	js?: string;
	type?: string;
	menu?: string;
	size?: string;
	/** WxH: the window is resized back and forth to this size during the scene, then compared with the page. */
	resize?: string;
	after?: number;
	/** A problem with what the scene did, if any. `before` holds the sessions that existed before it. */
	check?: (client: EngineClient, before: Set<string>) => Promise<string | undefined>;
}

const SCENES: Scene[] = [
	{ name: "start", route: "/#/new", js: `q("#task-field")?.focus();` },
	{ name: "session_lab", session: "lab" },
	{ name: "session_local", session: "local" },
	{ name: "place_menu", session: "lab", js: `q(".switch .chip")?.click();` },
	{ name: "model_menu", session: "lab", js: `[...document.querySelectorAll(".model .chip")][0]?.click();` },
	{ name: "workbench_files", session: "local", after: 2500, js: `button("Workbench")?.click(); later(700, () => button("Files")?.click()); later(1800, () => [...document.querySelectorAll(".files-pane button")].find((b) => b.textContent.includes("README"))?.click());` },
	{ name: "workbench_terminal", session: "local", after: 2500, type: "ls", js: `button("Workbench")?.click(); later(700, () => button("Terminal")?.click()); later(2200, () => q(".xterm-helper-textarea")?.focus());` },
	// A terminal keeps running when its tab moves into a split: the text typed before the move is still there.
	{
		name: "terminal_split",
		session: "local",
		after: 7000,
		type: "echo still-here",
		js: `button("Workbench")?.click(); later(700, () => button("Files")?.click()); later(1200, () => button("Terminal")?.click()); later(2200, () => q(".xterm-helper-textarea")?.focus()); later(6500, () => { const tab = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.includes("Terminal")); tab?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, shiftKey: true, bubbles: true })); });`,
	},
	{ name: "settings", session: "lab", js: `button("Settings")?.click();` },
	{ name: "model_services", session: "lab", after: 2000, js: `button("Models")?.click();` },
	{ name: "palette", session: "lab", js: `q(".search")?.click();` },
	{ name: "join_lab", session: "lab", js: `button("Add a lab")?.click();` },
	{ name: "move_back", session: "lab", after: 2000, js: `q(".switch .chip")?.click(); later(500, () => q(".switch .menu-item")?.click());` },
	{ name: "narrow_900", session: "lab", size: "900x720" },
	{ name: "narrow_760", session: "lab", size: "760x700" },
	{ name: "compact_workbench", session: "local", size: "1100x800", after: 2000, js: `button("Workbench")?.click(); later(700, () => button("Files")?.click());` },
	// The lab's desktop sandbox in a pane: the first picture, then a click the person makes (the marker moves there).
	{ name: "desktop", session: "lab", after: 4500, js: `button("Workbench")?.click(); later(700, () => button("Desktop")?.click()); later(2500, () => { const c = q(".desktop-pane canvas"); if (!c) return; const r = c.getBoundingClientRect(); const at = { clientX: r.left + r.width * 0.42, clientY: r.top + r.height * 0.5, bubbles: true, button: 0 }; c.dispatchEvent(new PointerEvent("pointerdown", at)); c.dispatchEvent(new PointerEvent("pointerup", at)); c.dispatchEvent(new MouseEvent("click", { ...at, detail: 1 })); });` },
	// The window never scrolls as a whole: focus and scrollIntoView inside the panes leave every frame where it is.
	{
		name: "window_stays_put",
		session: "lab",
		after: 6000,
		js: `button("Workbench")?.click(); later(700, () => button("Desktop")?.click());
later(3000, () => { const tall = document.createElement("div"); tall.style.cssText = "position:absolute;top:0;width:10px;height:4000px"; q(".rail")?.append(tall); tall.scrollIntoView(); const c = q(".desktop-pane canvas"); c?.focus(); c?.scrollIntoView(); q("textarea")?.scrollIntoView({ block: "end" }); [...document.querySelectorAll("*")].at(-1)?.scrollIntoView(); document.documentElement.scrollTop = 400; });
later(4200, () => { const tall = [...document.querySelectorAll("*")].map((e) => [e, e.getBoundingClientRect()]).filter(([, r]) => r.bottom > innerHeight + 4 && r.height > 0).filter(([e]) => getComputedStyle(e).position === "absolute" || getComputedStyle(e).position === "fixed").sort((a, b) => b[1].bottom - a[1].bottom).slice(0, 6).map(([e, r]) => (e.id || String(e.className).split(" ").slice(0, 2).join(".") || e.tagName) + "@" + Math.round(r.top) + "-" + Math.round(r.bottom));
console.log("shot: check page " + document.documentElement.scrollHeight + " tall in a " + innerHeight + " window; below the window " + JSON.stringify(tall)); });
later(4500, () => { const moved = [document.documentElement, document.body, ...document.querySelectorAll("*")].filter((e) => (e.scrollTop || e.scrollLeft) && !["auto", "scroll"].includes(getComputedStyle(e).overflowY)).map((e) => (e.id || String(e.className).split(" ")[0] || e.tagName) + ":" + e.scrollTop);
console.log("shot: check shell top " + q(".shell")?.getBoundingClientRect().top + "; frames moved " + JSON.stringify(moved)); });`,
	},
	// Discovery mode, typed in a lab session: the title bar says so and the transcript marks where it started.
	{ name: "discovery", session: "lab", after: 2500, type: "/discover", js: `q("textarea")?.focus();` },
	// A long tool call streams for about 20 seconds: the page has to keep drawing frames (a window resized meanwhile
	// shows its old frame over the window's material until the page draws again).
	{
		name: "streaming_write",
		session: "local",
		after: 26_000,
		resize: "1000x640",
		type: "Write a big page",
		js: `const gaps = []; let last = performance.now(); let long = 0, longest = 0;
new PerformanceObserver((l) => l.getEntries().forEach((e) => { long += e.duration; longest = Math.max(longest, e.duration); })).observe({ type: "longtask", buffered: false });
const frame = (t) => { gaps.push(t - last); last = t; if (gaps.length < 100000) requestAnimationFrame(frame); }; requestAnimationFrame(frame);
q("textarea")?.focus();
later(24_000, () => { const sorted = [...gaps].sort((a, b) => a - b); const p = (x) => sorted[Math.floor(sorted.length * x)]?.toFixed(1);
console.log("shot: perf frames " + gaps.length + " p50 " + p(0.5) + " ms p95 " + p(0.95) + " ms max " + sorted.at(-1)?.toFixed(0) + " ms; long tasks " + long.toFixed(0) + " ms, longest " + longest.toFixed(0) + " ms"); });`,
	},
	// A task typed after choosing "New Session in <lab>" from the lab's menu runs there as the first turn.
	{
		name: "new_in_lab",
		route: "/#/new",
		after: 9000,
		menu: "New Session in Field Lab",
		type: "Run uname and show the last commit",
		js: `[...document.querySelectorAll("button.place-main")].find((b) => b.textContent.includes("Field Lab"))?.click(); later(900, () => q("#task-field")?.focus());`,
		check: async (client, before) => {
			const made = (await client.call("session.list", {})).filter((s) => !before.has(s.id));
			if (made.length !== 1) return `expected one new session, found ${made.length}`;
			if (made[0]!.place !== "devlab") return `the session is on ${made[0]!.place ?? "This Mac"}, not the lab`;
			if (made[0]!.turns !== 1) return `the first task didn't run (${made[0]!.turns} turns)`;
			return undefined;
		},
	},
];

try {
	await main();
} catch (error) {
	console.error(`dev lab: ${(error as Error).message}`);
	failed = true;
} finally {
	app?.kill();
	engine.kill();
	await engine.exited;
	lab.stop(true);
	rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
process.exit(failed ? 1 : 0);
