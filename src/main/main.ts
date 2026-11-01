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
import { app, BrowserWindow, ipcMain, safeStorage, session, shell, utilityProcess } from 'electron';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CredentialService } from './credential-service.ts';
import { SettingsStore } from './app-settings.ts';
import { PROVIDERS } from './providers.ts';
import { agentDir, appRoot, credentialPath, dataDir, sessionDir, settingsPath } from './paths.ts';
import {
  allowClose,
  createTray,
  installWindowLifecycle,
  type TrayController,
  type WindowController,
} from './window-lifecycle.ts';

/**
 * Where the app's own files live.
 *
 * `app.getAppPath()` is the directory of the script Electron was launched
 * with, which is the app's root in a packaged build but the *script's*
 * directory when Electron is launched with a path. The app resolves its own
 * root instead, so the paths are the same however it was started.
 */
export { appRoot };

/** The state the backend reports when it is listening. */
interface BackendReady {
  readonly port: number;
  readonly host: string;
  readonly token: string;
}

let mainWindow: BrowserWindow | undefined;
let appWindow: BrowserWindow | undefined;
let backend: Electron.UtilityProcess | undefined;
let credentials: CredentialService | undefined;
let settings: SettingsStore | undefined;
let tray: TrayController | undefined;
let windowController: WindowController | undefined;
/** The address the renderer talks to. */
let backendAddress: { host: string; port: number; token: string } | undefined;
/** Whether the app is ready to serve requests. */
let ready = false;

/** Whether the app is ready to serve requests. */
export function isReady(): boolean {
  return ready;
}

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
      ready = false;
      if (code !== 0) {
        // eslint-disable-next-line no-console
        console.error(`[minibots] the backend exited with code ${code}`);
      }
    });
  });
}

/**
 * The chat window's page.
 *
 * The window is served from the app's own loopback origin rather than from
 * the file system. That matters:
 *
 * - the upstream client's page refers to its own assets by absolute path
 *   (`/bot/app.css`), which a `file://` page cannot resolve at all — the
 *   page loads unstyled and its module script never runs;
 * - the page needs a real origin, because the event stream is a real
 *   `EventSource` and the API calls are relative `fetch` calls.
 *
 * The origin is authenticated by the bearer token, which the main process
 * adds at the network layer — see `installRequestAuthentication`.
 */
function clientUrl(): string {
  if (!backendAddress) return 'about:blank';
  return `http://${backendAddress.host}:${backendAddress.port}/bot`;
}

/** The app's own window's page. */
function appUrl(): string {
  if (!backendAddress) return 'about:blank';
  return `http://${backendAddress.host}:${backendAddress.port}/app`;
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

  windowController = installWindowLifecycle(mainWindow, {
    onQuitRequested: () => void quit(),
  });

  void mainWindow.loadURL(clientUrl());
}

/**
 * Create the app's own window.
 *
 * It holds the provider settings and the two inspectors. It is a separate
 * window so that the chat stays exactly the upstream Mini App — the frontend
 * was not rewritten.
 */
function createAppWindow(): void {
  if (appWindow && !appWindow.isDestroyed()) {
    if (appWindow.isMinimized()) appWindow.restore();
    appWindow.show();
    appWindow.focus();
    return;
  }

  appWindow = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: '#101014',
    title: 'MiniBots',
    webPreferences: {
      preload: join(appRoot(), 'dist', 'main', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  appWindow.once('ready-to-show', () => appWindow?.show());
  appWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // The app's window closes for real: it holds nothing that must keep running.
  appWindow.on('close', () => {
    appWindow = undefined;
  });

  void appWindow.loadURL(appUrl());
}

/**
 * Add the bearer token to the window's own requests.
 *
 * The window is served from the app's loopback origin, and every request it
 * makes — the page's assets, its API calls, its event stream — goes through
 * Chromium's network stack. A browser cannot set an `Authorization` header
 * on a subresource load or on an event stream, so the token is added here,
 * at the network layer, where the main process can reach it.
 *
 * This is why the token is safe to keep in the main process: the page never
 * sees it. The preload does not patch the page's `fetch` — with context
 * isolation on, it could not — and does not have to.
 *
 * Only requests to the app's own origin are touched. A request to another
 * host is left exactly as the page made it.
 */
function installRequestAuthentication(): void {
  const target = session.defaultSession.webRequest;

  target.onBeforeSendHeaders({ urls: ['http://127.0.0.1/*'] }, (details, callback) => {
    const address = backendAddress;
    if (!address) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    // Only the app's own backend is authenticated. The port is the one the
    // backend reported, so a different loopback service is never touched.
    let origin: string;
    try {
      origin = new URL(details.url).port;
    } catch {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    if (origin !== String(address.port)) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    const requestHeaders = { ...details.requestHeaders };
    requestHeaders.Authorization = `Bearer ${address.token}`;
    callback({ requestHeaders });
  });
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
      const contentType = response.headers.get('content-type') ?? undefined;
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON: the caller gets the raw text.
      }
      return {
        status: response.status,
        body,
        ...(contentType ? { contentType } : {}),
      };
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

  // The providers the app offers. The list comes from the main process, which
  // owns Pi's provider ids, so the two can never drift apart.
  ipcMain.handle('minibots:provider:list', () => ({
    providers: PROVIDERS.map((provider) => ({
      id: provider.id,
      name: provider.name,
      description: provider.description,
      keyUrl: provider.keyUrl,
    })),
  }));

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

  // What the app knows about itself: the versions, the data folder and the
  // backend's state. Nothing here is a secret.
  ipcMain.handle('minibots:app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    node: process.versions.node ?? 'unknown',
    pi: '1.4.0',
    dataDir: dataDir(),
    backend: Boolean(backendAddress),
    locale: resolveLocale(),
  }));

  // The app's own language.
  ipcMain.handle('minibots:app:locale', async (_event, request: { locale: string }) => {
    const locale = request.locale === 'en' || request.locale === 'zh' ? request.locale : 'auto';
    await settings?.update({ locale });
    return { locale: resolveLocale() };
  });

  // Open the app's own window.
  ipcMain.handle('minibots:app:open', () => {
    createAppWindow();
    return { ok: true };
  });

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

/**
 * The app's effective language.
 *
 * `auto` follows the operating system's language, which is what the user
 * sees everywhere else on this machine.
 */
function resolveLocale(): 'en' | 'zh' {
  const preference = settings?.current.locale ?? 'auto';
  if (preference === 'en' || preference === 'zh') return preference;
  return app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/**
 * Stop everything and quit.
 *
 * The shutdown is **bounded**: the backend is asked to stop, and the app
 * quits anyway after the timeout. A tool that hangs must never leave a
 * zombie process behind.
 */
async function quit(): Promise<void> {
  allowClose();
  tray?.destroy();
  tray = undefined;
  const child = backend;
  backend = undefined;
  child?.kill();
  // Electron's own quit handles the rest; the timeout is a backstop.
  setTimeout(() => app.quit(), 5_000);
  app.quit();
}

/** Create the tray icon. */
function installTray(): void {
  tray = createTray({
    onShow: () => {
      if (mainWindow && !mainWindow.isDestroyed()) windowController?.show();
      else createWindow();
    },
    onToggleStartAtLogin: (enabled) => {
      void applyStartAtLogin(enabled);
    },
    isStartAtLoginEnabled: () => settings?.current.startAtLogin === true,
    onQuit: () => void quit(),
    tooltip: 'MiniBots',
  });
}

/**
 * Apply the "start at sign-in" preference.
 *
 * The preference is remembered even when the platform cannot apply it: in a
 * development run Electron's login-item settings would register `electron.exe`
 * instead of the app, which would start the wrong thing at sign-in.
 *
 * On Windows the app is launched with its own arguments, so the path has to
 * name the executable rather than the launcher.
 */
async function applyStartAtLogin(enabled: boolean): Promise<void> {
  await settings?.update({ startAtLogin: enabled });
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: [] });
}

/** Boot the app. */
async function bootstrap(): Promise<void> {
  credentials = new CredentialService({ path: credentialPath(), safeStorage });
  await credentials.load().catch(() => ({ loaded: [], failed: [] }));

  settings = new SettingsStore(settingsPath());
  await settings.load().catch(() => undefined);

  const token = randomBytes(32).toString('base64url');
  registerIpc();
  installRequestAuthentication();
  installTray();

  // The backend comes up first.
  //
  // The window is served from the backend's origin, so there is no page to
  // show until the backend is listening. Starting the backend first means
  // the window loads the real URL the first time, instead of showing a blank
  // page and then being navigated somewhere else.
  await startBackend(token);
  ready = true;

  createWindow();

  // The start-at-sign-in preference is the app's own, and it is applied once
  // the app knows whether it is installed.
  if (settings.current.startAtLogin && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: [] });
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  void app.whenReady().then(bootstrap).catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[minibots] startup failed:', error);
    app.quit();
  });

  // The window hides rather than closing, so a running turn and a scheduled
  // delivery both survive. The app quits through the tray's "Quit" item.
  app.on('window-all-closed', () => {
    // The window is hidden, not closed, so this only fires when the app's own
    // window is gone too. The app keeps running in the tray.
  });

  app.on('before-quit', () => {
    allowClose();
    backend?.kill();
  });
}
