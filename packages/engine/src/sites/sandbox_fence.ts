// The file fence for commands in a lab's sandbox (docs/security.md, "In a lab's sandbox"): Linux Landlock, set up by
// a short Python program that then runs the command. Writes, removals and new files land only in the project, the
// temp folders and device files such as /dev/null; everything the command starts inherits the fence. Reading is
// not fenced (the sandbox holds only the person's own work), and the sandbox has no network. A sandbox whose kernel
// or image can't fence (no Landlock, no python3) says so when probed, and its commands ask instead.

/** The Landlock program: `probe` reports whether a fence holds here; `run <root> <program> <args...>` fences and runs. */
export const FENCE_PY = String.raw`
import ctypes, os, sys
NR = (444, 445, 446)
WRITE_FILE, REMOVE_DIR, REMOVE_FILE = 1 << 1, 1 << 4, 1 << 5
MAKE = sum(1 << b for b in range(6, 13))
REFER, TRUNCATE = 1 << 13, 1 << 14
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
L = ctypes.c_long

class Ruleset(ctypes.Structure):
    _fields_ = [("fs", ctypes.c_uint64)]

class Beneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed", ctypes.c_uint64), ("parent", ctypes.c_int32)]

def abi():
    if os.uname().machine not in ("x86_64", "aarch64", "riscv64", "ppc64le", "s390x"):
        return 0
    v = libc.syscall(L(NR[0]), None, L(0), L(1))
    return v if v > 0 else 0

def fence(allowed):
    v = abi()
    if v < 1:
        raise OSError("no Landlock")
    handled = WRITE_FILE | REMOVE_DIR | REMOVE_FILE | MAKE | (REFER if v >= 2 else 0) | (TRUNCATE if v >= 3 else 0)
    attr = Ruleset(handled)
    fd = libc.syscall(L(NR[0]), ctypes.byref(attr), L(ctypes.sizeof(attr)), L(0))
    if fd < 0:
        raise OSError("ruleset: errno %d" % ctypes.get_errno())
    for path, rights in allowed:
        try:
            parent = os.open(path, os.O_PATH | os.O_CLOEXEC)
        except OSError:
            continue
        rule = Beneath(rights & handled, parent)
        r = libc.syscall(L(NR[1]), L(fd), L(1), ctypes.byref(rule), L(0))
        os.close(parent)
        if r != 0:
            raise OSError("rule for %s: errno %d" % (path, ctypes.get_errno()))
    if libc.prctl(38, 1, 0, 0, 0) != 0:
        raise OSError("no_new_privs: errno %d" % ctypes.get_errno())
    if libc.syscall(L(NR[2]), L(fd), L(0)) != 0:
        raise OSError("restrict: errno %d" % ctypes.get_errno())
    os.close(fd)

def allowed(root):
    every = WRITE_FILE | REMOVE_DIR | REMOVE_FILE | MAKE | REFER | TRUNCATE
    return [(root, every), ("/tmp", every), ("/var/tmp", every), ("/dev/shm", every), ("/dev", WRITE_FILE | TRUNCATE)]

def probe():
    import shutil, tempfile
    base = tempfile.mkdtemp(prefix=".el-fence-", dir=os.getcwd())
    try:
        os.mkdir(os.path.join(base, "in"))
        os.mkdir(os.path.join(base, "out"))
        pid = os.fork()
        if pid == 0:
            try:
                fence([(os.path.join(base, "in"), WRITE_FILE | MAKE | REMOVE_FILE)])
                open(os.path.join(base, "in", "ok"), "w").close()
                try:
                    open(os.path.join(base, "out", "no"), "w").close()
                    os._exit(3)
                except PermissionError:
                    os._exit(0)
            except Exception:
                os._exit(4)
        _, status = os.waitpid(pid, 0)
        code = os.waitstatus_to_exitcode(status)
        print("el-fence %s abi %d" % ("ok" if code == 0 and os.path.exists(os.path.join(base, "in", "ok")) else "no", abi()))
    finally:
        shutil.rmtree(base, ignore_errors=True)

if sys.argv[1] == "probe":
    try:
        probe()
    except Exception:
        print("el-fence no abi 0")
else:
    try:
        fence(allowed(os.path.realpath(sys.argv[2])))
    except OSError as e:
        sys.stderr.write("The sandbox couldn't fence this command (%s), so it didn't run.\n" % e)
        os._exit(125)
    os.execvp(sys.argv[3], sys.argv[3:])
`;
