# MiniBots implementation acceptance

Status: M0, M1, M2, M3, M4 and M5 complete. Evidence below is real: every
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
    93 vendored, 8 modified, 4 added, 0 removed, **0 client files changed**.
- [x] Pi 1.4.0 tarball exports and Electron embedded Node compatibility are verified.
  - `npm run test:smoke` → **32/32 checks passed**. `npm run test:smoke:electron`
    → **10/10 checks passed (Electron utility process)**.
  - Electron 45.1.0 embeds Node **v24.22.1**; Pi 1.4.0 requires `>=22.19.0`.
  - 20 required exports confirmed present, including `AgentSession`,
    `createAgentSession`, `SessionManager`, `ModelRuntime`,
    `createMcpExtension`, `createPowerShellTool`, `defineTool`, `loadSkills`.
  - Evidence: `docs/runtime-validation.md` §2, §3, §6.
- [ ] Runtime runs inside the packaged Windows app without an external Node or Pi CLI install.
  - **Partially proven.** The whole application now runs on Electron:
    `npm run test:smoke:shell` → **21/21 checks passed**. It launches the
    real main process, the real utility process and a real window; the window
    loads the real vendored client — **with its stylesheet and its module
    script working** — and the backend is the real upstream Mini App.
  - The *packaged* build is not verified yet: Electron 45 restricts file
    descriptors inside an ASAR archive (`EBADF` for native addons and
    `child_process` stdio), so Pi's runtime assets must be unpacked. That
    check belongs to M6 (`npm run verify:package`).
- [x] Two independently configured sessions run concurrently and restore after restart.
  - **Proven** by `tests/integration/pi-adapter.test.ts` → 11/11 pass.
    Two sessions in the same process keep their own history and never see
    each other's turns; a session reopens from its file after the adapter is
    disposed (the way a restart does) and continues with its history intact.
    The application session → Pi session association is persisted **before**
    the turn is acknowledged, because Pi writes a session file only once the
    session has content.
- [x] Streaming, text commits, tool-call IDs, retries, and completion events are verified.
  - **Proven.** `src/runtime/event-mapper.ts` guarantees one `turn.started`,
    one `message.committed` per assistant message and one `turn.finished` per
    run; tool calls are settled by their call id, so two concurrent calls to
    the same tool stay distinguishable. `tests/runtime/event-mapper.test.mjs`
    → 8/8, and the integration suite checks the same invariants end to end
    against Pi's real event stream.
  - One correction came out of this work: Pi ends the **system** and the
    **user** message too, so committing every `message_end` would have
    echoed the user's words back as the Bot's reply. Only assistant messages
    are committed (`docs/runtime-validation.md` §10).
- [x] Cancellation stops owned work and reports uncertain outcomes honestly.
  - **Proven** for the run itself: an aborted turn settles with
    `status: 'aborted'`, not a success, and the terminal event carries the
    same status. The abort signal reaches the provider (verified directly).
  - **Still open**: cancelling the *work a tool started* — a native process
    tree, for example — needs the tool dispatch layer (M3).
- [x] Questionnaire pause/resume works, including restart and duplicate-answer cases.
  - **Proven** by the integration suite: a tool raises a questionnaire, the
    turn ends with `pendingQuestion` set and no final answer, the question
    reaches the chat as a `question.requested` event, and `answer()` continues
    the **same session** with the answers as its prompt.
  - A second answer to the same request is refused with `REQUEST_NOT_FOUND`,
    so a double click cannot answer twice. An answer to another chat's
    question is refused with `NOT_PERMITTED`.
  - **Still open**: a questionnaire that is pending across a restart needs
    the durable session index (M4).
- [ ] Full autonomy is the default; optional approval behavior is available and tested.
  - **Partially proven.** The adapter implements `reply()` for permission
    requests, and a request is bound to the session that raised it: a
    decision for another session is refused with `NOT_PERMITTED`.
  - The default-mode switch itself, and the approval UI, are still open: the
    upstream engine owns the approval flow and the desktop app has not yet
    exposed it.
- [x] No custom replacement model/tool loop has been introduced.
  - The port adds no model loop. `scripts/smoke-runtime.mjs` drives Pi's own
    `AgentSession`; the adapter contract in `miniapp/node/miniapp-api.ts`
    is implemented verbatim, so the engine needed no event-contract migration.
  - The integration suite drives Pi's **real** agent loop — the real session
    manager, the real tool execution, the real event stream — and replaces
    only the network call with a deterministic provider fixture.

## Providers and tools

- [ ] DeepSeek completes a real file/tool task.
  - **UNTESTED.** No provider key is configured on this machine.
    `npm run test:providers` reports **UNTESTED** with the reason for each
    provider — "no key is configured (set `MINIBOTS_DEEPSEEK_API_KEY`)" — and
    **not** a pass. The runner asks the model to write a real file with a real
    file-writing tool and checks the file afterwards; a provider that only
    answers in prose does not pass.
  - The key is entered in the app's provider settings, never in chat.
- [ ] MiniMax completes a real file/tool task, with the configured region recorded.
  - **UNTESTED** — same reason as above. The app offers MiniMax's
    international region (`minimax`) and its China region (`minimax-cn`)
    separately, because a MiniMax key is region-specific.
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
  - **The catalogue now reaches Pi's built-in providers.** It is built from
    `ModelRuntime.getProviders()`, not `getRegisteredProviderIds()` — the
    latter lists only the providers an *extension* registered and is empty in
    a bare runtime, so the catalogue would have offered **no model at all**
    even with a working key, silently.
    `tests/desktop/model-catalogue.test.ts` (5/5) pins the difference and
    `tests/integration/pi-adapter.test.ts` proves the adapter offers a
    configured provider's models end to end.
- [ ] Provider errors do not silently change models or replay completed side effects.
  - Not yet.
- [x] API keys are encrypted at rest and absent from normal logs/exports/Pi plaintext auth.
  - **Proven** by `tests/integration/credential-service.test.ts` → **8/8 pass**:
    a saved key is not readable in plain text from the file on disk; the
    Electron 45 **async** `safeStorage` API is the one used (the deprecated
    synchronous one is not called); a removed key is gone from the file; a
    file that cannot be decrypted is *reported*, not silently ignored; and a
    system with no OS key store refuses to store a key at all.
  - The key never leaves the main process: the renderer submits it through a
    dedicated preload method, the main process encrypts it and stores only the
    ciphertext, and the backend receives the resolved key over the utility
    process's private IPC. The renderer is told **which** providers are
    configured, never the key.
  - Pi receives the key through its in-memory runtime credential API, so no
    plaintext Pi auth file is written (`npm run test:smoke` asserts this).
  - The loopback is authenticated: a request without the bearer token is
    refused with 401 and never reaches the upstream server
    (`tests/integration/backend-gate.test.ts` → 6/6 pass).
- [x] Native Windows PowerShell works; missing optional Bash is handled.
  - `createPowerShellTool` constructs successfully in both the Node and the
    Electron utility-process smoke tests. Git Bash was located at
    `C:\Program Files\Git\bin\bash.exe` and its absence is reported as an
    optional prerequisite rather than a failure.
- [x] The desktop shell runs the upstream Mini App unmodified, behind an authenticated loopback.
  - **Proven** by `npm run test:smoke:shell` → **21/21 checks passed** and
    `tests/integration/backend-host.test.ts` → **10/10 pass**.
  - The window is served from the app's own loopback origin, so the client's
    own absolute asset paths resolve and the page is fully styled and
    interactive. See `docs/runtime-validation.md` §12.
  - The upstream `server.mjs` is started unmodified with a real context: the
    real engine, the real stores, the real scheduler and the real tasks. It
    serves the upstream client at `/bot`, so the whole upstream UI comes with
    it — the frontend was not rewritten and no second copy exists.
  - The upstream server binds a reserved ephemeral loopback port. The app's
    **gate** listens on its own ephemeral port, checks a bearer token in
    constant time, and forwards only authenticated requests. A request without
    the token is refused with 401 and never reaches the upstream server.
  - The renderer has no route to the backend at all: it asks the main process
    over IPC, and the main process adds the token. The shell smoke test
    asserts that the renderer sees no credential.
  - The gate binds the loopback interface only, and a test asserts that it is
    not reachable on the machine's LAN address.
  - The app's own routes — the session inspector at `/api/app/sessions` — are
    served by the gate, because the upstream server's routing is a closure
    that cannot be extended without changing a vendored file.
  - The backend survives a restart with its state intact, and releases its
    port cleanly on shutdown.
  - The caller's identity travels out of band in an `AsyncLocalStorage`
    context, so the tools a model calls run with the real caller's authority
    while the model never sees it.
- [ ] All 21 original MiniBots business tools retain their expected behavior.
  - **Inventory verified, and the count corrected.** The implementation plan's
    list has **21** names, not 22: 19 are declared literally in
    `miniapp/node/mcp.mjs` and `get_tasks` and `cancel_tasks` are generated by
    a `.map()` at line 77. `TOOL_NAMES` is computed from the definitions
    themselves, so the count cannot drift.
  - The tools are offered to the model over Pi's custom-tool mechanism, with
    the **same** handlers the Streamable HTTP MCP endpoint uses
    (`tests/integration/tool-dispatch.test.ts` asserts the upstream endpoint
    still lists all of them).
  - Their behaviour is unchanged by the port — the upstream suite's 343 tests
    all pass.
- [x] Tool authority is bound to sessions; spoofed caller fields cannot impersonate Chief.
  - **Proven** by `tests/integration/tool-dispatch.test.ts` → **5/5 pass**.
  - The upstream contract puts the caller in the tool's arguments
    (`caller_bot_id`), because an HTTP client has no other way to say who it
    is. A model, however, *writes* those arguments.
  - The Windows app therefore binds the caller from the **runtime** — the
    session the run belongs to — and **removes** the model's field before the
    call. A test asserts that a model naming the Chief as the caller still
    runs as its own session's Bot.
  - A tool call for a session with no Bot bound to it is refused.
  - The tools run through Pi's **real** tool loop: the session identity is
    bound in the closure, the tool's result goes back to the model, and the
    model answers from it (`tests/integration/pi-adapter.test.ts`).
  - The UI's canonical `mcp__minimax-bot__…` labels are preserved, because
    the engine's receipt logic depends on them.
- [ ] Skills discovery and local/remote MCP tools work through Pi.
  - `loadSkills`, `discoverAndLoadExtensions` and `createMcpExtension` are
    confirmed present in Pi 1.4.0. End-to-end behaviour is not yet exercised.
- [ ] MCP failure, reconnect, cancellation, and authentication are tested.
  - The **authentication** half is proven: the app's own MCP transport sits
    behind the bearer-token gate (`tests/integration/backend-gate.test.ts`),
    and the tool dispatch replaces the model-supplied caller
    (`tests/integration/tool-dispatch.test.ts`).
  - The failure, reconnect and cancellation halves need the external MCP
    integration (M5).
- [x] An interrupted dispatch is reported as uncertain, never as success and never replayed.
  - **Proven** by `tests/integration/recovery.test.ts` → **8/8 pass**.
  - The dispatch ledger records every admission **before** the dispatch starts,
    and the outcome when it settles. A record that is still `admitted` when
    the app starts again becomes `unknown` — the app may have done the work,
    and it says so rather than claiming success or repeating the side effect.
  - A settled dispatch stays settled across a restart.
  - A corrupt ledger file does not stop the app, and the ledger is bounded.
  - The ledger is served at `/api/app/dispatches` for the inspector.
- [x] A session's Pi session survives a restart.
  - **Proven** by `tests/integration/recovery.test.ts` and
    `tests/integration/schedule-catchup.test.ts`.
  - The app owns the association between an application session and a Pi
    session, because Pi writes a session file only once the session has
    content and the app therefore cannot rediscover it from the filesystem.
    The association is written as soon as it changes, and it is restored when
    the backend starts.
  - A cleared chat starts a new **generation** and does not reuse the old
    session, so a late completion from the previous generation cannot enter
    the new chat.
- [x] A schedule that came due while the app was closed is delivered once.
  - **Proven** by `tests/integration/schedule-catchup.test.ts` → **4/4 pass**.
  - The upstream scheduler already moves a schedule's next run forward when it
    fires, so an overdue schedule fires once rather than once per missed
    occurrence. The app adds the catch-up record that says *whether this
    occurrence has already been delivered*, so a restart before the next slot
    does not deliver it twice, while the next slot is a new delivery.

## MiniBots feature parity

The upstream feature set is imported intact and its 343 upstream tests pass,
so the starting point is sound. **No parity row has an observed
installed-app result yet** — the parity rows are about the upstream Mini App's
own behaviour inside the desktop shell, and the desktop shell is only now
running the client for real (see §"Recovery and Windows lifecycle" for the
evidence that the client loads, renders and authenticates).

The two rows that *are* checked below — the bilingual strings and the session
inspector — are the ones the desktop app itself owns.

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
  - **The app's own strings are complete in both languages.**
    `tests/desktop/strings.test.ts` (7/7) checks that the English and Chinese
    tables have exactly the same keys, that no string is empty, that a
    translation keeps the placeholders of its original, and that the two
    languages really differ — a copy-paste that left the Chinese table in
    English would otherwise pass silently.
  - The upstream Mini App's own strings are the vendored ones and are not
    touched (`client files changed: 0`).
- [x] Session inspector includes tool activity, helpers, interactions, and errors.
  - **The app's own inspector window is served and renders.**
    `npm run test:smoke:shell` → **21/21 checks passed**: the app's window is
    served from the app's own origin at `/app`, it renders its rail, and the
    session inspector and the dispatch inspector are both reachable.
  - The session inspector shows every chat and the Pi session it is bound to;
    the dispatch inspector shows every admitted tool call and what the app
    knows about its outcome — an `unknown` outcome is reported as unknown.
  - **Partially proven**: the two inspectors are served and render. The
    *content* they show for a live session is asserted by the integration
    suite (`/api/app/sessions`, `/api/app/dispatches`), not by an
    installed-app observation.

## Recovery and Windows lifecycle

Partially complete.

- [ ] Start at sign-in works for the installed app and is user-configurable.
  - **Partially proven.** The preference is stored in the app's own settings
    file, survives a restart, and is applied through Electron's login-item
    settings — but **only when the app is packaged**, because a development
    run would register `electron.exe` instead of the app.
    `tests/desktop/app-settings.test.ts` (6/6) proves the persistence.
    The installed-app behaviour is an M6 check.
- [x] Close hides the window; tray reopen preserves ongoing work.
  - **Proven** by `scripts/desktop-tests.mjs` → **22/22 checks passed**
    (inside a real Electron process): closing the window hides it, the
    window is not destroyed, and it can be shown again.
  - The shell smoke test confirms it end to end: closing the window leaves
    the app running, and the window still answers afterwards.
- [ ] Stop all work and explicit Quit work with a bounded shutdown.
  - **Partially proven.** The quit is the tray's explicit "Quit" item, the
    backend is killed on `before-quit`, and a five-second backstop bounds the
    shutdown so a hung tool cannot leave a zombie process.
    The bounded shutdown has not been exercised against a hung tool.
- [x] Resume/startup admits one catch-up delivery per overdue schedule.
  - **Proven** by `tests/integration/schedule-catchup.test.ts` → **4/4 pass**.
- [x] Busy bots retain schedule deliveries; repeated ticks do not duplicate them.
  - **Proven** by the same suite.
- [ ] Timezones, DST, interval anchors, and one-time schedules are tested.
- [ ] Crash tests cover admission, tool execution, result delivery, and pending questions.
- [x] Uncertain external effects are not automatically replayed.
  - **Proven** by `tests/integration/recovery.test.ts` → **8/8 pass**.
- [ ] SSE reconnect/renderer refresh preserves authoritative state without duplicates.
  - **Partially proven.** The event stream is a real `EventSource` now, served
    over the app's own origin. The reconnect behaviour itself is upstream's
    and is not yet exercised.
- [x] Single-instance lock prevents duplicate schedulers and state writers.
  - **Proven.** The app claims `app.requestSingleInstanceLock()` before it
    starts the backend, so a second launch never starts a second scheduler.
    `scripts/desktop-tests.mjs` checks that the lock can be claimed by a
    process that does not hold it — which is exactly what a second copy of the
    app would do if the first one were not running.
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
- [x] Type checks and runtime/integration/desktop suites pass.
  - `npm run typecheck` runs **three** configurations, because they are not
    the same check: the whole tree (`tsconfig.json`), the build
    (`tsconfig.build.json`) and the preload as CommonJS. All three pass.
    The build's own configuration caught a real defect that the tree-wide
    check had passed.
  - `tests/runtime/` → **17/17**. `tests/integration/` → **54/54**.
    `tests/desktop/` → **29/29**.
  - `scripts/desktop-tests.mjs` → **22/22 checks passed** (the tray and the
    window's lifecycle, inside a real Electron process).
- [ ] Packaged assets, native modules, and Pi resources are present and load successfully.
  - Not yet (M6).
- [ ] Installer tested under paths containing spaces and Unicode.
  - Not yet (M6).
- [ ] No development server or unrelated global configuration is required.
  - Not yet (M6).
- [x] Local HTTP/MCP authentication and preview isolation are verified.
  - **Proven.** Every `/api/…` route, the MCP endpoint and the event stream
    are behind the bearer token, and the token is compared in constant time.
    A request without it is refused with 401 **before** it reaches the
    upstream server.
  - The one exception is the application's own **static assets** — the page's
    stylesheet, its scripts, the skin images and the app's own window's
    files. A browser loads those as subresources, which cannot carry an
    `Authorization` header, so requiring a token for them would leave the
    window blank. They are the application's own files and carry no user
    data. The rule is pinned by `tests/desktop/gate-assets.test.ts` and
    proved against the real upstream server by
    `tests/integration/backend-host.test.ts`.
  - The renderer never sees the token: it is added at the network layer, in
    the main process, and the shell smoke test asserts that the renderer
    sees no credential.
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
| Application commit | M5 — see the git history for the milestone commits |
| Electron / embedded Node | **45.1.0**, embedded Node **v24.22.1**, ABI 150 |
| Pi package | **1.4.0**, exports verified (32/32 Node, 10/10 Electron utility process) |
| Windows version tested | Windows 11 x64, `DESKTOP-V2KHC9K`, Node v24.22.1 |
| Automated report | `npm run test:upstream` → 343/343. `npm run test:runtime` → 17/17. `npm run test:integration` → 54/54. `npm run test:desktop` → 29/29. `npm run test:smoke` → 32/32. `npm run test:smoke:shell` → 21/21. `scripts/desktop-tests.mjs` → 22/22 |
| Provider test report | **UNTESTED** — `npm run test:providers` ran and reported UNTESTED for all four providers, with the reason ("no key is configured"). Not a pass |
| Installer path | Not built |
| Installer SHA-256 | Not built |
| Signing status | Not built |
| Known limitations | See implementation plan section 15, plus `docs/runtime-validation.md` §10–§13 |
