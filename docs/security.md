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

## How much it asks

Each session asks in one of three modes, set for new sessions in Settings and for one session from the shield menu
beside its model (`permissions.mode` in config.json, `session.permissions` over RPC):

| Mode | Runs without asking | Asks |
| --- | --- | --- |
| Ask Before Changes (`ask`) | reads in the project, contained commands that stay in it | file changes, other commands, new hosts |
| Ask When It Can't Be Undone (`auto`, the default) | also file changes in a folder the person let it change | commands outside the containment, new hosts, changes outside the folder, signed-in browser actions, memory and skills |
| Allow Everything (`full`) | everything | pushes and unreviewed lab tools |

`auto` rests on history: what runs without asking is what the session's history can take back
([history.md](history.md)), so when a folder's history can't be kept (its store fails), the session asks as `ask`
does. The first time a
session starts in a folder, the window asks once whether EnrichedLab may change files there or only read them
(`folder.access`, kept in config.json under `folders`; Settings lists them). Listing the folder at that moment brings up
any macOS privacy prompt then, not mid-task. A question about a change in a folder nobody answered for offers "Allow
Changes in this folder", which saves the same answer.

"Allow for this session" covers what the button names and nothing wider, and is kept in the session log (an `allow`
event), so it outlasts a restart. A command is remembered per program it runs (`touch`, `rm`, `git commit`), so
`python3 a.py | grep x` and `python3 b.py | grep y` share an answer. A program named by its full path is remembered
by that path. A line is remembered exactly when its words don't show everything it runs: substitutions, process
substitution, here-documents, subshells, groups and functions, control flow, a program named by a variable or a
relative path, options before a subcommand (`git -C dir reset`), output written to a file, a program that runs
what follows it (`sudo`, `ssh`, `env`, `timeout`, `xargs`), or a variable set in front that changes which program
runs or what it loads (`PATH`, `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `PYTHON*`, `GIT_*`, `CC`, names ending in `PATH`,
`OPTS`, `FLAGS` or `LIBS`, and the like). Other variables in front (`SEED=42 python3 run.py`) pass data and share the
program's answer. File edits share one answer; each other kind of change (a
click or typing in the browser, a new app, a memory or skill, a filled PDF, a sandbox download) has its own, and asks
in every mode until allowed. Session answers hold where they were given: a move to a lab or back, or a "Try Again"
session, starts them over. Folder answers apply to what a change lands on, by the folder's real path (symlinks
followed one part at a time, so `link/..` is where the system takes it, and the disk's own letter case), so a
read-only folder inside one that may change stays read only. An answer to allow changes is saved with the folder's
identity on disk; if a part of its path later becomes a link, or another folder takes its place, the answer no
longer applies there and the question comes back. A session
keeps the mode it started with; a subagent asks as much as the session that started it. A session's own worktree
runs file edits. In a lab's sandbox, commands and file
edits inside the project run without asking: the sandbox is a separate machine with no network, and its work comes
home as a branch the person merges. There the paths a command names are the fence, so a command whose paths aren't
in its words asks: code handed to an interpreter (`sh -c`, `python3 -c`, `Rscript -e`), an awk program, arguments
read from input (`xargs`, `parallel`), or a quoted word holding a script or a list. A program or script file the
agent wrote still runs; it can reach the sandbox's other projects, which the project's history doesn't cover.
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
