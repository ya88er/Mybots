// @ts-check
/**
 * The backend host.
 *
 * This runs inside the Electron **utility process** — the process that owns
 * the MiniBots engine, its stores, the Pi sessions and the tools. The
 * Electron main process supervises it; the renderer never talks to it
 * directly.
 *
 * The upstream Mini App is started unmodified. `server.mjs` exports
 * `start(context)` and does everything: the HTTP routes, the SSE stream, the
 * static client, the scheduler and the tasks. What the host adds is the
 * context the Mini App was written to be given by a Host:
 *
 * - a real `agent`, so the Bot can actually talk to a model;
 * - a `logger` that goes to the app's log;
 * - the ephemeral loopback address the server binds to;
 * - the abort signal that shuts the whole thing down.
 *
 * The upstream server has no authentication of its own, so the host puts an
 * authenticated gate in front of it: see `backend-gate.ts`.
 */
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { start as startMiniApp } from './upstream-miniapp.ts';import { DispatchingAgent, withCaller, type CallerIdentity } from '../runtime/dispatching-agent.ts';
import { DispatchLedger } from '../runtime/dispatch-ledger.ts';
import { PiAdapter, type BoundTool } from '../runtime/pi-adapter.ts';
import { SessionIndex } from '../runtime/session-index.ts';
import { SessionRegistry, type SessionAssociation } from '../runtime/session-registry.ts';
import { ScheduleCatchUp } from '../runtime/schedule-catchup.ts';
import { inspectSessions } from '../runtime/session-inspector.ts';
import { ToolDispatch, type UpstreamDispatch } from '../tools/tool-dispatch.ts';
import { isAppPath, readAppFile } from '../main/app-ui-server.ts';
import type { GateResponse } from './backend-gate.ts';

export interface BackendOptions {
  /** Where the app keeps its state (the Mini App's data dir). */
  readonly dataDir: string;
  /** Where Pi keeps its session files. */
  readonly sessionDir: string;
  /** Where Pi keeps its agent directory. */
  readonly agentDir: string;
  /** The bearer token every request must carry. */
  readonly token: string;
  /** Supplies a provider API key, if one is configured. */
  readonly credential?: (providerId: string) => string | undefined;
  /** The tools available to every run, before session binding. */
  readonly tools?: () => BoundTool[];
  /** How the host logs. */
  readonly log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

/** What the host reports back to the main process once it is listening. */
export interface BackendReady {
  readonly port: number;
  readonly host: string;
  readonly token: string;
}

/**
 * A logger for the upstream Mini App.
 *
 * The upstream logger takes `(message, fields)`. Field values are redacted
 * before they leave, because a field can carry anything the engine put in
 * it.
 */
function makeLogger(
  sink: (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void,
) {
  return {
    debug: (message: string, fields?: Record<string, unknown>) => sink('debug', message, fields),
    info: (message: string, fields?: Record<string, unknown>) => sink('info', message, fields),
    warn: (message: string, fields?: Record<string, unknown>) => sink('warn', message, fields),
    error: (message: string, fields?: Record<string, unknown>) => sink('error', message, fields),
  };
}

/**
 * Start the backend.
 *
 * @returns the address the server listens on, and the lifecycle that stops it.
 */
export async function startBackend(options: BackendOptions): Promise<{
  ready: BackendReady;
  stop: () => Promise<void>;
  /** The application session index, for the session inspector. */
  sessions: SessionRegistry;
  /** The dispatch ledger, for the inspector and the recovery report. */
  ledger: DispatchLedger;
  /** The app's own routes, served by the gate. */
  routes: (path: string, method: string) => Promise<GateResponse | undefined>;
}> {
  const log =
    options.log ??
    ((level, message, fields) => {
      // eslint-disable-next-line no-console
      console.error(`[${level}] ${message}`, fields ?? '');
    });

  await mkdir(options.dataDir, { recursive: true });
  await mkdir(options.sessionDir, { recursive: true });
  await mkdir(options.agentDir, { recursive: true });

  const sessions = new SessionRegistry();

  // The durable session index: the app's own record of which Pi session
  // belongs to which chat, because Pi writes a session file only once the
  // session has content.
  const sessionIndex = new SessionIndex({ path: join(options.dataDir, 'sessions.json') });
  const stored = await sessionIndex.load().catch(() => [] as SessionAssociation[]);
  sessions.load(stored);
  // The index is written at start-up too, so the file exists even when no
  // session has been created yet.
  await sessionIndex.save(sessions.all()).catch(() => {});
  if (stored.length) {
    log('info', 'minibots.sessions_restored', { count: stored.length });
  }

  // The dispatch ledger records every admission, so a restart can tell a
  // known outcome from an unknown one.
  const ledger = new DispatchLedger({
    path: join(options.dataDir, 'dispatch-ledger.json'),
    log,
  });
  await ledger.load();
  const reconciled = await ledger.reconcile();
  if (reconciled.length) {
    log('warn', 'minibots.dispatches_unknown', { count: reconciled.length });
  }

  // The abort signal shuts the whole backend down: the upstream server
  // listens for it and disposes itself.
  const controller = new AbortController();

  // The vendored Mini App lives next to the app's code. In a packaged build
  // the resources are unpacked, because Electron 45 restricts file
  // descriptors inside an ASAR archive.
  const pluginRoot = resolvePluginRoot();

  // The upstream Mini App resolves its own listen address from the context
  // and does not report the port back. So the host picks a free ephemeral port
  // first and hands it over: the server binds exactly that port, and the
  // renderer is told where to look.
  const port = await reserveEphemeralPort();
  if (!port) {
    controller.abort();
    throw new Error('No free loopback port was available for the backend.');
  }

  // The tool dispatch only exists once the Mini App has started, and the
  // Mini App needs the agent, and the agent needs the adapter's tools. The
  // way out is that the adapter resolves its tools **lazily**, at the moment
  // a session is created — by which time the dispatch exists.
  let upstreamDispatch: UpstreamDispatch | undefined;

  const tools = new ToolDispatch({
    // Resolved on demand; see above.
    dispatch: {
      definitions: () => upstreamDispatch?.definitions() ?? [],
      names: () => upstreamDispatch?.names() ?? [],
      call: (name, args, options) => {
        if (!upstreamDispatch) throw new Error('The MiniBots tools are not ready yet.');
        return upstreamDispatch.call(name, args, options);
      },
      failureText: (error, name) =>
        upstreamDispatch?.failureText(error, name) ?? 'The tool failed.',
    },
    // The caller is the session's own Bot. The model's field never decides.
    resolveCaller: (sessionId) => {
      const association = sessions.get(sessionId);
      if (!association) return undefined;
      return {
        id: association.botId,
        chatId: association.chatId,
        sessionId: association.id,
        runId: association.id,
      };
    },
    log,
  });

  const adapter = new PiAdapter({
    agentDir: options.agentDir,
    sessionDir: options.sessionDir,
    sessions,
    ...(options.credential ? { credential: options.credential } : {}),
    tools: () => tools.tools(),
    // The session index is written as soon as it changes, so a crash never
    // loses the association between a chat and its Pi session.
    onSessionsChanged: (records) => {
      void sessionIndex.save(records).catch((error: unknown) => {
        log('warn', 'minibots.sessions_save_failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },
    // The dispatch ledger records every admission and every outcome, so a
    // restart can tell a known outcome from an unknown one.
    onAdmit: (record) => {
      void ledger.admit(record).catch((error: unknown) => {
        log('warn', 'minibots.ledger_admit_failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },
    onSettle: (id, state, reason) => {
      void ledger.settle(id, state, reason).catch((error: unknown) => {
        log('warn', 'minibots.ledger_settle_failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },
  });

  const agent = new DispatchingAgent({ adapter });

  // The schedule catch-up record: a schedule that came due while the app was
  // closed is delivered exactly once, even across a restart.
  const catchUp = new ScheduleCatchUp({ path: join(options.dataDir, 'schedule-catchup.json') });
  await catchUp.load();

  const lifecycle = await startMiniApp({
    pluginId: 'minimax-bot',
    pluginRoot,
    dataDir: options.dataDir,
    listen: { host: '127.0.0.1', port },
    signal: controller.signal,
    logger: makeLogger(log),
    agent,
    // The engine asks this before it delivers an overdue schedule. It answers
    // "has this occurrence already been delivered?", and records the answer.
    scheduleCatchUp: async (scheduleId: string, nextRunAt: number) => {
      if (await catchUp.alreadyDelivered(scheduleId, nextRunAt)) return true;
      await catchUp.record(scheduleId, nextRunAt);
      return false;
    },
  });

  upstreamDispatch = lifecycle.dispatch as UpstreamDispatch | undefined;
  if (!upstreamDispatch) {
    controller.abort();
    throw new Error('The Mini App did not expose its tool dispatch.');
  }

  log('info', 'minibots.backend_listening', { port, tools: upstreamDispatch.names().length });

  /**
   * The app's own routes.
   *
   * The upstream server's routing is a closure, so it cannot be extended
   * without changing a vendored file. These routes are therefore served by
   * the gate, in front of the upstream server, where the app owns the code.
   */
  const routes = async (
    path: string,
    method: string,
  ): Promise<GateResponse | undefined> => {
    if (method === 'GET' && path === '/api/app/sessions') {
      return { status: 200, body: inspectSessions(sessions) };
    }
    if (method === 'GET' && path === '/api/app/dispatches') {
      // The dispatch ledger: what the app admitted, and what it knows about
      // each outcome. An `unknown` outcome is reported as unknown.
      return {
        status: 200,
        body: {
          records: ledger.all(),
          unsettled: ledger.unsettled().length,
        },
      };
    }
    // The app's own window: the provider settings and the two inspectors.
    if (method === 'GET' && isAppPath(path)) {
      const file = await readAppFile(path === '/app' || path === '/app/' ? '/app/index.html' : path);
      if (file) return { status: file.status, file: { contentType: file.contentType, body: file.body } };
      return { status: 404, body: { error: 'not_found', message: 'The page was not found.' } };
    }
    return undefined;
  };

  const stop = async (): Promise<void> => {
    controller.abort();
    // The session associations are written last: they are the only thing
    // that lets a chat find its Pi session again after a restart.
    await sessionIndex.save(sessions.all()).catch((error: unknown) => {
      log('warn', 'minibots.sessions_save_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    await Promise.resolve(lifecycle?.dispose?.());
    await adapter.dispose();
  };

  return { ready: { port, host: '127.0.0.1', token: options.token }, stop, sessions, ledger, routes };
}

/**
 * Where the vendored Mini App lives.
 *
 * In development that is the repository's `vendor/minimax-bot`. In a packaged
 * build the resources are unpacked next to the executable, because Electron 45
 * restricts file descriptors inside an ASAR archive.
 */
function resolvePluginRoot(): string {
  const candidates = [
    process.env.MINIBOTS_PLUGIN_ROOT,
    join(process.cwd(), 'vendor', 'minimax-bot'),
    // In a packaged build the resources are unpacked next to the executable.
    resourcesPath() && join(resourcesPath()!, 'app', 'vendor', 'minimax-bot'),
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor', 'minimax-bot'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'miniapp', 'node', 'server.mjs'))) {
      return candidate;
    }
  }
  throw new Error('The MiniBots Mini App was not found. Set MINIBOTS_PLUGIN_ROOT.');
}

/**
 * Electron's `process.resourcesPath`, when the process runs inside Electron.
 *
 * The backend runs in an Electron utility process, so the path is there; in a
 * plain Node process it is not, and the development layout is used instead.
 */
function resourcesPath(): string | undefined {
  const value = (process as unknown as { resourcesPath?: unknown }).resourcesPath;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Reserve a free TCP port on the loopback interface.
 *
 * The operating system picks the port when the socket binds to 0, and it is
 * released again straight away. The window between the release and the
 * upstream server's own bind is tiny and local to this machine: the backend
 * binds it immediately afterwards, and the port is never published anywhere
 * but the app's own IPC.
 */
async function reserveEphemeralPort(): Promise<number | undefined> {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', () => resolve(undefined));
    probe.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : undefined;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Run a piece of work with a caller identity in scope.
 *
 * The backend host uses this around every call into the engine, so the tools
 * a model calls run with the real caller's authority.
 */
export { withCaller };
export type { CallerIdentity };
