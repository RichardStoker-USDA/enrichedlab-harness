# Development

How the code is laid out for change, how to check it, and how to release it. Each seam below is an interface with one or more
implementations; adding a capability means adding an implementation, not editing the loop.

## Seams

| To add | Write | Register in |
|---|---|---|
| A model API (Gemini's own API, a new local server) | a `ModelAdapter` (`packages/engine/src/models/types.ts`) | `adapterFor` in `models/registry.ts` |
| A service people sign in to instead of pasting a key (like ChatGPT plans) | a sign-in module beside `models/chatgpt.ts` | `provider.signin` in `engine.ts` |
| A kind of lab (a research broker, a university gateway) | a `SiteAdapter` (`packages/engine/src/sites/adapter.ts`) | `SITE_KINDS` in the same file |
| A place tools act | a `Workspace` (`packages/engine/src/tools/workspace.ts`) | `Engine.createSession` |
| A built-in tool | a `Tool` (`packages/engine/src/tools/types.ts`) with its `kind`, and `touches` if it changes files | `BUILT_IN_TOOLS` in `engine.ts` |
| Something a window does for the agent (like the browser pane) | an op handled in the window, called with `ctx.surface.call(capability, op, args)` | the capability in the window's `hello` |
| An app template | files in `packages/engine/src/apps/templates.ts` | `TEMPLATES` there |
| A model service people add with a key | a preset in `packages/engine/src/models/providers.ts` | `PROVIDER_PRESETS` there |
| A surface (editor bridge, native client) | a client of the Lab protocol (`packages/protocol`) | nothing: it connects to the engine |
| A web search provider | a branch in `tools/search.ts` | `SearchConfig.provider` |
| An add-on for people (skills, instructions, MCP servers, hooks, apps) | a bundle folder (`docs/bundles.md`) | `el bundle add`, or a site's `bundles()` grant |
| A site that hands out add-ons by role | `bundles()` on its `SiteAdapter` | nothing: `Sites.connect` installs what it returns |

Tools the person adds without code: MCP servers (`mcpServers` in `~/.el/config.json`), skills (`~/.el/skills/<name>/SKILL.md`
or `.agents/skills` in a project) and hooks (`hooks.beforeTool` / `hooks.afterTool`).

## Names

| Where | Name |
|---|---|
| What people see: the app, installers, window titles, docs | EnrichedLab |
| The terminal command, its folder and settings variables | `el`, `~/.el` (`%USERPROFILE%\.el`), `EL_*` |
| What the app leaves elsewhere: git branches and refs, container names, temp folders, browser storage keys | `enrichedlab` (`enrichedlab/<title>-<id>`, `refs/enrichedlab/…`) |
| This repository | `enrichedlab-harness` (EnrichedLab is the whole platform; this is the app people install) |

## Rules that keep it changeable

- The session log is the only source of model context. A new feature that affects what the model sees adds an
  event type to `packages/protocol` and a case in `session/context.ts`; it never edits earlier events.
- The protocol is additive: new fields are optional, new methods are new names. Surfaces ignore what they don't know.
- Provider field names stay inside their adapter. Nothing above `models/` knows `reasoning_content` or `cache_control`.
- Permissions are decided in one place (`permissions.ts`). A tool declares what it is (`kind`, `ask`, `host`,
  `touches`); it doesn't prompt on its own.
- Comments say why, not what. If a comment restates the line below it, delete it.

## Checks

```sh
bun test tests                       # unit tests, including captured adapter requests
bunx tsc -p tsconfig.json --noEmit   # types across packages
(cd packages/web && bun run check)   # svelte-check for the window
bun scripts/bench.ts                 # fixed tasks end to end through a real model
bun scripts/deps.ts audit            # known vulnerabilities in every locked package
```

CI runs the tests and type checks on macOS, Linux and Windows for every push (`.github/workflows/test.yml`).

The desktop window has a live check of its own, run by hand or on a release tag on all three systems
(`.github/workflows/desktop.yml`): `bun scripts/desktop_smoke.ts <folder>` starts a test engine, opens the app on a
session, loads a page in the browser pane and saves screenshots of the window and the browser view.

`bun scripts/dev_lab.ts` runs the window against a stand-in lab on this computer: a scripted model, a sandbox that
is a temporary folder, a source engine on a throwaway home, and a git project with one session on This Mac and one
moved to the lab. `--open` opens the app on it; `--shots <folder>` captures every scene (new session, both sessions,
the place and model menus, the workbench, every sheet, narrow windows) in light and dark, and checks the flows that
cross places, such as a first task typed after "New Session in <lab>" running there. Its stand-in config adds a cloud
service beside the lab, so model menus show private and cloud models. The stand-in lab also offers a desktop sandbox
(a drawn desktop that marks where the last click went) and grants Discovery mode: the `desktop` scene opens the pane
and clicks in it, and the `discovery` scene types `/discover` in the lab session. The `streaming_write` scene streams a 30 KB tool
call at a model's pace while resizing the window, and prints frame times, long tasks, and whether the page kept the
window's size. Build the window first
(`bun run build:web`). Run it before calling a change to the window done, and add a scene with each new surface.

The native macOS app builds with `swift build` in `apps/macos` (tests: `swift test`, which also start a real engine
from source in a scratch home). `bun scripts/dev_lab.ts --mac --shots <folder>` runs the debug build against the same
stand-in lab and captures each native scene in light and dark (`--scene mac_files` for one); it captures only the app's
own windows. The `mac_plot_divider` and `mac_dashboard_divider` scenes open a 60,000-point plot or a dashboard and
drag the workbench's divider in small steps; a scene fails when the app ends before it's ready. They guard the window
crash of November 7 (a window minimum computed from live column widths during layout). It showed only in an optimized
build, so check window sizing with one: `swift build -c release -Xswiftc -DDEBUG` keeps the scene hooks, and
`EL_MAC_BINARY=apps/macos/.build/release/EnrichedLab` runs the scenes on it. `bun scripts/build_mac_app.ts --adhoc` builds `dist/mac/EnrichedLab.app` (universal, with the universal
`el` inside) for a local check; the release signs it with the Developer ID.

A development run of the desktop app (`apps/desktop`, unpackaged) takes these for screenshots and tests:

| Variable | Does |
|---|---|
| `EL_SHOT=<file.png>` | Capture the window after load, save it, and quit; each browser view is saved beside it |
| `EL_SHOT_DELAY`, `EL_SHOT_AFTER` | Milliseconds to wait before the scene, and after it, before the capture |
| `EL_SHOT_JS` | Script run in the page first, to set the scene |
| `EL_SHOT_TYPE` | Text typed as key events into what the scene focused, then Return |
| `EL_SHOT_SIZE=1024x720` | The window's size, to check narrower layouts |
| `EL_SHOT_ROUTE` | The page to open instead of the session |
| `EL_SHOT_MENU` | The label of the menu item to choose when the scene opens a menu; a screenshot run shows no native menus |
| `EL_SHOT_RESIZE` | `WxH`: the window is resized back and forth to this size during the scene, then the page's size is compared with the window's (printed as `shot: perf window …`) |
| `EL_BINARY` | The engine to start, such as a wrapper that runs `packages/cli/src/main.ts` from source |

Pass `--use-mock-keychain` to Electron in these runs, so a test never asks for the login keychain.

## Benchmarks

`bench/scenarios/*.json` are tasks with checks: a command that must pass, a file that must or mustn't change, words
the answer must contain, an app the agent must open. `bun scripts/bench.ts [--model <ref>] [name ...]` runs each in a
fresh git project through the engine, removes its sessions afterwards, and writes `dist/bench/<time>.json`. Add a
scenario with each feature, and compare runs before a change reaches people.

## Releases

On a Mac with the Developer ID identities in the keychain:

```sh
NOTARY_PROFILE=<notarytool profile> bun scripts/release.ts --publish
```

It builds the six binaries, the native universal macOS app (`scripts/build_mac_app.ts`, macOS 15 and later) and its
home-folder package (signed and notarized), the per-user Windows setup, the Linux AppImages, an SBOM, and
`manifest.json` signed with the release key (`~/.secrets/enriched/release_signing.jwk`; its public half is
`config/release_key.json`). `--publish` creates the GitHub release that `el update` and `install.sh` read. `--security`
marks a release as a security fix. The version is `VERSION` in `packages/engine/src/util.ts` and the `version` in each
`package.json`; the release notes are `NEWS` beside it.

### Signing for Windows

Windows signing uses Azure Artifact Signing through jsign, so it runs from the same Mac (`scripts/windows_signing.cjs`).
It signs the app, the installer, the uninstaller and every `el.exe`, each with an RFC 3161 timestamp. Until it is set
up, the Windows files ship unsigned and SmartScreen warns on first run. One-time setup:

1. In the Azure portal, create an Artifact Signing account, finish its identity validation, and create a public-trust
   certificate profile.
2. Give the Azure identity that releases the Certificate Profile Signer role on that account.
3. On the release Mac: `brew install jsign azure-cli`, then `az login` as that identity.

Then release with the account's endpoint, name and profile set:

```sh
EL_WINDOWS_SIGNING_ENDPOINT=<region>.codesigning.azure.net EL_WINDOWS_SIGNING_ACCOUNT=<account> \
EL_WINDOWS_SIGNING_PROFILE=<profile> NOTARY_PROFILE=<notarytool profile> bun scripts/release.ts --publish
```

The access token comes from `az` at the moment of signing and reaches jsign through its environment only.

## Upgrading dependencies

Versions are pinned exactly in each `package.json`. To move one:

1. Read its release notes since the pinned version.
2. `bun update <name>@<version>` in the package that uses it, then `bun run check` and `bun test tests`.
3. For `@anthropic-ai/sdk`, recheck the beta names in `models/anthropic.ts` against the API reference; for
   `@earendil-works/pi-tui`, run `el` in a real terminal; for Electron, open the desktop app and a canvas window;
   for pixi, update the pinned version and hashes in `apps/environments.ts`.
4. Commit the version change alone, so it can be reverted alone.

Early capabilities go behind a seam first (a new adapter, an opt-in config key) and become the default after they
have run for a while.
