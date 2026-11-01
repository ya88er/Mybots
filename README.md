# MiniBots

A standalone Windows desktop app for multi-bot AI collaboration.

MiniBots reproduces the full feature set of the [MiniMax Bot Mini App][upstream]
— Chief, teams, groups, helpers, schedules, per-bot and team memory, media
cards, reactions, 11 looks, and an English/Chinese interface — as a native
Windows application that runs on your own DeepSeek, MiniMax, or OpenAI API
keys.

It is built on the [Pi coding-agent SDK][pi]: Pi owns the model conversation,
the tool loop, context compaction, retries, Skills, and MCP. MiniBots owns the
collaboration layer. **No replacement model or tool loop is implemented here.**

> **Status:** in development. Milestones M0–M5 are complete; see
> [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) for the honest per-item state and
> [`docs/runtime-validation.md`](docs/runtime-validation.md) for the verified
> environment facts. The installer is M6.

---

## What works today

- The complete upstream MiniBots engine and UI are imported and running
  (**343/343 upstream tests pass** on Windows), and the desktop shell serves
  the real client — styled, interactive, and authenticated.
- The Pi 1.4.0 SDK drives the real model loop inside the Electron utility
  process that hosts the backend (**32/32** Node checks, **10/10** Electron
  checks).
- Provider keys are stored encrypted with the operating system's key store,
  and never leave the main process.
- A durable dispatch ledger, a durable session index, and a schedule catch-up
  record survive a restart.
- A tray icon, a window that hides instead of closing, and a start-at-sign-in
  preference.

## What is not done yet

- **The live provider rows are UNTESTED.** No provider key is configured on
  the build machine, so `npm run test:providers` reports `UNTESTED` with a
  reason. It is not a pass. The key is entered in the app's provider
  settings, never in chat.
- **The installer is not built.** The packaged-build checks — Pi's runtime
  assets under Electron's ASAR restrictions, the installer under a path with
  spaces and Unicode, the installed app's start-at-sign-in entry — are M6.

---

## Requirements

| Requirement | Version | Notes |
|---|---|---|
| Windows | 10/11 x64 | the only supported target today |
| Node.js | 22.19.0 or newer | for building; the packaged app bundles its own runtime |
| Git | any recent | for the source |
| Git Bash | optional | only needed if a selected Pi tool requires it; PowerShell works without it |

The packaged application does **not** require a machine-wide Node.js or Pi
installation.

---

## Getting started

```bash
npm ci                 # install the pinned dependency graph
npm run build          # compile the app into dist/
npm run dev            # launch the desktop shell
```

## Testing

```bash
npm run typecheck          # three configurations: the tree, the build, the preload
npm run test:runtime       # the pure runtime units
npm run test:integration   # the real backend, the real upstream server, the real Pi loop
npm run test:desktop       # the desktop's own units
npm run test:upstream      # the imported upstream suite
npm run test:smoke         # the Pi SDK surface on Node
npm run test:smoke:electron  # the Pi SDK surface in the Electron utility process
npm run test:smoke:shell   # the whole desktop shell, end to end
npm run test:providers     # the opt-in live provider check
```

`npm run test:providers` is **not** part of `npm test`: it costs money and
needs a key. It reports `UNTESTED` with a reason when no key is configured,
and it never reports an untested provider as a pass.

The Electron tests write their report to a file, because Electron on Windows
does not write to the console of a GUI application:

| Report | Written by |
|---|---|
| `shell-smoke-report.txt` | `npm run test:smoke:shell` |
| `desktop-tests-report.txt` | `scripts/desktop-tests.mjs` |

---

## Layout

```text
vendor/minimax-bot/      the imported upstream Mini App (MIT, attributed)
  miniapp/client/        the existing UI — preserved verbatim
  miniapp/node/          the engine: groups, helpers, memory, schedules, tools
  miniapp/node/miniapp-api.ts   the agent contract the Pi adapter implements
  tests/                 the imported upstream suite
src/                     the new desktop, backend and runtime code
  main/                  the Electron main process, the preload, the tray, the keys
  backend/               the utility process, the authenticated loopback, the app's routes
  runtime/               the Pi adapter, the session index, the dispatch ledger
  tools/                 the MiniBots business tools as Pi custom tools
  app-ui/                the app's own window: provider settings and the inspectors
tests/                   new tests for the port
scripts/                 build, verify and smoke-test tooling
docs/                    plan, acceptance report, runtime validation
```

`vendor/minimax-bot/UPSTREAM.md` records where the import came from, and
`vendor/minimax-bot/MODIFICATIONS.md` lists every change made to it.

---

## Credits and licence

The MiniBots Mini App is by **MiniMax** and is used under the MIT licence; the
original notice is kept at `vendor/minimax-bot/LICENSE`. This port is a derived
work and retains that notice.

The agent runtime is [Pi][pi] by earendil-works, also MIT-licensed.

[upstream]: https://github.com/MiniMax-AI/MiniMax-Code-MiniApps
[pi]: https://github.com/earendil-works/pi
