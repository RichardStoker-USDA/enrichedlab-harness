# Labs

A lab is a server or cluster that signs people in and gives each of them models, MCP tools, a sandbox, data and apps
according to who they are. EnrichedLab reaches a lab through one adapter (`packages/engine/src/sites/`); the lab
decides access and enforces it on every call, so a changed client gains nothing the lab doesn't grant.

Run two labs with the same contract: a development lab where features are built and broken, and a production lab
that only takes what passed there.

## What a lab serves

The shapes are JSON Schemas in [contract/](../contract/); this table says what each endpoint is for. A lab names the
endpoints it serves in its descriptor, and `el lab check <lab>` exercises each one against the schemas (pass, fail or
skip per row, non-zero exit on a failure), so a lab can gate its own releases on it. Two labs serving the same contract
look the same to EnrichedLab.

| Endpoint | Purpose | Client |
| --- | --- | --- |
| `GET /.well-known/enrichedlab-lab` | the descriptor: contract version (`2026-11`), title, endpoints served, sign-in kind, policy, help and docs links, sandbox profiles | reads it on connect; refuses another contract major |
| Sign-in | OAuth 2.1 through Cloudflare Access managed OAuth: discovery (RFC 9728, RFC 8414), client registration (RFC 7591), PKCE, a token bound to the lab (RFC 8707) | built |
| `GET /v1/me` | a stable pseudonymous `subject` (never an email), memberships (lab, research group, roles), policy, and `data_scopes`: the lab data the person may reach by reference (`id`, `title`, the research group or project it belongs to, `read` or `write`), which data tools take by id while the files stay at the lab and the lab enforces access | built, with ETag; `el lab check` checks the shape; the harness doesn't show data scopes yet |
| `GET /v1/models` | the models this person may use, with context, output limit and reasoning levels. A model the lab doesn't run on its own servers names the outside service it relays requests to in `gate.relayed_to` | built, with ETag. Model menus and the new-session screen say where each model runs: private (the lab's own servers, this computer, a private address on the person's network) or cloud (a service, named, where what's sent may be kept by its terms); lab models count as the lab's own unless `relayed_to` names a service |
| `POST /v1/chat/completions` (`endpoints.chat_completions`) | OpenAI-compatible chat: `stream: true` with `tools` and `tool_calls`, the model's reasoning as `reasoning_content` in the deltas, and `usage` at the end. A descriptor that lists `models` without `chat_completions` serves it too (Home Lab today) | built: sessions at a lab use it; the reasoning is kept in the session log and summarized per step by a model in the same place |
| `POST /mcp` | MCP tools, filtered per person; MCP 2026-07-28 stateless, so any replica answers any request | built |
| `/v1/containers` | the person's sandbox: run, background jobs, files in and out; `profile` picks a size. `GET` lists the person's sandboxes (one the lab ended itself stays listed as `deleted`, with `reason`, so the person sees why) and `DELETE /v1/containers/{id}` removes one (`202`, status `deleting`, while the lab still clears its files; it lists and reads as `deleting` and counts toward the person's limits until it's gone; `429 too_many_deletes` past a few at once); `POST /v1/containers/{id}/stop` stops a running one, keeping its files, where the descriptor says `endpoints.stop`. A new one is refused with `429 too_many_containers` when the person holds as many as the lab allows (`error.limit: "held"`; stopped and archived ones count) or runs as many at once as their policy allows (`"at_once"`, also on restore and wake), `413 storage_full` when files and resting sandboxes fill their storage, or `503 sandbox_busy` with `Retry-After` while the lab is too busy to start it. A file leaving the sandbox passes the lab's malware scanners first and comes with `Repr-Digest` (RFC 9530) of the bytes they passed; `422 file_refused` when a scanner stops it, `503 scanner_unavailable` with `Retry-After` while one is down, `429 downloads_in_progress` past the person's concurrent scans, `413 file_too_large` past the person's limit. A restore is refused (`403 restore_files_over_limit` or `restore_memory_over_limit`, the message giving sizes) when the sandbox outgrew the person's current limits | built: downloads are kept only when their sha-256 matches `Repr-Digest`, and one the lab ends partway (a reader idle for a minute, or past 30 minutes) is tried once more from the start; waits out `sandbox_busy`, `scanner_unavailable`, `downloads_in_progress` and `too_many_deletes` for up to 3 minutes; `el sandboxes <lab>` lists them, ended ones apart with the lab's reason, `el sandbox stop <lab> <id>` stops one and `el sandbox delete <lab> <id>` removes one, which the refusals name (stop only for `at_once`, where it frees a place); `el lab check` sends a file in and out |
| `POST /v1/containers {network}` | a sandbox's network, fixed when it's made: `none` (the default) or `internet`, the public web on ports 443 and 80 through the lab's proxy (`HTTPS_PROXY`), never private, LAN, cluster or metadata addresses. The descriptor's `sandbox_networks` lists what the lab offers and `/v1/me` `sandbox_networks` what this person may use; container JSON carries `network`. An internet sandbox takes no lab files (`409 internet_no_files`); only a sign-in made for internet use (which never has lab files, tools or record views) or the lab's owner can make one (`403 internet_identity_required`); the lab's code interpreter refuses them (`409 internet_not_for_code`); `400 network_unavailable` where the lab doesn't offer it; a restore keeps the network (`409 network_not_offered` when the person can't start one now) | `el sandbox create <lab> --network internet`; `el sandboxes` marks internet ones; a replaced sandbox keeps its network; the sandbox browser says whether it reaches the web; `el lab check` checks that an internet sandbox fetches a public page through its proxy, can't connect directly without it and takes no files, and that its proxy refuses (4xx) a CONNECT to the metadata address, 10/8, 172.16/12, 192.168/16, 100.64/10, loopback, the cluster API, ULA, link-local, and the IPv4-mapped, NAT64 and 6to4 forms of private IPv4 addresses (a 5xx means the proxy tried, which fails the row), and that a proxy re-signing HTTPS refuses sites whose own certificates are broken (badssl.com's expired, self-signed and wrong-name pages, with its good page as the control). Where the lab also has a browser image, it checks that Chrome in an internet sandbox loads https://example.com/: a proxy that re-signs HTTPS has to make the browser trust its CA, since Chrome reads none of the CA variables (`SSL_CERT_FILE` and the like) other programs follow |
| `POST /v1/files` | the person's files, scanned on the way in; `422 file_refused` when a scanner stops one. A lab that sets `conformance.scan_test: true` refuses the EICAR antivirus test file without flagging the person to its owner | `el lab check` sends the EICAR test file where the descriptor offers it, expects `422 file_refused`, and removes the file if the lab kept it |
| `GET /v1/bundles` | skills, instructions, MCP servers and apps granted by role | built, with ETag |
| `GET /v1/events` | server-sent events with a commit-ordered `id`; resume with `Last-Event-ID`; a cursor older than the history kept gets `event: reset` | built: shown as notices; cursor kept across restarts |
| `POST /v1/guard` | the lab's classifiers: `{stage, text, session?, tool?}` → `{decision, categories, reasons, policy_version, receipt_id}` | checked by `el lab check`; sessions call it next |
| `GET /v1/usage` | tokens, GPU and sandbox seconds by lab and group, for a 7- or 30-day window | `el usage <lab>` |
| `GET /v1/me` `capabilities`, `sandbox_agents` | grants beyond roles, each named: `discovery` lets the person turn on Discovery mode in that lab's sessions (the lab checks it again for anything it runs unattended). `sandbox_agents` says whose agents may use this person's sandboxes: `lab` (only the lab's models, the default where the lab's `policy.sandbox_agents` says so) or `any` (the person's own agents too, a grant a lab gives chosen people) | built: `/discover` and `el discover` only where `discovery` is listed; a session in a lab sandbox under `lab` uses that lab's models only |
| `sandbox_desktop`, `POST /v1/containers/{id}/desktop` | a desktop sandbox: the descriptor names its `image`, `screen` size, `actions`, `open_targets`, `max_type_chars`, `max_wait_seconds`, the `labels` it records, its `os`, the `apps` that `launch` starts, the apps `open_with` takes, and whether it serves a live `stream`; `sandbox_desktops` lists every desktop the lab offers (`sandbox_desktop` repeats the first). The endpoint takes one checked action (`screenshot`, `cursor_position`, `mouse_move`, `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `left_click_drag`, `type`, `key`, `scroll`, `zoom`, `wait`, and where listed `state`, `launch {app}`, `focus_window {window}`), each with `by: agent` or `by: person` as the client says (a label next to the audited actor, never authority), and answers `{ok, action}`, with `screenshot {png, width, height}` after a screenshot or zoom (the PNG's own size) and `cursor` after `cursor_position`; `state` answers `state {screen, cursor, windows [{id, app, title, bounds, focused, minimized}], focused {window, tree, nodes, truncated}}`, `launch` and `focus_window` a `window` when there is one, and a desktop made from an older image build answers `409 desktop_outdated` (the client marks the lab's desktop `outdated`, and Update Desktop moves it over in place, keeping its files: `POST .../stop`, `POST .../archive`, wait for `archived`, `POST .../restore`, wait for `running`); a client that wants to see what input did asks for a screenshot after it. `POST .../desktop/open {target, with?}` opens an http(s) address with a host and no user or password, or a path under `/sandbox/`, and answers `{opened}`. A stopped or starting desktop answers `409 sandbox_starting` with `Retry-After` (retry the action), an archived one `409 sandbox_archived` (restore it, then retry; a new one would lose the files), an ended one `410 container_expired`, a busy one `429 too_many_commands`, and one that didn't answer `503 desktop_unavailable` with `Retry-After`. A desktop sandbox refuses exec, attach, jobs, ports and the code interpreter (`403 desktop_no_shell`); typing is audited by length only. Shapes: `desktop.schema.json` | built: `<lab>_desktop` tools for the agent start with `state` where the desktop offers it (windows and controls with the point to click) and take a screenshot just after each input action; the desktop opens in a pane where the person's clicks and keys go through the same endpoint, shown live where the lab streams it (`GET .../desktop/stream`, subprotocol `gate.desktop.v1`: a hello with the size, then binary bands of x, y, w, h as big-endian u16 and a JPEG; the engine keeps one stream per desktop while any window watches and passes bands only to those windows); archived desktops are restored, ended ones made again once; `el lab check` takes a screenshot of the named size, checks the shell and password refusals, opens the live view, reads `state`, and launches and focuses an app. Checked live at Home Lab |
| `endpoints.openapi`, `GET /v1/openapi.json` | the lab's API as OpenAPI 3.1, its component schemas taken from `contract/*.schema.json` | built: `el lab check` reads it and reports the version, paths and schemas. Checked live at Home Lab |
| `endpoints.checkpoints`, `/v1/containers/{id}/checkpoints` | whole-filesystem snapshots of a sandbox: `POST {label?}` makes one (201, `checkpoint.schema.json`), `GET` lists them newest first, `POST .../{checkpoint}/restore` brings the sandbox back to it under the same id (202 `restoring`, then `running`), `DELETE` removes one; `409 sandbox_busy` while the sandbox changes state | built: each step at a lab makes a checkpoint, and going back restores the whole sandbox to the one before that step ([history.md](history.md)); until a lab offers it, EnrichedLab keeps the history of `/sandbox/work` with git inside the sandbox, through exec. `el lab check` makes one, lists it, restores it (a file written after it is gone) and removes it |
| `packages` | the package sources the lab vets and scans: `conda` channels in order, a `pypi` simple index, a `cran` repository, an `npm` registry, and `only: true` when sandboxes reach no public source | `el lab check` checks each is an https address; EnrichedLab points its isolated environments (pixi on this computer, and in a lab's sandbox) at these when the lab names them |
| `/v1/runs` | a run at the lab: the agent loop runs on the lab's servers with the lab's models and sandbox, and keeps going while the person's computer is off. A run is the lab's own session (at Home Lab, a Rein session), so its id is the session's and there is no second state to keep. `POST /v1/runs {session, log, model, mode}` with an `Idempotency-Key` hands a session over (its log so far in the v1 format; `mode` is `attended` or `discovery`); `GET /v1/runs` and `/v1/runs/{id}` give status (`running`, `waiting`, `idle`, `finished`, `failed`, `stopped`) and what a waiting run waits on; `GET /v1/runs/{id}/events` streams its log events (SSE, `id` is the sequence, resumable with `Last-Event-ID`); `POST .../messages {text}` continues it, `.../decisions {call, allow}` answers a held call, `.../stop` stops it at the next turn boundary; `GET .../log` is the whole log. The lab keeps the run's log, files and results after its sandbox stops. Shapes: `run.schema.json` | proposed: Home Lab maps it onto Rein sessions, WHNRC onto research runs and campaigns; `el lab check` checks the `GET /v1/runs` list where the descriptor offers runs |
| `POST /v1/devices` | registers the client's device key (ES256) for sender-bound tokens; `GET` lists them; `DELETE /v1/devices/{id}` revokes one | built: proofs on every request; `el lab check` tries a proof for another token, one with a made-up nonce, one for another address, and one used twice. Behind Cloudflare Access the lab never sees the token, so the first is skipped there and the lab's nonce, tied to the sign-in, binds proofs instead |
| descriptor `sandbox_jobs`, `sandbox_exec: {max_argument_bytes, max_stdin_bytes}` | whether the sandbox runs background jobs (absent means it does), and the longest single argument and stdin one exec takes; a command past them is refused with `413 command_too_long` | built: job tools are offered only where jobs run; files go into a sandbox in 12 KiB pieces (16 KB of base64 per command) and by upload when a lab refuses a command; `el lab check` reports jobs as not offered when `sandbox_jobs` is false, and checks that a 64 KB command runs or is refused with 413 |
| `/v1/containers/{id}/ports/{port}/…` | HTTP and WebSocket into a port of the sandbox, header auth only, every app page served with `Content-Security-Policy: sandbox` | built: `<lab>_sandbox_open_port` opens the app in the browser pane through a loopback proxy that gives each port its own origin (it drops the `sandbox` directive); with a command it runs the app's server over attach, stops it after 15 minutes unused and starts it on the next visit |
| descriptor `browser: {protocol: "cdp", image?, port, version}`, `sandbox_images` | a headless Chrome reached through the port path. It runs in the person's own sandbox, so it reaches the apps they run there (sandboxes can't reach each other). With `image`, that sandbox has to be made from that image, the default plus the browser (`POST /v1/containers {image}`; one the lab doesn't list is `400 unknown_image`). The first contact may answer `503 browser_starting` with `Retry-After`; another site's `Origin` is `403 origin_refused`, so clients send none; Chrome's `webSocketDebuggerUrl` names loopback and is rewritten to the port path. `/v1/me` says what the sandbox can reach (`sandboxes.network`: `none`, `allowlist` with `hosts`, or `open`) | built: the browser tools' sandbox lane (`where: "sandbox"`), one browser context per session, shown live in a pane the person can click and type into; a session's first sandbox is made from the browser image when the browser is the first thing to need one, and `el sandbox create <lab> --image browser` switches to a new one otherwise (the old one keeps its files; within a limit of one running at once, stop it first). `el lab check` makes a browser-image sandbox, asks its browser for its version over DevTools, and checks an unknown image is refused |
| `/v1/containers/{id}/attach` | a process with stdin and output streamed over a WebSocket of JSON frames: the command first, then `{stdin}`, `{eof}`, `{signal}` in and `{stdout}`, `{stderr}`, `{exit_code}` out (124 past `timeout_seconds`, null when stopped). A first frame of `{error: {code: "busy"}}` (the bridge is full or still draining stops) or `{code: "internal"}` (the sandbox didn't confirm in 10 s) means the command never started | built: app backends in a lab session run this way (apps.md); busy and internal are tried again after 1, 3 and 8 seconds with the input sent so far; `el lab check` runs one |
| `GET /v1/apps`, `GET /v1/signers` | the app versions a person's groups may install (withdrawn ones stay listed with `withdrawn_at`), each package at `/v1/apps/{name}/{version}/package` with ETag = its sha256; and the signers the lab vouches for (`revoked_at` once revoked) | built: the Apps menu and `el apps` list them; installs check size and sha256 against the listing, then the package's signature and every file hash |

Events carry `{type, at, id, session?}` plus fields of their own. Known types: `job.finished`, `agent.finished`,
`sandbox.idle_stopping`, `sandbox.stopped`, `sandbox.archived` (`delete_after`), `sandbox.restored`,
`sandbox.deleted`, `app.published`, `app.withdrawn`, `ticket.updated`, `models.changed`, `bundles.changed`,
`quota.warning`, `signin.revoked`. A lab may add types; clients ignore ones they don't know. A lab agent's run held
for its owner carries `waiting_on: "approval"` and `approve_url` (https), on any type; EnrichedLab says the agent is
waiting and links to where to approve it.

A sandbox has a lifecycle (`status`: running, starting, stopped, archived, restoring, deleting, deleted). An idle one
stops with its files kept; the next use answers `409 sandbox_starting` with `Retry-After` while it starts, and
EnrichedLab waits and sends the request again. The person can stop a running one too, with `POST
/v1/containers/{id}/stop` (`el sandbox stop <lab> <id>`): `200` once stopped, `202` (`stopping`) while the lab still
stops it, `409 sandbox_has_jobs` while background jobs run, `409 sandbox_not_running` when it isn't running. A stopped
one keeps its files and frees its place under the lab's limit on sandboxes running at once. A lab offers this with
`endpoints.stop: true` in its descriptor; without it EnrichedLab doesn't ask. A stopped one is archived after a while
(`409 sandbox_archived`): EnrichedLab calls `POST /v1/containers/{id}/restore` (202, same id), tells the person, and
polls until it runs. A deleted one reads 404 (using it, `410 container_expired`); one still being deleted reads
`deleting`. Either way EnrichedLab starts a new one and says the old files are gone; if the lab refuses it with `429
too_many_containers` because the old one still counts, it waits up to a minute for that one to go, then asks again.

Tools and results carry two markers. `_meta["org.enrichedlab/tier"]: "unvalidated"` marks a tool no person has
reviewed yet: EnrichedLab shows it as unreviewed and asks before every call, in every permission mode. Data tools return
files as references (MCP `resource_link` with `_meta["org.enrichedlab/sha256"]`), never rows through the model, plus
`_meta["org.enrichedlab/receipt"]` on the result (inputs, code version, parameters, seed, image digest, outputs), so a
scientist can see how a result was made and run it again. The person saves a copy into their project with the checksum
checked.

## Who gets what

Access is decided at the lab, in three layers, and logged per person:

1. **Identity.** Cloudflare Access in front of every endpoint: the identity provider (an institution through
   CILogon, Google, GitHub), MFA, and device rules. Nothing reaches the cluster without passing it.
2. **Roles and groups.** The lab keeps memberships: a person belongs to groups (a research group, a project) with a
   role in each (reader, researcher, maintainer). Groups come from the identity provider or the lab's own table;
   explicit per-person grants add to them or take away. This is NIST's role-based model (INCITS 359) with
   attribute checks where data needs them (SP 800-162).
3. **Grants.** Roles grant tool groups, models, sandbox size and network, data scopes, and the most an app may ask
   for. The MCP endpoint lists only granted tools and checks each call; data tools pass the person's scope to the
   database (row-level security keyed on the session), so a grant can't be widened by a tool's arguments.

Least privilege by default: a new member gets reader, and every grant names an owner and a review date. The audit
record ties every model request, tool call and sandbox command to the person, the session and the grant that allowed
it.

## MCP on the lab

Serve MCP from the cluster, behind one endpoint that the lab controls. The 2026-07-28 revision made the protocol
stateless: no session to keep on a replica, each request carries its own authorization, and `server/discover`
replaces the handshake. A lab can run many copies behind a load balancer and serve many people at once, with the
same per-request checks as any API. Individual MCP servers (a database, a document search, a pipeline) sit behind
that endpoint on the cluster network, never exposed on their own; the endpoint holds their credentials and applies
the person's grants. Other MCP clients can use the same endpoint with the same sign-in.

## Cloudflare: what to use

| Feature | What it does | Cost | Use it? |
| --- | --- | --- | --- |
| Zero Trust Access, managed OAuth | sign-in, MFA and device rules in front of each hostname; OAuth tokens for apps like EnrichedLab | free up to 50 people | yes: the foundation |
| Tunnel | the cluster reaches Cloudflare outbound; no open ports | free | yes |
| MCP server portals | one address that gathers several MCP servers, with per-person access by server and request logs | in Zero Trust, beta | optional: for people using other MCP clients. EnrichedLab doesn't need it, and a portal grants whole servers, not single tools or rows, so the lab's own checks still decide |
| AI Gateway | a proxy for model providers (OpenAI, Anthropic and others) with logs, caching and rate limits | core free; log and guardrail limits | only for paid outside providers the lab offers. For models on the cluster it adds a round trip through Cloudflare and nothing the lab doesn't already do |
| Artifacts | versioned, Git-speaking storage for agents | Workers Paid, beta | no: a Git server on the cluster does the same and keeps research data on site |
| Workers (remote MCP servers) | small MCP servers at the edge | free tier | for public tools with no lab data |

**Git history** lives with the person: their repository on their computer, moved into a sandbox and back as a git
bundle. A sandbox keeps a working repository while it exists; anything that must outlive it goes to the lab's Git
server or comes home with the person.

**Tools in a website.** WebMCP lets a page register tools (`document.modelContext`) that an agent in the browser can
call. It's an origin trial in Chrome, with no other browser shipping it. When it settles, EnrichedLab's built-in
browser (Chromium) can call such tools, and lab websites can offer them; until then, lab tools go through `/mcp`.

**Notifications.** Webhooks fit server to server (Git pushes to the deploy controller, alerts to a chat). A person's
computer can't receive webhooks, so the lab streams their events over `GET /v1/events` and the app shows them.

## Keeping lab tokens in EnrichedLab

Anyone who can use a lab from their computer holds a credential there, and no client can stop a determined person
from copying it. The lab makes a copied token worth little:

- **Short lifetimes.** Access tokens last minutes and refresh; revoking a person ends both.
- **Sender-bound tokens.** For a lab whose descriptor lists `devices`, EnrichedLab makes a P-256 key per lab, keeps
  its private half in the OS credential store (an owner-only file where there is none), and registers the public half
  (`POST /v1/devices`, signed by that key). Every request, model and MCP requests included, then carries a DPoP proof (RFC 9449): `htm`,
  `htu` (the lab's public address even over the LAN), `iat`, a single-use `jti`, and `ath`, the hash of the exact
  bearer in that request. `policy.device_proof` is `off` (a lab staging the change: proofs it gets are still checked,
  none are asked for), `optional` or `required`. A token copied into another tool fails. Access doesn't issue
  DPoP-bound tokens, so the lab's endpoint checks the proof. On `device_unregistered` (an `optional` lab sends it too
  once the person has an approved device) the client registers a new key, which waits for approval when the person has
  another device; on `device_revoked` it stops until the person signs in again, so revoking a lost laptop sticks; on
  `device_mismatch` or `signin_stale` it asks for a new sign-in. A lab that issues nonces (RFC 9449 section 8) sends
  `DPoP-Nonce` on its responses: the client puts the latest one it got under the current token in every proof, and
  answers `use_dpop_nonce` by sending once more. Before a request it can't send twice (an upload, a WebSocket, a page's
  request through a port), it fetches a fresh nonce if its own is over 4 minutes old or came with an earlier token. A
  lab that ties its nonce to the sign-in has to tie it to something that stays the same for the whole sign-in, such
  as the identity Access verified: Cloudflare Access can deliver more than one assertion for one token, so a nonce
  bound to the whole assertion is refused at random. When the person already has a device, a new one registers as
  pending (202, `device_approval_needed`); only one waits at a time (`409 device_pending_exists`). Once a person has
  an approved device the lab wants proofs even where they're optional, so the pending computer says "approve this
  computer from one of your other devices" and tries a signed read every 5 seconds until it's approved or the request
  lapses (15 minutes). The other devices get `device.pending`; the window asks the person (Approve, or Not mine to
  revoke it) and `el devices <lab>` lists them, with `el device approve|revoke <lab> <id>`. Nothing approves on its
  own. Sign-out revokes the key (`DELETE /v1/devices/{id}`). MCP is standardizing the same profile (SEP-1932).
- **Quotas and alerts.** Per-person request and token limits, and an alert when use leaves the person's pattern.

## Classifiers and the audit record

Every model request and answer for a lab session passes through the lab. The lab screens prompts and answers
(policy, personal data, secrets) and screens tool results for injected instructions before the model sees them. It
records sandbox commands, keeps a hash of each event in the audit record, and keeps the full text only where policy
allows. Groups decide what their members may do with agents: which tools, whether sandboxes have network, which
models, how much. Sessions bound to a lab call `POST /v1/guard` on their own text too, so app messages and pasted
content go through the same checks.

## Sandboxes, apps and Shiny on the cluster

- **Lifecycle.** A sandbox belongs to one person. Idle for an hour, it stops: the compute is freed and its volume
  kept. Stopped for 14 days, its work is archived (the git repository as a bundle, and files not already in the lab's
  data store) and the sandbox is deleted; opening the session restores it into a new sandbox. Archives older than 90
  days are deleted after a notice, and the person can download one at any time. Nothing lingers and nothing is lost
  silently.
- **Environments.** An app's `pixi.toml` and `pixi.lock` build the same R or Python environment on a laptop and in
  the lab's image builder, so an app that runs locally runs in the sandbox.
- **Shiny and other served apps.** The app's server runs in the sandbox; the lab tunnels its port
  (`/v1/containers/{id}/ports/{port}`) and EnrichedLab shows it in a pane. The person signed in once in EnrichedLab,
  so the page needs no second sign-in in a browser.
- **Apps for groups.** A maintainer publishes a signed `.labapp` to `/v1/apps` for a group; members see it in their
  Apps menu and install it with one click. The lab says the most an app may ask for (no commands, read-only files)
  and refuses packages that ask for more. Removing a version or a signer withdraws it.

## Adding a kind of lab

A different server (a research broker, a university gateway) is one `SiteAdapter`: sign-in, models, tools, sandbox.
Register it in `SITE_KINDS` (`packages/engine/src/sites/adapter.ts`); sessions, places and apps work unchanged.
