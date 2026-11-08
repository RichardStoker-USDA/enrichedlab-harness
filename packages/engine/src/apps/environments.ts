// Environments for apps that need R, Python or other tools. An app that ships a pixi.toml (and, once installed, a
// pixi.lock) gets exactly that environment, built per user from conda-forge into the app's .pixi folder: no
// administrator, the same on macOS, Linux and Windows, and the same lock a lab sandbox builds its image from.
// pixi comes from PATH, or is downloaded once into ~/.el/tools and checked against the hashes below.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contained } from "../tools/workspace.ts";

export const PIXI_VERSION = "0.82.0";

/** Release file and SHA-256 for each platform, from github.com/prefix-dev/pixi/releases/tag/v0.82.0. */
const PIXI_BUILDS: Record<string, [string, string]> = {
	"darwin-arm64": ["pixi-aarch64-apple-darwin", "92aa551c67a56ec0ba105fa20c3f48094b02586de523e24b96974ba1f092455b"],
	"darwin-x64": ["pixi-x86_64-apple-darwin", "db4bd6dc3a5f88f2d94cf2e1f8a377b53d3aaac95b45b058854fbf53919d6d36"],
	"linux-arm64": ["pixi-aarch64-unknown-linux-musl", "c6e3c4d98bb41560b5cfdebbe6cbf766f3547603a0fb96e1450a6ccff74b5e14"],
	"linux-x64": ["pixi-x86_64-unknown-linux-musl", "1dff1db704884f078c44b4c7fb3c5bc6f946fc3d1fa679edf214ad79187a9c64"],
	"win32-arm64": ["pixi-aarch64-pc-windows-msvc.exe", "d205d144618bdc83e25dba1a10c8cff8f39e9da85c06e142a9ec0d0c8f6d3559"],
	"win32-x64": ["pixi-x86_64-pc-windows-msvc.exe", "89c7455923dac401c1853310894d87fa06602911b838e389a46c7bc8df00171e"],
};

/** True when pixi is here without downloading: on PATH, or the pinned build already under `tools`. */
export function pixiPresent(tools: string): boolean {
	return Boolean(Bun.which("pixi")) || existsSync(join(tools, `pixi-${PIXI_VERSION}${process.platform === "win32" ? ".exe" : ""}`));
}

/** The pixi program: on PATH, else the pinned build under `tools`, downloaded and checked the first time. */
export async function pixi(tools: string, log: (line: string) => void = () => undefined): Promise<string> {
	const found = Bun.which("pixi");
	if (found) return found;
	const build = PIXI_BUILDS[`${process.platform}-${process.arch}`];
	if (!build) throw new Error(`No pixi build for ${process.platform} ${process.arch}.`);
	const file = join(tools, `pixi-${PIXI_VERSION}${process.platform === "win32" ? ".exe" : ""}`);
	if (existsSync(file)) return file;
	mkdirSync(tools, { recursive: true });
	log(`Getting pixi ${PIXI_VERSION}, which builds app environments without administrator rights`);
	const response = await fetch(`https://github.com/prefix-dev/pixi/releases/download/v${PIXI_VERSION}/${build[0]}`, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
	if (!response.ok) throw new Error(`Downloading pixi failed (${response.status}).`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (createHash("sha256").update(bytes).digest("hex") !== build[1]) throw new Error("The pixi download doesn't match its pinned SHA-256; nothing was kept.");
	await Bun.write(`${file}.part`, bytes);
	chmodSync(`${file}.part`, 0o755);
	renameSync(`${file}.part`, file);
	return file;
}

/** True when the app folder declares an environment. */
export const hasEnvironment = (dir: string): boolean => existsSync(join(dir, "pixi.toml"));

/**
 * Build (or check) the app's environment and return the command wrapped to run inside it. Installing reaches the
 * package indexes, and a package built from source runs its build scripts, so the install is contained too: it may
 * write only the app's folder and its own caches under `tools` (never the person's shared pixi or uv caches, which
 * other projects read), and it gets no keys or tokens. The app itself then runs offline in its sandbox.
 */
export async function inEnvironment(dir: string, command: string[], tools: string, log: (line: string) => void): Promise<string[]> {
	const program = await pixi(tools, log);
	const manifest = join(dir, "pixi.toml");
	log(existsSync(join(dir, "pixi.lock")) ? "Checking the app's environment" : "Building the app's environment (first run takes a few minutes)");
	// pixi keeps conda packages, repodata and its uv cache under PIXI_CACHE_DIR.
	const caches = join(tools, "pixi-cache");
	mkdirSync(caches, { recursive: true });
	const env: Record<string, string> = { PIXI_NO_PATH_UPDATE: "1", PIXI_CACHE_DIR: caches, PIXI_HOME: caches };
	for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT", "SSL_CERT_FILE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) if (process.env[key]) env[key] = process.env[key]!;
	const launch = contained(program, ["install", "--manifest-path", manifest], { writable: [dir, caches], readable: [program], network: "all" });
	// From a scratch folder: some packages' install scripts write test files where they run, and the app's folder
	// is watched for edits.
	const install = Bun.spawn([launch.file, ...launch.args], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe", env });
	const lines = async (stream: ReadableStream<Uint8Array>) => {
		for await (const chunk of stream) for (const line of new TextDecoder().decode(chunk).split(/\r|\n/)) if (line.trim()) log(line.trim());
	};
	await Promise.all([lines(install.stdout), lines(install.stderr), install.exited]);
	if (install.exitCode !== 0) throw new Error(`Building the app's environment failed; the app's log has pixi's output.`);
	return [program, "run", "--manifest-path", manifest, "--frozen", "--", ...command];
}

/** What an environment would install, for the consent card, and a digest of its manifest for the grant. */
export interface EnvironmentPlan {
	conda: string[];
	pypi: string[];
	/** Packages built from a folder, a git repository or an address: their build scripts run at install. */
	source: string[];
	/** Channels other than conda-forge, and package indexes other than PyPI. */
	elsewhere: string[];
	/** SHA-256 of pixi.toml: a grant covers exactly this manifest; any change asks again. */
	digest: string;
}

/** Read every dependency table in pixi.toml: the default one, features, targets, and PyPI's. */
export function environmentPlan(dir: string): EnvironmentPlan | undefined {
	if (!hasEnvironment(dir)) return undefined;
	const text = readFileSync(join(dir, "pixi.toml"), "utf8");
	const plan: EnvironmentPlan = { conda: [], pypi: [], source: [], elsewhere: [], digest: createHash("sha256").update(text).digest("hex") };
	let table = "";
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/\s+#.*$/, "").trim();
		const header = /^\[([^\]]+)\]$/.exec(line);
		if (header) {
			table = header[1]!.trim();
			continue;
		}
		const entry = /^("?)([A-Za-z0-9_.\-[\]]+)\1\s*=\s*(.*)$/.exec(line);
		if (!entry) continue;
		const [, , name, value] = entry as unknown as [string, string, string, string];
		const deps = /(^|\.)(dependencies|host-dependencies|build-dependencies)$/.test(table);
		const pypi = /(^|\.)pypi-dependencies$/.test(table);
		if (deps || pypi) {
			(pypi ? plan.pypi : plan.conda).push(name);
			if (/\b(path|git|url)\s*=/.test(value)) plan.source.push(name);
		} else if (name === "channels" && /^(workspace|project)$/.test(table)) {
			for (const channel of value.matchAll(/"([^"]+)"/g)) if (channel[1] !== "conda-forge") plan.elsewhere.push(`the ${channel[1]} channel`);
		} else if (/^(index-url|extra-index-urls|find-links)$/.test(name) && /(^|\.)pypi-options$/.test(table)) {
			for (const index of value.matchAll(/"([^"]+)"/g)) plan.elsewhere.push(index[1]!);
		}
	}
	for (const key of ["conda", "pypi", "source", "elsewhere"] as const) plan[key] = [...new Set(plan[key])];
	return plan;
}

/** The consent card's lines for an environment. */
export function describeEnvironment(plan: EnvironmentPlan): string[] {
	const lines: string[] = [];
	if (plan.conda.length) lines.push(`Install ${plan.conda.join(", ")} from conda-forge into the app's folder (no administrator)`);
	if (plan.pypi.length) lines.push(`Install ${plan.pypi.join(", ")} from PyPI into the app's folder`);
	if (plan.elsewhere.length) lines.push(`Get packages from ${plan.elsewhere.join(", ")} as well`);
	if (plan.source.length) lines.push(`Build ${plan.source.join(", ")} from source: their build scripts run on this computer, contained`);
	return lines;
}
