# Research at a lab

How scientists do long research with agents through EnrichedLab: in a lab's sandboxes, with the lab's tools, papers,
databases and object data, every step traced, and work that keeps going at the lab while their computer is off. This
is the plan and its state; the wire shapes are in [labs.md](labs.md) and [contract/](../contract/).

## Two labs, one contract

| Lab | Role | Serves the contract through | State (November 6, 2026) |
|---|---|---|---|
| Home Lab | the development lab: every addition is built and broken here first | Gate | the contract through `2026-11`, 36 of 38 `el lab check` rows pass (2 skipped by design); desktop sandboxes live since publication 67 |
| WHNRC EnrichedLab | the production lab: scientists, research data, reviewed tools | the WHNRC research broker, as a versioned adapter | not started: the broker has its own API on the lab's research host; the adapter waits for Rich's go-ahead and an owner |

Each lab names itself in its descriptor (`title`). Nothing in EnrichedLab names a lab: a person sees a lab only after
joining it from its invite and signing in, and a lab never learns which other labs a person uses. A lab that holds
research data says `policy.keep_data_inside`, and EnrichedLab then isolates it: its sessions use its models and tools
only, other labs' tools and models never appear in them, and its files don't leave for another lab. The setting
sticks once a lab has said it, so a lab that can't be reached stays isolated.

More labs join the same way. A lab is anything that serves the contract; a new kind of server is one `SiteAdapter`.

## Where an agent runs

| Place | The loop runs | Models | Tools act in | Fits |
|---|---|---|---|---|
| This computer | on the person's computer | any: their own keys, local models, a lab's models | their project, contained (Seatbelt, bubblewrap, Windows) | the person's own agents and data |
| A lab sandbox, from this computer | on the person's computer | the lab's | the lab's sandbox and tools | interactive work on lab data |
| A run at the lab | on the lab's servers | the lab's | the lab's sandbox and tools | long research, Discovery mode, work that continues while the computer is off |

A run at the lab is the same session in the same session log: the window shows it like any other session, a person
can watch it, answer it and stop it, and when it ends its log comes home. What changes is who holds the loop. The lab
offers runs at `/v1/runs` ([labs.md](labs.md)); Home Lab maps them onto its session store (Rein) and scheduled tasks,
WHNRC onto the broker's research runs and campaigns, which already keep task, state, provenance, reasoning, workspace
and artifacts after the sandbox is released.

## Whose agents use a lab's sandboxes

A lab can't verify what program sits on a person's computer, so it decides by what it runs and what it hands out:

- **Runs at the lab** use the lab's models and the lab's loop. No outside agent is involved.
- **Sessions from this computer** that work in a lab's sandbox use that lab's models. EnrichedLab enforces this for
  isolated labs and for labs whose policy says `sandbox_agents: "lab"`.
- **The lab's own check** for those sessions is a signed tool call: the lab's model gateway signs each tool call its
  model writes, and the sandbox runs a command only with a signature for it. Until a lab serves that, it limits
  sandboxes from outside the lab to the people it trusts with them (`/v1/me` `sandbox_agents`).
- **A person's own agents** (their ChatGPT or Claude subscription, a local model) work on their own computer and in
  local sandboxes as before. A lab may grant chosen people `sandbox_agents: "any"`, for example to let a signed-in
  person's own coding agent use a sandbox, and its audit names the client and model of every call.

Data tools stay per person whatever the agent: the lab checks every MCP call against the person's grants and passes
their scope to the database.

## Discovery mode

For a scientist the lab trusts with it, an agent works without asking: long research that runs for days, at the lab,
whether or not the person's computer is on. The name follows WHNRC's existing grant (`research.discovery.autonomous`)
and says what it is for. It never says "dangerous": the work stays in a sandbox, with the lab's models, filters and
checks.

- **Who.** Only a person whose `/v1/me` lists the `discovery` capability for that lab. The lab grants it per person,
  with an owner and a review date.
- **How it's turned on.** By typing `/discover` in a session at that lab, or `el discover <session>`. It isn't in
  menus or help; a person without the grant is told the lab hasn't given it to them.
- **What it changes.** Commands, file changes and lab tool calls inside that lab's sandbox and tools run without
  asking. Anything on this computer still asks. Tools a lab marks unreviewed still ask. The lab's model filters,
  injection checks, audit and refusals all stay on, and the lab checks the grant again for anything it runs
  unattended.
- **Where it runs.** Where the lab offers runs, the session moves to a run at the lab, so closing the laptop doesn't
  stop it. The person comes back, signs in again if their sign-in lapsed (Cloudflare Access with the institution's
  MFA), and sees the run where they left it: its progress, results, and anything it is waiting on.
- **How it shows.** A quiet "Discovery" label in the session's title bar, and one line in the transcript where it
  started and stopped. `/discover off` returns to asking.

## Long runs and what is kept

A run doesn't need a running sandbox between steps. The lab stops a sandbox once it goes unused and keeps its files,
and the next step wakes it (EnrichedLab already pauses a lab sandbox on quit and wakes it on use, and a served app
stops after 15 unused minutes). What a run leaves is kept by the lab:

- the session log: every message, model call with its settings, full reasoning, tool call and output;
- the sandbox's files, and the intermediate data and scripts the agent wrote, with their checksums;
- results (tables, figures, documents) as checked artifacts;
- the lab's receipts for each step.

A person downloads any of it with its checksum checked, and the whole run as one package (below).

## Trace and reproducibility

Scientists validate everything, so every step has to be readable and repeatable.

- **The session log** is the record ([session-log.md](session-log.md)): each model call with model, effort and
  settings, the reasoning the model returned, each tool call with its arguments and output, files with checksums, and
  approvals with who gave them.
- **Reasoning, full and summarized.** The full reasoning stays in the log for troubleshooting. A utility model writes
  a one- or two-sentence summary of each step's reasoning for reading, stored beside it as its own event. The summary
  is made in the same place as the session's model: a lab session's reasoning is summarized by the lab's model, never
  by a cloud service. The window shows the summary, and the full text one click away.
- **Receipts.** A lab's tools return a receipt with each result (inputs, code version, parameters, seed, image
  digest, outputs). WHNRC's evidence records chain each step's receipt and seal a finished run
  (`enrichedlab-contracts`, `enrichedlab.evidence.v1`).
- **A run package.** `el session package <id> [folder]` (or Session ▸ Export Run Package… in the Mac app) writes one
  RO-Crate 1.3 folder in the Process Run Crate 0.6 profile, the versions WHNRC's evidence exports pin. The engine
  writes it (`session.package`), and it holds:
  - the shared session log, with every message, model step and its full reasoning, and every tool call and output;
  - its images;
  - the files a session on this computer changed, with their checksums;
  - the project's package environment (`environment/pixi.toml`, `pixi.lock`);
  - EnrichedLab's version and where each model ran;
  - every model step and tool call as an action: its tool, its arguments and command, the files it named (`object`),
    the files it changed (`result`), times, outcome, who allowed it, and the reading summary. Files are named by
    their content id in the step history.
  - the step history itself, as `history/steps.bundle`: every kept state of the folder, one commit per point, so
    any file any step read or wrote can be checked out offline (`--no-history` leaves it out).

  `el session verify <folder>` checks every checksum, opens the history, and confirms every content id the steps
  name is in it (a malformed id fails). `el session reproduce <folder> <step>` reruns a command step from the folder
  as it was just before it, in a scratch folder, contained and offline: it may write only that folder (not the
  system's temp folders), gets a few plain variables (`PATH`, `HOME` and `TMPDIR` in the scratch folder, `LANG`,
  `TZ`) and nothing else from the caller, and doesn't run at all where the computer can't contain it. It then
  compares every file against what the step left, the same or different, names any file the rerun changed that the
  step didn't, and fails when the command fails. A package may come from anyone, so both read it defensively: only
  plain files inside the folder (metadata too), opened without following a link anywhere on the way, and its history
  from a private copy of the bundle, through the system's git (not one on the caller's PATH) with no hooks, no
  system or global config, no inherited `GIT_*` settings, home and temp in the scratch folder, no replace objects,
  and only the session refs fetched; every content id must be the kind of object it names (a commit for a history
  point, a blob for a file). Export copies a changed file only when it is a plain file inside the project, read the
  same link-free way, so a file swapped for a link to somewhere else is left out. On Linux, the rerun's private
  `/tmp` and `/run` are read-only. The package folder is resolved once, and every read is beneath that. A lab session's files stay in the lab; its
  receipts are in the log.

## Desktops

Some tools only have a desktop: RStudio, a PDF form, a GUI viewer. A lab can offer a desktop sandbox where the person
and the agent both work.

- **Linux, now.** Home Lab's desktop image (`openshell-sandbox-desktop`) runs a virtual display with a window manager
  and the browser, under OpenShell, and Gate takes one checked action at a time
  (`POST /v1/containers/{id}/desktop`): screenshot, cursor position, pointer moves, clicks, drags, typing, keys,
  scrolling, zoom and wait, the action set agents already know from computer-use tools. A desktop sandbox has no
  shell, attach, jobs or ports (`403 desktop_no_shell`), so nothing reaches the display except those actions, and each
  is audited. EnrichedLab gives the agent desktop tools that call those actions and opens the desktop in a pane, where
  the person's clicks and keys go through the same endpoint, marked `by: person`.
- **Live view, next.** A Selkies stream (one WebSocket, H.264 or JPEG decoded in the browser, several viewers at once)
  carried by Gate replaces the pane's screenshots, read-only first.
- **Text for smaller models, next.** Pelorus reads a desktop as text: windows with their geometry and accessibility
  trees with exact coordinates for every control, so even a small local model can operate it without guessing pixels.
  It comes in behind Gate's actions.
- **macOS, later.** macOS virtual machines on the Mac Studio through Apple's Virtualization framework (Apple's license
  allows two per Mac), streamed over VNC, with the same action endpoint for agents. Built and qualified at Home Lab
  first.

At WHNRC the same image runs in a Kata microVM on the sandbox node.

## Data in and out

- **In.** Files a person drops onto a lab session go to the lab, scanned on the way (`POST /v1/files`, or into the
  sandbox), and never through the model. A lab's own data is reached by reference: data tools return links with
  checksums, and the lab's database applies the person's scope.
- **Out.** Downloads are kept only when their checksum matches what the lab's scanners passed. At WHNRC an export
  needs the person's recorded decision about what leaves and to where.
- **Back home.** A session's work comes home as a branch the person merges, and a run's results as checked downloads
  or a run package.

## What WHNRC needs

What it takes for WHNRC to serve EnrichedLab the way Home Lab does. Rich confirmed the adapter on November 7 (item 4 of
WHNRC's current program): WHNRC builds the broker side as part of its research-agent work, and the contract's shapes
and the `el lab check` conformance rows stay in this repository. EnrichedLab's side is ready for each piece as the
contract rows show.

1. **The adapter.** The broker serves the contract at one hostname: the descriptor (`title: "WHNRC EnrichedLab"`,
   `policy.keep_data_inside: true`), `/v1/me` from its principals and memberships, `/v1/models` from the reasoner and
   smaller models, `/mcp` with the reviewed tools, library and knowledge per lab, `/v1/containers` on the OpenShell
   gateway, `/v1/runs` over research runs and campaigns, `/v1/events` from its change stream, `/v1/guard` from decision
   052's classifiers, and `/v1/usage`.
2. **Sign-in.** That hostname's Cloudflare Access application with managed OAuth, so EnrichedLab signs in with the
   institution's sign-in and MFA in the browser and refreshes on its own (CILogon stays the identity provider).
3. **Sandboxes on the sandbox node.** Kata (`kata-clh`) microVMs on the lab's sandbox node through the OpenShell gateway,
   with sized profiles. That node also runs other production services, so sandbox profiles and queues need limits that
   keep their CPU and memory reserved.
4. **Desktop image.** The same desktop image as Home Lab, qualified under Kata.
5. **Discovery mode.** The `discovery` capability mapped onto `research.discovery.autonomous`.
6. **The research web front end.** EnrichedLab's own web package, served by the lab, so a session changed in the
   desktop app or in the browser shows in the other through `/v1/runs` and `/v1/events`. EnrichedLab's side is a lab
   transport for the web package's store: the same windows, reading a run and its events from the lab instead of the
   engine on the person's computer.

## Order of work

| # | Piece | Owner | State |
|---|---|---|---|
| 1 | Isolate labs that keep data inside; no lab names in EnrichedLab | EnrichedLab | done (`f7c4fc6`) |
| 2 | Contract rows for runs, desktops, capabilities, sandbox agents and data scopes | EnrichedLab, with Home Lab | in [labs.md](labs.md); runs agreed with Home Lab as a thin layer over its sessions; `el lab check` rows for desktops and runs |
| 3 | Discovery mode client | EnrichedLab | done (`d4a39dc`) |
| 4 | Reasoning summaries | EnrichedLab | done (`398e4d6`) |
| 5 | Desktop pane and agent tools | EnrichedLab | done (`4824b45`, `d44bd9d`); checked live against Home Lab, November 6 |
| 6 | Runs at the lab, client | EnrichedLab | after Home Lab serves `/v1/runs` |
| 7 | Run package | EnrichedLab | done (`700eb59`) |
| 8 | Desktop sandboxes, `Home Lab` title | Home Lab | live (publication 67) |
| 9 | Runs on Rein and scheduled tasks | Home Lab | next |
| 10 | Discovery grant and approval holds | Home Lab | after Rich confirms to its owner |
| 11 | Broker adapter | WHNRC broker lane | confirmed by Rich, November 7; in WHNRC's research-agent work |
| 12 | Hostname, Access managed OAuth, sandbox node limits | WHNRC, with Rich | to settle |
| 13 | Web package served by a lab (a lab transport for its store) | EnrichedLab | after runs |
