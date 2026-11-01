// @ts-check
/**
 * The backend entry point.
 *
 * This file runs inside the Electron **utility process**. It starts the
 * upstream Mini App with a real context, puts the authenticated gate in front
 * of it, and reports the address back to the main process over IPC.
 *
 * The upstream Mini App's own HTTP server stays bound to the loopback
 * interface and is reachable only from this process and the gate. The gate
 * adds the bearer token check, so no other process on the machine can drive
 * the engine.
 */
import { startBackend } from './backend-host.ts';
import { startGate } from './backend-gate.ts';
import { inspectSessions } from '../runtime/session-inspector.ts';

/** The message the main process listens for. */
interface ParentProcess {
  postMessage(message: unknown): void;
}

const parent = process.parentPort
  ? ({ postMessage: (message: unknown) => process.parentPort?.postMessage(message) } as ParentProcess)
  : undefined;

const dataDir = process.env.MINIBOTS_DATA_DIR;
const sessionDir = process.env.MINIBOTS_SESSION_DIR;
const agentDir = process.env.MINIBOTS_AGENT_DIR;
const token = process.env.MINIBOTS_TOKEN;

if (!dataDir || !sessionDir || !agentDir || !token) {
  const message = 'The backend was started without its directories or its token.';
  // eslint-disable-next-line no-console
  console.error(`[minibots] ${message}`);
  parent?.postMessage({ type: 'backend-error', error: message });
  process.exit(1);
}

/** How the backend logs. */
function log(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  fields?: Record<string, unknown>,
): void {
  const line = `[minibots] ${message}`;
  if (level === 'error') {
    // eslint-disable-next-line no-console
    console.error(line, fields ?? '');
    return;
  }
  // eslint-disable-next-line no-console
  console.log(line, fields ?? '');
}

/**
 * The credentials the main process has sent.
 *
 * They arrive over the utility process's private IPC channel and stay in
 * memory. The backend never writes them to disk.
 */
const credentials = new Map<string, string>();

if (process.parentPort) {
  process.parentPort.on('message', (message: unknown) => {
    const payload = message as { type?: string; providerId?: string; apiKey?: string };
    if (payload?.type === 'credential:set' && payload.providerId && payload.apiKey) {
      credentials.set(payload.providerId, payload.apiKey);
      return;
    }
    if (payload?.type === 'credential:remove' && payload.providerId) {
      credentials.delete(payload.providerId);
    }
  });
}

try {
  const backend = await startBackend({
    dataDir,
    sessionDir,
    agentDir,
    token,
    log,
    // The credential comes from the main process over private IPC. The
    // backend keeps it in memory only: it reaches Pi through its in-memory
    // runtime credential API, and no plaintext auth file is written.
    credential: (providerId) => credentials.get(providerId),
  });

  // The gate is the only address the renderer is given. It listens on its own
  // ephemeral port, so the upstream server's port is never published.
  const gate = await startGate({
    upstream: { host: backend.ready.host, port: backend.ready.port },
    token,
    log,
    // The app's own routes. The upstream server's routing is a closure, so
    // it cannot be extended without changing a vendored file.
    routes: async (path, method) => {
      if (method === 'GET' && path === '/api/app/sessions') {
        return { status: 200, body: inspectSessions(backend.sessions) };
      }
      return undefined;
    },
  });

  log('info', 'minibots.backend_ready', { port: gate.port });

  parent?.postMessage({
    type: 'backend-ready',
    ready: { port: gate.port, host: '127.0.0.1', token },
  });

  const shutdown = async (): Promise<void> => {
    await gate.stop();
    await backend.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error('[minibots] the backend failed to start:', message);
  parent?.postMessage({ type: 'backend-error', error: message });
  process.exit(1);
}
