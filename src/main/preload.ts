/**
 * The preload bridge.
 *
 * The renderer runs sandboxed, with no Node API. This preload is the only way
 * in, and it exposes a narrow surface:
 *
 * - the provider key path — save, list, remove and test;
 * - what the app knows about itself;
 * - the app's own window.
 *
 * The chat page is served from the app's own loopback origin. Its requests —
 * the page's assets, its API calls, its event stream — are authenticated by the
 * **main process**, at the network layer: Chromium cannot attach an
 * `Authorization` header to a subresource load or to an event stream, so the
 * main process adds the header to every request that goes to the backend's
 * own port.
 *
 * That is why this preload does **not** patch the page's `fetch` or its
 * `EventSource`. With context isolation on, the preload runs in its own
 * world and its `window` is not the page's `window`: a patch there would
 * change nothing the page can see, and the token would still never reach the
 * page. The bridge below is for the operations that are not HTTP at all.
 *
 * Electron 45's sandboxed preload scripts have no Node module shims: `events`,
 * `timers` and `url` are gone, and so are `Buffer`, `setImmediate` and
 * `clearImmediate`. The preload therefore uses Web APIs only — `URL`,
 * `TextEncoder`, `queueMicrotask` — and no `require()` beyond `electron`.
 */
import { contextBridge, ipcRenderer } from 'electron';

/** The request the bridge forwards to the main process. */
export interface BridgeRequest {
  readonly path: string;
  readonly method?: string;
  readonly body?: unknown;
}

/** What the main process answers a request with. */
export interface BridgeResponse {
  readonly status: number;
  readonly body: unknown;
  readonly contentType?: string;
}

/**
 * The bridge the renderer sees.
 *
 * The token is added by the main process, so the renderer never sees it: a
 * page in this window cannot read another page's credentials, and a request
 * that leaves the app carries no credential of its own.
 */
const bridge = {
  /** Call the backend. The bearer token is added by the main process. */
  request: (options: BridgeRequest): Promise<BridgeResponse> =>
    ipcRenderer.invoke('minibots:request', options),

  /** Store a provider key. The key never comes back. */
  saveCredential: (providerId: string, apiKey: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('minibots:credential:save', { providerId, apiKey }),

  /** The providers that have a key, by id. Never the keys themselves. */
  listCredentials: (): Promise<{ providers: string[] }> =>
    ipcRenderer.invoke('minibots:credential:list'),

  /** Forget a provider's key. */
  removeCredential: (providerId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('minibots:credential:remove', { providerId }),

  /** The providers the app offers. */
  listProviders: (): Promise<{
    providers: { id: string; name: string; description: string; keyUrl: string }[];
  }> => ipcRenderer.invoke('minibots:provider:list'),

  /**
   * Test a provider's connection.
   *
   * It is an explicit action, never a side effect of rendering the settings
   * page: a real request costs the user money.
   */
  testProvider: (
    providerId: string,
  ): Promise<{ ok: boolean; stage?: string; message?: string }> =>
    ipcRenderer.invoke('minibots:provider:test', { providerId }),

  /** What the app knows about itself. */
  appInfo: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('minibots:app:info'),

  /** The app's own language. */
  setLocale: (locale: string): Promise<{ locale: string }> =>
    ipcRenderer.invoke('minibots:app:locale', { locale }),

  /** Open the app's own window. */
  openAppWindow: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('minibots:app:open'),

  /** Subscribe to the backend's event stream. */
  onEvent: (listener: (payload: string) => void): (() => void) => {
    const wrapped = (_event: unknown, payload: string): void => listener(payload);
    ipcRenderer.on('minibots:events', wrapped);
    return () => ipcRenderer.removeListener('minibots:events', wrapped);
  },

  /** Open the backend's event stream. */
  openEvents: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('minibots:events:open'),
};

contextBridge.exposeInMainWorld('minibots', bridge);
