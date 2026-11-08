# Apps

An app is a web page that runs in a workbench pane beside the conversation, with tools behind it. The agent builds one
from a sentence ("make an app to compare yield by treatment"), the person uses it, and both keep changing it while it
runs: the pane reloads as files change, and errors the page hits reach the agent's next turn.

Apps speak the MCP Apps protocol (`io.modelcontextprotocol/ui`, specification 2026-01-26): the page is an MCP Apps
view, the workbench is its host, and the app's backend is an MCP server. So an app built here is an MCP App, and a view
any MCP server returns opens here too.

## Making one

- The agent: `app_create` scaffolds `apps/<name>/` in the project from a template (data, blank, shiny); it edits the
  files with its normal tools and calls `app_open`.
- The person: `el app new <name> [--template data|blank|shiny|shiny-python]`, then open it from the
  workbench's Apps menu or ⌘K.

## R, Python and other tools

An app that needs R, Python or anything else from conda-forge ships a `pixi.toml` listing its packages (the Shiny
templates do). The first time it opens, EnrichedLab builds that environment in the app's `.pixi` folder with pixi,
which it downloads once and checks against pinned hashes when it isn't installed. No administrator, the same on
macOS, Windows and Linux, and `pixi.lock` records exactly what was installed, so a lab can build the same
environment into a sandbox image. The consent card lists the packages. `command` and `serve` backends then run
inside that environment, contained; `$PORT` in a served app's command is its port.

## A project's own environment

The agent's `environment` tool gives a project its own pixi environment: `pixi.toml` and `pixi.lock` in the project,
the packages in its `.pixi` folder. It can list, add (conda-forge, or PyPI with `pypi: true`), remove, update and
sync, for the project or for one app's folder (`folder: "apps/<name>"`). The install is contained the same way as an
app's: it may write the project and pixi's own caches under `~/.el/tools`, and it gets no keys or tokens. Contained
shell commands then run inside that environment: its programs come first on PATH and `CONDA_PREFIX` is set. A command
run outside the sandbox never gets it, so a program the project holds can't stand in for the system's there. Package
names can't be options (they start with a letter or digit, after `--`), and listing never downloads pixi. Each project
is kept apart from the system and from other projects. The system prompt tells the model to use the tool rather than
brew, sudo, `pip install --user` or `install.packages`. Installs ask unless the session allowed them or runs Allow
Everything; listing doesn't ask.

Updating names its packages (`update` with `packages: ["shiny"]`) or updates everything the manifest allows. The
result lists every version that changed. `pixi.toml` and `pixi.lock` are project files, so step history keeps each
version: going back to before an update and running `sync` puts the previous versions back.

When the session works with a lab whose descriptor names vetted package sources (`packages`, docs/labs.md), a new
environment uses the lab's conda channels, plus conda-forge unless the lab says `only`, and its PyPI index. A lab's
sandbox has no network, so there the tool explains that packages come from the lab's image.

## From a lab

A lab can offer apps to people by group (`GET /v1/apps`, docs/labs.md). They show under *From <lab>* in the Apps
menu and in `el apps`; `el app add <lab>/<name>[@version]` installs one. The package has to match the listing (size
and sha256), then pass the same checks as any package: every file's hash and the Ed25519 signature. A signer the lab
vouches for (`GET /v1/signers`) is trusted for that lab's apps only, never for a package added by hand. The install
records where it came from (`.lab/origin.json`); when the lab withdraws that version or revokes its signer, the app
stops opening and its data stays until the person updates or removes it. An app a lab publishes names that lab in
`permissions.labs` by the lab's own name (its descriptor's `name`), which EnrichedLab maps to the person's site.

## In a lab session

When the session works in a lab, an app's backend runs in that lab's sandbox, next to the project and its data. The
app's folder is copied in once per version (`~/.el-apps/<name>/<digest>` there, with `data/` beside it as
`APP_DATA_DIR`), and the process is attached over the lab's attach endpoint: `command` and `bun` backends speak MCP
over its stdin and stdout, and a `serve` backend listens on `$PORT` (0.0.0.0) and opens through the lab's port path.
The sandbox has no network, so an app's own environment isn't installed there; its command runs with what the lab's
image has, and a `bun` backend needs Bun in that image. `container` backends run on this computer only. A lab that
keeps its data inside never runs the backend here; for other labs, a lab without attach falls back to this computer.
Installed apps (and apps the lab grants in bundles) open in a lab session by id: `app_open` with the id. Sessions
that work in the same lab share one backend per app, since a sandbox has few long-running process slots: its
`PROJECT_DIR` is the folder holding every session's project, and each call names the calling session's project in
MCP `_meta["org.enrichedlab/project"]`, which a `bun` backend gets as `app.projectDir`.

## app.json

```json
{
  "name": "yield-explorer",
  "title": "Yield explorer",
  "version": "0.1.0",
  "entry": "index.html",
  "backend": { "runtime": "bun", "main": "backend.js" },
  "permissions": { "files": "read", "models": true, "labs": ["enrichedlab"], "network": ["https://api.example.org"] }
}
```

| Backend | What runs | Contained by |
| --- | --- | --- |
| `bun` | a module exporting `tools`, on the Bun runtime inside `el` (`BUN_BE_BUN=1`); nothing to install | OS sandbox: writes only to the app's data folder, no network unless `permissions.network` |
| `command` | any MCP server on stdio the person has (`uv run server.py`, `Rscript srv.R`) | the same |
| `container` | an MCP server on stdio in an image, built from the folder when `build` is set (Docker, Podman or nerdctl) | the container: `--network none` unless allowed, app folder read-only |
| `serve` | a web app on `$PORT` (R or Python Shiny, Streamlit, a dev server); the page is its address | OS sandbox with loopback only |

## What a page can call

Pages import `/app-sdk/lab.js` (EnrichedLab's helpers on the official MCP Apps `App` class, also served raw at
`/app-sdk/app.js`):

```js
import { connect, scatter } from "/app-sdk/lab.js";
const lab = await connect({ name: "yield-explorer", version: "0.1.0" });
const table = await lab.table("plots.csv");          // CSV, TSV, JSON, JSON Lines, Parquet
await scatter(element, { x, y, color, xLabel, yLabel }); // WebGPU, Canvas 2D fallback
await lab.call("summarize", { values });              // the app's backend tools
```

Host tools, each behind a permission: `lab_read_file`, `lab_list_files`, `lab_write_file` (files), `lab_run`
(commands, where the session works), `lab_ask` (models), `lab_cluster_run` (labs: a command in that lab's sandbox),
and always `lab_store_get/set` and `lab_session`. `lab.share(text)` tells the model what the app shows
(`ui/update-model-context`); `lab.say(text)` speaks in the session (`ui/message`).

## Safety

- A page gets an opaque origin from its CSP (`sandbox allow-scripts`): no access to the workbench, its storage or the
  engine. It reaches the host only through the bridge, and the network only at origins it declared.
- An app that asks for permissions, or runs a program of its own, shows the person what it asks before anything loads.
  The grant covers exactly that list; asking for more asks again.
- In a session bound to a lab that keeps data inside, pages get no network or links, and other labs are refused.
- An MCP server's view may call only its own server's tools marked for apps; app-only tools never reach the model.

## Sharing

`el app pack <folder>` writes `<name>-<version>.labapp`: the files, each file's SHA-256, and an Ed25519
signature with the person's key (made on first pack, `~/.el/keys`). `el app add <file>` checks every hash
and the signature and refuses a signer the person hasn't trusted unless given `--trust`. Bundles can carry apps in
`apps/<name>/`, so a lab grants apps to people by role the way it grants skills.

## Not yet

- Building an app's environment into a lab's sandbox image: the lab's signed apps (`/v1/apps`, `/v1/signers`).
