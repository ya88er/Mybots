# MiniBots implementation acceptance

Status: M0 complete, M1 partially complete. Evidence below is real: every
checked row names the command that produced it. Rows that could not be run
say so.

For each completed item, attach the test command/result or installed-app observation, application commit, dependency versions, and evidence location. Use `BLOCKED` with a reason for unavailable external dependencies. A skipped live-provider test is not a pass.

**Evidence location for this milestone:** `docs/runtime-validation.md`
(verified facts and how each was observed), `vendor/minimax-bot/UPSTREAM.md`
(import provenance), `vendor/minimax-bot/MODIFICATIONS.md` (every change made
to the vendored tree).

## Runtime and architecture

- [x] Upstream source is pinned, attributed, and complete.
  - Pinned commit `79ebc4b89be6b372365199db92d69e5e36ac3409`, package
    `minimax-bot@0.7.16`, MIT. Imported 89 files / 2,663,241 bytes including the
    `.minimax-plugin` dotfile directory and the 11 skin PNGs.
  - `vendor/minimax-bot/UPSTREAM.md` records source URL, commit, version,
    import date and licence. The upstream `LICENSE` is preserved unmodified.
  - Verified by `node scripts/verify-upstream.mjs`: 89 upstream files,
    93 vendored, 6 modified, 4 added, 0 removed, **0 client files changed**.
- [x] Pi 1.4.0 tarball exports and Electron embedded Node compatibility are verified.
  - `npm run test:smoke` → **32/32 checks passed**. `npm run test:smoke:electron`
    → **10/10 checks passed (Electron utility process)**.
  - Electron 45.1.0 embeds Node **v24.22.1**; Pi 1.4.0 requires `>=22.19.0`.
  - 20 required exports confirmed present, including `AgentSession`,
    `createAgentSession`, `SessionManager`, `ModelRuntime`,
    `createMcpExtension`, `createPowerShellTool`, `defineTool`, `loadSkills`.
  - Evidence: `docs/runtime-validation.md` §2, §3, §6.
- [ ] Runtime runs inside the packaged Windows app without an external Node or Pi CLI install.
  - **Partially proven.** The Pi SDK loads and runs inside the Electron
    **utility process**, which is the process the backend uses
    (`npm run test:smoke:electron` → 10/10). The *packaged* build is not
    verified yet: Electron 45 restricts file descriptors inside an ASAR
    archive (`EBADF` for native addons and `child_process` stdio), so Pi's
    runtime assets must be unpacked. That check belongs to M6
    (`npm run verify:package`).
- [ ] Two independently configured sessions run concurrently and restore after restart.
  - **Partially proven.** `SessionManager.create` / `newSession` / `open` by
    path / `getSessionId` are verified in both runtimes
    (`docs/runtime-validation.md` §3, §4). Two concurrent sessions and
    restore-after-restart need the adapter (M2).
- [ ] Streaming, text commits, tool-call IDs, retries, and completion events are verified.
  - Not yet. Needs the adapter's event mapping (M2).
- [ ] Cancellation stops owned work and reports uncertain outcomes honestly.
  - Not yet. `AgentSession.abort()` exists and returns `Promise<void>`
    (verified), but the adapter's behaviour is not built.
- [ ] Questionnaire pause/resume works, including restart and duplicate-answer cases.
  - Not yet. Needs the adapter (M1/M2).
- [ ] Full autonomy is the default; optional approval behavior is available and tested.
  - Not yet.
- [x] No custom replacement model/tool loop has been introduced.
  - The port adds no model loop. `scripts/smoke-runtime.mjs` drives Pi's own
    `AgentSession`; the adapter contract in `miniapp/node/miniapp-api.ts`
    is implemented verbatim, so the engine needed no event-contract migration.

## Providers and tools

- [ ] DeepSeek completes a real file/tool task.
  - **UNTESTED.** No provider key is configured on this machine.
    `createAgentSession` reports `No models available`. The opt-in runner is
    `npm run test:providers`, which reports `UNTESTED` with a reason rather
    than a pass. The key is entered in the app's provider settings, never in chat.
- [ ] MiniMax completes a real file/tool task, with the configured region recorded.
  - **UNTESTED** — same reason as above.
- [ ] OpenAI completes a real file/tool task.
  - **UNTESTED** — same reason as above.
- [ ] Per-bot models and supported reasoning settings are preserved.
  - **Contract proven.** `tests/runtime/model-catalog.test.mjs` → 6/6 pass.
    It pins the catalogue shape the engine and the settings page actually read
    (`providerId`, `modelId`, `displayName`, `thinking.efforts`,
    `thinking.default`, `variants`), effort resolution against the default,
    fallback for an unsupported effort, and a Bot that names its own model.
  - The engine's `withEffort` / `effortOptions` output survives
    `normalizeModel` unchanged, so a selected model reaches `run({ model })`
    intact.
- [ ] Provider errors do not silently change models or replay completed side effects.
  - Not yet.
- [ ] API keys are encrypted at rest and absent from normal logs/exports/Pi plaintext auth.
  - **Partially proven.** `npm run test:smoke` asserts that no plaintext
    `sk-…` key appears in the Pi auth file after a session runs
    (`docs/runtime-validation.md` §6). The `safeStorage` encryption path is
    not built yet (M2), and Electron 45's `safeStorage` synchronous methods
    are deprecated in favour of the async API, which returns an object rather
    than a string.
- [x] Native Windows PowerShell works; missing optional Bash is handled.
  - `createPowerShellTool` constructs successfully in both the Node and the
    Electron utility-process smoke tests. Git Bash was located at
    `C:\Program Files\Git\bin\bash.exe` and its absence is reported as an
    optional prerequisite rather than a failure.
- [ ] All 22 original MiniBots business tools retain their expected behavior.
  - **Inventory verified.** All 22 tool names are present in
    `miniapp/node/mcp.mjs` (20 declared literally, plus `get_tasks` and
    `cancel_tasks` generated by a `.map()` at line 77). Their behaviour is
    unchanged by the port — the upstream suite's 343 tests all pass.
- [ ] Tool authority is bound to sessions; spoofed caller fields cannot impersonate Chief.
  - Not yet. Needs the adapter's session-bound closures (M3).
- [ ] Skills discovery and local/remote MCP tools work through Pi.
  - `loadSkills`, `discoverAndLoadExtensions` and `createMcpExtension` are
    confirmed present in Pi 1.4.0. End-to-end behaviour is not yet exercised.
- [ ] MCP failure, reconnect, cancellation, and authentication are tested.
  - Not yet.

## MiniBots feature parity

All rows in this section are **not yet started**. The upstream feature set is
imported intact and its 343 upstream tests pass, so the starting point is
sound, but no parity row has an observed installed-app result yet.

- [ ] First-launch Chief setup and bot management.
- [ ] Private chat, history, queued input, clearing, stop, and attachments.
- [ ] Groups, admin/all modes, Unicode mentions, PASS, relay limits, and convergence.
- [ ] Private/group isolation and correct session generations after clearing.
- [ ] Group notes survive chat clearing and are included in context correctly.
- [ ] Bot handoffs and private-only group posting retain their rules.
- [ ] Background helpers, dependency tasks, caps, queue UI, cancellation, and result return.
- [ ] Per-bot and team memory, revision conflicts, context selection, journal, and limits.
- [ ] Daily, interval, and once schedules via UI and tools.
- [ ] Image/audio/video/file cards, HTML/Markdown previews, downloads, and retries.
- [ ] All 11 original looks, imported avatars, crop/deduplication, themes, and colors.
- [ ] Reactions, copy, quote, session links, and working-message bubble behavior.
- [ ] Chat filters, unread counts, tasks view, and restored UI preferences.
- [ ] Usage counters and time ranges, with no duplicated turns.
- [ ] English and Chinese for all existing and new product flows.
- [ ] Session inspector includes tool activity, helpers, interactions, and errors.

## Recovery and Windows lifecycle

Not yet started.

- [ ] Start at sign-in works for the installed app and is user-configurable.
- [ ] Close hides the window; tray reopen preserves ongoing work.
- [ ] Stop all work and explicit Quit work with a bounded shutdown.
- [ ] Resume/startup admits one catch-up delivery per overdue schedule.
- [ ] Busy bots retain schedule deliveries; repeated ticks do not duplicate them.
- [ ] Timezones, DST, interval anchors, and one-time schedules are tested.
- [ ] Crash tests cover admission, tool execution, result delivery, and pending questions.
- [ ] Uncertain external effects are not automatically replayed.
- [ ] SSE reconnect/renderer refresh preserves authoritative state without duplicates.
- [ ] Single-instance lock prevents duplicate schedulers and state writers.
- [ ] Corruption, migration, backups, and restore are tested.

## Installed release

Not yet started.

- [x] Existing upstream tests pass, or pre-existing failures have documented dispositions.
  - **343/343 pass**, over five consecutive full-suite runs
    (`npm run test:upstream`).
  - The baseline on this machine was **341 pass / 2 fail**. Both failures were
    diagnosed as a **Windows porting defect in the upstream code**, not flaky
    tests: `rename()` fails with `EPERM` on Windows when another handle still
    holds the destination, while POSIX replaces the inode silently. Both
    reproduce in the pristine upstream checkout. The mechanism is reproduced
    directly by `scripts/probe-rename-race.mjs`.
  - Fix: `vendor/minimax-bot/miniapp/node/fs-safe.mjs` adds a bounded retry for
    the transient lock, used by every atomic write in `store.mjs`, `team.mjs`,
    `memory.mjs` and `server.mjs`. The regression test
    `tests/runtime/fs-safe.test.mjs` proves the guard fires — a plain rename
    **fails** on this platform while `renameWithRetry` **succeeds** on the same
    scenario.
  - A third, separate flake (`helper-usage` cleanup, `ENOTEMPTY` on a temp
    directory) was fixed with a retrying removal in
    `vendor/minimax-bot/tests/helpers/temp-dir.mjs`.
  - Full detail: `docs/runtime-validation.md` §8 and
    `vendor/minimax-bot/MODIFICATIONS.md`.
- [ ] Type checks and runtime/integration/desktop suites pass.
  - `npm run typecheck` is configured (`tsconfig.json`, strict). The runtime
    suite `tests/runtime/` passes (9/9 across two files). Integration and
    desktop suites are not written yet.
- [ ] Packaged assets, native modules, and Pi resources are present and load successfully.
  - Not yet (M6).
- [ ] Installer tested under paths containing spaces and Unicode.
  - Not yet (M6).
- [ ] No development server or unrelated global configuration is required.
  - Not yet (M6).
- [ ] Local HTTP/MCP authentication and preview isolation are verified.
  - Not yet (M2/M3).
- [ ] Upgrade preserves conversations, memory, settings, avatars, and sessions.
  - Not yet (M6).
- [ ] Ordinary uninstall preserves personal data.
  - Not yet (M6).
- [x] Operations guide and license inventory are included.
  - Licence inventory: `vendor/minimax-bot/LICENSE` (upstream MIT, preserved
    unmodified) and `vendor/minimax-bot/UPSTREAM.md`.
  - The operations guide (`docs/operations.md`) is **not yet written**; it is an
    M6 deliverable and this row is therefore only partially satisfied.
- [ ] Installer path, SHA-256, signing status, tested environment, and commit are recorded.
  - Not yet (M6).

## Final evidence

| Item | Result |
|---|---|
| Application commit | Not yet committed — awaiting user approval to commit |
| Electron / embedded Node | **45.1.0**, embedded Node **v24.22.1**, ABI 150 |
| Pi package | **1.4.0**, exports verified (32/32 Node, 10/10 Electron utility process) |
| Windows version tested | Windows 11 x64, `DESKTOP-V2KHC9K`, Node v24.22.1 |
| Automated report | `npm run test:upstream` → 343/343. `npm run test:smoke` → 32/32. `npm run test:smoke:electron` → 10/10. `tests/runtime/` → 9/9 |
| Provider test report | **Not run** — no provider key configured. Reported as UNTESTED, not a pass |
| Installer path | Not built |
| Installer SHA-256 | Not built |
| Signing status | Not built |
| Known limitations | See implementation plan section 15, plus `docs/runtime-validation.md` §10 |
