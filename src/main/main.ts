// @ts-check
/**
 * The Electron main process.
 *
 * It owns the things that must live in one place: the window, the tray, the
 * single-instance lock, the encrypted credentials and the backend process.
 *
 * It owns **no** model loop and no conversation policy: the backend utility
 * process owns the MiniBots engine, and the Pi adapter owns the model
 * conversation.
 *
 * The renderer never talks to the backend directly. It asks the main process,
 * which holds the bearer token and adds it to every request. That is what
 * makes the loopback safe on a machine where any process can reach
 * `127.0.0.1`.
 */
import { app, BrowserWindow, ipcMain, safeStorage, shell, utilityProcess } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CredentialService } from './credential-service.ts';

/**
 * Where the app's own files live.
 *
 * `app.getAppPath()` is the directory of the script Electron was launched
 * with, which is the app's root in a packaged build but the *script's*
 * directory when Electron is launched with a path. The app resolves its own
 * root instead, so the paths are the same however it was started.
 */
function appRoot(): string {
  const fromEnv = process.env.MINIBOTS_APP_ROOT;
  if (fromEnv) return fromEnv;
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Where the app keeps its state. */
function dataDir(): string {
  return join(app.getPath('userData'), 'data');
}

/** Where the backend keeps the Pi session files. */
function sessionDir(): string {
  return join(app.getPath('userData'), 'sessions');
}

/** Where the backend keeps Pi's agent directory. */
function agentDir(): string {
  return join(app.getPath('userData'), 'agent');
}

/** Where the encrypted credentials live. */
function credentialPath(): string {
  return join(app.getPath('userData'), 'credentials.enc.json');
}

/** The state the backend reports when it is listening. */
interface BackendReady {
  readonly port: number;
  readonly host: string;
  readonly token: string;
}

let mainWindow: BrowserWindow | undefined;
let backend: Electron.UtilityProcess | undefined;
let credentials: CredentialService | undefined;
/** The address the renderer talks to. */
let backendAddress: { host: string; port: number; token: string } | undefined;

/**
 * Start the backend utility process.
 *
 * The backend runs in its own process so that a crash in a tool — or in the
 * model provider — takes down the tool, not the window.
 */
function startBackend(token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    backend = utilityProcess.fork(join(appRoot(), 'dist', 'backend', 'backend-entry.js'), [], {
      serviceName: 'minibots-backend',
      stdio: 'inherit',
      env: {
        ...process.env,
        MINIBOTS_DATA_DIR: dataDir(),
        MINIBOTS_SESSION_DIR: sessionDir(),
        MINIBOTS_AGENT_DIR: agentDir(),
        MINIBOTS_TOKEN: token,
        MINIBOTS_PLUGIN_ROOT: join(appRoot(), 'vendor', 'minimax-bot'),
      },
    });

    backend.on('message', (message: unknown) => {
      const payload = message as { type?: string; ready?: BackendReady; error?: string };
      if (payload?.type === 'backend-ready' && payload.ready) {
        backendAddress = payload.ready;
        resolve();
        return;
      }
      if (payload?.type === 'backend-error') {
        reject(new Error(payload.error ?? 'The backend failed to start.'));
      }
    });

    backend.on('exit', (code) => {
      backend = undefined;
      backendAddress = undefined;
      if (code !== 0) {
        // eslint-disable-next-line no-console
        console.error(`[minibots] the backend exited with code ${code}`);
      }
    });
  });
}

/** Create the main window. */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#101014',
    title: 'MiniBots',
    webPreferences: {
      preload: join(appRoot(), 'dist', 'main', 'preload.cjs'),
      // The renderer is untrusted with the Node API: it may not touch the file
      // system, the process or a raw shell.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Nothing in this app should ever open a second window or navigate away.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  void mainWindow.loadFile(clientEntry());
}

/**
 * The client's entry page.
 *
 * In development it is the vendored Mini App's own file. In a packaged build
 * the build copies it next to the app.
 */
function clientEntry(): string {
  const candidates = [
    join(appRoot(), 'dist', 'client', 'index.html'),
    join(appRoot(), 'vendor', 'minimax-bot', 'miniapp', 'client', 'index.html'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

/** The IPC surface the preload exposes to the renderer. */
function registerIpc(): void {
  // The renderer asks the main process to fetch from the backend. The main
  // process adds the bearer token; the renderer never learns it.
  ipcMain.handle(
    'minibots:request',
    async (_event, request: { path: string; method?: string; body?: unknown }) => {
      if (!backendAddress) {
        return {
          status: 503,
          body: { error: 'unavailable', message: 'The backend is not running.' },
        };
      }
      const method = request.method ?? 'GET';
      const response = await fetch(
        `http://${backendAddress.host}:${backendAddress.port}${request.path}`,
        {
          method,
          headers: {
            authorization: `Bearer ${backendAddress.token}`,
            ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
        },
      );
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON: the caller gets the raw text.
      }
      return { status: response.status, body };
    },
  );

  // A credential is saved in the main process and never sent back.
  ipcMain.handle(
    'minibots:credential:save',
    async (_event, request: { providerId: string; apiKey: string }) => {
      await credentials?.save(request.providerId, request.apiKey);
      // The backend needs the key to reach the provider, so it is sent over
      // the utility process's private channel. It stays in memory there.
      backend?.postMessage({
        type: 'credential:set',
        providerId: request.providerId,
        apiKey: request.apiKey,
      });
      return { ok: true };
    },
  );

  // The renderer learns *that* a provider is configured, never the key.
  ipcMain.handle('minibots:credential:list', () => ({
    providers: credentials?.providers() ?? [],
  }));

  ipcMain.handle(
    'minibots:credential:remove',
    async (_event, request: { providerId: string }) => {
      await credentials?.remove(request.providerId);
      backend?.postMessage({ type: 'credential:remove', providerId: request.providerId });
      return { ok: true };
    },
  );

  // Test a provider's connection.
  //
  // The check is a small explicit API request, and it reports authentication
  // separately from model access. It never runs on a settings render, because
  // a real request costs the user money.
  ipcMain.handle(
    'minibots:provider:test',
    async (_event, request: { providerId: string }) => {
      const key = credentials?.resolve(request.providerId);
      if (!key) {
        return {
          ok: false,
          stage: 'authentication',
          message: 'No key is configured for this provider.',
        };
      }
      if (!backendAddress) {
        return {
          ok: false,
          stage: 'service',
          message: 'The backend is not running.',
        };
      }
      try {
        const response = await fetch(
          `http://${backendAddress.host}:${backendAddress.port}/api/models`,
          { headers: { authorization: `Bearer ${backendAddress.token}` } },
        );
        const body = (await response.json().catch(() => ({}))) as {
          supported?: boolean;
          models?: Array<{ providerId?: string }>;
        };
        const offered = (body.models ?? []).some(
          (model) => model.providerId === request.providerId,
        );
        return {
          ok: response.ok,
          stage: response.ok ? 'ok' : 'service',
          message: response.ok
            ? offered
              ? 'The provider is reachable and its models are offered.'
              : 'The provider is authenticated, but it offers no models.'
            : `The backend answered with ${response.status}.`,
        };
      } catch (error) {
        return {
          ok: false,
          stage: 'service',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  // The event stream: the renderer subscribes, main proxies to the backend.
  ipcMain.handle('minibots:events:open', (event) => {
    if (!backendAddress) return { ok: false };
    const { port, host, token } = backendAddress;
    void fetch(`http://${host}:${port}/api/events`, {
      headers: { authorization: `Bearer ${token}` },
    })
      .then(async (response) => {
        if (!response.body) return;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          let boundary = buffered.indexOf('\n\n');
          while (boundary !== -1) {
            const frame = buffered.slice(0, boundary);
            buffered = buffered.slice(boundary + 2);
            const line = frame.trim();
            if (line.startsWith('data:')) {
              event.sender.send('minibots:events', line.slice(5).trim());
            }
            boundary = buffered.indexOf('\n\n');
          }
        }
      })
      .catch(() => {
        event.sender.send('minibots:events', JSON.stringify({ type: 'stream.closed' }));
      });
    return { ok: true };
  });
}

/** Boot the app. */
async function bootstrap(): Promise<void> {
  credentials = new CredentialService({ path: credentialPath(), safeStorage });
  await credentials.load().catch(() => ({ loaded: [], failed: [] }));

  const token = randomBytes(32).toString('base64url');
  registerIpc();
  createWindow();

  await startBackend(token);
  // The renderer may ask before the backend is up; the bridge answers with a
  // 503 until it is, and the app becomes usable as soon as it is.
  ready = true;
}

/** Whether the backend is up and the app can serve requests. */
let ready = false;

/** Whether the app is ready to serve requests. */
export function isReady(): boolean {
  return ready;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(bootstrap).catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[minibots] startup failed:', error);
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    backend?.kill();
  });
}
