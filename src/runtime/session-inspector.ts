// @ts-check
/**
 * The session inspector.
 *
 * The user can ask what the app is doing: which chats exist, which Pi
 * session each one is bound to, and what the app knows about it.
 *
 * It reads the adapter's own index, so it shows the **truth** about the
 * sessions rather than what the UI remembers.
 */
import type { SessionRegistry, SessionAssociation } from './session-registry.ts';

/** What the inspector reports about one application session. */
export interface SessionReport {
  readonly sessionId: string;
  readonly botId: string;
  readonly chatId: string;
  readonly generation: number;
  /** The Pi session id, when a Pi session exists. */
  readonly piSessionId?: string;
  /** The Pi session file, when the session has content. */
  readonly piSessionFile?: string;
  /** The workspace the session runs in. */
  readonly workspace: string;
  /** The model the session was admitted with. */
  readonly providerId?: string;
  readonly modelId?: string;
  readonly variant?: string;
  readonly effort?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** The whole report. */
export interface SessionInspectorReport {
  readonly sessions: readonly SessionReport[];
  /** How many sessions exist in total. */
  readonly count: number;
}

/**
 * Build the report.
 *
 * The association is the app's own record, so it is the only source that
 * knows which Pi session belongs to which chat.
 */
export function inspectSessions(sessions: SessionRegistry): SessionInspectorReport {
  const all = sessions.all();
  return {
    sessions: all.map(toReport),
    count: all.length,
  };
}

/** One association, as the inspector reports it. */
function toReport(association: SessionAssociation): SessionReport {
  return {
    sessionId: association.id,
    botId: association.botId,
    chatId: association.chatId,
    generation: association.generation,
    ...(association.piSessionId ? { piSessionId: association.piSessionId } : {}),
    ...(association.piSessionFile ? { piSessionFile: association.piSessionFile } : {}),
    workspace: association.workspace,
    ...(association.providerId ? { providerId: association.providerId } : {}),
    ...(association.modelId ? { modelId: association.modelId } : {}),
    ...(association.variant !== undefined ? { variant: association.variant } : {}),
    ...(association.effort ? { effort: association.effort } : {}),
    createdAt: association.createdAt,
    updatedAt: association.updatedAt,
  };
}
