// The lab contract from the client's side: schemas, the descriptor, `el lab check` against a local lab that follows
// the contract, the event stream's cursor and reset, files by reference, and unreviewed lab tools.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { toTools } from "../packages/engine/src/mcp.ts";
import { decide } from "../packages/engine/src/permissions.ts";
import { contractProblem, type LabDescriptor, SCHEMAS, validate } from "../packages/engine/src/sites/contract.ts";
import { GateSite } from "../packages/engine/src/sites/gate.ts";
import { noticeText } from "../packages/engine/src/sites/sites.ts";

const descriptor: LabDescriptor = {
	contract: "2026-11",
	name: "devlab",
	title: "Dev Lab",
	endpoints: { models: true, bundles: true, events: true, guard: true, usage: true, containers: true, attach: true, files: true, runs: true, checkpoints: true },
	packages: { conda: ["https://conda.example.org/vetted"], pypi: "https://pypi.example.org/simple", only: true },
	sign_in: { kind: "cloudflare-access-oauth" },
	policy: { keep_data_inside: false },
	support: { url: "https://help.example.org" },
	sandbox_profiles: [{ name: "small", cpu: 2, memory: "4Gi" }],
	conformance: { foreign_scope: "otherlab", scan_test: true },
	sandbox_networks: [{ name: "none", title: "No network" }, { name: "internet", title: "The public web" }],
	sandbox_desktop: { image: "desktop", screen: { width: 8, height: 4 }, actions: ["screenshot", "left_click"], open: true, max_type_chars: 4000 },
};
/** A PNG's signature and the start of its IHDR, enough for a check that reads the size. */
const TINY_PNG = (() => {
	const b = Buffer.alloc(33);
	b.set([137, 80, 78, 71, 13, 10, 26, 10]);
	b.writeUInt32BE(13, 8);
	b.write("IHDR", 12, "ascii");
	b.writeUInt32BE(8, 16);
	b.writeUInt32BE(4, 20);
	return b.toString("base64");
})();
const me = {
	subject: "u_9f2c41aa",
	handle: "pat",
	memberships: [
		{ lab: "devlab", research_group: "soils", roles: ["researcher"] },
		{ lab: "devlab", research_group: null, roles: ["member"] },
	],
	policy: { keep_data_inside: false },
	sandbox_networks: ["none", "internet"],
	data_scopes: [{ id: "soils-2026", title: "Soil cores, 2026", research_group: "soils", access: "read" }],
};
const seen: { desktop: string[]; cursor?: string | null; deleted?: string; uploaded: string; keepsTestFile?: boolean; filesDeleted: string[]; internet: string[]; leaks?: boolean; tries?: boolean; passesBadCerts?: boolean; restored?: boolean } = { desktop: [], uploaded: "", filesDeleted: [], internet: [] };
/** The EICAR test file's sha-256: the lab here knows it by its hash, so this file never holds it. */
const EICAR_SHA256 = "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f";

const lab = Bun.serve<{ stdin: string; started: boolean }, never>({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(request, srv): Promise<Response | undefined> {
		const url = new URL(request.url);
		if (request.headers.get("authorization") !== "Bearer test") return new Response("", { status: 401 });
		const etagged = (body: unknown) => {
			const etag = `"${createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16)}"`;
			if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
			return Response.json(body, { headers: { etag } });
		};
		switch (url.pathname) {
			case "/.well-known/enrichedlab-lab":
				return etagged(descriptor);
			case "/v1/me":
				return etagged(me);
			case "/v1/models":
				return etagged({ data: [{ id: "lab-model", gate: { context: 65536, capabilities: ["reasoning"], efforts: ["low", "high"] } }] });
			case "/v1/bundles":
				return etagged({ data: [{ name: "lab-basics", version: "1", files: [{ path: "AGENTS.md", content: "Be careful with data." }] }] });
			case "/v1/guard":
				return Response.json({ decision: "allow", categories: [], reasons: [], policy_version: "g1", receipt_id: "r1" });
			case "/v1/usage":
				if (url.searchParams.get("lab") === "otherlab") return Response.json({ error: { message: "not yours" } }, { status: 403 });
				return Response.json({ window: "7d", rows: [{ lab: "devlab", tokens: { input: 10, output: 5 }, gpu_seconds: 0, sandbox_seconds: 30 }] });
			case "/v1/containers": {
				// An internet sandbox (n1) reaches the public web only, and takes no files.
				const body = (await request.json().catch(() => ({}))) as { network?: string; image?: string };
				if (body.image === "desktop") return Response.json({ id: "d1", status: "running", image: "desktop" });
				if (body.network === "internet") return Response.json({ id: "n1", status: "running", network: "internet" });
				return Response.json({ id: "c1", status: "running", image_digest: `sha256:${"a".repeat(64)}` });
			}
			// A desktop sandbox: a picture for screenshot, no shell, and no address with a user and password.
			case "/v1/containers/d1/desktop":
				seen.desktop.push(((await request.json()) as { action: string }).action);
				return Response.json({ ok: true, action: "screenshot", screenshot: { png: TINY_PNG, width: 8, height: 4 } });
			case "/v1/containers/d1/exec":
				return Response.json({ error: { code: "desktop_no_shell", message: "a desktop sandbox has no shell" } }, { status: 403 });
			case "/v1/containers/d1/desktop/open":
				return Response.json({ error: { code: "invalid_target", message: "no user or password in addresses" } }, { status: 400 });
			case "/v1/runs":
				return Response.json({ data: [{ id: "s1", session: "s1", status: "idle", mode: "attended", model: "lab-model" }] });
			case "/v1/containers/n1/exec": {
				const { command } = (await request.json()) as { command: string };
				seen.internet.push(command);
				// The private-address probe: the proxy refuses every target, except where a lab is set to leak one
				// (it connects to the metadata address spelled as IPv4-mapped IPv6) or to try one (it connects and fails).
				if (command.includes("CONNECT ")) {
					const targets = [...command.matchAll(/'([^'\s]+:\d+)'/g)].map((m) => m[1]!);
					const answers = Object.fromEntries(targets.map((t) => [t, seen.leaks && t === "[::ffff:a9fe:a9fe]:443" ? "reached" : seen.tries && t === "10.0.0.1:443" ? "the proxy answered 502" : "refused"]));
					return Response.json({ exit_code: 0, stdout: `${JSON.stringify(answers)}\n`, stderr: "" });
				}
				// Pages with broken certificates: the proxy refuses them, unless a lab is set to pass them on re-signed.
				if (command.includes("badssl.com")) {
					const urls = [...command.matchAll(/'(https:[^'\s]+)'/g)].map((m) => m[1]!);
					const got = Object.fromEntries(urls.map((u) => [u, u === "https://badssl.com/" || (seen.passesBadCerts && u.includes("expired")) ? "loaded 200" : "URLError: Tunnel connection failed: 502 Bad Gateway"]));
					return Response.json({ exit_code: 0, stdout: `${JSON.stringify(got)}\n`, stderr: "" });
				}
				return command.includes("https://example.com/") ? Response.json({ exit_code: 0, stdout: "200\n", stderr: "" }) : Response.json({ exit_code: 1, stdout: "", stderr: "urllib.error.URLError" });
			}
			case "/v1/containers/n1/files":
				return Response.json({ error: { code: "internet_no_files", message: "A sandbox with internet access takes no files." } }, { status: 409 });
			case "/v1/containers/c1/exec": {
				// A long command, written the way agents write files: its byte count.
				const { command } = (await request.json()) as { command: string };
				const piped = /^printf %s '(x*)' \| wc -c$/.exec(command);
				return Response.json({ exit_code: 0, stdout: piped ? `${piped[1]!.length}\n` : "ok\n", stderr: "" });
			}
			case "/v1/containers/c1/checkpoints":
				if (request.method === "POST") return Response.json({ id: "k1", container: "c1", at: new Date().toISOString(), label: "el lab check" }, { status: 201 });
				return Response.json({ checkpoints: [{ id: "k1", container: "c1", at: new Date().toISOString() }] });
			case "/v1/containers/c1/checkpoints/k1/restore":
				seen.restored = true;
				return Response.json({ id: "c1", status: "restoring" }, { status: 202 });
			case "/v1/containers/c1/checkpoints/k1":
				return new Response(null, { status: 204 });
			case "/v1/containers/c1/jobs":
				return Response.json({ id: "j1", status: "running" }, { status: 201 });
			case "/v1/containers/c1/jobs/j1":
				return Response.json({ id: "j1", status: "succeeded", exit_code: 0, log: "el-job-ok\n" });
			case "/v1/containers/c1/attach":
				return srv.upgrade(request, { data: { stdin: "", started: false } }) ? undefined : new Response("", { status: 400 });
			case "/v1/containers/c1/files":
				if (request.method === "POST") {
					const file = (await request.formData()).get("file") as File;
					seen.uploaded = await file.text();
					return Response.json({ path: `/sandbox/work/${file.name}`, bytes: file.size });
				}
				return Response.json({ data: [{ id: "u1", path: "/sandbox/work/el-check.txt", bytes: seen.uploaded.length }] });
			case "/v1/containers/c1/files/u1/content":
				return new Response(seen.uploaded, { headers: { "repr-digest": `sha-256=:${createHash("sha256").update(seen.uploaded).digest("base64")}:` } });
			case "/v1/files/f1/content":
				return new Response("plot,yield\nP1,5.1\n");
			case "/v1/files": {
				// Scanned on the way in: the EICAR test file is refused, unless this lab is set to keep it.
				const file = (await request.formData()).get("file") as File;
				const test = createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex") === EICAR_SHA256;
				if (test && !seen.keepsTestFile) return Response.json({ error: { code: "file_refused", message: "A malware scanner refused this file." } }, { status: 422 });
				return Response.json({ id: "f2", object: "file", bytes: file.size, filename: file.name });
			}
			case "/v1/files/f2":
				seen.filesDeleted.push("f2");
				return Response.json({ id: "f2", deleted: true });
			case "/v1/events": {
				seen.cursor = request.headers.get("last-event-id");
				const body =
					seen.cursor === "0"
						? `event: reset\nid: 7\ndata: {"cursor":"7"}\n\n`
						: `: keepalive\n\nid: 8\nevent: job.finished\ndata: {"type":"job.finished","at":"2026-11-04T10:00:00Z","id":"8","status":"done","summary":"model fit"}\n\nid: 9\nevent: quota.warning\ndata: {"type":"quota.warning","at":"2026-11-04T10:01:00Z","id":"9","kind":"GPU hours","used":8,"limit":10}\n\n`;
				return new Response(body, { headers: { "content-type": "text/event-stream" } });
			}
		}
		if (request.method === "DELETE" && url.pathname === "/v1/containers/d1") {
			seen.desktop.push("deleted");
			return Response.json({ ok: true });
		}
		if (request.method === "DELETE" && url.pathname === "/v1/containers/n1") {
			seen.internet.push("deleted");
			return Response.json({ ok: true });
		}
		if (request.method === "GET" && url.pathname === "/v1/containers/c1") return Response.json({ id: "c1", status: "running" });
		if (request.method === "DELETE" && url.pathname === "/v1/containers/c1") {
			seen.deleted = "c1";
			return Response.json({ ok: true });
		}
		return new Response("", { status: 404 });
	},
	// Stands in for the check's `read line; echo got:$line; read more; echo also:$more; echo note >&2; exit 3`.
	websocket: {
		message(ws, raw) {
			const frame = JSON.parse(String(raw)) as { argv?: string[]; stdin?: string; eof?: boolean };
			if (!ws.data.started) {
				ws.data.started = frame.argv?.[0] === "sh";
				return;
			}
			const b64 = (s: string) => Buffer.from(s).toString("base64");
			if (frame.stdin) {
				ws.data.stdin += Buffer.from(frame.stdin, "base64").toString();
				const lines = ws.data.stdin.split("\n");
				// Answer each line as it arrives, as a live process does.
				if (lines.length === 2) ws.send(JSON.stringify({ stdout: b64(`got:${lines[0]}\n`) }));
				if (lines.length === 3) ws.send(JSON.stringify({ stdout: b64(`also:${lines[1]}\n`) }));
			}
			if (frame.eof) {
				ws.send(JSON.stringify({ stderr: b64("note\n") }));
				ws.send(JSON.stringify({ exit_code: 3 }));
				ws.close();
			}
		},
	},
});
afterAll(() => lab.stop(true));

const base = `http://127.0.0.1:${lab.port}`;
const site = () => new GateSite({ name: "devlab", url: base, kind: "gate" }, { base, via: "key", headers: async () => ({ authorization: "Bearer test" }) });

describe("lab contract", () => {
	test("schemas accept the agreed shapes and say what's wrong with others", () => {
		expect(validate(SCHEMAS.lab, descriptor)).toEqual([]);
		expect(validate(SCHEMAS.me, me)).toEqual([]);
		const bad = validate(SCHEMAS.me, { subject: "pat@example.org", memberships: [{ lab: "x" }] });
		expect(bad.join(" | ")).toContain("$.subject must not match");
		expect(bad.join(" | ")).toContain("$.memberships[0].roles is missing");
		expect(validate(SCHEMAS.me, { ...me, memberships: [{ lab: "devlab", research_group: 7, roles: [] }] })).toEqual(["$.memberships[0].research_group is integer, expected string or null"]);
		// A sandbox's reason is null while there's nothing to say (a running one), as Gate sends it.
		expect(validate(SCHEMAS.container, { id: "c1", status: "running", reason: null })).toEqual([]);
		expect(validate(SCHEMAS.container, { id: "c1", status: "deleted", reason: "Unused for 90 days; its files are gone." })).toEqual([]);
		expect(contractProblem({ ...descriptor, contract: "2026-11.2" })).toBeUndefined();
		expect(contractProblem({ ...descriptor, contract: "2027-03" })).toContain("speaks lab contract 2027-03");
	});

	test("connect reads the descriptor and answers repeat reads from ETags", async () => {
		const s = site();
		await s.connect();
		expect([s.title, s.descriptor?.support?.url, s.models.map((m) => m.id)]).toEqual(["Dev Lab", "https://help.example.org", ["lab-model"]]);
		expect(await s.bundles()).toHaveLength(1);
		await s.connect();
		expect(s.who).toBe("pat");
	});

	test("el lab check passes a lab that follows the contract, and cleans up its sandbox", async () => {
		const rows = await site().check();
		const failed = rows.filter((r) => r.status === "fail");
		expect(failed).toEqual([]);
		expect(rows.find((r) => r.row === "old cursor")?.detail).toContain("reset");
		expect(rows.find((r) => r.row === "another lab's scope")?.status).toBe("pass");
		expect(rows.find((r) => r.row === "attach")?.status).toBe("pass");
		// A desktop sandbox: its picture, no shell, no address with a password; removed after.
		expect(rows.filter((r) => r.row.startsWith("desktop")).map((r) => [r.row, r.status, r.detail])).toEqual([
			["desktop sandbox", "pass", "a 8x4 screenshot from the desktop image"],
			["desktop sandbox has no shell", "pass", "exec answered 403 desktop_no_shell"],
			["desktop refuses an address with a password", "pass", "answered 400 invalid_target"],
		]);
		expect(seen.desktop).toEqual(["screenshot", "deleted"]);
		expect(rows.find((r) => r.row === "GET /v1/runs")?.status).toBe("pass");
		expect(rows.find((r) => r.row === "sandbox checkpoints")).toMatchObject({ status: "pass", detail: "made, listed, and restored: a file written after it is gone" });
		expect(seen.restored).toBe(true);
		expect(rows.find((r) => r.row === "package sources")).toMatchObject({ status: "pass", detail: "1 conda channel, a PyPI index, and nothing public" });
		expect(rows.find((r) => r.row === "attach streams stdin")?.status).toBe("pass");
		expect(rows.find((r) => r.row === "scanner refuses a test file")).toMatchObject({ status: "pass", detail: "422 file_refused" });
		// An internet sandbox reaches the public web, not the metadata or a private address, and takes no files.
		expect(rows.filter((r) => r.row.startsWith("internet sandbox")).map((r) => [r.row, r.status])).toEqual([
			["internet sandbox", "pass"],
			["internet sandbox only through its proxy", "pass"],
			["internet sandbox private addresses", "pass"],
			["internet sandbox checks site certificates", "pass"],
			["internet sandbox takes no files", "pass"],
		]);
		expect(seen.internet.at(-1)).toBe("deleted");
		// One probe asks the proxy about every private target, the IPv6 spellings of the metadata address included.
		const probe = seen.internet.find((c) => c.includes("CONNECT "));
		for (const target of ["169.254.169.254:443", "10.0.0.1:443", "kubernetes.default.svc:443", "[::ffff:a9fe:a9fe]:443", "[64:ff9b::a9fe:a9fe]:443", "[2002:a9fe:a9fe::1]:443", "[fd00:ec2::254]:443"]) expect(probe).toContain(`'${target}'`);
		expect(rows.find((r) => r.row === "internet sandbox private addresses")?.detail).toStartWith("all 13 refused");
		expect(rows.find((r) => r.row === "internet sandbox checks site certificates")?.detail).toStartWith("https://badssl.com/ loaded; its expired, self-signed and wrong-name pages were refused");
		expect(seen.deleted).toBe("c1");
	});

	test("a lab whose scanner keeps the antivirus test file fails the check, and the file is removed again", async () => {
		seen.keepsTestFile = true;
		try {
			const rows = await site().check();
			expect(rows.find((r) => r.row === "scanner refuses a test file")).toMatchObject({ status: "fail", detail: "the lab kept the EICAR test file" });
			expect(seen.filesDeleted).toContain("f2");
		} finally {
			seen.keepsTestFile = false;
		}
	});

	test("an internet sandbox that reaches a private address fails the check as a leak", async () => {
		seen.leaks = true;
		try {
			const rows = await site().check();
			expect(rows.find((r) => r.row === "internet sandbox private addresses")).toMatchObject({ status: "fail", detail: "reached a private address: [::ffff:a9fe:a9fe]:443" });
		} finally {
			seen.leaks = false;
		}
	});

	test("a proxy that passes on a broken site certificate, re-signed, fails the check", async () => {
		seen.passesBadCerts = true;
		try {
			const rows = await site().check();
			expect(rows.find((r) => r.row === "internet sandbox checks site certificates")).toMatchObject({ status: "fail", detail: "the proxy passed on a broken certificate as trusted: https://expired.badssl.com/" });
		} finally {
			seen.passesBadCerts = false;
		}
	});

	test("a proxy that tries a private address, rather than refusing it, fails the check", async () => {
		seen.tries = true;
		try {
			const rows = await site().check();
			expect(rows.find((r) => r.row === "internet sandbox private addresses")).toMatchObject({ status: "fail", detail: "not refused: 10.0.0.1:443 (the proxy answered 502)" });
		} finally {
			seen.tries = false;
		}
	});

	test("the event stream keeps its cursor and resumes from it", async () => {
		const events: string[] = [];
		const cursors: string[] = [];
		const stop = site().follow("8", { event: (e) => events.push(e.type), cursor: (id) => cursors.push(id), reset: () => events.push("reset") });
		for (let i = 0; i < 50 && events.length < 2; i++) await Bun.sleep(20);
		stop();
		expect(seen.cursor).toBe("8");
		expect(events.slice(0, 2)).toEqual(["job.finished", "quota.warning"]);
		expect(cursors.slice(0, 2)).toEqual(["8", "9"]);
	});

	test("a lab agent's run held for approval says so, whatever the event's type", () => {
		const held = { type: "agent.updated", at: "2026-11-04T10:00:00Z", id: "12", task_id: "t1", waiting_on: "approval", approve_url: "https://rein.example.org/s/1", summary: "fit the yield model" };
		expect(validate(SCHEMAS.event, held)).toEqual([]);
		expect(noticeText("Dev Lab", held)).toBe("Dev Lab: the lab's agent is waiting for your approval (fit the yield model).");
		expect(validate(SCHEMAS.event, { ...held, approve_url: "http://rein.example.org" }).length).toBeGreaterThan(0);
	});

	test("files by reference come only from the lab's own address", async () => {
		const s = site();
		expect(new TextDecoder().decode(await s.fetchFile(`${base}/v1/files/f1/content`, AbortSignal.timeout(5_000)))).toContain("P1,5.1");
		await expect(s.fetchFile("https://elsewhere.example/v1/files/f1/content", AbortSignal.timeout(5_000))).rejects.toThrow("isn't an address of");
	});

	test("an unreviewed lab tool asks every time, and its results arrive as references with a receipt", async () => {
		const sha = "b".repeat(64);
		const client = {
			callTool: async () => ({
				content: [{ type: "resource_link", uri: `${base}/v1/files/f1/content`, name: "plots.csv", mimeType: "text/csv", size: 18, _meta: { "org.enrichedlab/sha256": sha } }],
				_meta: { "org.enrichedlab/receipt": { id: "rc1", code_version: "v3", parameters: { n: 24 } } },
			}),
		};
		const [tool] = toTools("devlab", client as never, [{ name: "query_plots", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, _meta: { "org.enrichedlab/tier": "unvalidated" } }] as never, "site");
		expect(tool!.unreviewed).toBe(true);
		const verdict = decide(tool!, {}, { kind: "local", inside: () => true } as never, { permissions: { mode: "full", allowCommands: [] } } as never, new Set([`tool:${tool!.name}`]));
		expect(verdict).toMatchObject({ action: "ask", keys: [`unreviewed!${tool!.name}`] });
		const result = await tool!.run({}, { signal: AbortSignal.timeout(5_000) } as never);
		expect(result.view?.files).toEqual([{ uri: `${base}/v1/files/f1/content`, name: "plots.csv", mime: "text/csv", bytes: 18, sha256: sha }]);
		expect(result.content).toContain(`sha256 ${sha}`);
		expect(result.view?.detail).toContain("code version: v3");
	});
});
