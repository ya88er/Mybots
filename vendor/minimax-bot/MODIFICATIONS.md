# Modifications to the imported upstream subtree

This file records every change made to `vendor/minimax-bot/` after the import.
The upstream baseline is commit `79ebc4b89be6b372365199db92d69e5e36ac3409`
of <https://github.com/MiniMax-AI/MiniMax-Code-MiniApps>, subtree
`plugins/minimax-ai/minimax-bot`, package `minimax-bot@0.7.16`, MIT.

`UPSTREAM.md` records the import itself. This file records what the Windows port
changed.

---

## 1. Windows-safe atomic rename — new file

**`miniapp/node/fs-safe.mjs`** (new)

`renameWithRetry(from, to)` retries the transient Windows file lock
(`EPERM`, `EACCES`, `EBUSY`) with a bounded linear backoff, and rethrows every
other error immediately.

**Why.** On POSIX, `rename()` replaces the destination inode even while another
handle holds it open. On Windows it fails with `EPERM`. The upstream suite was
authored on macOS, so this race cannot surface there — and it did not surface
until the suite ran on this machine.

**Evidence.** `docs/runtime-validation.md` §8. Baseline on Windows:
`pass 341 / fail 2`, with `{"status":"error","errorCode":"EPERM"}`. After the
fix: `pass 343 / fail 0`, over five consecutive runs. Both original failures
reproduce in the pristine upstream checkout, so they are a porting defect and
not something this port introduced.

**Regression test.** `tests/runtime/fs-safe.test.mjs` — the first test shows a
plain rename over a held-open destination **fails** on this platform, the
second shows `renameWithRetry` **succeeds** on the same scenario, and the third
shows a non-transient `ENOENT` is rethrown rather than retried away.

---

## 2. Call sites switched to `renameWithRetry`

| File | Line (upstream) | What it writes |
|---|---|---|
| `miniapp/node/store.mjs` | 124 | the state document, atomically |
| `miniapp/node/team.mjs` | 284 | an imported avatar, content-addressed |
| `miniapp/node/memory.mjs` | 230 | the memory journal's pending record |
| `miniapp/node/memory.mjs` | 270 | a memory scope's document |
| `miniapp/node/memory.mjs` | 433 | the archived copy of a scope |
| `miniapp/node/server.mjs` | 414 | an uploaded file, content-addressed |

The unused `rename` import was removed from each of those four modules.

**Why the avatar and upload paths need it specifically.** Both name their
destination by content hash, so two concurrent imports of the same bytes target
the *same* file. The second rename therefore always collides with the first.

---

## 3. The model catalogue contract — `miniapp/node/miniapp-api.ts`

Added:

```ts
export interface MiniAppModelCatalogEntry {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName?: string;
  readonly thinking?: { readonly efforts?: readonly string[]; readonly default?: string };
  readonly variants?: readonly string[];
  readonly contextLimit?: number;
  readonly supportsTools?: boolean;
  readonly supportsImages?: boolean;
}

export interface MiniAppModelCatalog {
  readonly models: readonly MiniAppModelCatalogEntry[];
  readonly default?: MiniAppModelCatalogEntry;
}
```

and `models?(): Promise<MiniAppModelCatalog>` on `MiniAppAgentClient`.

**Why.** `engine.mjs:999-1012` already called `agent.models()` and read
`catalog.default` and `catalog.models[]`, but the contract did not declare it.
The implementation plan's §4.2 flagged this as the one genuine gap.

**The field set was read off the real consumers, not guessed.** The engine's
`effortOptions` and `withEffort` read `thinking.efforts` and `variants`; the
settings page (`panels.js`) reads `displayName` and `thinking.default`; the
`/api/models` route serves `{ supported, models, default }`.

**Regression test.** `tests/runtime/model-catalog.test.mjs` — 6 tests covering
the unsupported case, the catalogue and its default, effort resolution against
the default, fallback for an unsupported effort, the effort list the UI
offers, and a Bot that names its own model.

---

## 4. Test-harness cleanup retry — new file

**`tests/helpers/temp-dir.mjs`** (new)

`removeTempDir(dir)` retries `ENOTEMPTY`, `EPERM`, `EACCES` and `EBUSY` when
removing a temporary directory.

**Why.** `rm(dir, { recursive: true })` can fail with `ENOTEMPTY` when a file
is written into the directory while the removal walks it. A background helper
turn can still be settling its files when the test's cleanup hook runs.

**Where it is used.** `tests/helper-usage.test.mjs` only — the one file where
the race was actually observed (roughly one run in four). The other 24 test
files use the same cleanup shape and were left untouched; they did not flake.

**Evidence.** Five consecutive full-suite runs after the change: `pass 343 /
fail 0` every time. Before it, the same suite showed the
`helper-usage` cleanup flake in 1 of 3 runs.

---

## 5. The tool dispatch exposed to another transport

**`miniapp/node/mcp.mjs`** and **`miniapp/node/server.mjs`**

`createMcpHandler` gained a `dispatch` object, and the handler it returns
carries it as a property. The lifecycle `server.mjs` returns carries it too.

```js
dispatch = {
  definitions: () => toolDefs(),
  names: () => [...TOOL_NAMES],
  call: async (name, args, options = {}) => { /* ... */ },
  failureText: (error, name) => failureText(error, name),
};
```

**Why.** The implementation plan requires the 21 MiniBots business tools to be
registered as Pi custom tools **and** to keep the Streamable HTTP MCP
endpoint as another transport over the *same* handlers: "Avoid duplicated
implementations." The handlers were already in one place, but they were
reachable only through the HTTP request handler, so a second transport would
have had to reimplement them.

**What did not change.** The HTTP endpoint's own behaviour is untouched: it
still authenticates its caller through the transport's credentials and still
accepts a model-supplied `caller_bot_id`. The `dispatch.call` path takes the
caller as an *option*, and the Windows app binds it from the runtime — the
model's own field is removed before the call, so a model cannot borrow
another Bot's authority by naming it.

**No upstream test was changed, and none needed to be.** The upstream suite
still passes 343/343.

---

## 6. The schedule catch-up hook

**`miniapp/node/engine.mjs`** and **`miniapp/node/server.mjs`**

The `Engine` accepts an optional `scheduleCatchUp` dependency, and
`tickSchedules` asks it before it delivers an overdue schedule:

```js
if (this.scheduleCatchUp && (await this.scheduleCatchUp(schedule.id, schedule.nextRunAt))) {
  schedule.nextRunAt = nextRun(schedule, now + 1000);
  changed = true;
  continue;
}
```

**Why.** The implementation plan requires "one catch-up delivery per overdue
schedule". The upstream already delivers an overdue schedule once and moves
its `nextRunAt` forward — but it keeps no record that it did. If the app
restarts before the schedule's next slot, the upstream cannot tell an
un-delivered occurrence from one it already delivered.

The Host's catch-up record answers exactly that question. When the hook is
absent, the upstream behaviour is unchanged, so the upstream suite still
passes 343/343 with no test modified.

**The upstream's own behaviour is preserved:** the schedule still fires, still
posts its note into its Bot's chat and still moves to its next slot. Only a
*duplicate* catch-up is suppressed.

---

## 7. The Providers section in the settings sidebar

**`miniapp/client/panels.js`**, **`miniapp/client/core.js`** and
**`miniapp/client/strings-panels.js`**

The settings sidebar gained one entry, `Providers`, between `General` and
`Bots`. It renders a row per provider — a masked key field, **Save**,
**Remove**, **Test connection** and a status — exactly as the upstream
renders the other sections.

```js
const PAGES = [
  ['general', 'panels.settings.page.general', 'sliders'],
  ['providers', 'panels.settings.page.providers', 'plug'],
  ...
];
```

**Why.** The provider keys belong to the **desktop app**, not to the Mini App:
they are encrypted with the operating system's key store and they never reach
the upstream server. The Mini App's own settings — General, Bots, Groups,
Memory, Tasks, Scheduled tasks, Usage — have nowhere to put them, so the
desktop app's keys had no home in the app's own settings window. The user
asked for the section to be there, and it is.

**How the keys are read and written.** Through the desktop app's own bridge,
`window.minibots`, which the preload exposes in the chat window too. The
page calls `listProviders`, `listCredentials`, `saveCredential`,
`removeCredential` and `testProvider`. **No key is ever sent over HTTP** and
no key is ever read back: the page is told only *which* providers are
configured, and the field it shows for a configured provider is a mask.

**The Mini App on its own.** `window.minibots` is absent when the Mini App
runs without the desktop app, so the page says so
(`panels.providers.unavailable`) instead of failing. The upstream's own
behaviour is unchanged in that case.

**What did not change.** The upstream's `h()` helper, its `set-row` /
`set-group` / `soft` / `muted` classes, the sidebar's layout, its icons and
its artwork. The section uses the upstream's own components and its own
styling; the only new thing is one icon path (`plug`) in the icon set.

**Strings.** Ten new keys, in both English and Chinese.

**That the Save button works.** The packaged app's own self-check types a probe
key into this section's **own** field and clicks this section's **own** Save
button — no injection behind the page, no bridge call that bypasses the
button — and then asserts that the provider is configured, that the backend is
still answering, that the key is never read back out, and that the key can be
removed again. It leaves no key behind. That check lives in the desktop app,
not in the upstream, so it adds nothing to the three changed files.

**The upstream suite still passes 343/343**, with no test modified: the
change is entirely in the client, and the upstream's tests cover the engine.

---

## 8. What was NOT changed

- The engine's business logic: groups, relay guards, group notes, memory
  selection, helper admission, schedules, usage metering.
- The client UI's **layout**, its 11 looks, and its artwork. The settings
  sidebar gained one section, as described above; nothing else moved.
- The `MiniAppAgentRunEvent` / `MiniAppAgentRunResult` contract: the adapter
  implements it verbatim instead of the engine migrating to a new shape.
- The MCP protocol's own behaviour: the HTTP endpoint's request handling,
  its session handling, its schema validation and its error reporting are
  unchanged. Only the dispatch was exposed, so a second transport can share
  the handlers.
- Every upstream test file's assertions and its test bodies. Only the
  `helper-usage` cleanup hook was changed, and only in the way described above.

All of `miniapp/client/` and `tests/` are otherwise byte-identical to the
pinned upstream commit, and the upstream `LICENSE` and `README.md` are
preserved unmodified.
