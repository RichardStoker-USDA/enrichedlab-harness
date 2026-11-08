// The Gate adapter: everything a person may use on a Gate site, read from Gate itself.
//
//   GET /v1/me          who they are, quotas, whether files and sandboxes are on
//   GET /v1/models      the models they may use, with context, output cap, reasoning levels and where levels go
//   POST /mcp           the tools their role grants (MCP, Streamable HTTP)
//   /v1/containers      their sandbox: run, background jobs, copy files in and out

import { hostname, tmpdir } from "node:os";
import { createReadStream, realpathSync } from "node:fs";
import { mkdir, mkdtemp, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { BundleGrant } from "../bundles.ts";
import { repoRoot } from "../git.ts";
import { connectRemote, type McpConnection } from "../mcp.ts";
import { labFetch, sseData } from "../models/http.ts";
import { DeviceKey, dpopError } from "./dpop.ts";
import { type OpenPort, openPort, type RunningServer } from "./port_proxy.ts";
import { type AttachSpec, type Attached, attachSocket, retryingAttach } from "./attach.ts";
import { Cdp } from "./cdp.ts";
import type { SandboxBrowserLane } from "./sandbox_browser.ts";
import type { LabSandbox, SandboxNetwork } from "@enrichedlab/protocol";
import type { ModelProfile } from "../models/types.ts";
import { num, str, type Tool, ToolError } from "../tools/types.ts";
import { errorText, redact, SECRET_NAME, sleep } from "../util.ts";
import type { SiteAdapter } from "./adapter.ts";
import { fetchRepo, sendRepo } from "./repo_handoff.ts";
import type { SandboxApi, SandboxCheckpoints } from "./sandbox_workspace.ts";
import type { SiteConfig, SiteRoute } from "./sites.ts";
import { type DesktopAction, type DesktopApi, type DesktopFrame, type DesktopResult, type DesktopStreamHandlers, desktopTools, frameIn } from "./desktop.ts";
import { type CheckRow, CONTRACT, contractProblem, DESCRIPTOR_PATH, type DesktopInfo, type Endpoint, type LabAppEntry, type LabDescriptor, type LabEvent, type LabSigner, type SandboxAgents, SCHEMAS, validate } from "./contract.ts";

interface GateModel {
	id: string;
	max_model_len?: number;
	gate?: {
		aliases?: string[];
		capabilities?: string[];
		context?: number;
		default_effort?: string;
		effort_field?: string;
		efforts?: string[];
		endpoints?: string[];
		max_output?: number;
		/** The outside service a lab sends this model's requests to, when it doesn't run the model itself. */
		relayed_to?: string;
	};
}

interface GateMe {
	handle?: string;
	owner?: boolean;
	files?: { enabled?: boolean };
	sandboxes?: { enabled?: boolean; idle_minutes?: number; network?: SandboxNetwork; hosts?: string[] };
	/** The sandbox networks this person may choose at create, such as ["none", "internet"]. */
	sandbox_networks?: string[];
	quotas?: unknown[];
	/** Named grants, such as "discovery". */
	capabilities?: string[];
	sandbox_agents?: SandboxAgents;
	/** The lab data the person may reach, by reference; the lab enforces access. */
	data_scopes?: { id: string; title?: string; research_group?: string | null; project?: string | null; access: "read" | "write" }[];
}

/** What a sandbox was made with: its image and network (undefined: the lab's default image, or no network). */
interface Made {
	image?: string;
	network?: string;
}

const title = (entry: LabAppEntry) => `${entry.title || entry.name} ${entry.version}`;

/** The token in a request's sign-in header. */
const bearerOf = (headers: Record<string, string>) => /^(?:Bearer|DPoP)\s+(.+)$/i.exec(headers.authorization ?? "")?.[1];

/** Minutes a served app goes unused (no requests, no open WebSockets) before its server stops until the next visit. */
const SERVE_IDLE_MINUTES = 15;

/** Refusals (409, 429, 503) that clear on their own, and the longest Retry-After waited each time, in seconds. */
const WAITS: Record<string, number> = { sandbox_starting: 30, sandbox_busy: 30, browser_starting: 5, scanner_unavailable: 60, downloads_in_progress: 30, too_many_deletes: 15, desktop_unavailable: 5, too_many_commands: 5 };

/**
 * The industry's harmless antivirus test file (EICAR), each character code plus one, so neither this source nor a built
 * binary holds it: antivirus on the computers they sit on would act on it. `el lab check` sends it where a lab offers.
 */
const EICAR_SHIFTED = [
	89, 54, 80, 34, 81, 38, 65, 66, 81, 92, 53, 93, 81, 91, 89, 54, 53, 41, 81, 95, 42, 56, 68, 68, 42, 56, 126, 37, 70, 74, 68, 66, 83, 46, 84, 85, 66, 79, 69, 66, 83, 69, 46, 66, 79, 85, 74,
	87, 74, 83, 86, 84, 46, 85, 70, 84, 85, 46, 71, 74, 77, 70, 34, 37, 73, 44, 73, 43,
];

/**
 * Private destinations an internet sandbox must never reach, all on port 443 so a refusal is about the address and
 * not the port: the metadata address, each private and carrier NAT range, loopback, the cluster API, and the IPv6
 * spellings that carry a private IPv4 address (mapped, NAT64, 6to4) or are private themselves (ULA, link-local).
 */
const PRIVATE_TARGETS = [
	"169.254.169.254:443",
	"10.0.0.1:443",
	"172.16.0.1:443",
	"192.168.0.1:443",
	"100.64.0.1:443",
	"127.0.0.1:443",
	"kubernetes.default.svc:443",
	"[::1]:443",
	"[fd00:ec2::254]:443",
	"[fe80::1]:443",
	"[::ffff:a9fe:a9fe]:443",
	"[64:ff9b::a9fe:a9fe]:443",
	"[2002:a9fe:a9fe::1]:443",
];

/** Public pages whose certificates are broken on purpose: expired, self-signed, and issued for another name. */
const BAD_CERT_PAGES = ["https://expired.badssl.com/", "https://self-signed.badssl.com/", "https://wrong.host.badssl.com/"];
/** The same site with a good certificate: it has to load, or a refusal says nothing. */
const GOOD_CERT_PAGE = "https://badssl.com/";

/**
 * Fetches each URL given and prints, as JSON, "loaded <status>" or the error it got. Python trusts the sandbox's CA
 * (SSL_CERT_FILE), so through a proxy that re-signs HTTPS a page loads only if the proxy passed its certificate on.
 */
const FETCH_PROBE = String.raw`import json, sys, urllib.request
out = {}
for url in sys.argv[1:]:
    try:
        out[url] = "loaded " + str(urllib.request.urlopen(url, timeout=20).status)
    except Exception as e:
        out[url] = type(e).__name__ + ": " + str(getattr(e, "reason", e))[:160]
print(json.dumps(out))`;

/**
 * Asks the sandbox's proxy to CONNECT to each target given and prints what it said, as JSON: "reached" (2xx),
 * "refused" (4xx), or what else happened. Fetching a URL can't tell a refusal from a proxy that tried and found nothing
 * listening, and a plain-http fetch may skip the proxy altogether. With no proxy set, it tries each target directly.
 * No single quotes, so it rides in a shell's single-quoted argument.
 */
const PRIVATE_PROBE = String.raw`import base64, json, os, socket, ssl, sys, urllib.parse
proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
p = urllib.parse.urlsplit(proxy) if proxy else None
out = {}
for target in sys.argv[1:]:
    host, port = target.rsplit(":", 1)
    try:
        if p is None:
            socket.create_connection((host.strip("[]"), int(port)), timeout=8).close()
            out[target] = "reached"
            continue
        s = socket.create_connection((p.hostname, p.port or (443 if p.scheme == "https" else 80)), timeout=8)
        if p.scheme == "https":
            s = ssl.create_default_context().wrap_socket(s, server_hostname=p.hostname)
        auth = ""
        if p.username:
            pair = urllib.parse.unquote(p.username) + ":" + urllib.parse.unquote(p.password or "")
            auth = "Proxy-Authorization: Basic " + base64.b64encode(pair.encode()).decode() + "\r\n"
        s.sendall(("CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\n" + auth + "\r\n").encode())
        line = s.makefile("rb").readline().decode("latin-1").split()
        s.close()
        code = int(line[1]) if len(line) > 1 and line[1].isdigit() else 0
        out[target] = "reached" if 200 <= code < 300 else "refused" if 400 <= code < 500 and code != 407 else ("the proxy answered " + str(code) if code else "the proxy closed without an answer")
    except socket.timeout:
        out[target] = "refused" if p is None else "the proxy gave no answer in 8 s"
    except OSError:
        out[target] = "refused" if p is None else "the proxy could not be reached"
print(json.dumps(out))`;

/** The sha-256 a response's `Repr-Digest` (RFC 9530) gives, in hex; undefined when it carries none. */
export function reprSha256(response: Response): string | undefined {
	const match = /(?:^|,)\s*sha-256=:([A-Za-z0-9+/]+={0,2}):/.exec(response.headers.get("repr-digest") ?? "");
	return match ? Buffer.from(match[1]!, "base64").toString("hex") : undefined;
}

export class GateSite implements SiteAdapter, SandboxApi, DesktopApi {
	who?: string;
	/** Named grants this person holds at the lab (GET /v1/me capabilities), such as "discovery". */
	capabilities: string[] = [];
	/** Whose agents may use this person's sandboxes here. */
	sandboxAgents?: SandboxAgents;
	owner = false;
	models: ModelProfile[] = [];
	tools: Tool[] = [];
	sandboxOn = false;
	/** What the person's sandbox can reach on the web, as /v1/me says. */
	private network?: { network?: SandboxNetwork; hosts?: string[] };
	warning?: string;
	private mcp?: McpConnection;
	private container?: string;
	private starting?: Promise<string>;
	/** A sandbox of the person's the lab is still deleting: it counts toward their limits until the lab confirms. */
	private leaving?: string;
	/** What each sandbox here was made with, as the lab says; a replacement is made the same way. */
	private made = new Map<string, Made>();
	/** The sandbox networks this person may choose (/v1/me), when the lab says. */
	private networks?: string[];
	/** Background jobs started in the sandbox, so shutdown never deletes a sandbox while one runs. */
	private jobs = new Set<string>();
	/** Repositories sent to the sandbox from this engine: sandbox folder → local repository and the commit sent. */
	private sent = new Map<string, { repo: string; base: string; home?: string }>();

	/** This computer's key for the lab, when the lab binds tokens to devices (dpop.ts). */
	private device?: DeviceKey;
	/**
	 * The latest DPoP nonce the lab handed out, if it uses them, when it came, and the token of the request it answered.
	 * A lab may bind its nonce to the sign-in, so a refreshed token needs a nonce of its own.
	 */
	private nonce?: string;
	private nonceAt = 0;
	private nonceToken?: string;
	private nonceRefresh?: Promise<void>;
	/** The token the latest request was signed in with. */
	private signedWith?: string;
	/** Plain-language notices for the person (a sandbox restored or replaced); Sites passes them to every surface. */
	onNotice?: (text: string) => void;
	/** Sandbox ports opened on this computer, by container and port. */
	private ports = new Map<string, OpenPort>();
	/** The desktop sandbox (descriptor sandbox_desktop), a sandbox of its own beside the one the person works in. */
	private desktopBox?: string;
	private desktopStarting?: Promise<string>;
	/** Set by Sites: a picture of the desktop after an action, for the windows that show it. */
	onDesktopFrame?: (frame: DesktopFrame) => void;
	/** Set by Sites: the desktop's outdated mark changed, so the lab's summary changed. */
	onDesktopChange?: () => void;
	desktopOutdated = false;

	constructor(
		readonly config: SiteConfig,
		readonly route: SiteRoute,
		/** The sandbox an earlier connection to this site made; a reconnect keeps using it. */
		container?: string,
		/** Where this computer's device key for the lab is kept. */
		private deviceFile?: string,
	) {
		this.container = container;
	}

	/** The lab's public address for a request URL or path: proofs name it even when the request goes over the LAN. */
	private publicUrl(url: string): string {
		const pub = this.config.url.replace(/\/+$/, "");
		if (url.startsWith(this.route.base)) return pub + url.slice(this.route.base.length);
		return url.startsWith("/") ? pub + url : url;
	}

	/** Keep the lab's latest DPoP nonce (RFC 9449 section 8); every response may carry one. */
	private noteNonce(response: Response, token = this.signedWith): string | undefined {
		const nonce = response.headers.get("dpop-nonce") ?? undefined;
		if (nonce) {
			this.nonce = nonce;
			this.nonceAt = Date.now();
			this.nonceToken = token;
		}
		return nonce;
	}

	/**
	 * Before a request that can't be sent twice (a streamed upload, a WebSocket, a page's request through a port), make
	 * sure the nonce is recent and for the current token: a lab keeps one valid 5 to 10 minutes, so past 4, or once the
	 * token was refreshed, a cheap read fetches a fresh one.
	 */
	private async freshNonce(): Promise<void> {
		if (!this.device || this.device.revoked || !this.nonce) return;
		// Reading the sign-in is also what refreshes an expired token, so the request that follows uses this one.
		const token = bearerOf(await this.route.headers().catch(() => ({}) as Record<string, string>));
		if (token === this.nonceToken && Date.now() - this.nonceAt < 240_000) return;
		this.nonceRefresh ??= this.call("GET", "/v1/me", { signal: AbortSignal.timeout(10_000) })
			.then((r) => r.arrayBuffer())
			.then(
				() => undefined,
				() => undefined,
			)
			.finally(() => {
				this.nonceRefresh = undefined;
			});
		await this.nonceRefresh;
	}

	/** For MCP requests: note the nonce, and say whether a nonce challenge should be answered by sending again. */
	private answered = (response: Response): boolean => {
		const fresh = this.noteNonce(response);
		return Boolean(fresh) && response.status === 401 && dpopError(response) === "use_dpop_nonce";
	};

	/** The route's sign-in, plus a proof for this request when the lab binds tokens to devices. */
	private async authHeaders(method: string, url: string): Promise<Record<string, string>> {
		const headers = await this.route.headers();
		const bearer = bearerOf(headers);
		this.signedWith = bearer;
		// A pending key can't sign yet: until another device approves it, requests go as they would without one.
		if (!this.device || this.device.revoked || this.device.pending) return headers;
		// A nonce from an earlier token is refused; sent without one, the lab answers with a nonce for this token.
		const nonce = this.nonceToken === bearer ? this.nonce : undefined;
		return { ...headers, dpop: await this.device.proof(method, this.publicUrl(url), bearer, nonce) };
	}

	/** Register this computer's key with the lab, once; the lab registers the key that signed the request. */
	private async enroll(): Promise<void> {
		if (!this.deviceFile) return;
		const key = await DeviceKey.open(this.deviceFile, this.config.url);
		if (key.revoked) throw Object.assign(new Error(`${this.title} revoked this computer's key. Sign in again (el login ${this.config.name}) to register a new one.`), { status: 401, revoked: true });
		if (key.lapsed) {
			// Nobody approved it in time and the lab dropped the request: ask again with a new key.
			key.discard();
			return this.enroll();
		}
		this.device = key;
		if (key.id) {
			if (key.pending) this.awaitApproval(key);
			return;
		}
		const made = await this.json<{ id: string; thumbprint?: string; status?: string; expires_at?: string }>("POST", "/v1/devices", {
			json: { name: `EnrichedLab on ${hostname().replace(/\.local$/i, "")}`, jwk: key.publicJwk },
			signal: AbortSignal.timeout(15_000),
		});
		if (made.thumbprint && made.thumbprint !== key.thumbprint) throw new Error(`${this.title} registered a different key than this computer sent.`);
		// The person already has a device: this one waits until one of those approves it.
		const pending = made.status === "pending" ? (made.expires_at ?? new Date(Date.now() + 15 * 60_000).toISOString()) : undefined;
		key.registered(made.id, pending);
		if (key.pending) this.awaitApproval(key);
	}

	/** How often a key waiting for approval tries a signed read. */
	static approvalPollMs = 5_000;

	/** How long a new sandbox waits for one the lab is still deleting to free its place. */
	static leavingWaitMs = 60_000;

	/** Set by Sites: this computer's key was approved by another device, so connect again with it. */
	onApproved?: () => void;
	private approving?: ReturnType<typeof setInterval>;

	private get pendingText(): string {
		return `Approve this computer for ${this.title} from one of your other devices (el devices ${this.config.name} there, or the request it shows).`;
	}

	/** Wait for another device to approve this key: try a signed read every 5 seconds until it works or the request lapses. */
	private awaitApproval(key: DeviceKey): void {
		this.warning = this.pendingText;
		if (this.approving) return;
		this.onNotice?.(this.pendingText);
		const stop = () => {
			clearInterval(this.approving);
			this.approving = undefined;
		};
		this.approving = setInterval(async () => {
			if (!key.pending) {
				stop();
				if (key.lapsed) this.onNotice?.(`Nobody approved this computer for ${this.title} in time. Connect again (el login ${this.config.name}) to ask once more.`);
				return;
			}
			const bearer = /^(?:Bearer|DPoP)\s+(.+)$/i.exec((await this.route.headers().catch(() => ({}) as Record<string, string>)).authorization ?? "")?.[1];
			const proof = await key.proof("GET", this.publicUrl("/v1/me"), bearer, this.nonce);
			const answer = await this.call("GET", "/v1/me", { dpop: proof, signal: AbortSignal.timeout(10_000) }).then(
				async (r) => (await r.arrayBuffer(), "ok"),
				(error: { dpop?: string; code?: string }) => error.dpop ?? error.code ?? "error",
			);
			if (answer === "ok") {
				stop();
				key.approved();
				this.warning = undefined;
				this.onNotice?.(`This computer is approved for ${this.title}.`);
				this.onApproved?.();
			} else if (answer === "device_revoked") {
				stop();
				key.markRevoked();
				this.onNotice?.(`${this.title} refused this computer's key. Sign in again (el login ${this.config.name}) to ask once more.`);
			}
		}, GateSite.approvalPollMs);
		this.approving.unref?.();
	}

	/** The person's devices at this lab (GET /v1/devices). */
	async devices(): Promise<{ id: string; name?: string; status?: string; created?: string; last_seen?: string; current?: boolean; thumbprint?: string }[]> {
		if (!this.offers("devices")) throw new Error(`${this.title} doesn't bind sign-ins to devices.`);
		const listed = await this.json<unknown>("GET", "/v1/devices", { signal: AbortSignal.timeout(15_000) });
		return (Array.isArray(listed) ? listed : ((listed as { data?: unknown[] }).data ?? [])) as never;
	}

	/** Approve another of the person's devices; the lab takes it only signed by an approved device, such as this one. */
	async approveDevice(id: string): Promise<void> {
		if (!this.device?.id || this.device.pending) throw new Error(`Approve from a computer that's already approved for ${this.title}; this one isn't yet.`);
		await this.json("POST", `/v1/devices/${encodeURIComponent(id)}/approve`, { json: {}, signal: AbortSignal.timeout(15_000) });
	}

	/** Revoke one of the person's devices (a lost laptop, or a request that wasn't theirs). */
	async revokeDevice(id: string): Promise<void> {
		await this.call("DELETE", `/v1/devices/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.arrayBuffer());
	}

	/** The person's sandboxes here, newest first (GET /v1/containers); `current` is the one this engine works in. */
	async sandboxes(): Promise<LabSandbox[]> {
		if (!this.offers("containers")) throw new Error(`${this.title} has no sandboxes.`);
		type Listed = { id: string; name?: string; status?: string; reason?: string | null; image?: string | null; network?: string | null; created_at?: number; last_active_at?: number; memory_limit?: string; profile?: string };
		const when = (seconds?: number) => (typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : undefined);
		const found: LabSandbox[] = [];
		const stops = this.offers("stop");
		let after: string | undefined;
		for (let page = 0; page < 10; page++) {
			const query = new URLSearchParams({ limit: "100" });
			if (after) query.set("after", after);
			const list = await this.json<{ data?: Listed[]; has_more?: boolean }>("GET", `/v1/containers?${query}`, { signal: AbortSignal.timeout(15_000) });
			// One the lab ended itself stays listed, as deleted, so the person sees why; it holds nothing and counts toward no limit.
			for (const c of list.data ?? []) found.push({ id: c.id, name: c.name, status: c.status, reason: c.reason || undefined, image: c.image || undefined, network: c.network || undefined, created: when(c.created_at), last_active: when(c.last_active_at), memory: c.memory_limit, profile: c.profile, current: c.id === this.container, stoppable: stops && (c.status ?? "running") === "running" });
			if (!list.has_more || !list.data?.length) break;
			after = list.data[list.data.length - 1]!.id;
		}
		return found;
	}

	/** Delete one of the person's sandboxes with its files. The lab answers 202 while it still clears them. */
	async deleteSandbox(id: string): Promise<"deleted" | "deleting"> {
		const response = await this.call("DELETE", `/v1/containers/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(200_000) });
		const body = (await response.json().catch(() => ({}))) as { deleted?: boolean };
		const status = response.status === 202 || body.deleted === false ? "deleting" : "deleted";
		// The engine's own one: the next command starts a new sandbox, after this one is gone if the lab needs that.
		if (id === this.container) {
			this.container = undefined;
			if (status === "deleting") this.leaving = id;
		}
		return status;
	}

	/**
	 * Stop one of the person's running sandboxes (POST /v1/containers/{id}/stop): its files stay, it no longer counts
	 * toward how many may run at once, and its next use starts it again. The lab answers 202 while it still stops it.
	 */
	async stopSandbox(id: string): Promise<"stopped" | "stopping" | "archived"> {
		const path = `/v1/containers/${encodeURIComponent(id)}`;
		const cannot = () => new Error(`${this.title} can't stop sandboxes yet. el sandbox delete ${this.config.name} ${id} removes it, with its files.`);
		if (!this.offers("stop")) throw cannot();
		try {
			const response = await this.call("POST", `${path}/stop`, { json: {}, signal: AbortSignal.timeout(60_000) });
			const body = (await response.json().catch(() => ({}))) as { status?: string };
			if (response.status === 202 || body.status === "stopping") return "stopping";
			return body.status === "archived" ? "archived" : "stopped";
		} catch (error) {
			// A lab with no descriptor to say so may lack the route, which answers 404 too: tell that apart from an unknown id.
			if ((error as { status?: number }).status !== 404 || (await this.containerStatus(id, undefined, true)) === "deleted") throw error;
			throw cannot();
		}
	}

	async forget(): Promise<void> {
		const key = this.device ?? (this.deviceFile ? await DeviceKey.open(this.deviceFile, this.config.url) : undefined);
		if (key?.id && !key.revoked) await this.call("DELETE", `/v1/devices/${encodeURIComponent(key.id)}`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
		key?.discard();
		this.device = undefined;
	}

	private async call(
		method: string,
		path: string,
		init: {
			json?: unknown;
			body?: BodyInit;
			headers?: Record<string, string>;
			signal?: AbortSignal;
			/** a proof to send instead of a fresh one (el lab check) */
			dpop?: string;
			/** don't wait for a sandbox that's starting, or a scanner that's down; answer at once */
			noWait?: boolean;
			/** milliseconds already spent waiting for the sandbox to start or the scanner to come back */
			waited?: number;
		} = {},
		retried = false,
	): Promise<Response> {
		let body = init.body;
		const streamed = typeof ReadableStream !== "undefined" && body instanceof ReadableStream;
		if (streamed) await this.freshNonce();
		const headers: Record<string, string> = { accept: "application/json", ...init.headers, ...(await this.authHeaders(method, path)) };
		if (init.dpop !== undefined) headers.dpop = init.dpop;
		if (init.json !== undefined) {
			headers["content-type"] = "application/json";
			body = JSON.stringify(init.json);
		}
		const response = await labFetch(`${this.route.base}${path}`, {
			method,
			headers,
			body,
			signal: init.signal,
			ca: this.route.ca,
			redirect: "manual",
			...(streamed ? { duplex: "half" } : {}),
		} as RequestInit & { ca?: string });
		const nonce = this.noteNonce(response);
		if (response.status === 304) return response;
		if (response.status >= 300 && response.status < 400) throw new Error(`${this.config.name} asked for a sign-in. Run el login ${this.config.name}.`);
		const refused = response.status === 401 || response.status === 400 ? dpopError(response) : undefined;
		if (refused && init.dpop === undefined) {
			const again = !retried && !streamed;
			// Once the person has an approved device, the lab wants proofs even where they're optional; a key that waits
			// for approval can't give one yet.
			const waiting = () => Object.assign(new Error(this.pendingText), { status: 401, pending: true, dpop: refused });
			if (refused === "device_proof_required" && this.device?.pending) {
				await response.arrayBuffer();
				throw waiting();
			}
			if (refused === "use_dpop_nonce" && nonce && again) return this.call(method, path, init, true);
			if ((refused === "device_unregistered" || refused === "device_proof_required") && again && this.deviceFile && path !== "/v1/devices") {
				// No proof was sent: load (or register) this computer's key. The lab lost the key: register a new one.
				await response.arrayBuffer();
				this.device = undefined;
				if (refused === "device_unregistered") {
					const key = await DeviceKey.open(this.deviceFile, this.config.url);
					if (key.id && !key.revoked) key.discard();
				}
				await this.enroll();
				// enroll() set the key again; a new one may be waiting for approval.
				if ((this.device as DeviceKey | undefined)?.pending) throw waiting();
				return this.call(method, path, init, true);
			}
			if (refused === "device_mismatch" || refused === "signin_stale") {
				// The sign-in belongs to another key, or predates a revocation: only a new sign-in fixes it, so don't retry.
				await response.arrayBuffer();
				const why = refused === "device_mismatch" ? "is bound to another device key" : "is older than a device revocation";
				throw Object.assign(new Error(`Your sign-in to ${this.title} ${why}. Sign in again (el login ${this.config.name}).`), { status: 401 });
			}
			if (refused === "device_revoked") {
				// A revoked key is not replaced on its own: the person signs in again first.
				this.device?.markRevoked();
				throw Object.assign(new Error(`${this.title} revoked this computer's key. Sign in again (el login ${this.config.name}) to register a new one.`), { status: 401 });
			}
		}
		if ((response.status === 409 || response.status === 429 || response.status === 503) && !streamed && !init.noWait) {
			const code = ((await response.clone().json().catch(() => undefined)) as { error?: { code?: string } } | undefined)?.error?.code;
			const waited = init.waited ?? 0;
			// Answers that clear on their own: the lab is starting a stopped sandbox for this request, it's too busy to
			// take a new sandbox's lifecycle hold, its malware scanner is down while a file leaves the sandbox, or the
			// person already has as many downloads being scanned or deletes running as it allows. Wait as long as it says
			// (at most this many seconds a time), then send the request again, for up to 3 minutes in all.
			const most = code ? (WAITS[code] ?? 0) : 0;
			if (most && waited < 180_000) {
				const after = Number(response.headers.get("retry-after"));
				const wait = Math.max((Number.isFinite(after) && response.headers.has("retry-after") ? Math.min(after, most) : 5) * 1000, 1_000);
				await response.arrayBuffer();
				await sleep(wait, init.signal);
				return this.call(method, path, { ...init, waited: waited + wait }, retried);
			}
		}
		if (response.status === 410 && this.container && path.startsWith(`/v1/containers/${this.container}`)) {
			this.container = undefined;
			await response.arrayBuffer();
			throw Object.assign(new ToolError(`Your ${this.title} sandbox expired, with its files. The next command starts a new one.`), { status: 410 });
		}
		if (!response.ok) {
			const challenge = response.headers.get("www-authenticate") ?? "";
			if (response.status === 401 && this.route.via === "oauth" && /invalid_token/.test(challenge)) {
				// Cloudflare Access itself refused the token, before the request reached the site. Signing in again
				// gets another token Access will refuse the same way, so say what has to change instead.
				throw new Error(`Cloudflare Access refused the sign-in token for ${this.config.name} (invalid_token). The site's Access application has to accept OAuth tokens (its binding cookie off); signing in again won't change it.`);
			}
			const detail = ((await response.json().catch(() => undefined)) ?? {}) as { error?: { message?: string; code?: string; limit?: string } };
			const worded: Record<string, string> = {
				device_pending: this.pendingText,
				approve_requires_device: `Approve from a computer that's already approved for ${this.title}.`,
				file_refused: "The malware scanner stopped this file from leaving the sandbox.",
				scanner_unavailable: `${this.title}'s malware scanner is down, so files can't leave the sandbox right now. Try again in a few minutes.`,
				file_too_large: `This file is larger than ${this.title} lets you download. Compress or split it in the sandbox and try again.`,
				downloads_in_progress: `You have as many downloads from ${this.title} being scanned as it allows at once. Try again when one finishes.`,
				device_pending_exists: `Another new computer is already waiting for approval at ${this.title}. Approve or revoke it from one of your approved devices (el devices ${this.config.name}), then try again here.`,
			};
			// The lab's own message gives the numbers; this adds where to act on it. Stopping frees a place only under the
			// limit on sandboxes running at once (error.limit "at_once"); one of the most a person may keep ("held") takes a delete.
			const { name } = this.config;
			const cleanup = `el sandboxes ${name} lists your sandboxes there; el sandbox delete ${name} <id> removes one.`;
			const freeing = `el sandboxes ${name} lists your sandboxes there; el sandbox stop ${name} <id> stops one and keeps its files, el sandbox delete ${name} <id> removes one.`;
			const atOnce = detail.error?.limit === "at_once" && this.offers("stop");
			// Lab files go only into sandboxes without internet; work with lab data happens in one of those.
			const offline = `Lab files go only into a sandbox without internet: el sandbox create ${name} makes one.`;
			const after: Record<string, string> = { too_many_containers: atOnce ? freeing : cleanup, storage_full: cleanup, internet_no_files: offline, internet_identity_required: `Internet sandboxes are for sign-ins made for internet use, which hold no lab data; ask the lab's owner for one. ${offline}` };
			const code = detail.error?.code;
			const given = code && detail.error?.message && after[code] ? `${detail.error.message.replace(/\.?$/, ".")} ${after[code]}` : detail.error?.message;
			const message = (code && worded[code]) || given || `${this.config.name} answered ${response.status}.`;
			if (detail.error?.code === "device_pending" && this.device && !this.device.pending) {
				// The lab says this key still waits for approval: wait with it.
				this.device.registered(this.device.id ?? "", new Date(Date.now() + 15 * 60_000).toISOString());
				this.awaitApproval(this.device);
			}
			const error = new Error(response.status === 401 ? `${message.replace(/\.$/, "")}. Run el login ${this.config.name}.` : message);
			throw Object.assign(error, { status: response.status, ...(refused ? { dpop: refused } : {}), ...(detail.error?.code ? { code: detail.error.code } : {}), ...(detail.error?.limit ? { limit: detail.error.limit } : {}) });
		}
		return response;
	}

	private async json<T>(method: string, path: string, init: Parameters<GateSite["call"]>[2] = {}): Promise<T> {
		return (await (await this.call(method, path, init)).json()) as T;
	}

	/** A GET that sends the last ETag: a 304 answers from the copy kept here. */
	private async cached<T>(path: string, signal?: AbortSignal): Promise<T> {
		const kept = this.etags.get(path);
		const response = await this.call("GET", path, { headers: kept ? { "if-none-match": kept.etag } : {}, signal });
		if (response.status === 304 && kept) return kept.body as T;
		const body = (await response.json()) as T;
		const etag = response.headers.get("etag");
		if (etag) this.etags.set(path, { etag, body });
		return body;
	}
	private etags = new Map<string, { etag: string; body: unknown }>();

	descriptor?: LabDescriptor;

	/** The lab's own description, or undefined from a lab that predates it (then endpoints are probed). */
	private async readDescriptor(): Promise<LabDescriptor | undefined> {
		try {
			return await this.cached<LabDescriptor>(DESCRIPTOR_PATH, AbortSignal.timeout(10_000));
		} catch {
			return undefined;
		}
	}

	/** Whether the lab serves an endpoint: what its description says, or "try it" without one. */
	private offers(endpoint: Endpoint): boolean {
		return this.descriptor ? this.descriptor.endpoints[endpoint] === true : true;
	}

	async connect(): Promise<void> {
		this.descriptor = await this.readDescriptor();
		if (this.descriptor) {
			const problem = contractProblem(this.descriptor);
			if (problem) throw new Error(problem);
			const fit = validate(SCHEMAS.lab, this.descriptor);
			if (fit.length) this.warning = `${this.title}'s description doesn't fit the lab contract (${fit[0]}).`;
		}
		if (this.offers("devices") && this.deviceFile) {
			try {
				await this.enroll();
			} catch (error) {
				// Proofs are optional at this lab: work without them and say so. A required proof or a revoked key stops here.
				if (this.descriptor?.policy?.device_proof === "required" || (error as { revoked?: boolean }).revoked) throw error;
				this.device = undefined;
				this.warning = `Couldn't register this computer's key with ${this.title} (${redact(errorText(error))}).`;
			}
			// Waiting for approval where proofs are required: nothing works until then; the wait goes on in the background.
			if (this.device?.pending && this.descriptor?.policy?.device_proof === "required") throw Object.assign(new Error(this.pendingText), { pending: true });
		}
		const me = await this.cached<GateMe>("/v1/me", AbortSignal.timeout(10_000));
		this.who = me.handle;
		this.owner = me.owner === true;
		this.sandboxOn = me.sandboxes?.enabled === true;
		this.network = { network: me.sandboxes?.network, hosts: me.sandboxes?.hosts };
		this.networks = me.sandbox_networks;
		this.capabilities = Array.isArray(me.capabilities) ? me.capabilities.filter((c) => typeof c === "string") : [];
		this.sandboxAgents = me.sandbox_agents ?? this.descriptor?.policy?.sandbox_agents;
		const list = await this.cached<{ data?: GateModel[] }>("/v1/models", AbortSignal.timeout(10_000));
		this.models = (list.data ?? []).filter((m) => !m.gate?.endpoints?.length || m.gate.endpoints.includes("chat")).map((m) => this.profile(m));
		const tools: Tool[] = [];
		try {
			this.mcp = await connectRemote(this.config.name, { url: `${this.route.base}/mcp`, headers: (request) => this.authHeaders(request.method, request.url), ca: this.route.ca, origin: "site", answered: this.answered });
			tools.push(...this.mcp.tools);
		} catch (error) {
			this.warning = `Tools unavailable: ${redact(errorText(error))}`;
		}
		if (this.sandboxOn) tools.push(...this.sandboxTools());
		tools.push(...desktopTools(this.config.name, this.title, this));
		// Each tool knows its lab, so a session's Discovery mode applies to this lab's tools only.
		this.tools = tools.map((tool) => ({ ...tool, site: this.config.name }));
		// Waiting for approval is what the person has to act on: it leads whatever else went wrong.
		if (this.device?.pending && !this.warning?.startsWith(this.pendingText)) this.warning = [this.pendingText, this.warning].filter(Boolean).join(" ");
	}

	get title(): string {
		return this.config.title ?? this.descriptor?.title ?? this.config.name;
	}

	sandboxApi(): SandboxApi | undefined {
		return this.sandboxOn ? this : undefined;
	}

	/** Apps this person's groups may install (GET /v1/apps), withdrawn versions included. */
	async labApps(): Promise<LabAppEntry[]> {
		if (!this.offers("apps")) return [];
		return (await this.cached<{ data?: LabAppEntry[] }>("/v1/apps", AbortSignal.timeout(15_000))).data ?? [];
	}

	/** Signers the lab vouches for (GET /v1/signers), revoked ones included. */
	async signers(): Promise<LabSigner[]> {
		if (!this.offers("signers") && !this.offers("apps")) return [];
		return (await this.cached<{ data?: LabSigner[] }>("/v1/signers", AbortSignal.timeout(15_000))).data ?? [];
	}

	/** An app package from the lab, checked against its listing's size and checksum before anything reads it. */
	async appPackage(entry: LabAppEntry, signal?: AbortSignal): Promise<Uint8Array> {
		if (!entry.package.startsWith("/v1/apps/")) throw new Error(`${this.title} listed a package outside /v1/apps.`);
		const response = await this.call("GET", entry.package, { headers: { accept: "application/octet-stream" }, signal: signal ?? AbortSignal.timeout(300_000) });
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.length !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
			throw new Error(`The package ${title(entry)} that arrived doesn't match ${this.title}'s listing, so it wasn't installed.`);
		}
		return bytes;
	}

	/** Bundles this person's role is granted, from GET /v1/bundles. A Gate that doesn't serve it grants none. */
	async bundles(): Promise<BundleGrant[]> {
		if (!this.offers("bundles")) return [];
		try {
			const list = await this.cached<{ data?: BundleGrant[] }>("/v1/bundles", AbortSignal.timeout(10_000));
			return list.data ?? [];
		} catch (error) {
			if ((error as { status?: number }).status === 404) return [];
			throw error;
		}
	}

	describe(): string {
		const parts = [`${this.config.name} (${this.config.url}) as ${this.who ?? "unknown"}`];
		if (this.models.length) parts.push(`models ${this.models.map((m) => m.id).join(", ")}`);
		if (this.sandboxOn) parts.push(`an isolated Linux sandbox with no network (tools ${this.config.name}_sandbox_*)`);
		if (this.mcp?.tools.length) parts.push(`${this.mcp.tools.length} site tools`);
		return parts.join("; ");
	}

	private profile(m: GateModel): ModelProfile {
		const g = m.gate ?? {};
		const capabilities = g.capabilities ?? [];
		const reasoning = capabilities.includes("reasoning");
		const template = g.effort_field === "chat_template_kwargs";
		const efforts = reasoning ? [...(template ? ["off"] : []), ...(g.efforts?.length ? g.efforts : ["low", "medium", "high"])] : [];
		const name = this.config.name;
		return {
			ref: `${name}/${m.id}`,
			provider: name,
			id: m.id,
			label: `${m.id} · ${name}`,
			source: "site",
			// A lab runs its models on its own servers, unless it says it relays one to an outside service.
			where: g.relayed_to ? { kind: "cloud", name: g.relayed_to } : { kind: "lab", name: this.title },
			api: "openai-chat",
			baseUrl: `${this.route.base}/v1`,
			context: g.context ?? m.max_model_len ?? 131_072,
			maxOutput: g.max_output ?? 8_192,
			vision: capabilities.includes("vision"),
			efforts,
			defaultEffort: reasoning ? g.default_effort : undefined,
			effortField: reasoning ? (template ? "chat_template_kwargs" : "reasoning_effort") : "none",
			replayReasoning: reasoning,
			// Each model request carries this computer's proof when the lab binds the sign-in to it.
			headers: async (method = "POST", url = `${this.route.base}/v1/chat/completions`) => (await this.freshNonce(), this.authHeaders(method, url)),
			answered: this.answered,
			ca: this.route.ca,
		};
	}

	// ── Lab contract: events, files by reference, usage, conformance ─────────────────────────────────────────────

	/** Follow GET /v1/events from `cursor`, reconnecting with backoff. A `reset` event means re-read what was granted. */
	follow(cursor: string | undefined, on: { event(e: LabEvent): void; cursor(id: string): void; reset(): void }): () => void {
		const controller = new AbortController();
		if (!this.offers("events")) return () => undefined;
		let last = cursor;
		void (async () => {
			let wait = 2_000;
			while (!controller.signal.aborted) {
				try {
					const response = await this.call("GET", "/v1/events", { headers: { accept: "text/event-stream", ...(last ? { "last-event-id": last } : {}) }, signal: controller.signal });
					if (!response.body) throw new Error("The lab sent no event stream.");
					wait = 2_000;
					for await (const message of sseData(response.body, controller.signal)) {
						if (message.event === "reset") {
							on.reset();
							let next = message.id;
							try {
								next = (JSON.parse(message.data) as { cursor?: string }).cursor ?? next;
							} catch {
								// The id field carries the cursor.
							}
							if (next) on.cursor((last = next));
							continue;
						}
						let event: LabEvent;
						try {
							event = JSON.parse(message.data) as LabEvent;
						} catch {
							continue;
						}
						if (message.id) on.cursor((last = message.id));
						if (typeof event.type === "string") on.event(event);
					}
				} catch (error) {
					if (controller.signal.aborted) return;
					// A lab without the stream, or a sign-in that ended: stop; the next connect starts again.
					const status = (error as { status?: number }).status;
					if (status === 404 || status === 401 || status === 403) return;
				}
				await sleep(wait, controller.signal).catch(() => undefined);
				wait = Math.min(wait * 2, 60_000);
			}
		})();
		return () => controller.abort();
	}

	/** A file a lab tool returned by reference. Only the lab's own addresses are fetched, with the lab's sign-in. */
	async fetchFile(uri: string, signal: AbortSignal): Promise<Uint8Array> {
		const base = [this.route.base, new URL(this.config.url).origin].find((b) => uri === b || uri.startsWith(`${b}/`));
		if (!base) throw new Error(`${uri} isn't an address of ${this.title}.`);
		// A transfer that broke off (or doesn't match its checksum) is tried once more from the start.
		for (let tries = 0; ; tries++) {
			const response = await this.call("GET", uri.slice(base.length), { headers: { accept: "*/*" }, signal });
			const bytes = await response.arrayBuffer().then(
				(b) => new Uint8Array(b),
				(error: Error) => {
					if (tries || signal.aborted) throw error;
					return undefined;
				},
			);
			if (!bytes) continue;
			const said = reprSha256(response);
			if (!said || said === createHash("sha256").update(bytes).digest("hex")) return bytes;
			if (tries) throw new Error(`The file from ${this.title} doesn't match the checksum the lab sent with it.`);
		}
	}

	/** POST /rein/api/sessions/import: Rein makes a session from the shared log's lines (docs/session-log.md). */
	async reinImport(lines: string, title: string): Promise<unknown> {
		return this.json("POST", `/rein/api/sessions/import?title=${encodeURIComponent(title)}`, { body: lines, headers: { "content-type": "application/x-ndjson", "x-rein": "1" }, signal: AbortSignal.timeout(120_000) });
	}

	/** GET /rein/api/sessions/{id}/export: a Rein session as the shared log's lines. */
	async reinExport(id: string): Promise<string> {
		const response = await this.call("GET", `/rein/api/sessions/${encodeURIComponent(id)}/export`, { headers: { accept: "application/x-ndjson, application/jsonl" }, signal: AbortSignal.timeout(120_000) });
		return response.text();
	}

	/** Use by lab and group (GET /v1/usage). */
	async usage(window: "7d" | "30d"): Promise<unknown> {
		if (!this.offers("usage")) throw new Error(`${this.title} doesn't report usage.`);
		return this.json("GET", `/v1/usage?window=${window}`, { signal: AbortSignal.timeout(15_000) });
	}

	/**
	 * `el lab check`: read the description, then exercise each endpoint it lists against contract/. Read-only apart
	 * from one sandbox it makes and deletes, and one guard call with harmless text.
	 */
	async check(): Promise<CheckRow[]> {
		const rows: CheckRow[] = [];
		const add = (row: string, status: CheckRow["status"], detail?: string) => rows.push({ row, status, ...(detail ? { detail } : {}) });
		const fits = (row: string, schema: keyof typeof SCHEMAS, value: unknown, note?: string) => {
			const problems = validate(SCHEMAS[schema], value);
			add(row, problems.length ? "fail" : "pass", problems.length ? problems.slice(0, 3).join("; ") : note);
		};
		const attempt = async (row: string, run: () => Promise<unknown>) => {
			try {
				await run();
			} catch (error) {
				add(row, "fail", redact(errorText(error)));
			}
		};
		const t = () => AbortSignal.timeout(20_000);

		let d: LabDescriptor | undefined;
		await attempt("descriptor", async () => {
			const response = await this.call("GET", DESCRIPTOR_PATH, { signal: t() });
			d = (await response.json()) as LabDescriptor;
			fits("descriptor", "lab", d, `${d.title}, contract ${d.contract}`);
			const problem = contractProblem(d);
			add("contract version", problem ? "fail" : "pass", problem ?? `${d.contract} (this client: ${CONTRACT})`);
		});
		const has = (endpoint: Endpoint) => d?.endpoints?.[endpoint] === true;
		const skip = (row: string) => add(row, "skip", "not listed in the descriptor");

		await attempt("GET /v1/me", async () => fits("GET /v1/me", "me", await this.json("GET", "/v1/me", { signal: t() })));
		await attempt("ETag on /v1/me", async () => {
			const first = await this.call("GET", "/v1/me", { signal: t() });
			const etag = first.headers.get("etag");
			await first.arrayBuffer();
			if (!etag) return add("ETag on /v1/me", "fail", "no ETag header");
			const again = await this.call("GET", "/v1/me", { headers: { "if-none-match": etag }, signal: t() });
			await again.arrayBuffer();
			// A proxy that compresses (Cloudflare does) turns a strong ETag into a weak one; If-None-Match must still match.
			const weak = etag.startsWith("W/") ? `; the ETag arrived weak (${etag}), so compare without the W/ prefix (RFC 9110 weak comparison)` : "";
			add("ETag on /v1/me", again.status === 304 ? "pass" : "fail", again.status === 304 ? undefined : `answered ${again.status} to If-None-Match${weak}`);
		});
		await attempt("GET /v1/models", async () => {
			const list = await this.json<{ data?: unknown[] }>("GET", "/v1/models", { signal: t() });
			fits("GET /v1/models", "models", list, `${list.data?.length ?? 0} models`);
		});

		if (has("devices")) {
			const key = this.device;
			if (!key?.id) add("device key", "fail", this.warning ?? "this computer's key isn't registered");
			else if (key.pending) add("device key", "skip", "registered; waiting for one of your other devices to approve it, so proofs can't be tried yet");
			else {
				await attempt("device key", async () => {
					const listed = await this.json<unknown>("GET", "/v1/devices", { signal: t() });
					const devices = (Array.isArray(listed) ? listed : ((listed as { data?: unknown[] }).data ?? [])) as { id?: string; thumbprint?: string; current?: boolean; revoked?: boolean }[];
					const mine = devices.find((x) => x.id === key.id) as { id?: string; thumbprint?: string; revoked?: unknown; status?: string; current?: boolean } | undefined;
					const fits = mine && mine.thumbprint === key.thumbprint && !mine.revoked && (mine.status === undefined || mine.status === "active");
					add("device key", fits ? "pass" : "fail", !mine ? "the lab doesn't list this computer's key" : fits ? `registered${mine.current ? ", marked current" : ""}` : `listed ${mine.status ?? ""} with ${mine.thumbprint === key.thumbprint ? "this" : "another"} thumbprint`.replace("  ", " "));
				});
				// A lab that accepts these bound nothing: each must be refused, as an invalid proof. Each proof carries the
				// lab's current nonce, so the refusal is for what the row tests.
				const bearer = /^(?:Bearer|DPoP)\s+(.+)$/i.exec((await this.route.headers()).authorization ?? "")?.[1];
				const answer = (dpop: string) =>
					this.call("GET", "/v1/me", { dpop, signal: t() }).then(
						async (r) => (await r.arrayBuffer(), { status: r.status, code: undefined as string | undefined }),
						(e: { status?: number; dpop?: string }) => ({ status: e.status, code: e.dpop }),
					);
				const current = async () => (await this.call("GET", "/v1/me", { signal: t() }).then((r) => r.arrayBuffer()).catch(() => undefined), this.nonce);
				const refusedRight = (got: { status?: number; code?: string }) => got.status === 401 && (!got.code || got.code === "invalid_dpop_proof");
				const said = (got: { status?: number; code?: string }) => `answered ${got.status ?? "?"}${got.code ? ` ${got.code}` : ""}`;
				const me = this.publicUrl("/v1/me");
				await attempt("proof for another token", async () => {
					const nonce = await current();
					const got = await answer(await key.proof("GET", me, "not-the-token-this-request-carries", nonce));
					// Behind Cloudflare Access the lab never sees the token: Access takes it and forwards its own assertion. The
					// proof's token hash has nothing to be compared with there; the lab's nonce has to tie proofs to the sign-in.
					if (got.status === 200 && nonce && d?.sign_in?.kind === "cloudflare-access-oauth") {
						return add("proof for another token", "skip", "Cloudflare Access keeps the token from the lab, so it can't compare it; the lab's nonce has to bind proofs to the sign-in (next row)");
					}
					add("proof for another token", refusedRight(got) ? "pass" : "fail", said(got));
				});
				await attempt("proof with a made-up nonce", async () => {
					if (!(await current())) return add("proof with a made-up nonce", "skip", "the lab doesn't use DPoP nonces");
					const made = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64");
					const got = await answer(await key.proof("GET", me, bearer, made));
					add("proof with a made-up nonce", got.status === 401 && got.code === "use_dpop_nonce" ? "pass" : "fail", said(got));
				});
				await attempt("proof for another address", async () => {
					const got = await answer(await key.proof("GET", this.publicUrl("/v1/models"), bearer, await current()));
					add("proof for another address", refusedRight(got) ? "pass" : "fail", said(got));
				});
				await attempt("proof used twice", async () => {
					const proof = await key.proof("GET", me, bearer, await current());
					const first = await answer(proof);
					const second = await answer(proof);
					add("proof used twice", first.status === 200 && refusedRight(second) ? "pass" : "fail", `first ${first.status ?? "?"}, again ${said(second).replace("answered ", "")}`);
				});
			}
		} else skip("device key");

		if (has("mcp") || !d) {
			await attempt("MCP tools", async () => {
				const connection = await connectRemote(`${this.config.name}-check`, { url: `${this.route.base}/mcp`, headers: (request) => this.authHeaders(request.method, request.url), ca: this.route.ca, origin: "site", answered: this.answered });
				const unreviewed = connection.tools.filter((tool) => tool.unreviewed).length;
				add("MCP tools", "pass", `${connection.tools.length} tools${unreviewed ? `, ${unreviewed} unreviewed` : ""}`);
				const data = d?.conformance?.data_tool;
				if (data) {
					const tool = connection.tools.find((x) => x.name.endsWith(`_${data.name}`) || x.name === data.name);
					if (!tool) add("data by reference", "fail", `no tool named ${data.name}`);
					else {
						const result = await tool.run(data.arguments ?? {}, { signal: t() } as never);
						const files = result.view?.files ?? [];
						if (!files.length && result.content.length < 2_000) {
							// Nothing to list proves nothing either way; the lab can name arguments that always return a sample file.
							add("data by reference", "skip", `the tool returned no files ("${result.content.trim().slice(0, 80)}"); give conformance.data_tool arguments that return a sample file`);
						} else {
							const referenced = files.length > 0 && files.every((f) => f.sha256);
							add("data by reference", referenced && result.content.length < 20_000 ? "pass" : "fail", referenced ? `${files.length} files with checksums` : "the result carried no file references with checksums");
						}
					}
				} else add("data by reference", "skip", "the descriptor names no conformance.data_tool");
				await connection.close();
			});
		} else skip("MCP tools");

		if (has("apps")) {
			await attempt("GET /v1/apps", async () => {
				const list = await this.json<{ data?: unknown[] }>("GET", "/v1/apps", { signal: t() });
				fits("GET /v1/apps", "apps", list, `${list.data?.length ?? 0} app versions`);
			});
			await attempt("GET /v1/signers", async () => {
				const list = await this.json<{ data?: unknown[] }>("GET", "/v1/signers", { signal: t() });
				fits("GET /v1/signers", "signers", list, `${list.data?.length ?? 0} signers`);
			});
		} else skip("GET /v1/apps");

		if (has("bundles")) await attempt("GET /v1/bundles", async () => fits("GET /v1/bundles", "bundles", await this.json("GET", "/v1/bundles", { signal: t() })));
		else skip("GET /v1/bundles");

		if (has("guard")) {
			await attempt("POST /v1/guard", async () => {
				const answer = await this.json<{ decision?: string }>("POST", "/v1/guard", { json: { stage: "input", text: "Summarize the yield table by treatment." }, signal: t() });
				fits("POST /v1/guard", "guard", answer, `decision ${answer.decision}`);
				if (answer.decision === "block") add("guard on harmless text", "fail", "it blocked a plain request");
			});
		} else skip("POST /v1/guard");

		if (has("usage")) {
			await attempt("GET /v1/usage", async () => fits("GET /v1/usage", "usage", await this.json("GET", "/v1/usage?window=7d", { signal: t() })));
			const foreign = d?.conformance?.foreign_scope;
			if (foreign) {
				await attempt("another lab's scope", async () => {
					const response = await this.call("GET", `/v1/usage?window=7d&lab=${encodeURIComponent(foreign)}`, { signal: t() }).catch((error: { status?: number }) => error);
					const status = response instanceof Response ? response.status : response.status;
					add("another lab's scope", status === 403 || status === 404 ? "pass" : "fail", `answered ${status ?? "?"}`);
				});
			} else add("another lab's scope", "skip", "the descriptor names no conformance.foreign_scope");
		} else skip("GET /v1/usage");

		if (has("files") && d?.conformance?.scan_test) {
			await attempt("scanner refuses a test file", async () => {
				// A lab that offers it refuses the EICAR test file like malware, without flagging the person to its owner.
				const eicar = String.fromCharCode(...EICAR_SHIFTED.map((c) => c - 1));
				const boundary = `enrichedlab-${randomBytes(12).toString("hex")}`;
				const form = `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nuser_data\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="el-scan-test.txt"\r\nContent-Type: text/plain\r\n\r\n${eicar}\r\n--${boundary}--\r\n`;
				const got = await this.call("POST", "/v1/files", { body: form, headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, signal: t() }).then(
					async (r) => ({ status: r.status, code: undefined as string | undefined, kept: ((await r.json().catch(() => ({}))) as { id?: string }).id }),
					(e: { status?: number; code?: string }) => ({ status: e.status, code: e.code, kept: undefined as string | undefined }),
				);
				// A lab that kept it: remove it again.
				if (got.kept) await this.call("DELETE", `/v1/files/${encodeURIComponent(got.kept)}`, { signal: t() }).then((r) => r.arrayBuffer(), () => undefined);
				const refused = got.status === 422 && got.code === "file_refused";
				add("scanner refuses a test file", refused ? "pass" : "fail", refused ? "422 file_refused" : got.kept ? "the lab kept the EICAR test file" : `answered ${got.status ?? "?"}${got.code ? ` ${got.code}` : ""}`);
			});
		} else add("scanner refuses a test file", "skip", has("files") ? "the descriptor doesn't offer conformance.scan_test" : "not listed in the descriptor");

		if (has("containers")) {
			await attempt("sandbox", async () => {
				const profile = d?.sandbox_profiles?.[0]?.name;
				const made = await this.json<{ id: string }>("POST", "/v1/containers", { json: { name: "el-lab-check", ...(profile ? { profile } : {}) }, signal: AbortSignal.timeout(300_000) });
				fits("sandbox made", "container", made, profile ? `profile ${profile}` : undefined);
				try {
					const ran = await this.json<{ exit_code?: number; stdout?: string }>("POST", `/v1/containers/${made.id}/exec`, { json: { command: "echo ok", timeout_seconds: 30 }, signal: AbortSignal.timeout(120_000) });
					add("sandbox runs a command", ran.exit_code === 0 && ran.stdout?.trim() === "ok" ? "pass" : "fail", `exit ${ran.exit_code}`);
					await attempt("long command", async () => {
						// Agents write files as long commands: a 64 KB one runs, or the lab refuses it with a size it says.
						const filler = "x".repeat(64 * 1024);
						const long = await this.call("POST", `/v1/containers/${made.id}/exec`, { json: { command: `printf %s '${filler}' | wc -c`, timeout_seconds: 30 }, noWait: true, signal: t() }).then(
							async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as { exit_code?: number; stdout?: string } }),
							(e: { status?: number; code?: string; message?: string }) => ({ status: e.status ?? 0, body: { stdout: `${e.code ?? ""} ${e.message ?? ""}`.trim() } }),
						);
						const ran = long.status === 200 && long.body.stdout?.trim() === String(filler.length);
						add("long command", ran || long.status === 413 ? "pass" : "fail", ran ? "a 64 KB command ran" : long.status === 413 ? "413: the lab says it's too long" : `answered ${long.status}: ${String(long.body.stdout ?? "").slice(0, 120)}`);
					});
					if (d?.sandbox_jobs === false) add("background job", "skip", "not offered (the descriptor says sandbox_jobs: false)");
					else await attempt("background job", async () => {
						const job = await this.json<{ id: string }>("POST", `/v1/containers/${made.id}/jobs`, { json: { command: "echo el-job-ok" }, signal: t() });
						let state: { status?: string; exit_code?: number | null; log?: string } = {};
						for (const until = Date.now() + 30_000; Date.now() < until; await sleep(1_000)) {
							state = await this.json("GET", `/v1/containers/${made.id}/jobs/${encodeURIComponent(job.id)}?log_bytes=1000`, { signal: t() });
							if (state.status !== "queued" && state.status !== "running") break;
						}
						add("background job", state.exit_code === 0 && state.log?.includes("el-job-ok") ? "pass" : "fail", `${state.status ?? "?"}${state.exit_code !== undefined && state.exit_code !== null ? ` (exit ${state.exit_code})` : ""}`);
					});
					await attempt("file download", async () => {
						// A small file in and out again: the lab scans it on the way out and says the checksum it passed (RFC 9530).
						const text = `el-file-ok ${randomBytes(6).toString("hex")}\n`;
						const boundary = `enrichedlab-${randomBytes(12).toString("hex")}`;
						const form = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="el-check.txt"\r\nContent-Type: text/plain\r\n\r\n${text}\r\n--${boundary}--\r\n`;
						const sent = await this.json<{ path: string }>("POST", `/v1/containers/${made.id}/files`, { body: form, headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, signal: t() });
						const list = await this.json<{ data: { id: string; path: string }[] }>("GET", `/v1/containers/${made.id}/files?limit=100&order=asc`, { signal: t() });
						const file = list.data.find((f) => f.path === sent.path);
						if (!file) return add("file download", "fail", `the file list doesn't show ${sent.path}`);
						const got = await this.call("GET", `/v1/containers/${made.id}/files/${file.id}/content`, { headers: { accept: "*/*" }, signal: t() });
						const bytes = Buffer.from(await got.arrayBuffer());
						const said = reprSha256(got);
						if (bytes.toString() !== text) return add("file download", "fail", "the bytes that came back differ from the ones sent");
						const right = said === createHash("sha256").update(bytes).digest("hex");
						add("file download", right ? "pass" : "fail", right ? "same bytes, and Repr-Digest matches them" : said ? "Repr-Digest doesn't match the bytes" : "no Repr-Digest header");
					});
					// Whole-disk checkpoints: one made, listed, brought back (a file written after it is gone), then removed.
					if (has("checkpoints")) {
						await attempt("sandbox checkpoints", async () => {
							const at = `/v1/containers/${encodeURIComponent(made.id)}`;
							const point = await this.json<{ id: string; container?: string; at?: string }>("POST", `${at}/checkpoints`, { json: { label: "el lab check" }, signal: t() });
							if (!point.id || !point.at) return add("sandbox checkpoints", "fail", "the answer has no id or time");
							await this.json("POST", `${at}/exec`, { json: { command: "echo after > /sandbox/work/el-after.txt", timeout_seconds: 30 }, signal: t() });
							const listed = await this.json<{ checkpoints?: { id: string }[] }>("GET", `${at}/checkpoints`, { signal: t() });
							if (!listed.checkpoints?.some((c) => c.id === point.id)) return add("sandbox checkpoints", "fail", "the list doesn't show the checkpoint just made");
							await this.json("POST", `${at}/checkpoints/${encodeURIComponent(point.id)}/restore`, { json: {}, signal: t() });
							let status = "";
							for (const end = Date.now() + 180_000; Date.now() < end && status !== "running"; await sleep(1_000)) status = await this.containerStatus(made.id, t(), true);
							if (status !== "running") return add("sandbox checkpoints", "fail", `not running 3 minutes after restore (${status})`);
							const left = await this.json<{ exit_code?: number }>("POST", `${at}/exec`, { json: { command: "test ! -e /sandbox/work/el-after.txt", timeout_seconds: 30 }, signal: t() });
							await this.call("DELETE", `${at}/checkpoints/${encodeURIComponent(point.id)}`, { signal: t() }).then((r) => r.arrayBuffer(), () => undefined);
							add("sandbox checkpoints", left.exit_code === 0 ? "pass" : "fail", left.exit_code === 0 ? "made, listed, and restored: a file written after it is gone" : "a file written after the checkpoint is still there after restore");
						});
					}
					if (has("attach")) {
						const url = `${this.route.base}/v1/containers/${encodeURIComponent(made.id)}/attach`;
						const process = await attachSocket(url.replace(/^http/, "ws"), await this.authHeaders("GET", url), { argv: ["sh", "-c", "read line; echo got:$line; read more; echo also:$more; echo note >&2; exit 3"], timeout_seconds: 60 }, this.route.ca);
						let out = "";
						let err = "";
						process.onStdout((c) => (out += new TextDecoder().decode(c)));
						process.onStderr((c) => (err += new TextDecoder().decode(c)));
						// MCP backends talk over a live stdin: the first answer has to come back before stdin closes.
						process.write("hello\n");
						for (const until = Date.now() + 15_000; !out.includes("got:hello") && Date.now() < until; ) await sleep(200);
						const live = out.includes("got:hello");
						process.write("again\n");
						process.end();
						const code = await Promise.race([process.exit, sleep(30_000).then(() => "timeout" as const)]);
						process.close();
						const fits = code === 3 && out.includes("got:hello") && out.includes("also:again") && err.trim() === "note";
						add("attach", fits ? "pass" : "fail", fits ? "stdin in, stdout and stderr out, exit code" : `exit ${code}, stdout ${JSON.stringify(out.slice(0, 40))}, stderr ${JSON.stringify(err.slice(0, 40))}`);
						add("attach streams stdin", live ? "pass" : "fail", live ? "an answer came back while stdin was still open" : "nothing came back until stdin closed, so an MCP backend can't talk over it");
					}
					if (has("ports")) {
						// A web server in the sandbox, read through the lab's port path; app pages must come sandboxed (CSP).
						const served = await this.json<{ exit_code?: number }>("POST", `/v1/containers/${made.id}/exec`, {
							json: { command: "command -v python3 >/dev/null || exit 3; mkdir -p /tmp/el-check && echo el-port-ok > /tmp/el-check/index.html && (cd /tmp/el-check && nohup python3 -m http.server 8765 >/dev/null 2>&1 &) && sleep 2", timeout_seconds: 30 },
							signal: AbortSignal.timeout(60_000),
						});
						if (served.exit_code === 3) add("sandbox port", "skip", "the sandbox image has no python3 to serve a page");
						else {
							const page = await this.call("GET", `/v1/containers/${made.id}/ports/8765/`, { headers: { accept: "text/html" }, signal: t() }).catch((error: { status?: number; message?: string }) => error);
							if (!(page instanceof Response)) add("sandbox port", "fail", `answered ${page.status ?? page.message}`);
							else {
								const text = await page.text();
								const csp = page.headers.get("content-security-policy") ?? "";
								add("sandbox port", text.includes("el-port-ok") ? "pass" : "fail", text.includes("el-port-ok") ? "the page came through" : `answered ${page.status} without the page`);
								add("app pages sandboxed", /(^|;)\s*sandbox\b/.test(csp) ? "pass" : "fail", csp ? `Content-Security-Policy: ${csp.slice(0, 80)}` : "no Content-Security-Policy");
							}
						}
					}
				} finally {
					await this.call("DELETE", `/v1/containers/${made.id}`, { signal: t() }).catch(() => undefined);
				}
			});
		} else skip("sandbox");
		// A lab with sandbox images: one it doesn't offer is refused, and its browser image's DevTools answer through the
		// port path (the browser starts on first contact), with the WebSocket address Chrome gives rewritten to that path.
		if (has("containers") && d?.sandbox_images) {
			await attempt("unknown image refused", async () => {
				const got = await this.call("POST", "/v1/containers", { json: { name: "el-lab-check", image: "el-check-no-such-image" }, signal: t() }).then(
					async (r) => ({ status: r.status, code: undefined as string | undefined, id: ((await r.json().catch(() => ({}))) as { id?: string }).id }),
					(e: { status?: number; code?: string }) => ({ status: e.status, code: e.code, id: undefined as string | undefined }),
				);
				if (got.id) await this.call("DELETE", `/v1/containers/${encodeURIComponent(got.id)}`, { signal: t() }).then((r) => r.arrayBuffer(), () => undefined);
				add("unknown image refused", got.status === 400 && got.code === "unknown_image" ? "pass" : "fail", got.id ? "the lab made a sandbox from an image it doesn't list" : `answered ${got.status ?? "?"}${got.code ? ` ${got.code}` : ""}`);
			});
		}
		const browserInfo = d?.browser;
		// The DevTools of the browser in sandbox `id`, through its port path with this sign-in; undefined when the
		// browser gives no WebSocket address.
		const devtools = async (id: string, port: number): Promise<Cdp | undefined> => {
			const path = `/v1/containers/${encodeURIComponent(id)}/ports/${port}`;
			const version = await this.json<{ webSocketDebuggerUrl?: string }>("GET", `${path}/json/version`, { signal: AbortSignal.timeout(120_000) });
			if (!version.webSocketDebuggerUrl) return undefined;
			const url = `${this.route.base}${path}${new URL(version.webSocketDebuggerUrl).pathname}`;
			await this.freshNonce();
			return Cdp.open(url.replace(/^http/, "ws"), await this.authHeaders("GET", url), this.route.ca);
		};
		if (has("containers") && has("ports") && browserInfo?.protocol === "cdp" && browserInfo.image) {
			await attempt("browser sandbox", async () => {
				const made = await this.json<{ id: string }>("POST", "/v1/containers", { json: { name: "el-lab-check-browser", image: browserInfo.image }, signal: AbortSignal.timeout(300_000) });
				try {
					const cdp = await devtools(made.id, browserInfo.port);
					if (!cdp) return add("browser sandbox", "fail", "json/version gave no webSocketDebuggerUrl");
					try {
						const got = await cdp.send<{ product?: string }>("Browser.getVersion");
						add("browser sandbox", got.product ? "pass" : "fail", got.product ? `${got.product} in the ${browserInfo.image} image` : "Browser.getVersion gave no product");
					} finally {
						cdp.close();
					}
				} finally {
					await this.call("DELETE", `/v1/containers/${encodeURIComponent(made.id)}`, { signal: t() }).then((r) => r.arrayBuffer(), () => undefined);
				}
			});
		}
		// A lab that offers a desktop sandbox: a PNG of the size it names, no shell, and no address carrying a user and
		// password. The desktop starts on first contact; call() waits out sandbox_starting and desktop_unavailable.
		const desktopInfo = d?.sandbox_desktops?.find((x) => (x.os ?? "linux") === "linux") ?? d?.sandbox_desktop;
		if (has("containers") && desktopInfo?.image) {
			await attempt("desktop sandbox", async () => {
				const made = await this.json<{ id: string }>("POST", "/v1/containers", { json: { name: "el-lab-check-desktop", image: desktopInfo.image }, signal: AbortSignal.timeout(300_000) });
				const at = `/v1/containers/${encodeURIComponent(made.id)}`;
				const refused = (path: string, json: Record<string, unknown>) =>
					this.call("POST", `${at}/${path}`, { json, signal: t() }).then(
						async (r) => (await r.arrayBuffer(), { status: r.status as number | undefined, code: undefined as string | undefined }),
						(e: { status?: number; code?: string }) => ({ status: e.status, code: e.code }),
					);
				const said = (got: { status?: number; code?: string }) => `answered ${got.status ?? "?"}${got.code ? ` ${got.code}` : ""}`;
				try {
					const shot = await this.json<{ screenshot?: { png?: string } }>("POST", `${at}/desktop`, { json: { action: "screenshot", by: "agent" }, signal: AbortSignal.timeout(180_000) });
					const png = Buffer.from(shot.screenshot?.png ?? "", "base64");
					const isPng = png.length > 24 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
					const [w, h] = isPng ? [png.readUInt32BE(16), png.readUInt32BE(20)] : [0, 0];
					const want = desktopInfo.screen;
					if (!isPng) add("desktop sandbox", "fail", "a screenshot gave no PNG under screenshot.png");
					else if (want && (w !== want.width || h !== want.height)) add("desktop sandbox", "fail", `the screenshot is ${w}x${h}; the descriptor says ${want.width}x${want.height}`);
					else add("desktop sandbox", "pass", `a ${w}x${h} screenshot from the ${desktopInfo.image} image`);
					const exec = await refused("exec", { command: "id", timeout_seconds: 10 });
					add("desktop sandbox has no shell", exec.status === 403 && exec.code === "desktop_no_shell" ? "pass" : "fail", `exec ${said(exec)}`);
					if (desktopInfo.open) {
						const open = await refused("desktop/open", { target: "https://check:check@example.com/", by: "agent" });
						add("desktop refuses an address with a password", open.status === 400 ? "pass" : "fail", said(open));
					}
					// A desktop that streams: the live view opens with the screen's size and sends a band of it.
					if (desktopInfo.stream) {
						const url = `${this.route.base}${at}/desktop/stream`;
						const socket = new WebSocket(url.replace(/^http/, "ws"), { headers: await this.authHeaders("GET", url), protocols: ["gate.desktop.v1"], ...(this.route.ca ? { tls: { ca: this.route.ca } } : {}) } as unknown as string[]);
						socket.binaryType = "arraybuffer";
						const seen = await new Promise<string>((resolve) => {
							let size = "";
							const timer = setTimeout(() => (socket.close(), resolve(size ? `${size}, but no band within 20 s` : "no hello within 20 s")), 20_000);
							socket.onmessage = (event) => {
								if (typeof event.data === "string") {
									const hello = JSON.parse(event.data) as { type?: string; width?: number; height?: number };
									if (hello.type === "hello") size = `${hello.width}x${hello.height}`;
									return;
								}
								clearTimeout(timer);
								socket.close(1000);
								resolve(`ok ${size}, a ${(event.data as ArrayBuffer).byteLength}-byte band`);
							};
							socket.onclose = (event) => (clearTimeout(timer), resolve(`closed ${event.code}${event.reason ? ` ${event.reason}` : ""}`));
						});
						add("desktop live view", seen.startsWith("ok ") ? "pass" : "fail", seen.replace(/^ok /, "hello "));
					}
					// A desktop that reads its own state: the windows, then an app started and brought forward by its id.
					const act = <T>(json: Record<string, unknown>) => this.json<T>("POST", `${at}/desktop`, { json: { ...json, by: "agent" }, signal: AbortSignal.timeout(120_000) });
					type State = { state?: { windows?: { id?: string; app?: string; title?: string }[]; focused?: { nodes?: number } } };
					if (desktopInfo.actions.includes("state")) {
						const first = await act<State>({ action: "state" });
						const windows = first.state?.windows;
						add("desktop state", Array.isArray(windows) ? "pass" : "fail", Array.isArray(windows) ? `${windows.length} window${windows.length === 1 ? "" : "s"}` : "the answer has no state.windows");
						const app = desktopInfo.apps?.find((a) => a.id !== "browser")?.id ?? desktopInfo.apps?.[0]?.id;
						if (app && desktopInfo.actions.includes("launch") && desktopInfo.actions.includes("focus_window")) {
							// The new window: the one launch names, else one that wasn't there before it.
							const before = new Set((first.state?.windows ?? []).map((w) => w.id));
							const launched = await act<{ window?: { id?: string } | string }>({ action: "launch", app });
							let id = typeof launched.window === "string" ? launched.window : launched.window?.id;
							let seen: { id?: string; app?: string; title?: string }[] = [];
							for (let i = 0; !id && i < 15; i++) {
								await sleep(1_000);
								seen = (await act<State>({ action: "state" })).state?.windows ?? [];
								id = seen.find((w) => w.id && !before.has(w.id))?.id;
							}
							if (!id) add("desktop launch and focus", "fail", `no new window within 15 s of launch ${app}${seen.length ? `; windows: ${seen.map((w) => `${w.id} ${w.app ?? ""} "${w.title ?? ""}"`).join(", ")}` : ""}`);
							else {
								await act({ action: "focus_window", window: id });
								const after = await act<State>({ action: "state" });
								const focused = after.state?.windows?.find((w) => w.id === id) as { focused?: boolean } | undefined;
								add("desktop launch and focus", focused?.focused ? "pass" : "fail", focused?.focused ? `${app} opened ${id}, focused, with ${after.state?.focused?.nodes ?? "?"} controls` : `${id} isn't focused after focus_window`);
							}
						}
					}
				} finally {
					await this.call("DELETE", `/v1/containers/${encodeURIComponent(made.id)}`, { signal: t() }).then((r) => r.arrayBuffer(), () => undefined);
				}
			});
		}
		// A lab that offers internet sandboxes: one reaches the public web but no private address, and takes no lab files.
		if (has("containers") && d?.sandbox_networks?.some((n) => n.name === "internet")) {
			await attempt("internet sandbox", async () => {
				const allowed = (await this.json<GateMe>("GET", "/v1/me", { signal: t() })).sandbox_networks ?? [];
				if (!allowed.includes("internet")) return add("internet sandbox", "skip", "your policy doesn't allow internet sandboxes");
				const made = await this.json<{ id: string; network?: string | null }>("POST", "/v1/containers", { json: { name: "el-lab-check-internet", network: "internet" }, signal: AbortSignal.timeout(300_000) });
				try {
					if (made.network !== "internet") return add("internet sandbox", "fail", `the lab made it with network ${made.network ?? "unset"}`);
					const run = (command: string) => this.json<{ exit_code?: number; stdout?: string }>("POST", `/v1/containers/${encodeURIComponent(made.id)}/exec`, { json: { command, timeout_seconds: 45 }, signal: AbortSignal.timeout(120_000) });
					// Python's urllib follows HTTPS_PROXY, the way the lab's internet is reached.
					const fetchCommand = (url: string, seconds: number) => `python3 -c 'import urllib.request; print(urllib.request.urlopen("${url}", timeout=${seconds}).status)'`;
					const web = await run(fetchCommand("https://example.com/", 20));
					if (web.exit_code === 127) return add("internet sandbox", "skip", "the sandbox image has no python3 to fetch a page");
					add("internet sandbox", web.exit_code === 0 && web.stdout?.trim() === "200" ? "pass" : "fail", web.exit_code === 0 ? `https://example.com/ answered ${web.stdout?.trim()}` : `fetching https://example.com/ failed (exit ${web.exit_code})`);
					// The proxy is the only way out: a direct connection, with no proxy set, fails.
					const direct = await run(`env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy python3 -c 'import socket; socket.create_connection(("example.com", 443), timeout=8)'`);
					add("internet sandbox only through its proxy", direct.exit_code === 0 ? "fail" : "pass", direct.exit_code === 0 ? "a direct connection to example.com:443 got through without the proxy" : "a direct connection without the proxy failed");
					// The proxy refuses every private destination, IPv6 spellings of private IPv4 addresses included.
					const probe = await run(`python3 -c '${PRIVATE_PROBE}' ${PRIVATE_TARGETS.map((target) => `'${target}'`).join(" ")}`);
					let answers: Record<string, string> = {};
					try {
						answers = JSON.parse(probe.stdout?.trim() || "{}") as Record<string, string>;
					} catch {}
					const reached = PRIVATE_TARGETS.filter((target) => answers[target] === "reached");
					const unclear = PRIVATE_TARGETS.filter((target) => answers[target] !== "reached" && answers[target] !== "refused");
					if (reached.length) add("internet sandbox private addresses", "fail", `reached a private address: ${reached.join(", ")}`);
					else if (unclear.length) add("internet sandbox private addresses", "fail", `not refused: ${unclear.map((target) => `${target} (${answers[target] ?? `no result, exit ${probe.exit_code ?? "?"}`})`).join(", ")}`);
					else add("internet sandbox private addresses", "pass", `all ${PRIVATE_TARGETS.length} refused: the metadata address, the private, carrier NAT and loopback ranges, the cluster API, and their IPv6 forms`);
					// A proxy that re-signs HTTPS checks each site's own certificate first, or it vouches for forgeries.
					const certRow = "internet sandbox checks site certificates";
					const bad = await run(`python3 -c '${FETCH_PROBE}' ${[GOOD_CERT_PAGE, ...BAD_CERT_PAGES].map((url) => `'${url}'`).join(" ")}`);
					let got: Record<string, string> = {};
					try {
						got = JSON.parse(bad.stdout?.trim() || "{}") as Record<string, string>;
					} catch {}
					const passedOn = BAD_CERT_PAGES.filter((url) => got[url]?.startsWith("loaded"));
					if (passedOn.length) add(certRow, "fail", `the proxy passed on a broken certificate as trusted: ${passedOn.join(", ")}`);
					else if (!got[GOOD_CERT_PAGE] || BAD_CERT_PAGES.some((url) => !got[url])) add(certRow, "fail", `the probe printed no result (exit ${bad.exit_code ?? "?"})`);
					else if (!got[GOOD_CERT_PAGE].startsWith("loaded")) add(certRow, "skip", `${GOOD_CERT_PAGE} itself didn't load (${got[GOOD_CERT_PAGE]}), so a refusal can't be told from an outage`);
					else add(certRow, "pass", `${GOOD_CERT_PAGE} loaded; its expired, self-signed and wrong-name pages were refused (${got[BAD_CERT_PAGES[0]!]})`);
					const boundary = `enrichedlab-${randomBytes(12).toString("hex")}`;
					const form = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="el-check.txt"\r\nContent-Type: text/plain\r\n\r\nel-check\r\n--${boundary}--\r\n`;
					const sent = await this.call("POST", `/v1/containers/${encodeURIComponent(made.id)}/files`, { body: form, headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, signal: t() }).then(
						async (r) => (await r.arrayBuffer(), { status: r.status, code: undefined as string | undefined }),
						(e: { status?: number; code?: string }) => ({ status: e.status, code: e.code }),
					);
					const refused = sent.status === 409 && sent.code === "internet_no_files";
					add("internet sandbox takes no files", refused ? "pass" : "fail", refused ? "409 internet_no_files" : `answered ${sent.status ?? "?"}${sent.code ? ` ${sent.code}` : ""}`);
				} finally {
					await this.call("DELETE", `/v1/containers/${encodeURIComponent(made.id)}`, { signal: t() }).then((r) => r.arrayBuffer(), () => undefined);
				}
			});
			// The browser in an internet sandbox loads a public HTTPS page. A proxy that re-signs HTTPS needs its CA
			// trusted by the browser too: Chrome reads none of the CA variables python, curl, node and git follow.
			if (has("ports") && browserInfo?.protocol === "cdp" && browserInfo.image) {
				const row = "browser in an internet sandbox";
				const { image, port } = browserInfo;
				await attempt(row, async () => {
					const allowed = (await this.json<GateMe>("GET", "/v1/me", { signal: t() })).sandbox_networks ?? [];
					if (!allowed.includes("internet")) return add(row, "skip", "your policy doesn't allow internet sandboxes");
					const made = await this.json<{ id: string; network?: string | null }>("POST", "/v1/containers", { json: { name: "el-lab-check-internet-browser", image, network: "internet" }, signal: AbortSignal.timeout(300_000) });
					try {
						if (made.network !== "internet") return add(row, "fail", `the lab made it with network ${made.network ?? "unset"}`);
						const cdp = await devtools(made.id, port);
						if (!cdp) return add(row, "fail", "json/version gave no webSocketDebuggerUrl");
						try {
							const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
							const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
							const went = await cdp.send<{ errorText?: string }>("Page.navigate", { url: "https://example.com/" }, sessionId, 45_000);
							let title = "";
							for (let i = 0; i < 30 && !went.errorText; i++) {
								const got = await cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sessionId);
								title = typeof got.result?.value === "string" ? got.result.value : "";
								// Chrome's certificate warning page is titled "Privacy error".
								if (title === "Example Domain" || title === "Privacy error") break;
								await sleep(500);
							}
							const untrusted = /CERT/.test(went.errorText ?? "") || title === "Privacy error";
							const hint = untrusted ? ". The browser doesn't trust the certificate it got; a proxy that re-signs HTTPS needs its CA trusted by the browser" : "";
							if (title === "Example Domain") add(row, "pass", `Chrome loaded https://example.com/ through the lab's proxy`);
							else add(row, "fail", `${went.errorText ? `Chrome couldn't load https://example.com/: ${went.errorText}` : `Chrome showed "${title || "no title"}" for https://example.com/`}${hint}`);
						} finally {
							cdp.close();
						}
					} finally {
						await this.call("DELETE", `/v1/containers/${encodeURIComponent(made.id)}`, { signal: t() }).then((r) => r.arrayBuffer(), () => undefined);
					}
				});
			}
		}
		// The package sources a lab vets: each an https address; sandboxes and local environments point at them.
		if (d?.packages) {
			const p = d.packages;
			const urls = [...(p.conda ?? []), p.pypi, p.cran, p.npm].filter((u): u is string => typeof u === "string");
			const bad = urls.filter((u) => !/^https:\/\/[^/\s]+/.test(u));
			const parts = [p.conda?.length ? `${p.conda.length} conda channel${p.conda.length === 1 ? "" : "s"}` : "", p.pypi ? "a PyPI index" : "", p.cran ? "a CRAN repository" : "", p.npm ? "an npm registry" : ""].filter(Boolean);
			add("package sources", urls.length && !bad.length ? "pass" : "fail", bad.length ? `not https: ${bad.join(", ")}` : urls.length ? `${parts.join(", ")}${p.only ? ", and nothing public" : ""}` : "the packages block names no source");
		}
		// A lab that describes its API: OpenAPI 3.1 with paths and the contract's schemas.
		if (has("openapi")) {
			await attempt("GET /v1/openapi.json", async () => {
				const doc = await this.json<{ openapi?: string; paths?: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } }>("GET", "/v1/openapi.json", { signal: t() });
				const paths = Object.keys(doc.paths ?? {}).length;
				const schemas = Object.keys(doc.components?.schemas ?? {}).length;
				const ok = typeof doc.openapi === "string" && doc.openapi.startsWith("3.1") && paths > 0;
				add("GET /v1/openapi.json", ok ? "pass" : "fail", ok ? `OpenAPI ${doc.openapi}, ${paths} paths, ${schemas} schemas` : `openapi ${doc.openapi ?? "missing"}, ${paths} paths`);
			});
		}
		if (has("events")) {
			await attempt("GET /v1/events", async () => {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 25_000);
				try {
					const response = await this.call("GET", "/v1/events", { headers: { accept: "text/event-stream", "last-event-id": "0" }, signal: controller.signal });
					const type = response.headers.get("content-type") ?? "";
					if (!type.includes("text/event-stream")) return add("GET /v1/events", "fail", `content type ${type || "none"}`);
					add("GET /v1/events", "pass", "the stream opens");
					let seen = "";
					for await (const message of sseData(response.body!, controller.signal)) {
						if (message.event === "reset") {
							seen = "reset";
							break;
						}
						const problems = validate(SCHEMAS.event, JSON.parse(message.data));
						if (problems.length) {
							seen = `bad event: ${problems[0]}`;
							break;
						}
						if (!message.id) {
							seen = "an event without an id";
							break;
						}
						seen = "events";
						break;
					}
					if (!seen) add("old cursor", "skip", "no events within 25 s");
					else add("old cursor", seen === "reset" || seen === "events" ? "pass" : "fail", seen === "reset" ? "a cursor older than the history kept gets reset" : seen === "events" ? "resumes from the cursor" : seen);
				} catch (error) {
					if (!controller.signal.aborted) throw error;
					if (!rows.some((r) => r.row === "old cursor")) add("old cursor", "skip", "no events within 25 s");
				} finally {
					clearTimeout(timer);
					controller.abort();
				}
			});
		} else skip("GET /v1/events");
		if (has("runs")) await attempt("GET /v1/runs", async () => fits("GET /v1/runs", "runs", await this.json("GET", "/v1/runs", { signal: t() })));
		else skip("GET /v1/runs");

		return rows;
	}

	// ── Sandbox ────────────────────────────────────────────────────────────────────────────────────────────────────

	private async sandbox(signal?: AbortSignal): Promise<string> {
		const previous = this.container;
		if (this.container) {
			const id = this.container;
			const status = await this.containerStatus(id, signal, true);
			if (status !== "deleted" && status !== "deleting") {
				await this.wake(id, status, signal);
				return id;
			}
			this.container = undefined;
			if (status === "deleting") this.leaving = id;
			this.onNotice?.(`Your ${this.title} sandbox was deleted, with its files. A new one starts now.`);
		}
		// A replacement is made the way the person chose for the one before (the browser image, internet access).
		const like = (previous && this.made.get(previous)) || {};
		this.starting ??= this.create(signal, { name: "EnrichedLab", ...like })
			.then((made) => {
				this.container = made.id;
				this.made.set(made.id, like);
				return made.id;
			})
			.finally(() => {
				this.starting = undefined;
			});
		return this.starting;
	}

	/**
	 * The sandbox the browser runs in: the person's own, so it reaches the apps they run there (sandboxes can't reach
	 * each other). A lab that names a browser image (descriptor `browser.image`, its default image plus the browser)
	 * runs the browser only in a sandbox made from it: one is made from that image when none exists yet, and a sandbox
	 * from another image gets a plain answer on how to switch.
	 */
	private async browserSandbox(signal?: AbortSignal): Promise<string> {
		const image = this.descriptor?.browser?.image;
		if (!image) return this.sandbox(signal);
		if (!this.container && !this.starting) {
			this.starting = this.create(signal, { name: "EnrichedLab", image })
				.then((made) => {
					this.container = made.id;
					this.made.set(made.id, { image });
					return made.id;
				})
				.finally(() => {
					this.starting = undefined;
				});
		}
		const id = await this.sandbox(signal);
		if (!this.made.has(id)) {
			const read = await this.json<{ image?: string | null; network?: string | null }>("GET", `/v1/containers/${encodeURIComponent(id)}`, { signal });
			this.made.set(id, { image: read.image || undefined, network: read.network || undefined });
		}
		if (this.made.get(id)?.image !== image) {
			throw new ToolError(`${this.title}'s browser runs only in a sandbox made from its ${image} image, and your sandbox there (${id}) isn't one. The person can start one with el sandbox create ${this.config.name} --image ${image}; sessions there then use it, and the current sandbox keeps its files.`);
		}
		return id;
	}

	/**
	 * Make a new sandbox for the person, from one of the lab's images and on one of its networks, and work in it from
	 * now on. The one used until now stays as it is, files and all. A lab that allows one sandbox running at once needs
	 * that one stopped first. A network is fixed when the sandbox is made: internet means the public web, and no lab
	 * files go into such a sandbox.
	 */
	async createSandbox(image?: string, network?: string): Promise<{ id: string; image?: string; network?: string; previous?: string }> {
		if (!this.offers("containers")) throw new Error(`${this.title} has no sandboxes.`);
		const offered = this.descriptor?.sandbox_images;
		if (image && offered && !offered.some((i) => i.name === image)) throw new Error(`${this.title} has no sandbox image named ${image}. It offers: ${offered.map((i) => i.name).join(", ")}.`);
		if (network && network !== "none") {
			const nets = this.descriptor?.sandbox_networks;
			if (nets && !nets.some((n) => n.name === network)) throw new Error(`${this.title} has no sandbox network named ${network}. It offers: ${nets.map((n) => n.name).join(", ")}.`);
			if (this.networks && !this.networks.includes(network)) throw new Error(`${this.title} doesn't let you make sandboxes with ${network} access. You may use: ${this.networks.join(", ")}.`);
		}
		const previous = this.container;
		const like: Made = { ...(image ? { image } : {}), ...(network && network !== "none" ? { network } : {}) };
		try {
			const made = await this.create(undefined, { name: "EnrichedLab", ...like });
			this.container = made.id;
			this.made.set(made.id, like);
			return { id: made.id, ...like, previous };
		} catch (error) {
			const { code, limit } = error as { code?: string; limit?: string };
			if (code === "too_many_containers" && limit === "at_once" && previous) {
				throw Object.assign(new Error(`${(error as Error).message.split(" el sandboxes")[0]} Stop the one you use now first (its files are kept): el sandbox stop ${this.config.name} ${previous}, then run this again.`), { code, limit });
			}
			throw error;
		}
	}

	/**
	 * POST /v1/containers. A sandbox the lab is still deleting counts toward the person's limits until it's gone
	 * (usually seconds), so a refusal for too many is met by waiting for that one, then asking once more; the
	 * refusal stands if it's still there after a minute.
	 */
	private async create(signal?: AbortSignal, body: Record<string, unknown> = { name: "EnrichedLab" }): Promise<{ id: string }> {
		const post = () => this.json<{ id: string }>("POST", "/v1/containers", { json: body, signal: AbortSignal.timeout(300_000) });
		try {
			const made = await post();
			this.leaving = undefined;
			return made;
		} catch (error) {
			const leaving = this.leaving;
			if ((error as { code?: string }).code !== "too_many_containers" || !leaving) throw error;
			for (const until = Date.now() + GateSite.leavingWaitMs; Date.now() < until; ) {
				await sleep(Math.min(2_000, GateSite.leavingWaitMs), signal);
				if ((await this.containerStatus(leaving, signal, true)) !== "deleted") continue;
				this.leaving = undefined;
				return post();
			}
			throw error;
		}
	}

	/**
	 * A sandbox's lifecycle status; "deleted" when the lab no longer has it (404 or 410), and also while it's still
	 * deleting it unless `exact`.
	 */
	private async containerStatus(id: string, signal?: AbortSignal, exact = false): Promise<string> {
		try {
			const status = (await this.json<{ status?: string }>("GET", `/v1/containers/${encodeURIComponent(id)}`, { signal })).status ?? "running";
			return status === "deleting" && !exact ? "deleted" : status;
		} catch (error) {
			const status = (error as { status?: number }).status;
			if (status === 404 || status === 410) return "deleted";
			throw error;
		}
	}

	/** Bring a stopped or archived sandbox back before using it: any use starts a stopped one; an archived one is restored. */
	private async wake(id: string, status: string, signal?: AbortSignal): Promise<void> {
		if (status === "running") return;
		const slow = status === "archived" || status === "restoring";
		if (status === "archived") {
			this.onNotice?.(`Restoring your ${this.title} sandbox from its archive. Its files come back with it.`);
			await this.json("POST", `/v1/containers/${encodeURIComponent(id)}/restore`, { json: {}, signal }).catch((error: Error & { status?: number; code?: string }) => {
				// The lab refuses when the sandbox no longer fits the person's limits there; its message gives the sizes.
				if (error.status !== 403) throw error;
				const ask =
					error.code === "restore_memory_over_limit"
						? "Ask the lab to raise your memory limit."
						: error.code === "restore_files_over_limit"
							? "Ask the lab to raise your disk limit, or to delete the archive."
							: "Ask the lab to raise your limit, or to delete the archive.";
				throw new ToolError(`${this.title} won't restore your archived sandbox: ${error.message.replace(/\.$/, "")}. ${ask}`);
			});
		} else if (status === "stopped") {
			// Listing one file is the lightest use; the lab starts the sandbox on it.
			await this.call("GET", `/v1/containers/${encodeURIComponent(id)}/files?limit=1`, { signal, noWait: true }).then(
				(r) => r.arrayBuffer(),
				() => undefined,
			);
		}
		const until = Date.now() + (slow ? 15 * 60_000 : 3 * 60_000);
		for (;;) {
			const now = await this.containerStatus(id, signal);
			if (now === "running") return;
			if (now === "deleted") throw new ToolError(`Your ${this.title} sandbox is gone. Try again to start a new one.`);
			if (now === "archived" && slow) throw new ToolError(`Restoring your ${this.title} sandbox didn't work; it's still archived. Try again in a while.`);
			if (now === "stopped" && status !== "stopped") throw new ToolError(`Your ${this.title} sandbox didn't start. Try again.`);
			if (Date.now() > until) throw new ToolError(`Your ${this.title} sandbox is taking long to ${slow ? "restore" : "start"}. Try again in a minute.`);
			await sleep(slow ? 5_000 : 2_000, signal);
		}
	}

	/** Run a command in the sandbox: its exit code and output streams. */
	/** Whole-disk checkpoints of the person's sandbox (checkpoint.schema.json), when the lab serves them. */
	checkpoints(): SandboxCheckpoints | undefined {
		if (!this.offers("checkpoints")) return undefined;
		return {
			make: async (label, signal) => {
				const id = await this.sandbox(signal);
				return (await this.json<{ id: string }>("POST", `/v1/containers/${encodeURIComponent(id)}/checkpoints`, { json: { label: label.slice(0, 200) }, signal })).id;
			},
			restore: async (checkpoint, signal) => {
				const id = await this.sandbox(signal);
				await this.json("POST", `/v1/containers/${encodeURIComponent(id)}/checkpoints/${encodeURIComponent(checkpoint)}/restore`, { json: {}, signal });
				for (const end = Date.now() + 300_000; Date.now() < end; await sleep(1_000, signal)) if ((await this.containerStatus(id, signal, true)) === "running") return;
				throw new ToolError(`The ${this.title} sandbox didn't come back from its checkpoint within 5 minutes.`);
			},
		};
	}

	async run(command: string, timeoutSeconds: number, signal?: AbortSignal): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
		const id = await this.sandbox(signal);
		const result = await this.json<{ exit_code?: number; stdout?: string; stderr?: string; timed_out?: boolean }>("POST", `/v1/containers/${id}/exec`, {
			json: { command, timeout_seconds: timeoutSeconds },
			signal,
		});
		return { exitCode: result.exit_code ?? null, stdout: result.stdout ?? "", stderr: result.stderr ?? "", timedOut: result.timed_out === true };
	}

	/** Run a command and return its output as one text with a status word, for tool results. */
	private async exec(command: string, timeoutSeconds: number, signal?: AbortSignal): Promise<{ ok: boolean; output: string; status: string }> {
		const r = await this.run(command, timeoutSeconds, signal);
		const output = [r.stdout, r.stderr ? `[stderr]\n${r.stderr}` : ""].filter(Boolean).join("\n");
		return { ok: !r.timedOut && r.exitCode === 0, output, status: r.timedOut ? "timed out" : `exit ${r.exitCode ?? "?"}` };
	}

	/** Copy a local file into the sandbox, or another of the person's sandboxes (the site scans it first). */
	async put(path: string, signal?: AbortSignal, container?: string): Promise<{ path: string; bytes: number }> {
		const info = await stat(path).catch(() => undefined);
		if (!info?.isFile()) throw new ToolError(`${path} isn't a file.`);
		const id = container ?? (await this.sandbox(signal));
		const boundary = `enrichedlab-${randomBytes(12).toString("hex")}`;
		const name = basename(path).replace(/["\r\n]/g, "_");
		const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
		const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
		const parts = async function* () {
			yield head;
			if (info.size) yield* createReadStream(path);
			yield tail;
		};
		return this.json<{ path: string; bytes: number }>("POST", `/v1/containers/${id}/files`, {
			body: Readable.toWeb(Readable.from(parts())) as unknown as ReadableStream,
			headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(head.length + info.size + tail.length) },
			signal,
		});
	}

	/** Stream a sandbox file to `target` through a temporary file. Returns its size and sha256. */
	async get(wanted: string, target: string, signal?: AbortSignal): Promise<{ bytes: number; sha: string }> {
		const id = await this.sandbox(signal);
		let after: string | undefined;
		let file: { id: string; path: string; bytes: number } | undefined;
		for (let page = 0; page < 50 && !file; page++) {
			const query = new URLSearchParams({ limit: "100", order: "asc" });
			if (after) query.set("after", after);
			const list = await this.json<{ data: { id: string; path: string; bytes: number }[]; has_more?: boolean }>("GET", `/v1/containers/${id}/files?${query}`, { signal });
			file = list.data.find((f) => f.path === wanted);
			if (!list.has_more || !list.data.length) break;
			after = list.data[list.data.length - 1].id;
		}
		if (!file) throw new ToolError(`There's no file ${wanted} in the sandbox.`);
		await mkdir(dirname(target), { recursive: true });
		// The lab ends a download whose reader stalls for a minute or that runs past 30 minutes. One that broke off is
		// tried once more from the start, unless it reached the 30-minute end, which a second try would reach too.
		for (let tries = 0; ; tries++) {
			const started = Date.now();
			try {
				return await this.download(`/v1/containers/${id}/files/${file.id}/content`, wanted, target, signal);
			} catch (error) {
				if (!(error as { cut?: boolean }).cut || signal?.aborted) throw error;
				if (Date.now() - started > 25 * 60_000) throw new ToolError(`${wanted} stopped partway: ${this.title} ends a download after 30 minutes. Compress or split it in the sandbox, then try again.`);
				if (tries >= 1) throw error;
			}
		}
	}

	/** One try at a sandbox file, streamed to disk (result files can be larger than the engine should hold). */
	private async download(path: string, wanted: string, target: string, signal?: AbortSignal): Promise<{ bytes: number; sha: string }> {
		const response = await this.call("GET", path, { signal });
		const temp = `${target}.${randomBytes(4).toString("hex")}.part`;
		const cut = (why: string) => Object.assign(new ToolError(`${wanted} ${why}, so it wasn't saved. Try again.`), { cut: true });
		let bytes = 0;
		const hash = createHash("sha256");
		// Awaited writes to a file handle, not a write stream: Bun's stream, destroyed with a write in flight (as a cut
		// download leaves it), throws that write's error with nobody listening and never emits "close".
		const out = await open(temp, "w", 0o600);
		let writing = true;
		let writeFailed: unknown;
		try {
			try {
				for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
					bytes += chunk.length;
					hash.update(chunk);
					try {
						for (let at = 0; at < chunk.length; ) at += (await out.write(chunk, at)).bytesWritten;
					} catch (error) {
						writeFailed = error;
						throw error;
					}
				}
			} catch (error) {
				if (signal?.aborted) throw error;
				// A disk that can't take the file isn't the lab cutting the download: trying again wouldn't help.
				if (writeFailed) throw new ToolError(`${wanted} couldn't be saved to ${dirname(target)}: ${errorText(writeFailed)}`);
				throw cut(`stopped partway (${errorText(error)})`);
			}
			writing = false;
			await out.close();
			const length = Number(response.headers.get("content-length") ?? Number.NaN);
			const encoded = (response.headers.get("content-encoding") ?? "identity") !== "identity";
			if (!encoded && Number.isFinite(length) && bytes !== length) throw cut(`stopped partway (${bytes} of ${length} bytes)`);
			// The lab sends the checksum of the bytes its scanners passed (RFC 9530): keep the file only if it matches.
			const said = reprSha256(response);
			if (said && said !== hash.copy().digest("hex")) throw cut(`arrived different from what ${this.title}'s scanner passed`);
			await rename(temp, target);
		} catch (error) {
			if (writing) await out.close().catch(() => undefined);
			await rm(temp, { force: true });
			throw error;
		}
		return { bytes, sha: hash.digest("hex") };
	}

	private sandboxTools(): Tool[] {
		const site = this.config.name;
		const run: Tool = {
			name: `${site}_sandbox_run`,
			kind: "sandbox",
			description: `Run a shell command in your ${site} sandbox: an isolated Linux machine with no network, which keeps its files between sessions. Files copied in with ${site}_sandbox_upload are there. Returns output and exit code.${this.jobsOffered() ? ` For anything over a few minutes use ${site}_sandbox_job_start.` : ""}`,
			parameters: {
				type: "object",
				properties: { command: { type: "string" }, timeout: { type: "integer", description: "Seconds, default 120." } },
				required: ["command"],
				additionalProperties: false,
			},
			view: (a) => ({ verb: `${site} sandbox`, target: String(a.command ?? "") }),
			run: async (args, ctx) => {
				const { ok, output, status } = await this.exec(str(args, "command"), num(args, "timeout") ?? 120, ctx.signal);
				return { ok, content: `${output}\n[${status}]`, view: { result: status, detail: output } };
			},
		};
		const jobStart: Tool = {
			name: `${site}_sandbox_job_start`,
			kind: "sandbox",
			description: `Start a long command in your ${site} sandbox as a background job and return its id at once. Check it with ${site}_sandbox_job_status.`,
			parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
			view: (a) => ({ verb: `${site} job`, target: String(a.command ?? "") }),
			run: async (args, ctx) => {
				const id = await this.sandbox(ctx.signal);
				const job = await this.json<{ id: string; status: string }>("POST", `/v1/containers/${id}/jobs`, { json: { command: str(args, "command") }, signal: ctx.signal });
				this.jobs.add(job.id);
				return { ok: true, content: `Job ${job.id}: ${job.status}`, view: { result: job.status } };
			},
		};
		const jobStatus: Tool = {
			name: `${site}_sandbox_job_status`,
			kind: "sandbox",
			description: `Status of a ${site} sandbox job, with the end of its log.`,
			parameters: { type: "object", properties: { job: { type: "string" } }, required: ["job"], additionalProperties: false },
			view: (a) => ({ verb: `${site} job`, target: String(a.job ?? "") }),
			run: async (args, ctx) => {
				const id = await this.sandbox(ctx.signal);
				const job = await this.json<{ id: string; status: string; exit_code?: number | null; log?: string }>(
					"GET",
					`/v1/containers/${id}/jobs/${encodeURIComponent(str(args, "job"))}?log_bytes=16000`,
					{ signal: ctx.signal },
				);
				const ended = job.exit_code !== null && job.exit_code !== undefined ? ` (exit ${job.exit_code})` : "";
				return { ok: true, content: `Job ${job.id}: ${job.status}${ended}\n${job.log ?? ""}`, view: { result: `${job.status}${ended}`, detail: job.log } };
			},
		};
		const jobCancel: Tool = {
			name: `${site}_sandbox_job_cancel`,
			kind: "sandbox",
			description: `Stop a ${site} sandbox job.`,
			parameters: { type: "object", properties: { job: { type: "string" } }, required: ["job"], additionalProperties: false },
			view: (a) => ({ verb: `${site} job stop`, target: String(a.job ?? "") }),
			run: async (args, ctx) => {
				const id = await this.sandbox(ctx.signal);
				const job = await this.json<{ status: string }>("POST", `/v1/containers/${id}/jobs/${encodeURIComponent(str(args, "job"))}/cancel`, { signal: ctx.signal });
				return { ok: true, content: `Job stopped: ${job.status}`, view: { result: job.status } };
			},
		};
		const upload: Tool = {
			name: `${site}_sandbox_upload`,
			kind: "sandbox",
			description: `Copy a file from the project folder into your ${site} sandbox (the site scans it first). Returns where it landed.`,
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
			view: (a) => ({ verb: `${site} upload`, target: String(a.path ?? "") }),
			ask: (a, { workspace }) => {
				const path = String(a.path ?? "");
				if (!workspace.inside(path)) return `${workspace.display(path)} is outside the project folder.`;
				let target = path;
				try {
					target = realpathSync(workspace.resolve(path));
				} catch {
					// Missing files fail in run().
				}
				if (SECRET_NAME.test(path) || SECRET_NAME.test(target)) return `${workspace.display(path)} looks like it holds secrets.`;
				return undefined;
			},
			run: async (args, ctx) => {
				const path = ctx.workspace.resolve(str(args, "path"));
				const placed = await this.put(path, ctx.signal);
				return { ok: true, content: `Copied to ${placed.path} (${placed.bytes} bytes).`, view: { result: `${(placed.bytes / 1024).toFixed(0)} KB` } };
			},
		};
		const download: Tool = {
			name: `${site}_sandbox_download`,
			kind: "write",
			description: `Copy a file from your ${site} sandbox into the project folder. Never replaces an existing file.`,
			parameters: {
				type: "object",
				properties: { path: { type: "string", description: "The file in the sandbox, e.g. /sandbox/out/result.csv" }, to: { type: "string", description: "A new path in the project folder." } },
				required: ["path", "to"],
				additionalProperties: false,
			},
			view: (a) => ({ verb: `${site} download`, target: `${a.path ?? ""} → ${a.to ?? ""}` }),
			touches: (a) => [String(a.to ?? "")],
			ask: (a, { workspace }) => (workspace.inside(String(a.to ?? "")) ? undefined : `${workspace.display(String(a.to ?? ""))} is outside the project folder.`),
			run: async (args, ctx) => {
				const target = ctx.workspace.resolve(str(args, "to"));
				if (await stat(target).catch(() => undefined)) throw new ToolError(`${ctx.workspace.display(target)} already exists; choose a new name.`);
				if (/(^|[\\/])(\.git|\.ssh)([\\/]|$)/.test(target)) throw new ToolError("Downloads never go into .git or .ssh.");
				const wanted = str(args, "path");
				const { bytes, sha } = await this.get(wanted, target, ctx.signal);
				return { ok: true, content: `Saved ${wanted} to ${ctx.workspace.display(target)} (${bytes} bytes, sha256 ${sha}).`, view: { result: `${(bytes / 1024).toFixed(0)} KB` } };
			},
		};
		const repoSend: Tool = {
			name: `${site}_sandbox_repo_send`,
			kind: "sandbox",
			description: `Send this git repository to your ${site} sandbox: the current commit plus uncommitted and untracked files (files that look like secrets stay here). It lands on branch work in a new folder, which this returns. Work there with ${site}_sandbox_run and commit; bring the work back with ${site}_sandbox_repo_fetch.`,
			parameters: { type: "object", properties: {}, additionalProperties: false },
			view: () => ({ verb: `${site} send repo`, target: "" }),
			ask: () => `It sends this repository, uncommitted files included, to ${site}.`,
			run: async (_args, ctx) => {
				const repo = repoRoot(ctx.workspace.root);
				if (!repo) throw new ToolError("The project folder isn't a git repository.");
				const id = randomBytes(4).toString("hex");
				const dir = `/sandbox/work/${basename(repo).replace(/[^\w.-]/g, "_")}-${id}`;
				const sent = await sendRepo(this, repo, dir, ctx.signal);
				this.sent.set(dir, { repo, base: sent.base, home: sent.home });
				const left = `${sent.skipped.length ? ` Left out as likely secrets: ${sent.skipped.join(", ")}.` : ""}${sent.history ? "" : " Only the current files went: the history has files that look like secrets."}`;
				return { ok: true, content: `Sent to ${dir} on branch work (${sent.head}).${left}`, view: { result: dir } };
			},
		};
		const repoFetch: Tool = {
			name: `${site}_sandbox_repo_fetch`,
			kind: "sandbox",
			description: `Bring the work in a sandbox folder made by ${site}_sandbox_repo_send back as a new local branch (uncommitted sandbox changes are committed first, as the person). The working folder and other branches stay as they are; the person reviews and merges the branch.`,
			parameters: { type: "object", properties: { folder: { type: "string", description: "The sandbox folder; default the last one sent." } }, additionalProperties: false },
			view: (a) => ({ verb: `${site} fetch repo`, target: String(a.folder ?? "") }),
			run: async (args, ctx) => {
				const dir = typeof args.folder === "string" && args.folder ? args.folder : [...this.sent.keys()].at(-1);
				const sent = dir ? this.sent.get(dir) : undefined;
				if (!dir || !sent) throw new ToolError(`No repository was sent to ${site} from this engine${dir ? ` as ${dir}` : ""}.`);
				const branch = `enrichedlab/${site}-${basename(dir).split("-").at(-1)}`;
				const commits = await fetchRepo(this, dir, sent, branch, ctx.signal);
				if (!commits.length) return { ok: true, content: `No new commits in ${dir} since it was sent.`, view: { result: "nothing new" } };
				return {
					ok: true,
					content: `Branch ${branch} has ${commits.length} commit${commits.length === 1 ? "" : "s"} from the sandbox:\n${commits.join("\n")}\nReview with git diff HEAD...${branch}; merge when it's right.`,
					view: { result: `${branch} · ${commits.length} commit${commits.length === 1 ? "" : "s"}`, detail: commits.join("\n") },
				};
			},
		};
		const openPortTool: Tool = {
			name: `${site}_sandbox_open_port`,
			kind: "sandbox",
			description: [
				`Show a web app from your ${site} sandbox (a Shiny app, a dashboard, Streamlit, Dash, a dev server) in the browser pane, where the person uses it.`,
				`Give command: the shell command that starts its server, run in the project folder, listening on 0.0.0.0 at port (also in $PORT), for example "R -e 'shiny::runApp(\\"app\\", host=\\"0.0.0.0\\", port=8501)'" or "python3 -m streamlit run app.py --server.port 8501 --server.address 0.0.0.0".`,
				`EnrichedLab starts it, waits for the page, shows it, stops the server when nobody has used it for ${SERVE_IDLE_MINUTES} minutes, and starts it again on the next visit: don't start servers in the background yourself.`,
				"Leave command out only to show a server that already runs. Returns the page as text; the server's last output when it didn't start.",
			].join(" "),
			parameters: {
				type: "object",
				properties: {
					port: { type: "integer", minimum: 1024, maximum: 65535 },
					command: { type: "string", description: "Shell command that starts the app's server on 0.0.0.0 at port" },
					path: { type: "string", description: "Path to open, default /" },
				},
				required: ["port"],
				additionalProperties: false,
			},
			view: (a) => ({ verb: `${site} app`, target: a.command ? `${String(a.command)} (port ${a.port})` : `port ${a.port}` }),
			run: async (args, ctx) => {
				const port = num(args, "port") ?? 0;
				const path = typeof args.path === "string" ? args.path : "/";
				const command = typeof args.command === "string" && args.command.trim() ? args.command : undefined;
				// The server starts in the session's project folder when the session works in this lab.
				const workdir = ctx.workspace.kind === "sandbox" && ctx.place === site ? ctx.workspace.root : undefined;
				const opened = command ? await this.serve(port, command, workdir, path, ctx.signal) : await this.openPort(port, path, ctx.signal);
				if (ctx.surface) {
					const page = await ctx.surface.call("browser", "open", { url: opened.url }, ctx.signal).catch(() => undefined);
					if (page) return { ok: true, content: page.text, view: { result: `opened ${opened.origin}` } };
				}
				return { ok: true, content: `Open ${opened.url} in a browser on this computer. The address works only here, while this engine runs.`, view: { result: opened.origin } };
			},
		};
		// A lab that doesn't run background jobs doesn't get offered job tools (a model calls what it's offered).
		return [run, ...(this.jobsOffered() ? [jobStart, jobStatus, jobCancel] : []), upload, download, repoSend, repoFetch, ...(this.offers("ports") ? [openPortTool] : [])];
	}

	/** Stop using this connection but keep the sandbox: a reconnect (refresh, sign-in, route change) hands it on. */
	async detach(): Promise<string | undefined> {
		await this.mcp?.close().catch(() => undefined);
		const container = this.container;
		this.container = undefined;
		return container;
	}

	/** A process in the sandbox with stdin and output streamed (attach.ts). */
	async attach(spec: AttachSpec, signal?: AbortSignal): Promise<Attached> {
		if (!this.offers("attach")) throw Object.assign(new Error(`${this.title} doesn't stream sandbox processes.`), { unsupported: true });
		const id = await this.sandbox(signal);
		const url = `${this.route.base}/v1/containers/${encodeURIComponent(id)}/attach`;
		// Each try signs its own proof.
		return retryingAttach(async () => {
			await this.freshNonce();
			return attachSocket(url.replace(/^http/, "ws"), await this.authHeaders("GET", url), spec, this.route.ca);
		}, signal);
	}

	/** The browser in the person's sandbox, when the lab runs one this client speaks to (descriptor `browser`). */
	browser(): SandboxBrowserLane | undefined {
		const info = this.descriptor?.browser;
		if (!this.sandboxOn || info?.protocol !== "cdp" || !this.offers("ports")) return undefined;
		// A lab with a network per sandbox: what the browser reaches is what the person's current sandbox was made with.
		const mine = this.container && this.descriptor?.sandbox_networks ? this.made.get(this.container) : undefined;
		if (mine) return { version: info.version, network: mine.network === "internet" ? "open" : "none" };
		return { version: info.version, ...this.network };
	}

	/**
	 * A DevTools connection to that browser through the lab's port path. The lab starts the browser on the first
	 * connection, so its address is asked for again for a few seconds while the port isn't answering yet.
	 */
	async cdp(signal?: AbortSignal): Promise<Cdp> {
		const info = this.descriptor?.browser;
		if (!this.browser() || !info) throw Object.assign(new Error(`${this.title}'s sandbox has no browser.`), { unsupported: true });
		const id = await this.browserSandbox(signal);
		const path = `/v1/containers/${encodeURIComponent(id)}/ports/${info.port}`;
		let found: { webSocketDebuggerUrl?: string } | undefined;
		let last: unknown;
		// A lab answers 503 browser_starting with Retry-After while the browser starts (call() waits that out).
		for (const until = Date.now() + 60_000; !found && Date.now() < until; ) {
			try {
				found = await this.json<{ webSocketDebuggerUrl?: string }>("GET", `${path}/json/version`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
			} catch (error) {
				last = error;
				const { status, code } = error as { status?: number; code?: string };
				if (signal?.aborted || (status && status < 500)) throw error;
				// The lab tried to start the browser and it failed: asking again at once won't help.
				if (code === "browser_start_failed") throw new ToolError(`${this.title}'s sandbox browser failed to start. Try again in half a minute; if it keeps failing, tell the lab's owner.`);
				await sleep(1_000, signal);
			}
		}
		if (!found?.webSocketDebuggerUrl) throw new Error(`${this.title}'s sandbox browser didn't start${last ? ` (${redact(errorText(last))})` : ""}.`);
		// Chrome names its own loopback address; the same path goes through the lab's port instead.
		const url = `${this.route.base}${path}${new URL(found.webSocketDebuggerUrl).pathname}`;
		await this.freshNonce();
		return Cdp.open(url.replace(/^http/, "ws"), await this.authHeaders("GET", url), this.route.ca);
	}

	/** The lab's desktop sandbox, when it offers one and this person has sandboxes. */
	desktop(): DesktopInfo | undefined {
		if (!this.sandboxOn || !this.offers("containers")) return undefined;
		// The Linux desktop for now; a lab may list others (macOS) that later clients choose between.
		const listed = this.descriptor?.sandbox_desktops;
		return listed?.find((d) => (d.os ?? "linux") === "linux") ?? listed?.[0] ?? this.descriptor?.sandbox_desktop;
	}

	/** The person's desktop sandbox: one they already have from the desktop image, or a new one. */
	private async desktopSandbox(signal?: AbortSignal, avoid?: string): Promise<string> {
		if (this.desktopBox) return this.desktopBox;
		const image = this.desktop()?.image;
		if (!image) throw new ToolError(`${this.title} has no desktop sandbox for you.`);
		this.desktopStarting ??= (async () => {
			const listed = await this.json<{ data?: { id: string; image?: string | null; status?: string }[] }>("GET", "/v1/containers?limit=100", { signal: AbortSignal.timeout(15_000) });
			const found = (listed.data ?? []).find((c) => c.image === image && c.id !== avoid && c.status !== "deleted" && c.status !== "deleting");
			const id = found?.id ?? (await this.create(signal, { name: "Desktop", image })).id;
			this.desktopBox = id;
			this.made.set(id, { image });
			return id;
		})().finally(() => {
			this.desktopStarting = undefined;
		});
		return this.desktopStarting;
	}

	/**
	 * One request to the desktop. A stopped or starting desktop answers sandbox_starting, which call() waits out; an
	 * archived one is restored with its files, never replaced; one that ended (410) or that the lab no longer has
	 * (404) is made again, once.
	 */
	private async desktopCall(path: "desktop" | "desktop/open", body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		let gone: string | undefined;
		for (let attempt = 0; ; attempt++) {
			const id = await this.desktopSandbox(signal, gone);
			try {
				return await this.json<unknown>("POST", `/v1/containers/${encodeURIComponent(id)}/${path}`, { json: body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) });
			} catch (error) {
				const { status, code } = error as { status?: number; code?: string };
				if (code === "desktop_outdated") {
					if (!this.desktopOutdated) {
						this.desktopOutdated = true;
						this.onDesktopChange?.();
					}
					throw new ToolError(`This ${this.title} desktop was made before the lab's current desktop, so it can't list windows, launch or focus apps. Use screenshot and clicks, or ask the person to choose Update Desktop in its pane, which keeps its files.`);
				}
				if (attempt < 2 && code === "sandbox_archived") {
					this.onNotice?.(`Restoring your ${this.title} desktop from its archive. Its files come back with it.`);
					await this.json("POST", `/v1/containers/${encodeURIComponent(id)}/restore`, { json: {}, signal }).catch(() => undefined);
					for (const until = Date.now() + 120_000; Date.now() < until && (await this.containerStatus(id, signal).catch(() => "running")) !== "running"; ) await sleep(2_000, signal);
					continue;
				}
				if (attempt === 0 && (status === 404 || status === 410)) {
					// That one ended: a new one, not the same one found again in the list.
					gone = id;
					this.desktopBox = undefined;
					continue;
				}
				throw error;
			}
		}
	}

	async desktopAct(action: DesktopAction, by: "agent" | "person", signal?: AbortSignal): Promise<DesktopResult> {
		const answer = await this.desktopCall("desktop", { ...action, by }, signal);
		const frame = frameIn(answer, this.config.name, by, this.desktop());
		if (frame) this.onDesktopFrame?.(frame);
		const cursor = (answer as { cursor?: unknown } | undefined)?.cursor;
		return { frame, cursor: Array.isArray(cursor) && cursor.length === 2 ? (cursor as [number, number]) : undefined, answer };
	}

	/**
	 * The desktop's live view (GET .../desktop/stream, subprotocol gate.desktop.v1): a hello with the screen's size,
	 * then binary bands (x, y, w, h as big-endian u16, then a JPEG) until an end message or the socket closes. Only
	 * watching: the person's input still goes through the checked action endpoint.
	 */
	async desktopStream(handlers: DesktopStreamHandlers, signal?: AbortSignal): Promise<{ width: number; height: number; close(): void }> {
		if (!this.desktop()?.stream) throw new ToolError(`${this.title}'s desktop has no live view.`);
		const id = await this.desktopSandbox(signal);
		const url = `${this.route.base}/v1/containers/${encodeURIComponent(id)}/desktop/stream`;
		await this.freshNonce();
		const headers = await this.authHeaders("GET", url);
		const socket = new WebSocket(url.replace(/^http/, "ws"), { headers, protocols: ["gate.desktop.v1"], ...(this.route.ca ? { tls: { ca: this.route.ca } } : {}) } as unknown as string[]);
		socket.binaryType = "arraybuffer";
		let ended = false;
		const end = (reason: string) => {
			if (ended) return;
			ended = true;
			handlers.end(reason);
		};
		return new Promise((resolve, reject) => {
			let hello = false;
			const timer = setTimeout(() => {
				if (!hello) {
					socket.close();
					reject(new ToolError(`${this.title}'s desktop didn't start its live view.`));
				}
			}, 30_000);
			signal?.addEventListener("abort", () => socket.close(), { once: true });
			socket.onmessage = (event) => {
				if (typeof event.data === "string") {
					let message: { type?: string; width?: number; height?: number; reason?: string };
					try {
						message = JSON.parse(event.data);
					} catch {
						return;
					}
					if (message.type === "hello" && !hello) {
						hello = true;
						clearTimeout(timer);
						resolve({ width: Number(message.width ?? 0), height: Number(message.height ?? 0), close: () => socket.close(1000) });
					} else if (message.type === "end") end(String(message.reason ?? "closed"));
					return;
				}
				const bytes = new Uint8Array(event.data as ArrayBuffer);
				if (bytes.length < 9) return;
				const head = new DataView(bytes.buffer, bytes.byteOffset, 8);
				handlers.band({ x: head.getUint16(0), y: head.getUint16(2), w: head.getUint16(4), h: head.getUint16(6), jpeg: bytes.subarray(8) });
			};
			socket.onclose = (event) => {
				clearTimeout(timer);
				if (!hello) reject(new ToolError(`${this.title}'s desktop refused its live view (${event.code}${event.reason ? ` ${event.reason}` : ""}).`));
				else end("closed");
			};
		});
	}

	/**
	 * Move the desktop to the lab's current image under the same id, keeping its /sandbox files: stop it, archive it,
	 * then restore it (Gate makes it again from the image's current build). Its open windows close.
	 */
	async desktopUpdate(signal?: AbortSignal): Promise<void> {
		const id = await this.desktopSandbox(signal);
		const at = `/v1/containers/${encodeURIComponent(id)}`;
		const until = async (want: string) => {
			for (const end = Date.now() + 300_000; Date.now() < end; await sleep(2_000, signal)) if ((await this.containerStatus(id, signal, true)) === want) return;
			throw new ToolError(`Your ${this.title} desktop didn't become ${want} within 5 minutes. Try again, or ask the lab's support.`);
		};
		this.onNotice?.(`Updating your ${this.title} desktop. Its files come along; its open windows close.`);
		// Stop answers stopped (or archived, when it already is), or stopping while it gets there.
		const stopped = (await this.json<{ status?: string }>("POST", `${at}/stop`, { json: {}, signal })).status;
		if (stopped === "stopping") await until("stopped");
		if (stopped !== "archived") {
			// The lab may still be busy with another change: try again for a minute.
			for (let attempt = 0; ; attempt++) {
				try {
					await this.json("POST", `${at}/archive`, { json: {}, signal });
					break;
				} catch (error) {
					const code = (error as { code?: string }).code;
					if (attempt >= 30 || (code !== "sandbox_running" && code !== "sandbox_busy")) throw error;
					await sleep(2_000, signal);
				}
			}
			await until("archived");
		}
		await this.json("POST", `${at}/restore`, { json: {}, signal });
		await until("running");
		this.desktopOutdated = false;
		this.onDesktopChange?.();
		this.onNotice?.(`Your ${this.title} desktop is up to date.`);
	}

	/** A file from the workspace sandbox onto the desktop, through this computer; the lab scans it both ways. */
	async desktopCopy(from: string, signal?: AbortSignal): Promise<{ path: string; bytes: number }> {
		const dir = await mkdtemp(join(tmpdir(), "el-desktop-"));
		try {
			const local = join(dir, basename(from));
			await this.get(from, local, signal);
			return await this.put(local, signal, await this.desktopSandbox(signal));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	async desktopOpen(target: string, by: "agent" | "person", signal?: AbortSignal, app?: string): Promise<DesktopResult> {
		if (!this.desktop()?.open) throw new ToolError(`${this.title}'s desktop doesn't open addresses or files for you.`);
		const answer = await this.desktopCall("desktop/open", { target, by, ...(app ? { with: app } : {}) }, signal);
		const frame = frameIn(answer, this.config.name, by, this.desktop());
		if (frame) this.onDesktopFrame?.(frame);
		return { frame };
	}

	/** Background jobs, unless the lab's descriptor says it doesn't run them (sandbox_jobs: false). */
	private jobsOffered(): boolean {
		return this.descriptor?.sandbox_jobs !== false;
	}

	/**
	 * Run a web app's server in the sandbox behind one of its ports: started now over attach, stopped when unused for
	 * a while, started again on the next visit (port_proxy.ts). Rejects with the server's last output when it doesn't
	 * answer.
	 */
	async serve(port: number, command: string, workdir: string | undefined, path = "/", signal?: AbortSignal): Promise<OpenPort> {
		if (!this.offers("attach")) throw new ToolError(`${this.title} doesn't run servers for you here; start it yourself and leave command out.`);
		const opened = await this.openPort(port, path, signal);
		const start = async (): Promise<RunningServer> => {
			const started = await this.attach({ argv: ["sh", "-c", command], ...(workdir ? { workdir } : {}), env: { PORT: String(port), HOST: "0.0.0.0", NO_COLOR: "1" } });
			// A web server reads no input: close stdin at once (a lab may hold the process until stdin closes).
			started.end();
			let tail = "";
			const keep = (chunk: Uint8Array) => void (tail = (tail + new TextDecoder().decode(chunk)).slice(-1_500));
			started.onStdout(keep);
			started.onStderr(keep);
			let ended: string | undefined;
			const exit = started.exit.then(
				(code) => void (ended = `it stopped (exit ${code ?? "stopped"})`),
				(error: Error) => void (ended = error.message),
			);
			const stop = async () => {
				started.signal("TERM");
				started.close();
			};
			for (const until = Date.now() + 120_000; ; ) {
				if (ended) throw new Error(`${ended}. Its last output:\n${tail.trim() || "(none)"}`);
				const status = await opened.probe();
				if (status && status !== 502 && status !== 503 && status !== 504) break;
				if (Date.now() > until) {
					await stop();
					throw new Error(`nothing answered on port ${port} within 2 minutes. Its last output:\n${tail.trim() || "(none)"}`);
				}
				await sleep(700);
			}
			return { ended: exit, stop };
		};
		await opened.serve({ start }, SERVE_IDLE_MINUTES * 60_000).catch((error: Error) => {
			throw new ToolError(`The app's server didn't start: ${error.message}`);
		});
		return opened;
	}

	/** Open a port of the sandbox on this computer (port_proxy.ts); one loopback address per port, reused. */
	async openPort(port: number, path = "/", signal?: AbortSignal): Promise<OpenPort> {
		if (!this.offers("ports")) throw Object.assign(new Error(`${this.title} doesn't open sandbox ports.`), { unsupported: true });
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ToolError("Give a port from 1 to 65535.");
		const id = await this.sandbox(signal);
		const kept = this.ports.get(`${id}:${port}`);
		if (kept) return kept;
		const prefix = `${this.route.base}/v1/containers/${encodeURIComponent(id)}/ports/${port}`;
		const opened = openPort(
			{
				url: (p) => `${prefix}${p}`,
				// A page's requests through the port can't be sent twice, so the nonce is kept recent beforehand.
				headers: async (method, url) => (await this.freshNonce(), this.authHeaders(method, url)),
				answered: (response) => void this.noteNonce(response),
				ca: this.route.ca,
			},
			path,
		);
		this.ports.set(`${id}:${port}`, opened);
		return opened;
	}

	/**
	 * Engine shutdown or sign-out. The sandbox keeps the person's work (a session may work in it), so it is never
	 * deleted here: where the lab can stop one it stops (files kept, nothing running, it costs the lab only storage), and
	 * the next start wakes it. A lab that can't stop sandboxes ends idle ones itself. Returns the sandbox's id.
	 */
	async close(): Promise<string | undefined> {
		// The next connection waits for approval itself. (A connect that failed is never closed: its wait goes on
		// and reconnects through onApproved.)
		clearInterval(this.approving);
		this.approving = undefined;
		for (const opened of this.ports.values()) opened.close();
		this.ports.clear();
		await this.mcp?.close().catch(() => undefined);
		const id = this.container;
		this.container = undefined;
		if (!id || !this.offers("stop")) return id;
		// A background job still running keeps the sandbox running for it.
		for (const job of this.jobs) {
			const state = await this.json<{ status?: string }>("GET", `/v1/containers/${id}/jobs/${encodeURIComponent(job)}?log_bytes=0`, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
			if (state?.status === "running" || state?.status === "queued") return id;
		}
		await this.call("POST", `/v1/containers/${encodeURIComponent(id)}/stop`, { json: {}, noWait: true, signal: AbortSignal.timeout(10_000) }).then(
			(r) => r.arrayBuffer(),
			() => undefined,
		);
		return id;
	}
}

