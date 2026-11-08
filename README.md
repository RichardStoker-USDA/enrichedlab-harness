# EnrichedLab harness

The EnrichedLab app for your computer: an AI workbench for research. You ask for something in plain words; an agent
works on it with your files, a browser, R and Python, and the models, tools and sandboxes of the lab you belong to.
Results appear beside the conversation as tables, plots, pages, and apps you can keep using.

It runs on macOS, Windows 11 and Linux, installs without administrator rights, and works the same from its window or
from a terminal.

## Install

Download the file for your computer from the [latest release](https://github.com/RichardStoker-USDA/enrichedlab-harness/releases/latest)
and open it:

| Computer | File |
| --- | --- |
| Mac (Apple silicon or Intel, macOS 15 or later) | `EnrichedLab-mac.pkg` (installs into your home folder) |
| Windows 11 | `EnrichedLab-Setup-x64.exe` (installs for you only) |
| Linux | `EnrichedLab-linux-x64.AppImage` or `-arm64` |

Terminal only, on macOS or Linux:

```sh
curl -fsSL https://github.com/RichardStoker-USDA/enrichedlab-harness/releases/latest/download/install.sh | sh
```

Updates are signed and install themselves the same way: the app offers them, `el update` applies them.

## First run

- **Your lab sends an invite link.** Open it; EnrichedLab adds the lab and opens the lab's sign-in page. Its models,
  tools and sandbox appear once you're signed in. In a terminal, `el join '<invite link>'` does the same. The first
  sign-in may ask you to set up a second step: a passkey, a security key or an authenticator app.
- **Your ChatGPT plan.** Choose *Continue with ChatGPT* under *Model services* in the model menu (or run
  `el service add chatgpt`). Requests then use the usage included in your plan.
- **Your own key.** Add an OpenAI, Anthropic, Google Gemini or OpenRouter key in the same place. Keys go to your
  computer's credential store.
- **On this computer.** Models running in Ollama, LM Studio, llama.cpp, MLX, oMLX, vLLM, SGLang or Foundry Local
  appear on their own. With Ollama installed, `el local` suggests open models that fit your computer and `el model pull <name>`
  downloads one (the window does the same under *On this computer*).

## What it does

- **Conversation and workbench.** Files, a terminal, tables, GPU-drawn plots and a browser open in panes beside the
  session.
- **Apps on request.** Ask for "an app to compare yield by treatment" and the agent builds one that runs in a pane.
  Apps can be web pages, R or Python Shiny apps, or containers, and you can share them as signed files
  ([docs/apps.md](docs/apps.md)).
- **The web and PDFs.** The agent can open pages in the built-in browser, where your sign-ins persist, or in a
  browser in your lab's sandbox, which has none of your sign-ins and which you watch live in a pane. It can also
  fill PDF forms.
- **Where work runs.** Each session works on this computer or in a lab sandbox, and can move between them, taking
  its git repository along. A lab that keeps its data inside pins its sessions there.
- **Contained by default.** On macOS and Linux the agent's commands can write only to the project and temp folders,
  can't read your credential folders, and have no network unless you allow it; anything that would run outside that
  asks first, unless you listed it or chose Allow Everything. On Windows they can write only to the project and temp folders, can read your credential folders, and
  ask before they run ([docs/security.md](docs/security.md)).

## Terminal

```sh
el                       # a session in this folder; the window opens when the agent shows something
el app                   # open the window
el run "task"            # one task, no interface; --allow lets it edit and run commands
el join '<invite link>'  # add a lab from its invite and sign in
el login <lab>           # sign in to a lab you've added
el local                 # model servers here, and open models that fit this computer
el service add chatgpt   # use your ChatGPT plan; or add a key: el service add gemini
el doctor                # check the setup
```

`el help` lists the rest.

## For labs and developers

- [docs/labs.md](docs/labs.md): serving models, MCP tools, sandboxes and apps to groups of people, with
  per-person access.
- [docs/architecture.md](docs/architecture.md): how the engine, the window and the terminal fit together.
- [docs/development.md](docs/development.md): building, testing, benchmarks and releases.

Build from source with [Bun](https://bun.com) 1.4: `bun install && bun scripts/build.ts`.

## License

[CC0 1.0](LICENSE): public domain. No permission needed to use, change or share it.
