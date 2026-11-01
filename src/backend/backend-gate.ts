// @ts-check
/**
 * The authenticated loopback gate.
 *
 * The upstream Mini App's HTTP server has no authentication: it trusts every
 * request that reaches it. That is fine when the Host owns the socket, and
 * wrong for a desktop app, where any process on the machine can reach
 * `127.0.0.1:<port>` and would otherwise be able to read the user's chats,
 * create Bots and spend the user's model credits.
 *
 * The gate is a thin HTTP proxy in front of the upstream server:
 *
 * - every request must carry the bearer token, in the `Authorization` header;
 * - a request without it is refused with 401 and never reaches the upstream
 *   server;
 * - the token is compared in constant time, so a wrong token leaks nothing
 *   through timing;
 * - the upstream server stays bound to the loopback interface and is never
 *   reachable except through the gate.
 *
 * The renderer never sees the token: it talks to the Electron main process,
 * which holds it and adds the header itself.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';

/** How long a proxied request may take, in milliseconds. */
const UPSTREAM_TIMEOUT_MS = 120_000;

/**
 * What a route may answer with.
 *
 * A route normally answers with JSON. The app's own **pages** — the provider
 * settings window and the two inspectors — are static files, so a route may
 * answer with raw bytes instead.
 */
export interface GateResponse {
  readonly status: number;
  readonly body?: unknown;
  /** The raw response, when the route serves a file rather than JSON. */
  readonly file?: { readonly contentType: string; readonly body: Buffer };
}

/** The app's own routes. */
export type GateRoutes = (
  path: string,
  method: string,
) =>
  | Promise<GateResponse | undefined>
  | GateResponse
  | undefined;

export interface GateOptions {
  /** The upstream server's address. */
  readonly upstream: { readonly host: string; readonly port: number };
  /** The bearer token every request must carry. */
  readonly token: string;
  /** Reports a refused request. */
  readonly log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
  /**
   * The app's own routes.
   *
   * The upstream server's routing is a closure, so it cannot be extended
   * without changing a vendored file. The app's own routes — the session
   * inspector and the app's own pages — are therefore served here, in front
   * of the upstream server, where the app owns the code.
   */
  readonly routes?: GateRoutes;
}

/** The running gate. */
export interface Gate {
  readonly port: number;
  readonly stop: () => Promise<void>;
}

/**
 * Compare two strings without leaking their difference through timing.
 *
 * The lengths are compared first, because the length is not a secret: the
 * token is a fixed-length random value.
 */
function tokensMatch(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const receivedBytes = Buffer.from(received, 'utf8');
  if (expectedBytes.length !== receivedBytes.length) return false;
  return timingSafeEqual(expectedBytes, receivedBytes);
}

/** A constant-time comparison, without importing a Node API that may move. */
function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= a[i]! ^ b[i]!;
  }
  return difference === 0;
}

/** The bearer token a request carries, if it carries one. */
function bearerOf(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * The paths that are served without a token.
 *
 * A page's own assets — the HTML, the CSS, the JavaScript, the SVG icons and
 * the skin images — are **not** user data: they are the application itself,
 * and every one of them ships inside the app. A browser loads them as
 * subresources, which cannot carry an `Authorization` header, so requiring a
 * token for them would leave the window blank.
 *
 * Everything that can carry the user's data — every `/api/…` route, the MCP
 * endpoint and the event stream — still needs the token. The rule is
 * therefore narrow and checkable: a path is public only when it is one of the
 * app's own static files.
 */
const PUBLIC_ASSET = /^\/bot(\/skins\/[a-z]+\.png|\/[a-z0-9-]+\.(js|css|svg))?\/?$/;

/**
 * The app's own window's assets.
 *
 * The provider settings window is the same kind of thing as the chat page:
 * the application's own files, loaded as subresources by a browser that
 * cannot carry an `Authorization` header. The window's **data** — the
 * provider keys, the sessions, the dispatches — is reached through the
 * preload bridge and through the authenticated API routes, so nothing the
 * user owns is served this way.
 */
const PUBLIC_APP_ASSET = /^\/app(\/[a-z0-9-]+\.(js|css))?\/?$/;

/** Whether a path is one of the app's own static assets. */
export function isPublicAsset(path: string): boolean {
  return PUBLIC_ASSET.test(path) || PUBLIC_APP_ASSET.test(path);
}

/**
 * Start the gate.
 *
 * The gate listens on its own ephemeral loopback port; that is the address the
 * Electron main process talks to.
 */
export async function startGate(options: GateOptions): Promise<Gate> {
  const log = options.log ?? (() => {});

  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const method = request.method ?? 'GET';

    // The app's own static assets are public; see `isPublicAsset`. A browser
    // loads them as subresources, which cannot carry a token, and they are
    // the application's own files rather than the user's data.
    //
    // Everything else — every `/api/…` route, the MCP endpoint, the event
    // stream and the app's own routes — is behind the token. The token check
    // comes **before** the routes are consulted, so a route can never be
    // reached without a token.
    const publicAsset = method === 'GET' && isPublicAsset(path);

    if (!publicAsset) {
      const token = bearerOf(request);
      if (!token || !tokensMatch(options.token, token)) {
        log('warn', 'minibots.gate_refused', {
          path,
          method,
        });
        response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
        response.end(
          JSON.stringify({ error: 'unauthorized', message: 'A valid bearer token is required.' }),
        );
        return;
      }
    }

    // The app's own routes are answered here, in front of the upstream
    // server, and never reach it. The app's own window's files are among
    // them: they are static assets, so they are reached without a token.
    void Promise.resolve(options.routes?.(path, method))
      .then(async (route) => {
        if (!route) {
          await proxyToUpstream(request, response, options.upstream);
          return;
        }
        if (route.file) {
          response.writeHead(route.status, {
            'content-type': route.file.contentType,
            'cache-control': 'no-store',
          });
          response.end(route.file.body);
          return;
        }
        response.writeHead(route.status, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(route.body));
      })
      .catch((error: unknown) => {
        log('error', 'minibots.gate_route_failed', {
          path,
          message: error instanceof Error ? error.message : String(error),
        });
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        }
        response.end(
          JSON.stringify({ error: 'internal', message: 'The request could not be handled.' }),
        );
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : undefined;
  if (!port) {
    server.close();
    throw new Error('The loopback gate did not bind a port.');
  }

  const stop = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  };

  return { port, stop };
}

/**
 * Forward one authenticated request to the upstream server.
 *
 * The body, the method, the content type and the SSE stream are all passed
 * through unchanged: the upstream server's own behaviour is not second-guessed
 * here.
 */
async function proxyToUpstream(
  request: IncomingMessage,
  response: ServerResponse,
  upstream: { host: string; port: number },
): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    // The host header must name the upstream, or the upstream's own routing
    // would reject it; the authorization header must not be forwarded.
    if (name === 'host') continue;
    if (name === 'authorization') continue;
    headers[name] = value;
  }
  headers.host = `${upstream.host}:${upstream.port}`;

  const upstreamResponse = await new Promise<IncomingMessage>((resolve, reject) => {
    const forwarded = httpRequest(
      {
        host: upstream.host,
        port: upstream.port,
        method: request.method,
        path: request.url,
        headers,
      },
      resolve,
    );
    forwarded.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      forwarded.destroy(new Error('The upstream request timed out.'));
    });
    forwarded.on('error', reject);
    request.pipe(forwarded);
  });

  response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
  upstreamResponse.pipe(response);
  upstreamResponse.on('error', () => {
    response.end();
  });
}
