// Electron entry point for the desktop lifecycle tests.
//
// The window's lifecycle and the tray are Electron's own objects, so they can
// only be exercised inside an Electron process. The tests are therefore run
// here rather than by `node --test`.
//
// Electron on Windows does not write to the console of a GUI application, so
// the report goes to a file and the process exits with a status code.
//
// Run:  npx electron scripts/desktop-tests.mjs
import { app, BrowserWindow } from 'electron';
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const reportPath = resolve(here, '..', 'desktop-tests-report.txt');

/** The checks that passed. */
const passed = [];
/** The checks that failed. */
const failed = [];

writeFileSync(reportPath, 'MiniBots desktop tests\n\n', 'utf8');
const say = (line) => appendFileSync(reportPath, `${line}\n`, 'utf8');

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
async function until(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Wait a moment. */
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    const { installWindowLifecycle, createTray, allowClose, isQuitting } = await import(
      `file://${resolve(here, '..', 'dist', 'main', 'window-lifecycle.js').replace(/\\/g, '/')}`
    );

    // -------------------------------------------------------------------
    // The window hides rather than closing.
    // -------------------------------------------------------------------
    const window = new BrowserWindow({ show: false });
    const controller = installWindowLifecycle(window, { onQuitRequested: () => {} });
    window.show();
    await until(() => window.isVisible());

    window.close();
    await pause(600);
    check('closing the window hides it', window.isVisible() === false);
    check('the window is not destroyed by a close', window.isDestroyed() === false);
    check('the window still answers after a close', controller.visible === false);

    // The window comes back.
    controller.show();
    await until(() => window.isVisible());
    check('the window can be shown again', window.isVisible() === true);

    // -------------------------------------------------------------------
    // The quit is explicit.
    // -------------------------------------------------------------------
    check('the app is not quitting yet', isQuitting() === false);
    allowClose();
    check('the quit is recorded once it is requested', isQuitting() === true);

    // -------------------------------------------------------------------
    // The tray.
    // -------------------------------------------------------------------
    let shown = 0;
    let quitRequested = 0;
    let signIn = null;
    let settingsOpened = 0;
    const tray = createTray({
      onShow: () => {
        shown += 1;
      },
      onOpenSettings: () => {
        settingsOpened += 1;
      },
      onToggleStartAtLogin: (enabled) => {
        signIn = enabled;
      },
      isStartAtLoginEnabled: () => false,
      onQuit: () => {
        quitRequested += 1;
      },
      labels: {
        tooltip: 'MiniBots',
        open: 'Open MiniBots',
        settings: 'Settings…',
        startAtLogin: 'Start at sign-in',
        quit: 'Quit MiniBots',
      },
    });

    check('the tray exists', Boolean(tray.tray));

    const menu = tray.menu;
    check('the tray has a menu', Boolean(menu));

    const items = menu?.items ?? [];
    const ids = items.map((item) => item.id).filter(Boolean);
    check(
      'the tray has exactly four actions',
      ids.length === 4,
      `ids: ${ids.join(', ')}`,
    );
    check('the tray can open the window', ids.includes('show'));
    check('the tray can open the settings', ids.includes('settings'));
    check('the tray can toggle start at sign-in', ids.includes('start-at-login'));
    check('the tray can quit', ids.includes('quit'));

    // The items are labelled, and each one says what it does. A menu whose
    // items are all named after the app is a menu nobody can use.
    check(
      'the tray items are labelled',
      items
        .filter((item) => item.id)
        .every((item) => typeof item.label === 'string' && item.label.length > 0),
    );
    check(
      "the tray's settings item says what it does",
      items.find((item) => item.id === 'settings')?.label === 'Settings…',
      items.find((item) => item.id === 'settings')?.label,
    );
    check(
      "the tray's quit item says what it does",
      items.find((item) => item.id === 'quit')?.label === 'Quit MiniBots',
      items.find((item) => item.id === 'quit')?.label,
    );
    check(
      "the tray's items do not all carry the app's name",
      new Set(items.filter((item) => item.id).map((item) => item.label)).size === 4,
      `labels: ${items.filter((item) => item.id).map((item) => item.label).join(' | ')}`,
    );

    // The sign-in item is a checkbox, and it starts unchecked.
    const signInItem = items.find((item) => item.id === 'start-at-login');
    check('the sign-in item is a checkbox', signInItem?.type === 'checkbox');
    check('the sign-in item starts unchecked', signInItem?.checked === false);

    // Clicking the items does what they say.
    tray.action('show');
    check('the tray opens the window', shown === 1);

    tray.action('settings');
    check('the tray opens the settings', settingsOpened === 1);

    tray.action('quit');
    check('the tray quits the app', quitRequested === 1);

    // The tray follows the app's language.
    tray.setLabels({
      tooltip: 'MiniBots',
      open: '打开 MiniBots',
      settings: '设置…',
      startAtLogin: '开机自动启动',
      quit: '退出 MiniBots',
    });
    check(
      "the tray's labels follow the language",
      tray.item('quit')?.label === '退出 MiniBots',
      tray.item('quit')?.label,
    );
    check(
      "the tray's settings item follows the language",
      tray.item('settings')?.label === '设置…',
      tray.item('settings')?.label,
    );

    // The checkbox reports the new state to the app.
    const item = tray.item('start-at-login');
    check('the tray exposes its sign-in item', Boolean(item));
    check('the sign-in item is still unchecked', item?.checked === false);

    tray.setStartAtLogin(true);
    check(
      'the sign-in item can be set',
      tray.item('start-at-login')?.checked === true,
      'the tick reflects the preference',
    );

    // The checkbox's action reports the new state to the app.
    tray.action('start-at-login', true);
    check('the sign-in preference is reported', signIn === true);

    tray.destroy();
    check('the tray can be destroyed', true);

    // -------------------------------------------------------------------
    // The single instance lock.
    //
    // The application's own main process holds the lock when it is running,
    // so a second copy of the app cannot start a second scheduler. This test
    // process does not hold it — the assertion is that asking for it here
    // succeeds, which is exactly what a second copy would do if the first
    // one were not running.
    // -------------------------------------------------------------------
    check(
      'the single instance lock can be claimed by a process that does not hold it',
      app.requestSingleInstanceLock() === true,
      'this process is not the app, so it may take the lock',
    );
  } catch (error) {
    failed.push('the desktop tests');
    say(`FAIL  the desktop tests — ${error?.stack ?? error}`);
  } finally {
    say(`\n=== ${passed.length}/${passed.length + failed.length} checks passed ===`);
    app.exit(failed.length === 0 ? 0 : 1);
  }
});
