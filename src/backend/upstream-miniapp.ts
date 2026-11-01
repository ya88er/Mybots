// @ts-check
/**
 * A typed view of the upstream Mini App's entry point.
 *
 * The vendored subtree is plain JavaScript with a JSDoc-typed contract. This
 * module gives the host a typed import of `start(context)` without touching a
 * single upstream file: the implementation is the upstream function, and only
 * the declaration is ours.
 *
 * The context's shape is declared here rather than imported from the vendored
 * `miniapp-api.ts`, so the build's `rootDir` never has to reach into the
 * vendored subtree. The shape is the upstream one, copied from
 * `miniapp/node/miniapp-api.ts`.
 *
 * The upstream server is loaded **dynamically, from the path the host
 * resolves**, not by a static import. A static import would be relative to
 * this file's own location, and that location is not the same in every
 * layout: in a development run the vendored tree is at the repository's root,
 * while in a packaged build it is inside the archive at `dist/vendor`. The
 * host already resolves the right place for it — that is the same place it
 * passes to the Mini App as `pluginRoot` — so the loader is told where to
 * look.
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

/**
 * The upstream server's `start(context)`.
 *
 * It is resolved on the first call and kept: the Mini App is started once per
 * backend, and the module is cached by Node anyway.
 */
let startUpstream: ((context: unknown) => Promise<unknown>) | undefined;

/**
 * Load the upstream server from the Mini App's root.
 *
 * The path is turned into a `file://` URL, because that is what a dynamic
 * import needs — and a URL is also what lets the loader reach **inside an
 * archive**, where the vendored tree lives in a packaged build.
 */
async function loadUpstream(pluginRoot: string): Promise<(context: unknown) => Promise<unknown>> {
  if (startUpstream) return startUpstream;
  const entry = join(pluginRoot, 'miniapp', 'node', 'server.mjs');
  const module = (await import(pathToFileURL(entry).href)) as {
    start?: (context: unknown) => Promise<unknown>;
  };
  if (typeof module.start !== 'function') {
    throw new Error('The MiniBots Mini App did not export a start function.');
  }
  startUpstream = module.start;
  return startUpstream;
}

/** The agent client the upstream engine consumes. */
export interface MiniAppAgentClient {
  run(
    input: { readonly text: string; readonly sessionId?: string },
    options?: MiniAppAgentRunOptions,
  ): Promise<MiniAppAgentRunResult>;
  reply(input: {
    readonly sessionId: string;
    readonly requestId: string;
    readonly decision: 'allowOnce' | 'deny';
  }): Promise<void>;
  answer(
    input: {
      readonly sessionId: string;
      readonly requestId: string;
      readonly answers: readonly unknown[];
    },
    options?: MiniAppAgentRunOptions,
  ): Promise<MiniAppAgentRunResult>;
  models?(): Promise<{ readonly models: readonly unknown[]; readonly default?: unknown }>;
}

export interface MiniAppAgentRunOptions {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: unknown) => void;
}

export interface MiniAppAgentRunResult {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly status: 'finished' | 'error' | 'aborted';
  readonly text?: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly pendingQuestion?: {
    readonly requestId: string;
    readonly mode: 'questionnaire' | 'feature-enable' | 'plan';
    readonly request: unknown;
  };
}

export interface MiniAppLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** The context the upstream Mini App is started with. */
export interface MiniAppContext {
  readonly pluginId: string;
  readonly pluginRoot: string;
  readonly dataDir: string;
  readonly listen: Readonly<{ readonly host: '127.0.0.1'; readonly port: number }>;
  readonly signal: AbortSignal;
  readonly logger: MiniAppLogger;
  readonly agent?: MiniAppAgentClient;
  /**
   * The Host's schedule catch-up record.
   *
   * It answers "was this occurrence already delivered?", so a schedule that
   * came due while the Host was closed is delivered exactly once — even if
   * the Host restarts before the schedule's next slot.
   */
  readonly scheduleCatchUp?: (scheduleId: string, nextRunAt: number) => Promise<boolean> | boolean;
}

/** The lifecycle the upstream Mini App returns. */
export interface MiniAppLifecycle {
  dispose(): void | Promise<void>;
  /**
   * The MiniBots business tools, as a dispatch.
   *
   * It is exposed so a Host can offer the same tools over another transport
   * — the Windows app registers them as Pi custom tools this way — while the
   * Streamable HTTP MCP endpoint keeps using the same handlers.
   */
  dispatch?: MiniAppToolDispatch;
}

/** The tool dispatch the upstream Mini App exposes. */
export interface MiniAppToolDispatch {
  definitions(): Array<{ name: string; description: string; inputSchema: unknown }>;
  names(): string[];
  call(
    name: string,
    args: Record<string, unknown>,
    options?: { caller?: unknown; signal?: AbortSignal },
  ): Promise<unknown>;
  failureText(error: unknown, name: string): string;
}

/**
 * Start the upstream Mini App.
 *
 * The upstream server binds the address the context names and returns a
 * lifecycle that stops it.
 *
 * The Mini App's root is taken from the context, because that is where the
 * host has already resolved it.
 */
export const start = async (context: MiniAppContext): Promise<MiniAppLifecycle> => {
  const start_ = await loadUpstream(context.pluginRoot);
  return (await start_(context as never)) as MiniAppLifecycle;
};
