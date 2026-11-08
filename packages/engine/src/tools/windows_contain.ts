// Windows containment without administrator rights: the command runs under a write-restricted copy of the person's
// own token (the approach Chromium and Codex use). A write then needs the person's own access and a grant to one of
// the token's restricted SIDs: Everyone, the logon session, or this install's sandbox SID, which is granted on the
// project and temp folders only. Reads and the network stay open, so Windows commands still ask before they run.
// The command runs in a job object that ends it if this helper ends.

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

const WRITE_RESTRICTED = 0x8;
const DISABLE_MAX_PRIVILEGE = 0x1;
const TOKEN_ALL_ACCESS = 0xf01ff;
const TOKEN_GROUPS = 2;
const SE_GROUP_LOGON_ID = 0xc0000000;
const CREATE_SUSPENDED = 0x4;
const CREATE_UNICODE_ENVIRONMENT = 0x400;
const STARTF_USESTDHANDLES = 0x100;
const HANDLE_FLAG_INHERIT = 0x1;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOB_EXTENDED_LIMIT_INFORMATION = 9;

const wide = (text: string) => Buffer.from(`${text}\0`, "utf16le");

const atOrBelow = (path: string, root: string) => {
	const target = path.toLowerCase();
	const base = root.toLowerCase();
	return target === base || target.startsWith(`${base}${sep}`);
};

function installedProgram(path: string, base: string, excluded: string[] = []): string | undefined {
	try {
		if (!isAbsolute(path) || !statSync(path).isFile()) return undefined;
		const program = realpathSync.native(path);
		const install = realpathSync.native(base);
		if (!atOrBelow(program, install)) return undefined;
		for (const path of excluded) if (atOrBelow(program, realpathSync.native(path))) return undefined;
		return program;
	} catch {
		return undefined;
	}
}

/** PowerShell from an OS install location, never PATH or a program inside the project. */
export function systemPowerShell(project?: string | string[], env: NodeJS.ProcessEnv = process.env): { file: string; name: string } | undefined {
	const excluded = project === undefined ? [] : Array.isArray(project) ? project : [project];
	const programFiles = env.ProgramFiles ?? env.PROGRAMFILES;
	if (programFiles) {
		const file = installedProgram(join(programFiles, "PowerShell", "7", "pwsh.exe"), programFiles, excluded);
		if (file) return { file, name: "PowerShell 7" };
	}
	const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
	if (systemRoot) {
		const file = installedProgram(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), systemRoot, excluded);
		if (file) return { file, name: "Windows PowerShell" };
	}
	return undefined;
}

/** cmd.exe from the Windows installation, used only to probe and test the restricted token. */
export function systemCommand(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
	return systemRoot ? installedProgram(join(systemRoot, "System32", "cmd.exe"), systemRoot) : undefined;
}

/** Quote one argument for a Windows command line (the rules CommandLineToArgvW reads back). */
export function quoteArg(arg: string): string {
	if (arg && !/[\s"]/.test(arg)) return arg;
	let out = '"';
	for (let i = 0; i < arg.length; i++) {
		let slashes = 0;
		while (arg[i] === "\\") (i++, slashes++);
		if (i === arg.length) out += "\\".repeat(slashes * 2);
		else if (arg[i] === '"') out += `${"\\".repeat(slashes * 2 + 1)}"`;
		else out += "\\".repeat(slashes) + arg[i];
	}
	return `${out}"`;
}

/** The command line for `argv`. cmd.exe reads what follows /c as it stands, so that part isn't quoted. */
export function commandLine(argv: string[]): string {
	const at = /(^|[\\/])cmd(\.exe)?$/i.test(argv[0] ?? "") ? argv.findIndex((a) => /^\/c$/i.test(a)) : -1;
	if (at < 0) return argv.map(quoteArg).join(" ");
	return [...argv.slice(0, at + 1).map(quoteArg), ...argv.slice(at + 1)].join(" ");
}

/** This install's sandbox SID, made once (a random SID in the local-authority range, not tied to any account). */
export function sandboxSid(home: string): string {
	const file = join(home, "sandbox_sid");
	if (existsSync(file)) return readFileSync(file, "utf8").trim();
	const part = () => Math.floor(Math.random() * 2 ** 31) + 1;
	const sid = `S-1-5-21-${part()}-${part()}-${part()}-1000`;
	mkdirSync(home, { recursive: true });
	writeFileSync(file, sid);
	return sid;
}

/** Let the sandbox SID write in `folders` (once per folder; the grant is inherited by what's inside). icacls can't
 * name a SID that isn't an account, so this goes through .NET's ACL API, changing access rules only. */
export function grantWrites(home: string, sid: string, folders: string[]): void {
	const record = join(home, "sandbox_grants.json");
	const done = new Set<string>(existsSync(record) ? (JSON.parse(readFileSync(record, "utf8")) as string[]) : []);
	const todo = folders.filter((f) => !done.has(f.toLowerCase()) && existsSync(f));
	if (!todo.length) return;
	const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
	const script = [
		`$sid = New-Object System.Security.Principal.SecurityIdentifier(${quote(sid)})`,
		"$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')",
		`foreach ($p in @(${todo.map(quote).join(",")})) { $d = Get-Item -LiteralPath $p; $acl = $d.GetAccessControl('Access'); $acl.AddAccessRule($rule); $d.SetAccessControl($acl) }`,
	].join("; ");
	const powershell = systemPowerShell(folders);
	if (!powershell) throw new Error("Couldn't find PowerShell in an OS installation folder, so sandbox write access was not changed.");
	const run = Bun.spawnSync([powershell.file, "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "ignore", stderr: "pipe" });
	if (run.exitCode !== 0) throw new Error(`Couldn't let the sandbox write in ${todo.join(", ")}: ${run.stderr.toString().trim().slice(0, 400)}`);
	for (const f of todo) done.add(f.toLowerCase());
	writeFileSync(record, JSON.stringify([...done]));
}

/** Run `argv` under the restricted token with this process's stdio; resolves to its exit code. */
export async function runContained(home: string, writable: string[], argv: string[]): Promise<number> {
	if (!argv[0] || !isAbsolute(argv[0])) throw new Error("Windows containment requires an absolute executable path.");
	let executable: string;
	try {
		executable = realpathSync.native(argv[0]);
		if (!statSync(executable).isFile()) throw new Error("not a file");
	} catch {
		throw new Error(`Windows containment could not open the executable ${argv[0]}.`);
	}
	argv = [executable, ...argv.slice(1)];
	const { dlopen, FFIType, ptr, read } = await import("bun:ffi");
	const { p, u32, i32 } = { p: FFIType.ptr, u32: FFIType.u32, i32: FFIType.i32 };
	const k32 = dlopen("kernel32.dll", {
		GetCurrentProcess: { args: [], returns: p },
		GetStdHandle: { args: [u32], returns: p },
		SetHandleInformation: { args: [p, u32, u32], returns: i32 },
		CreateJobObjectW: { args: [p, p], returns: p },
		SetInformationJobObject: { args: [p, i32, p, u32], returns: i32 },
		AssignProcessToJobObject: { args: [p, p], returns: i32 },
		ResumeThread: { args: [p], returns: u32 },
		WaitForSingleObject: { args: [p, u32], returns: u32 },
		GetExitCodeProcess: { args: [p, p], returns: i32 },
		CloseHandle: { args: [p], returns: i32 },
		GetLastError: { args: [], returns: u32 },
	}).symbols;
	const adv = dlopen("advapi32.dll", {
		OpenProcessToken: { args: [p, u32, p], returns: i32 },
		GetTokenInformation: { args: [p, i32, p, u32, p], returns: i32 },
		CreateRestrictedToken: { args: [p, u32, u32, p, u32, p, u32, p, p], returns: i32 },
		ConvertStringSidToSidW: { args: [p, p], returns: i32 },
		CreateProcessAsUserW: { args: [p, p, p, p, p, i32, u32, p, p, p, p], returns: i32 },
	}).symbols;
	const fail = (what: string): never => {
		throw new Error(`${what} failed (Windows error ${k32.GetLastError()}).`);
	};

	const sid = sandboxSid(home);
	grantWrites(home, sid, writable);

	// The restricted SIDs: Everyone, this logon session (consoles and the desktop need it), and the sandbox SID.
	const token = new BigUint64Array(1);
	if (!adv.OpenProcessToken(k32.GetCurrentProcess(), TOKEN_ALL_ACCESS, ptr(token))) fail("OpenProcessToken");
	const tokenHandle = Number(token[0]);
	const needed = new Uint32Array(1);
	adv.GetTokenInformation(tokenHandle, TOKEN_GROUPS, null, 0, ptr(needed));
	const groups = new Uint8Array(needed[0]!);
	if (!adv.GetTokenInformation(tokenHandle, TOKEN_GROUPS, ptr(groups), groups.length, ptr(needed))) fail("GetTokenInformation");
	const view = new DataView(groups.buffer);
	let logonSid = 0;
	for (let i = 0, count = view.getUint32(0, true); i < count; i++) {
		const at = 8 + i * 16;
		if ((view.getUint32(at + 8, true) & SE_GROUP_LOGON_ID) === SE_GROUP_LOGON_ID) logonSid = Number(view.getBigUint64(at, true));
	}
	const sidPointer = (text: string) => {
		const out = new BigUint64Array(1);
		if (!adv.ConvertStringSidToSidW(ptr(wide(text)), ptr(out))) fail(`ConvertStringSidToSid ${text}`);
		return out[0]!;
	};
	const restricted = [sidPointer("S-1-1-0"), sidPointer(sid), ...(logonSid ? [BigInt(logonSid)] : [])];
	const entries = new BigUint64Array(restricted.length * 2);
	restricted.forEach((s, i) => (entries[i * 2] = s));
	const newToken = new BigUint64Array(1);
	if (!adv.CreateRestrictedToken(tokenHandle, DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED, 0, null, 0, null, restricted.length, ptr(entries), ptr(newToken))) fail("CreateRestrictedToken");

	// A job that ends the command (and what it starts) when this helper ends.
	const job = k32.CreateJobObjectW(null, null);
	if (!job) fail("CreateJobObject");
	const limits = new Uint8Array(144);
	new DataView(limits.buffer).setUint32(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
	if (!k32.SetInformationJobObject(job, JOB_EXTENDED_LIMIT_INFORMATION, ptr(limits), limits.length)) fail("SetInformationJobObject");

	// This process's stdin, stdout and stderr, inherited by the command.
	const startup = new Uint8Array(104);
	const s = new DataView(startup.buffer);
	s.setUint32(0, startup.length, true);
	s.setUint32(60, STARTF_USESTDHANDLES, true);
	for (const [index, std] of [[0, -10], [1, -11], [2, -12]] as const) {
		const handle = k32.GetStdHandle(std >>> 0);
		if (handle) k32.SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
		s.setBigUint64(80 + index * 8, BigInt(Number(handle ?? 0)), true);
	}
	const info = new Uint8Array(24);
	const line = wide(commandLine(argv));
	const application = wide(executable);
	if (!adv.CreateProcessAsUserW(Number(newToken[0]), ptr(application), ptr(line), null, null, 1, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, null, null, ptr(startup), ptr(info))) {
		fail(`Starting ${argv[0]}`);
	}
	const process_ = Number(read.u64(ptr(info), 0));
	const thread = Number(read.u64(ptr(info), 8));
	if (!k32.AssignProcessToJobObject(job, process_)) fail("AssignProcessToJobObject");
	k32.ResumeThread(thread);
	k32.CloseHandle(thread);
	// Wait off the main thread's event loop in short steps, so a kill of this helper is noticed promptly.
	while (k32.WaitForSingleObject(process_, 200) === 0x102) await Bun.sleep(0);
	const code = new Uint32Array(1);
	k32.GetExitCodeProcess(process_, ptr(code));
	k32.CloseHandle(process_);
	return code[0]!;
}
