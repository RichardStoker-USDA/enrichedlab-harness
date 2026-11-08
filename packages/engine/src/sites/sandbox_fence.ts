// The file fence for commands in a lab's sandbox (docs/security.md, "In a lab's sandbox"): Linux Landlock (ABI 3 or
// later, so truncation is covered), set up by a short Python program that then runs the command with /bin/bash.
// Writes, truncation, removals, renames, links and new files land only in the project (anchored to the folder the
// command starts in, not to its name), in a temp folder made for that one command, and on a few device files
// (/dev/null and the like); everything the command starts inherits the fence. Where the kernel has them, TCP and
// signals or abstract sockets reaching processes outside the fence are refused too. Reading isn't fenced (the
// sandbox holds only the person's own work), and the sandbox has no network. File modes, owners and times aren't
// covered by Landlock. A sandbox whose kernel or image can't fence (an older Landlock, no root-owned python3) says
// so when probed, and its commands ask instead.

/** Interpreters the fence may run with: the image's own, root-owned and writable by nobody else (checked in the probe). */
export const FENCE_PYTHONS = ["/usr/bin/python3", "/usr/local/bin/python3"];

/**
 * The Landlock program. `probe <nonce>`: fences a child to one folder and checks that it can't truncate, write,
 * remove, rename into or link in another; prints "el-fence ok <nonce>" when all of that holds. `run <root> <command>`:
 * checks that <root> is the folder it was started in, fences, and runs the command with /bin/bash.
 */
export const FENCE_PY = String.raw`
import ctypes, os, shutil, signal, sys, tempfile
NR = (444, 445, 446)
WRITE_FILE, REMOVE_DIR, REMOVE_FILE = 1 << 1, 1 << 4, 1 << 5
MAKE = sum(1 << b for b in range(6, 13))
REFER, TRUNCATE, IOCTL_DEV = 1 << 13, 1 << 14, 1 << 15
EVERY = WRITE_FILE | REMOVE_DIR | REMOVE_FILE | MAKE | REFER | TRUNCATE | IOCTL_DEV
FILE_RIGHTS = WRITE_FILE | TRUNCATE | IOCTL_DEV
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
L = ctypes.c_long

class Ruleset(ctypes.Structure):
    _fields_ = [("fs", ctypes.c_uint64), ("net", ctypes.c_uint64), ("scoped", ctypes.c_uint64)]

class Beneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed", ctypes.c_uint64), ("parent", ctypes.c_int32)]

def abi():
    if os.uname().machine not in ("x86_64", "aarch64", "riscv64", "ppc64le", "s390x"):
        return 0
    v = libc.syscall(L(NR[0]), None, L(0), L(1))
    return v if v > 0 else 0

def fence(rules):
    v = abi()
    if v < 3:
        raise OSError("Landlock ABI %d; 3 or later is needed" % v)
    handled = EVERY if v >= 5 else EVERY & ~IOCTL_DEV
    attr = Ruleset(handled, 3 if v >= 4 else 0, 3 if v >= 6 else 0)
    size = 8 if v < 4 else (16 if v < 6 else 24)
    fd = libc.syscall(L(NR[0]), ctypes.byref(attr), L(size), L(0))
    if fd < 0:
        raise OSError("ruleset: errno %d" % ctypes.get_errno())
    for target, rights in rules:
        opened = isinstance(target, int)
        try:
            parent = target if opened else os.open(target, os.O_PATH | os.O_CLOEXEC | os.O_NOFOLLOW)
        except OSError:
            continue
        rule = Beneath(rights & handled, parent)
        r = libc.syscall(L(NR[1]), L(fd), L(1), ctypes.byref(rule), L(0))
        if not opened:
            os.close(parent)
        if r != 0:
            raise OSError("rule: errno %d" % ctypes.get_errno())
    if libc.prctl(38, 1, 0, 0, 0) != 0:
        raise OSError("no_new_privs: errno %d" % ctypes.get_errno())
    if libc.syscall(L(NR[2]), L(fd), L(0)) != 0:
        raise OSError("restrict: errno %d" % ctypes.get_errno())
    os.close(fd)

DEVICES = ["/dev/null", "/dev/zero", "/dev/full", "/dev/tty"]
DROP = ("BASH_ENV", "ENV", "ZDOTDIR", "SHELLOPTS", "BASHOPTS", "PS4", "PROMPT_COMMAND", "CDPATH", "GLOBIGNORE", "BASH_XTRACEFD", "EXECIGNORE", "IFS")

def probe(nonce):
    base = tempfile.mkdtemp(prefix=".el-fence-", dir=os.getcwd())
    try:
        inside, outside = os.path.join(base, "in"), os.path.join(base, "out")
        os.mkdir(inside)
        os.mkdir(outside)
        existing = os.path.join(outside, "existing")
        with open(existing, "w") as f:
            f.write("keep")
        pid = os.fork()
        if pid == 0:
            try:
                fence([(os.open(inside, os.O_PATH | os.O_DIRECTORY), EVERY)])
                open(os.path.join(inside, "ok"), "w").close()
                for attempt in (
                    lambda: os.truncate(existing, 0),
                    lambda: open(existing, "r+").close(),
                    lambda: open(os.path.join(outside, "new"), "w").close(),
                    lambda: os.unlink(existing),
                    lambda: os.rename(os.path.join(inside, "ok"), os.path.join(outside, "moved")),
                    lambda: os.mkdir(os.path.join(outside, "d")),
                    lambda: os.symlink("x", os.path.join(outside, "l")),
                ):
                    try:
                        attempt()
                        os._exit(3)
                    except OSError:
                        pass
                os._exit(0)
            except Exception:
                os._exit(4)
        _, status = os.waitpid(pid, 0)
        with open(existing) as f:
            kept = f.read() == "keep"
        held = os.waitstatus_to_exitcode(status) == 0 and kept and os.path.exists(os.path.join(inside, "ok")) and sorted(os.listdir(outside)) == ["existing"]
        print("el-fence %s %s abi %d py %s" % ("ok" if held else "no", nonce, abi(), sys.executable))
    finally:
        shutil.rmtree(base, ignore_errors=True)

def run(root, command):
    here = os.open(".", os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    named = os.lstat(root)
    started = os.fstat(here)
    if not os.path.isdir(root) or os.path.islink(root) or (named.st_dev, named.st_ino) != (started.st_dev, started.st_ino):
        raise OSError("the project folder isn't the folder the command started in")
    temp = tempfile.mkdtemp(prefix="el-fence-")
    own = os.open(temp, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        env = {k: v for k, v in os.environ.items() if k not in DROP and not k.startswith("BASH_FUNC_") and not v.startswith("() {")}
        env.update(TMPDIR=temp, TMP=temp, TEMP=temp)
        rules = [(here, EVERY), (own, EVERY)] + [(d, FILE_RIGHTS) for d in DEVICES if os.path.exists(d)]
        pid = os.fork()
        if pid == 0:
            try:
                fence(rules)
            except OSError as e:
                sys.stderr.write("The sandbox couldn't fence this command (%s), so it didn't run.\n" % e)
                os._exit(125)
            os.execve("/bin/bash", ["bash", "-c", command], env)
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, lambda s, f: os.kill(pid, s))
        while True:
            try:
                _, status = os.waitpid(pid, 0)
                break
            except InterruptedError:
                continue
        code = os.waitstatus_to_exitcode(status)
        return code if code >= 0 else 128 - code
    finally:
        shutil.rmtree(temp, ignore_errors=True)

if sys.argv[1] == "probe":
    try:
        probe(sys.argv[2])
    except Exception:
        print("el-fence no")
else:
    try:
        sys.exit(run(sys.argv[2], sys.argv[3]))
    except OSError as e:
        sys.stderr.write("The sandbox couldn't fence this command (%s), so it didn't run.\n" % e)
        sys.exit(125)
`;

/** Runs the probe with the system's python3 when it is root-owned and writable only by root; else says "no". */
/** The interpreter starts without loader variables, so nothing runs in it before the fence is set. */
const CLEAN = "env -u LD_PRELOAD -u LD_AUDIT -u LD_LIBRARY_PATH -u PYTHONHOME -u PYTHONPATH";

/** Probes with the first interpreter that is root-owned, in a root-owned folder, and writable only by root. */
export function probeCommand(nonce: string, quote: (text: string) => string): string {
	const ok = (py: string) => `[ -x ${py} ] && [ "$(stat -L -c %u ${py})" = 0 ] && [ "$(stat -L -c %u $(dirname ${py}))" = 0 ] && [ $(( 0$(stat -L -c %a ${py}) & 022 )) = 0 ] && [ $(( 0$(stat -L -c %a $(dirname ${py})) & 022 )) = 0 ]`;
	const pick = FENCE_PYTHONS.map((py) => `if [ -z "$__el_py" ] && ${ok(py)}; then __el_py=${py}; fi`).join("; ");
	return `__el_py=; ${pick}; if [ -n "$__el_py" ]; then ${CLEAN} "$__el_py" -I -c ${quote(FENCE_PY)} probe ${quote(nonce)}; else echo "el-fence no"; fi`;
}

/** The interpreter a probe answer names, when it is one the fence may use; undefined otherwise. */
export function fencePython(line: string, nonce: string): string | undefined {
	const m = new RegExp(`^el-fence ok ${nonce} abi \\d+ py (\\S+)$`).exec(line.trim());
	const py = m?.[1];
	if (!py) return undefined;
	// python3 may be a link to python3.x in the same folder: the probe ran it by the name it was checked under.
	return FENCE_PYTHONS.find((name) => py === name || (py.startsWith(name.slice(0, name.lastIndexOf("/") + 1)) && /\/python3(\.\d+)?$/.test(py))) ? py : undefined;
}

/** The command fenced with the interpreter the probe checked: the project is `root`, the folder the shell is in. */
export function fencedCommand(root: string, command: string, quote: (text: string) => string, python = FENCE_PYTHONS[0]!): string {
	return `${CLEAN} ${python} -I -c ${quote(FENCE_PY)} run ${quote(root)} ${quote(command)}`;
}
