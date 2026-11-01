// @ts-check
/**
 * The app's own pages.
 *
 * The upstream Mini App serves its own client at `/bot`. The desktop app has
 * its own window — the provider settings, the session inspector and the
 * dispatch inspector — served at `/app`.
 *
 * The window is served over HTTP rather than from the file system, and that
 * matters for two reasons:
 *
 * - the upstream client's own page refers to its assets by absolute path
 *   (`/bot/app.css`), which a `file://` page cannot resolve at all;
 * - the page needs a real origin, because the event stream is a real
 *   `EventSource` and the API calls are relative `fetch` calls.
 *
 * The files are read from disk on each request rather than cached, so a
 * development edit shows up on a reload.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The content types the app's own files use. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

/** Where the app's own pages live. */
export function appUiDir(): string {
  const fromEnv = process.env.MINIBOTS_APP_UI_DIR;
  if (fromEnv) return fromEnv;
  // In development the sources sit next to the main process's own module; in a
  // packaged build they are copied into `dist/app`.
  const beside = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'app');
  if (existsSync(join(beside, 'index.html'))) return beside;
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'app-ui');
}

/** A file the app serves, and its content type. */
export interface AppFile {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

/**
 * Read one of the app's own files.
 *
 * Only flat file names with a known extension are served: the app's pages
 * have no directories, and a path that walks out of the folder is refused.
 */
export async function readAppFile(path: string): Promise<AppFile | undefined> {
  const name = path.replace(/^\/app\/?/, '').replace(/^\/+/, '');
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return undefined;
  }
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
  const contentType = CONTENT_TYPES[extension];
  if (!contentType) return undefined;

  const file = join(appUiDir(), name);
  try {
    const body = await readFile(file);
    return { status: 200, contentType, body };
  } catch {
    return undefined;
  }
}

/** Whether a path belongs to the app's own pages. */
export function isAppPath(path: string): boolean {
  return path === '/app' || path === '/app/' || path.startsWith('/app/');
}
