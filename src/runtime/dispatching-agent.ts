// @ts-check
/**
 * The dispatching agent client.
 *
 * The upstream engine holds **one** agent client and calls it for every Bot,
 * every chat and every helper. The upstream `MiniAppAgentClient` contract has
 * no room for the caller's identity, yet the MiniBots tools must run with the
 * real caller's authority — a model must not gain another Bot's powers by
 * naming it in its arguments.
 *
 * The identity therefore travels out of band: the backend sets it on the
 * surrounding async context before it calls into the engine, and this client
 * reads it back. The model never sees it, and the engine needed no change.
 *
 * `AsyncLocalStorage` is the mechanism: it survives the `await` boundaries
 * between the engine's admission, its turn and the adapter's prompt, and it
 * keeps concurrent turns apart.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import type { MappedEvent } from './event-mapper.ts';
import {
  AgentError,
  PiAdapter,
  type AgentRunResult,
  type ModelCatalog,
  type ModelSelection,
} from './pi-adapter.ts';

/** The identity the current run speaks with. */
export interface CallerIdentity {
  readonly botId: string;
  readonly chatId: string;
  readonly generation?: number;
  readonly workspace?: string;
}

/** The context carried alongside the current run. */
interface CallerContext {
  readonly identity: CallerIdentity;
}

const callerStorage = new AsyncLocalStorage<CallerContext>();

/**
 * Run `work` with the given caller identity in scope.
 *
 * Every call the work makes — directly or through awaits — sees the identity.
 */
export function withCaller<T>(identity: CallerIdentity, work: () => T): T {
  return callerStorage.run({ identity }, work);
}

/** The identity of the run in scope, when there is one. */
export function currentCaller(): CallerIdentity | undefined {
  return callerStorage.getStore()?.identity;
}

export interface DispatchingAgentOptions {
  readonly adapter: PiAdapter;
}

/**
 * The agent client the upstream engine is given.
 *
 * It satisfies the upstream `MiniAppAgentClient` contract exactly and adds
 * nothing to it: the identity comes from the async context, not from the
 * arguments.
 */
export class DispatchingAgent {
  readonly #adapter: PiAdapter;

  constructor(options: DispatchingAgentOptions) {
    this.#adapter = options.adapter;
  }

  /** Run one turn as the caller in scope. */
  async run(
    input: { text: string; sessionId?: string; model?: ModelSelection },
    options: { signal?: AbortSignal; onEvent?: (event: MappedEvent) => void } = {},
  ): Promise<AgentRunResult> {
    const identity = currentCaller();
    if (!identity) {
      throw new AgentError(
        'INVALID_ARGUMENTS',
        'A run needs the caller it speaks for.',
      );
    }
    return this.#adapter.run(input, {
      ...options,
      botId: identity.botId,
      chatId: identity.chatId,
      generation: identity.generation ?? 0,
      ...(identity.workspace ? { workspace: identity.workspace } : {}),
    });
  }

  /**
   * Answer a pending questionnaire.
   *
   * The answer is matched against the session that asked, so a Bot cannot
   * answer another Bot's question.
   */
  async answer(
    input: { sessionId: string; requestId: string; answers: readonly unknown[] },
    options: { signal?: AbortSignal; onEvent?: (event: MappedEvent) => void } = {},
  ): Promise<AgentRunResult> {
    const identity = currentCaller();
    const association = this.#adapter.sessions.get(input.sessionId);
    if (!association) {
      throw new AgentError('SESSION_NOT_FOUND', 'That session is gone.');
    }
    if (
      identity &&
      (association.botId !== identity.botId || association.chatId !== identity.chatId)
    ) {
      throw new AgentError('NOT_PERMITTED', 'That question belongs to another chat.');
    }
    return this.#adapter.answer(input, options);
  }

  /** Decide a pending permission request. */
  async reply(input: {
    sessionId: string;
    requestId: string;
    decision: 'allowOnce' | 'deny';
  }): Promise<void> {
    const identity = currentCaller();
    const association = this.#adapter.sessions.get(input.sessionId);
    if (!association) {
      throw new AgentError('SESSION_NOT_FOUND', 'That session is gone.');
    }
    if (
      identity &&
      (association.botId !== identity.botId || association.chatId !== identity.chatId)
    ) {
      throw new AgentError('NOT_PERMITTED', 'That request belongs to another chat.');
    }
    return this.#adapter.reply(input);
  }

  /** The models this Host offers. */
  async models(): Promise<ModelCatalog> {
    return this.#adapter.models();
  }
}
