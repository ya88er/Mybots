# Runtime validation

Every fact in this document was observed on this machine, not inferred from
moving online documentation. Each entry records how it was verified.

Recorded: 2026-11-01, Asia/Shanghai.
Machine: Windows 11 x64, `DESKTOP-V2KHC9K`.

---

## 1. Toolchain

| Component | Version | How verified |
|---|---|---|
| Git | 2.54.0.windows.1 | `git --version` |
| Node | v24.22.1 | `node --version` |
| npm | 11.19.1 | `npm --version` |
| GitHub CLI | 2.101.0 | `gh --version` |
| Python | not on PATH (Windows Store alias) | `python --version` |
| Java | OpenJDK 17.0.20.1 | `java -version` |

Git identity is configured globally: `user.name=yasser`,
`user.email=sadikimohamed795@gmail.com`.

---

## 2. Electron 45.1.0 — the packaged runtime

| Fact | Value | How verified |
|---|---|---|
| Electron version | 45.1.0 | `node_modules/electron/dist/version` |
| Embedded Node | **v24.22.1** | `electron.exe -e "console.log(process.versions)"` |
| Electron ABI | modules 150 | same |
| Chromium / V8 | 156.0.8078.48 / 15.6 | Electron 45 release notes |

**Engine gate satisfied.** Pi 1.4.0 declares `engines.node >=22.19.0`; the
embedded Node is v24.22.1.

Electron 39 (Node 22.20.0) and 40 (Node 24.11.0) would also satisfy the gate.
Electron 37 and 38 ship Node 22.16.0 and would **not** — they are excluded.

### Install-script caveat

`npm install` did not run Electron's postinstall, because the sandboxed npm
policy reported `install-scripts 3 packages have install scripts not yet
covered by allowScripts`. The Electron binary was fetched by running the
package's own installer directly:

```
node node_modules/electron/install.js
```

Without it, `node_modules/electron/dist/electron.exe` is absent and every
Electron command fails with a confusing "not a valid Win32 application".

### Electron 45 behaviour changes that affect this project

These are documented in the Electron 45 release notes and are load-bearing for
the desktop shell:

1. **`safeStorage` synchronous methods are deprecated** and are removed in
   Electron 46. `encryptStringAsync` returns an **object** containing the
   encrypted `result`, not a string. The credential helper must use the async
   API and normalise the object.
2. **Sandboxed preload scripts lost their Node module shims.** `events`,
   `timers` and `url` are no longer bundled, and the `Buffer`, `setImmediate`
   and `clearImmediate` globals are gone. A sandboxed preload's `require()`
   now only loads `electron`, `electron/renderer` and `electron/common`. The
   preload must use Web APIs (`URL`, `TextEncoder`, `queueMicrotask`).
3. **File descriptors inside an ASAR archive are only usable through `fs`.**
   `fs.open()` on a packed file returns a descriptor that native addons,
   `child_process` stdio and `net.Socket({ fd })` cannot use — it fails with
   `EBADF`. Writing to such a file fails with `EACCES`. Anything Pi executes
   must therefore be outside the archive or explicitly unpacked.
4. **`window.open()` children of unsandboxed windows get their own sandboxed
   process**, and subframe workers need `nodeIntegrationInSubFrames`. HTML
   previews must stay in a separate, isolated partition.

---

## 3. Pi 1.4.0 — the agent runtime

| Fact | Value | How verified |
|---|---|---|
| Package | `@earendil-works/pi-coding-agent` | `npm ls` |
| Version | 1.4.0 | `pi --version` and the installed `package.json` |
| Declared engine | `node >=22.19.0` | `package.json` |
| Exports | `.`, `./rpc-entry` | `package.json` exports map |
| Type | ESM (`"type": "module"`) | `package.json` |

Pi is also installed as a managed release on this machine at
`C:\Users\book\.pi\agent\install\releases\1.4.0`, and `pi` is on PATH. The
project uses its own pinned npm dependency so the packaged app does not depend
on a machine-wide Pi install.

### Verified public API surface

Read from the installed `dist/index.d.ts` of 1.4.0:

| Export | Kind | Used for |
|---|---|---|
| `AgentSession` | class | one conversation with a model |
| `createAgentSession` | function | build a session from options |
| `SessionManager` | class | own, list and reopen session files |
| `ModelRuntime` | class | provider/model catalogue and credentials |
| `createMcpExtension` | function | MCP server integration |
| `createPowerShellTool` | function | the Windows-native shell tool |
| `createReadTool` / `createWriteTool` / `createEditTool` | function | file tools |
| `createBashTool` / `createGrepTool` / `createFindTool` / `createLsTool` | function | shell and search tools |
| `defineTool` | function | register the MiniBots business tools |
| `loadSkills` | function | SKILL.md discovery |
| `discoverAndLoadExtensions` | function | load Pi extensions |
| `ExtensionRunner` | class | extension lifecycle |
| `SettingsManager` | class | agent settings |
| `DefaultResourceLoader` | class | explicit resource discovery |
| `VERSION` | constant | reported as `1.4.0` |

### Verified member APIs

| Call | Signature | Source |
|---|---|---|
| `agentSession.subscribe(listener)` | returns `() => void` (disposer) | `dist/core/agent-session.d.ts:384` |
| `agentSession.prompt(text, options?)` | `Promise<void>` | `dist/core/agent-session.d.ts:553` |
| `agentSession.abort()` | `Promise<void>` | `dist/core/agent-session.d.ts:654` |
| `agentSession.setModel(model, options?)` | `Promise<void>` | `dist/core/agent-session.d.ts:663` |
| `agentSession.dispose()` | `void` | `dist/core/agent-session.d.ts:391` |
| `modelRuntime.setRuntimeApiKey(providerId, apiKey, opts?)` | `Promise<void>` | `dist/core/model-runtime.d.ts:93` |
| `modelRuntime.removeRuntimeApiKey(providerId, opts?)` | `Promise<void>` | `dist/core/model-runtime.d.ts:94` |
| `modelRuntime.listCredentials(opts?)` | `Promise<readonly CredentialInfo[]>` | `dist/core/model-runtime.d.ts:95` |
| `SessionManager.create(cwd, sessionDir?, options?)` | static factory | `dist/core/session-manager.d.ts:371` |
| `SessionManager.open(path, sessionDir?, cwdOverride?)` | static factory | `dist/core/session-manager.d.ts:378` |
| `SessionManager.newSession(options?)` | returns the **session file path** | `dist/core/session-manager.d.ts:238` |
| `SessionManager.getSessionId()` | the session id | `dist/core/session-manager.d.ts:246` |
| `SessionManager.getSessionFile()` | the session file path | `dist/core/session-manager.d.ts:247` |

`SessionManager` has a **private constructor**; it must be created through the
static factories.

---

## 4. Session persistence — a design constraint

Observed with `scripts/probe-session-persistence.mjs`:

```
newSession -> ...\2026-11-01T07-52-35-506Z_01a19618-....jsonl
getSessionId -> 01a19618-93b2-77e4-a03a-d65cec3ecaec
files after newSession: []
files after createAgentSession: ["auth.json","models-store.json"]
```

**A session file is only written once the session has content.** An empty
session leaves nothing on disk.

**Consequence for the adapter.** The app cannot rely on Pi's own files to
discover which Pi session belongs to which chat. The app must keep its own
association from application session to Pi session file, and persist that
association **before** it acknowledges a turn — which is what the
implementation plan's §5.2 requires.

---

## 5. Runtime environment

| Fact | Value | How verified |
|---|---|---|
| Git Bash | `C:\Program Files\Git\bin\bash.exe` | filesystem probe in the smoke test |
| PowerShell | native on Windows | `createPowerShellTool` constructs successfully |
| Network egress | `HTTP_PROXY=http://127.0.0.1:7897`, `NO_PROXY=localhost,127.0.0.1,::1` | environment |
| npm registry | reachable but slow (`npm view` exceeded 60 s) | observed during setup |

The registry latency is why the project commits a lockfile and uses `npm ci`
rather than resolving versions live.

---

## 6. Smoke test results

### Plain Node — `npm run test:smoke`

```
=== 32/32 checks passed ===
```

Covers: package import, 20 required exports, `VERSION`, the three credential
methods, the five `AgentSession` methods, the tool factories, `loadSkills`,
Git Bash detection, PowerShell availability, `SessionManager.create`,
`newSession` returning a file path, `getSessionId`, the empty-session
no-file behaviour, reopening a session by path, `createAgentSession` in an
isolated workspace, the subscribe disposer, clean disposal, and the absence of
a plaintext API key in the Pi auth file.

### Electron utility process — `npm run test:smoke:electron`

```
=== 10/10 checks passed (Electron utility process) ===
```

Covers: the embedded Node satisfies Pi's engine floor, the package imports
inside the utility process, 12 required exports, a real session with its own
`cwd`, the subscribe disposer, `createPowerShellTool` construction, clean
disposal, and the workspace contents.

The utility process is the process the backend actually runs in, so this is
the environment that matters. A packaged build has an additional constraint:
Pi's runtime assets must be reachable as real paths, because Electron 45
restricts file descriptors inside an ASAR archive. That is checked by
`scripts/verify-package.mjs` at M6.

---

## 7. Provider credentials — not yet available

`createAgentSession` reports `modelFallbackMessage: "No models available. Use
/login to log into a provider via OAuth or API key."` because no provider key
is configured on this machine.

The live-provider acceptance rows (DeepSeek, MiniMax and OpenAI each
completing a real file/tool task) therefore **cannot be marked as passing**.
They are gated on the user configuring a key in the app's provider settings.
Keys are never requested in chat.

`scripts/test-providers.mjs` is the opt-in runner for those rows; it reports
`UNTESTED` with a reason when a key is missing. A skipped provider test is
not a pass.

---

## 8. Windows porting defect found in the upstream code

The upstream suite was authored on macOS. Two write paths lose a race on
Windows because `rename()` there refuses to replace a destination that another
handle still holds open, while POSIX replaces the inode silently.

Observed baseline on this machine, before any change:

```
tests 343 | pass 341 | fail 2
```

- `task-lifecycle.test.mjs` — *"admission is durable and idempotent…"* failed
  with `{"status":"error","errorCode":"EPERM"}`.
- `http-reliability.test.mjs` — *"avatar library persists imports…"* failed
  with a non-200 response.

Both reproduce in the pristine upstream checkout at
`C:\Users\book\AppData\Local\Temp\minibots-upstream-20261101`, so they are a
Windows porting defect and not a defect introduced by this port.

`scripts/probe-rename-race.mjs` reproduces the mechanism directly:

```
rename FAILED with code = EPERM
```

### The fix

`vendor/minimax-bot/miniapp/node/fs-safe.mjs` adds `renameWithRetry`, a bounded
retry for the transient lock (`EPERM`, `EACCES`, `EBUSY`). It is used by every
atomic write in the engine: `store.mjs`, `team.mjs`, `memory.mjs` and
`server.mjs`.

`tests/runtime/fs-safe.test.mjs` proves the guard fires: the first test shows
a plain rename over a held-open destination **fails** with `EPERM` on this
platform, and the second shows `renameWithRetry` **succeeds** on the same
scenario. A non-transient error such as `ENOENT` is rethrown immediately
rather than retried away.

### Result after the fix

```
tests 343 | pass 343 | fail 0
```

confirmed over five consecutive full-suite runs.

---

## 9. Upstream contract: the agent client

The upstream `miniapp/node/miniapp-api.ts` already declares the exact event
and result contract the engine consumes, so the adapter implements it verbatim
and the engine needs no event-contract migration.

| Upstream type | Discriminants |
|---|---|
| `MiniAppAgentRunEvent` | `turn.started`, `text.delta`, `message.committed`, `tool.started`, `tool.finished`, `permission.requested`, `question.requested`, `turn.finished` |
| `MiniAppAgentRunResult` | `status: 'finished' \| 'error' \| 'aborted'`, `text?`, `error?`, `pendingQuestion?` |
| `MiniAppAgentErrorCode` | `NOT_PERMITTED`, `BUSY`, `SESSION_NOT_FOUND`, `INVALID_ARGUMENTS`, `AGENT_UNAVAILABLE`, `REQUEST_CANCELLED`, `AGENT_OUTCOME_UNKNOWN`, `REQUEST_NOT_FOUND` |

### The one gap, and its fix

`engine.mjs:999-1012` calls `agent.models()` and reads `catalog.default` plus
`catalog.models[]`, but `miniapp-api.ts` did not declare it.

The contract was added as `MiniAppModelCatalog` and `MiniAppModelCatalogEntry`.
The entry shape is load-bearing and was read off the real consumers rather
than guessed:

- `store.mjs` `effortOptions(entry)` reads `entry.thinking.efforts` (string
  levels) and `entry.variants`.
- `store.mjs` `withEffort(entry, effort)` reads `entry.variants` for the
  `'thinking'` variant and returns `{ providerId, modelId, variant?, thinking? }`.
- `panels.js` reads `entry.displayName`, `entry.thinking.default` and the same
  `efforts` / `variants` fields, and `/api/models` serves
  `{ supported, models, default }`.

`tests/runtime/model-catalog.test.mjs` pins all of it: 6 tests, all passing.

---

## 10. The adapter — M1 findings

Everything in this section was observed by running the adapter against Pi's
**real** agent loop through a deterministic provider fixture
(`tests/fixtures/fixture-provider.ts`). The fixture replaces the network call
only: the real session manager, the real tool execution and the real event
stream all run.

### `ModelRuntime.create` has no `agentDir`

The installed declaration (`dist/core/model-runtime.d.ts:4-26`) accepts
`credentials`, `authPath`, `modelsPath`, `modelsStore`, `allowModelNetwork`,
`modelRefreshTimeoutMs`, `catalogBaseUrl` and `minOAuthValidityMs`. There is
no `agentDir`, and `refreshOnCreate` does not exist either — the flag is
`allowModelNetwork`, and it defaults to `false`.

The adapter therefore creates the runtime with an in-memory credential store
and `modelsPath: null`, so no plaintext auth file and no model catalogue file
is written:

```ts
const credentials = new InMemoryCredentialStore();
const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
```

### A provider must be *stored* to count as configured

`runtime.getAuth(model)` resolves a key through the provider's own
`auth.apiKey.resolve()`, but `runtime.hasConfiguredAuth(providerId)` reads a
different thing: it is true only when the **credential store** holds a key.
Pi's `prompt()` checks `hasConfiguredAuth` and refuses with *"No API key found
for the selected model"* when it is false — even though `getAuth` would have
returned a working key.

Observed directly:

```
registered ids = minibots-fixture
hasConfiguredAuth = false
getAuth(model) = {"auth":{"apiKey":"fixture-key","headers":{}}}
```

The adapter's `#ensureCredential` therefore resolves the key and writes it into
the in-memory store with `setRuntimeApiKey`. Nothing reaches a plaintext file.

### `message_end` fires for every message, not only the assistant's

Pi ends the system message, the user message and the assistant message alike.
Observed event order for one prompt:

```
message_start | role = system
message_end   | role = system
message_start | role = user
message_end   | role = user
message_start | role = assistant
message_end   | role = assistant
```

Committing every `message_end` would echo the user's own words back as the
Bot's reply. The event mapper commits **assistant messages only**.

### The abort signal does reach the provider

`agent.abort()` aborts the run's `AbortController`, and that signal is what
the provider receives in its stream options. Observed:

```
streamSimple() got signal = yes
seenSignal.aborted before abort = false
seenSignal.aborted after abort  = true
```

A real provider fails the request when it is aborted — pi-ai's own providers
throw `"Request was aborted"`. The fixture does the same, because a stream
that ends silently leaves Pi's run unsettled and `session.abort()` never
returns.

### The conversation history lives in the context, not in the prompt

The fixture records the last user message per call, so the history is not in
the prompt string. It is in the context Pi sends:

```
context 0: roles = system, user
context 1: roles = system, user, assistant, user
```

---

## 11. The Electron shell — M2 findings

### Electron on Windows does not write to the console

A GUI Electron application on Windows has no console attached, so
`console.log` goes nowhere. This was found by a smoke test that appeared to
hang with no output: the application was working, and the output was simply
invisible.

The shell smoke test therefore writes its report to a file and exits with a
status code. `scripts/smoke-electron-shell.mjs` → **10/10 checks passed**:
the window is created, the real vendored client loads, the preload bridge is
installed, the renderer never sees a bearer token, the backend becomes ready,
and the renderer reaches the backend only through the main process.

### `app.getAppPath()` is the *script's* directory

When Electron is launched with a script path, `app.getAppPath()` is that
script's directory — not the app's root. The app resolves its own root from
its module location instead (`appRoot()` in `src/main/main.ts`), so the paths
are the same however the app was started.

### The upstream server does not report its port

`server.mjs` creates its own `http.Server`, binds it and returns only
`{ dispose }`. The host therefore reserves a free loopback port first — by
binding a probe socket to port 0, reading the port the OS chose and releasing
it — and hands that port to the upstream server through `context.listen`.

### The upstream routing cannot be extended

`server.mjs` builds its routes in a local closure, so the app cannot add a
route without changing a vendored file. The app's own routes — the session
inspector at `/api/app/sessions` — are therefore served by the **gate**, in
front of the upstream server, where the app owns the code. They are behind the
same bearer token as everything else.

### The upstream client is served by the upstream server

`server.mjs` serves the client itself at `/bot` from
`miniapp/client`, reading it from `context.pluginRoot`. The window therefore
loads that page, and the whole upstream UI comes with it — no rewrite into
React, no second copy of the client.

### The identity the upstream contract has no room for

The upstream engine holds **one** agent client and calls it for every Bot,
chat and helper, and `MiniAppAgentClient` carries no caller identity. The
MiniBots tools must nevertheless run with the real caller's authority.

The identity therefore travels out of band, in an `AsyncLocalStorage` context
that the backend sets around every call into the engine
(`src/runtime/dispatching-agent.ts`). The model never sees it, and the engine
needed no change. `AsyncLocalStorage` keeps concurrent turns apart, because
each turn's context is its own async branch.

### `safeStorage` in Electron 45

The synchronous `safeStorage` methods are deprecated and removed in Electron
46, and the async API returns an **object**:

- `encryptStringAsync(plain)` resolves to `{ result: Buffer }`;
- `decryptStringAsync(cipher)` resolves to `{ result: string }`.

`src/main/credential-service.ts` normalises both shapes and prefers the async
API. `tests/integration/credential-service.test.ts` proves the async path is
the one used (8/8 pass), that a saved key is not readable in plain text from
the file, that a removed key is gone from the file, and that a file which
cannot be decrypted is *reported* rather than silently ignored.

---

## 12. The desktop shell — M5 findings

### The window could not be served from the file system

The upstream client's own page refers to its assets by **absolute** path:

```html
<link rel="stylesheet" href="/bot/app.css" />
<script type="module" src="/bot/app.js"></script>
```

A page loaded from the file system resolves `/bot/app.css` against the file
system root, not against a server. The page therefore loads **unstyled, and
its module script never runs**.

This was measured, not assumed. `scripts/probe-client-origin.mjs` loaded the
vendored client from `file://` and reported:

| Probe | Result |
|---|---|
| `getComputedStyle(document.body).backgroundColor` | `rgba(0, 0, 0, 0)` — the stylesheet did not load |
| the side list's children | `0` — the module script never ran |
| the side list's text | `正在加载团队…` — the static placeholder from `index.html` |

The app's UI was, in that state, entirely non-functional.

**The fix:** the window is served from the app's own **loopback origin** —
`http://127.0.0.1:<gate port>/bot` — which is the upstream server's own
address, reached through the authenticated gate. The absolute paths resolve
normally, the page has a real origin, and the event stream is a real
`EventSource`. The upstream client is still the upstream client: it is served
by the upstream server from `miniapp/client`, and the frontend was not
rewritten.

### A preload cannot patch the page's `fetch` under context isolation

The first attempt bridged the page's `fetch` and `EventSource` from the
preload. That does not work: with `contextIsolation: true` the preload runs
in its **own world**, and its `window` is not the page's `window`. The page's
`fetch` was therefore untouched, and the page's own request reached the gate
without a token and was refused with 401.

The measured proof is in the smoke test's own report — the page's relative
fetch returned `{"error":"unauthorized","message":"A valid bearer token is
required."}` while the stylesheet and the script loaded correctly.

**The fix:** the token is added at the **network layer**, in the main process:

```ts
session.defaultSession.webRequest.onBeforeSendHeaders(
  { urls: ['http://127.0.0.1/*'] },
  (details, callback) => { /* add Authorization */ },
);
```

Chromium's `webRequest` sees every request the renderer makes, including a
subresource load and an event stream, and a request to the app's own port
only. The token therefore never reaches the page, and the page does not have
to know it exists. The preload keeps only the operations that are not HTTP:
the provider keys, the app's own information, and the app's own window.

This is strictly better than the page-side bridge: it covers the page's
assets, its API calls *and* its event stream with one mechanism, and it
cannot be bypassed by a page that decides to use `XMLHttpRequest` instead.

### The gate must let the page's own assets through — and nothing else

The gate refuses every request without the bearer token. A browser loads a
page's stylesheet, its scripts and its images as **subresources**, and a
subresource request cannot carry an `Authorization` header. The gate
therefore has one narrow exception, for the application's own files:

- `/bot`, `/bot/app.css`, `/bot/app.js`, `/bot/skins/*.png`;
- `/app`, `/app/app.css`, `/app/app.js`, `/app/strings.js`.

Everything that can carry the user's data — every `/api/…` route, the MCP
endpoint, the event stream and the app's own routes — is still behind the
token, and the token check happens **before** the routes are consulted, so a
route can never be reached without one. Only `GET` is public; a `POST` to the
same path is refused.

`tests/desktop/gate-assets.test.ts` pins the rule, and
`tests/integration/backend-host.test.ts` proves it against the real upstream
server: the assets answer `200` without a token, and every API route answers
`401`.

**One regression was introduced and caught here.** The first implementation of
the public-asset rule consulted the app's routes *before* the token check, so
`/api/app/sessions` was answered with `200` and no token. The integration
suite's existing test — "an app route still needs the token" — caught it
immediately. The rule is now: **token first, then routes**, with only the
static-asset paths bypassing the check.

### The window hides; it does not close

The app keeps working when the window is closed: a schedule that comes due at
09:00 has to be delivered whether or not anyone is looking. Closing the
window therefore hides it, and the tray is how the user brings it back. The
tray's menu has exactly three items — open, start at sign-in, quit — and the
quit is always the user's explicit choice.

`scripts/desktop-tests.mjs` → **22/22 checks passed** — proves the rules inside a real Electron process:
the window hides on close and is not destroyed, it can be shown again, the
tray has exactly three actions, the sign-in item is a checkbox that reports
the new state, and the single-instance lock admits exactly one holder.

### The start-at-sign-in preference is remembered even when it cannot be applied

Electron's login-item settings only work for a **packaged, installed**
application. A development run would register the path to `electron.exe`
itself, which would start the wrong thing at sign-in. The preference is
therefore stored in the app's own settings either way, and applied only when
`app.isPackaged` is true.

### The type checker now runs the build's own configuration

`scripts/check-types.mjs` checks three configurations, because they are not
the same check: the whole tree (`tsconfig.json`), the build
(`tsconfig.build.json`), and the preload as CommonJS. The build's own
configuration caught a real defect — a header value's type is checked
differently there — that the tree-wide check had passed.

The preload was also rewritten from a `.cts` file with JSDoc annotations to
a plain `.ts` file. A sandboxed preload is loaded as CommonJS, so it is
compiled on its own and emitted as `preload.cjs`; writing it in TypeScript
means the same checker covers it.

### M5 verification

| Suite | Command | Result |
|---|---|---|
| Types | `npm run typecheck` | 4/4 configurations pass |
| Runtime | `npm run test:runtime` | 17/17 |
| Desktop | `npm run test:desktop` | 30/30 |
| Integration | `npm run test:integration` | 54/54 |
| Upstream | `npm run test:upstream` | 343/343 |
| Shell | `npm run test:smoke:shell` | **25/25 checks passed** |

The shell smoke test now proves the origin fix end to end: the page is served
from `http://127.0.0.1:<port>/bot`, the client's stylesheet loaded
(`body background: rgb(20, 20, 20)`), the client's module script ran, the
page's own relative `fetch` is authenticated, the app's own window renders,
and closing the window hides it instead of quitting.

---

## 13. The tray — a defect found by asking how a key is entered

The app ships with an app-owned window that holds the provider settings, the
session inspector and the dispatch inspector. It works: the packaged
self-check opens it, it renders, and it lists the four providers.

And nothing could reach it.

The upstream client's avatar at the bottom of the rail opens the **Mini
App's own** settings — the upstream overlay, not MiniBots' provider
settings. The upstream client is preserved byte-for-byte
(`client files changed: 0`), so there is nothing in it that knows MiniBots
exists. The preload bridge exposed `openAppWindow()`, but the only caller
was the **self-check** — in normal use, no one called it.

So the app shipped with **no way to enter an API key**. The engine, the
bots, the groups, the schedules and the memory all worked; the model calls
could not, because no key could ever be entered.

### The strings were in the wrong process

The tray's labels — "Open MiniBots", "Start at sign-in", "Quit MiniBots" —
were already written, in English and Chinese, in the app's own string table.
They were never shown:

- the table lives in the **renderer**, at `src/app/strings.js`, and the
  renderer never reads the tray keys;
- the **main process** builds the tray, and it could not reach that table;
- so every menu item fell back to the app's own tooltip, and the menu read
  `MiniBots / MiniBots / MiniBots`.

The fix puts the table where both processes can use it. The app's own
window's folder moved from `src/app-ui/` to `src/app/` — the same name as
the route it serves — and the main process imports it as `../app/strings.js`.
That specifier resolves in the development build (`dist/app/strings.js`) and
in the archive (`app.asar/dist/app/strings.js`) alike.

### The tray is the way in

The tray menu now has four items, each labelled with what it does, in the
user's language:

```
Open MiniBots
Settings…
☐ Start at sign-in
─────────────
Quit MiniBots
```

**Settings…** opens the app's own window — the provider settings. The tray
follows the app's language: changing it in the app's own window rebuilds the
menu, because Electron's menu items are immutable once a menu is built.

### The shell smoke test drives the user's path

The smoke test used to open the app's window through the preload bridge —
the bridge is not how a user reaches it. It now calls the same function the
tray's item calls, and it checks that the window really shows **four visible
key fields and a Save button**: the surface the user is there for.

### A check that waits, because a check that races is not a check

The first version of that check probed the window **once**, and read the
provider cards straight away. The cards are rendered after the window's own
data has loaded, so the check passed or failed depending on the machine's
mood: one run reported four key fields, the next reported zero.

A check that is right by luck is not a check. Both the smoke test and the
packaged self-check now **wait** for the cards, and the packaged verification
is run five times in a row
(`scripts/verify-package-repeatedly.ps1`) — five runs, five passes.

### What this cost

The suite was green throughout: 4/4 type checks, 17/17, 30/30, 54/54,
343/343 upstream, 22/22 → 30/30 Electron, 21/21 → 25/25 shell, 34/34
package. **Every one of them passed while the app had no way to enter an
API key.**

The lesson is not about the tray. It is that a green suite proves the code
does what it was written to do, and it says nothing about whether the user
can reach the thing they need. The question "how does a user add their API
key?" was asked of the finished app, and the answer was "there is no way".

---

## 14. The Windows release — M6 findings

### The ASAR packager's unpack list must stay short

The first packaging attempt failed with:

```
TypeError: pattern is too long
    at assertValidPattern (…\@electron\asar\node_modules\minimatch\minimatch.js:281:11)
    at isUnpackedDir (…\@electron\asar\src\asar.ts:23:47)
```

`@electron/asar` joins **every unpacked file's path** into a single
brace-expansion glob, and `minimatch` refuses a pattern longer than 64 KB.
Unpacking the whole Pi runtime — 2,579 files — produces a glob far longer
than that, and the build fails.

The fix is to unpack only what genuinely needs a real file on the disk:

```yaml
asarUnpack:
  - dist/node_modules/@earendil-works/pi-tui/native/win32
```

Two files. The glob is short, and the build succeeds.

### Only the native prebuilds need a real path

Electron 45 restricts file descriptors inside an ASAR archive, so a **native
addon** cannot be loaded from one — it has to be a real file. That is the
only thing that has to be unpacked:

| What | Where it lives in the packaged app | Why |
|---|---|---|
| Pi's native prebuilds | `app.asar.unpacked/dist/node_modules/…/native/win32` | loaded through `dlopen`, which needs a real path |
| The backend's shim | `app.asar.unpacked/dist/backend/backend-shim.cjs` | a forked process needs a real file to run |
| The vendored Mini App | inside `app.asar` | the upstream server reads the client with `readFile`, which works through an archive |
| The Pi runtime | inside `app.asar` | imported by its bare package name, which Node resolves through the archive's own `node_modules` |

The archive holds **9,474** entries. `scripts/verify-package.mjs` lists the
archive and checks each of these by name.

### `rcedit` needs Developer Mode or administrator rights

The second packaging attempt failed while extracting electron-builder's
`winCodeSign` tool:

```
errorOut=ERROR: Cannot create symbolic link : A required privilege is not
held by the client. : …\winCodeSign\103299411\darwin\10.12\lib\libcrypto.dylib
```

The archive contains macOS symbolic links, and creating one on Windows needs
Developer Mode or administrator rights — which a build machine does not
necessarily have. The two failing links are for **macOS** libraries, which a
Windows build does not use at all.

`signAndEditExecutable: false` skips the tool. The consequence is stated
plainly: the **executable** keeps Electron's own icon, while the installer
and the Start menu entry carry the app's icon. That is a cosmetic
limitation of an unsigned, non-elevated build, and it is recorded here
rather than hidden.

### The app checks itself

A packaged app cannot be checked by a script beside it: the script's
`electron` import resolves to the npm package, not to the application's
runtime. The check therefore lives **inside** the app.

`MINIBOTS_SELF_CHECK` names a report file; when the environment sets it, the
main process runs the check after the backend is up and writes the report to
that file, then exits with a status code. A normal launch never takes that
path — the variable is simply not set.

`scripts/verify-package.mjs` launches `release/win-unpacked/MiniBots.exe`
with the variable set and reads the report. The check runs in the **real
packaged application**: the real window, the real utility process, the real
vendored client.

### The packaged app has no console — it needs a log of its own

On Windows, a GUI application does not write to a console at all. A packaged
app that cannot start therefore says **nothing**: there is no output, no
exit code, and — worst of all — the JavaScript error dialog waits for a
click, so the process never exits either.

Three things came out of this:

1. **The app writes its own log.** `src/main/app-log.ts` writes
   `minibots.log` into the app's user-data directory, and every step of the
   start-up is traced into it. The last line before a hang is where the
   hang is.

2. **The verification reads the crash dialog.** A dialog is a real Windows
   window, so its text is read through the UI Automation API
   (`scripts/read-window-text.ps1`). The verification now reports *why* the
   app failed to start instead of timing out silently.

3. **The app's own log is the first thing that is written.** It is written
   before anything else, so a failure in any later step is recorded.

### Four packaging defects, each found by running the real artifact

The packaged app failed four times before it started. Each failure was
found by **launching the built artifact**, not by reading the code.

#### 1. The compiled output was CommonJS, not ESM

The sources are ESM, but a `.js` file is only read as ESM when the nearest
`package.json` says `"type": "module"`. `dist/` had no `package.json`, so
Node read `dist/backend/backend-entry.js` as CommonJS and failed:

```
Cannot find module 'file:///…/dist/backend/backend-entry.js'
```

The build now writes `dist/package.json`. (In the packaged app the
**archive's** own root `package.json` is the nearest ancestor of `dist/`,
and it already carries `"type": "module"`.)

#### 2. The CommonJS transform rewrote the shim's dynamic import

The backend's shim is CommonJS, because it is the one file Electron forks.
It was being **compiled**, and TypeScript's CommonJS transform rewrites
`import(specifier)` into `require(specifier)`:

```js
// dist/backend/backend-shim.cjs, as it was
Promise.resolve(`${pathToFileURL(entry).href}`).then(s => __importStar(require(s)))
```

That is a `require` of a `file://` URL, which cannot work. The shim is now
**copied verbatim** and never compiled, so the real dynamic import survives —
and it is the only thing that can load an ES module. It is still
type-checked, in its own CommonJS configuration.

#### 3. The utility process is not a browser process

`src/main/paths.ts` imported `electron`'s `app`, and the backend imported
`paths.ts`:

```
SyntaxError: The requested module 'electron' does not provide an export named 'app'
```

A utility process has no `app`. The two path helpers the backend needs —
`resourcesPath()` and `resourcesRoot()` — now live in
`src/main/resources.ts`, which has no Electron dependency at all and reads
`process.resourcesPath`, a plain process property.

#### 4. The packager's file list was incomplete

`electron-builder.yml` listed `dist/main`, `dist/backend`, `dist/app`,
`dist/client`, `dist/vendor` and `dist/node_modules` — but not
`dist/storage`, `dist/runtime` or `dist/tools`. A directory that is not in
the list is dropped silently, and the app then failed at start-up with a
dialog reading:

```
Cannot find module '…/app.asar/dist/storage/atomic-json.js'
```

The list is now `dist/**/*`, so a new directory is shipped automatically.

### The unpacked shim is not beside the entry point

The shim is unpacked onto the disk; the entry point stays inside the
archive. So the two are in **different places**, and the shim could not
find its neighbour:

```
Cannot find module '…/app.asar.unpacked/dist/backend/backend-entry.js'
```

The main process knows both places — it can see into the archive through
Electron's own file API — so it passes the entry point's URL to the shim in
`MINIBOTS_BACKEND_ENTRY`. The shim uses it when it is given, and falls back
to its neighbour for a development run.

### A static import of the vendored subtree is wrong in a packaged build

The upstream Mini App's server was imported statically:

```ts
import { start as startUpstream } from '../../vendor/minimax-bot/miniapp/node/server.mjs';
```

That specifier is relative to the **source** file, so the compiled output in
`dist/backend/` asks for `../../vendor/…` — the app's root, not `dist/`. In a
development run that happens to be right, because the vendored tree is copied
to the repository's own `vendor/` as well. In a packaged build it is one level
out:

```
Cannot find module '…/app.asar/vendor/minimax-bot/miniapp/node/server.mjs'
```

The upstream server is now loaded **dynamically, from the path the host
resolves** — the same `pluginRoot` the Mini App is started with. A `file://`
URL is used, so the loader can also reach inside the archive.

The same reasoning applies to the Mini App's own existence check: a path
inside an archive may not answer `existsSync` in the utility process, so the
check tries the plain path first and the file's own URL second.

### The verification checks the whole module graph

The verification used to check a handful of named files. That is not
enough: the fourth defect above shipped four of the app's own directories
without tripping a single check.

The verification now walks the archive's own listing and resolves **every
relative import** in the compiled app against it. A file the app needs and
the archive does not have is a failure, by name. A check that finds nothing
is reported as a check that did not run, rather than as a pass.

### A build writes into a directory of its own

A freshly written archive is often opened by a scanner without
`FILE_SHARE_DELETE`, and such a file **cannot be deleted** — not even
renamed. The next build then fails with:

```
remove …\release\win-unpacked\resources\app.asar: The process cannot access
the file because it is being used by another process.
```

So every build writes into a directory named after the moment it was built,
and the previous build's directory is left alone. `scripts/package.mjs`
reports the directories Windows will not let go, rather than pretending they
were cleared.

### The icons are made from the upstream skin

The app's icon and its tray icon are derived from the upstream Mini App's
`fuzzy` skin — the bot face the upstream client already uses as its brand
mark — so the app and the Mini App wear the same face, and the upstream art
keeps its notice.

`scripts/make-icons.mjs` reads the upstream PNG, undoes its per-row filters,
downsamples it with a box filter and writes a new PNG. It is written by hand
rather than with an image library, because the build has no image dependency:
a 32×32 RGBA PNG is a few hundred bytes of zlib data.

The tray icon is drawn at **32×32**, because Windows scales a tray icon into
a 16-pixel box and a large picture is drawn tiny and muddy.

### A stray Electron process holds the single-instance lock

The app takes a single-instance lock, so a second copy quits immediately. A
leftover Electron process from an earlier run therefore makes the **next**
run quit before it writes a single check, and the report is empty.

`scripts/verify-all.ps1` therefore clears stray Electron processes before
each Electron run. The same applies to the packaged app: a `MiniBots.exe`
left running holds `release/win-unpacked/resources/app.asar` open, and the
next packaging attempt fails with "The process cannot access the file
because it is being used by another process."


### The M6 verification

`npm run verify:package` → **34/34 checks passed**.

It confirms, against the built artifact:

- the unpacked build, the archive and the unpacked tree all exist;
- the app's own code, the preload, the app's own pages and the client are all
  inside the archive;
- the app's **whole module graph** is in the archive — 95 relative imports
  resolved across 60 compiled files;
- the vendored Mini App and the Pi runtime are inside the archive;
- the Windows native prebuilds and the backend's shim are **on the disk**,
  outside the archive;
- the archive's own `package.json` marks the build as an ES module and points
  at the app's entry point;
- every shipped package states its licence, and the upstream Mini App's own
  licence notice and list of modifications travel with the code;
- the installer exists, is not empty, and its SHA-256 is recorded;
- the packaged app **starts**: the window appears, the page is served from
  the app's own origin, the preload bridge is installed, the backend
  answers, the client's stylesheet loads, the client's module script runs,
  the page's own relative fetch is authenticated, and the app's own window
  opens with its four providers, and the tray icon loads from inside the archive — **12/12** inside the app itself.

### The M6 verification, as a whole

| Suite | Command | Result |
|---|---|---|
| Types | `npm run typecheck` | 4/4 configurations pass |
| Runtime | `npm run test:runtime` | 17/17 |
| Desktop | `npm run test:desktop` | 30/30 |
| Integration | `npm run test:integration` | 54/54 |
| Upstream | `npm run test:upstream` | 343/343 |
| Electron desktop | `scripts/desktop-tests.mjs` | **30/30 checks passed** |
| Shell | `npm run test:smoke:shell` | **25/25 checks passed** |
| Package | `npm run verify:package` | **34/34 checks passed** |
| Providers | `npm run test:providers` | **UNTESTED** — no key configured |

---

## 15. What is still unverified

| Item | Status | Why |
|---|---|---|
| DeepSeek / MiniMax / OpenAI real file task | **UNTESTED** | no provider key configured |
| MCP server call, failure, reconnect | not yet exercised | needs the tool dispatch layer (M3) |
| Native process-tree cancellation | not yet exercised | needs the tool dispatch layer (M3) |
| The installer run from a path with spaces and Unicode | not yet exercised | the installer is a per-user NSIS installer that lets the user choose the folder; it has not been installed on this machine |
| The installed app's start-at-sign-in entry | not yet exercised | needs the installed build |
| The installed app's tray icon | not yet exercised | needs the installed build |
| Upgrade preserving the data | not yet exercised | needs two installed versions |
| The executable's own icon | **known limitation** | `rcedit` needs Developer Mode or administrator rights; the installer and the Start menu entry carry the app's icon, the executable keeps Electron's |

Two of these are worth spelling out, because the difference between "not
exercised" and "known broken" matters.

**The start-at-sign-in entry** is written by
`app.setLoginItemSettings({ openAtLogin, path: process.execPath })`, which is
Electron's own API and is only called when `app.isPackaged` is true. The
packaged build *is* `isPackaged`, and the verification launches it — but the
verification does not read the Windows registry, so whether the entry landed
is not measured.

**The upgrade path** depends on the installer replacing the program files and
leaving `%APPDATA%\minibots` alone. The installer is configured with
`deleteAppDataOnUninstall: false` and `perMachine: false`, which is the
configuration that does that — but a measurement needs two installed
versions, and only one has been built.
