// File operations on a physical path (one with no links in it, as physical() gives) that never follow a link,
// in any part of the path, even one swapped in after the path was checked: a link appearing anywhere makes the
// operation fail instead of landing somewhere else. macOS has this in the kernel (O_NOFOLLOW_ANY and
// AT_SYMLINK_NOFOLLOW_ANY); Linux walks the path one folder at a time with openat, each opened without following a
// link. Windows uses the ordinary calls (its links need privileges to make).

import { CString, dlopen, FFIType, toArrayBuffer, type Pointer } from "bun:ffi";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { getSystemErrorName } from "node:util";

const DARWIN_NOFOLLOW_ANY = 0x20000000;
const DARWIN_AT_FDCWD = -2;
const DARWIN_AT_SYMLINK_NOFOLLOW_ANY = 0x0800;
const LINUX_O_CLOEXEC = 0o2000000;
const AT_REMOVEDIR = process.platform === "darwin" ? 0x80 : 0x200;
/** Opens a folder for walking through it: needs search permission only, like ordinary path lookup. */
const LINUX_O_PATH = 0o10000000;

type Libc = {
	openat: (dir: number, path: Buffer, flags: number, mode: number) => number;
	mkdirat: (dir: number, path: Buffer, mode: number) => number;
	unlinkat: (dir: number, path: Buffer, flag: number) => number;
	dup: (fd: number) => number;
	fdopendir: (fd: number) => Pointer | null;
	readdir: (dir: Pointer) => Pointer | null;
	closedir: (dir: Pointer) => number;
	close: (fd: number) => number;
	renameat: (fromDir: number, from: Buffer, toDir: number, to: Buffer) => number;
	renameat2: (fromDir: number, from: Buffer, toDir: number, to: Buffer, flags: number) => number;
	__errno_location: () => Pointer;
};

let libc: Libc | undefined;
function lib(): Libc {
	if (libc) return libc;
	const path = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
	// openat's mode is variadic: Linux passes it in a register like any argument (only Linux uses it with O_CREAT).
	const { symbols } = dlopen(path, {
		openat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
		mkdirat: { args: [FFIType.i32, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
		unlinkat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
		dup: { args: [FFIType.i32], returns: FFIType.i32 },
		fdopendir: { args: [FFIType.i32], returns: FFIType.ptr },
		readdir: { args: [FFIType.ptr], returns: FFIType.ptr },
		closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
		close: { args: [FFIType.i32], returns: FFIType.i32 },
		...(process.platform === "linux" ? {
			renameat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring], returns: FFIType.i32 },
			renameat2: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
			__errno_location: { args: [], returns: FFIType.ptr },
		} : {}),
	});
	libc = symbols as unknown as Libc;
	return libc;
}

/** A C string; a NUL inside would end it early (".." from "..\0a"), so it is refused. */
const c = (text: string) => {
	if (text.includes("\0")) throw new Error("A path can't hold a NUL character.");
	return Buffer.from(`${text}\0`);
};

function parts(path: string): string[] {
	if (!isAbsolute(path)) throw new Error(`${path} isn't an absolute path.`);
	// C ends a name at NUL: "..\0a" would reach the kernel as "..".
	if (path.includes("\0")) throw new Error("A path can't hold a NUL character.");
	const names = path.split(sep).filter(Boolean);
	if (names.some((n) => n === "." || n === "..")) throw new Error(`${path} isn't a physical path.`);
	return names;
}

/** Linux: open the folder at `names` by walking from / without following any link (making missing ones when asked). */
function linuxWalk(path: string, names: string[], make: boolean): number {
	const { openat, mkdirat, close } = lib();
	let dir = openat(-100, c("/"), LINUX_O_PATH | constants.O_DIRECTORY | LINUX_O_CLOEXEC, 0);
	if (dir < 0) throw new Error("Couldn't open /.");
	for (const part of names) {
		const flags = LINUX_O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW | LINUX_O_CLOEXEC;
		let next = openat(dir, c(part), flags, 0);
		// Made, or made meanwhile by someone else (EEXIST): either way opened again the same link-free way.
		if (next < 0 && make) {
			mkdirat(dir, c(part), 0o777);
			next = openat(dir, c(part), flags, 0);
		}
		close(dir);
		if (next < 0) throw new Error(`${path}: a part of the path is missing, isn't a folder, or is a link.`);
		dir = next;
	}
	return dir;
}

/** Linux: the folder holding the last part, and that part's name; the caller closes the folder. */
function linuxParent(path: string): { dir: number; name: string } {
	const names = parts(path);
	const name = names.pop();
	if (!name) throw new Error("No file name.");
	return { dir: linuxWalk(path, names, false), name };
}

/** Open a physical path without following a link anywhere in it. */
export function openPhysical(path: string, flags: number, mode = 0o666): number {
	if (path.includes("\0")) throw new Error("A path can't hold a NUL character.");
	if (process.platform === "darwin") return openSync(path, flags | DARWIN_NOFOLLOW_ANY, mode);
	if (process.platform !== "linux") return openSync(path, flags | constants.O_NOFOLLOW, mode);
	const { dir, name } = linuxParent(path);
	try {
		const fd = lib().openat(dir, c(name), flags | constants.O_NOFOLLOW | LINUX_O_CLOEXEC, mode);
		if (fd < 0) {
			const error = new Error(`${path}: couldn't open it without following a link.`) as NodeJS.ErrnoException;
			error.code = "ENOENT_OR_LINK";
			throw error;
		}
		return fd;
	} finally {
		lib().close(dir);
	}
}

/** Linux: a handle on the folder at a physical path, opened without following a link anywhere (O_PATH: no read needed). */
export function holdFolder(path: string): number {
	if (process.platform !== "linux") throw new Error("Folder handles are for Linux.");
	return linuxWalk(path, parts(path), false);
}

export interface GitEntryBaseline {
	root: string;
	entries: [relative: string, identity: string][];
}

export interface GitQuarantineResult {
	moved: { from: string; to: string }[];
	error?: string;
}

export interface GitQuarantineIntent {
	/** Device and inode of the entry named when the intent was recorded. */
	item: string;
	from: string;
	to: string;
}

export interface GitQuarantineJournal {
	intent(move: GitQuarantineIntent): void;
	done(move: GitQuarantineIntent): void;
}

/** Test observation point after a real directory fsync has completed. */
export interface GitQuarantineHooks {
	directoryFsynced?(directory: "source" | "quarantine", move: GitQuarantineIntent): void;
}

export interface HeldGitEntries {
	paths: string[];
	baseline: GitEntryBaseline;
	quarantinePath: string;
	/** Reconcile a durable intent left without its durable done record. */
	recover(move: GitQuarantineIntent): { moved: boolean };
	quarantine(final?: boolean, journal?: GitQuarantineJournal): GitQuarantineResult;
	release(): void;
}

/** Hold a private engine folder, checking the opened directory rather than trusting its path. */
export function holdPrivateFolder(path: string, device?: bigint): number {
	if (process.platform !== "linux") throw new Error("Private folder handles are for Linux.");
	const held = holdFolder(path);
	try {
		const stat = fstatSync(held, { bigint: true });
		const uid = process.getuid?.();
		if (!stat.isDirectory() || uid === undefined || stat.uid !== BigInt(uid) || (stat.mode & 0o7777n) !== 0o700n || (device !== undefined && stat.dev !== device)) {
			throw new Error("The .git quarantine must be a no-link directory owned by this user, mode 0700, on the project's filesystem.");
		}
		return held;
	} catch (error) {
		lib().close(held);
		throw error;
	}
}

/**
 * Hold a Linux project through launch and cleanup. Every walk and rename is relative to held, no-follow folders.
 * A saved baseline is used only to finish a pass left pending by an earlier engine process.
 */
export function holdGitEntries(path: string, maxEntries = 50_000, maxDepth = 64, saved?: GitEntryBaseline, quarantinePath = join(dirname(path), ".enrichedlab-git-quarantine"), hooks: GitQuarantineHooks = {}): HeldGitEntries {
	if (process.platform !== "linux") throw new Error("Git quarantine is for Linux.");
	const root = holdFolder(path);
	const rootStat = fstatSync(root, { bigint: true });
	let quarantineRoot: number;
	try {
		try {
			mkdirSync(quarantinePath, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		quarantineRoot = holdPrivateFolder(quarantinePath, rootStat.dev);
	} catch (error) {
		lib().close(root);
		throw error;
	}
	const rootIdentity = `${rootStat.dev}:${rootStat.ino}`;
	let released = false;
	const release = () => {
		if (!released) {
			lib().close(root);
			lib().close(quarantineRoot);
		}
		released = true;
	};
	const errno = new Int32Array(toArrayBuffer(lib().__errno_location(), 0, 4));
	const mountId = (fd: number, relative: string): string => {
		let info: string;
		try {
			info = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
		} catch (error) {
			throw new Error(`Couldn't read the mount identity of ${relative || "."} during the .git scan: ${(error as Error).message}`);
		}
		const id = /^mnt_id:\s*(\d+)$/m.exec(info)?.[1];
		if (!id) throw new Error(`Couldn't read the mount identity of ${relative || "."} during the .git scan.`);
		return id;
	};
	let rootMount: string;
	try {
		rootMount = mountId(root, "");
	} catch (error) {
		release();
		throw error;
	}
	const walk = (visit: (dir: number, name: string, relative: string) => void, ownerAccess: "check" | "defer" | "restore" = "check") => {
		if (released) throw new Error("The project folder is no longer held.");
		let seen = 0;
		const descend = (dir: number, relative: string, depth: number) => {
			// After every sandbox process has ended, temporarily restore owner access that the command removed. The
			// held descriptor names the same directory even if its path was renamed. Restore the command's mode after
			// the scan. The foreground pass defers owned folders that need this recovery until every child has ended.
			const directory = fstatSync(dir);
			const originalMode = directory.mode & 0o7777;
			const needsOwnerAccess = (originalMode & 0o700) !== 0o700;
			if (ownerAccess === "defer" && directory.uid === process.getuid?.() && needsOwnerAccess) return;
			const changedMode = ownerAccess === "restore" && needsOwnerAccess;
			if (changedMode) chmodSync(`/proc/self/fd/${dir}`, originalMode | 0o700);
			let stream: Pointer | null = null;
			try {
				// A fresh open gives each scan its own directory position; dup would share the previous scan's offset.
				const opened = lib().openat(dir, c("."), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | LINUX_O_CLOEXEC, 0);
				if (opened < 0) throw new Error(`Couldn't scan ${relative || "."} for .git entries.`);
				stream = lib().fdopendir(opened);
				if (!stream) {
					lib().close(opened);
					throw new Error(`Couldn't enumerate ${relative || "."}.`);
				}
				for (;;) {
					errno[0] = 0;
					const entry = lib().readdir(stream);
					if (!entry) {
						if (errno[0]) throw new Error(`Couldn't finish scanning ${relative || "."}.`);
						break;
					}
					const name = new CString(entry, 19).toString();
					if (name === "." || name === "..") continue;
					if (++seen > maxEntries) throw new Error(`The project has more than ${maxEntries} entries; .git protection couldn't be completed.`);
					const next = relative ? `${relative}/${name}` : name;
					if (name.toLowerCase() === ".git") {
						visit(dir, name, next);
						continue;
					}
					const child = lib().openat(dir, c(name), LINUX_O_PATH | constants.O_NOFOLLOW | LINUX_O_CLOEXEC, 0);
					if (child < 0) throw new Error(`Couldn't check ${next} during the .git scan.`);
					try {
						const childStat = fstatSync(child, { bigint: true });
						if (childStat.isDirectory()) {
							const childMount = mountId(child, next);
							if (childStat.dev !== rootStat.dev || childMount !== rootMount) {
								throw new Error(`The .git scan refused to cross the mount boundary at ${next}: its device or mount ID differs from the project root.`);
							}
							if (depth >= maxDepth) throw new Error(`The project is deeper than ${maxDepth} folders; .git protection couldn't be completed.`);
							descend(child, next, depth + 1);
						}
					} finally {
						lib().close(child);
					}
				}
			} finally {
				if (stream) lib().closedir(stream);
				if (changedMode) chmodSync(`/proc/self/fd/${dir}`, originalMode);
			}
		};
		descend(root, "", 0);
	};
	const identityIfPresent = (dir: number, name: string, display: string): { id: string; symlink: boolean } | undefined => {
		errno[0] = 0;
		const fd = lib().openat(dir, c(name), LINUX_O_PATH | constants.O_NOFOLLOW | LINUX_O_CLOEXEC, 0);
		if (fd < 0) {
			if (errno[0] === 2) return undefined;
			throw new Error(`Couldn't check the identity of ${display}: errno ${errno[0]}.`);
		}
		try {
			const stat = fstatSync(fd, { bigint: true });
			return { id: `${stat.dev}:${stat.ino}`, symlink: stat.isSymbolicLink() };
		} finally {
			lib().close(fd);
		}
	};
	const identity = (dir: number, name: string, display = name): { id: string; symlink: boolean } => {
		const found = identityIfPresent(dir, name, display);
		if (!found) throw new Error(`Couldn't check the identity of ${display}: it disappeared.`);
		return found;
	};
	const sourceParent = (relative: string): { dir?: number; name: string } => {
		const names = relative.split("/");
		const name = names.pop();
		if (!name || names.some((part) => !part || part === "." || part === "..")) throw new Error(`The recorded quarantine source ${relative} is invalid.`);
		let dir = lib().dup(root);
		if (dir < 0) throw new Error(`Couldn't hold the recorded quarantine source ${relative}.`);
		for (let index = 0; index < names.length; index++) {
			const part = names[index]!;
			errno[0] = 0;
			const child = lib().openat(dir, c(part), LINUX_O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW | LINUX_O_CLOEXEC, 0);
			const code = errno[0];
			lib().close(dir);
			if (child < 0) {
				if (code === 2) return { name };
				throw new Error(`Couldn't check the recorded quarantine source ${relative}: errno ${code}.`);
			}
			try {
				const childStat = fstatSync(child, { bigint: true });
				const childMount = mountId(child, names.slice(0, index + 1).join("/"));
				if (childStat.dev !== rootStat.dev || childMount !== rootMount) throw new Error(`The recorded quarantine source ${relative} crosses a mount boundary.`);
			} catch (error) {
				lib().close(child);
				throw error;
			}
			dir = child;
		}
		return { dir, name };
	};
	const syncDirectory = (dir: number, directory: "source" | "quarantine", move: GitQuarantineIntent) => {
		const stat = fstatSync(dir);
		const originalMode = stat.mode & 0o7777;
		const restoreMode = stat.uid === process.getuid?.() && (originalMode & 0o700) !== 0o700;
		if (restoreMode) chmodSync(`/proc/self/fd/${dir}`, originalMode | 0o700);
		let opened = -1;
		try {
			opened = lib().openat(dir, c("."), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | LINUX_O_CLOEXEC, 0);
			if (opened < 0) throw new Error(`Couldn't open the ${directory} directory for the durable move from ${move.from}.`);
			fsyncSync(opened);
			hooks.directoryFsynced?.(directory, move);
		} finally {
			if (opened >= 0) lib().close(opened);
			if (restoreMode) chmodSync(`/proc/self/fd/${dir}`, originalMode);
		}
	};
	const syncMove = (source: number | undefined, move: GitQuarantineIntent) => {
		if (source === undefined) throw new Error(`Couldn't hold the source directory for the durable move from ${move.from}.`);
		// The rename must reach both directory journals before its done record can become durable.
		syncDirectory(source, "source", move);
		syncDirectory(quarantineRoot, "quarantine", move);
	};
	const recover = (move: GitQuarantineIntent): { moved: boolean } => {
		if (dirname(move.to) !== quarantinePath || !/^git-[a-f0-9]{24}$/.test(move.to.split(sep).at(-1) ?? "")) throw new Error(`The recorded quarantine destination ${move.to} is invalid.`);
		const source = sourceParent(move.from);
		let sourceIdentity: string | undefined;
		try {
			sourceIdentity = source.dir === undefined ? undefined : identityIfPresent(source.dir, source.name, move.from)?.id;
			const targetName = move.to.split(sep).at(-1)!;
			const targetIdentity = identityIfPresent(quarantineRoot, targetName, move.to)?.id;
			if (targetIdentity === move.item) {
				if (sourceIdentity === move.item) throw new Error(`Both ${move.from} and ${move.to} name the recorded item; cleanup cannot choose between them.`);
				syncMove(source.dir, move);
				return { moved: false };
			}
			if (targetIdentity !== undefined) throw new Error(`${move.to} exists with a different identity.`);
			if (sourceIdentity === undefined) throw new Error(`Neither ${move.from} nor ${move.to} contains the recorded item.`);
			if (sourceIdentity !== move.item) throw new Error(`${move.from} exists with a different identity and ${move.to} is missing.`);
			if (source.dir === undefined) throw new Error(`${move.from} is missing.`);
			errno[0] = 0;
			if (lib().renameat2(source.dir, c(source.name), quarantineRoot, c(targetName), 1) !== 0) throw new Error(`Couldn't complete the recorded move from ${move.from} to ${move.to}: errno ${errno[0]}.`);
			const movedIdentity = identityIfPresent(quarantineRoot, targetName, move.to)?.id;
			const left = identityIfPresent(source.dir, source.name, move.from);
			if (movedIdentity !== move.item || left) throw new Error(`The completed move from ${move.from} to ${move.to} did not match its recorded identity.`);
			syncMove(source.dir, move);
			return { moved: true };
		} finally {
			if (source.dir !== undefined) lib().close(source.dir);
		}
	};
	const initial = new Map<string, string>(saved?.entries ?? []);
	try {
		if (saved) {
			if (saved.root !== rootIdentity) throw new Error("The project folder changed identity while .git cleanup was pending.");
		} else {
			walk((dir, name, relative) => {
				const entry = identity(dir, name);
				if (entry.symlink) throw new Error(`${relative} is a symbolic link. Linux commands cannot run until the .git link is replaced with Git's regular directory or pointer-file layout.`);
				initial.set(relative, entry.id);
			});
		}
	} catch (error) {
		release();
		throw error;
	}
	return {
		paths: [...initial.keys()].map((relative) => join(path, relative)),
		baseline: { root: rootIdentity, entries: [...initial] },
		quarantinePath,
		recover,
		release,
		quarantine(final = true, journal) {
			const moved: { from: string; to: string }[] = [];
			try {
				walk((dir, name, relative) => {
					// Moving an old metadata directory away and making a new one at its name is still a new entry.
					const item = identity(dir, name, relative).id;
					if (initial.get(relative) === item) return;
					const blocked = `git-${randomBytes(12).toString("hex")}`;
					const intent = { item, from: relative, to: join(quarantinePath, blocked) };
					// The durable intent must exist before the rename. The durable done record follows verification.
					journal?.intent(intent);
					// renameat2 never follows the final entry, even if it is a symlink. NOREPLACE prevents any loss of
					// existing data at the destination. The destination is engine-owned and outside the project.
					errno[0] = 0;
					if (lib().renameat2(dir, c(name), quarantineRoot, c(blocked), 1) !== 0) {
						const code = errno[0];
						let name = `errno ${code}`;
						try {
							name = `${getSystemErrorName(-code)} (errno ${code})`;
						} catch {
							// Keep the numeric errno when this runtime doesn't know its name.
						}
						throw new Error(`Couldn't move aside ${relative}: ${name}.`);
					}
					const target = identityIfPresent(quarantineRoot, blocked, intent.to)?.id;
					const left = identityIfPresent(dir, name, relative);
					if (target !== item || left) throw new Error(`The move from ${relative} to ${intent.to} did not match its recorded identity.`);
					syncMove(dir, intent);
					journal?.done(intent);
					const move = { from: relative, to: intent.to };
					moved.push(move);
				}, final ? "restore" : "defer");
				// With all sandbox children gone, the project must match the baseline before its journal can be removed.
				if (final) walk((dir, name, relative) => {
					if (initial.get(relative) !== identity(dir, name, relative).id) throw new Error(`${relative} changed during the final .git verification scan.`);
				}, "restore");
				return { moved };
			} catch (error) {
				return { moved, error: (error as Error).message };
			}
		},
	};
}

/** Remove a file at a physical path without following a link anywhere in it; true when it was removed. */
export function unlinkPhysical(path: string): boolean {
	if (path.includes("\0")) throw new Error("A path can't hold a NUL character.");
	if (process.platform === "darwin") return lib().unlinkat(DARWIN_AT_FDCWD, c(path), DARWIN_AT_SYMLINK_NOFOLLOW_ANY) === 0;
	if (process.platform !== "linux") {
		rmSync(path, { force: true });
		return true;
	}
	let parent: { dir: number; name: string };
	try {
		parent = linuxParent(path);
	} catch {
		return false;
	}
	try {
		return lib().unlinkat(parent.dir, c(parent.name), 0) === 0;
	} finally {
		lib().close(parent.dir);
	}
}

/**
 * Remove a directory tree only where every descendant is a directory. Directory enumeration and removal stay
 * relative to held descriptors, so replacing a checked project directory with a link cannot redirect the walk.
 */
export function removeEmptyTreePhysical(path: string): boolean {
	if (path.includes("\0")) throw new Error("A path can't hold a NUL character.");
	if (process.platform === "win32") {
		const clear = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) clear(join(dir, entry.name));
			try {
				rmdirSync(dir);
			} catch {
				// A file, junction or concurrent change keeps it in place.
			}
		};
		if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) return false;
		clear(path);
		return !lstatSync(path, { throwIfNoEntry: false });
	}
	let parent: { dir: number; name: string };
	try {
		if (process.platform === "linux") parent = linuxParent(path);
		else parent = { dir: openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | DARWIN_NOFOLLOW_ANY), name: parts(path).at(-1) ?? "" };
	} catch {
		return false;
	}
	const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | (process.platform === "linux" ? constants.O_NOFOLLOW | LINUX_O_CLOEXEC : DARWIN_NOFOLLOW_ANY);
	const clear = (dir: number): void => {
		const copied = lib().dup(dir);
		if (copied < 0) return;
		const stream = lib().fdopendir(copied);
		if (!stream) {
			lib().close(copied);
			return;
		}
		const names: string[] = [];
		try {
			for (;;) {
				const entry = lib().readdir(stream);
				if (!entry) break;
				const name = new CString(entry, process.platform === "darwin" ? 21 : 19).toString();
				if (name !== "." && name !== "..") names.push(name);
			}
		} finally {
			lib().closedir(stream);
		}
		for (const name of names) {
			const child = lib().openat(dir, c(name), directoryFlags, 0);
			if (child < 0) continue;
			try {
				clear(child);
			} finally {
				lib().close(child);
			}
			// If the name became a link or a non-empty directory, unlinkat refuses it. It is never followed.
			lib().unlinkat(dir, c(name), AT_REMOVEDIR);
		}
	};
	let root = -1;
	try {
		root = lib().openat(parent.dir, c(parent.name), directoryFlags, 0);
		if (root < 0) return false;
		clear(root);
		lib().close(root);
		root = -1;
		return lib().unlinkat(parent.dir, c(parent.name), AT_REMOVEDIR) === 0;
	} finally {
		if (root >= 0) lib().close(root);
		lib().close(parent.dir);
	}
}

/** mkdir -p for a physical path: every folder on the way must be a folder, not a link, or it fails. */
export function mkdirPhysical(path: string): void {
	if (path.includes("\0")) throw new Error("A path can't hold a NUL character.");
	if (process.platform === "darwin") {
		const names = parts(path);
		let at = "";
		for (const name of names) {
			at += `${sep}${name}`;
			let fd: number;
			try {
				fd = openSync(at, constants.O_RDONLY | constants.O_DIRECTORY | DARWIN_NOFOLLOW_ANY);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${at} isn't a folder, or a link is on the way.`);
				// Made inside its parent, opened again without following anything.
				const parent = openSync(dirname(at), constants.O_RDONLY | constants.O_DIRECTORY | DARWIN_NOFOLLOW_ANY);
				try {
					if (lib().mkdirat(parent, c(name), 0o777) !== 0) {
						const exists = (() => {
							try {
								closeSync(openSync(at, constants.O_RDONLY | constants.O_DIRECTORY | DARWIN_NOFOLLOW_ANY));
								return true;
							} catch {
								return false;
							}
						})();
						if (!exists) throw new Error(`Couldn't make ${at}.`);
					}
				} finally {
					closeSync(parent);
				}
				continue;
			}
			closeSync(fd);
		}
		return;
	}
	if (process.platform !== "linux") {
		mkdirSync(path, { recursive: true });
		return;
	}
	lib().close(linuxWalk(path, parts(path), true));
}
