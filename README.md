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

> **Status:** in development. Milestones M0 (import and baseline) and the
> runtime half of M1 are complete; see [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)
> for the honest per-item state and [`docs/runtime-validation.md`](docs/runtime-validation.md)
> for the verified environment facts.

---

## What works today

- The complete upstream MiniBots engine and UI are imported and running
  (**343/343 upstream tests pass** on Windows).
- The Pi 1.4.0 SDK is verified to load and work inside the Electron utility
  process that hosts the backend (**32/32** Node checks, **10/10** Electron
  checks).
- The model-catalogue contract between the engine, the settings UI, and the
  agent runtime is pinned by tests.

The desktop shell, the Pi adapter, credential storage, and the installer are
still to come.

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
npm run test:upstream  # run the imported upstream suite
npm run test:smoke     # verify the Pi SDK surface on Node
npm run test:smoke:electron  # verify it inside the Electron utility process
npm run typecheck      # type-check the new TypeScript
```

`npm run dev` launches the desktop shell once the Electron shell lands.

---

## Layout

```text
vendor/minimax-bot/      the imported upstream Mini App (MIT, attributed)
  miniapp/client/        the existing UI — preserved verbatim
  miniapp/node/          the engine: groups, helpers, memory, schedules, tools
  miniapp/node/miniapp-api.ts   the agent contract the Pi adapter implements
  tests/                 the imported upstream suite
src/                     the new desktop, backend and runtime code
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
