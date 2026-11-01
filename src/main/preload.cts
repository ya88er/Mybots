// @ts-check
/**
 * The preload bridge.
 *
 * The renderer runs sandboxed, with no Node API and no direct access to the
 * backend. This preload is the only way in, and it exposes a narrow surface:
 *
 * - `request` — a fetch to the backend, with the bearer token added by the
 *   main process. The renderer never sees the token.
 * - `saveCredential` / `listCredentials` / `removeCredential` — the
 *   provider key path. The key goes in and never comes back out.
 * - `onEvent` — the server-sent event stream.
 *
 * Electron 45's sandboxed preload scripts have no Node module shims: `events`,
 * `timers` and `url` are gone, and so are `Buffer`, `setImmediate` and
 * `clearImmediate`. The preload therefore uses Web APIs only — `URL`,
 * `TextEncoder`, `queueMicrotask` — and no `require()` beyond `electron`.
 */
const { contextBridge, ipcRenderer } = require('electron');

/** The bridge the renderer sees. */
const bridge = {
  /**
   * Call the backend.
   *
   * The path must be a path on the backend's own API; it is joined onto the
   * backend's origin by the main process, so it cannot address another host.
   */
  request: (options) => ipcRenderer.invoke('minibots:request', options),

  /** Store a provider key. The key never comes back. */
  saveCredential: (providerId, apiKey) =>
    ipcRenderer.invoke('minibots:credential:save', { providerId, apiKey }),

  /** The providers that have a key, by id. Never the keys themselves. */
  listCredentials: () => ipcRenderer.invoke('minibots:credential:list'),

  /** Forget a provider's key. */
  removeCredential: (providerId) =>
    ipcRenderer.invoke('minibots:credential:remove', { providerId }),

  /**
   * Test a provider's connection.
   *
   * It is an explicit action, never a side effect of rendering the settings
   * page: a real request costs the user money.
   */
  testProvider: (providerId) => ipcRenderer.invoke('minibots:provider:test', { providerId }),

  /** Subscribe to the backend's event stream. */
  onEvent: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('minibots:events', wrapped);
    return () => ipcRenderer.removeListener('minibots:events', wrapped);
  },

  /** Open the backend's event stream. */
  openEvents: () => ipcRenderer.invoke('minibots:events:open'),
};

contextBridge.exposeInMainWorld('minibots', bridge);
