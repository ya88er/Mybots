import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../vendor/minimax-bot/miniapp/node/store.mjs';
import { MemoryStore } from '../../vendor/minimax-bot/miniapp/node/memory.mjs';
import { Engine } from '../../vendor/minimax-bot/miniapp/node/engine.mjs';
import { Team } from '../../vendor/minimax-bot/miniapp/node/team.mjs';
import { effortOptions, normalizeModel, withEffort } from '../../vendor/minimax-bot/miniapp/node/store.mjs';
import { setLocale } from '../../vendor/minimax-bot/miniapp/node/i18n.mjs';
import { removeTempDir } from '../../vendor/minimax-bot/tests/helpers/temp-dir.mjs';

// The engine and the settings page both read the Host's model catalog through
// `agent.models()`. The catalog entry shape is load-bearing: `withEffort` reads
// `thinking.efforts` and `variants`, and the composer passes the result to
// `run({ model })`. These tests pin that contract so the Pi adapter cannot
// drift from it.

const CATALOG = {
  models: [
    {
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      displayName: 'DeepSeek Chat',
      thinking: { efforts: [], default: undefined },
      variants: [],
    },
    {
      providerId: 'minimax',
      modelId: 'MiniMax-M3',
      displayName: 'MiniMax M3',
      thinking: { efforts: ['low', 'medium', 'high'], default: 'medium' },
      variants: ['', 'thinking'],
    },
  ],
  default: {
    providerId: 'minimax',
    modelId: 'MiniMax-M3',
    displayName: 'MiniMax M3',
    thinking: { efforts: ['low', 'medium', 'high'], default: 'medium' },
    variants: ['', 'thinking'],
  },
};

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'minibots-model-contract-'));
  const store = new Store(dir);
  const memory = new MemoryStore(dir);
  await store.init();
  await memory.init();
  setLocale('en');
  const bot = { id: 'bot_a', name: 'Alice', isMain: true };
  store.state.bots = [bot];
  await store.save();
  const engine = new Engine({
    store, memory, logger: { warn() {} }, broadcast() {}, retryDelaysMs: [],
  });
  new Team({ store, memory, engine, broadcast() {} });
  t.after(async () => {
    engine.dispose();
    await removeTempDir(dir);
  });
  return { dir, store, engine, bot };
}

test('a Host without models() reports the model picker as unsupported', async (t) => {
  const { engine } = await fixture(t);
  // No agent at all: the engine must not throw, it must report "unsupported".
  assert.equal(engine.supportsModels(), false);
  assert.equal(await engine.modelCatalog(), undefined);
});

test('a Host with models() exposes the catalog and its default', async (t) => {
  const { engine } = await fixture(t);
  engine.agent = { run: async () => ({ status: 'finished' }) , models: async () => CATALOG };
  assert.equal(engine.supportsModels(), true);
  const catalog = await engine.modelCatalog({ fresh: true });
  assert.equal(catalog.models.length, 2);
  assert.equal(catalog.default.providerId, 'minimax');
  assert.equal(catalog.default.modelId, 'MiniMax-M3');
});

test('a Bot that names no model but an effort runs the default at that effort', async (t) => {
  const { engine, bot } = await fixture(t);
  engine.agent = { run: async () => ({ status: 'finished' }) , models: async () => CATALOG };
  const model = await engine.turnModel({ ...bot, effort: 'high' }, undefined);
  assert.equal(model.providerId, 'minimax');
  assert.equal(model.modelId, 'MiniMax-M3');
  assert.equal(model.thinking.effort, 'high');
  assert.equal(model.variant, 'thinking');
  // The value the composer passes to run({ model }) must survive normalizeModel.
  assert.deepEqual(normalizeModel(model), model);
});

test('an effort the default does not offer falls back to the plain default', async (t) => {
  const { engine, bot } = await fixture(t);
  engine.agent = { run: async () => ({ status: 'finished' }) , models: async () => CATALOG };
  const model = await engine.turnModel({ ...bot, effort: 'ultra' }, undefined);
  assert.equal(model.providerId, 'minimax');
  assert.equal(model.modelId, 'MiniMax-M3');
});

test('the catalog entry exposes the efforts the settings UI offers', () => {
  const entry = CATALOG.models.find((m) => m.providerId === 'minimax');
  assert.deepEqual(effortOptions(entry), ['low', 'medium', 'high', 'off']);
  const plain = CATALOG.models.find((m) => m.providerId === 'deepseek');
  assert.deepEqual(effortOptions(plain), []);
  // 'off' is only offered because the model lists the '' variant.
  assert.deepEqual(withEffort(entry, 'off'), {
    providerId: 'minimax',
    modelId: 'MiniMax-M3',
    variant: '',
  });
});

test('a Bot that names its own model ignores the catalog default', async (t) => {
  const { engine, bot } = await fixture(t);
  engine.agent = { run: async () => ({ status: 'finished' }) , models: async () => CATALOG };
  const own = { providerId: 'openai', modelId: 'gpt-4o' };
  const model = await engine.turnModel({ ...bot, model: own, effort: 'high' }, undefined);
  assert.deepEqual(model, own);
});
