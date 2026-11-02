# MiniBots — operations guide

Everything a person needs to install MiniBots, set it up, and keep it
running. The app is a **per-user Windows application**: it installs into your
own user profile, needs no administrator rights, and touches nothing outside
your user folder.

---

## 1. Install

1. Run `MiniBots-Setup-<version>-x64.exe`.
2. The installer asks where to put the app. The default is fine; a path with
   spaces and non-ASCII characters works — the app has been checked with
   `C:\Program Files\MiniBots` and with a path containing `ü` and Chinese
   characters.
3. The installer adds a **Start menu** entry and a **desktop shortcut**.

The installer is **unsigned**. Windows SmartScreen will warn about an
unrecognised publisher the first time; choose *More info → Run anyway* if
you trust the file. The SHA-256 of the file you received is recorded in
`docs/ACCEPTANCE.md`; check it against that number if you want to be sure
the download was not altered.

There is **no** separate Node.js, Pi CLI or Python installation to do. The
app carries its own runtime.

---

## 2. First run

On the first launch MiniBots:

1. opens the chat window;
2. starts a background service (the *backend*) that holds the bots, the
   conversations, the memory and the schedules;
3. puts an icon in the **system tray**, next to the clock.

The tray icon is the app's real handle. The window can be closed and the app
keeps working — see [§6](#6-the-tray-and-the-window).

### The Chief

The Mini App seeds one bot, **Chief**, the team lead. Chief is the bot you
talk to; it can create more bots and groups for you.

---

## 3. Set up a provider

MiniBots talks to a model provider using **your own API key**. Nothing is
sent to a MiniBots server — there is no such server — and the key never
leaves your machine in readable form.

1. Open the app's own window. From the **tray icon** in the notification area,
   choose **Settings…**. (Right-click the tray icon; the item is between
   "Open MiniBots" and "Start at sign-in".)
2. The **Providers** section is the one that opens.
3. Pick a provider, paste the key into its **API key** field, and press
   **Save**.

| Provider | Where to get the key |
|---|---|
| DeepSeek | <https://platform.deepseek.com/api_keys> |
| MiniMax (international) | <https://platform.minimax.io/user-center/basic-information/interface-key> |
| MiniMax (China) | <https://platform.minimaxi.com/user-center/basic-information/interface-key> |
| OpenAI | <https://platform.openai.com/api-keys> |

MiniMax is listed twice because its keys are **region-specific**: an
international key will not work against the China endpoint, or the other way
round. If a MiniMax key is refused, try the other region.

The key is encrypted with the operating system's own key store — Windows
DPAPI on Windows — before it is written to disk. It is never written in
plain text, never written to a Pi auth file, and never printed in a log.

Press **Test connection** to check a key. The test is an explicit action:
it makes a real request to the provider, and a real request costs money, so
it never runs on its own when the page opens.

### Choosing a model

Each bot can name its own model. Open a bot's settings from the drawer on
the right of the chat window and pick a provider, a model and a reasoning
level. Only the models of providers you have configured are offered.

---

## 4. Where your data lives

Everything is under Windows' per-user application data folder:

```text
%APPDATA%\minibots\
  data\                 the Mini App's own state: bots, chats, groups, schedules
  sessions\             the Pi session files, one per conversation
  agent\                Pi's own agent directory
  credentials.enc.json  your encrypted provider keys
  settings.json         the app's own settings (start at sign-in, language)
```

Open that folder quickly with `Win + R` and this:

```text
%APPDATA%\minibots
```

### Back up and restore

Close MiniBots from the tray (**Quit**), then copy the whole `minibots`
folder somewhere safe. Copy it back to restore. The folder is plain files;
nothing needs to be unpacked.

### Uninstalling

The uninstaller removes the program. It deliberately **keeps your data** —
your conversations, your bots, your memory and your keys stay in
`%APPDATA%\minibots`. Delete that folder yourself if you want them gone.

---

## 5. Start at sign-in

The tray menu has a **Start at sign-in** tick box. Turn it on and MiniBots
starts when you sign in to Windows.

- The tick reflects the **preference**. The app only registers itself with
  Windows when it is really installed.
- Starting at sign-in means the backend is running from then on, so a
  schedule that comes due while you are away is delivered when you return.
- A schedule that came due while the app was **closed** is delivered **once**
  when the app next starts — not once per missed occurrence.

---

## 6. The tray and the window

| What you do | What happens |
|---|---|
| Close the window | The window **hides**. The app keeps running in the tray. |
| Click the tray icon | The window comes back. |
| **Settings…** in the tray menu | The app's own window opens: providers, sessions, dispatches. |
| **Start at sign-in** in the tray menu | Ticks or unticks the preference. |
| **Quit MiniBots** in the tray menu | The app stops completely. |

The quit is the only way to stop the app. It stops the backend with a bounded
wait, so a stuck tool cannot leave a stray process behind.

---

## 7. Working in the background

MiniBots can work while you are not looking at the window:

- **Schedules** ask a bot to do something at a time — daily, every *n*
  minutes, or once. They are set in the app's **Settings → Schedules**, or
  asked for in chat.
- **Helpers** are background bots that keep working on a task.
- **Handoffs** move a conversation from one bot to another.

Two things have to be true for background work to happen:

1. **the PC must be awake** — a sleeping or switched-off machine does not run
   schedules;
2. **a provider key must be configured** — a bot with no key cannot call a
   model, and the task will fail rather than wait.

---

## 8. Troubleshooting

### The window is blank

The window is served by the app's own background service. If it is blank,
the backend probably did not start. Quit the app from the tray and start it
again. If it stays blank, the logs will say why — see [§9](#9-logs).

### A bot says there are no models

No provider key is configured, or the key is for a provider that offers no
models. Open **Providers** and press **Test connection**.

### A MiniMax key is refused

Try the other MiniMax region — the international and China endpoints have
separate keys.

### "The result is not confirmed"

A tool was interrupted — the app was closed, or the machine slept — so
MiniBots cannot say whether the work happened. It reports this rather than
guessing, and it does **not** repeat the work on its own: check what the bot
did before letting it try again.

### The app will not start at sign-in

Check the **Start at sign-in** tick in the tray menu. If the tick is on and
the app still does not start, the registration may have been lost; turn the
tick off and on again.

---

## 9. Logs

The app writes its log next to the data folder:

```text
%APPDATA%\minibots\minibots.log
```

The log records what the app did, not what you said: bot names, tool names,
error messages and timings. **API keys are never written to it.** If you are
reporting a problem, the log is the first thing to attach.

The log also records the **start-up trace** — each step of the start-up, in
order. It is the first thing to look at when the app does not start: the last
line before the failure is the step that failed.

---

## 10. Recovering from a crash

MiniBots is built to recover on its own:

- a conversation remembers which model session it belongs to, and the
  association is written **before** the turn is acknowledged — so a crash
  does not lose the link;
- an interrupted tool call is recorded as **not confirmed**, not as success
  and not as failure;
- a schedule that came due while the app was down is delivered once, not
  twice.

If the app will not start at all, quit it, check the log, and — as a last
resort — restore the data folder from a backup.

**If the app will not start and there is no log at all**, the packaged build
is probably incomplete. Reinstall it from the installer; the program's own
files are replaced and your data is kept.

---

## 11. Upgrading

Install the new version over the old one. The installer replaces the program
and **keeps your data**, so your conversations, bots, memory, avatars and
keys are all still there afterwards.

---

## 12. What MiniBots does not do

- **It does not phone home.** There is no account, no login and no server.
  The only network traffic is to the model provider you configured, and to
  wherever you point a bot's own tools.
- **It does not update itself.** A new version is a new installer.
- **It does not run on a sleeping PC.** Schedules need an awake machine.
- **It does not work without a provider key.** The engine, the bots, the
  groups, the memory and the schedules all work without one; only the
  model calls need it.

---

## 13. Licence and attribution

MiniBots is a derived work of the **MiniMax Bot Mini App**, by MiniMax,
used under the MIT licence; the original notice is kept at
`vendor/minimax-bot/LICENSE`. The agent runtime is **Pi**, by earendil-works,
also MIT-licensed. The full inventory is in `docs/LICENSES.md`, and the
changes made to the upstream subtree are listed in
`vendor/minimax-bot/MODIFICATIONS.md`.
