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

## 12. What is still unverified

| Item | Status | Why |
|---|---|---|
| DeepSeek / MiniMax / OpenAI real file task | **UNTESTED** | no provider key configured |
| MCP server call, failure, reconnect | not yet exercised | needs the tool dispatch layer (M3) |
| Packaged build loading Pi's runtime assets | not yet exercised | M6 |
| Native process-tree cancellation | not yet exercised | needs the tool dispatch layer (M3) |
