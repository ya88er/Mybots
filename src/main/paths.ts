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
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resourcesPath, resourcesRoot } from './resources.ts';

export { resourcesPath, resourcesRoot };

/**
 * The app's root directory.
 *
 * In development the root is the repository, found from the module's own
 * location: `src/main/paths.ts` → the repository's root.
 *
 * In a packaged build the root is the **archive**:
 *
 *   resources/app.asar            the archive — the app's own code
 *   resources/app.asar.unpacked   the few files that must be real files
 *
 * Only a handful of files are unpacked — Pi's native prebuilds and the
 * backend's one-file shim — so the archive is where the app's own code
 * lives, and it is the root. The unpacked tree is checked first, because a
 * build that keeps everything unpacked would put the app's code there.
 *
 * Electron's own file API reads the archive, so a path inside it works
 * exactly as a path on the disk does.
 */
export function appRoot(): string {
  const fromEnv = process.env.MINIBOTS_APP_ROOT;
  if (fromEnv) return fromEnv;

  const resources = resourcesPath();
  if (resources) {
    // A build that keeps the app's own code unpacked.
    const unpacked = join(resources, 'app.asar.unpacked');
    if (existsSync(join(unpacked, 'dist', 'main'))) return unpacked;
    // The ordinary build: the app's own code is inside the archive.
    const archive = join(resources, 'app.asar');
    if (existsSync(join(archive, 'dist', 'main'))) return archive;
  }

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
