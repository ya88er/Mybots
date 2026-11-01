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
 */
import { start as startUpstream } from '../../vendor/minimax-bot/miniapp/node/server.mjs';

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
 */
export const start = async (context: MiniAppContext): Promise<MiniAppLifecycle> =>
  (await startUpstream(context as never)) as MiniAppLifecycle;
