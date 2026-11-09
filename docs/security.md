# Security

## The local sandbox

"Local sandbox" is what the app calls the containment on this computer (This Mac ▸ About the Local Sandbox explains
it in the app). The agent's commands, app backends and package installs run inside it. It needs no administrator
setup.
- Writes stay inside the platform-specific paths listed below.
- The network is off unless a command is allowed to use it.
- Credential folders stay hidden, and keys and tokens are left out of its environment.

Packages go into each project's own environment (pixi, docs/apps.md), not the system. Step history
(docs/history.md) keeps every step, so changes in the project can be taken back. The table below has the details
for each operating system.

## What contains the agent

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Facility | Seatbelt (`sandbox-exec`) | bubblewrap, when user namespaces work | a write-restricted copy of the person's token |
| Writes | project and a private temp folder, except any `.git` component below the project root | project and a private temp folder; regular `.git` entries stay read only, `.git` links refuse launch, and new entries move to an engine-owned quarantine outside the project | project and temp folders |
| Credential folders (`~/.ssh`, `~/.aws`, key stores, browser profiles) | hidden | hidden | readable |
| Network | off unless allowed | off unless allowed | open |
| Commands inside the project | run | run | ask first |
| App backends | contained as above | contained as above; without bubblewrap they don't start | run as the person (the consent card says so) |

None of these need administrator rights. Where the facility isn't available (bubblewrap inside a container, a
locked-down Windows policy), commands run as the person and every one asks first.

Containment governs writes, the network and credential folders. It does not hide the rest of the disk: a contained
program the project holds can read files outside it that aren't hidden, and what it prints goes to the model. A
contained command gets the engine's environment without anything that looks like a key, token, password, DSN or
agent socket (`withoutSecrets` in `util.ts`), so `env` or `printenv` show nothing secret. Contained commands get a
private temp folder EnrichedLab makes under `/private/tmp` on macOS or `/tmp` on Linux; caller `TMPDIR` does not
widen the write grant. Package installers and app backends receive that same granted folder in `TMPDIR`, `TMP` and
`TEMP`. Engine Git has a different private scratch folder that contained agent commands cannot write. A command the
person approves to run uncontained gets the whole environment.

## What is trusted

Approvals and fences guard against untrusted project work, not against the person or the EnrichedLab engine.

- Untrusted: code running in a contained shell, app backends, container builds, the model's output, every file in a
  project (including `.git/config`, `.gitattributes`, `.pixi`, scripts and data), packages from others, and whatever
  a contained process leaves behind.
- Trusted: the person and the EnrichedLab engine. The person's environment as EnrichedLab starts in it (`PATH` and
  loader variables, global and system git settings, Homebrew's folders) is part of that trust. A lab's image and the
  environment its gate gives each command are trusted by that lab. This holds only while those paths lead to content
  the person or lab controls. A `PATH` entry, `include.path` or loader library inside a project hands that trust to
  untrusted project content, so do not configure one that way.
- What the person approves extends trust. An approved uncontained command or package install can change trusted
  places (Homebrew, global git settings, the package cache), and the result counts as the person's. EnrichedLab
  checks one of them itself: its own pixi, compared with the pinned SHA-256 before every use.
- `/tmp` and `/private/tmp` are shared scratch space, not trusted code. Contained commands write only their private
  command folder there. Engine Git scratch and Linux `.git` quarantine are separate private folders that contained
  commands cannot read or write. Nothing that matters should be loaded from a shared scratch path.

Containment is the boundary: nothing runs outside the OS sandbox or a lab's fence without a yes. The exceptions are
the person's own settings:

- commands listed exactly in `allowCommands` on macOS and Linux: bash must parse one simple command of literal
  words, then EnrichedLab resolves its program through `PATH` and starts that argv without a shell. Assignments,
  redirects, globs, expansions, control characters and Unicode spaces do not match. A program inside the project is
  refused. This path is off on Windows and for a lab command API that accepts shell text;
- `full` mode, which runs everything except pushes the line shows, lines that could push unseen, and lab tools the
  lab hasn't reviewed;
- Discovery mode, for what acts inside the lab it applies to;
- `auto` in a lab sandbox that checkpoints its whole disk, where commands run unfenced. A checkpoint brings the
  sandbox's disk back; it doesn't take back what left the sandbox or what other sessions did there meanwhile.

The engine's own work stays inside the same line:

- Its general git work on a project's repository (worktrees, turn snapshots, and sending a project to a lab) runs only
  under Seatbelt or
  bubblewrap, because the repository's settings and attributes are project content and can name programs (filter
  and diff drivers). It may write that repository and its named scratch folders, with hooks, fsmonitor and signing
  off, no network and
  an explicit minimal environment and fixed engine-only temp folder, and the repository's settings, hooks and info
  folder read only. The only caller Git variables it retains are `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` set
  exactly to `/dev/null`, to disable those settings. Other paths and Git or loader variables are not inherited. Where the
  repository's folders are is asked again on every call, and each is granted as the folder just checked (bound by
  handle on Linux). It widens past the folder only in layouts git makes itself (the folder's own `.git`, a
  repository above it whose `.git` sits in its top folder, or an EnrichedLab worktree inside `.git`), so a `.git`
  file or `core.worktree` pointing elsewhere grants nothing. Where this computer can't contain it (Windows, Linux
  without bubblewrap) it doesn't run, so turn snapshots, commits and worktrees are off there. On Linux its temporary
  indexes and bundle folders are bound into bubblewrap even though bubblewrap has a private `/tmp`. Credential and
  engine-data masks are mounted after every project-derived bind. A bind whose physical target is inside one of those
  hidden folders is refused, including a target reached through a link or a case alias. Its only fetch
  reads a bundle file
  over the file transport, a test pins the git subcommands it uses (none merges or prints file content), and its
  own folder work (making the worktrees folder and removing files on undo) never follows a link. The expected scratch
  path is checked without resolving it away first; agent commands have no write grant to that folder.
- Step history has its own bare git store, separate from the project's repository. It uses a trusted system git by
  absolute path with hooks, fsmonitor, filters and line conversion off, and an explicit minimal environment. Caller
  Git and loader variables are not inherited. Local file and empty-directory removal stays relative to held folder
  descriptors. In a lab, removal runs only under the fence; without the fence it leaves the path in place.
- Bringing work back from a lab (committing what's left, then bundling) runs only under the lab's fence, with
  hooks, fsmonitor and signing off. A lab where the fence doesn't hold refuses it.
- App backends (`bun`, `command`, `serve`) run contained or not at all. Their only grant inside the hidden
  `app-data` tree is the current app's own data folder, bound by its engine-owned path after the private-folder masks;
  sibling app data stays hidden. On Windows, where servers run as the person, the consent card says so before
  anything starts. A served backend needs a named network grant before it starts. Seatbelt limits that grant to
  loopback unless the manifest asks for network. Bubblewrap cannot provide loopback without sharing the host network,
  so the Linux card names that whole-network access.
- Package installs and listings run contained with the pinned pixi, checked against its SHA-256 before each use. A
  listing never downloads it and gets no network.
- File tools reject a `.git` component before and after following links on every platform. On macOS, Seatbelt denies
  contained shell commands a write to any path below the project root with a case-insensitive `.git` component, including a `.git` file and a
  repository made during the command. The rule is anchored at the project root, so a worktree stored below its
  repository's `.git` is still writable while its own `.git` pointer is not.
- On Linux, contained commands can write the project. Before launch, an anchored scan finds existing `.git`
  directories and pointer files, including case variants, and bubblewrap binds them read only. The scan refuses any
  `.git` symbolic link, including a dangling one, because bubblewrap cannot protect the link entry and its target as
  one object. A scan error or its 50,000-entry or 64-level limit refuses the command. The engine also prepares one
  hidden sibling quarantine outside the project, named from the project's device and inode and on the same
  filesystem. It makes the directory with mode 0700, then opens it without following any link and verifies from that
  descriptor that it is owned by the person, still mode 0700 and on the project's device. An unsafe existing path
  refuses the command.
  Contained commands cannot read the quarantine.

  Before starting the command, the engine records the project identity, quarantine path and the
  identities of existing `.git` entries in its own `run` folder. If that record cannot be written, the command does
  not start. When the foreground command exits, the engine makes a bounded cleanup pass without changing modes while
  background children may still run. After every child ends, the final anchored pass uses the same 50,000-entry and
  64-level bounds. It temporarily adds owner access to a directory the command made inaccessible, moves each new or
  replaced `.git` entry atomically into the held quarantine descriptor, then restores the directory's mode. It
  reports the original path and exact quarantine path in command output. Nothing is deleted or overwritten, and
  cleanup never follows a link. A lifecycle pipe keeps final cleanup attached to background children even when they
  redirect output; the command result waits for them to end. A successful final pass removes the cleanup record.

  A final scan or move error returns exit 125 and leaves the project and cleanup record in place. It does not move
  the project, leave its access bits changed or delete data to enforce the rule. Before any later contained command
  or local file-tool write in that project, the engine retries the anchored pass. An invalid record or another
  failure refuses that command or write before it creates anything. Reads remain available so the person's data is
  not hidden. Recovery also finds a pending record by folder identity after the project is renamed or reached through
  another physical path. An existing sibling quarantine must pass the same descriptor checks even when no cleanup
  record is found; file writes refuse an unsafe quarantine without waiting for a command to check it.

  There is a remaining window while a command runs: new metadata exists at its project path and Git in that command,
  or a simultaneous process outside containment, can use it. An engine crash or failed bounded pass can leave that
  metadata readable in the project until recovery succeeds. Later contained commands and file writes are refused,
  but an already-open directory handle or a process outside containment is not revoked. Quarantine does not undo work
  already done with the metadata. Landlock and bubblewrap grant access by existing paths or inodes, and seccomp
  cannot safely inspect pathname strings, so none can deny every future entry named `.git` inside an otherwise
  writable project. Lab file tools apply the same `.git` check as local file tools; the accepted lab write-mode
  metadata limit remains.
- Commits use `git_commit`, not shell `git commit`. The permission decision records the repository, worktree admin
  directory, branch and current commit. Execution checks them again. A recorded session worktree must still point
  back to its own admin directory and its admin `HEAD` must still name the recorded branch. A session without a
  worktree commits only the repository and branch named by the person's answer. Staging uses an isolated Git
  directory with the real metadata read only, so project filters, hooks, includes and other helpers do not run while
  shared metadata is writable. The engine installs the staged objects, atomically advances only the named branch
  from the checked old commit, and refreshes that worktree's index. A recorded worktree runs without asking; Allow
  Everything keeps its usual no-question behavior but still gets the same target checks.
- A read-only subagent's commands run contained with nothing in the project writable, or not at all. In a lab they
  run under the fence with no project rights, and a seccomp filter there refuses changes to modes, owners, times and
  extended attributes and ACL changes (on x86_64 and arm64; other machines don't run them). The filter also denies
  `io_uring_setup`, `io_uring_enter`, `io_uring_register` and `ioctl`, including regular-file flag changes. Temp
  folders stay writable. Their words
  decide nothing.

Reading a command's words still decides three things: which lines are pushes (they ask in every mode), what may
run unasked inside containment (paths inside the project), and what an answer covers. Inside containment a command
can still read most of the disk (credential folders aren't readable) and has no network, so it can't push whatever
its words say.

Accepted residuals, each with its reason:

- Pushes the line doesn't show. In `full` mode and for commands the person approves outside containment, only pushes
  the command line shows are caught (`git push`, `send-pack`, `http-push`, `svn dcommit`, `p4 submit`,
  `send-email`, including the supported quoting, wrapping and POSIX escape forms). On Windows, `iex`,
  `Invoke-Expression`, any spelling or abbreviation of `-EncodedCommand`, and direct `cmd /c`, `cmd /k`, `sh -c`,
  `bash -c`, `wsl`, `powershell` or `pwsh` invocations count as a push and ask every time. Those interpreter handoffs
  also count behind `env`, `start`, `Start-Process`, its `saps` alias, `timeout` and `xargs`, including native `.exe`
  forms. Other unsupported PowerShell syntax asks as a push when its raw text contains a publishing word and as
  hidden otherwise. A script or program that pushes on its own isn't. "Pushes ask"
  means pushes the line shows.
- The lab fence by Landlock ABI. ABI 3 covers file contents, names, existence and truncation; refusing TCP needs ABI
  4, device ioctls ABI 5, and signals and abstract sockets to processes outside the fence ABI 6. Below those, a fenced
  command reaches the rest of the sandbox (one person's, with no network) that way. UDP is left to the lab's
  no-network rule, and pathname sockets inside the sandbox aren't fenced, so a fenced command can talk to a server
  another session started there.
- Metadata and running programs. Landlock doesn't restrict modes, owners, times, extended attributes or ACLs, so a
  fenced command that may write its project can change those on other projects' files in the same sandbox (files
  the sandbox user owns). A filter can't tell which file a mode change is for, and ordinary work needs one in its
  own project (`chmod +x`), so this stays for writing commands; read-only subagents' commands get the direct syscall
  and io_uring filter. That
  can change who may read them and their recorded times, and a project's checkpoints don't undo it. Running programs
  isn't restricted either; that is needed, and whatever they start inherits the fence.
- Hard links and mounts. A file in the project is in the project, whatever other names it has: a hard link that
  already exists (made by the person, or by a command they approved outside containment) lets a contained command
  change that file through it. Contained commands can't make new hard links to files outside (Seatbelt, Landlock and
  bubblewrap each refuse it, and the fence's probe checks that), and EnrichedLab's own file writes refuse a file
  with a second name. A folder mounted inside the project (an automount, a bind mount the person or the lab set up)
  counts as part of the project for commands and file operations alike; the Linux walk crosses mount points.
- Races with an uncontained process. A second process running outside containment at the same moment (an approved
  background command) isn't defended against. File operations refuse links and hard links, not a real folder
  renamed into place. Engine git grants exact folders by a held handle on Linux or by real path on macOS. Local
  step-history removal and empty-folder cleanup use held descriptors. Lab removal runs only under the fence, so a
  contained process cannot redirect either path.
- Windows. File operations there follow links and junctions, and any user can make a junction (`mklink /J`).
  Commands on Windows aren't fully contained and ask first, so a junction in a project comes from the person or a
  command they approved, and a write through one lands where it leads.

## How much it asks

Each session asks in one of three modes, set for new sessions in Settings and for one session from the shield menu
beside its model (`permissions.mode` in config.json, `session.permissions` over RPC):

| Mode | Runs without asking | Asks |
| --- | --- | --- |
| Ask Before Changes (`ask`) | reads in the project, contained commands that stay in it | file changes, other commands, new hosts |
| Ask When It Can't Be Undone (`auto`, the default) | also file changes in a folder the person let it change | commands outside the containment, new hosts, changes outside the folder, signed-in browser actions, memory and skills |
| Allow Everything (`full`) | everything | pushes, lines that could push unseen, and unreviewed lab tools |

`auto` rests on history: what runs without asking is what the session's history can take back
([history.md](history.md)), so when a folder's history can't be kept (its store fails), the session asks as `ask`
does. The first time a
session starts in a folder, the window asks once whether EnrichedLab may change files there or only read them
(`folder.access`, kept in config.json under `folders`; Settings lists them). Listing the folder at that moment brings up
any macOS privacy prompt then, not mid-task. A question about a change in a folder nobody answered for offers "Allow
Changes in this folder", which saves the same answer.

A command that would run outside containment (the sandbox off for this folder, or `unsandboxed`) asks even when it
only reads, unless its exact text is in `allowCommands` and parses as one literal argv. EnrichedLab compares the
exact string, without trimming it, resolves the program through `PATH` to an absolute path outside the project, and
starts it without a shell. It uses the person's launch `PATH` and environment, not the project's activated package
environment. `allowCommands` is off on Windows and does not apply to lab command APIs that take shell text.
"Allow for this session" covers what the button names and nothing wider, and is kept in the session log (an `allow`
event), so it outlasts a restart. A command is remembered per program it runs (`touch`, `rm`, `git commit`), so
`python3 a.py | grep x` and `python3 b.py | grep y` share an answer. On macOS and Linux, lines are read with
mvdan/sh's bash parser (compiled to WebAssembly, through `sh-syntax`), which gives each command the words it receives
once quotes and escapes are done (`$'\x67it'` is `git`, `$'git\0x'` is `git`, a quote after `#` is a comment). A
word is text only when nothing expands or substitutes in it: no variable, substitution, brace list or `~user`
(`tools/shell_syntax.ts`). On Windows, the publishing gate reads a constrained set of literal PowerShell
native-command words, where a backslash in `C:\Tools\Git\git.exe` stays a backslash. Variables and expression
syntax outside that literal subset, splatting, script blocks, block comments, backtick escapes and the stop-parsing
token fail closed and ask in every mode. The Windows interpreter handoffs and executor wrappers listed above count
as pushes before this parsing. Bracket expressions are outside that Windows subset. A supported glob word (`*` or
`?`, plus `[..]` on POSIX shells) is judged by the names it matches: on
this computer they are listed at decision time and each must be inside the project, links
followed; in a fenced lab sandbox each
is checked just before the command runs. A glob part that starts with a dot (`.?`, `.*`) could reach `..`, so it
asks. On macOS and Linux commands run in the system's `/bin/bash`, whatever `$SHELL` says, without `BASH_ENV`, `ENV`,
`ZDOTDIR`, shell options, trace or prompt hooks, `CDPATH` or functions passed in, so what runs is the line that was
read. Windows runs PowerShell without a profile, by an absolute path under `%ProgramFiles%\PowerShell\7` or
`%SystemRoot%\System32\WindowsPowerShell\v1.0`, never from `PATH` or from inside the project. git counts
as read-only only when the repository's own settings make no read command run a program (`core.fsmonitor`, diff
and filter drivers, signature checks); the person's global settings are their own. A version check
(`--version`, `-V`) counts only for a program found on PATH. A program named by its full path is remembered by that
path. A line is remembered exactly when its words
don't show everything it runs: substitutions, process
substitution, here-documents, subshells, groups and functions, control flow, a program named by a variable or a
relative path, options before a subcommand (`git -C dir reset`), output written to a file, a program that runs
what follows it (`sudo`, `ssh`, `env`, `timeout`, `xargs`, `eval`, `source`), or a variable set in front that could
change which program runs or what it loads. That is judged broadly: a toolchain's own prefix (`PHP*`, `PYTHON*`,
`GIT_*`, `LD_*`, `DYLD_*`, `NODE*`), or any part of the name that says path, folder, library, config, startup or
command (`PATH`, `DIR`, `LIB`, `INI`, `RC`, `CONFIG`, `OPTS`, `PRELOAD`, `CMD`). Data variables in front
(`SEED=42 python3 run.py`) share the program's answer. A push the line shows asks every time through the supported
quoting, POSIX escapes and globs (`git 'push'`, `$'\x67it' $'\x70ush'`, `/usr/bin/g[i]t p[u]sh`,
`env ./g[[:lower:]]t push`, a continued line), anywhere in the line,
including code handed to `eval` or a shell (directly or through `env`, `env -S`, `timeout`, `nice`, `xargs` and the
like), a word that is itself a command line (a pager, an editor, `--compress-program`) and here-documents, and so does a line where git or push sits beside a function, alias or sourced file. A line that
could push unseen asks every time too, in every mode, and its answer is never remembered (a file or variable it
reads can change without the line changing): a program named by expansion or a glob (`$C a`, `$(cat cmd.txt)`),
a wrapper given an expanded word (`command "$CMD" push`, `xargs "$P"`), git settings handed to `env`,
git given an expanded word, a word after git that isn't one of git's own commands (an alias, from settings a file
edit can change), a git setting that runs a program (`-c alias.*`, `-c core.sshCommand=...`, `GIT_*` set in front or
exported), code for `eval` or a shell that expands or arrives on its input (`curl x | env bash`), or a line that
doesn't parse. If unreadable PowerShell still contains a publishing word, it is
classified as a push; otherwise it is hidden. A lab's own command tools pass the same publishing check. File edits
share one answer; each other kind of change (a
click or typing in the browser, a new app, a memory or skill, a filled PDF, a sandbox download) has its own, and asks
in every mode until allowed. Session answers hold where they were given: a move to a lab or back, or a "Try Again"
session, starts them over. Folder answers apply to what a change lands on, by the folder's real path (symlinks
followed one part at a time, so `link/..` is where the system takes it; a backslash is part of a name except on
Windows; and the disk's own letter case), so a read-only folder inside one that may change stays read only. An
answer to allow changes is saved with the folder's identity on disk. If a part of its path later becomes a link, or
another folder takes its place, the answer no longer applies there and the question comes back; answers saved
before identities (0.2.30) ask once more. Every call is decided again just before it runs, and a file write lands
on the real path it was judged for: its folders are made and the file opened without following a link anywhere on
the way (`tools/anchored.ts`: `O_NOFOLLOW_ANY` on macOS, a folder-by-folder `openat` walk on Linux), so a folder
swapped for a link after the check makes the write fail instead of landing elsewhere. A path holding a NUL is
refused, and a file with a second name (a hard link) isn't written unless its outside path was approved.
Without step history (its store failed), a contained command that changes things asks too. A session
keeps the mode it started with; a subagent asks as much as the session that started it. A session's own worktree
runs file edits, and its commits use `git_commit`. In a lab's sandbox, commands and file
edits inside the project run without asking: the sandbox is a separate machine with no network, and its work comes
home as a branch the person merges. There the fence is Linux Landlock, ABI 3 or later (`sites/sandbox_fence.ts`):
the image's own `/usr/bin/python3` or `/usr/local/bin/python3` (root-owned, in a root-owned folder, writable by no one
else; started without loader variables) fences the command, then starts it with `/bin/bash` and the shell startup
variables removed. It and everything it runs can write, truncate, make, rename,
link or remove files only in the project (anchored to the folder the command starts in, which must be the folder
named, so a renamed or swapped project is refused), in a temp folder made for that command (`TMPDIR`, removed
after), and on `/dev/null`, `/dev/zero`, `/dev/full` and `/dev/tty`, whatever a script or interpreter does. Where the
kernel has them (ABI 4 and 6), TCP connections and binds, signals to processes outside the fence and abstract
sockets are refused too, and from ABI 5 device ioctls outside those four devices. Reading isn't fenced, and file
modes, owners and times aren't covered (see "What is trusted"). Before the first decision the sandbox is
probed once with a fresh code: a child fences itself and must fail to truncate, write, create, remove, rename into
or link in a folder outside, and only a line carrying that code counts. A sandbox where that fails (an older
kernel, no root-owned `python3`) runs no command unasked. A fenced command runs on the same terms as a contained one
on this computer: it names no path outside the project, and every named path (every name a glob matches, expanded
there) must also lead inside once links are followed (`realpath -m`). Read-only commands run under the fence too.
File edits in the sandbox run under it as well, after a check of where their folder leads, and replace a link at
the end instead of following it; where the fence doesn't hold, each file edit asks. `full` and Discovery mode don't fence (the person let the session act outside the
project), and in `auto` a sandbox whose whole disk is checkpointed runs changes unfenced, because the disk can be
put back. A lab's own command tools (`<lab>_sandbox_run`, `<lab>_sandbox_job_start`) run
outside any project and outside the fence. Their API accepts shell text, so `allowCommands` does not apply. They ask
unless Allow Everything, Discovery mode or a working whole-sandbox checkpoint permits them.
Commands that change lab data outside the project ask, unless the lab checkpoints the whole sandbox disk
(`endpoints.checkpoints`) and the session is in `auto`. An answer about a path
outside the project covers that path. Pushes and unreviewed lab tools ask every time, in every mode.

A lab sandbox is one Linux container per person at that lab, and the sessions moved there share it: a command in one
project can read the others'. Keep work that must stay apart in different labs or sandboxes (`el sandbox create`). Hiding reads and blocking the
network on Windows needs a one-time administrator setup (a sandbox account and firewall rules); a lab sandbox is the
place for that kind of work.

App backends and served apps run under the same facility, and app pages run in an opaque origin with their own
content security policy (docs/apps.md). The page reaches only the origins the app names. A program behind it that
asked for network reaches all of it. A served backend asks for its listening network before it starts; on Linux the
card explains that bubblewrap must share the whole host network. A container build also names network access in the
card. The build command uses `--network none` without that grant. A networkless container run uses `--pull=never`, so
a missing image cannot trigger an unapproved pull. Building an app's pixi environment runs contained: pixi may write
the app's folder and its own cache under `~/.el/tools`, never the person's shared package caches, and gets no keys.
The card lists every package (conda, PyPI, other channels and indexes, and anything built from source), and a grant
covers that exact `pixi.toml`: a change asks again. An app package is checked against its size limits before it is
unpacked. Lab sandboxes are isolated by the lab.

The engine listens on loopback only, checks `Host` and `Origin`, and authenticates every surface (docs/architecture.md).
`el app` hands a browser its one-time pairing address through an owner-only page in `~/.el/run`, never on a command
line, where other people on a shared computer could read it.

Moving a session to a lab sends its git repository without secret-looking files. When any commit in its history
holds one (`.env`, keys, credentials, even a since-deleted one), only the current files go, as one commit, because a
bundle carries every object its history reaches. Work comes back as a branch on the person's own history either way,
with the secret-looking files they track kept.

An imported session log (`el session import`) is held to the shared log's limits and brings only conversation:
records about the computer that wrote it (undo checkpoints, where it worked, local snapshots) are dropped.
Keys for model services go to the OS credential store; lab tokens are owner-only files, short-lived, and bound to
the lab that issued them. At a lab that asks for it, every request also carries a DPoP proof signed by a per-lab device
key whose private half stays in the OS credential store, so a copied token is useless elsewhere ([labs.md](labs.md)).

A sandbox port opened on this computer (`<lab>_sandbox_open_port`) is a loopback proxy that adds the person's lab
sign-in to what it forwards. It answers only its own page: the Host must be its loopback address, a browser Origin its
own origin, and each request carries a per-port cookie (HttpOnly, SameSite=Strict) set from a one-time token in the
first address. Other sites in the browser and other programs get 403. The lab serves app pages with
`Content-Security-Policy: sandbox` so they never act with the lab's origin; the proxy drops that one directive, since
each port has a loopback origin of its own that reaches nothing but that port. The app then keeps its cookies,
storage, requests and WebSockets to its own server (Shiny needs the WebSocket). Opening one of these addresses in the
browser pane doesn't ask; other local addresses do.

A served app (`<lab>_sandbox_open_port` with a command) runs as the person in their sandbox. Its server stops after
15 minutes with no requests and no open WebSockets, and starts again on the next visit. When the engine quits, the
person's lab sandbox is stopped, not deleted, where the lab can stop one: its files stay for the next start, and it
uses only storage meanwhile. `el sandbox delete` removes it.

A lab sandbox's browser has none of the person's sign-ins: the engine never copies cookies into it, each session gets
its own browser context (disposed when the session or the connection ends), and it reaches only what the lab's network
policy allows. The engine connects to it through the lab's port path with the person's sign-in; the lab sends that hop
to Chrome on loopback with no Origin header. Files it downloads stay in the sandbox and leave only through the lab's
scanned file API, checked against `Repr-Digest`. A confirm or prompt on a page is cancelled, never accepted for the
person.

ChatGPT sign-in tokens stay in the engine (`~/.el/credentials/chatgpt.json`, owner-only, refreshed before they expire,
revoked at OpenAI on sign-out); windows and the terminal see only the account's email.

## Updates

Each release publishes `manifest.json` (version, notes, and every file's size and SHA-256) and an Ed25519 signature
over it. The public key is built into the binary, so a file that doesn't match what the release key signed is never
installed, wherever it was downloaded from. The private key stays on the release machine.

The first install is the exception. `install.sh` comes from the latest GitHub release and checks the binary against
that release's `SHA256SUMS`, so its trust rests on the release itself (the GitHub account that publishes it); it can't
check the manifest signature before `el` exists. The macOS app and package carry Apple's notarization as a second,
independent check. Every update after that is verified against the release key.

`el update` and the app's update button replace whatever this copy was installed as, without administrator
rights: the macOS package into `~/Applications`, the Windows setup into `%LOCALAPPDATA%\Programs`, the AppImage in
place, or the plain binary. The engine checks once a day. A release marked as a security fix installs as the app
quits, without waiting for anyone to click.

## Supply chain

- `bun scripts/deps.ts audit` checks every locked package (the workspace's `bun.lock` and the desktop's npm lock)
  against OSV and fails on any advisory that isn't triaged. Triage lives in `config/audit_accepted.json`: the
  advisory, the packages, why it doesn't reach people, and a review date after which it fails again.
- Each build writes a CycloneDX SBOM (`sbom.cdx.json`, also attached to every release).
- Dependencies are pinned exactly and taken at least two weeks after their release unless a security fix needs them
  sooner. Tools fetched at run time are pinned by hash (pixi, in `apps/environments.ts`).
- The macOS app and package are signed with a Developer ID and notarized. The Windows setup needs a code-signing
  certificate before Windows SmartScreen stops warning about it.

## AI risk management

How EnrichedLab maps to the NIST AI Risk Management Framework (AI RMF 1.0) and its Generative AI Profile (NIST AI
600-1). A lab carries its own system controls; these are the client's.

- **Govern.** Labs decide access by role (docs/labs.md). A lab that keeps data inside pins its sessions to its
  sandbox and models and removes web, personal MCP and download tools. Risk: an agent or an app acts beyond what the
  person meant. Controls: pushes the command line shows ask in every mode, commands outside containment ask, an app's permissions are
  shown and granted before its page loads, and messages from apps are marked as the app's, not the person's.
- **Map.** Each session records where it works, which model answered, every tool call with its arguments and
  result, permission decisions, and what apps told the model (`~/.el/sessions/<id>/log.jsonl`).
- **Measure.** `bun scripts/bench.ts` runs fixed tasks end to end and records pass rate, steps and time per model
  and version. The audit measures known vulnerabilities in what ships.
- **Manage.** Containment (above), undo for file edits and shell changes in a git repository, worktrees that keep
  agent work off the person's checkout, secrets redacted from logs and refused in notes and skills.

Open: input and output classifiers on the client (the lab runs its own; the client will call `POST /v1/guard` for
lab sessions), app calls in the session log, and encrypted session logs for labs that keep data inside.
