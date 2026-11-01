// @ts-check
/**
 * The app's **resources** paths.
 *
 * These are the paths that point into the packaged application: the archive
 * and the unpacked tree beside it.
 *
 * They live in their own module, apart from `paths.ts`, because they are the
 * only paths the **backend utility process** needs — and the backend is not a
 * browser process, so it cannot import `electron`. Reading
 * `process.resourcesPath` is a plain process property, so this module has no
 * Electron dependency at all and can be loaded from either process.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Electron's `process.resourcesPath`, when the process runs inside Electron.
 *
 * The backend runs in an Electron utility process, so the path is there; in a
 * plain Node process it is not, and the development layout is used instead.
 */
export function resourcesPath(): string | undefined {
  const value = (process as unknown as { resourcesPath?: unknown }).resourcesPath;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The app's **resources** root: the files that are shipped beside the
 * archive rather than inside it.
 *
 * In a packaged build this is the unpacked tree, which holds the app's own
 * code and Pi's native prebuilds. The vendored Mini App and the Pi runtime
 * stay inside the archive, and Electron's own file API reads them from there.
 */
export function resourcesRoot(): string | undefined {
  const resources = resourcesPath();
  if (!resources) return undefined;
  const unpacked = join(resources, 'app.asar.unpacked');
  if (existsSync(unpacked)) return unpacked;
  return undefined;
}
