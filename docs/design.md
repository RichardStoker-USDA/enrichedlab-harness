# Design

The interface direction. Later work extends it; it doesn't average it away.

## The idea: a lab workbench

EnrichedLab's product is work done in front of the person: what the agent did, where it ran, why it was allowed to,
and what it made. Three regions carry that, and nothing else competes with them.

- **The rail** is orientation: which places this person can work in (this computer and each lab they belong to), their
  projects, and each project's sessions. It answers "where am I and what's running" at a glance.
- **The run sheet** is the record: the person's request, the agent's thinking, its steps grouped as one activity per
  stretch of work, and its answer, typeset for reading. Every step keeps its decision and result on one ruled line.
- **The workbench** is where results are used as well as seen: interactive tables, GPU-drawn plots, R and Python
  figures and widgets, live apps, a browser, a terminal, the place's files. Panes tile, tab and split; the person
  arranges them and the arrangement is kept per session.

The terminal surface is the same run sheet drawn in characters, with the same marks and words.

## Places

Where work runs is the first thing the interface says, because a scientist must know whether code touches their own
computer or the cluster that holds the data.

- Every session has a place, named in plain words in its header: "This Mac · contained", or "<lab> sandbox" with
  the lab's own name. The header's place switch moves the session (a git repository comes along).
- Each place has a color used only as a marker: a 2 px line across the top of the run sheet, the dot beside the place
  in the rail, the pane label for work that ran there. This computer is neutral; the first lab is Aggie Blue (Aggie
  Gold in dark mode); a lab that keeps its data inside is UC Davis Redwood `#266041` (Sage `#6CCA98` in dark mode).
  Further labs take Putah Creek `#008EAA` and Tahoe `#00B2E3`. The color is never the only signal: the name is
  always beside it.
- A lab that keeps data in place shows its place as fixed: the switch says why it can't move.

## The seven axes

| Axis | Committed to | Why |
|---|---|---|
| Composition | Three regions (rail, run sheet, workbench), tiling panes, no floating windows | Pro tools that people live in all day tile; free windows make people manage windows instead of work |
| Color | White and Aggie Blue in light; black, UC Davis black tints and Aggie Gold in dark (BFI Index); place colors as markers only | UC Davis identity; the one extra hue per place earns its place by orienting |
| Type | System UI (SF Pro, Segoe UI Variable); prose 15.5/1.6 at a 70-character measure; prompts 18/1.35 semibold; mono 12.5 for steps, code and data | Reading quality first; the run sheet is mostly reading |
| Density | Comfortable in the run sheet, compact in the rail and panes (28 px rows, 12.5 px data) | Reading and scanning are different jobs |
| Depth | Hairline rules between regions and panes; one soft shadow for things that float (menus, the command palette); translucent rail material in the desktop window | Flat regions read as one instrument; only transient things lift |
| Motion | Short and purposeful: the live rail grows, panes slide in once, the palette scales from 98%, the place line sweeps when a move completes | Each motion confirms something happened; nothing loops |
| Voice | Plain words: "Runs on", "Move to", "Allow for this session"; no product jargon in the interface | People without agent experience must read it cold |

**The deliberate outlier:** the plot pane draws with WebGPU (WebGL2 or Canvas 2D as fallbacks). It is the one dense,
luminous surface in the product: a million measured points with pan, zoom and hover at frame rate. It is earned
because it is data, not decoration.

## Run sheet typesetting

- A turn: the prompt as a heading in the person's words; then the agent's work.
- Thinking streams in small faded type, folds to "Thought for 12 s" when the step ends, and opens on click.
- Steps group into one activity block per stretch between answers: a summary line ("Read 4 files, ran 2 commands,
  edited geom.py") over the ruled step lines. Edits show their diff; commands show output on demand.
- Answers: real typesetting. Headings, lists, tables with tabular numbers, block quotes, and code with syntax
  highlighting, a language label and a copy button. Views the agent shows appear as a line that opens their pane.
- An approval opens inline at its step: the exact command or change, then Decline, the remembered answer naming what
  it covers ("Allow “python3” Commands This Session", or "Allow Changes in “project”" for a folder not answered for
  yet), and Allow Once.

## The workbench

- Pane kinds: View (agent-made HTML, R and Python widgets, figures), Table (sort, filter, column statistics, copy,
  millions of rows virtualized), Plot (WebGPU), App (a running Shiny, Streamlit or dev server), Browser (a real
  browser in the desktop app, or a lab sandbox's browser shown live and marked with that lab's color), Terminal (the
  person's shell on this computer; a command console in a lab sandbox), Files (the place's folder, opening data as
  tables).
- Drag a tab to an edge to split; drag a gutter to resize; the layout is remembered per session.
- When a view arrives, it opens as a tab in the most recent pane group; the workbench opens if it was closed.
- On a phone the workbench is a full-height sheet with its tabs across the top.

## Identity

No logo mark anywhere in the interface: the wordmark "EnrichedLab" set in the UI face, semibold. The browser tab and
app icon use a lowercase "e" in Aggie Gold on Aggie Blue, nothing more.

## Refused

Chat bubbles, avatars, a hero greeting, cards of suggested prompts, gradient or sparkle marks, glowing borders,
tinted status badges, floating desktop-style windows, a dashboard of tiles, spinners and blinking dots, neon
palettes, decorative WebGPU effects, and any upstream harness's layout, names or assets.

## Rebuild, November 2026

Rich's verdict on 0.2.10: the window feels clunky and nothing like a native Mac app; menus aren't polished; there's
no visible place to drag the window; light mode's contrast makes it hard to tell what is what; there is no right-click
anywhere; and moving between this computer and the clusters "makes 0 sense". The rebuild keeps the three regions and
the session logic, and changes how they look and behave:

- **Window.** A real title-bar strip on every region header (drag anywhere that isn't a control, double-click to
  zoom, as macOS does), traffic lights given their own space, and the sidebar on the system's sidebar material.
- **Menus.** A native application menu (File, Edit, View, Session, Window, Help) carrying every command with its
  shortcut, and native context menus: text fields (cut, copy, paste, look up, spelling), sessions (rename, move,
  reveal folder, delete), files, tabs and messages.
- **Contrast.** Light mode rebuilt for WCAG AA on every text and control role; borders and fills strong enough to
  separate surfaces; one accent per state.
- **Places.** Where a session runs is chosen in the composer, beside its model: this computer or a lab's sandbox,
  each with its sign-in state. Moving a session shows what moves (the project folder, or only the conversation)
  before it runs; the model stays the same. The sidebar lists the places; each row signs in or opens that place's
  actions. Models are filtered to the ones the session's place allows.
- **Layout.** The workbench stays beside the session while both fit at 360 px: from 984 px with the sidebar and from
  720 px without it. Between 861 and 983 px the sidebar steps aside while the workbench is open and comes back when it
  closes; asking for it then floats the workbench over the session instead. Under 720 px the workbench covers the
  window.
- **Sheets and notices.** Settings, Model services, Add a lab, device requests and confirmations hang from just under
  the toolbar at one position. Notices show above an open sheet.
- **Every screen.** New session, run sheet, composer, model menu, Model services, Add a lab, workbench panes (files,
  terminal, browser, tables, plots, apps, views), palette, settings and every dialog, each in all nine states, light
  and dark, at phone and desktop widths; then an independent review by GPT-6 Astra.
