import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startBackend } from '../../src/backend/backend-host.ts';
import { startGate } from '../../src/backend/backend-gate.ts';

// These tests start the **real** upstream Mini App — the vendored
// `server.mjs` — with a real context, and drive it over a real loopback
// socket. Only the model call is absent: no provider key is configured, so
// the engine reports that no agent is available for a turn, which is exactly
// the state a freshly installed app is in.

async function backendFixture(t: { after: (fn: () => unknown) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'minibots-backend-'));
  const token = 'test-token-value';

  const backend = await startBackend({
    dataDir: join(root, 'data'),
    sessionDir: join(root, 'sessions'),
    agentDir: join(root, 'agent'),
    token,
    log: () => {},
  });

  const gate = await startGate({
    upstream: { host: backend.ready.host, port: backend.ready.port },
    token,
  });

  t.after(async () => {
    await gate.stop();
    await backend.stop();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const call = async (path: string, init?: RequestInit) => {
    const response = await fetch(`http://127.0.0.1:${gate.port}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON.
    }
    return { status: response.status, body };
  };

  return { root, token, gate, backend, call };
}

test('the upstream Mini App starts and answers its state route', async (t) => {
  const h = await backendFixture(t);

  const { status, body } = await h.call('/api/state');
  assert.equal(status, 200, 'the state route answers');
  const state = body as { bots?: unknown[]; settings?: unknown; agentAvailable?: boolean };
  assert.ok(Array.isArray(state.bots), 'the state carries the bots');
  assert.ok(state.settings, 'the state carries the settings');
  assert.equal(state.agentAvailable, true, 'the agent is wired into the engine');
});

test('the client page is served', async (t) => {
  const h = await backendFixture(t);

  const response = await fetch(`http://127.0.0.1:${h.gate.port}/bot`, {
    headers: { authorization: `Bearer ${h.token}` },
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<html/i, 'the page is the MiniBots client');
});

test('the upstream server refuses a request without the token', async (t) => {
  const h = await backendFixture(t);

  const response = await fetch(`http://127.0.0.1:${h.gate.port}/api/state`);
  assert.equal(response.status, 401, 'the request is refused');
});

test('a Bot can be created and appears in the state', async (t) => {
  const h = await backendFixture(t);

  const created = await h.call('/api/bots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Test Bot', role: 'Helper' }),
  });
  assert.equal(created.status, 200, `the bot was created: ${JSON.stringify(created.body)}`);

  const state = await h.call('/api/state');
  const bots = (state.body as { bots: Array<{ name: string }> }).bots;
  assert.ok(
    bots.some((bot) => bot.name === 'Test Bot'),
    'the new bot is in the state',
  );
});

test('the app state survives a restart of the backend', async (t) => {
  const h = await backendFixture(t);

  await h.call('/api/bots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Persistent Bot', role: 'Helper' }),
  });

  // The backend stops and starts again over the same data directory, which
  // is what a restart of the app does.
  await h.gate.stop();
  await h.backend.stop();

  const token = 'test-token-value';
  const restarted = await startBackend({
    dataDir: join(h.root, 'data'),
    sessionDir: join(h.root, 'sessions'),
    agentDir: join(h.root, 'agent'),
    token,
    log: () => {},
  });
  const gate = await startGate({
    upstream: { host: restarted.ready.host, port: restarted.ready.port },
    token,
  });
  t.after(async () => {
    await gate.stop();
    await restarted.stop();
  });

  const response = await fetch(`http://127.0.0.1:${gate.port}/api/state`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const state = (await response.json()) as { bots: Array<{ name: string }> };
  assert.ok(
    state.bots.some((bot) => bot.name === 'Persistent Bot'),
    'the bot survived the restart',
  );
});

test('the app\'s own routes are served in front of the upstream server', async (t) => {
  const h = await backendFixture(t);

  // The gate owns the app's routes, because the upstream server's routing is
  // a closure and cannot be extended without changing a vendored file.
  const gate = await startGate({
    upstream: { host: h.backend.ready.host, port: h.backend.ready.port },
    token: h.token,
    routes: async (path, method) => {
      if (method === 'GET' && path === '/api/app/sessions') {
        return { status: 200, body: { sessions: [], count: 0 } };
      }
      return undefined;
    },
  });
  t.after(gate.stop);

  const response = await fetch(`http://127.0.0.1:${gate.port}/api/app/sessions`, {
    headers: { authorization: `Bearer ${h.token}` },
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { sessions: unknown[]; count: number };
  assert.equal(body.count, 0);
  assert.deepEqual(body.sessions, []);

  // A path the app does not own still reaches the upstream server.
  const upstreamResponse = await fetch(`http://127.0.0.1:${gate.port}/api/state`, {
    headers: { authorization: `Bearer ${h.token}` },
  });
  assert.equal(upstreamResponse.status, 200, 'the upstream route still works');
});

test('an app route still needs the token', async (t) => {
  const h = await backendFixture(t);
  const gate = await startGate({
    upstream: { host: h.backend.ready.host, port: h.backend.ready.port },
    token: h.token,
    routes: async (path, method) =>
      method === 'GET' && path === '/api/app/sessions'
        ? { status: 200, body: { sessions: [], count: 0 } }
        : undefined,
  });
  t.after(gate.stop);

  const response = await fetch(`http://127.0.0.1:${gate.port}/api/app/sessions`);
  assert.equal(response.status, 401, 'the app route is behind the token too');
});

test('the page\'s own assets are public, and nothing else is', async (t) => {
  const h = await backendFixture(t);

  // The window is served from the app's origin, so the browser asks for the
  // page's stylesheet and its scripts as subresources. A subresource request
  // cannot carry an `Authorization` header, so these are the one exception
  // to the gate's rule — and the exception must stay that narrow.
  for (const path of ['/bot', '/bot/app.css', '/bot/app.js']) {
    const response = await fetch(`http://127.0.0.1:${h.gate.port}${path}`);
    assert.equal(response.status, 200, `${path} is a public asset`);
  }

  // Everything that can carry the user's data stays behind the token.
  for (const path of [
    '/api/state',
    '/api/bots',
    '/api/models',
    '/api/app/sessions',
    '/api/app/dispatches',
    '/mcp/minimax-bot',
  ]) {
    const response = await fetch(`http://127.0.0.1:${h.gate.port}${path}`);
    assert.equal(response.status, 401, `${path} needs the token`);
  }
});

test('a public asset is refused when the method is not a GET', async (t) => {
  const h = await backendFixture(t);

  // Only a read is public. A write to the same path must not be.
  const response = await fetch(`http://127.0.0.1:${h.gate.port}/bot/app.js`, {
    method: 'POST',
  });
  assert.equal(response.status, 401, 'only GET is public');
});

test('the backend shuts down cleanly and releases its port', async (t) => {
  const h = await backendFixture(t);
  const { port } = h.backend.ready;

  await h.gate.stop();
  await h.backend.stop();

  // The port must be free again: the app must be able to start a second
  // instance after the first one exits.
  const response = await fetch(`http://127.0.0.1:${port}/api/state`).catch(() => undefined);
  assert.equal(response, undefined, 'the upstream server stopped answering');
});
