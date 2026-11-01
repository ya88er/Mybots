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

> **Status:** milestones M0–M6 are complete. The Windows installer is built and
> verified against the **built artifact**, not just the source tree. See
> [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) for the honest per-item state and
> [`docs/runtime-validation.md`](docs/runtime-validation.md) for the verified
> environment facts.

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
- **A per-user Windows installer**, and the **packaged app** is verified by
  running it: the window appears, the client renders with its stylesheet, the
  backend answers, and the page's own API calls are authenticated
  (**34/34 checks**, `npm run verify:package`).

## What is not done yet

- **The live provider rows are UNTESTED.** No provider key is configured on
  the build machine, so `npm run test:providers` reports `UNTESTED` with a
  reason. It is not a pass. The key is entered in the app's provider
  settings, never in chat.
- **The installer has not been run from a path with spaces and Unicode**, and
  an upgrade that preserves the data has not been measured. Both need the
  installer to be installed twice.
- **The executable keeps Electron's own icon.** Writing it needs Developer
  Mode or administrator rights. The installer and the Start menu entry carry
  the app's own icon.

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

### Installing the app

Run `release/MiniBots-Setup-0.1.0-x64.exe`. It is a **per-user** installer:
no administrator rights, no UAC prompt, and your data is kept if you
uninstall. `release/SHA256SUMS.txt` holds the installer's checksum, in the
format `sha256sum` understands.

[`docs/operations.md`](docs/operations.md) is the full guide: first run,
setting up a provider, where your data lives, start at sign-in, the tray,
troubleshooting, the log, and crash recovery.

### Building it from the source

```bash
npm ci                 # install the pinned dependency graph
npm run build          # compile the app into dist/
npm run dev            # launch the desktop shell
npm run dist:win       # build the Windows installer into release/
```

## Testing

```bash
npm run typecheck          # four configurations: the tree, the build, the preload, the shim
npm run test:runtime       # the pure runtime units
npm run test:integration   # the real backend, the real upstream server, the real Pi loop
npm run test:desktop       # the desktop's own units
npm run test:upstream      # the imported upstream suite
npm run test:smoke         # the Pi SDK surface on Node
npm run test:smoke:electron  # the Pi SDK surface in the Electron utility process
npm run test:smoke:shell   # the whole desktop shell, end to end
npm run test:providers     # the opt-in live provider check
npm run verify:package     # the built artifact: its contents, and the app running
```

`npm run test:providers` is **not** part of `npm test`: it costs money and
needs a key. It reports `UNTESTED` with a reason when no key is configured,
and it never reports an untested provider as a pass.

`scripts/verify-all.ps1` runs the whole suite in one go, and clears any
stray Electron process first — a leftover one holds the app's single-instance
lock and makes the next run quit before it writes a single check.

The Electron tests write their report to a file, because Electron on Windows
does not write to the console of a GUI application:

| Report | Written by |
|---|---|
| `shell-smoke-report.txt` | `npm run test:smoke:shell` |
| `desktop-tests-report.txt` | `scripts/desktop-tests.mjs` |
| `package-verification-report.txt` | `npm run verify:package` |

The app writes its own log at `%APPDATA%\minibots\minibots.log`.

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
docs/                    plan, acceptance report, runtime validation, operations guide
```

`vendor/minimax-bot/UPSTREAM.md` records where the import came from, and
`vendor/minimax-bot/MODIFICATIONS.md` lists every change made to it. The full
licence inventory is in [`docs/LICENSES.md`](docs/LICENSES.md).

---

## Credits and licence

The MiniBots Mini App is by **MiniMax** and is used under the MIT licence; the
original notice is kept at `vendor/minimax-bot/LICENSE`. This port is a derived
work and retains that notice — and the notice travels with the shipped app.

The agent runtime is [Pi][pi] by earendil-works, also MIT-licensed.

[upstream]: https://github.com/MiniMax-AI/MiniMax-Code-MiniApps
[pi]: https://github.com/earendil-works/pi
