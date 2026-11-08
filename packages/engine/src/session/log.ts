// One session on disk: an append-only JSONL log, a small summary for listings, and stored outputs.
//
//   sessions/<id>/log.jsonl     every durable event, one per line, never rewritten
//   sessions/<id>/meta.json     title, model, counts, times (rewritten; derived from the log)
//   sessions/<id>/outputs/      full text of large tool outputs, by handle

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent, SessionSummary } from "@enrichedlab/protocol";
import { newId, now, readJson, writeFileAtomic, writeJson } from "../util.ts";

export interface SessionMeta {
	id: string;
	cwd: string;
	title: string;
	created: string;
	updated: string;
	model: string;
	turns: number;
	site?: string;
	parent?: string;
	place?: string;
	/** The lab where Discovery mode is on. */
	discovery?: string;
	/** How much the session asks, when the person set it for this session. */
	permissions?: "ask" | "auto" | "full";
}

export class SessionLog {
	readonly dir: string;
	readonly logPath: string;
	readonly metaPath: string;
	readonly outputsDir: string;

	constructor(
		root: string,
		readonly id: string,
	) {
		this.dir = join(root, id);
		this.logPath = join(this.dir, "log.jsonl");
		this.metaPath = join(this.dir, "meta.json");
		this.outputsDir = join(this.dir, "outputs");
	}

	static create(
		root: string,
		cwd: string,
		model: string,
		system: string,
		options: { site?: string; agent?: { parent: string; mode: "read" | "full" }; worktree?: { repo: string; path: string; branch: string }; place?: string } = {},
	): { log: SessionLog; header: SessionEvent } {
		const { site, agent, worktree, place } = options;
		const id = newId("s");
		const log = new SessionLog(root, id);
		mkdirSync(log.outputsDir, { recursive: true, mode: 0o700 });
		const created = now();
		const header: SessionEvent = { t: "header", v: 1, id: newId("e"), at: created, cwd, created, system, site, parent: agent?.parent, mode: agent?.mode, worktree };
		log.append(header);
		log.writeMeta({ id, cwd, title: "New session", created, updated: created, model, turns: 0, site, parent: agent?.parent, place });
		return { log, header };
	}

	exists(): boolean {
		return existsSync(this.logPath);
	}

	append(event: SessionEvent): void {
		// After a crash mid-write the file can end inside a line; start a fresh one so this event isn't glued to it.
		if (this.checkTail) {
			this.checkTail = false;
			if (existsSync(this.logPath)) {
				const size = statSync(this.logPath).size;
				if (size > 0) {
					const fd = openSync(this.logPath, "r");
					const last = Buffer.alloc(1);
					readSync(fd, last, 0, 1, size - 1);
					closeSync(fd);
					if (last[0] !== 0x0a) appendFileSync(this.logPath, "\n");
				}
			}
		}
		appendFileSync(this.logPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
	}
	private checkTail = true;

	/** Every event in order. A torn last line (the process died mid-write) is skipped. */
	read(): SessionEvent[] {
		const text = readFileSync(this.logPath, "utf8");
		const events: SessionEvent[] = [];
		for (const line of text.split("\n")) {
			if (!line) continue;
			try {
				events.push(JSON.parse(line) as SessionEvent);
			} catch {
				// A partial final line from a crash; the events before it stand.
			}
		}
		return events;
	}

	meta(): SessionMeta | undefined {
		return readJson<SessionMeta | undefined>(this.metaPath, undefined);
	}

	writeMeta(meta: SessionMeta): void {
		writeJson(this.metaPath, meta, true);
	}

	/** Keep a full output and return its handle. */
	storeOutput(text: string): string {
		const handle = newId("o");
		mkdirSync(this.outputsDir, { recursive: true, mode: 0o700 });
		writeFileAtomic(join(this.outputsDir, `${handle}.txt`), text, true);
		return handle;
	}

	readOutput(handle: string): string | undefined {
		if (!/^o[0-9a-z]+$/.test(handle)) return undefined;
		try {
			return readFileSync(join(this.outputsDir, `${handle}.txt`), "utf8");
		} catch {
			return undefined;
		}
	}
}

export function listSessions(root: string): SessionMeta[] {
	if (!existsSync(root)) return [];
	const out: SessionMeta[] = [];
	for (const id of readdirSync(root)) {
		const meta = readJson<SessionMeta | undefined>(join(root, id, "meta.json"), undefined);
		if (meta?.id) out.push(meta);
	}
	return out.sort((a, b) => b.updated.localeCompare(a.updated));
}

export function toSummary(meta: SessionMeta, running: boolean): SessionSummary {
	return { ...meta, running };
}
