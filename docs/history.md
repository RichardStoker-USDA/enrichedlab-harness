# Step history

Every step an agent takes that can change files is kept, so the person or the agent can go back to before any step
and try again. It is what lets the `auto` approval mode run file changes and contained commands without asking
([security.md](security.md#how-much-it-asks)).

## What is kept, and when

A session keeps the folder it works in at the start of each turn and after every step that wrote a file or ran a
command (`packages/engine/src/session/history.ts`). Each point is a `checkpoint` event in the session log with its
`history` commit, so the run sheet can offer "Go Back to Before This Step" on every step.

- **Where.** On this computer, in a git store of EnrichedLab's own at `~/.el/history/<folder id>`, one per folder. The
  person's own repository in that folder is never touched: no commits, refs, index or stash. In a lab's sandbox, the
  same store sits at `/sandbox/.el-history`, run through the sandbox's shell, and lives as long as the sandbox's files.
- **Sessions apart.** Each session keeps its own index and its own line of commits (`refs/sessions/<id>`); the
  objects are shared, so a file kept once is kept once.
- **Fast after the first.** The index remembers each file's size and time, so a snapshot hashes only what changed.
- **Everything the person made.** Ignore files don't apply: a data folder a repository ignores is what a person
  would want back.
- **Byte for byte.** Git attributes are off in the store (`info/attributes`), so line endings and filters never
  change what comes back.
- **Not kept, and said so.** Files over 25 MB, new data past 1 GB in one snapshot (the first snapshot of a large data
  folder stops there and lists what it left out in the event's `skipped`), repositories inside the folder (kept as a
  pointer, not their files), names with line breaks in a lab sandbox, and folders tools rebuild (`node_modules`,
  virtual environments, `.pixi`, caches). Each commit names what it left out on its own `el-kept-out` line, so going
  back to it, or from it, leaves those as they are, whether they were too large then or now, along with any folder
  holding them and any file that would take the place of such a folder.
- **One at a time.** Snapshots and restores of one folder take turns, and going back holds its session like a turn.

## Going back

`session.rewind {sessionId, before, retry?}` puts the folder back as it was at the newest point before the step
`before` (an event id). Files changed since come back, files made since go. The present is kept first, as its own
point, so going back can itself be taken back (rewind with `before` set to the `rewind` event's id returns to it);
the session's line goes on from there, and a `rewind` event records what changed. Files go first, while the folder
is as the present has it, and never through a link, so a link the target brings back can't carry a removal outside
the folder. The model is told on its next request.

Undo keeps each file it writes over as it is just before (`undo.kept`, beside the session log), so undo can be
taken back too. It puts back files outside the folder from their per-file copies first, while links in the folder still lead where
they did, and only where the path still leads to the file that was kept; through a link, it acts on the file the link
led to. After a move, undo touches nothing where the session was. If a snapshot's list of what it left out can't be
read, going back stops rather than guess; folders emptied by going back give way to the file that comes back.

With `retry`, a new session continues from just before that step: the conversation up to there, the same folder
and model, titled "Retry: …". The original stays as it was, so both tries can be compared. On this computer for now;
at a lab, go back and continue in the same session.

Undo (Session ▸ Undo Last Changes) goes back to the start of the last turn the same way, shell changes included.
Sessions from before step history keep their older undo (per-file copies, or a git snapshot in the repository).

History belongs to the place it was kept in: after a session moves to a lab or back, steps from before the move
can't be brought back where it works now.

## At a lab

A lab sandbox keeps history with git inside the sandbox, through exec, for `/sandbox/work`. A lab that serves
whole-disk checkpoints (`endpoints.checkpoints`, [labs.md](labs.md)) covers the rest of the sandbox too, and there
`auto` runs any command, since all of it can be taken back, once a checkpoint has been made and while the last one
worked. Going back at a lab uses the project's own history by default. Putting the whole sandbox back from its
checkpoint is a separate choice ("Go Back the Whole Sandbox…", `session.rewind` with `whole`), because every
folder in the sandbox goes back with it, other sessions' projects included. If the lab can't make one (quota, an outage), the session says so and commands outside the project ask again
until a checkpoint works. Checkpoints go on when git history fails. Going back from a go-back
there returns to the checkpoint it made of the present (`rewind.whole`).
