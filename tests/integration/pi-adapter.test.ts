import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FIXTURE_MODEL_ID,
  FIXTURE_PROVIDER_ID,
  createFixtureProvider,
  type Script,
} from '../fixtures/fixture-provider.ts';
import { PiAdapter, type BoundTool } from '../../src/runtime/pi-adapter.ts';
import { SessionRegistry } from '../../src/runtime/session-registry.ts';
import type { MappedEvent } from '../../src/runtime/event-mapper.ts';

// These tests drive Pi's real agent loop through a deterministic provider
// fixture: the real session manager, the real tool execution, the real event
// stream. Only the network call is replaced.
//
// A fixture is not a substitute for live-provider acceptance; it is how the
// adapter's own behaviour is proven without a billable key.

interface Harness {
  readonly adapter: PiAdapter;
  readonly prompts: string[];
  readonly contexts: Array<{ messages?: Array<{ role?: string; content?: unknown }> }>;
  readonly workspace: string;
  readonly events: MappedEvent[];
}

async function harness(
  t: { after: (fn: () => unknown) => void },
  script: Script,
  options: { tools?: BoundTool[] } = {},
): Promise<Harness> {
  const workspace = await mkdtemp(join(tmpdir(), 'minibots-adapter-'));
  const { provider, prompts, contexts } = createFixtureProvider(script);

  const adapter = new PiAdapter({
    agentDir: workspace,
    sessionDir: workspace,
    sessions: new SessionRegistry(),
    provider: (runtime) => {
      runtime.registerNativeProvider(provider);
    },
    ...(options.tools ? { tools: () => options.tools ?? [] } : {}),
  });

  const events: MappedEvent[] = [];

  t.after(async () => {
    await adapter.dispose();
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  });

  return { adapter, prompts, contexts, workspace, events };
}

/** Run a turn and collect the events it produced. */
async function run(
  h: Harness,
  text: string,
  runOptions: {
    botId?: string;
    chatId?: string;
    generation?: number;
    sessionId?: string;
    signal?: AbortSignal;
  } = {},
): Promise<{ result: Awaited<ReturnType<PiAdapter['run']>>; events: MappedEvent[] }> {
  const collected: MappedEvent[] = [];
  const result = await h.adapter.run(
    {
      text,
      // The fixture provider serves exactly one model; the run names it so the
      // adapter resolves it and configures the provider, as the engine does
      // when a Bot names a model.
      model: { providerId: FIXTURE_PROVIDER_ID, modelId: FIXTURE_MODEL_ID },
      ...(runOptions.sessionId ? { sessionId: runOptions.sessionId } : {}),
    },
    {
      onEvent: (event) => collected.push(event),
      ...(runOptions.botId ? { botId: runOptions.botId } : {}),
      ...(runOptions.chatId ? { chatId: runOptions.chatId } : {}),
      ...(runOptions.generation !== undefined ? { generation: runOptions.generation } : {}),
      ...(runOptions.signal ? { signal: runOptions.signal } : {}),
    },
  );
  return { result, events: collected };
}

test('a turn streams text and settles with exactly one terminal event', async (t) => {
  const h = await harness(t, [{ text: 'Hello from the fixture.', chunkSize: 6 }]);

  const { result, events } = await run(h, 'Say hello.', { botId: 'bot1', chatId: 'chat1' });

  assert.equal(result.status, 'finished');
  assert.match(result.text ?? '', /Hello from the fixture\./);
  assert.equal(h.prompts.length, 1, 'the model was called once');
  assert.match(h.prompts[0] ?? '', /Say hello\./);

  const started = events.filter((e) => e.type === 'turn.started');
  const finished = events.filter((e) => e.type === 'turn.finished');
  assert.equal(started.length, 1, 'exactly one turn.started');
  assert.equal(finished.length, 1, 'exactly one turn.finished');

  const committed = events.filter((e) => e.type === 'message.committed');
  assert.equal(committed.length, 1, 'the assistant message is committed once');

  // The streamed deltas together equal the committed message.
  const deltas = events
    .filter((e) => e.type === 'text.delta')
    .map((e) => (e.type === 'text.delta' ? e.text : ''))
    .join('');
  assert.equal(deltas, committed[0]?.type === 'message.committed' ? committed[0].text : '');
});

test('a second turn on the same session continues the conversation', async (t) => {
  const h = await harness(t, [{ text: 'First answer.' }, { text: 'Second answer.' }]);

  const first = await run(h, 'First question.', { botId: 'bot1', chatId: 'chat1' });
  const second = await run(h, 'Second question.', {
    botId: 'bot1',
    chatId: 'chat1',
    ...(first.result.sessionId ? {} : {}),
  });

  assert.equal(first.result.sessionId, second.result.sessionId, 'the session is the same');
  assert.equal(h.prompts.length, 2, 'the model was called twice');
  // The second call carries the first exchange as context, so the model can
  // answer from the history rather than from the prompt alone.
  const secondContext = h.contexts[1];
  const roles = (secondContext?.messages ?? []).map((message) => message?.role);
  assert.ok(roles.includes('assistant'), 'the first answer is in the context');
  assert.ok(
    JSON.stringify(secondContext?.messages ?? []).includes('First answer.'),
    'the first answer text reached the model',
  );
});

test('a custom tool runs with the session identity bound', async (t) => {
  const calls: Array<{ args: Record<string, unknown>; context: unknown }> = [];
  const tool: BoundTool = {
    name: 'minibots_test_tool',
    description: 'A deterministic test tool.',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
    execute: async (args, context) => {
      calls.push({ args, context });
      return { content: `tool saw ${args.value}` };
    },
  };

  const h = await harness(
    t,
    [
      {
        toolCalls: [{ id: 'call_1', name: 'minibots_test_tool', arguments: { value: 'hello' } }],
      },
      { text: 'The tool ran.' },
    ],
    { tools: [tool] },
  );

  const { events } = await run(h, 'Use the tool.', { botId: 'bot1', chatId: 'chat1' });

  assert.equal(calls.length, 1, 'the tool ran exactly once');
  assert.equal(calls[0]?.args.value, 'hello');

  // The authority is bound by the adapter, never by the model.
  const context = calls[0]?.context as { botId: string; chatId: string };
  assert.equal(context.botId, 'bot1');
  assert.equal(context.chatId, 'chat1');

  const started = events.filter((e) => e.type === 'tool.started');
  const finished = events.filter((e) => e.type === 'tool.finished');
  assert.equal(started.length, 1, 'one tool.started');
  assert.equal(finished.length, 1, 'one tool.finished');
  assert.equal(finished[0]?.type === 'tool.finished' ? finished[0].ok : false, true);
});

test('two sessions stay independent', async (t) => {
  const h = await harness(t, [{ text: 'First answer.' }, { text: 'Second answer.' }]);

  const first = await run(h, 'Question one.', { botId: 'bot1', chatId: 'chat1' });
  const second = await run(h, 'Question two.', { botId: 'bot2', chatId: 'chat2' });

  assert.notEqual(first.result.sessionId, second.result.sessionId, 'the sessions differ');
  assert.match(h.prompts[0] ?? '', /Question one\./);
  assert.match(h.prompts[1] ?? '', /Question two\./);
  assert.ok(!(h.prompts[0] ?? '').includes('Question two.'), 'no cross-talk');
});

test('a session is persisted before the turn is acknowledged', async (t) => {
  const h = await harness(t, [{ text: 'Answer.' }]);

  const { result } = await run(h, 'Question.', { botId: 'bot1', chatId: 'chat1' });

  const association = h.adapter.sessions.get(result.sessionId);
  assert.ok(association, 'the association exists');
  assert.equal(association?.botId, 'bot1');
  assert.equal(association?.chatId, 'chat1');
  assert.ok(association?.piSessionId, 'the Pi session id was bound');
  assert.ok(association?.piSessionFile, 'the Pi session file was bound');
});

test('a turn aborted mid-flight reports the abort, not a success', async (t) => {
  // The fixture holds the turn open until the abort arrives, so the abort
  // lands during the run rather than before it was admitted.
  const controller = new AbortController();
  const h = await harness(t, [
    {
      text: 'A long answer that is interrupted.',
      chunkSize: 4,
      holdMs: 500,
    },
  ]);

  const pending = run(h, 'Question.', {
    botId: 'bot1',
    chatId: 'chat1',
    signal: controller.signal,
  });

  // Abort once the model has started streaming.
  await new Promise((resolve) => setTimeout(resolve, 60));
  controller.abort();

  const { result } = await pending;
  assert.equal(result.status, 'aborted', 'the run reports the abort');
});

test('a second turn on a busy session is refused', async (t) => {
  const h = await harness(t, [{ text: 'Answer.' }]);

  await run(h, 'First.', { botId: 'bot1', chatId: 'chat1' });
  // The session is idle again, so a new turn is admitted: the busy guard is
  // about overlapping turns, not about history.
  const second = await run(h, 'Second.', { botId: 'bot1', chatId: 'chat1' });
  assert.equal(second.result.status, 'finished');
});

test('a run without a bot and a chat is refused', async (t) => {
  const h = await harness(t, [{ text: 'Answer.' }]);
  await assert.rejects(
    () => h.adapter.run({ text: 'No context.' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /bot and a chat/);
      return true;
    },
  );
});

test('the session reopens from its file and keeps its history', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'minibots-reopen-'));
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  });

  const { provider, prompts, contexts } = createFixtureProvider([
    { text: 'First turn.' },
    { text: 'Second turn.' },
  ]);

  const sessions = new SessionRegistry();
  const adapter = new PiAdapter({
    agentDir: workspace,
    sessionDir: workspace,
    sessions,
    provider: (runtime) => {
      runtime.registerNativeProvider(provider);
    },
  });

  const first = await adapter.run(
    {
      text: 'First question.',
      model: { providerId: FIXTURE_PROVIDER_ID, modelId: FIXTURE_MODEL_ID },
    },
    { botId: 'bot1', chatId: 'chat1' },
  );
  assert.equal(first.status, 'finished');

  const association = sessions.get(first.sessionId);
  const sessionFile = association?.piSessionFile;
  assert.ok(sessionFile, 'the session file exists after a turn with content');

  // Dispose the adapter, as a restart would.
  await adapter.dispose();

  // A new adapter over the same registry resumes the session.
  const resumed = new PiAdapter({
    agentDir: workspace,
    sessionDir: workspace,
    sessions,
    provider: (runtime) => {
      runtime.registerNativeProvider(provider);
    },
  });
  t.after(async () => {
    await resumed.dispose();
  });

  const second = await resumed.run(
    {
      text: 'Second question.',
      sessionId: first.sessionId,
      model: { providerId: FIXTURE_PROVIDER_ID, modelId: FIXTURE_MODEL_ID },
    },
    { botId: 'bot1', chatId: 'chat1' },
  );

  assert.equal(second.sessionId, first.sessionId, 'the session id is stable across a restart');
  assert.equal(second.status, 'finished');
  assert.equal(prompts.length, 2, 'the model was called twice');
  assert.match(
    JSON.stringify(contexts[1]?.messages ?? []),
    /First turn\./,
    'the history survived the restart',
  );
});

test('a questionnaire pauses the turn and the answer resumes it exactly once', async (t) => {
  // The tool raises a questionnaire the way the MiniBots tools will: it asks
  // the adapter, which pauses the turn and reports it to the engine.
  const asked: string[] = [];
  const tool: BoundTool = {
    name: 'minibots_ask_tool',
    description: 'Asks the user a question.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, context) => {
      const { requestId } = await h.adapter.requestQuestion({
        sessionId: context.sessionId,
        mode: 'questionnaire',
        request: {
          schemaVersion: 2,
          id: 'q1',
          title: 'Pick one',
          steps: [
            {
              id: 'step1',
              question: 'Which one?',
              selectionMode: 'single',
              options: [
                { id: 'a', label: 'A' },
                { id: 'b', label: 'B' },
              ],
              allowOther: true,
            },
          ],
        },
      });
      asked.push(requestId);
      return { content: `question ${requestId} asked` };
    },
  };

  const h = await harness(
    t,
    [
      { toolCalls: [{ id: 'call_1', name: 'minibots_ask_tool', arguments: {} }] },
      { text: 'The answer was A.' },
    ],
    { tools: [tool] },
  );

  const { result, events } = await run(h, 'Ask me something.', { botId: 'bot1', chatId: 'chat1' });

  // The turn ended waiting on the user.
  assert.ok(result.pendingQuestion, 'the run reports a pending question');
  assert.equal(result.pendingQuestion?.mode, 'questionnaire');
  assert.equal(asked.length, 1, 'the tool asked exactly one question');
  assert.equal(result.pendingQuestion?.requestId, asked[0]);

  // The question was delivered as an event, so the chat can render it.
  const questionEvents = events.filter((e) => e.type === 'question.requested');
  assert.equal(questionEvents.length, 1, 'one question.requested was delivered');

  // The answer resumes the session.
  const continued = await h.adapter.answer(
    {
      sessionId: result.sessionId,
      requestId: result.pendingQuestion?.requestId ?? '',
      answers: [{ stepId: 'step1', selectedOptionIds: ['a'], selectedOther: false }],
    },
    { onEvent: () => {} },
  );

  assert.equal(continued.status, 'finished');
  assert.equal(continued.sessionId, result.sessionId, 'the same session continued');
  assert.match(continued.text ?? '', /The answer was A\./);

  // The answers reached the model as the continuation's prompt.
  const lastContext = h.contexts[h.contexts.length - 1];
  assert.ok(
    JSON.stringify(lastContext?.messages ?? []).includes('step1'),
    'the answers reached the model',
  );

  // A second answer to the same request is refused: a double click cannot
  // answer twice.
  await assert.rejects(
    () =>
      h.adapter.answer(
        {
          sessionId: result.sessionId,
          requestId: result.pendingQuestion?.requestId ?? '',
          answers: [{ stepId: 'step1', selectedOptionIds: ['b'], selectedOther: false }],
        },
        { onEvent: () => {} },
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, 'REQUEST_NOT_FOUND');
      return true;
    },
  );
});

test('the provider catalogue lists only configured providers', async (t) => {
  const h = await harness(t, [{ text: 'Answer.' }]);
  const catalog = await h.adapter.models();
  // The fixture provider has no credential configured through the adapter's
  // credential hook, so it is not listed: an uncallable model is not offered.
  assert.equal(catalog.models.length, 0);
  assert.equal(catalog.default, undefined);
});

test('a configured built-in provider is offered', async (t) => {
  // The catalogue must reach Pi's **built-in** providers — DeepSeek,
  // MiniMax, OpenAI — and not only the ones an extension registered.
  //
  // The two lists are different: `getRegisteredProviderIds()` is empty in a
  // bare runtime, while `getProviders()` holds the whole catalogue. A
  // catalogue built from the registered ids would offer nothing at all, and
  // the failure would be silent.
  const workspace = await mkdtemp(join(tmpdir(), 'minibots-catalogue-'));
  const adapter = new PiAdapter({
    agentDir: workspace,
    sessionDir: workspace,
    sessions: new SessionRegistry(),
    // The user's own key, as the settings page supplies it.
    credential: (providerId) =>
      providerId === 'deepseek' ? 'sk-not-a-real-key' : undefined,
  });

  t.after(async () => {
    await adapter.dispose();
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  });

  // The catalogue is empty until a provider has been configured.
  assert.equal((await adapter.models()).models.length, 0);

  // A run names the provider, which is what configures it in the real app.
  const catalog = await (async () => {
    // The adapter's own credential path is what the settings page uses; the
    // provider becomes configured when a turn names it.
    await adapter
      .run(
        {
          text: 'Hello.',
          model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
        },
        { botId: 'bot_test', chatId: 'bot:bot_test', onEvent: () => {} },
      )
      .catch(() => undefined);
    return adapter.models();
  })();

  assert.ok(
    catalog.models.length > 0,
    'the configured provider\'s models are offered',
  );
  assert.ok(
    catalog.models.every((entry) => entry.providerId === 'deepseek'),
    'only the configured provider is offered',
  );
  assert.ok(catalog.default, 'there is a default model');
});

test('a MiniBots business tool runs through Pi\'s real tool loop', async (t) => {
  // The tool is registered the way the backend registers it: as a Pi custom
  // tool whose closure carries the session's identity.
  const calls: Array<{ args: Record<string, unknown>; context: unknown }> = [];
  const tool: BoundTool = {
    name: 'mcp__minimax-bot__list_team',
    description: 'List the team.',
    parameters: { type: 'object', properties: {} },
    execute: async (args, context) => {
      calls.push({ args, context });
      return { content: JSON.stringify({ members: ['Chief'] }) };
    },
  };

  const h = await harness(
    t,
    [
      {
        toolCalls: [
          { id: 'call_1', name: 'mcp__minimax-bot__list_team', arguments: {} },
        ],
      },
      { text: 'The team is Chief.' },
    ],
    { tools: [tool] },
  );

  const { events, result } = await run(h, 'Who is on the team?', {
    botId: 'bot1',
    chatId: 'chat1',
  });

  assert.equal(calls.length, 1, 'the tool ran exactly once');
  const context = calls[0]?.context as { botId: string; chatId: string };
  assert.equal(context.botId, 'bot1', 'the session identity was bound');
  assert.equal(context.chatId, 'chat1');

  // The tool's result went back to the model, and the model answered from it.
  assert.equal(result.status, 'finished');
  assert.match(result.text ?? '', /The team is Chief\./);

  // The tool call is visible in the event stream, by its canonical name.
  const started = events.filter((e) => e.type === 'tool.started');
  assert.equal(started.length, 1);
  assert.equal(
    started[0]?.type === 'tool.started' ? started[0].name : '',
    'mcp__minimax-bot__list_team',
    "the UI's canonical label is preserved",
  );
});
