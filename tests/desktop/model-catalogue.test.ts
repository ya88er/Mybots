// @ts-check
/**
 * The model catalogue the app offers.
 *
 * The catalogue is what the settings page lists and what the engine's model
 * picker reads. It is built from Pi's providers, and the way Pi exposes them
 * is easy to get wrong:
 *
 * - `getRegisteredProviderIds()` lists the providers an **extension** added
 *   at runtime. Pi's built-in providers — DeepSeek, MiniMax, OpenAI — are
 *   **not** in that list.
 * - `getProviders()` is the whole catalogue, built-ins included.
 *
 * Iterating the registered ids would offer **no model at all**, even with a
 * working key, and the failure would be silent: the settings page would just
 * be empty. This test pins the difference.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';

/** A runtime with no network and no credentials. */
async function runtime() {
  return ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
}

test('the built-in providers are not the registered ones', async () => {
  const r = await runtime();
  const registered = r.getRegisteredProviderIds();
  const builtins = r.getProviders().map((provider) => provider.id);

  assert.equal(
    registered.length,
    0,
    'no extension provider is registered in a bare runtime',
  );
  assert.ok(
    builtins.length > 20,
    `the built-in catalogue is large, got ${builtins.length}`,
  );
});

test('the providers the app names are all in the built-in catalogue', async () => {
  const r = await runtime();
  const ids = new Set(r.getProviders().map((provider) => provider.id));
  for (const id of ['deepseek', 'minimax', 'minimax-cn', 'openai']) {
    assert.ok(ids.has(id), `${id} is offered by Pi`);
  }
});

test('each of the providers the app names has models', async () => {
  const r = await runtime();
  for (const id of ['deepseek', 'minimax', 'minimax-cn', 'openai']) {
    const models = r.getModels(id);
    assert.ok(models.length > 0, `${id} offers at least one model`);
    for (const model of models) {
      assert.equal(typeof model.id, 'string');
      assert.ok(model.id.length > 0, `${id} has a model with an id`);
    }
  }
});

test('a provider can be marked as configured with a key', async () => {
  const r = await runtime();
  assert.equal(
    r.hasConfiguredAuth('deepseek'),
    false,
    'a provider with no key is not configured',
  );
  await r.setRuntimeApiKey('deepseek', 'sk-not-a-real-key');
  assert.equal(
    r.hasConfiguredAuth('deepseek'),
    true,
    'a provider with a key is configured',
  );
});

test('a configured provider\'s models are reachable', async () => {
  const r = await runtime();
  await r.setRuntimeApiKey('deepseek', 'sk-not-a-real-key');
  const models = r.getModels('deepseek');
  assert.ok(models.length > 0, 'the models are still there after the key is set');
  const first = models[0];
  assert.ok(first, 'a model exists');
  assert.equal(
    r.getModel('deepseek', first.id)?.id,
    first.id,
    'the model can be looked up by its id',
  );
});
