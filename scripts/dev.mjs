// @ts-check
/**
 * The development launcher.
 *
 * It builds the app and then starts Electron on the real main process. The
 * app's own root is passed through `MINIBOTS_APP_ROOT` so that the paths are
 * the same as in a packaged build — `app.getAppPath()` is the *script's*
 * directory when Electron is launched with a path, which is not what the app
 * wants.
 *
 * Run:  npm run dev
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Build the app, so the launcher never runs a stale build. */
const build = spawnSync(process.execPath, [resolve(root, 'scripts', 'build.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

/** Electron's binary, from the installed package. */
const electron = resolve(root, 'node_modules', 'electron', 'dist', 'electron.exe');

const app = spawnSync(electron, [resolve(root, 'dist', 'main', 'main.js')], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    MINIBOTS_APP_ROOT: root,
    // Electron's own developer tools are useful while working on the UI.
    MINIBOTS_DEV: '1',
  },
});

process.exit(app.status ?? 0);
