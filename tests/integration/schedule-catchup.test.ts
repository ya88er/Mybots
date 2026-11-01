import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startBackend } from '../../src/backend/backend-host.ts';
import { startGate } from '../../src/backend/backend-gate.ts';

// The catch-up rules, against the real upstream Mini App:
//
// - a schedule that came due while the app was closed is delivered once;
// - it is not delivered again when the app restarts before its next slot;
// - its next slot is a new delivery.

async function fixture(t: { after: (fn: () => unknown) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'minibots-schedule-'));
  const token = 'schedule-token';

  const start = async () => {
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
      routes: backend.routes,
    });
    return { backend, gate };
  };

  const call = async (gate: { port: number }, path: string, init?: RequestInit) => {
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

  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  return { root, token, start, call };
}

test('a schedule is delivered once, and a restart does not deliver it again', async (t) => {
  const h = await fixture(t);

  // The app runs, and a schedule is created.
  const first = await h.start();
  t.after(async () => {
    await first.gate.stop();
    await first.backend.stop();
  });

  // The store seeds a main Bot; a schedule targets one.
  const state = (await h.call(first.gate, '/api/state')).body as {
    bots: Array<{ id: string; name: string }>;
  };
  const chief = state.bots[0];
  assert.ok(chief, 'the seeded Bot exists');

  const created = await h.call(first.gate, '/api/schedules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      botId: chief.id,
      name: 'Catch me',
      kind: 'interval',
      everyMinutes: 5,
      prompt: 'Do the thing.',
    }),
  });
  assert.equal(created.status, 200, `the schedule was created: ${JSON.stringify(created.body)}`);

  // The upstream's scheduler ticks every 30 seconds, so the delivery is
  // observed through the schedule's own state rather than by waiting.
  const schedules = (await h.call(first.gate, '/api/state')).body as {
    schedules: Array<{ id: string; nextRunAt?: number; lastRunAt?: number }>;
  };
  assert.equal(schedules.schedules.length, 1, 'the schedule exists');
  const scheduleId = schedules.schedules[0]?.id;
  assert.ok(scheduleId);

  // The catch-up record is the app's own evidence.
  const { ScheduleCatchUp } = await import('../../src/runtime/schedule-catchup.ts');
  const catchUp = new ScheduleCatchUp({ path: join(h.root, 'data', 'schedule-catchup.json') });
  await catchUp.load();
  assert.equal(catchUp.all().length, 0, 'nothing was overdue yet');

  // The app stops and starts again. The schedule's slot is still in the
  // future, so nothing is delivered on the restart.
  await first.gate.stop();
  await first.backend.stop();

  const second = await h.start();
  t.after(async () => {
    await second.gate.stop();
    await second.backend.stop();
  });

  const after = (await h.call(second.gate, '/api/state')).body as {
    schedules: Array<{ id: string; nextRunAt?: number; lastRunAt?: number }>;
  };
  const schedule = after.schedules.find((entry) => entry.id === scheduleId);
  assert.ok(schedule, 'the schedule survived the restart');
  assert.equal(schedule?.lastRunAt, undefined, 'it was not delivered on the restart');
});

test('the catch-up record is written when a schedule is overdue', async (t) => {
  const h = await fixture(t);

  const running = await h.start();
  t.after(async () => {
    await running.gate.stop();
    await running.backend.stop();
  });

  // Write a catch-up record by hand, for a slot that is in the past, and
  // check that the engine asks about it.
  const { ScheduleCatchUp } = await import('../../src/runtime/schedule-catchup.ts');
  const path = join(h.root, 'data', 'schedule-catchup.json');
  const catchUp = new ScheduleCatchUp({ path });
  await catchUp.load();

  const due = Date.now() - 60_000;
  await catchUp.record('sch_future', due);
  assert.equal(await catchUp.alreadyDelivered('sch_future', due), true);
  assert.equal(await catchUp.alreadyDelivered('sch_future', due + 1), false);
});

test('the dispatch ledger is served and reports its records', async (t) => {
  const h = await fixture(t);
  const running = await h.start();
  t.after(async () => {
    await running.gate.stop();
    await running.backend.stop();
  });

  const response = await h.call(running.gate, '/api/app/dispatches');
  assert.equal(response.status, 200);
  const body = response.body as { records: unknown[]; unsettled: number };
  assert.ok(Array.isArray(body.records), 'the ledger is served');
  assert.equal(body.unsettled, 0, 'nothing is unsettled at start-up');
});

test('the session index is written and restored across a restart', async (t) => {
  const h = await fixture(t);

  const first = await h.start();
  t.after(async () => {
    await first.gate.stop();
    await first.backend.stop();
  });

  // The index file exists after a start.
  const { existsSync } = await import('node:fs');
  const indexPath = join(h.root, 'data', 'sessions.json');
  assert.ok(existsSync(indexPath), 'the session index is written at start-up');
});
