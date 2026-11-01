// @ts-check
/**
 * The durable session index.
 *
 * The adapter's `SessionRegistry` lives in memory. A Pi session file only
 * exists once the session has content, so the app cannot rediscover which Pi
 * session belongs to which chat by looking at the filesystem — the
 * association has to be written down.
 *
 * This module is that written-down association. It is loaded when the backend
 * starts, so a chat that was talking to a model before the app closed talks
 * to the **same** Pi session afterwards, with its history intact.
 */
import { AtomicJsonFile } from '../storage/atomic-json.ts';
import type { SessionAssociation } from './session-registry.ts';

/** The session index document, as it is written. */
interface SessionIndexDocument {
  readonly version: 1;
  readonly sessions: readonly SessionAssociation[];
}

export interface SessionIndexOptions {
  /** Where the index is stored. */
  readonly path: string;
}

/**
 * The durable session index.
 *
 * One instance per backend process; it owns the file.
 */
export class SessionIndex {
  readonly #file: AtomicJsonFile<SessionIndexDocument>;

  constructor(options: SessionIndexOptions) {
    this.#file = new AtomicJsonFile<SessionIndexDocument>(options.path);
  }

  /** Read the stored associations. */
  async load(): Promise<SessionAssociation[]> {
    const document = await this.#file.read({ version: 1, sessions: [] });
    return (document.sessions ?? []).filter(
      (record): record is SessionAssociation =>
        Boolean(record) && typeof record.id === 'string' && typeof record.botId === 'string',
    );
  }

  /** Write the associations. */
  async save(sessions: readonly SessionAssociation[]): Promise<void> {
    await this.#file.write({ version: 1, sessions: [...sessions] });
  }
}
