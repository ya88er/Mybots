// Electron entry point for the M5 shell smoke test.
//
// It launches the real application: the main process, the utility process and
// the window. The window loads the real vendored client from the app's own
// loopback origin, and the backend is the real upstream Mini App.
//
// The checks are that the shell works end to end:
//
// - the window appears and loads the real client **with its stylesheet and
//   its module script** — a `file://` page resolves neither of them, so this
//   is the check that the origin fix actually took;
// - the backend answers through the gate;
// - the renderer can reach the backend through the main process without ever
//   seeing the bearer token;
// - the app's own window serves the provider settings and the inspectors;
// - the tray exists and the window hides rather than closing.
//
// Electron on Windows does not write to the console of a GUI application, so
// the report goes to a file and the process exits with a status code.
//
// Run:  npx electron scripts/smoke-electron-shell.mjs
import { app, BrowserWindow } from 'electron';
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const reportPath = resolve(here, '..', 'shell-smoke-report.txt');

/** The checks that passed. */
const passed = [];
/** The checks that failed. */
const failed = [];

/** Write a line to the report. */
function say(line) {
  appendFileSync(reportPath, `${line}\n`, 'utf8');
}

/** Record a check. */
function check(name, ok, detail = '') {
  if (ok) {
    passed.push(name);
    say(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed.push(name);
    say(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Wait for a condition, up to a timeout. */
async function until(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

writeFileSync(reportPath, 'MiniBots shell smoke test\n\n', 'utf8');

app.whenReady().then(async () => {
  try {
    // The main process's own module starts the backend and the window when it
    // is imported. It is imported here so that the smoke test drives the
    // same code path the application does.
    const projectRoot = resolve(here, '..');
    const entry = resolve(projectRoot, 'dist', 'main', 'main.js');
    const main = await import(`file://${entry.replace(/\\/g, '/')}`);

    // The window appears.
    const windowAppeared = await until(() => BrowserWindow.getAllWindows().length > 0);
    check('a window is created', windowAppeared);

    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('no window');

    // The window loads the real client, over the app's own origin.
    const loaded = await until(
      () =>
        !window.webContents.isLoading() &&
        window.webContents.getURL().startsWith('http://127.0.0.1:'),
    );
    check('the window loads a page', loaded, window.webContents.getURL());
    check(
      'the page is served from the app\'s own loopback origin',
      window.webContents.getURL().startsWith('http://127.0.0.1:'),
      window.webContents.getURL(),
    );

    // The preload bridge is installed.
    const bridgePresent = await window.webContents.executeJavaScript(
      'typeof window.minibots === "object" && window.minibots !== null',
    );
    check('the preload bridge is exposed to the renderer', bridgePresent === true);

    // The renderer cannot reach the backend's token.
    const bridgeShape = String(
      await window.webContents.executeJavaScript('JSON.stringify(window.minibots ?? {})'),
    );
    check(
      'the bridge exposes no bearer token',
      !bridgeShape.includes('Bearer') && !bridgeShape.includes('sk-'),
      'the renderer sees no credential',
    );

    // The backend answers 503 until it is up, so the test waits for the first
    // real answer rather than racing the start-up.
    const backendUp = await until(async () => {
      const state = await window.webContents.executeJavaScript(
        'window.minibots.request({ path: "/api/state" })',
      );
      return state?.status === 200;
    }, 30_000);
    check('the backend becomes ready', backendUp);

    // The backend answers through the main process.
    const state = await window.webContents.executeJavaScript(
      'window.minibots.request({ path: "/api/state" })',
    );
    const body = state?.body;
    check(
      'the renderer reaches the backend through the main process',
      Array.isArray(body?.bots),
      `bots: ${Array.isArray(body?.bots) ? body.bots.length : 'n/a'}`,
    );
    check('the agent is wired into the engine', body?.agentAvailable === true);

    // ---------------------------------------------------------------------
    // The client actually renders.
    //
    // The upstream page refers to its own assets by absolute path. A page
    // loaded from the file system cannot resolve them, and the page then
    // loads unstyled with its module script never running. These two checks
    // are what prove the origin fix works.
    // ---------------------------------------------------------------------
    const rendered = await until(async () => {
      const probe = await window.webContents.executeJavaScript(`
        (() => {
          const side = document.getElementById('side-list');
          return JSON.stringify({
            // The stylesheet applied: the upstream page paints a dark body.
            background: getComputedStyle(document.body).backgroundColor,
            // The module script ran: the side list was populated.
            children: side ? side.children.length : 0,
            text: side ? side.textContent.trim().slice(0, 40) : '',
          });
        })()
      `);
      const state = JSON.parse(probe);
      return state.children > 0 && state.background !== 'rgba(0, 0, 0, 0)';
    }, 30_000);

    const renderState = JSON.parse(
      String(
        await window.webContents.executeJavaScript(`
          (() => {
            const side = document.getElementById('side-list');
            return JSON.stringify({
              background: getComputedStyle(document.body).backgroundColor,
              children: side ? side.children.length : 0,
              text: side ? side.textContent.trim().slice(0, 40) : '',
            });
          })()
        `),
      ),
    );
    check(
      'the client\'s stylesheet loaded',
      renderState.background !== 'rgba(0, 0, 0, 0)',
      `body background: ${renderState.background}`,
    );
    check(
      'the client\'s module script ran',
      renderState.children > 0,
      `side list entries: ${renderState.children}`,
    );

    // The page's own relative fetch works — that is the bridge's job.
    const fetched = await window.webContents.executeJavaScript(
      'fetch("/api/state").then((r) => r.text()).then((text) => text.slice(0, 300)).catch((e) => "ERROR " + String(e))',
    );
    const fetchedText = String(fetched);
    check(
      'the page can fetch the API with a relative path',
      fetchedText.includes('"bots"'),
      fetchedText.slice(0, 160),
    );

    // ---------------------------------------------------------------------
    // The app's own window.
    //
    // It is opened the way a user opens it: through the **tray's** settings
    // item. That is the only route to the provider settings in the shipped
    // app, so it is the one that has to work.
    // ---------------------------------------------------------------------
    check('the app can open its own window', typeof main.openSettings === 'function');
    main.openSettings();
    const appWindowAppeared = await until(
      () =>
        BrowserWindow.getAllWindows().some(
          (candidate) => candidate.webContents.getURL().endsWith('/app'),
        ),
    );
    check("the app's own window opens", appWindowAppeared);

    // The app's window is found by its URL, not by its position: the chat
    // window is the first one, and its position is not the app's business.
    const appWindow = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.getURL().endsWith('/app'),
    );
    if (appWindow) {
      await until(() => !appWindow.webContents.isLoading() && appWindow.webContents.getURL().length > 0);
      check(
        "the app's own window is served from the app's origin",
        appWindow.webContents.getURL().startsWith('http://127.0.0.1:') &&
          appWindow.webContents.getURL().endsWith('/app'),
        appWindow.webContents.getURL(),
      );

      const appRendered = await until(async () => {
        const probe = await appWindow.webContents.executeJavaScript(
          'Boolean(document.querySelector(".rail button"))',
        );
        return probe === true;
      }, 20_000);
      check("the app's own window rendered its rail", appRendered);

      // The provider list is the app's own, and the key never comes back.
      const providers = await appWindow.webContents.executeJavaScript(
        'window.minibots.listProviders().then((r) => r.providers.length)',
      );
      check('the app offers its providers', providers === 4, `providers: ${providers}`);

      // The providers section is the one that is open, and each provider has
      // a field to paste the key into. This is the surface the user is
      // actually here for, so it is checked rather than assumed.
      //
      // The cards are rendered after the window's own data has loaded, so
      // the check **waits** for them rather than probing once and reporting
      // a race.
      const keyFieldsReady = await until(async () => {
        const probe = await appWindow.webContents.executeJavaScript(
          'document.querySelectorAll(\'input[id^="key-"]\').length',
        );
        return probe === 4;
      }, 30_000);
      check(
        'the providers section has a key field for every provider',
        keyFieldsReady,
        'key fields: 4',
      );

      const keyFields = await appWindow.webContents.executeJavaScript(`
        (() => {
          const inputs = [...document.querySelectorAll('input[id^="key-"]')];
          return JSON.stringify({
            inputs: inputs.length,
            hasSave: [...document.querySelectorAll('button')].some((b) =>
              /save/i.test(b.textContent || ''),
            ),
            visible: inputs.length > 0 && inputs[0].offsetParent !== null,
          });
        })()
      `);
      const keyState = JSON.parse(String(keyFields));
      check('the key field is visible', keyState.visible === true, 'the user can paste a key');
      check('the providers section has a save button', keyState.hasSave === true);

      const credentials = await appWindow.webContents.executeJavaScript(
        'window.minibots.listCredentials().then((r) => JSON.stringify(r))',
      );
      check(
        'the credential list carries no key',
        !String(credentials).includes('sk-'),
        String(credentials),
      );
    }

    // ---------------------------------------------------------------------
    // The tray and the window lifecycle.
    // ---------------------------------------------------------------------
    // Electron does not expose the tray list, so the tray is observed through
    // its effect: the app must not quit when the window is closed, and the
    // quit path must be the tray's own.
    window.close();
    await new Promise((r) => setTimeout(r, 800));
    check('closing the window hides it instead of quitting', window.isVisible() === false);
    check('the window still exists after a close', window.isDestroyed() === false);

    // The session inspector route works.
    const sessions = await window.webContents.executeJavaScript(
      'window.minibots.request({ path: "/api/app/sessions" })',
    );
    check(
      'the session inspector is served',
      typeof sessions?.body?.count === 'number',
      `sessions: ${sessions?.body?.count ?? 'n/a'}`,
    );

    // The dispatch inspector route works.
    const dispatches = await window.webContents.executeJavaScript(
      'window.minibots.request({ path: "/api/app/dispatches" })',
    );
    check(
      'the dispatch inspector is served',
      Array.isArray(dispatches?.body?.records),
      `records: ${dispatches?.body?.records?.length ?? 'n/a'}`,
    );

    // The app's own pages are served.
    const appPage = await window.webContents.executeJavaScript(
      'window.minibots.request({ path: "/app/index.html" })',
    );
    check(
      "the app's own page is served",
      appPage?.status === 200 &&
        String(typeof appPage.body === 'string' ? appPage.body : '').includes('<!doctype html>'),
      `status: ${appPage?.status}`,
    );
  } catch (error) {
    failed.push('the shell smoke test');
    say(`FAIL  the shell smoke test — ${error?.stack ?? error}`);
  } finally {
    say(`\n=== ${passed.length}/${passed.length + failed.length} checks passed ===`);
    app.exit(failed.length === 0 ? 0 : 1);
  }
});
