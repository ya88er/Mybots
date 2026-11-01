// @ts-check
/**
 * The per-chat agent client.
 *
 * The upstream engine talks to a `MiniAppAgentClient`, but its contract
 * carries no Bot or chat identity: `run({ text, sessionId, model })` says
 * nothing about *who* is speaking. The tools the model can call must be bound
 * to the real caller though, so the identity has to come from somewhere the
 * model cannot influence.
 *
 * This facade is that somewhere. The backend creates one per (chat, bot) and
 * hands it to the engine; the identity is captured in the closure, so the
 * model can neither see it nor change it. The shared `PiAdapter` underneath
 * stays the single owner of the Pi sessions.
 */
import type { MappedEvent } from './event-mapper.ts';
import {
  AgentError,
  PiAdapter,
  type AgentRunResult,
  type ModelCatalog,
  type ModelSelection,
} from './pi-adapter.ts';

export type { ModelCatalog, ModelCatalogEntry } from './pi-adapter.ts';

/** The identity a chat's agent client speaks with. */
export interface ChatIdentity {
  readonly botId: string;
  readonly chatId: string;
  /** The conversation generation; a cleared chat starts a new one. */
  readonly generation?: number;
  /** The workspace this chat's sessions run in. */
  readonly workspace?: string;
}

export interface ChatAgentOptions {
  readonly adapter: PiAdapter;
  readonly identity: ChatIdentity;
}

/**
 * The agent client the engine is given for one chat.
 *
 * It satisfies the upstream `MiniAppAgentClient` contract exactly, and adds
 * the identity that the contract has no room for.
 */
export class ChatAgentClient {
  readonly #adapter: PiAdapter;
  readonly #identity: ChatIdentity;

  constructor(options: ChatAgentOptions) {
    this.#adapter = options.adapter;
    this.#identity = options.identity;
  }

  /** The Bot this client speaks for. */
  get botId(): string {
    return this.#identity.botId;
  }

  /** The chat this client belongs to. */
  get chatId(): string {
    return this.#identity.chatId;
  }

  /**
   * Run one turn.
   *
   * The identity travels in the options, never in the input, so the engine
   * cannot choose whose authority the tools run with.
   */
  async run(
    input: { text: string; sessionId?: string; model?: ModelSelection },
    options: { signal?: AbortSignal; onEvent?: (event: MappedEvent) => void } = {},
  ): Promise<AgentRunResult> {
    return this.#adapter.run(input, {
      ...options,
      botId: this.#identity.botId,
      chatId: this.#identity.chatId,
      generation: this.#identity.generation ?? 0,
      ...(this.#identity.workspace ? { workspace: this.#identity.workspace } : {}),
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
    const association = this.#adapter.sessions.get(input.sessionId);
    if (!association) {
      throw new AgentError('SESSION_NOT_FOUND', 'That session is gone.');
    }
    if (association.botId !== this.#identity.botId || association.chatId !== this.#identity.chatId) {
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
    const association = this.#adapter.sessions.get(input.sessionId);
    if (!association) {
      throw new AgentError('SESSION_NOT_FOUND', 'That session is gone.');
    }
    if (association.botId !== this.#identity.botId || association.chatId !== this.#identity.chatId) {
      throw new AgentError('NOT_PERMITTED', 'That request belongs to another chat.');
    }
    return this.#adapter.reply(input);
  }

  /** The models this Host offers. */
  async models(): Promise<ModelCatalog> {
    return this.#adapter.models();
  }
}
