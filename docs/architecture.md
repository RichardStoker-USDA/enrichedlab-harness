# Architecture

EnrichedLab is an agent harness for people on macOS, Linux and Windows 11. It works on its own with local models and
the person's own keys. Signed in to a lab (a site), it picks up the models, tools, sandboxes and data that lab grants
that person. The lab decides access; the client only applies it ([labs.md](labs.md)). [design.md](design.md) records
the interface direction.

## Shape

```text
 terminal          desktop window    browser tab    editor (ACP)    el run -p
        \               |                 |             /              /
         \______________|_________________|____________/______________/
                                  │  Lab protocol: JSON-RPC 2.0 over WebSocket (loopback, page key or token)
                       ┌──────────┴───────────┐
                       │   engine (el serve) │  one per person, starts on demand, stops when idle
                       ├──────────────────────┤
                       │ sessions: append-only logs, live fan-out to every attached surface
                       │ agent loop: steps, steering, cancel, retries
                       │ context: token budget, output handles, elision, compaction
                       │ models: adapters (OpenAI Chat, Anthropic Messages), local discovery, profiles
                       │ tools: workspace seam (local now, site sandbox next), web, canvas, recall, plan
                       │ permissions: ask, allow for session, deny; read-only by default outside the project
                       │ MCP client: stdio and Streamable HTTP
                       │ sites: sign-in, entitlements, site models, site MCP tools, site sandboxes
                       └──────────┬───────────┘
              ┌───────────────────┼─────────────────────┐
         local models        site (Gate)            MCP servers
   Ollama, LM Studio,    /v1/models /v1/me /mcp     configured by the person
   llama.cpp, vLLM, keys  /v1/containers            or granted by a site
```

## Packages

| Path | Owns |
|---|---|
| `packages/protocol` | The Lab protocol: request, notification and event types. Every surface imports only this from the engine side |
| `packages/engine` | Everything in the box above |
| `packages/tui` | The terminal surface |
| `packages/web` | The browser surface (Svelte 5), served by the engine; the Windows and Linux window's contents |
| `packages/cli` | The `el` command: starts or finds the engine, routes subcommands |
| `apps/macos` | The native macOS app (SwiftUI): `EnrichedLabKit` speaks the protocol, `EnrichedLabUI` is the window |
| `apps/desktop` | The Electron window around the web surface, for Windows and Linux |

## Windows on each system

One engine, a native window per system. The engine holds everything that decides behavior (sessions, the agent loop,
models, tools, labs, permissions, apps), so every window does the same things the same way; a window only draws state
and sends requests.

- **macOS: `apps/macos`, SwiftUI.** A `NavigationSplitView` with places and sessions in the sidebar, the run sheet with
  the composer, and the workbench as an inspector beside it. Native menus, Settings window, Liquid Glass materials,
  SwiftTerm terminals, WebKit for pages and apps, Swift Charts for plots, a native table. `EnrichedLabKit` is the
  protocol client (an actor on `URLSessionWebSocketTask`) and the run sheet's pure logic, tested against a real engine.
  The app carries the universal `el` in `Contents/Resources/bin` and starts the engine through `el engine ensure`, so
  the version and start rules stay in the engine. Apps (MCP Apps) run in an embedded engine-served page
  (`#/embed/app/<id>`), so their bridge and consent are the same code as the other windows'.
- **Windows and Linux: `apps/desktop`, Electron** around `packages/web`, installed per person without administrator.
- **Terminal: `packages/tui` and `el`**, and the browser through a pairing link.

A new protocol field reaches every window as data: Swift string unions stay strings and unknown session events decode
as `other`, so an older window keeps working with a newer engine.

## The engine

**Process.** `el` looks for a running engine through `<home>/run/engine.json` (port, token, pid). If there is none,
it starts `el serve` detached and waits for the file. A lock file stops two engines starting at once: it is created
complete under its final name, a stale one is moved aside rather than deleted, and the winner checks again. The
engine binds to 127.0.0.1 on a free port, checks `Host` on every request and `Origin` on WebSocket upgrades, and stops
after 30 minutes with no surface attached and no turn running. A session no surface has open leaves memory once its
turn ends; its log stays on disk.

**Home.** `~/.el` (`EL_HOME` overrides): `config.json`, `sites.json`, `credentials/` (owner-only),
`sessions/<id>/` (log and output handles), `run/`. The same layout on Windows under `%USERPROFILE%\.el`.

**Sessions.** A session is an append-only JSONL log in `sessions/<id>/log.jsonl`. Events are `header`, `user`,
`assistant` (text, reasoning, tool calls, usage, stop reason), `tool`, `elide`, `compaction`, `model`, `title`.
The conversation the model sees is derived from the log and nothing else, so any session resumes from any surface;
a request also carries the system prompt frozen in the log header and the tool definitions current at the time. Surfaces get each durable event as it is written, and transient deltas while a model streams.

**Agent loop.** A turn is one or more steps. A step is one model request plus the tools it called. Read-only tool
calls in a step run in parallel; anything that changes state runs in order. A message sent while a turn runs is
queued and joins the next step (steering). Cancel stops the stream and running tools, and the log records which
calls never finished. Errors before the first byte (429, 5xx, network) retry with backoff; a context-length refusal
forces a compaction and one retry.

**Context.** The engine tracks the last request's prompt tokens plus an estimate for what was added since.

1. A tool output over 24 KB is stored whole under `sessions/<id>/outputs/` and the model sees its head, its tail
   and a handle. `recall` pages the exact text back.
2. At 60% of the usable window, outputs older than the last three turns that are over 2 KB are elided to one line
   with their handle. The decision is an `elide` event.
3. At the usable window (context window minus a reserve of 15%, at least 8k tokens and at most half the window),
   older turns are summarized into a structured handoff (goal, constraints, done, in progress, decisions, files, next
   steps) and about 20k tokens of the most recent work are kept as they were, cut at a turn boundary, or inside the
   current turn when that turn alone is too big. The summary is a `compaction` event. The summary request keeps the
   session's tools with tool choice `none` (a history with tool calls needs them) and says when the oldest messages
   didn't fit.

Steps 2 and 3 change the prompt prefix only at those two points, and only where a turn starts: inside a tool round
only the hard limit (halfway into the reserve) forces a summary. Prefix caches stay warm between the points; on the
Anthropic API the system prompt carries a cache breakpoint and the conversation uses automatic caching. Anthropic
thinking blocks before a point stop being replayed, which the API allows for a leading run. A site can name a
separate summary model; otherwise the session's model writes it. Nobody has to run a command.

Reasoning summaries (one line per step, for the run sheet and the timeline) come from `summaryModel` when it's set
(Settings ▸ Models ▸ Reasoning summaries), and otherwise from a fast model where the session's model runs: a lab's or
a provider's small one (a name with mini, flash, haiku, nano, a few billion parameters and the like). On this
computer the session's own model writes them, after the turn, so a second model isn't loaded beside it. A summary
never goes anywhere the session's model doesn't (`pickHelper` in `session/runtime.ts`).

**Models.** A model reference is `<provider>/<model>`. Providers come from three places: model servers on this
computer, services the person added with a key
(`provider.add`: OpenAI, Anthropic, Gemini, OpenRouter or any OpenAI-compatible address, the key in the OS
credential store) or listed in `config.json`, and signed-in labs. A model profile holds its context window, output cap, vision,
reasoning levels and where the level is sent (`reasoning_effort` or `chat_template_kwargs`), and whether reasoning
is replayed inside a turn. Gate reports all of this in `/v1/models`; local models get conservative defaults that
`config.json` can override per model.

**Models on this computer** (`models/local.ts`). The engine probes ports 11434, 1234, 8080, 8000 and 30000
(`discovery.ports` replaces the list) and names each server by its answer, since llama.cpp and mlx_lm.server share
8080 and vLLM and oMLX share 8000: `owned_by` (llamacpp, vllm, sglang, omlx), Ollama's `/api/version`, LM Studio's
`/api/v1/models`, and Python's `Server` header for mlx_lm.server. Foundry Local takes a free port when its server
starts, so the engine asks its CLI (`foundry status --output json`, else the older `foundry service status`) and
probes that port too. Each model gets the context its server will hold,
capped by memory (16K under 32 GB, 32K under 64 GB, 64K above). Ollama is reached through `/api/chat`, because its
OpenAI endpoint can't set `num_ctx` and would cut prompts to its 4,096-token default; LM Studio loads a model with
the planned `context_length` before its first request. `el local` and the window's *On this computer* list what
runs here and suggest open models that fit (`models/suggested_models.json`); `el model pull` downloads through
Ollama, which since 0.40.0 runs models on MLX on Apple silicon. Apple's on-device Foundation Model is left out: its
4,096-token window can't hold an agent's instructions and tools. A session whose model goes away stops and says so;
it never moves the conversation to another model on its own.

**Tools.** `read`, `write`, `edit`, `ls`, `glob`, `grep`, `shell` (bash or zsh on macOS and Linux, PowerShell on
Windows), `fetch`, `show`, `recall`, `plan`, `agent_start` and `agent_wait` (subagents: child sessions in the same
folder and site binding, read-only unless started with mode "full", unable to start their own), `skill` when skills
exist, `web_search` when a provider is configured, `app_create` and `app_open`, `pdf_fields` and `pdf_fill` (PDF forms
through pdf.js), and the browser tools. `write`, `edit` and sandbox downloads checkpoint the files they
change first; `session.undo` puts back a turn's changes and tells the model. Hooks from `config.json` run before and
after tool calls (exit 2 blocks). With `permissions.sandbox: "workspace"`, local commands run contained by the OS
(Seatbelt, bubblewrap; on Windows a write-restricted token, which still asks) and don't ask; `unsandboxed: true`
asks. File and shell tools go through a workspace provider. The local one acts
in the project folder with the person's rights. A site sandbox provider is the next one: switching the workspace
moves `read`, `write`, `edit` and `shell` into the sandbox without changing the tools.

**Tool catalog.** Every tool a session can use is described for search: a one-line summary, its domains (files, data,
plots, documents, PDF, the lab's desktop, research and so on) and its argument names (`catalog.ts`). A session with
more than 40 tools offers the model its core tools (reading, editing, the shell, plans, recall, views, skills) and
`find_tools`, which searches the rest by what the agent needs; the tools it finds or has used stay in its requests,
rebuilt from the log when a session resumes. Search is lexical (BM25), so it works offline and needs no model; a
ranking by meaning can join it through the same search.

**Built-in skills.** EnrichedLab carries skills for the work scientists bring most (`packages/engine/skills`): Shiny
figure apps with export, reproducible data analysis in R or Python, Office files, PDF forms, a lab's desktop, and
research at a lab. They're embedded in `el`, written to `<home>/skills/builtin-<version>/` on first use, and listed
like any skill; a personal or project skill with the same name replaces one.

**Permissions.** Three modes decide what asks: `ask`, `auto` (the default: asks only for what history can't take
back) and `full` ([security.md](security.md#how-much-it-asks)). Reads inside the project run. A shell command runs
without asking when it runs contained and names only paths inside the project, or when a quote-aware check finds every
part read-only (no variables, substitutions, subshells, background jobs, writing redirections or environment
prefixes; no command that runs another program) with every path inside the project after following symlinks.
Anything outside the project asks, and `fetch` asks once per host. "Allow for this session" covers each program a
command runs (`python3`, `git commit`), is kept in the session log, and the button says what it covers. A site tool
runs when the site marks it read-only and asks otherwise. Sandbox commands run, since the sandbox is isolated. The person answers from whichever surface they are looking at; the
first answer wins. `el run` refuses what would ask, unless started with `--allow`.

**Windows that act.** A surface can say in `hello` what it can do for the engine. The desktop windows say "browser":
the browser tools (`browser_open`, `browser_read`, `browser_click`, `browser_type`, `browser_screenshot`) become
`surface.call` notifications to a window showing the session, which acts on its browser pane with real input events
and answers with `surface.reply`. The page is read as text with numbered controls
(`apps/desktop/src/page_script.mjs`; the macOS app carries the same script). When the agent shows something or needs the browser and no window shows the
session, the engine sends `surface.wanted` and the terminal opens the window (`/window off` keeps a session in the
terminal).

**Two browsers.** The same tools take `where`: `device` is the desktop browser above, with the person's own sign-ins;
`sandbox` is a headless Chrome in a lab's sandbox that the lab lists in its descriptor
(`browser: {protocol: "cdp", port}`). The engine drives that one itself over the DevTools protocol through the lab's
port path (`sites/cdp.ts`, `sites/sandbox_browser.ts`), with the same page script, so both read pages the same way.
Each session gets its own browser context, so sessions share no cookies; downloads stay in the sandbox and leave only
through the lab's scanned file API. A window watches the page with `browser.watch` and gets `browser.frame` pictures
and `browser.page` state; the person's clicks and keys go back with `browser.input`, and the page lays out to the
pane's size (`browser.resize`). A session keeps the browser it used last; an isolated lab's sessions use only that
lab's sandbox browser.

**Updates.** `update.check` and `update.apply` read the signed release manifest and replace the install in place
([security.md](security.md)). The long-lived engine checks daily and sends `update.available`.

**Canvas.** `show` publishes HTML, Markdown, SVG or an image to a canvas the engine serves at `/canvas/<id>`. The
desktop and browser surfaces show it beside the session; the terminal prints its address and can open it. Each
update reaches every viewer at once. Canvas content runs with an opaque origin (a CSP sandbox without same-origin), so it can't reach the engine, and its
address carries a per-canvas key.

## Sites

A site is a place that signs a person in and grants them things. `el login <name>` with a site address:

1. Discovery: the site's protected-resource metadata (RFC 9728) names its sign-in server, which describes itself
   (RFC 8414).
2. The engine registers once as a public client with a loopback redirect (RFC 7591, RFC 8252), opens the browser,
   and the person signs in with whatever the site's Cloudflare Access policy requires (MFA, identity provider).
3. PKCE (RFC 7636) and a resource indicator (RFC 8707) bind the token to that site. Tokens are short-lived and
   refreshed; they live in `credentials/<site>.json`, owner-only, and never appear in a log or an error.

After sign-in the Gate adapter reads `/v1/me` (who, quotas, whether files and sandboxes are on), `/v1/models` (the
models this person may use, with their profiles) and `/mcp` (the tools their role grants). Those become the
session's site models and tools with no manual setup. On the home LAN a Gate key and Gate's CA can stand in for
the browser sign-in.

Each kind of site is a `SiteAdapter` (`sites/adapter.ts`); Gate is the first. A session can be bound to one site, and
then sees only that site's tools and models plus the person's own; a site marked `isolated` (research data) is
never offered to sessions that aren't bound to it. A site's sandbox survives reconnects and refreshes, and isn't
deleted at shutdown while a background job runs. Repositories move to a sandbox and back as git bundles, and a site
can grant bundles of skills, instructions, MCP servers and apps by role ([bundles.md](bundles.md)).

A later site manifest (`/.well-known/enrichedlab-site`) can add web apps, agents, data sources and voice. The
client reads it when present and works without it.

## Places

A session's place is where its file, search and shell tools act: `local` (a LocalWorkspace, OS-contained by default)
or a site name (a SandboxWorkspace over that site's sandbox API: exec, upload, download). The tools are defined once;
the place decides where they run. `session.place` moves a session between turns and carries a git repository as a
bundle (sites/repo_handoff.ts); moving back fetches the sandbox's commits as a branch ([bundles.md](bundles.md)). An
isolated site pins its
sessions to its sandbox and its models and removes web, personal MCP and download tools. The model learns of a move
from a note in its next request; the system prompt stays frozen for prompt caching.

## Apps

An app is an MCP Apps view (a page in an opaque-origin frame) plus an optional MCP server backend. The engine's
AppHost (apps/host.ts) keeps the library and grants, serves pages at /apps/<token>/, runs backends through
apps/backends.ts (Bun module, stdio command, container, or a served web app) under tools/workspace.ts contained(),
and answers the page's host tools (lab_*) within its permissions. An app with a `pixi.toml` gets its R or Python
environment built per user first (apps/environments.ts). The surface carries the page's MCP Apps messages with the
official AppBridge (AppPane.svelte). [apps.md](apps.md) has the details.

## Git and add-ons

In a git repository each turn starts with a working-tree snapshot on a hidden ref, so undo covers shell changes. A
session or full-mode subagent can work in its own worktree and branch, where it edits and commits without asking;
pushes always ask. Bundles add skills, instructions, MCP servers, hooks and model settings, from the person or from
a lab. Details and rules: [bundles.md](bundles.md).

## Security

- The engine listens on loopback only, checks `Host` on every request (no DNS rebinding) and `Origin` on WebSocket
  upgrades. The terminal and the desktop shell authenticate with the token in the owner-only run file. A browser
  page is paired by a one-time link that stores a per-engine key in that origin's `localStorage`; the page sends it
  as a WebSocket subprotocol. Storage is scoped to the port, so a page on another loopback port (another person's
  server on a shared machine) can't read it, which a cookie on 127.0.0.1 wouldn't guarantee. The UI's own files are
  served without a key; they hold nothing private.
- The desktop shell runs the page with context isolation and a sandboxed renderer, keeps every window on the
  engine's origin (parsed, not by prefix), opens canvases in plain windows without its bridge, and grants the
  microphone, camera and notifications only to the app's own top frame.
- Site tokens are bound to the address they were issued for: pointing a site name at a new address drops them.
- Secrets are referenced by path or environment variable in `config.json` and read at use. Token-shaped strings are
  redacted from errors and notices. Contained commands run without the variables that look like credentials
  (`withoutSecrets`), so `printenv` there shows none; a command the person approves to run uncontained gets the whole
  environment and can still print a secret into the session log.
- The local shell runs with the person's own rights unless `permissions.sandbox` is `"workspace"`: then commands
  run under Seatbelt (macOS) or bubblewrap (Linux) with writes kept to the project and temp folders, no network,
  credential folders (`~/.ssh`, `~/.secrets`, the engine's keys and others) unreadable, and on Linux every namespace
  unshared. A contained command still asks when it names a path outside the project. Without the sandbox the
  permission prompts guard against a model steered by text it read; they aren't an OS boundary. On Windows commands
  run under a write-restricted token and still ask ([security.md](security.md)). Lab sandboxes are isolated by the lab.
- A site's grants are enforced by the site. A modified client gains nothing the site doesn't allow.
