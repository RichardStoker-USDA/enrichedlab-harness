// Apps: manifests, the host's serving and permission rules, a real Bun backend over MCP, and signed packages.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AppHost } from "../packages/engine/src/apps/host.ts";
import { containerBuildNetworkArgs, containerPullArgs, servedBackendNetwork, startBackend } from "../packages/engine/src/apps/backends.ts";
import { permissionKey, readManifest } from "../packages/engine/src/apps/manifest.ts";
import { installApp, packApp } from "../packages/engine/src/apps/package.ts";
import { templateFiles } from "../packages/engine/src/apps/templates.ts";
import { RUNNER_SOURCE } from "../packages/engine/src/apps/runner.ts";
import { paths } from "../packages/engine/src/paths.ts";
import { contained, LocalWorkspace, sandboxer } from "../packages/engine/src/tools/workspace.ts";

const made: string[] = [];
function scratch(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), `lab-${name}-`));
	made.push(dir);
	return dir;
}
afterAll(() => {
	// Windows can hold a folder a moment after its process ends.
	for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function writeApp(dir: string, files: Record<string, string>) {
	for (const [rel, body] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, rel)), { recursive: true });
		writeFileSync(join(dir, rel), body);
	}
}

function host(home: string, project: string, opened: string[] = []) {
	const p = paths(home);
	mkdirSync(p.run, { recursive: true });
	return new AppHost({
		paths: p,
		emit: (name) => void opened.push(name),
		session: (id) =>
			id === "s1"
				? { project, workspace: new LocalWorkspace(project), place: "local", sealed: false, prompt: () => undefined, context: () => undefined, ask: async () => "ok" }
				: undefined,
		sandbox: () => undefined,
		isolated: () => false,
		bundles: () => [],
		origin: () => "http://127.0.0.1:9",
	});
}

describe("manifest", () => {
	test("rejects paths outside the folder and bad names", () => {
		const dir = scratch("manifest");
		writeFileSync(join(dir, "app.json"), JSON.stringify({ name: "Bad Name" }));
		expect(() => readManifest(dir)).toThrow("lowercase");
		writeFileSync(join(dir, "app.json"), JSON.stringify({ name: "ok", entry: "../x.html" }));
		expect(() => readManifest(dir)).toThrow("inside");
		writeFileSync(join(dir, "app.json"), JSON.stringify({ name: "ok", permissions: { network: ["http://plain.example"] } }));
		expect(() => readManifest(dir)).toThrow("origins");
	});
});

describe("app host", () => {
	test("serve and container-build consent names network access and changes with the backend", async () => {
		const home = scratch("network-consent-home");
		const project = scratch("network-consent-project");
		const dir = join(project, "apps", "networked");
		writeApp(dir, {
			"index.html": "<!doctype html>",
			"app.json": JSON.stringify({ name: "networked", backend: { runtime: "serve", command: ["python", "app.py"] } }),
		});
		const apps = host(home, project);
		const served = await apps.open({ sessionId: "s1", path: "apps/networked" });
		expect(served.asks).toContain(process.platform === "linux"
			? "Let its served backend use this computer's whole network; bubblewrap cannot provide loopback alone"
			: "Let its served backend listen on this computer's loopback");
		apps.grant(served.app.id, true);
		writeFileSync(join(dir, "app.json"), JSON.stringify({ name: "networked", backend: { runtime: "container", image: "local/image:1", build: "." } }));
		const built = await apps.open({ sessionId: "s1", id: served.app.id });
		expect(built.app.granted).toBe(false);
		expect(built.asks).toContain("Let its container build reach the network: any address");
		expect(containerBuildNetworkArgs(false)).toEqual(["--network", "none"]);
		expect(containerBuildNetworkArgs(true)).toEqual(["--network", "default"]);
		expect(containerPullArgs(false)).toEqual(["--pull=never"]);
		expect(containerPullArgs(true)).toEqual([]);
		await apps.stop();
	});

	test("saved grants without network scope keys cannot authorize served or build network", async () => {
		const home = scratch("old-network-grant-home");
		const project = scratch("old-network-grant-project");
		const dir = join(project, "apps", "networked");
		writeApp(dir, { "index.html": "<!doctype html>" });
		for (const backend of [
			{ runtime: "serve", command: ["python", "app.py"] },
			{ runtime: "container", image: "local/image:1", build: "." },
		]) {
			writeFileSync(join(dir, "app.json"), JSON.stringify({ name: "networked", backend }));
			const before = host(home, project);
			const opened = await before.open({ sessionId: "s1", path: "apps/networked" });
			const manifest = readManifest(dir);
			const stateFile = join(home, "apps.json");
			const state = JSON.parse(readFileSync(stateFile, "utf8")) as { known: Record<string, unknown>; grants: Record<string, unknown> };
			// This is the grant-key formula used before network consent became a separate scope.
			state.grants[opened.app.id] = { key: `${permissionKey(manifest.permissions)}|${JSON.stringify(manifest.backend)}|`, allow: true, at: "2026-01-01T00:00:00.000Z" };
			writeFileSync(stateFile, JSON.stringify(state));
			await before.stop();
			const upgraded = host(home, project);
			expect((await upgraded.open({ sessionId: "s1", path: "apps/networked" })).app.granted).toBe(false);
			await upgraded.stop();
		}
	});

	test.skipIf(process.platform !== "linux")("a Linux served backend refuses to share the host network without its named consent", () => {
		expect(() => servedBackendNetwork(false, false)).toThrow("explicit consent for the whole network");
		expect(servedBackendNetwork(false, true)).toBe("all");
	});

	test.skipIf(process.platform !== "linux" || sandboxer() !== "bubblewrap")("the default Bun app backend starts with its private app-data grant under bubblewrap", async () => {
		const home = scratch("linux-backend-home");
		const app = join(home, "apps", "demo");
		const dataDir = join(home, "app-data", "demo");
		const savedHome = process.env.EL_HOME;
		let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
		try {
			process.env.EL_HOME = home;
			writeApp(app, templateFiles("data", "demo", "Demo", ""));
			backend = await startBackend(readManifest(app), {
				dir: app,
				dataDir,
				runDir: join(home, "runtime"),
				toolsDir: join(home, "tools"),
				network: false,
				log: () => undefined,
			});
			expect(backend.kind).toBe("mcp");
			if (backend.kind === "mcp") expect((await backend.call("summarize", { values: [2, 4] })).structuredContent).toMatchObject({ mean: 3, n: 2 });
		} finally {
			await backend?.close();
			if (savedHome === undefined) delete process.env.EL_HOME;
			else process.env.EL_HOME = savedHome;
		}
	}, 60_000);

	test.skipIf(process.platform !== "linux" || sandboxer() !== "bubblewrap")("a Linux command backend receives its held engine grant descriptors", () => {
		const home = scratch("linux-command-grant-home");
		const app = join(home, "apps", "grant-backend");
		const environment = join(app, ".pixi");
		const runner = join(app, "runner.mjs");
		const main = join(app, "main.mjs");
		mkdirSync(environment, { recursive: true });
		writeFileSync(join(app, "app.json"), JSON.stringify({ name: "grant-backend", version: "1.0.0", backend: { runtime: "command", command: ["unused"] } }));
		writeFileSync(join(app, "index.html"), "<!doctype html><title>Grant backend</title>");
		writeFileSync(runner, RUNNER_SOURCE);
		writeFileSync(main, `import { writeFileSync } from "node:fs";
import { join } from "node:path";
export const tools = { prove: { input: { type: "object", properties: {} }, run() { writeFileSync(join(import.meta.dir, ".pixi", "proof"), "held"); return { text: "ok", data: { held: true } }; } } };\n`);
		const environmentsModule = join(import.meta.dir, "../packages/engine/src/apps/environments.ts");
		const backendsModule = join(import.meta.dir, "../packages/engine/src/apps/backends.ts");
		const manifestModule = join(import.meta.dir, "../packages/engine/src/apps/manifest.ts");
		const workspaceModule = join(import.meta.dir, "../packages/engine/src/tools/workspace.ts");
		const script = `import { mock } from "bun:test";
const { createEngineWriteGrant } = await import(${JSON.stringify(workspaceModule)});
const grant = createEngineWriteGrant(${JSON.stringify(environment)});
mock.module(${JSON.stringify(environmentsModule)}, () => ({
	hasEnvironment: () => true,
	inEnvironment: async () => ({ command: [process.execPath, ${JSON.stringify(runner)}, ${JSON.stringify(main)}], engineWrite: grant }),
}));
const { startBackend } = await import(${JSON.stringify(backendsModule)});
const { readManifest } = await import(${JSON.stringify(manifestModule)});
let backend;
try {
	backend = await startBackend(readManifest(${JSON.stringify(app)}), {
		dir: ${JSON.stringify(app)}, engineOwned: true, dataDir: ${JSON.stringify(join(home, "app-data", "grant-backend"))},
		runDir: ${JSON.stringify(join(home, "runtime"))}, toolsDir: ${JSON.stringify(join(home, "tools"))}, network: false, log: () => undefined,
	});
	if (backend.kind !== "mcp") throw new Error("expected MCP backend");
	const result = await backend.call("prove", {});
	process.stdout.write(JSON.stringify(result.structuredContent));
} finally { await backend?.close(); }`;
		const ran = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, HOME: home, EL_HOME: home }, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
		expect(ran.exitCode, ran.stderr.toString() || ran.stdout.toString()).toBe(0);
		expect(JSON.parse(ran.stdout.toString())).toEqual({ held: true });
		expect(readFileSync(join(environment, "proof"), "utf8")).toBe("held");
	}, 60_000);

	test("a data app: consent, serving with CSP, a real Bun backend, and lab_ tools within permissions", async () => {
		const home = scratch("home");
		const project = scratch("project");
		writeFileSync(join(project, "data.csv"), "a,b\n1,2\n3,4\n");
		writeApp(join(project, "apps", "demo"), templateFiles("data", "demo", "Demo", ""));
		const apps = host(home, project);
		const first = await apps.open({ sessionId: "s1", path: "apps/demo" });
		// The data template reads files, so it asks first and serves nothing until allowed.
		expect(first.app.granted).toBe(false);
		expect(first.asks).toEqual(["Read files in the project"]);
		expect(apps.file(first.token, "index.html")).toBeUndefined();
		apps.grant(first.app.id, true);
		const opened = await apps.open({ sessionId: "s1", id: first.app.id });
		expect(opened.url).toBe(`http://127.0.0.1:9/apps/${opened.token}/index.html`);
		const page = apps.file(opened.token, "index.html")!;
		expect(page.headers["content-security-policy"]).toContain("sandbox allow-scripts");
		expect(page.headers["content-security-policy"]).toContain("connect-src 'self';");
		expect(page.headers["content-security-policy"]).toContain("form-action 'none'");
		expect(page.headers["content-security-policy"]).not.toContain("allow-popups");
		expect(apps.file(opened.token, "../../../etc/passwd")).toBeUndefined();
		// The backend: the template's summarize tool, on Bun, contained, over MCP.
		const result = await apps.call(opened.token, "summarize", { values: [1, 2, 3, 4] }, AbortSignal.timeout(30_000));
		expect(result.structuredContent).toMatchObject({ mean: 2.5, n: 4 });
		// Host tools within permissions; files outside the project and commands are refused.
		const read = await apps.call(opened.token, "lab_read_file", { path: "data.csv" }, AbortSignal.timeout(5_000));
		expect(read.structuredContent).toMatchObject({ text: "a,b\n1,2\n3,4\n" });
		await expect(apps.call(opened.token, "lab_read_file", { path: "/etc/hosts" }, AbortSignal.timeout(5_000))).rejects.toThrow("outside the project");
		await expect(apps.call(opened.token, "lab_run", { command: "id" }, AbortSignal.timeout(5_000))).rejects.toThrow("didn't ask to run commands");
		await apps.call(opened.token, "lab_store_set", { key: "path", value: "data.csv" }, AbortSignal.timeout(5_000));
		expect((await apps.call(opened.token, "lab_store_get", { key: "path" }, AbortSignal.timeout(5_000))).structuredContent).toEqual({ value: "data.csv" });
		await apps.stop();
	}, 60_000);

	test("contained programs can't read ~/.el, except paths passed as readable", () => {
		if (process.platform !== "darwin") return;
		const home = scratch("private-home");
		const probe = join(home, "run", "contained_probe_codetestfile.txt");
		const savedHome = process.env.EL_HOME;
		process.env.EL_HOME = home;
		mkdirSync(dirname(probe), { recursive: true });
		writeFileSync(probe, "ok");
		try {
			const run = (readable: string[]) => {
				const c = contained("/bin/cat", [probe], { writable: [], network: "none", readable });
				return Bun.spawnSync([c.file, ...c.args]).stdout.toString();
			};
			expect(run([])).toBe("");
			expect(run([probe])).toBe("ok");
		} finally {
			if (savedHome === undefined) delete process.env.EL_HOME;
			else process.env.EL_HOME = savedHome;
		}
	});

	test("asking for more asks again", async () => {
		const home = scratch("home");
		const project = scratch("project");
		const dir = join(project, "apps", "grow");
		writeApp(dir, templateFiles("blank", "grow", "Grow", ""));
		writeFileSync(join(dir, "app.json"), JSON.stringify({ name: "grow", permissions: { files: "read" } }));
		const apps = host(home, project);
		const opened = await apps.open({ sessionId: "s1", path: "apps/grow" });
		expect(apps.grant(opened.app.id, true).granted).toBe(true);
		writeFileSync(join(dir, "app.json"), JSON.stringify({ name: "grow", permissions: { files: "read", commands: true } }));
		expect((await apps.open({ sessionId: "s1", id: opened.app.id })).app.granted).toBe(false);
		await apps.stop();
	});
});

describe("packages", () => {
	test("pack, install, and refuse a tampered or untrusted package", async () => {
		const author = paths(scratch("author"));
		const reader = paths(scratch("reader"));
		const dir = scratch("app");
		writeApp(dir, templateFiles("blank", "share-me", "Share me", ""));
		const packed = await packApp(author, dir, scratch("out"));
		// Someone else installs it: a new signer needs --trust.
		await expect(installApp(reader, packed.file)).rejects.toThrow("haven't trusted");
		const added = await installApp(reader, packed.file, { trust: true });
		expect(added.newSigner).toBe(true);
		expect(readFileSync(join(added.dir, "index.html"), "utf8")).toContain("Share me");
		// Change one byte of a file inside the archive: the hash check fails.
		const Archive = (Bun as unknown as { Archive: new (i: Uint8Array | Record<string, Uint8Array>, o?: { compress?: "gzip" }) => { files(): Promise<Map<string, Blob>>; bytes(): Promise<Uint8Array> } }).Archive;
		const files = await new Archive(new Uint8Array(readFileSync(packed.file))).files();
		const entries: Record<string, Uint8Array> = {};
		for (const [name, blob] of files) entries[name] = new Uint8Array(await blob.arrayBuffer());
		entries["main.js"] = new TextEncoder().encode("alert(1)");
		const tampered = join(dirname(packed.file), "tampered.labapp");
		writeFileSync(tampered, await new Archive(entries, { compress: "gzip" }).bytes());
		await expect(installApp(reader, tampered)).rejects.toThrow("doesn't match its hash");
	});
});

describe("app environments", () => {
	test("the consent card lists PyPI packages, other sources and source builds; any manifest change asks again", async () => {
		const { describeEnvironment, environmentPlan } = await import("../packages/engine/src/apps/environments.ts");
		const dir = scratch("env-plan");
		const toml = (extra: string) =>
			writeFileSync(
				join(dir, "pixi.toml"),
				`[workspace]\nname = "x"\nchannels = ["conda-forge", "bioconda"]\nplatforms = ["osx-arm64"]\n\n[dependencies]\nr-shiny = "*"\n\n[pypi-dependencies]\npandas = "*"\nhelper = { path = "./helper" }\n\n[feature.dev.dependencies]\npytest = "*"\n\n[pypi-options]\nextra-index-urls = ["https://pkgs.example.org/simple"]\n${extra}`,
			);
		toml("");
		const plan = environmentPlan(dir)!;
		expect(plan.conda).toEqual(["r-shiny", "pytest"]);
		expect(plan.pypi).toEqual(["pandas", "helper"]);
		expect(plan.source).toEqual(["helper"]);
		expect(plan.elsewhere).toEqual(["the bioconda channel", "https://pkgs.example.org/simple"]);
		const lines = describeEnvironment(plan);
		expect(lines.some((l) => l.startsWith("Install pandas, helper from PyPI"))).toBe(true);
		expect(lines.some((l) => l.startsWith("Build helper from source"))).toBe(true);
		const before = plan.digest;
		toml("# a comment changes nothing but the digest\n");
		expect(environmentPlan(dir)!.digest).not.toBe(before);
	});
});
