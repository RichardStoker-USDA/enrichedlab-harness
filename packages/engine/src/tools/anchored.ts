// File operations on a physical path (one with no links in it, as physical() gives) that never follow a link,
// in any part of the path, even one swapped in after the path was checked: a link appearing anywhere makes the
// operation fail instead of landing somewhere else. macOS has this in the kernel (O_NOFOLLOW_ANY and
// AT_SYMLINK_NOFOLLOW_ANY); Linux walks the path one folder at a time with openat, each opened without following a
// link. Windows uses the ordinary calls (its links need privileges to make).

import { dlopen, FFIType } from "bun:ffi";
import { closeSync, constants, mkdirSync, openSync, rmSync } from "node:fs";
import { dirname, isAbsolute, sep } from "node:path";

const DARWIN_NOFOLLOW_ANY = 0x20000000;
const DARWIN_AT_FDCWD = -2;
const DARWIN_AT_SYMLINK_NOFOLLOW_ANY = 0x0800;
const LINUX_O_CLOEXEC = 0o2000000;
/** Opens a folder for walking through it: needs search permission only, like ordinary path lookup. */
const LINUX_O_PATH = 0o10000000;

type Libc = {
	openat: (dir: number, path: Buffer, flags: number, mode: number) => number;
	mkdirat: (dir: number, path: Buffer, mode: number) => number;
	unlinkat: (dir: number, path: Buffer, flag: number) => number;
	close: (fd: number) => number;
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
		close: { args: [FFIType.i32], returns: FFIType.i32 },
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
