// @ts-check
/**
 * The declaration for the vendored Mini App's entry point.
 *
 * The vendored subtree is plain JavaScript, so TypeScript cannot infer its
 * types across the module boundary. This file provides one.
 *
 * It declares the module **by its specifier pattern** rather than by a
 * relative path, so the vendored file never enters the build's `rootDir` and
 * no compiled artifact is ever written into `vendor/`.
 */
declare module '*minimax-bot/miniapp/node/server.mjs' {
  /** The context the upstream Mini App is started with. */
  export interface MiniAppContext {
    readonly pluginId: string;
    readonly pluginRoot: string;
    readonly dataDir: string;
    readonly listen: Readonly<{ readonly host: '127.0.0.1'; readonly port: number }>;
    readonly signal: AbortSignal;
    readonly logger: {
      debug(message: string, fields?: Record<string, unknown>): void;
      info(message: string, fields?: Record<string, unknown>): void;
      warn(message: string, fields?: Record<string, unknown>): void;
      error(message: string, fields?: Record<string, unknown>): void;
    };
    readonly agent?: unknown;
  }

  /** The lifecycle the upstream Mini App returns. */
  export interface MiniAppLifecycle {
    dispose(): void | Promise<void>;
  }

  export const USER_NAME_MAX: number;
  export function start(context: MiniAppContext): Promise<MiniAppLifecycle>;
}
