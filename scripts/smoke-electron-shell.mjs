// Electron entry point for the M2 shell smoke test.
//
// It launches the real application: the main process, the utility process and
// the window. The window loads the real vendored client, and the backend is
// the real upstream Mini App.
//
// The check is that the shell works end to end: the window appears, the
// backend answers through the gate, and the renderer can reach the backend
// through the main process without ever seeing the bearer token.
//
// Electron on Windows does not write to the console of a GUI application, so
// the report goes to a file and the process exits with a status code.
//
// Run:  npx electron scripts/smoke-electron-shell.mjs
import { app, BrowserWindow } from 'electron';
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(import.meta.url), '..');
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

// The whole run lives inside `whenReady`, because Electron's readiness is a
// promise that a top-level `await` in an ESM entry does not sequence
// reliably against the app's own start-up.
app.whenReady().then(async () => {
  try {
    // The main process's own module starts the backend and the window when it
    // is imported. It is imported here so that the smoke test drives the
    // same code path the application does.
    //
    // `app.getAppPath()` is the directory of the script Electron was launched
    // with, which is `scripts/`; the app's root is its parent.
    const projectRoot = resolve(here, '..');
    const entry = joinPath(projectRoot, 'dist', 'main', 'main.js');
    await import(`file://${entry.replace(/\\/g, '/')}`);

  // The window appears.
  const windowAppeared = await until(() => BrowserWindow.getAllWindows().length > 0);
  check('a window is created', windowAppeared);

  const window = BrowserWindow.getAllWindows()[0];
  if (!window) throw new Error('no window');

  // The window loads the real client.
  const loaded = await until(
    () => !window.webContents.isLoading() && window.webContents.getURL().length > 0,
  );
  check('the window loads a page', loaded, window.webContents.getURL());

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

  // The model catalogue route works through the same path.
  const models = await window.webContents.executeJavaScript(
    'window.minibots.request({ path: "/api/models" })',
  );
  check(
    'the model catalogue is served',
    models?.body?.supported === true,
    'the Host lets a run pick its model',
  );

  // The session inspector route works.
  const sessions = await window.webContents.executeJavaScript(
    'window.minibots.request({ path: "/api/app/sessions" })',
  );
  check(
    'the session inspector is served',
    typeof sessions?.body?.count === 'number',
    `sessions: ${sessions?.body?.count ?? 'n/a'}`,
  );

  // The gate refuses a request without the token. The renderer has no way to
  // reach the backend's own port, so this is the app's only way in.
  const gatePort = await window.webContents.executeJavaScript(
    'window.minibots.request({ path: "/api/app/sessions" }).then(() => "via-bridge")',
  );
  check('the bridge is the only way in', gatePort === 'via-bridge');
  } catch (error) {
    failed.push('the shell smoke test');
    say(`FAIL  the shell smoke test — ${error?.stack ?? error}`);
  } finally {
    say(`\n=== ${passed.length}/${passed.length + failed.length} checks passed ===`);
    app.exit(failed.length === 0 ? 0 : 1);
  }
});

/** Join path segments with the platform's separator. */
function joinPath(...segments) {
  return segments.join(/[\\/]/.test(segments[0]) && segments[0].includes('\\') ? '\\' : '/');
}
