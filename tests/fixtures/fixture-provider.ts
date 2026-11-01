// @ts-check
/**
 * A deterministic provider fixture.
 *
 * The upstream implementation plan calls for exactly this: "A deterministic
 * provider fixture can exercise malformed responses, retry, streaming, and tool
 * calls through the real Pi adapter; it must not replace live-provider
 * acceptance."
 *
 * It drives Pi's real agent loop — the real session manager, the real tool
 * execution, the real event stream — and only replaces the network call. That
 * is what makes it a test of the adapter rather than a mock of it.
 *
 * The API shape was read from Pi 1.4.0's own declarations:
 * - `createProvider` takes `{ id, name, auth, models, api }`.
 * - `auth.apiKey.resolve()` returns an `AuthResult`: `{ auth: { apiKey, headers? } }`.
 * - The `api` map is keyed by `model.api`; a model whose api has no entry
 *   produces a stream error, so the fixture declares both `stream` and
 *   `streamSimple` for the api it serves.
 */
import { createProvider, type AssistantMessageEventStream, type Model } from '@earendil-works/pi-ai';

/** One scripted turn: the text to stream and the tools to call. */
export interface ScriptedTurn {
  /** The visible text to stream. */
  readonly text?: string;
  /** The size of each streamed chunk. */
  readonly chunkSize?: number;
  /** Tool calls to make, in order. */
  readonly toolCalls?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }>;
  /** When set, the turn fails with this error instead of answering. */
  readonly error?: string;
  /**
   * How long the turn pauses before it finishes, in milliseconds.
   *
   * It exists so a test can abort a turn that is genuinely in flight rather
   * than one that has already finished.
   */
  readonly holdMs?: number;
}

/** A scripted conversation: the turns a session takes, in order. */
export type Script = readonly ScriptedTurn[];

/** The model the fixture provider serves. */
export const FIXTURE_MODEL_ID = 'fixture-model';
export const FIXTURE_PROVIDER_ID = 'minibots-fixture';

/** The api the fixture model declares. */
const FIXTURE_API = 'openai-completions';

/** Build the fixture model definition. */
export function createFixtureModel(): Model<'openai-completions'> {
  return {
    id: FIXTURE_MODEL_ID,
    name: 'MiniBots fixture model',
    api: FIXTURE_API,
    provider: FIXTURE_PROVIDER_ID,
    reasoning: false,
    contextWindow: 128000,
    maxTokens: 8192,
  } as unknown as Model<'openai-completions'>;
}

/**
 * Build a provider that answers with `script`.
 *
 * Each provider instance serves one session, so the turns are consumed in
 * order and the last turn repeats once the script runs out.
 */
export function createFixtureProvider(script: Script): {
  provider: ReturnType<typeof createProvider<'openai-completions'>>;
  /** The prompts this provider received, for assertions. */
  readonly prompts: string[];
  /** The full context of every call, for assertions about conversation history. */
  readonly contexts: Array<{ messages?: Array<{ role?: string; content?: unknown }> }>;
  /** The model this provider serves. */
  readonly model: Model<'openai-completions'>;
} {
  const prompts: string[] = [];
  const contexts: Array<{ messages?: Array<{ role?: string; content?: unknown }> }> = [];

  const provider = createProvider<'openai-completions'>({
    id: FIXTURE_PROVIDER_ID,
    name: 'MiniBots fixture',
    auth: {
      apiKey: {
        name: 'Fixture key',
        // `resolve` returns an AuthResult: `{ auth: { apiKey, headers? } }`.
        async resolve() {
          return { auth: { apiKey: 'fixture-key', headers: {} } };
        },
      },
    },
    models: [createFixtureModel()],
    api: {
      // Pi calls `streamSimple` for a plain chat turn, and `stream` when it
      // wants the raw event protocol. Both are wired to the same script.
      //
      // The provider's `api` map is typed on the wide `Api` union, so the
      // model arrives as `Model<Api>`; the fixture serves one api only, and
      // the script does not read the model.
      stream(model, context, options) {
        return scriptedStream(script, prompts, contexts, context, options);
      },
      streamSimple(model, context, options) {
        return scriptedStream(script, prompts, contexts, context, options);
      },    },
  });

  return { provider, prompts, contexts, model: createFixtureModel() };
}

/** Record the prompt and produce the scripted stream for one turn. */
function scriptedStream(
  script: Script,
  prompts: string[],
  contexts: Array<{ messages?: Array<{ role?: string; content?: unknown }> }>,
  context: { messages?: Array<{ role?: string; content?: unknown }> },
  options?: { signal?: AbortSignal },
): AssistantMessageEventStream {
  contexts.push(context);
  const messages = context.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    prompts.push(textOf(message.content));
    break;
  }
  const scripted = script[Math.min(prompts.length - 1, script.length - 1)] ?? { text: '' };
  return streamTurn(scripted, options?.signal);
}

/** Build an event stream for one scripted turn. */
function streamTurn(scripted: ScriptedTurn, signal?: AbortSignal): AssistantMessageEventStream {
  const chunkSize = scripted.chunkSize ?? 8;
  const text = scripted.text ?? '';
  const toolCalls = scripted.toolCalls ?? [];

  const partial = {
    role: 'assistant',
    content: [],
    api: FIXTURE_API,
    provider: FIXTURE_PROVIDER_ID,
    model: FIXTURE_MODEL_ID,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };

  const stream = {
    [Symbol.asyncIterator]: async function* asyncIterator() {
      if (signal?.aborted) throw new Error('Request was aborted');

      // The hold lets a test abort a turn that is genuinely in flight.
      if (scripted.holdMs) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, scripted.holdMs);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
        // A real provider fails the request when it is aborted; the fixture
        // does the same, so Pi sees the same shape it sees in production.
        if (signal?.aborted) throw new Error('Request was aborted');
      }

      yield { type: 'start', partial };

      if (text) {
        yield { type: 'text_start', contentIndex: 0, partial };
        for (let at = 0; at < text.length; at += chunkSize) {
          if (signal?.aborted) return;
          yield { type: 'text_delta', contentIndex: 0, delta: text.slice(at, at + chunkSize), partial };
        }
        yield { type: 'text_end', contentIndex: 0, content: text, partial };
      }

      let contentIndex = text ? 1 : 0;
      for (const call of toolCalls) {
        yield {
          type: 'toolcall_start',
          contentIndex,
          id: call.id,
          name: call.name,
          arguments: '',
          partial,
        };
        yield {
          type: 'toolcall_delta',
          contentIndex,
          id: call.id,
          name: call.name,
          argumentsDelta: JSON.stringify(call.arguments),
          partial,
        };
        yield {
          type: 'toolcall_end',
          contentIndex,
          id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
          partial,
        };
        contentIndex += 1;
      }

      if (scripted.error) {
        yield {
          type: 'error',
          error: new Error(scripted.error),
        };
        return;
      }

      yield { type: 'done', reason: 'stop', message: {
        ...partial,
        content: [
          ...(text ? [{ type: 'text', text }] : []),
          ...toolCalls.map((call) => ({
            type: 'toolCall',
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          })),
        ],
      } };
    },
  } as unknown as AssistantMessageEventStream;

  return stream;
}

/** The visible text of a user message. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const record = block as { type?: string; text?: string };
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text);
  }
  return parts.join('');
}
