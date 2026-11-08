// File operations on a physical path (one with no links in it, as physical() gives) that never follow a link,
// in any part of the path, even one swapped in after the path was checked: a link appearing anywhere makes the
// operation fail instead of landing somewhere else. macOS has this in the kernel (O_NOFOLLOW_ANY and
// AT_SYMLINK_NOFOLLOW_ANY); Linux walks the path one folder at a time with openat, each opened without following a
// link. Windows uses the ordinary calls (its links need privileges to make).

import { CString, dlopen, FFIType, toArrayBuffer, type Pointer } from "bun:ffi";
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";

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

/** Hold a Linux project through launch and cleanup. Every walk and rename is relative to held, no-follow folders. */
export function holdGitEntries(path: string, maxEntries = 50_000, maxDepth = 64): {
	paths: string[];
	quarantine(): { moved: { from: string; to: string }[]; error?: string };
	release(): void;
} {
	if (process.platform !== "linux") throw new Error("Git quarantine is for Linux.");
	const root = holdFolder(path);
	let released = false;
	const release = () => {
		if (!released) lib().close(root);
		released = true;
	};
	const errno = new Int32Array(toArrayBuffer(lib().__errno_location(), 0, 4));
	const walk = (visit: (dir: number, name: string, relative: string) => void) => {
		if (released) throw new Error("The project folder is no longer held.");
		let seen = 0;
		const descend = (dir: number, relative: string, depth: number) => {
			// A fresh open gives each scan its own directory position; dup would share the previous scan's offset.
			const opened = lib().openat(dir, c("."), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | LINUX_O_CLOEXEC, 0);
			if (opened < 0) throw new Error(`Couldn't scan ${relative || "."} for .git entries.`);
			const stream = lib().fdopendir(opened);
			if (!stream) {
				lib().close(opened);
				throw new Error(`Couldn't enumerate ${relative || "."}.`);
			}
			try {
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
						if (fstatSync(child).isDirectory()) {
							if (depth >= maxDepth) throw new Error(`The project is deeper than ${maxDepth} folders; .git protection couldn't be completed.`);
							descend(child, next, depth + 1);
						}
					} finally {
						lib().close(child);
					}
				}
			} finally {
				lib().closedir(stream);
			}
		};
		descend(root, "", 0);
	};
	const identity = (dir: number, name: string): string => {
		const fd = lib().openat(dir, c(name), LINUX_O_PATH | constants.O_NOFOLLOW | LINUX_O_CLOEXEC, 0);
		if (fd < 0) throw new Error(`Couldn't check the identity of ${name}.`);
		try {
			const stat = fstatSync(fd, { bigint: true });
			return `${stat.dev}:${stat.ino}`;
		} finally {
			lib().close(fd);
		}
	};
	const initial = new Map<string, string>();
	try {
		walk((dir, name, relative) => initial.set(relative, identity(dir, name)));
	} catch (error) {
		release();
		throw error;
	}
	return {
		paths: [...initial.keys()].map((relative) => join(path, relative)),
		release,
		quarantine() {
			const moved: { from: string; to: string }[] = [];
			try {
				walk((dir, name, relative) => {
					// Moving an old metadata directory away and making a new one at its name is still a new entry.
					if (initial.get(relative) === identity(dir, name)) return;
					const blocked = `.git.enrichedlab-blocked-${randomBytes(6).toString("hex")}`;
					// renameat2 never follows the final entry, even if it is a symlink. NOREPLACE prevents any loss of
					// existing data at the destination. No pathname lookup can escape the held parent folder.
					if (lib().renameat2(dir, c(name), dir, c(blocked), 1) !== 0) throw new Error(`Couldn't move aside ${relative} (errno ${errno[0]}).`);
					moved.push({ from: relative, to: join(dirname(relative), blocked) });
				});
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
