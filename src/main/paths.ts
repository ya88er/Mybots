// @ts-check
/**
 * Where the app's own files live.
 *
 * `app.getAppPath()` is the directory of the script Electron was launched
 * with. That is the app's root in a packaged build, but the *script's*
 * directory when Electron is launched with a path — so the app resolves its
 * own root instead, and the paths are the same however it was started.
 *
 * This module is separate from `main.ts` so that the parts of the main
 * process can be tested without starting Electron's app lifecycle.
 */
import { app } from 'electron';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The app's root directory. */
export function appRoot(): string {
  const fromEnv = process.env.MINIBOTS_APP_ROOT;
  if (fromEnv) return fromEnv;
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * The app's data directory.
 *
 * `userData` is Electron's own per-user directory, so a per-user installer
 * finds the same place every time it runs.
 */
export function userDataDir(): string {
  return app.getPath('userData');
}

/** Where the app keeps its state: the Mini App's own data directory. */
export function dataDir(): string {
  return resolve(userDataDir(), 'data');
}

/** Where the backend keeps the Pi session files. */
export function sessionDir(): string {
  return resolve(userDataDir(), 'sessions');
}

/** Where the backend keeps Pi's agent directory. */
export function agentDir(): string {
  return resolve(userDataDir(), 'agent');
}

/** Where the encrypted credentials live. */
export function credentialPath(): string {
  return resolve(userDataDir(), 'credentials.enc.json');
}

/** Where the app keeps its own settings. */
export function settingsPath(): string {
  return resolve(userDataDir(), 'settings.json');
}
