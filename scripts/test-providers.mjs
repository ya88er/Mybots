// @ts-check
/**
 * The live provider test.
 *
 * This is the **opt-in** check that drives a real provider with a real file
 * task. It is not part of `npm test`, because it costs the user money and
 * needs a key the app — not the chat — holds.
 *
 * The rules this script keeps:
 *
 * - a provider with no key is reported as **UNTESTED**, with the reason. It
 *   is never reported as a pass, and it never fails the run;
 * - a provider with a key is exercised for real: the model is asked to write
 *   a file, and the file is checked afterwards;
 * - the key comes from the **environment**, so it never appears in the
 *   transcript, in the report, or in a chat.
 *
 * The key is read from `MINIBOTS_<PROVIDER>_API_KEY`:
 *
 *   MINIBOTS_DEEPSEEK_API_KEY   for `deepseek`
 *   MINIBOTS_MINIMAX_API_KEY    for `minimax`
 *   MINIBOTS_OPENAI_API_KEY     for `openai`
 *
 * Run:  npm run test:providers
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';

import { PiAdapter } from '../src/runtime/pi-adapter.ts';
import { SessionRegistry } from '../src/runtime/session-registry.ts';

/** The providers the app offers, and the environment variable each one uses. */
const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', env: 'MINIBOTS_DEEPSEEK_API_KEY', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  { id: 'minimax', name: 'MiniMax (international)', env: 'MINIBOTS_MINIMAX_API_KEY', apiKeyEnv: 'MINIMAX_API_KEY' },
  { id: 'minimax-cn', name: 'MiniMax (China)', env: 'MINIBOTS_MINIMAX_CN_API_KEY', apiKeyEnv: 'MINIMAX_CN_API_KEY' },
  { id: 'openai', name: 'OpenAI', env: 'MINIBOTS_OPENAI_API_KEY', apiKeyEnv: 'OPENAI_API_KEY' },
];

/**
 * The task the model is given.
 *
 * It is a **real** file task: the model has to write a file, with real
 * content, on the disk. A provider that answers with prose instead of
 * calling the tool has not passed.
 */
const TASK_FILE = 'minibots-provider-check.txt';
const TASK_CONTENT = 'MiniBots provider check: the provider wrote this file.';

/** The outcome of one provider's test. */
const results = [];

/**
 * Run one provider's test.
 *
 * @param {{ id: string; name: string; env: string; apiKeyEnv: string }} provider
 */
async function testProvider(provider) {
  const key = process.env[provider.env] ?? process.env[provider.apiKeyEnv];
  if (!key) {
    results.push({
      id: provider.id,
      name: provider.name,
      status: 'UNTESTED',
      detail: `no key is configured (set ${provider.env})`,
    });
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'minibots-provider-'));
  try {
    const sessions = new SessionRegistry();
    const adapter = new PiAdapter({
      agentDir: join(root, 'agent'),
      sessionDir: join(root, 'sessions'),
      sessions,
      credential: () => key,
    });

    // The model is asked to write the file with the tool, not to describe how.
    const events = [];
    const run = await adapter.run(
      {
        text:
          `Write the file "${TASK_FILE}" in the current working directory with exactly this content: ` +
          `${TASK_CONTENT}\nUse the file-writing tool. Do not reply with the content instead of writing it.`,
      },
      { onEvent: (event) => events.push(event) },
    );

    if (run.status !== 'finished') {
      results.push({
        id: provider.id,
        name: provider.name,
        status: 'FAILED',
        detail: `the turn ended with status ${run.status}${run.error ? `: ${run.error.message}` : ''}`,
      });
      return;
    }

    // The file must exist with the right content. A provider that only
    // answered in prose has not passed.
    let content = '';
    try {
      content = await readFile(join(process.cwd(), TASK_FILE), 'utf8');
    } catch {
      results.push({
        id: provider.id,
        name: provider.name,
        status: 'FAILED',
        detail: 'the model did not write the file',
      });
      return;
    }

    const wrote = content.includes(TASK_CONTENT);
    results.push({
      id: provider.id,
      name: provider.name,
      status: wrote ? 'PASSED' : 'FAILED',
      detail: wrote
        ? 'the model wrote the file with the expected content'
        : `the file was written but its content was unexpected: ${content.slice(0, 120)}`,
    });
  } catch (error) {
    results.push({
      id: provider.id,
      name: provider.name,
      status: 'FAILED',
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    // The file the provider wrote is removed: the test must not leave
    // anything behind in the user's working directory.
    await rm(join(process.cwd(), TASK_FILE), { force: true }).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Check that Pi knows the provider at all.
 *
 * A provider that Pi does not offer cannot be tested, and saying so is more
 * useful than a network error.
 *
 * The check uses `getProviders()`, not `getRegisteredProviderIds()`: the
 * registered ids are the providers an extension added at runtime, and Pi's
 * built-in providers are not in that list.
 */
async function knownProviders() {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  return new Set(runtime.getProviders().map((provider) => provider.id));
}

// ---------------------------------------------------------------------------

const known = await knownProviders();

for (const provider of PROVIDERS) {
  if (!known.has(provider.id)) {
    results.push({
      id: provider.id,
      name: provider.name,
      status: 'UNTESTED',
      detail: `Pi 1.4.0 does not register the provider "${provider.id}"`,
    });
    continue;
  }
  await testProvider(provider);
}

// The report.
// ---------------------------------------------------------------------------

const width = Math.max(...results.map((result) => result.name.length));
console.log('');
console.log('MiniBots live provider report');
console.log('=============================');
console.log('');

let tested = 0;
let passed = 0;
for (const result of results) {
  console.log(`${result.name.padEnd(width)}  ${result.status.padEnd(9)}  ${result.detail}`);
  if (result.status === 'PASSED') {
    passed += 1;
    tested += 1;
  } else if (result.status === 'FAILED') {
    tested += 1;
  }
}

console.log('');
console.log(`${passed} passed, ${tested} tested, ${results.length - tested} untested`);

if (tested === 0) {
  console.log('');
  console.log(
    'UNTESTED: no provider key is configured on this machine. This is not a pass.',
  );
  console.log('The key is entered in the app\'s provider settings, never in chat.');
  process.exit(0);
}

process.exit(passed === tested ? 0 : 1);
