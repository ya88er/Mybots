import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DispatchLedger } from '../../src/runtime/dispatch-ledger.ts';
import { ScheduleCatchUp } from '../../src/runtime/schedule-catchup.ts';
import { SessionIndex } from '../../src/runtime/session-index.ts';
import { SessionRegistry } from '../../src/runtime/session-registry.ts';

// The recovery path: what the app knows after a crash, and what it is
// allowed to do about it.

async function root(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'minibots-recovery-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return dir;
}

test('an admitted dispatch is unknown after a restart, not replayed', async (t) => {
  const dir = await root(t);
  const path = join(dir, 'ledger.json');

  // The app admits a dispatch and then stops.
  const first = new DispatchLedger({ path });
  await first.admit({
    id: 'd1',
    kind: 'turn',
    subject: 'bot1',
    chatId: 'chat1',
    sessionId: 'sess1',
  });

  // The app starts again.
  const second = new DispatchLedger({ path });
  await second.load();
  const reconciled = await second.reconcile();

  assert.equal(reconciled.length, 1, 'the unsettled dispatch was reconciled');
  assert.equal(reconciled[0]?.state, 'unknown', 'its outcome is unknown');
  assert.match(reconciled[0]?.reason ?? '', /stopped before/);

  // A second reconciliation changes nothing: the outcome stays unknown, and
  // the dispatch is not admitted again.
  const again = await second.reconcile();
  assert.equal(again.length, 0, 'the second reconciliation found nothing unsettled');
  assert.equal(second.get('d1')?.state, 'unknown', 'the outcome is still unknown');
  assert.equal(second.unsettled().length, 0, 'nothing is left to replay');
});

test('a settled dispatch stays settled across a restart', async (t) => {
  const dir = await root(t);
  const path = join(dir, 'ledger.json');

  const first = new DispatchLedger({ path });
  await first.admit({ id: 'd1', kind: 'turn', subject: 'bot1', chatId: 'chat1' });
  await first.settle('d1', 'settled', 'the turn finished');

  const second = new DispatchLedger({ path });
  await second.load();
  const reconciled = await second.reconcile();

  assert.equal(reconciled.length, 0, 'a settled dispatch is not reconciled');
  assert.equal(second.get('d1')?.state, 'settled');
  assert.equal(second.get('d1')?.reason, 'the turn finished');
});

test('the ledger survives a corrupt file without losing the app', async (t) => {
  const dir = await root(t);
  const path = join(dir, 'ledger.json');

  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, 'not json at all', 'utf8');

  const ledger = new DispatchLedger({ path });
  await ledger.load();
  assert.equal(ledger.all().length, 0, 'the ledger starts empty');

  // It still works.
  await ledger.admit({ id: 'd1', kind: 'turn', subject: 'bot1', chatId: 'chat1' });
  assert.equal(ledger.all().length, 1);
});

test('the ledger keeps its newest records', async (t) => {
  const dir = await root(t);
  const ledger = new DispatchLedger({ path: join(dir, 'ledger.json') });

  for (let index = 0; index < 600; index += 1) {
    await ledger.admit({
      id: `d${index}`,
      kind: 'turn',
      subject: 'bot1',
      chatId: 'chat1',
      admittedAt: index,
    });
  }

  assert.equal(ledger.all().length, 500, 'the ledger is bounded');
  assert.equal(ledger.all()[0]?.id, 'd100', 'the oldest records were dropped');
});

test('an overdue schedule is caught up once, not once per missed occurrence', async (t) => {
  const dir = await root(t);
  const catchUp = new ScheduleCatchUp({ path: join(dir, 'catchup.json') });

  // The schedule was due at a fixed moment.
  const due = 1_700_000_000_000;

  assert.equal(await catchUp.alreadyDelivered('sch1', due), false, 'it has not been delivered');

  await catchUp.record('sch1', due);
  assert.equal(await catchUp.alreadyDelivered('sch1', due), true, 'it has been delivered');

  // The app restarts: the record is still there, so the catch-up does not
  // happen twice.
  const restarted = new ScheduleCatchUp({ path: join(dir, 'catchup.json') });
  await restarted.load();
  assert.equal(
    await restarted.alreadyDelivered('sch1', due),
    true,
    'the catch-up is remembered across a restart',
  );

  // The schedule's next slot comes round, and that one is delivered.
  const nextSlot = due + 86_400_000;
  assert.equal(
    await restarted.alreadyDelivered('sch1', nextSlot),
    false,
    'the next slot is a new delivery',
  );
});

test('a schedule that was never due is not caught up', async (t) => {
  const dir = await root(t);
  const catchUp = new ScheduleCatchUp({ path: join(dir, 'catchup.json') });
  assert.equal(await catchUp.alreadyDelivered('sch1', 1), false);
  assert.equal(catchUp.all().length, 0);
});

test('the session index restores the association between a chat and its Pi session', async (t) => {
  const dir = await root(t);
  const path = join(dir, 'sessions.json');

  const registry = new SessionRegistry();
  registry.ensure('bot1', 'chat1', 0, 'C:/workspace');
  registry.bindPiSession('sess_bot1__chat1__g0', 'pi-1', 'C:/sessions/pi-1.jsonl', {
    providerId: 'deepseek',
    modelId: 'deepseek-chat',
  });

  const index = new SessionIndex({ path });
  await index.save(registry.all());

  // The app starts again.
  const restored = new SessionRegistry();
  restored.load(await new SessionIndex({ path }).load());

  const association = restored.get('sess_bot1__chat1__g0');
  assert.ok(association, 'the association came back');
  assert.equal(association?.botId, 'bot1');
  assert.equal(association?.chatId, 'chat1');
  assert.equal(association?.piSessionId, 'pi-1', 'the Pi session id came back');
  assert.equal(association?.piSessionFile, 'C:/sessions/pi-1.jsonl');
  assert.equal(association?.providerId, 'deepseek');
  assert.equal(association?.modelId, 'deepseek-chat');

  // And the index finds it by its (bot, chat, generation) key.
  assert.equal(restored.find('bot1', 'chat1', 0)?.id, 'sess_bot1__chat1__g0');
});

test('a cleared chat starts a new generation and does not reuse the old session', async (t) => {
  const registry = new SessionRegistry();
  registry.ensure('bot1', 'chat1', 0, 'C:/workspace');
  registry.ensure('bot1', 'chat1', 1, 'C:/workspace');

  const first = registry.find('bot1', 'chat1', 0);
  const second = registry.find('bot1', 'chat1', 1);
  assert.notEqual(first?.id, second?.id, 'the generations have their own sessions');
});
