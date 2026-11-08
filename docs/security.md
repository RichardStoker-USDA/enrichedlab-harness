# Security

## The local sandbox

"Local sandbox" is what the app calls the containment on this computer (This Mac ▸ About the Local Sandbox explains
it in the app). The agent's commands, app backends and package installs run inside it. It needs no administrator
setup.
- Writes go to the project and temporary folders only.
- The network is off unless a command is allowed to use it.
- Credential folders stay hidden, and keys and tokens are left out of its environment.

Packages go into each project's own environment (pixi, docs/apps.md), not the system. Step history
(docs/history.md) keeps every step, so changes in the project can be taken back. The table below has the details
for each operating system.

## What contains the agent

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Facility | Seatbelt (`sandbox-exec`) | bubblewrap, when user namespaces work | a write-restricted copy of the person's token |
| Writes | project and temp folders | project and temp folders | project and temp folders |
| Credential folders (`~/.ssh`, `~/.aws`, key stores, browser profiles) | hidden | hidden | readable |
| Network | off unless allowed | off unless allowed | open |
| Commands inside the project | run | run | ask first |
| App backends | contained as above | contained as above | run as the person (the consent card says so) |

None of these need administrator rights. Where the facility isn't available (bubblewrap inside a container, a
locked-down Windows policy), commands run as the person and every one asks first.

Containment governs writes, the network and credential folders. It does not hide the rest of the disk: a contained
program the project holds can read files outside it that aren't hidden, and what it prints goes to the model. A
contained command gets the engine's environment without anything that looks like a key, token, password, DSN or
agent socket (`withoutSecrets` in `util.ts`), so `env` or `printenv` show nothing secret. A command the person
approves to run uncontained gets the whole environment.

## What is trusted

Approvals and fences guard against what the agent does and what a project holds, not against the person's own
computer. Untrusted: the model's output, every file in a project (its `.git/config`, `.pixi`, scripts and data),
packages and run packages from others, and anything a command started by the agent leaves behind. Trusted: the
person's own environment as EnrichedLab starts in it (`PATH`, loader variables, `TMPDIR`, global and system git
settings, Homebrew's folders), and a lab's image and the environment its gate gives each command. Whoever can change
those already runs code as the person, so a defense against them would only move the problem.

Safety comes from containment, not from reading commands: nothing runs outside the OS sandbox (or a lab's fence)
without a yes, except what the person listed in `allowCommands`. The engine's own git work on a project's repository
(worktrees, snapshots, sending a project to a lab) runs contained too, because the repository's settings and
attributes are project content and can name programs (filter and diff drivers): it may write that repository and
the temp folders, with hooks and fsmonitor off and no network. What it may write widens past the folder only in
layouts git makes itself (the folder's own `.git`, a repository above it whose `.git` sits in its top folder, or an
EnrichedLab worktree inside `.git`), so a `.git` file or `core.worktree` pointing elsewhere grants nothing. Where
this computer has no facility, the engine's git turns every configured filter driver off instead. Reading a command's words decides only what may
run unasked inside containment and what an answer covers. Inside containment a command can still read most of the
disk (credential folders aren't readable) and has no network, so it can't push, whatever its words say.

Accepted residuals, each with its reason:

- In `full` mode, for commands run outside containment and for programs and scripts generally, only pushes the line
  shows are caught. A script or program that pushes on its own can't be seen from its words; `full` means the person
  allowed that.
- In a lab sandbox, Landlock covers file contents, names and existence, not modes, owners or times, and doesn't
  restrict running programs. A fenced command could `chmod` another project's files in the same person's sandbox,
  which loses no data and can be undone. UDP and pathname sockets are left to the lab's no-network rule.
- `full`, Discovery mode, and `auto` in a lab that checkpoints its whole disk run commands without the fence.
- Races that need a second process running outside containment at the same moment (an approved background
  command) aren't defended; file operations refuse links and hard links, not a real folder renamed into place.
- Windows file operations aren't anchored the same way (its links need privileges to make).

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
only reads, unless the person listed it in `allowCommands` (no globs, chaining or expansion in it).
"Allow for this session" covers what the button names and nothing wider, and is kept in the session log (an `allow`
event), so it outlasts a restart. A command is remembered per program it runs (`touch`, `rm`, `git commit`), so
`python3 a.py | grep x` and `python3 b.py | grep y` share an answer. Lines are read the way the shell reads them:
mvdan/sh's bash parser (compiled to WebAssembly, through `sh-syntax`) gives each command the words it receives
once quotes and escapes are done (`$'\x67it'` is `git`, `$'git\0x'` is `git`, a quote after `#` is a comment), and a
word is text only when nothing expands or substitutes in it: no variable, substitution, brace list or `~user`
(`tools/shell_syntax.ts`). A glob word (`*`, `?`, `[..]`) is judged by the names it matches: on this computer
they are listed at decision time and each must be inside the project, links followed; in a fenced lab sandbox each
is checked just before the command runs. A glob part that starts with a dot (`.?`, `.*`) could reach `..`, so it
asks. Commands run in the system's `/bin/bash`, whatever `$SHELL` says, without `BASH_ENV`, `ENV`, `ZDOTDIR`, shell
options, trace or prompt hooks, `CDPATH` or functions passed in, so what runs is the line that was read. git counts
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
(`SEED=42 python3 run.py`) share the program's answer. A push asks every time, however it's quoted, encoded or
globbed (`git 'push'`, `$'\x67it' $'\x70ush'`, `/usr/bin/g[i]t p[u]sh`, a continued line), anywhere in the line,
including code handed to `eval` or a shell (directly or through `env`, `env -S`, `timeout`, `nice`, `xargs` and the
like), a word that is itself a command line (a pager, an editor, `--compress-program`) and here-documents, and so does a line where git or push sits beside a function, alias or sourced file. A line that
could push unseen asks every time too, in every mode, and its answer is never remembered (a file or variable it
reads can change without the line changing): a program named by expansion or a glob (`$C a`, `$(cat cmd.txt)`),
a wrapper given an expanded word (`command "$CMD" push`, `xargs "$P"`), git settings handed to `env`,
git given an expanded word, a word after git that isn't one of git's own commands (an alias, from settings a file
edit can change), a git setting that runs a program (`-c alias.*`, `-c core.sshCommand=...`, `GIT_*` set in front or
exported), code for `eval` or a shell that expands or arrives on its input (`curl x | env bash`), or a line that
doesn't parse. A lab's own command tools pass the same check. File edits share one answer; each other kind of change (a
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
runs file edits. In a lab's sandbox, commands and file
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
outside any project: read-only commands run (a version check only for a program found on PATH, never one the
project holds), and the rest ask, remembered per program apart from this computer's answers.
Commands that change lab data outside the project ask, unless the lab checkpoints the whole sandbox disk
(`endpoints.checkpoints`) and the session is in `auto`. An answer about a path
outside the project covers that path. Pushes and unreviewed lab tools ask every time, in every mode.

A lab sandbox is one Linux container per person at that lab, and the sessions moved there share it: a command in one
project can read the others'. Keep work that must stay apart in different labs or sandboxes (`el sandbox create`). Hiding reads and blocking the
network on Windows needs a one-time administrator setup (a sandbox account and firewall rules); a lab sandbox is the
place for that kind of work.

App backends and served apps run under the same facility, and app pages run in an opaque origin with their own
content security policy (docs/apps.md). The page reaches only the origins the app names; a program behind it that
asked for any network reaches all of it, and the consent card says so. Building an app's environment runs contained
too: pixi may write the app's folder and its own cache under `~/.el/tools`, never the person's shared package caches,
and gets no keys. The card lists every package (conda, PyPI, other channels and indexes, and anything built from
source), and a grant covers that exact `pixi.toml`: a change asks again. An app package is checked against its size
limits before it is unpacked. Lab sandboxes are isolated by
the lab.

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
  person meant. Controls: pushes always ask, commits outside the session's worktree ask, an app's permissions are
  shown and granted before its page loads, and messages from apps are marked as the app's, not the person's.
- **Map.** Each session records where it works, which model answered, every tool call with its arguments and
  result, permission decisions, and what apps told the model (`~/.el/sessions/<id>/log.jsonl`).
- **Measure.** `bun scripts/bench.ts` runs fixed tasks end to end and records pass rate, steps and time per model
  and version. The audit measures known vulnerabilities in what ships.
- **Manage.** Containment (above), undo for file edits and shell changes in a git repository, worktrees that keep
  agent work off the person's checkout, secrets redacted from logs and refused in notes and skills.

Open: input and output classifiers on the client (the lab runs its own; the client will call `POST /v1/guard` for
lab sessions), app calls in the session log, and encrypted session logs for labs that keep data inside.
