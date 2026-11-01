import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { startGate } from '../../src/backend/backend-gate.ts';

// The gate is the app's only defence on a desktop machine, where any process
// can reach 127.0.0.1. These tests use a real upstream HTTP server and a real
// loopback socket, because the claim they make is about the network.

/** A tiny upstream that echoes what it received. */
async function upstream(): Promise<{ port: number; close: () => Promise<void>; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true, url: request.url }));
  });
  server.listen({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  return {
    port,
    seen,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('a request without the token is refused and never reaches the upstream', async (t) => {
  const up = await upstream();
  t.after(up.close);

  const gate = await startGate({ upstream: { host: '127.0.0.1', port: up.port }, token: 'secret-token' });
  t.after(gate.stop);

  const response = await fetch(`http://127.0.0.1:${gate.port}/api/state`);
  assert.equal(response.status, 401, 'the request is refused');
  const body = (await response.json()) as { error?: string };
  assert.equal(body.error, 'unauthorized');
  assert.equal(up.seen.length, 0, 'the upstream server was never called');
});

test('a request with the wrong token is refused', async (t) => {
  const up = await upstream();
  t.after(up.close);

  const gate = await startGate({ upstream: { host: '127.0.0.1', port: up.port }, token: 'secret-token' });
  t.after(gate.stop);

  const response = await fetch(`http://127.0.0.1:${gate.port}/api/state`, {
    headers: { authorization: 'Bearer wrong-token' },
  });
  assert.equal(response.status, 401);
  assert.equal(up.seen.length, 0, 'the upstream server was never called');
});

test('a request with a token of the right length but different content is refused', async (t) => {
  const up = await upstream();
  t.after(up.close);

  const gate = await startGate({ upstream: { host: '127.0.0.1', port: up.port }, token: 'secret-token' });
  t.after(gate.stop);

  // The same length, one character different: a naive comparison that stops
  // at the first difference would accept a prefix.
  const response = await fetch(`http://127.0.0.1:${gate.port}/api/state`, {
    headers: { authorization: 'Bearer secret-tokeN' },
  });
  assert.equal(response.status, 401);
  assert.equal(up.seen.length, 0);
});

test('a request with the right token is served', async (t) => {
  const up = await upstream();
  t.after(up.close);

  const gate = await startGate({ upstream: { host: '127.0.0.1', port: up.port }, token: 'secret-token' });
  t.after(gate.stop);

  const response = await fetch(`http://127.0.0.1:${gate.port}/api/state`, {
    headers: { authorization: 'Bearer secret-token' },
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { ok?: boolean; url?: string };
  assert.equal(body.ok, true);
  assert.equal(body.url, '/api/state', 'the path is passed through');
  assert.deepEqual(up.seen, ['/api/state'], 'the upstream was called exactly once');
});

test('the authorization header is not forwarded to the upstream', async (t) => {
  const received: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    received.push(request.headers.authorization);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  server.listen({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const gate = await startGate({ upstream: { host: '127.0.0.1', port }, token: 'secret-token' });
  t.after(gate.stop);

  await fetch(`http://127.0.0.1:${gate.port}/api/state`, {
    headers: { authorization: 'Bearer secret-token' },
  });

  assert.equal(received.length, 1);
  assert.equal(
    received[0],
    undefined,
    'the upstream never sees the app\'s bearer token',
  );
});

test('the gate binds the loopback interface only', async (t) => {
  const up = await upstream();
  t.after(up.close);

  const gate = await startGate({ upstream: { host: '127.0.0.1', port: up.port }, token: 'secret-token' });
  t.after(gate.stop);

  // The gate must not be reachable on the machine's LAN address.
  const interfaces = (await import('node:os')).networkInterfaces();
  const external = Object.values(interfaces)
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry!.address);
  for (const address of external) {
    const response = await fetch(`http://${address}:${gate.port}/api/state`).catch(() => undefined);
    assert.equal(response, undefined, `the gate is not reachable on ${address}`);
  }
});
