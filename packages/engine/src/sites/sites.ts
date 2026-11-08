// Sites: places that sign a person in and grant them models, tools and sandboxes. The site decides access; the
// engine reads what it was granted and applies it. `sites.json` holds addresses; `credentials/<site>.json` holds
// tokens, owner-only. A site can also be reached on the LAN with a key file and a private CA.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DesktopFrame, DeviceRequest, LabApp, LabNotice, SiteSummary } from "@enrichedlab/protocol";
import type { ModelProfile } from "../models/types.ts";
import type { Paths } from "../paths.ts";
import type { Tool } from "../tools/types.ts";
import { CLIENT_AGENT, errorText, expandHome, readJson, readSecret, redact, writeJson } from "../util.ts";
import { syncSiteBundles } from "../bundles.ts";
import type { ModelSource } from "../models/registry.ts";
import { SITE_KINDS, type SiteAdapter } from "./adapter.ts";
import type { CheckRow, LabAppEntry, LabEvent, LabSigner } from "./contract.ts";
import { type AppOrigin, installApp } from "../apps/package.ts";
import type { SandboxApi } from "./sandbox_workspace.ts";
import type { DesktopApi } from "./desktop.ts";
import { login, refresh, type SavedClient, type SiteCredentials } from "./oauth.ts";

export interface SiteConfig {
	/** Names the lab had before a rename; model references made under them still resolve. */
	formerNames?: string[];
	/** Short id: CLI arguments and tool name prefixes (enrichedlab_sandbox_run). */
	name: string;
	/** What people see: the lab's name. Defaults to the short name. */
	title?: string;
	/** The site's public address (behind Cloudflare Access). */
	url: string;
	/** Which adapter speaks to it (see SITE_KINDS). */
	kind: string;
	/**
	 * Research or other bounded data: only sessions bound to this site see its tools and models, and those sessions
	 * work in the site's sandbox with the site's models only, without the person's web or local MCP tools, so code
	 * and data stay in the site.
	 */
	isolated?: boolean;
	/** Optional LAN route: a key instead of the browser sign-in. */
	lan?: { url: string; keyFile: string; caFile?: string };
	/** Use the LAN route even when an OAuth sign-in exists. */
	preferLan?: boolean;
}

interface StoredCredentials {
	oauth?: SiteCredentials;
	client?: SavedClient;
}

/** How a site is reached right now: an address, headers with credentials, and a CA when it has its own. */
export interface SiteRoute {
	base: string;
	via: "oauth" | "key";
	headers(): Promise<Record<string, string>>;
	ca?: string;
}

export interface SiteState {
	config: SiteConfig;
	route?: SiteRoute;
	who?: string;
	models: ModelProfile[];
	tools: Tool[];
	sandbox: boolean;
	error?: string;
	warning?: string;
	describe: string;
}

export class Sites {
	private states = new Map<string, SiteState>();
	private adapters = new Map<string, SiteAdapter>();
	/** Sandboxes whose site couldn't be reached on the last connect; the next connect picks them up. */
	private parked = new Map<string, string>();

	/** Event streams being followed, one per connected lab. */
	private following = new Map<string, () => void>();
	/** Each lab's app list and signers, read after connect and when the lab says they changed. */
	private catalog = new Map<string, { apps: LabAppEntry[]; signers: LabSigner[] }>();
	/** Set by the engine: a lab's app list changed. */
	onAppsChanged?: (site: string) => void;
	/** Set by the engine: a new device asks to use the person's sign-in at a lab. */
	onDeviceRequest?: (request: DeviceRequest) => void;

	constructor(
		private p: Paths,
		private onChange: (summary: SiteSummary) => void,
		private onNotice: (notice: LabNotice) => void = () => undefined,
	) {}

	/** Each lab's sandbox, kept across restarts so sessions working there find their files again. */
	private get sandboxFile(): string {
		return join(this.p.home, "lab_sandboxes.json");
	}

	private keepSandbox(name: string, id: string | undefined): void {
		const kept = readJson<Record<string, string>>(this.sandboxFile, {});
		if (id) kept[name] = id;
		else delete kept[name];
		writeJson(this.sandboxFile, kept);
	}

	/** Where each lab's event cursor is kept, so a restart resumes instead of replaying or missing events. */
	private get cursorFile(): string {
		return join(this.p.home, "lab_cursors.json");
	}

	private follow(name: string, adapter: SiteAdapter): void {
		this.following.get(name)?.();
		this.following.delete(name);
		if (!adapter.follow) return;
		const cursors = readJson<Record<string, string>>(this.cursorFile, {});
		const stop = adapter.follow(cursors[name], {
			cursor: (id) => writeJson(this.cursorFile, { ...readJson<Record<string, string>>(this.cursorFile, {}), [name]: id }),
			reset: () => void this.connect(name).catch(() => undefined),
			event: (event) => {
				// What was granted changed: read it again. A revoked sign-in shows as one.
				if (event.type === "models.changed" || event.type === "bundles.changed") void this.connect(name).catch(() => undefined);
				if (event.type === "app.published" || event.type === "app.withdrawn") void this.readCatalog(name, adapter);
				// Another device asks to use this sign-in: the person decides, here or on any approved device.
				if (event.type === "device.pending" && typeof event.device_id === "string") {
					this.onDeviceRequest?.({ site: name, lab: this.title(name), id: event.device_id, name: typeof event.name === "string" ? event.name : "a new device", created: typeof event.created_at === "string" ? event.created_at : event.at });
				}
				const title = this.title(name);
				const text = noticeText(title, event);
				const url = typeof event.approve_url === "string" && /^https:\/\//.test(event.approve_url) ? event.approve_url : undefined;
				if (text) this.onNotice({ site: name, type: event.type, at: event.at, text, session: event.session, ...(url ? { url } : {}) });
				if (event.type === "signin.revoked") void this.logout(name);
			},
		});
		this.following.set(name, stop);
	}

	/** The lab adapter serving `uri`, for saving a file a lab tool returned by reference. */
	ownerOf(uri: string): SiteAdapter | undefined {
		for (const [name, adapter] of this.adapters) {
			const state = this.states.get(name);
			const bases = [state?.route?.base, origin(state?.config.url ?? "")].filter(Boolean) as string[];
			if (bases.some((b) => uri === b || uri.startsWith(`${b}/`))) return adapter;
		}
		return undefined;
	}

	private async readCatalog(name: string, adapter: SiteAdapter): Promise<void> {
		if (!adapter.labApps) return;
		try {
			const [apps, signers] = await Promise.all([adapter.labApps(), adapter.signers?.() ?? Promise.resolve([])]);
			this.catalog.set(name, { apps, signers });
			this.onAppsChanged?.(name);
		} catch {
			// Keep the last list; the next connect or event reads it again.
		}
	}

	/** Every lab's apps for this person, newest version first per name, with whether each may still be installed. */
	labApps(): LabApp[] {
		const out: LabApp[] = [];
		for (const [site, { apps, signers }] of this.catalog) {
			for (const a of apps) {
				const signer = signers.find((s) => s.fingerprint === a.signer.fingerprint);
				out.push({
					site,
					lab: this.title(site),
					name: a.name,
					title: a.title,
					version: a.version,
					description: a.description ?? "",
					signer: { fingerprint: a.signer.fingerprint, name: a.signer.name ?? signer?.name },
					runtime: a.runtime,
					permissions: a.permissions ?? {},
					published: a.published,
					withdrawn: Boolean(a.withdrawn_at),
					signerRevoked: !signer || Boolean(signer.revoked_at),
				});
			}
		}
		return out;
	}

	/** Install an app from a lab's list: the package is checked against the listing, then fully verified. */
	async installLabApp(site: string, name: string, version?: string): Promise<{ name: string; version: string }> {
		const adapter = this.adapters.get(site) ?? (await this.connect(site), this.adapters.get(site));
		if (!adapter?.appPackage) throw new Error(`${this.title(site)} doesn't offer apps.`);
		// Read the list again (an ETag makes it cheap), so an install never goes by a withdrawn or changed listing.
		await this.readCatalog(site, adapter);
		const catalog = this.catalog.get(site);
		const offered = (catalog?.apps ?? []).filter((a) => a.name === name && !a.withdrawn_at);
		const entry = version ? offered.find((a) => a.version === version) : offered[0];
		if (!entry) throw new Error(`${this.title(site)} doesn't offer ${name}${version ? ` ${version}` : ""} to you.`);
		const live = (catalog?.signers ?? []).filter((s) => !s.revoked_at);
		if (!live.some((s) => s.fingerprint === entry.signer.fingerprint)) throw new Error(`${this.title(site)} doesn't vouch for the key that signed ${name} ${entry.version}.`);
		const bytes = await adapter.appPackage(entry);
		mkdirSync(this.p.run, { recursive: true });
		const file = join(this.p.run, `lab_app_${name}_${process.pid}.labapp`);
		writeFileSync(file, bytes, { mode: 0o600 });
		try {
			const installed = await installApp(this.p, file, {
				vouched: { lab: site, signers: live.map((s) => ({ fingerprint: s.fingerprint, publicKey: s.public_key })) },
				origin: { lab: site, name, version: entry.version, sha256: entry.sha256 },
			});
			return { name: installed.name, version: installed.version };
		} finally {
			rmSync(file, { force: true });
		}
	}

	private async adapterFor(name: string): Promise<SiteAdapter> {
		if (!this.adapters.has(name)) await this.connect(name);
		const adapter = this.adapters.get(name);
		if (!adapter) throw new Error(this.states.get(name)?.error ?? `Couldn't connect to ${name}.`);
		return adapter;
	}

	async devices(name: string) {
		const adapter = await this.adapterFor(name);
		if (!adapter.devices) throw new Error(`${this.title(name)} doesn't bind sign-ins to devices.`);
		return adapter.devices();
	}

	async approveDevice(name: string, id: string): Promise<void> {
		const adapter = await this.adapterFor(name);
		if (!adapter.approveDevice) throw new Error(`${this.title(name)} doesn't bind sign-ins to devices.`);
		await adapter.approveDevice(id);
	}

	async revokeDevice(name: string, id: string): Promise<void> {
		const adapter = await this.adapterFor(name);
		if (!adapter.revokeDevice) throw new Error(`${this.title(name)} doesn't bind sign-ins to devices.`);
		await adapter.revokeDevice(id);
	}

	async sandboxes(name: string) {
		const adapter = await this.adapterFor(name);
		if (!adapter.sandboxes) throw new Error(`${this.title(name)} doesn't list sandboxes.`);
		return adapter.sandboxes();
	}

	async deleteSandbox(name: string, id: string) {
		const adapter = await this.adapterFor(name);
		if (!adapter.deleteSandbox) throw new Error(`${this.title(name)} doesn't list sandboxes.`);
		return adapter.deleteSandbox(id);
	}

	async createSandbox(name: string, image?: string, network?: string) {
		const adapter = await this.adapterFor(name);
		if (!adapter.createSandbox) throw new Error(`${this.title(name)} doesn't make sandboxes on request.`);
		return adapter.createSandbox(image, network);
	}

	async stopSandbox(name: string, id: string) {
		const adapter = await this.adapterFor(name);
		if (!adapter.stopSandbox) throw new Error(`${this.title(name)} doesn't stop sandboxes.`);
		return adapter.stopSandbox(id);
	}

	/** A lab by its short name here, or by its own name (its descriptor's), as apps a lab publishes name it. */
	resolve(name: string): string | undefined {
		if (this.exists(name)) return name;
		for (const [site, adapter] of this.adapters) if (adapter.descriptor?.name === name) return site;
		return undefined;
	}

	/** Why an app installed from a lab may not open, if the lab withdrew it or stopped vouching for its signer. */
	appBlocked(origin: AppOrigin): string | undefined {
		const catalog = this.catalog.get(origin.lab);
		if (!catalog) return undefined;
		const lab = this.title(origin.lab);
		const signer = catalog.signers.find((s) => s.fingerprint === origin.signer);
		if (!signer || signer.revoked_at) return `${lab} no longer vouches for the key that signed ${origin.name}.`;
		const entry = catalog.apps.find((a) => a.name === origin.name && a.version === origin.version);
		if (!entry) return `${lab} no longer offers ${origin.name} ${origin.version} to you.`;
		if (entry.withdrawn_at) return `${lab} withdrew ${origin.name} ${origin.version}.`;
		return undefined;
	}

	/** `el lab check`: connect if needed, then run the lab's conformance rows. */
	async check(name: string): Promise<CheckRow[]> {
		if (!this.adapters.has(name)) await this.connect(name);
		const adapter = this.adapters.get(name);
		if (!adapter) throw new Error(this.states.get(name)?.error ?? `Couldn't connect to ${name}.`);
		if (!adapter.check) throw new Error(`${this.title(name)} can't be checked by this version.`);
		return adapter.check();
	}

	/** The lab's Rein, for moving a session there and back. */
	async rein(name: string): Promise<{ reinImport(lines: string, title: string): Promise<unknown>; reinExport(id: string): Promise<string> }> {
		if (!this.adapters.has(name)) await this.connect(name);
		const adapter = this.adapters.get(name);
		if (!adapter?.reinImport || !adapter.reinExport) throw new Error(`${this.title(name)} has no web harness to share sessions with.`);
		return adapter as Required<Pick<typeof adapter, "reinImport" | "reinExport">>;
	}

	async usage(name: string, window: "7d" | "30d"): Promise<unknown> {
		if (!this.adapters.has(name)) await this.connect(name);
		const adapter = this.adapters.get(name);
		if (!adapter?.usage) throw new Error(`${this.title(name)} doesn't report usage.`);
		return adapter.usage(window);
	}

	configs(): SiteConfig[] {
		return readJson<{ sites?: SiteConfig[] }>(this.p.sites, {}).sites ?? [];
	}

	private saveConfigs(sites: SiteConfig[]): void {
		writeJson(this.p.sites, { sites }, true);
	}

	add(config: SiteConfig): void {
		// A name pointed at a new address loses its sign-in: tokens belong to the address they were issued for.
		const before = this.configs().find((s) => s.name === config.name);
		if (before && origin(before.url) !== origin(config.url)) rmSync(this.credPath(config.name), { force: true });
		const sites = this.configs().filter((s) => s.name !== config.name);
		sites.push(config);
		this.saveConfigs(sites);
	}

	/** Give a site a new short name (and title); its sign-in moves with it. */
	rename(from: string, to: string, title?: string): SiteConfig {
		const sites = this.configs();
		const site = sites.find((s) => s.name === from);
		if (!site) throw new Error(`No site named ${from}.`);
		if (from !== to && sites.some((s) => s.name === to)) throw new Error(`A site named ${to} already exists.`);
		if (!/^[a-z][a-z0-9_-]{0,31}$/.test(to)) throw new Error("Site names are lowercase letters, digits, - and _, starting with a letter.");
		// Sessions started before the rename name the lab's models by the old name: keep it so they still resolve.
		const formerNames = [...new Set([...(site.formerNames ?? []), from])].filter((n) => n !== to);
		const renamed = { ...site, name: to, title: title ?? site.title, ...(formerNames.length ? { formerNames } : {}) };
		if (from !== to && existsSync(this.credPath(from))) renameSync(this.credPath(from), this.credPath(to));
		if (from !== to && existsSync(this.deviceFile(from))) renameSync(this.deviceFile(from), this.deviceFile(to));
		this.saveConfigs(sites.map((s) => (s.name === from ? renamed : s)));
		this.adapters.delete(from);
		this.states.delete(from);
		return renamed;
	}

	/** A signed-in site's sandbox as a place to work, when the site offers one. */
	sandbox(name: string): SandboxApi | undefined {
		return this.adapters.get(name)?.sandboxApi?.();
	}

	title(name: string): string {
		return this.configs().find((s) => s.name === name)?.title ?? this.adapters.get(name)?.descriptor?.title ?? name;
	}

	/** Set by the engine: a picture of a lab's desktop sandbox after an action, for the windows. */
	onDesktopFrame?: (frame: DesktopFrame) => void;

	/** A connected lab's desktop sandbox, where it offers one. */
	desktop(name: string): DesktopApi | undefined {
		const adapter = this.adapters.get(name);
		return adapter?.desktop?.() && adapter.desktopAct && adapter.desktopOpen ? (adapter as unknown as DesktopApi) : undefined;
	}

	/** What a connected lab says about this person: their named grants and whose agents may use its sandboxes. */
	lab(name: string): { title: string; capabilities: string[]; sandboxAgents?: "lab" | "any" } | undefined {
		const adapter = this.adapters.get(name);
		if (!adapter) return undefined;
		return { title: this.title(name), capabilities: adapter.capabilities ?? [], sandboxAgents: adapter.sandboxAgents };
	}

	private credPath(name: string): string {
		return join(this.p.credentials, `${name.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
	}

	private creds(name: string): StoredCredentials {
		return readJson<StoredCredentials>(this.credPath(name), {});
	}

	private saveCreds(name: string, creds: StoredCredentials): void {
		writeJson(this.credPath(name), creds, true);
	}

	/** Pick the route: OAuth on the public address when signed in, else the LAN key when configured. */
	route(config: SiteConfig, forceLan = false): SiteRoute | undefined {
		const creds = this.creds(config.name);
		// Never send a token to an address other than the one it was issued for.
		if (creds.oauth && origin(creds.oauth.resource) !== origin(config.url)) creds.oauth = undefined;
		const lan = config.lan && readSecret({ keyFile: config.lan.keyFile }) ? config.lan : undefined;
		const useLan = lan && (forceLan || config.preferLan || !creds.oauth);
		if (useLan && lan) {
			const ca = lan.caFile ? readFileSync(expandHome(lan.caFile), "utf8") : undefined;
			return { base: lan.url.replace(/\/+$/, ""), via: "key", ca, headers: async () => ({ authorization: `Bearer ${readSecret({ keyFile: lan.keyFile })}`, "user-agent": CLIENT_AGENT }) };
		}
		if (creds.oauth) {
			let current = creds.oauth;
			// One refresh at a time: requests that find the token expired together wait for the same new one, since a
			// rotated refresh token works once.
			let refreshing: Promise<SiteCredentials> | undefined;
			return {
				base: config.url.replace(/\/+$/, ""),
				via: "oauth",
				headers: async () => {
					if (Date.now() >= current.expires) {
						refreshing ??= refresh(current)
							.then((next) => {
								current = next;
								this.saveCreds(config.name, { ...this.creds(config.name), oauth: next });
								return next;
							})
							.finally(() => {
								refreshing = undefined;
							});
						await refreshing;
					}
					return { authorization: `Bearer ${current.access}`, "user-agent": CLIENT_AGENT };
				},
			};
		}
		return undefined;
	}

	/** Browser sign-in. `onAuth` gets the address to open. */
	async login(name: string, onAuth: (url: string, instructions: string) => void, signal?: AbortSignal): Promise<SiteSummary> {
		const config = this.configs().find((s) => s.name === name);
		if (!config) throw new Error(`No site named ${name}. Add it with el site add ${name} <address>.`);
		const stored = this.creds(name);
		const result = await login(config.url, { onAuth: ({ url, instructions }) => onAuth(url, instructions ?? ""), signal }, stored.client);
		this.saveCreds(name, { oauth: result.credentials, client: result.client });
		// A fresh sign-in is what lets a computer whose key the lab revoked register a new one.
		if (readJson<{ revoked?: boolean }>(this.deviceFile(name), {}).revoked) rmSync(this.deviceFile(name), { force: true });
		return this.connect(name);
	}

	/** This computer's device key for a lab that binds tokens to devices (dpop.ts). */
	private deviceFile(name: string): string {
		return join(this.p.credentials, `device_${name}.json`);
	}

	async logout(name: string): Promise<void> {
		this.following.get(name)?.();
		this.following.delete(name);
		// Revoke the device key at the lab while the sign-in still works, then drop both here.
		await this.adapters.get(name)?.forget?.().catch(() => undefined);
		rmSync(this.deviceFile(name), { force: true });
		rmSync(this.credPath(name), { force: true });
		if (this.catalog.delete(name)) this.onAppsChanged?.(name);
		// The sandbox stays for the next sign-in, with its files.
		const adapter = this.adapters.get(name);
		const sandbox = await adapter?.detach();
		void adapter?.close();
		if (sandbox) this.parked.set(name, sandbox);
		this.adapters.delete(name);
		this.states.delete(name);
		const config = this.configs().find((s) => s.name === name);
		if (config) void this.connect(name).catch(() => undefined);
	}

	/** Forget a lab on this computer: sign out (revoking the device key while the sign-in still works) and drop it. */
	async remove(name: string): Promise<void> {
		if (!this.configs().some((s) => s.name === name)) throw new Error(`No site named ${name}.`);
		this.following.get(name)?.();
		this.following.delete(name);
		await this.adapters.get(name)?.forget?.().catch(() => undefined);
		rmSync(this.deviceFile(name), { force: true });
		rmSync(this.credPath(name), { force: true });
		if (this.catalog.delete(name)) this.onAppsChanged?.(name);
		// The lab's sandbox, stopped, stays the person's at the lab (el sandboxes lists it); this computer forgets it.
		void this.adapters.get(name)?.close();
		this.parked.delete(name);
		this.keepSandbox(name, undefined);
		this.adapters.delete(name);
		this.states.delete(name);
		this.saveConfigs(this.configs().filter((s) => s.name !== name));
	}

	/** Connect (or reconnect) one site and read what this person was granted. */
	async connect(name: string): Promise<SiteSummary> {
		const config = this.configs().find((s) => s.name === name);
		if (!config) throw new Error(`No site named ${name}.`);
		// The old connection goes, its sandbox stays: files and running jobs survive a refresh.
		const container = (await this.adapters.get(name)?.detach()) ?? this.parked.get(name) ?? readJson<Record<string, string>>(this.sandboxFile, {})[name];
		this.adapters.delete(name);
		this.parked.delete(name);
		const first = this.route(config);
		const state: SiteState = { config, route: first, models: [], tools: [], sandbox: false, describe: config.name };
		// A rejected browser sign-in falls back to the LAN key when one is configured, and says so.
		const routes = [first, first?.via === "oauth" && config.lan ? this.route(config, true) : undefined].filter(Boolean) as SiteRoute[];
		const factory = Object.hasOwn(SITE_KINDS, config.kind) ? SITE_KINDS[config.kind] : undefined;
		if (!factory) state.error = `This version of EnrichedLab doesn't know sites of kind "${config.kind}".`;
		for (const route of routes) {
			if (!factory) break;
			const adapter = factory(config, route, container, this.deviceFile(name));
			adapter.onNotice = (text) => this.onNotice({ site: name, type: "site.notice", at: new Date().toISOString(), text });
			adapter.onDesktopFrame = (frame) => this.onDesktopFrame?.(frame);
			adapter.onDesktopChange = () => {
				const state = this.states.get(name);
				if (state) this.onChange(this.summary(state));
			};
			adapter.onApproved = () => void this.connect(name).catch(() => undefined);
			try {
				await adapter.connect();
				this.adapters.set(name, adapter);
				this.follow(name, adapter);
				void this.readCatalog(name, adapter);
				if (adapter.bundles) {
					try {
						syncSiteBundles(this.p, name, await adapter.bundles());
					} catch (error) {
						state.warning = `Bundles from ${name} weren't installed: ${redact(errorText(error))}`;
					}
				}
				// A lab that says it keeps data inside is isolated from then on, also while it can't be reached.
				if (adapter.descriptor?.policy?.keep_data_inside && !config.isolated) {
					config.isolated = true;
					this.saveConfigs(this.configs().map((c) => (c.name === name ? { ...c, isolated: true } : c)));
				}
				const note = route !== first && state.error ? `Browser sign-in refused; using the LAN key. ${state.error}` : adapter.warning;
				Object.assign(state, { route, who: adapter.who, models: adapter.models, tools: adapter.tools, sandbox: adapter.sandboxOn, error: undefined, warning: note ?? state.warning, describe: adapter.describe() });
				break;
			} catch (error) {
				state.error = redact(errorText(error));
				// Waiting for another device to approve this one: another route waits the same way.
				if ((error as { pending?: boolean }).pending) break;
			}
		}
		if (!this.adapters.has(name) && container) this.parked.set(name, container);
		this.states.set(name, state);
		const summary = this.summary(state);
		this.onChange(summary);
		return summary;
	}

	async connectAll(): Promise<void> {
		await Promise.all(this.configs().map((c) => this.connect(c.name).catch(() => undefined)));
	}

	summary(state: SiteState): SiteSummary {
		return {
			name: state.config.name,
			title: state.config.title ?? state.config.name,
			url: state.config.url,
			kind: state.config.kind,
			isolated: this.isolated(state.config.name) || undefined,
			signedIn: Boolean(state.route && !state.error),
			who: state.who,
			via: state.route?.via,
			models: state.models.length,
			tools: state.tools.length,
			sandbox: state.sandbox,
			error: state.error,
			warning: state.warning,
			...this.described(state.config.name),
		};
	}

	/** What the lab's own description adds to its summary. */
	private described(name: string): Partial<SiteSummary> {
		const d = this.adapters.get(name)?.descriptor;
		if (!d) return {};
		return {
			...(this.configs().find((c) => c.name === name)?.title ? {} : { title: d.title }),
			support: d.support?.url,
			docs: d.docs?.url,
			keepsDataInside: d.policy?.keep_data_inside,
			profiles: d.sandbox_profiles?.map(({ name: profile, cpu, memory, gpu }) => ({ name: profile, cpu, memory, ...(gpu ? { gpu } : {}) })),
			browser: Boolean(this.adapters.get(name)?.sandboxApi?.()?.browser?.()),
			desktop: this.desktopSummary(name),
		};
	}

	private desktopSummary(name: string): SiteSummary["desktop"] {
		const api = this.desktop(name);
		const info = api?.desktop();
		return info ? { width: info.screen?.width, height: info.screen?.height, actions: info.actions, open: info.open === true, ...(api?.desktopOutdated ? { outdated: true } : {}) } : undefined;
	}

	list(): SiteSummary[] {
		return this.configs().map((c) => {
			const state = this.states.get(c.name);
			return state ? this.summary(state) : { name: c.name, title: c.title ?? c.name, url: c.url, kind: c.kind, isolated: c.isolated, signedIn: false, models: 0, tools: 0, sandbox: false };
		});
	}

	/** Model sources for the registry: one per connected site. */
	modelSources(): ModelSource[] {
		return [...this.states.values()].map((s) => ({ name: `site:${s.config.name}`, models: () => s.models }));
	}

	/** The sites a session sees: the one it is bound to, or every site that isn't isolated. */
	private visible(site?: string): SiteState[] {
		return [...this.states.values()].filter((s) => (site ? s.config.name === site : !this.isolated(s.config.name)));
	}

	tools(site?: string): Tool[] {
		return this.visible(site).flatMap((s) => s.tools);
	}

	descriptions(site?: string): string[] {
		return this.visible(site)
			.filter((s) => s.route && !s.error)
			.map((s) => s.describe);
	}

	/** Whether a session (bound to `site`, or unbound) may use this model. Models from this computer or the
	 * person's own providers always may. */
	allows(model: ModelProfile, site?: string): boolean {
		// A session bound to an isolated site uses that site's models only, so its data never goes elsewhere.
		if (site && this.isolated(site)) return model.source === "site" && model.provider === site;
		if (model.source !== "site") return true;
		if (site) return model.provider === site;
		return !this.isolated(model.provider);
	}

	/** Each former lab name mapped to the lab's name now. */
	aliases(): Record<string, string> {
		return Object.fromEntries(this.configs().flatMap((c) => (c.formerNames ?? []).map((f) => [f, c.name])));
	}

	/** Whether a lab keeps its sessions to itself: joined that way, or the lab says it keeps data inside. */
	/** The lab's vetted package sources, when its descriptor names them. */
	packages(name: string): { conda?: string[]; pypi?: string; only?: boolean } | undefined {
		const p = this.adapters.get(name)?.descriptor?.packages;
		return p && (p.conda?.length || p.pypi) ? { conda: p.conda, pypi: p.pypi, only: p.only } : undefined;
	}

	isolated(name: string): boolean {
		return this.configs().find((c) => c.name === name)?.isolated === true || this.adapters.get(name)?.descriptor?.policy?.keep_data_inside === true;
	}

	exists(name: string): boolean {
		return this.configs().some((c) => c.name === name);
	}

	async close(): Promise<void> {
		for (const stop of this.following.values()) stop();
		this.following.clear();
		await Promise.all([...this.adapters.entries()].map(async ([name, a]) => this.keepSandbox(name, (await a.close()) ?? this.parked.get(name))));
	}
}

/** An event in words. Events that only refresh what's granted say nothing. */
export function noticeText(lab: string, e: LabEvent): string | undefined {
	const said = typeof e.text === "string" && e.text ? e.text : typeof e.summary === "string" && e.summary ? e.summary : undefined;
	// A lab agent's run held for the owner: whatever the event's type, the person has to act.
	if (e.waiting_on === "approval") return `${lab}: the lab's agent is waiting for your approval${said ? ` (${said})` : ""}.`;
	switch (e.type) {
		case "job.finished":
			return `${lab}: a sandbox job ${e.status === "failed" ? "failed" : "finished"}${said ? `: ${said}` : "."}`;
		case "agent.finished":
			return `${lab}: the lab's agent ${e.status === "failed" ? "couldn't finish" : "finished"}${said ? `: ${said}` : "."}`;
		case "sandbox.idle_stopping":
			return `${lab}: your sandbox stops in 10 minutes if it stays idle. Files stay.`;
		case "sandbox.stopped":
			return `${lab}: your sandbox stopped. Its files are kept; it starts again when you use it.`;
		case "sandbox.archived":
			return `${lab}: an unused sandbox was archived${typeof e.delete_after === "string" ? `; the archive is kept until ${e.delete_after.slice(0, 10)}` : ""}. Using it again restores it.`;
		case "sandbox.restored":
			return `${lab}: your sandbox is back from its archive, with its files.`;
		case "sandbox.deleted":
			return `${lab}: a sandbox was deleted, with its files.`;
		case "app.withdrawn":
			return `${lab}: the app ${typeof e.name === "string" ? e.name : ""}${typeof e.version === "string" ? ` ${e.version}` : ""} was withdrawn.`;
		case "quota.warning":
			return `${lab}: you've used ${typeof e.used === "number" && typeof e.limit === "number" ? `${Math.round((e.used / e.limit) * 100)}%` : "most"} of your ${typeof e.kind === "string" ? e.kind : "allowance"}.`;
		case "app.published":
			return `${lab}: a new app is available${said ? `: ${said}` : ""}. Find it under Apps.`;
		case "ticket.updated":
			return `${lab}: your help request was updated${said ? `: ${said}` : "."}`;
		case "device.pending":
			return `${lab}: ${typeof e.name === "string" ? `"${e.name}"` : "a new device"} asks to use your sign-in. Approve it only if you just signed in there; if not, revoke it (el devices).`;
		case "signin.revoked":
			return `${lab} ended your sign-in. Sign in again to keep using it.`;
		default:
			return said ? `${lab}: ${said}` : undefined;
	}
}

function origin(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return "";
	}
}
