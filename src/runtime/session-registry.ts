// @ts-check
/**
 * Session ownership.
 *
 * The app owns the mapping from an application session to a Pi session. Pi
 * only writes a session file once the session has content, so an empty session
 * leaves nothing on disk and cannot be discovered later. The association is
 * therefore persisted here before a turn is acknowledged.
 *
 * A session is identified by (bot, chat, generation). The generation
 * increments when a chat is cleared, which is what stops a late completion
 * from the previous generation entering the new chat.
 */

export interface SessionAssociation {
  /** The application session id: bot, chat and generation. */
  readonly id: string;
  readonly botId: string;
  readonly chatId: string;
  /** Increments when the chat is cleared. */
  readonly generation: number;
  /** The Pi session id, once a session exists. */
  readonly piSessionId?: string;
  /** The Pi session file, once the session has content. */
  readonly piSessionFile?: string;
  /** The workspace this session runs in. */
  readonly workspace: string;
  /** The provider and model this session was admitted with. */
  readonly providerId?: string;
  readonly modelId?: string;
  readonly variant?: string;
  readonly effort?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Builds the stable application session id for a (bot, chat, generation). */
export function sessionIdFor(botId: string, chatId: string, generation: number): string {
  return `sess_${botId}__${chatId}__g${generation}`;
}

/**
 * The in-memory index over the persisted associations.
 *
 * One writer owns this: the backend process.
 */
export class SessionRegistry {
  /** @type {Map<string, SessionAssociation>} */
  readonly #byId = new Map();
  /** @type {Map<string, string>} bot+chat+generation -> session id */
  readonly #byKey = new Map();

  static keyOf(botId: string, chatId: string, generation: number): string {
    return `${botId}\u0000${chatId}\u0000${generation}`;
  }

  /** Load persisted associations. */
  load(records: readonly SessionAssociation[]): void {
    this.#byId.clear();
    this.#byKey.clear();
    for (const record of records) {
      this.#byId.set(record.id, record);
      this.#byKey.set(SessionRegistry.keyOf(record.botId, record.chatId, record.generation), record.id);
    }
  }

  /** Every known association, for persistence. */
  all(): SessionAssociation[] {
    return [...this.#byId.values()];
  }

  get(id: string): SessionAssociation | undefined {
    return this.#byId.get(id);
  }

  find(botId: string, chatId: string, generation: number): SessionAssociation | undefined {
    const id = this.#byKey.get(SessionRegistry.keyOf(botId, chatId, generation));
    return id ? this.#byId.get(id) : undefined;
  }

  /**
   * The association for this (bot, chat, generation), created on first use.
   */
  ensure(
    botId: string,
    chatId: string,
    generation: number,
    workspace: string,
  ): SessionAssociation {
    const existing = this.find(botId, chatId, generation);
    if (existing) return existing;
    const now = Date.now();
    const record: SessionAssociation = {
      id: sessionIdFor(botId, chatId, generation),
      botId,
      chatId,
      generation,
      workspace,
      createdAt: now,
      updatedAt: now,
    };
    this.#byId.set(record.id, record);
    this.#byKey.set(SessionRegistry.keyOf(botId, chatId, generation), record.id);
    return record;
  }

  /**
   * Record the Pi session this application session resolved to.
   *
   * Called once the session exists and before the turn is acknowledged, so a
   * crash after the turn started still leaves a recoverable association.
   */
  bindPiSession(
    id: string,
    piSessionId: string,
    piSessionFile: string | undefined,
    model?: { providerId: string; modelId: string; variant?: string; thinking?: { effort: string } },
  ): SessionAssociation {
    const current = this.#byId.get(id);
    if (!current) throw new Error(`unknown application session: ${id}`);
    const updated: SessionAssociation = {
      ...current,
      piSessionId,
      piSessionFile: piSessionFile ?? current.piSessionFile,
      providerId: model?.providerId ?? current.providerId,
      modelId: model?.modelId ?? current.modelId,
      variant: model?.variant ?? current.variant,
      effort: model?.thinking?.effort ?? current.effort,
      updatedAt: Date.now(),
    };
    this.#byId.set(id, updated);
    return updated;
  }

  /** Drop every association of a chat. Used when a chat is cleared. */
  dropChat(chatId: string): void {
    for (const [id, record] of [...this.#byId]) {
      if (record.chatId !== chatId) continue;
      this.#byId.delete(id);
      this.#byKey.delete(SessionRegistry.keyOf(record.botId, record.chatId, record.generation));
    }
  }
}
