# Git and bundles

How EnrichedLab handles git on a person's computer and in a lab sandbox, and how add-ons reach each person. Code:
`packages/engine/src/git.ts`, `permissions.ts`, `sites/gate.ts`, `bundles.ts`.

## Git on the person's computer

- **Undo covers everything.** In a git repository every turn starts with a snapshot of the working tree (tracked and
  untracked files, `.gitignore` honored) as a commit on `refs/enrichedlab/checkpoints/<session>`, written through a
  temporary index. `/undo` restores it, so changes made by shell commands come back too. The person's index, branch
  and history never change. Outside git, undo uses per-file copies.
- **A worktree per writing agent.** `el --worktree` (and every subagent started in mode `full` inside a
  repository) works in `<repo>/.git/enrichedlab-worktrees/<id>` on its own branch `enrichedlab/<title>-<id>`. Parallel
  agents never write over each other or the person's checkout. `el worktrees` lists them; `--prune` removes the
  ones merged into the current branch.
- **What asks.** In its own recorded worktree the agent edits files and uses the built-in `git_commit` tool without asking.
  File tools reject `.git` paths. With the local sandbox on, macOS shell commands also reject them. Linux shell
  commands can write the worktree. Existing regular `.git` entries are bound read only, existing `.git` symbolic
  links refuse launch, and normal completion moves new entries aside after all background children end. A new
  `.git` exists until cleanup. Before launch the engine records what existed, so a crash or failed cleanup leaves the
  project blocked from contained shell commands until an anchored quarantine pass succeeds; see [security.md](security.md).
  `git_commit` stages all changes and commits
  through an isolated staging repository, then rechecks the recorded repository, worktree admin directory, branch
  and old commit before advancing only that branch. Its staging scratch is not in the temp folder agent commands can
  write, and project helpers have no shared metadata write grant. Outside the
  session's recorded worktree the question names the repository and branch it covers, except that Allow Everything
  keeps its no-question behavior with the same target checks. Worktrees need Seatbelt or bubblewrap;
  elsewhere sessions work in the checkout. `git push` (and `send-pack`, `svn dcommit` and the like) asks in every
  mode, every time, and "allow for this session" doesn't
  cover it; `el run` refuses pushes unless `--push` is given.
- **Commit messages** follow the prompt's rule: one imperative subject under 80 characters, no attribution footer.

## Git with a lab sandbox

- `<site>_sandbox_repo_send` packs the repository as a git bundle: HEAD plus one commit holding uncommitted and
  untracked files, with files named like secrets (`.env`, `*.pem`, `id_*`, credentials) left out. The sandbox
  unpacks it on branch `work` under `/sandbox/work/<repo>-<id>`. Sending asks once.
- The agent works there with `<site>_sandbox_run` and commits.
- `<site>_sandbox_repo_fetch` commits anything left uncommitted (as the person, from their git identity), packs the
  new commits, and fetches them as local branch `enrichedlab/<site>-<id>`. The working folder and other branches don't
  change; the person reviews with `git diff HEAD...enrichedlab/<site>-<id>` and merges.

Checked against a lab sandbox running git 2.43: uncommitted work went over, a sandbox commit came back as a
branch, and `main` was untouched.

## Bundles

A bundle is one installable add-on: skills, instructions, MCP servers, hooks and model settings. It is a folder with
either layout:

```
bundle.json                   { "name": "lab-basics", "version": "1.2.0", "description": "…",
                                "skills": "skills", "instructions": "AGENTS.md",
                                "mcpServers": { "tools": { "command": "${BUNDLE_ROOT}/bin/serve" } },
                                "hooks": { "afterTool": [{ "match": "edit", "command": "${BUNDLE_ROOT}/fmt.sh" }] },
                                "models": { "lab/some-model": { "defaultEffort": "low" } } }
.claude-plugin/plugin.json    the common agent-plugin layout: skills/, .mcp.json, hooks/hooks.json
```

Reading the plugin layout means the existing ecosystem of skills and MCP add-ons installs without conversion; its
hook matchers are mapped to EnrichedLab tool names (`Bash` to `shell`, `Write` to `write`, `Edit` to `edit`).

- **From the person.** `el bundle add <folder | https git address>`, `el bundles`,
  `el bundle remove <name>`. Copies go to `~/.el/bundles/<name>/` with a sha256 over their files in
  `~/.el/bundles.json`. A running engine reloads at once.
- **From a lab.** After sign-in the engine asks the site adapter for grants (Gate: `GET /v1/bundles`, answering
  `{ "data": [{ "name", "version", "files": [{ "path", "content", "base64"? }] }] }` chosen by the person's role,
  group or project; 404 means none). They land in `~/.el/bundles/<site>.<name>/` and leave when the site stops
  granting them. A site's bundle never runs programs on the person's computer: its hooks and command-started MCP
  servers are dropped. An isolated site's bundles apply only to sessions bound to that site.
- **Precedence.** The person's own `config.json` wins on any MCP server or model name a bundle also defines. Bundles
  never change permissions.

A bundle can also carry apps in `apps/<name>/`, which is how a lab hands a group its tools (docs/labs.md).

Open: labs serving `/v1/bundles`, signing bundles, and a bundle page in the window.
