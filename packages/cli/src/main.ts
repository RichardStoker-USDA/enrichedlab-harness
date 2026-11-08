#!/usr/bin/env bun
// el: the EnrichedLab command. With no arguments it opens the terminal surface for the current folder.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { PermissionRequest, SessionEvent } from "@enrichedlab/protocol";
import {
	describePermissions,
	Engine,
	EngineClient,
	ensureEngine,
	findEngine,
	installApp,
	installBundle,
	listBundles,
	packApp,
	parseInvite,
	paths,
	PUSH_REASON,
	readManifest,
	removeApp,
	removeBundle,
	removeWorktree,
	repoRoot,
	serve,
	Sites,
	stopEngine,
	type Template,
	TEMPLATES,
	templateFiles,
	VERSION,
} from "@enrichedlab/engine";
import { openBrowser, openSurface } from "./open.ts";

const HELP = `EnrichedLab ${VERSION}

  el                              open the terminal surface in this folder
      --site <name>               work with one site only: its tools and models, and no other site's
      --worktree                  work on a new branch in its own git worktree, away from your checkout
  el app                          open the desktop or browser surface
  el run "prompt"                 run one task without a surface and print the answer
      --model <ref>  --effort <level>  --site <name>  --worktree  --json
      --allow                     run commands and edits without asking
      --push                      let it push to a remote (refused otherwise, even with --allow)
  el worktrees [--prune]          worktrees sessions made in this repository; --prune removes merged ones

  el join <invite link | https address> [--name <short name>]
                                  add a lab from its invite (its /join page has the link) and sign in
  el login <site>                 sign in to a site in your browser
  el logout <site>
  el site add <name> <https://address> [--title "<Lab name>"] [--lan <https://address> --key <file> --ca <file>] [--isolated]
                                  --isolated: research data; its sessions work in its sandbox with its models only
  el site rename <name> <new-name> [--title "Display name"]
  el sites                        sites, who you are on each, and what they grant
  el lab check <lab> [--json]     check a lab against the lab contract (for people who run labs)
  el devices <lab>                your computers at a lab; el device approve|revoke <lab> <id>
  el sandboxes <lab>              your sandboxes at a lab; el sandbox stop|delete <lab> <id>
  el sandbox create <lab> [--image browser] [--network internet]
                                  a new sandbox to work in; internet ones take no lab files
  el usage <lab> [--window 7d|30d]
                                  your use of a lab: tokens, GPU and sandbox hours

  el bundles                      installed add-ons (skills, instructions, MCP servers, hooks)
  el bundle add <folder | https git address>
                                  install one; a Claude Code plugin folder works too
  el bundle remove <name>

  el apps                         your apps, and the apps your labs offer
  el app new <name> [--template data|blank|shiny|shiny-python]
                                  start an app in ./apps/<name>; the agent can build it with you
  el app pack <folder> [--out <folder>]
                                  one signed .labapp file to share
  el app add <file.labapp> [--trust]
                                  check and install one; --trust accepts a signer you haven't used before
  el app add <lab>/<name>[@version]
                                  install an app your lab offers (el apps lists them)
  el app remove <name>

  el models [--refresh]           models you can use now
  el model <ref> [effort]         set the default model
  el local                        model servers on this computer, and open models that fit it
  el model pull|remove <name>     download an open model through Ollama, or delete one
  el sessions                     recent sessions in this folder (--all for every folder)
  el session export <id> [folder] a session in the shared log format (v1), to open elsewhere
  el session import <folder>      a new session from a v1 log [--cwd <folder>]
  el session package <id> [dir]   the session as an RO-Crate: log, changed files, environment, every step with what
                                 it read and changed, and the step history (--no-history leaves it out)
  el session verify <dir>        check a run package: checksums, history, every content id its steps name
  el session reproduce <dir> <step>  rerun a command step from the package's history and compare the files
  el session push <id> <lab>      send a session to the lab's Rein, to go on in the browser [--title <title>]
  el session pull <lab> <id>      a Rein session back here as a new session [--cwd <folder>]
  el service add chatgpt          use your ChatGPT plan (sign in in the browser; --new adds another account)
  el service add <service>        use your own key: openai, anthropic, gemini, openrouter, custom --address <url>
  el doctor                       check the setup
  el update [--check]             install the newest release (signed; no administrator)
  el engine status|stop|restart|ensure [--json]
  el serve [--foreground] [--port N]

Settings and sessions live in ~/.el (EL_HOME moves them).`;

/** el app new | pack | add | remove | list. */
async function appCommand(action: string, target: string | undefined, flags: Flags): Promise<void> {
	const p = paths();
	switch (action) {
		case "new": {
			const name = target ?? fail("el app new <name> [--template data|blank|shiny|shiny-python]");
			const template = (typeof flags.template === "string" ? flags.template : "data") as Template;
			if (!TEMPLATES.includes(template)) fail(`--template is one of ${TEMPLATES.join(", ")}.`);
			const dir = resolve("apps", name);
			if (existsSync(join(dir, "app.json"))) fail(`${dir} already has an app.`);
			const title = name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
			for (const [rel, body] of Object.entries(templateFiles(template, name, title, ""))) {
				mkdirSync(dirname(join(dir, rel)), { recursive: true });
				writeFileSync(join(dir, rel), body);
			}
			readManifest(dir);
			out(`Started ${title} in ${dir}. Open it from the workbench (⌘K, "Open app"), or ask the agent to build on it.`);
			return;
		}
		case "pack": {
			const packed = await packApp(p, resolve(target ?? "."), resolve(typeof flags.out === "string" ? flags.out : "."));
			out(`Packed ${packed.files} files into ${packed.file} (${Math.round(packed.bytes / 1024)} KB), signed ${packed.fingerprint}.`);
			return;
		}
		case "add": {
			const wanted = target ?? fail("el app add <file.labapp> [--trust] | el app add <lab>/<name>[@version]");
			const fromLab = /^([a-z0-9][\w-]*)\/([a-z0-9][a-z0-9-]*)(?:@(.+))?$/i.exec(wanted);
			if (fromLab && !existsSync(resolve(wanted))) {
				// From a lab's app list: the engine checks the package against the listing and the lab's signers.
				const [, site, name, version] = fromLab;
				const client = await connect();
				const app = await client.call("lab.app.install", { site: site!, name: name!, ...(version ? { version } : {}) });
				client.close();
				out(`Installed ${app.title} ${app.version} from ${site}, signed ${app.signer ?? "?"}.`);
				const asks = describePermissions(app.permissions);
				if (asks.length) out(`When it first opens it asks to:\n  ${asks.join("\n  ")}`);
				return;
			}
			const file = resolve(wanted);
			const added = await installApp(p, file, { trust: flags.trust === true });
			const manifest = readManifest(added.dir);
			out(`Installed ${manifest.title} ${added.version}, signed ${added.fingerprint}${added.newSigner ? " (now trusted)" : ""}.`);
			const asks = describePermissions(manifest.permissions);
			if (asks.length) out(`When it first opens it asks to:\n  ${asks.join("\n  ")}`);
			return;
		}
		case "remove": {
			if (!removeApp(p, target ?? fail("el app remove <name>"))) fail(`No installed app named ${target}.`);
			out(`Removed ${target}.`);
			return;
		}
		case "list": {
			const client = await connect();
			const apps = await client.call("app.list", {});
			const offered = await client.call("lab.apps", {}).catch(() => []);
			client.close();
			if (!apps.length && !offered.length) out("No apps yet. Start one with el app new <name>, or add one with el app add <file>.");
			for (const a of apps) out(`${a.title} ${a.version}  ${a.source}${a.backend ? `  ${a.backend} backend` : ""}${a.granted ? "" : "  (asks when opened)"}\n  ${a.description || a.dir}`);
			// What each lab offers: the newest installable version per app, and what's installed already.
			const seen = new Set<string>();
			for (const a of offered) {
				const key = `${a.site}/${a.name}`;
				if (seen.has(key) || a.withdrawn || a.signerRevoked) continue;
				seen.add(key);
				const state = a.installed === a.version ? "installed" : a.installed ? `update from ${a.installed}: el app add ${key}` : `el app add ${key}`;
				out(`${a.title} ${a.version}  from ${a.lab}  ${state}\n  ${a.description || "(no description)"}  signed ${a.signer.name ?? a.signer.fingerprint}`);
			}
			return;
		}
		default:
			fail("el app new|pack|add|remove <…>, or el apps");
	}
}

interface Flags {
	[key: string]: string | boolean;
}

/** Flags that take the next word as their value; every other flag is a switch. */
const VALUE_FLAGS = new Set(["address", "name", "model", "effort", "port", "lan", "key", "ca", "cwd", "session", "site", "title", "template", "out", "window", "image", "network"]);

function parse(argv: string[]): { args: string[]; flags: Flags } {
	const args: string[] = [];
	const flags: Flags = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "-p") continue;
		if (a.startsWith("--")) {
			const [key, inline] = a.slice(2).split("=", 2);
			const next = argv[i + 1];
			if (inline !== undefined) flags[key] = inline;
			else if (next !== undefined && !next.startsWith("--") && VALUE_FLAGS.has(key)) {
				flags[key] = next;
				i++;
			} else flags[key] = true;
		} else args.push(a);
	}
	return { args, flags };
}

const out = (text: string): void => {
	process.stdout.write(`${text}\n`);
};
const fail = (text: string): never => {
	process.stderr.write(`el: ${text}\n`);
	process.exit(1);
};

async function connect(name = "el"): Promise<EngineClient> {
	const file = await ensureEngine();
	const client = new EngineClient(file, name);
	await client.ready();
	return client;
}

/** Sign in to a lab in the browser, where the lab may also ask for a second step (a passkey, key or code app). */
async function login(name: string): Promise<void> {
	const client = await connect();
	client.on("site.auth", (auth) => {
		if (auth.name !== name) return;
		out(`Opening your browser to sign in to ${name}. The first time, it may ask you to set up a second step: a passkey, a security key or an authenticator app. If the browser doesn't open, visit:\n${auth.url}`);
		openBrowser(auth.url);
	});
	const site = await client.call("site.login", { name });
	if (site.signedIn && site.via === "oauth") out(`Signed in to ${name} as ${site.who ?? "you"}: ${site.models} models, ${site.tools} tools${site.sandbox ? ", sandbox" : ""}.`);
	else if (site.signedIn) out(`${site.warning ?? "The browser sign-in wasn't used."}\nConnected to ${name} as ${site.who ?? "you"} with the LAN key.`);
	else out(`The browser sign-in finished, but ${name} can't be reached with it: ${site.error ?? "no answer"}`);
	client.close();
}

async function runHeadless(prompt: string, flags: Flags): Promise<void> {
	const allow = flags.allow === true;
	const push = flags.push === true;
	const json = flags.json === true;
	const engine = new Engine({
		headlessAnswer: (request: PermissionRequest) => {
			const pushing = request.reason === PUSH_REASON;
			if (pushing ? push : allow) return "allow";
			process.stderr.write(`el: refused ${request.tool} (${request.reason}): pass ${pushing ? "--push" : "--allow"} to permit\n`);
			return "deny";
		},
	});
	await engine.start();
	const cwd = resolve(String(flags.cwd ?? process.cwd()));
	const session = engine.createSession(cwd, typeof flags.model === "string" ? flags.model : undefined, typeof flags.site === "string" ? flags.site : undefined, undefined, flags.worktree === true);
	if (typeof flags.effort === "string") session.setModel(undefined, flags.effort);
	let lastKind = "";
	engine.onNotify((name, params) => {
		if (json) {
			if (name === "session.event") out(JSON.stringify((params as { event: SessionEvent }).event));
			return;
		}
		if (name === "session.delta") {
			const d = params as { kind: string; text: string };
			if (d.kind === "text") {
				if (lastKind === "reasoning") process.stderr.write("\n");
				process.stdout.write(d.text);
			} else if (d.kind === "reasoning" && process.stderr.isTTY) process.stderr.write(`\x1b[2m${d.text}\x1b[0m`);
			lastKind = d.kind;
		} else if (name === "session.event") {
			const e = (params as { event: SessionEvent }).event;
			if (e.t === "tool") process.stderr.write(`\n${e.ok ? "✓" : "✗"} ${e.view?.verb ?? e.name} ${e.view?.target ?? ""}${e.view?.result ? `  ${e.view.result}` : ""}\n`);
			if (e.t === "notice") process.stderr.write(`\n[${e.level}] ${e.text}\n`);
			if (e.t === "assistant" && e.stop === "error") process.stderr.write(`\n[error] ${e.error}\n`);
		}
	});
	session.prompt(prompt);
	while (session.isRunning) await new Promise((r) => setTimeout(r, 100));
	if (!json) process.stdout.write("\n");
	// The session's name comes from one short model request after the first turn.
	await Promise.race([session.naming, new Promise((r) => setTimeout(r, 20_000))]);
	await engine.stop();
	const last = [...session.events].reverse().find((e) => e.t === "assistant") as Extract<SessionEvent, { t: "assistant" }> | undefined;
	process.exit(last && last.stop !== "error" ? 0 : 1);
}

async function main(): Promise<void> {
	// Windows containment: el __contain <writable folders as JSON> -- program args (see windows_contain.ts).
	if (process.argv[2] === "__contain") {
		const { runContained, paths } = await import("@enrichedlab/engine");
		const split = process.argv.indexOf("--");
		process.exit(await runContained(paths().home, JSON.parse(process.argv[3]!) as string[], process.argv.slice(split + 1)));
	}
	const { args, flags } = parse(process.argv.slice(2));
	const [command, ...rest] = args;
	if (flags.version || command === "version") return out(VERSION);
	if (flags.help || command === "help") return out(HELP);

	switch (command) {
		case undefined: {
			const { runTui } = await import("@enrichedlab/tui");
			return runTui({
				cwd: resolve(String(flags.cwd ?? process.cwd())),
				sessionId: typeof flags.session === "string" ? flags.session : undefined,
				resume: flags.resume === true || flags.continue === true,
				site: typeof flags.site === "string" ? flags.site : undefined,
				worktree: flags.worktree === true,
				openWindow: (url, sessionId) => openSurface(url, sessionId),
			});
		}
		case "serve":
			return serve({ port: flags.port ? Number(flags.port) : undefined, foreground: flags.foreground === true });
		case "run": {
			const prompt = rest.join(" ") || (process.stdin.isTTY ? "" : await new Response(Bun.stdin.stream()).text());
			if (!prompt.trim()) fail('give a task: el run "what does this project do?"');
			return runHeadless(prompt, flags);
		}
		case "apps":
		case "app": {
			const [action, target] = command === "apps" ? ["list"] : rest;
			if (action) {
				await appCommand(action, target, flags);
				return;
			}
			const client = await connect();
			const next = typeof flags.session === "string" ? `/#/s/${flags.session}` : "/";
			const { url } = await client.call("engine.pair", { next });
			const how = openSurface(url, typeof flags.session === "string" ? flags.session : undefined, flags.browser ? "browser" : undefined);
			out(how === "none" ? `Open this address in a browser: ${url}` : `Opened in ${how}.`);
			client.close();
			return;
		}
		case "join": {
			const invite = parseInvite(rest[0] ?? fail("el join <invite link | https address>")) ?? fail("That isn't an invite link or an https address.");
			const sites = new Sites(paths(), () => undefined);
			const known = sites.configs().find((c) => c.url === invite.url);
			const name = known?.name ?? (typeof flags.name === "string" ? flags.name : invite.name);
			if (!known) {
				if (sites.configs().some((c) => c.name === name)) fail(`You already have a lab named ${name}. Pick another short name: el join ${rest[0]} --name <name>`);
				sites.add({ name, title: invite.title, url: invite.url, kind: "gate", isolated: invite.isolated });
				out(`Added ${invite.title ?? name} (${invite.url}) as ${name}.`);
			}
			const running = await findEngine();
			if (running) {
				const client = new EngineClient(running, "el");
				await client.call("site.refresh", { name });
				client.close();
			}
			await login(name);
			return;
		}
		case "login": {
			await login(rest[0] ?? fail("which site? el login <site>"));
			return;
		}
		case "logout": {
			const client = await connect();
			await client.call("site.logout", { name: rest[0] ?? fail("which site?") });
			out(`Signed out of ${rest[0]}.`);
			client.close();
			return;
		}
		case "worktrees": {
			const root = repoRoot(process.cwd());
			if (!root) fail("Not inside a git repository.");
			const listing = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" });
			const trees = listing.split("\n\n").map((block) => ({ path: /^worktree (.+)$/m.exec(block)?.[1] ?? "", branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? "" })).filter((t) => t.path.includes("enrichedlab-worktrees"));
			const merged = new Set(execFileSync("git", ["branch", "--merged", "HEAD", "--format=%(refname:short)"], { cwd: root, encoding: "utf8" }).split("\n"));
			if (!trees.length) out("No worktrees from EnrichedLab here.");
			for (const t of trees) {
				const done = merged.has(t.branch);
				if (flags.prune === true && done) {
					removeWorktree(root!, t.path, t.branch, true);
					out(`removed ${t.branch} (merged)`);
				} else out(`${t.branch}${done ? "  merged" : ""}\n  ${t.path}`);
			}
			return;
		}
		case "bundles":
		case "bundle": {
			const [action, target] = command === "bundles" ? ["list"] : rest;
			if (action === "add" && target) {
				const added = installBundle(paths(), target);
				out(`Installed ${added.name} ${added.version}${added.description ? `: ${added.description}` : ""}`);
			} else if (action === "remove" && target) {
				if (!removeBundle(paths(), target)) fail(`No bundle named ${target}.`);
				out(`Removed ${target}.`);
			} else if (action === "list" || action === undefined) {
				const all = listBundles(paths());
				if (!all.length) out("No bundles. Add one with el bundle add <folder | https git address>.");
				for (const b of all) out(`${b.name} ${b.version}  ${b.source}\n  ${b.description || "(no description)"}  sha256 ${b.sha256.slice(0, 12)}`);
				return;
			} else fail("el bundle add <folder | https git address> | el bundle remove <name> | el bundles");
			// A running engine picks the change up now; new sessions see the bundle's skills and instructions.
			const running = await findEngine();
			if (running) {
				const client = new EngineClient(running, "el");
				await client.call("config.reload", {});
				client.close();
			}
			return;
		}
		case "site": {
			if (rest[0] === "rename") {
				const [, from, to] = rest;
				if (!from || !to) fail('el site rename <name> <new-name> [--title "Display name"]');
				const renamed = new Sites(paths(), () => undefined).rename(from, to, typeof flags.title === "string" ? flags.title : undefined);
				const running = await findEngine();
				if (running) {
					const client = new EngineClient(running, "el");
					await client.call("site.refresh", {});
					client.close();
				}
				out(`${from} is now ${renamed.name}, shown as ${renamed.title ?? renamed.name}. Its tools are named ${renamed.name}_….`);
				return;
			}
			if (rest[0] !== "add") fail("el site add <name> <https://address> [--lan <https://address> --key <file> --ca <file>]");
			const [, name, url] = rest;
			if (!name || !url) fail("el site add <name> <https://address>");
			const sites = new Sites(paths(), () => undefined);
			const lan = typeof flags.lan === "string" && typeof flags.key === "string" ? { url: flags.lan, keyFile: flags.key, caFile: typeof flags.ca === "string" ? flags.ca : undefined } : undefined;
			sites.add({ name, title: typeof flags.title === "string" ? flags.title : undefined, url: new URL(url).origin, kind: "gate", lan, isolated: flags.isolated === true || undefined });
			const running = await findEngine();
			if (running) {
				const client = new EngineClient(running, "el");
				await client.call("site.refresh", { name });
				client.close();
			}
			out(`Added ${name}. ${lan ? "It will use the LAN key until you run el login " + name + "." : `Run el login ${name} to sign in.`}`);
			return;
		}
		case "lab": {
			// el lab check <lab> [--json]: the lab against the lab contract, one row per endpoint.
			if (rest[0] !== "check" || !rest[1]) fail("el lab check <lab> [--json]");
			const client = await connect();
			const { rows } = await client.call("lab.check", { name: rest[1]! });
			client.close();
			if (flags.json) out(JSON.stringify(rows, null, 2));
			else {
				const width = Math.max(...rows.map((r) => r.row.length));
				for (const r of rows) out(`${r.status === "pass" ? "pass" : r.status === "fail" ? "FAIL" : "skip"}  ${r.row.padEnd(width)}  ${r.detail ?? ""}`.trimEnd());
				const failed = rows.filter((r) => r.status === "fail").length;
				out(`\n${rows.filter((r) => r.status === "pass").length} pass, ${failed} fail, ${rows.filter((r) => r.status === "skip").length} skip`);
			}
			process.exit(rows.some((r) => r.status === "fail") ? 1 : 0);
		}
		case "devices":
		case "device": {
			// A lab that binds sign-ins to devices: list them, and approve a new one or revoke one that isn't yours.
			const [action, lab, id] = command === "devices" ? ["list", rest[0]] : rest;
			const client = await connect();
			if (action === "list" && lab) {
				const devices = await client.call("lab.devices", { name: lab });
				for (const d of devices) out(`${d.id}  ${d.status ?? "active"}${d.current ? "  this computer" : ""}  ${d.name ?? ""}\n  added ${d.created?.slice(0, 16).replace("T", " ") ?? "?"}${d.last_seen ? `, last used ${d.last_seen.slice(0, 16).replace("T", " ")}` : ""}`);
				if (devices.some((d) => d.status === "pending")) out(`\nApprove one only if you just signed in on it: el device approve ${lab} <id>. If not, revoke it: el device revoke ${lab} <id>`);
			} else if ((action === "approve" || action === "revoke") && lab && id) {
				await client.call(action === "approve" ? "lab.device.approve" : "lab.device.revoke", { name: lab, id });
				out(action === "approve" ? `Approved ${id}; it can use your ${lab} sign-in now.` : `Revoked ${id}; it can't use your ${lab} sign-in any more.`);
			} else fail("el devices <lab> | el device approve <lab> <id> | el device revoke <lab> <id>");
			client.close();
			return;
		}
		case "sandboxes":
		case "sandbox": {
			// The person's sandboxes at a lab: a lab limits how many one person keeps, and archived ones count.
			const [action, lab, id] = command === "sandboxes" ? ["list", rest[0]] : rest;
			const client = await connect();
			const at = (iso?: string) => iso?.slice(0, 16).replace("T", " ") ?? "?";
			if (action === "list" && lab) {
				const all = await client.call("lab.sandboxes", { name: lab });
				// Ones the lab ended itself stay listed so the person sees why; they hold nothing and count toward no limit.
				const boxes = all.filter((b) => b.status !== "deleted");
				const ended = all.filter((b) => b.status === "deleted");
				if (!boxes.length) out(`You have no sandboxes at ${lab}.`);
				for (const b of boxes) out(`${b.id}  ${b.status ?? "running"}${b.image ? `  (${b.image} image)` : ""}${b.network === "internet" ? "  internet" : ""}${b.current ? "  in use here" : ""}${b.status === "deleting" ? "  (counts toward your limit until it's gone)" : ""}  ${b.name ?? ""}\n  ${b.memory ? `${b.memory}, ` : ""}made ${at(b.created)}, last used ${at(b.last_active)}${b.reason ? `\n  ${b.reason}` : ""}`);
				if (boxes.some((b) => b.stoppable)) out(`\nStop a running one to free a place, keeping its files: el sandbox stop ${lab} <id>`);
				if (boxes.length) out(`${boxes.some((b) => b.stoppable) ? "" : "\n"}Delete one you no longer need, with its files: el sandbox delete ${lab} <id>`);
				if (ended.length) out(`\nEnded by ${lab}, with nothing kept; these don't count toward your limits:`);
				for (const b of ended) out(`${b.id}  ${b.name ?? ""}\n  ${b.reason ?? `${lab} didn't say why.`}\n  made ${at(b.created)}, last used ${at(b.last_active)}`);
			} else if (action === "delete" && lab && id) {
				const { status } = await client.call("lab.sandbox.delete", { name: lab, id });
				out(status === "deleting" ? `Deleting ${id}; ${lab} finishes clearing its files.` : `Deleted ${id} and its files.`);
			} else if (action === "create" && lab) {
				const image = typeof flags.image === "string" ? flags.image : undefined;
				const network = typeof flags.network === "string" ? flags.network : undefined;
				const made = await client.call("lab.sandbox.create", { name: lab, ...(image ? { image } : {}), ...(network ? { network } : {}) });
				const how = [made.image ? `from the ${made.image} image` : "", made.network === "internet" ? "with internet access (no lab files go into it)" : ""].filter(Boolean).join(", ");
				out(`Made ${made.id}${how ? ` ${how}` : ""}; sessions at ${lab} work in it now.${made.previous ? ` ${made.previous} keeps its files; el sandbox stop ${lab} ${made.previous} stops it, el sandbox delete ${lab} ${made.previous} removes it.` : ""}`);
			} else if (action === "stop" && lab && id) {
				const { status } = await client.call("lab.sandbox.stop", { name: lab, id });
				out(status === "archived" ? `${id} is archived already; its files are kept.` : `${status === "stopping" ? "Stopping" : "Stopped"} ${id}. Its files stay, and it no longer counts toward how many run at once; using it starts it again.`);
			} else fail("el sandboxes <lab> | el sandbox create <lab> [--image <name>] [--network internet] | el sandbox stop <lab> <id> | el sandbox delete <lab> <id>");
			client.close();
			return;
		}
		case "usage": {
			const name = rest[0] ?? fail("el usage <lab> [--window 7d|30d]");
			const client = await connect();
			const answer = (await client.call("lab.usage", { name, window: flags.window === "7d" ? "7d" : "30d" })) as {
				window?: string;
				rows?: { lab: string; research_group?: string; tokens: { input: number; output: number }; gpu_seconds: number; sandbox_seconds: number }[];
			};
			client.close();
			if (flags.json) return out(JSON.stringify(answer, null, 2));
			const hours = (s: number) => (s / 3600).toFixed(1);
			out(`Last ${answer.window ?? "30d"}:`);
			for (const r of answer.rows ?? []) out(`  ${r.lab}${r.research_group ? ` / ${r.research_group}` : ""}: ${r.tokens.input.toLocaleString()} in, ${r.tokens.output.toLocaleString()} out tokens; ${hours(r.gpu_seconds)} GPU h; ${hours(r.sandbox_seconds)} sandbox h`);
			if (!answer.rows?.length) out("  nothing yet");
			return;
		}
		case "sites": {
			const client = await connect();
			const list = await client.call("site.refresh", {});
			if (!list.length) out("No sites yet. Add one with el site add <name> <https://address>.");
			for (const s of list) {
				const state = s.signedIn ? `signed in as ${s.who ?? "?"} (${s.via})` : s.error ? `not connected: ${s.error}` : "not signed in";
				out(`${s.name}  ${s.url}\n  ${state}; ${s.models} models, ${s.tools} tools${s.sandbox ? ", sandbox" : ""}${s.signedIn && s.warning ? `\n  ${s.warning}` : ""}`);
			}
			client.close();
			return;
		}
		case "services":
		case "service": {
			const client = await connect();
			const [action, which] = command === "services" ? ["list"] : rest;
			if (action === "add" && which === "chatgpt") {
				// Your ChatGPT plan, through ChatGPT's own sign-in page; no key involved.
				client.on("provider.auth", (auth) => {
					out(`Opening your browser to continue with ChatGPT. If it doesn't open, visit:\n${auth.url}`);
					openBrowser(auth.url);
				});
				// Signing in again reuses the saved account's registration; --new adds another account or workspace.
				const saved = (await client.call("provider.list", {})).accounts.find((a) => a.service === "chatgpt" && a.active) ?? (await client.call("provider.list", {})).accounts[0];
				const result = await client.call("provider.signin", { service: "chatgpt", account: flags.new === true ? undefined : saved?.id });
				out(`Signed in to ChatGPT as ${result.account.label}: ${result.models} models on your plan.`);
				if (result.welcome) out("You're using your ChatGPT plan: eligible requests in EnrichedLab count toward it. Manage usage at https://chatgpt.com/settings/usage");
			} else if (action === "remove" && which === "chatgpt") {
				for (const a of (await client.call("provider.list", {})).accounts.filter((x) => x.service === "chatgpt" && x.signedIn)) {
					const { revoked } = await client.call("provider.signout", { service: "chatgpt", account: a.id });
					out(revoked ? `Signed out of ChatGPT (${a.label}).` : `Signed out of ChatGPT (${a.label}) here; OpenAI didn't confirm the session ended, so disconnect EnrichedLab in ChatGPT settings if you need to be sure.`);
				}
			} else if (action === "add" && which) {
				// The key is read from the terminal without echo, or from a pipe; it never appears on the command line.
				process.stdout.write("Key: ");
				if (process.stdin.isTTY) Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
				let key = "";
				for await (const line of console) {
					key = line;
					break;
				}
				if (process.stdin.isTTY) Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
				process.stdout.write("\n");
				const result = await client.call("provider.add", { preset: which, key, baseUrl: typeof flags.address === "string" ? flags.address : undefined, name: typeof flags.name === "string" ? flags.name : undefined });
				out(`Added ${result.name}: ${result.models} models. The key is in this computer's credential store.`);
			} else if (action === "remove" && which) {
				await client.call("provider.remove", { name: which });
				out(`Removed ${which} and its key.`);
			} else {
				const { presets, added, accounts } = await client.call("provider.list", {});
				for (const a of accounts) out(`chatgpt  ChatGPT plan  ${a.label}${a.active ? " (in use)" : ""}${a.signedIn ? (a.plan ? "" : ", plan use not allowed") : ", signed out"}`);
				for (const a of added) out(`${a.name}  ${a.label}  ${a.baseUrl}`);
				if (!added.length && !accounts.length) out("No services added.");
				out(`\nAdd one: el service add <chatgpt|${presets.map((p) => p.id).join("|")}> [--address <url> for custom]`);
			}
			client.close();
			return;
		}
		case "models": {
			const client = await connect();
			const { models, default: preferred } = await client.call("model.list", { refresh: flags.refresh === true });
			if (!models.length) out("No models found. Sign in to your lab (el login <lab>), el service add <service>, or el local to run an open model here.");
			for (const m of models) {
				const tags = [`${Math.round(m.context / 1024)}k`, m.vision ? "vision" : "", m.efforts.length ? `effort ${m.efforts.join("/")}` : ""].filter(Boolean).join(", ");
				out(`${m.ref === preferred ? "*" : " "} ${m.ref}  (${m.source}; ${tags})`);
			}
			client.close();
			return;
		}
		case "local": {
			const client = await connect();
			const local = await client.call("local.models", {});
			out(`This computer: ${local.memoryGiB} GB of memory${local.appleSilicon ? ", Apple silicon" : ""}.`);
			for (const server of local.servers) out(`  ${server.label} on port ${server.port}${server.version ? ` (${server.version})` : ""}: ${server.models.length ? server.models.join(", ") : "no models yet"}`);
			if (!local.servers.length) out("  No model server is running here.");
			if (!local.ollama) out("\nTo download open models, install Ollama from https://ollama.com/download and open it.");
			else if (local.ollama.updateForMlx) out(`\nOllama ${local.ollama.version} runs models on llama.cpp here; Ollama 0.40 or later runs them on MLX on Apple silicon, which is faster.`);
			else if (local.ollama.mlx) out("\nOllama runs models on MLX here.");
			out(`\nOpen models that call tools (checked ${local.checked}); el model pull <name> gets one:`);
			for (const m of local.suggestions) {
				const mark = m.installed ? "have it" : m.fits ? "fits" : "too big";
				out(`  ${m.model.padEnd(28)} ${`${m.sizeGB} GB`.padStart(7)}  ${mark.padEnd(8)} ${m.about}`);
			}
			client.close();
			return;
		}
		case "model": {
			const client = await connect();
			if (rest[0] === "pull" || rest[0] === "remove") {
				const name = rest[1] ?? fail(`el model ${rest[0]} <name>`);
				if (rest[0] === "remove") {
					await client.call("local.remove", { model: name });
					out(`Removed ${name}.`);
					client.close();
					return;
				}
				const gb = (n?: number) => (n ? (n / 1e9).toFixed(1) : "?");
				const finished = new Promise<void>((resolve, reject) => {
					client.on("local.pull.progress", (p) => {
						if (p.model !== name) return;
						if (p.done) {
							if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");
							return p.error || p.status === "cancelled" ? reject(new Error(p.error ?? "Cancelled.")) : resolve();
						}
						const line = p.total ? `${name}: ${gb(p.completed)} of ${gb(p.total)} GB (${Math.floor(((p.completed ?? 0) / p.total) * 100)}%)` : `${name}: ${p.status}`;
						if (process.stdout.isTTY) process.stdout.write(`\r\x1b[K${line}`);
					});
				});
				process.on("SIGINT", () => void client.call("local.pull.cancel", { model: name }).finally(() => process.exit(130)));
				await client.call("local.pull", { model: name });
				await finished.catch((error: Error) => fail(`Couldn't get ${name}: ${error.message}`));
				const ollamaName = (await client.call("local.models", {})).ollama?.name ?? "ollama";
				out(`${name} is ready: el model ${ollamaName}/${name}`);
				client.close();
				return;
			}
			await client.call("model.default", { model: rest[0] ?? fail("el model <ref> [effort]"), effort: rest[1] });
			out(`Default model: ${rest[0]}${rest[1] ? ` at ${rest[1]}` : ""}.`);
			client.close();
			return;
		}
		case "sessions": {
			const client = await connect();
			const list = await client.call("session.list", { cwd: flags.all ? undefined : process.cwd(), limit: 30 });
			for (const s of list) out(`${s.id}  ${s.updated.slice(0, 16).replace("T", " ")}  ${s.title}${s.running ? "  (running)" : ""}`);
			if (!list.length) out("No sessions here yet.");
			client.close();
			return;
		}
		// Not in el help: a lab grants Discovery mode to chosen people, who type it (docs/research.md).
		case "discover": {
			const [id, state] = rest;
			if (!id) fail("el discover <session id> [off]");
			const client = await connect();
			const { detail } = await client.call("session.discovery", { sessionId: id, on: state !== "off" });
			client.close();
			return out(detail);
		}
		case "session": {
			// The shared log format v1 (docs/session-log.md): a folder with session.jsonl and the images it refers to.
			const [verb, target] = rest;
			if (verb === "export") {
				const id = target ?? fail("el session export <session id> [folder]");
				const folder = resolve(rest[2] ?? `${id}-v1`);
				const client = await connect();
				const { events, attachments } = await client.call("session.export", { sessionId: id });
				client.close();
				mkdirSync(join(folder, "images"), { recursive: true });
				writeFileSync(join(folder, "session.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
				for (const [sha, image] of Object.entries(attachments)) writeFileSync(join(folder, "images", `${sha}.${image.mime.split("/")[1] ?? "bin"}`), Buffer.from(image.data, "base64"));
				return out(`Exported ${events.length} events to ${folder}`);
			}
			if (verb === "package") {
				// A run package: one RO-Crate folder a scientist can inspect, check and rerun from (docs/research.md).
				const id = target ?? fail("el session package <session id> [folder] [--no-history]");
				const folder = resolve(rest[2] ?? `${id}-package`);
				if (existsSync(folder) && readdirSync(folder).length) fail(`${folder} already has files in it. Name a new folder.`);
				const client = await connect();
				await client.call("session.open", { sessionId: id });
				const made = await client.call("session.package", { sessionId: id, folder, history: flags["no-history"] !== true });
				client.close();
				out(`Packaged ${made.actions} steps${made.files ? `, ${made.files} changed file${made.files === 1 ? "" : "s"}` : ""}${made.history ? " and the step history" : ""} as an RO-Crate in ${folder}`);
				for (const row of made.checks) out(`  ${row.ok ? "ok  " : "FAIL"}  ${row.check}: ${row.detail}`);
				return;
			}
			if (verb === "verify") {
				// Check a run package: every checksum, the history bundle, every content id its steps name.
				const folder = resolve(target ?? fail("el session verify <package folder>"));
				const { verifyPackage } = await import("@enrichedlab/engine");
				const checks = verifyPackage(folder);
				for (const row of checks) out(`${row.ok ? "ok  " : "FAIL"}  ${row.check}: ${row.detail}`);
				if (checks.some((row) => !row.ok)) process.exitCode = 1;
				return;
			}
			if (verb === "reproduce") {
				// Rerun a command step from the package's history, contained and offline, and compare the files it changes.
				const folder = resolve(target ?? fail("el session reproduce <package folder> <step id>"));
				const step = rest[2] ?? fail("el session reproduce <package folder> <step id>  (step ids are the #call-… entries)");
				const { reproduceStep } = await import("@enrichedlab/engine");
				const r = await reproduceStep(folder, step);
				out(`Reran: ${r.command}\nExit code: ${r.exitCode ?? "none (timed out or stopped)"}`);
				for (const path of r.same) out(`  same     ${path}`);
				for (const d of r.differ) out(`  DIFFERS  ${d.path}${d.expected ? "" : " (the step removed it)"}${d.got ? "" : " (the rerun removed it)"}`);
				for (const path of r.extra) out(`  EXTRA    ${path} (changed by the rerun, not by the step)`);
				out(r.differ.length || r.extra.length ? "Not reproduced: the files differ." : `Reproduced: ${r.same.length} file${r.same.length === 1 ? "" : "s"} came out the same.`);
				if (r.differ.length || r.extra.length) process.exitCode = 1;
				return;
			}
			if (verb === "push") {
				// A session to a lab's Rein, its web harness, to go on with it in the browser.
				const id = target ?? fail("el session push <session id> <lab> [--title <title>]");
				const site = rest[2] ?? fail("el session push <session id> <lab> [--title <title>]");
				const client = await connect();
				const pushed = await client.call("session.push", { sessionId: id, site, title: typeof flags.title === "string" ? flags.title : undefined });
				client.close();
				out(`Sent ${pushed.records} records to ${site}'s Rein.`);
				return out(JSON.stringify(pushed.result, null, 2));
			}
			if (verb === "pull") {
				// A Rein session back here, as a new session working in this folder (or --cwd).
				const site = target ?? fail("el session pull <lab> <rein session id> [--cwd <folder>]");
				const id = rest[2] ?? fail("el session pull <lab> <rein session id> [--cwd <folder>]");
				const client = await connect();
				const pulled = await client.call("session.pull", { site, id, cwd: resolve(typeof flags.cwd === "string" ? flags.cwd : process.cwd()) });
				client.close();
				return out(`Brought ${pulled.records} records from ${site}'s Rein into session ${pulled.summary.id} ("${pulled.summary.title}").`);
			}
			if (verb === "import") {
				const folder = resolve(target ?? fail("el session import <folder> [--cwd <folder>]"));
				const file = existsSync(join(folder, "session.jsonl")) ? join(folder, "session.jsonl") : folder;
				// The import goes to the engine as one message, at most 64 MiB with its images.
				if (statSync(file).size > 60 * 1024 * 1024) fail("That log is larger than an import takes (60 MB). Export it again with a newer el, which keeps it within the shared log's limits.");
				const events = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
				const attachments: Record<string, { mime: string; data: string }> = {};
				const images = join(dirname(file), "images");
				if (existsSync(images)) {
					for (const name of readdirSync(images)) {
						const [sha, ext] = name.split(".");
						if (sha && /^[0-9a-f]{64}$/.test(sha)) attachments[sha] = { mime: `image/${ext === "jpg" ? "jpeg" : ext}`, data: readFileSync(join(images, name)).toString("base64") };
					}
				}
				const client = await connect();
				const summary = await client.call("session.import", { events, attachments, cwd: typeof flags.cwd === "string" ? resolve(flags.cwd) : undefined });
				client.close();
				return out(`Imported as ${summary.id}: ${summary.title} (${summary.cwd}). Open it with el app --session ${summary.id}`);
			}
			return fail("el session export <session id> [folder] | el session import <folder> [--cwd <folder>]");
		}
		case "doctor":
			return (await import("./doctor.ts")).doctor();
		case "update": {
			const { applyUpdate, checkForUpdate } = await import("@enrichedlab/engine");
			const status = await checkForUpdate(paths().update, true);
			if (status.error) fail(`Couldn't check for updates: ${status.error}`);
			if (!status.latest) return out(`EnrichedLab ${status.current} is the newest release.`);
			out(`EnrichedLab ${status.latest} is out (you have ${status.current})${status.security ? "; it fixes a security problem" : ""}.`);
			for (const note of status.notes ?? []) out(`  ${note}`);
			if (flags.check) return;
			// --if-security: what the desktop runs as it quits, so security fixes never wait for someone to click.
			if (flags["if-security"] && !status.security) return;
			await stopEngine();
			const done = await applyUpdate((line) => out(line));
			return out(done.restart ? `Installed ${done.version}. Open EnrichedLab again to use it.` : `Updated to ${done.version}.`);
		}
		case "engine": {
			if (rest[0] === "stop") return out((await stopEngine()) ? "Engine stopped." : "No engine was running.");
			if (rest[0] === "restart") {
				await stopEngine();
				const file = await ensureEngine();
				return out(`Engine running on port ${file.port} (pid ${file.pid}).`);
			}
			if (rest[0] === "ensure") {
				// For windows that start the engine through this binary: find or start it, then say where it is. The token
				// stays in run/engine.json (owner-only); the caller reads it from there.
				const file = await ensureEngine();
				return out(flags.json ? JSON.stringify({ port: file.port, pid: file.pid, version: file.version, busy: file.busy ?? false }) : `Engine ${file.version} on port ${file.port} (pid ${file.pid}).`);
			}
			const file = await findEngine();
			return out(file ? `Engine ${file.version} on port ${file.port}, pid ${file.pid}, since ${file.started}.` : "No engine running. It starts on demand.");
		}
		default:
			fail(`unknown command "${command}". el help lists commands.`);
	}
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
