// File checkpoints: before a tool changes a file, its bytes (or its absence) are kept beside the session log, so a
// turn's file changes can be undone. Shell commands aren't covered; they can change anything.

import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirPhysical, openPhysical, unlinkPhysical } from "../tools/anchored.ts";
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
			// Read where the path leads, without following a link anywhere on the way (one swapped in is refused).
			let fd: number;
			try {
				fd = openPhysical(real, constants.O_RDONLY);
			} catch {
				if (!lstatSync(real, { throwIfNoEntry: false })) out.push({ path, existed: false, real });
				continue;
			}
			let bytes: Buffer;
			try {
				const info = fstatSync(fd);
				if (!info.isFile() || info.size > MAX_BYTES) continue;
				bytes = readFileSync(fd);
			} finally {
				closeSync(fd);
			}
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
				// Only where the path still leads to the file that was kept; a record from before that was noted is left.
				if (!file.real || physical(file.path) !== file.real) continue;
				// Acts where the path leads: through a link to a file that didn't exist, the file made there goes, not the link.
				const at = file.real ?? file.path;
				if (!kept.has(at)) {
					const now = this.capture([at]);
					// Too large to keep (or not a plain file): writing over it would lose it, so it stays as it is.
					if (!now.length) continue;
					kept.set(at, now[0]!);
				}
				if (file.existed && file.blob) {
					// Folders made and the file opened without following a link anywhere on the way (anchored.ts), so a
					// folder swapped for a link meanwhile makes it fail rather than write somewhere else.
					let fd: number;
					try {
						mkdirPhysical(dirname(at));
						fd = openPhysical(at, constants.O_WRONLY | constants.O_CREAT, 0o666);
					} catch {
						continue;
					}
					try {
						if (!fstatSync(fd).isFile()) continue;
						ftruncateSync(fd, 0);
						writeSync(fd, readFileSync(join(this.dir, file.blob)), 0, undefined, 0);
					} finally {
						closeSync(fd);
					}
				} else if (!file.existed) {
					// Removed the same way: a link anywhere on the path, or a folder there, and it stays.
					if (lstatSync(at, { throwIfNoEntry: false })?.isDirectory() || !unlinkPhysical(at)) {
						if (lstatSync(at, { throwIfNoEntry: false })) continue;
					}
				}
				restored.add(file.path);
			}
		}
		return { restored: [...restored], kept: [...kept.values()] };
	}
}
