// File checkpoints: before a tool changes a file, its bytes (or its absence) are kept beside the session log, so a
// turn's file changes can be undone. Shell commands aren't covered; they can change anything.

import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { physical } from "../tools/workspace.ts";

/**
 * One file as it was before a change. `blob` names the stored bytes; absent when the file didn't exist. `real` is
 * where the path led then, links followed: undo puts the file back only while it still leads there.
 */
export interface FileBefore {
	path: string;
	existed: boolean;
	blob?: string;
	real?: string;
}

/** Files larger than this aren't kept; undo leaves them as they are and says so. */
const MAX_BYTES = 25 * 1024 * 1024;

export class Checkpoints {
	constructor(private dir: string) {}

	/** Record each path as it is now. Paths must be absolute. */
	capture(paths: string[]): FileBefore[] {
		const out: FileBefore[] = [];
		for (const path of paths) {
			const real = physical(path);
			if (!existsSync(path)) {
				out.push({ path, existed: false, real });
				continue;
			}
			const info = statSync(path);
			if (!info.isFile() || info.size > MAX_BYTES) continue;
			const bytes = readFileSync(path);
			const blob = createHash("sha256").update(bytes).digest("hex");
			const file = join(this.dir, blob);
			if (!existsSync(file)) {
				mkdirSync(this.dir, { recursive: true, mode: 0o700 });
				writeFileSync(file, bytes, { mode: 0o600 });
			}
			out.push({ path, existed: true, blob, real });
		}
		return out;
	}

	/**
	 * Put files back, newest change first, so each ends as it was before the earliest one. Each file is kept as it is
	 * now first (`kept`), so what undo writes over isn't lost.
	 */
	restore(changes: FileBefore[][]): { restored: string[]; kept: FileBefore[] } {
		const restored = new Set<string>();
		const kept = new Map<string, FileBefore>();
		for (const files of [...changes].reverse()) {
			for (const file of files) {
				// A link on the way now leads somewhere else: that isn't the file that was kept.
				if (file.real && physical(file.path) !== file.real) continue;
				// Acts where the path leads: through a link to a file that didn't exist, the file made there goes, not the link.
				const at = file.real ?? file.path;
				if (!kept.has(at)) {
					const now = this.capture([at]);
					// Too large to keep (or not a plain file): writing over it would lose it, so it stays as it is.
					if (!now.length) continue;
					kept.set(at, now[0]!);
				}
				if (file.existed && file.blob) {
					mkdirSync(dirname(at), { recursive: true });
					// Never through a link at the end: the path was checked to lead here.
					const fd = openSync(at, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o666);
					try {
						writeSync(fd, readFileSync(join(this.dir, file.blob)));
					} finally {
						closeSync(fd);
					}
				} else if (!file.existed) rmSync(at, { force: true });
				restored.add(file.path);
			}
		}
		return { restored: [...restored], kept: [...kept.values()] };
	}
}
