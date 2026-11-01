// @ts-check
/**
 * The dispatch ledger.
 *
 * The upstream engine already keeps a durable record of what it dispatched:
 * the task batches, their children, and the `unknown` status that marks an
 * outcome nobody can vouch for. What it does not have is a place to say *why*
 * a record is in that state, or when the app last reconciled it.
 *
 * The ledger is that place. It is the app's own record of every dispatch the
 * engine admitted, and it exists so that:
 *
 * - a restart can tell an outcome that is *known* from one that is *unknown*,
 *   and never replay the second;
 * - the user can be told what the app is doing and why;
 * - an uncertain outcome is reported as uncertain, never as a success and
 *   never retried automatically.
 *
 * The ledger is written **before** the dispatch is admitted, and updated when
 * it settles. A crash between the two leaves a record whose state is
 * `admitted`, and the reconciliation marks it `unknown` rather than replaying
 * it.
 */
import { AtomicJsonFile } from '../storage/atomic-json.ts';

/** The state of one dispatched record. */
export type LedgerState =
  /** The dispatch was admitted; its outcome is not known yet. */
  | 'admitted'
  /** The dispatch finished normally. */
  | 'settled'
  /** The dispatch failed in a way that is known. */
  | 'failed'
  /** The dispatch was cancelled. */
  | 'cancelled'
  /** The dispatch may or may not have happened: the outcome is unknown. */
  | 'unknown';

/** One record in the ledger. */
export interface LedgerRecord {
  /** The record's own id. */
  readonly id: string;
  /** What was dispatched: the tool, the task or the schedule. */
  readonly kind: 'turn' | 'tool' | 'task' | 'schedule';
  /** The record's subject: a Bot id, a task id or a schedule id. */
  readonly subject: string;
  /** The chat the dispatch belongs to. */
  readonly chatId: string;
  /** The session the dispatch belongs to. */
  readonly sessionId?: string;
  /** The run the dispatch belongs to. */
  readonly runId?: string;
  /** The dispatch's own id, when the upstream gave one. */
  readonly externalId?: string;
  /** The dispatch's state. */
  readonly state: LedgerState;
  /** Why the dispatch ended the way it did. */
  readonly reason?: string;
  /** When the dispatch was admitted. */
  readonly admittedAt: number;
  /** When the dispatch settled. */
  readonly settledAt?: number;
}

/** The ledger document, as it is written. */
interface LedgerDocument {
  readonly version: 1;
  readonly records: readonly LedgerRecord[];
}

/** How many records are kept. */
const MAX_RECORDS = 500;

export interface LedgerOptions {
  /** Where the ledger is stored. */
  readonly path: string;
  /** Reports a failure to persist. */
  readonly log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

/**
 * The dispatch ledger.
 *
 * One instance per backend process. It owns the file.
 */
export class DispatchLedger {
  readonly #file: AtomicJsonFile<LedgerDocument>;
  readonly #log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
  /** @type {Map<string, LedgerRecord>} */
  readonly #records = new Map<string, LedgerRecord>();
  #loaded = false;

  constructor(options: LedgerOptions) {
    this.#file = new AtomicJsonFile<LedgerDocument>(options.path);
    this.#log = options.log ?? (() => {});
  }

  /** Load the ledger from disk. */
  async load(): Promise<void> {
    if (this.#loaded) return;
    const document = await this.#file.read({ version: 1, records: [] });
    for (const record of document.records ?? []) {
      if (!record || typeof record.id !== 'string') continue;
      this.#records.set(record.id, record);
    }
    this.#loaded = true;
  }

  /** Every record, oldest first. */
  all(): LedgerRecord[] {
    return [...this.#records.values()].sort((a, b) => a.admittedAt - b.admittedAt);
  }

  /** The records that are still unsettled. */
  unsettled(): LedgerRecord[] {
    return this.all().filter((record) => record.state === 'admitted');
  }

  /** One record by its id. */
  get(id: string): LedgerRecord | undefined {
    return this.#records.get(id);
  }

  /**
   * Record an admission.
   *
   * The record is written **before** the dispatch starts, so a crash after
   * the dispatch leaves evidence that something was attempted.
   */
  async admit(record: Omit<LedgerRecord, 'state' | 'admittedAt'> & { admittedAt?: number }): Promise<LedgerRecord> {
    await this.load();
    const entry: LedgerRecord = {
      ...record,
      state: 'admitted',
      admittedAt: record.admittedAt ?? Date.now(),
    };
    this.#records.set(entry.id, entry);
    await this.#persist();
    return entry;
  }

  /**
   * Record how a dispatch ended.
   *
   * A dispatch that was admitted but never settled is **unknown**, not a
   * success: the app may have done the work, and it must not pretend
   * otherwise.
   */
  async settle(id: string, state: Exclude<LedgerState, 'admitted'>, reason?: string): Promise<LedgerRecord | undefined> {
    await this.load();
    const current = this.#records.get(id);
    if (!current) return undefined;
    const updated: LedgerRecord = {
      ...current,
      state,
      ...(reason !== undefined ? { reason } : {}),
      settledAt: Date.now(),
    };
    this.#records.set(id, updated);
    await this.#persist();
    return updated;
  }

  /**
   * Reconcile the ledger after a restart.
   *
   * Every record still marked `admitted` becomes `unknown`: the app cannot
   * know whether the dispatch happened, so it says so instead of replaying it
   * or pretending it did not.
   */
  async reconcile(): Promise<LedgerRecord[]> {
    await this.load();
    const changed: LedgerRecord[] = [];
    for (const record of this.#records.values()) {
      if (record.state !== 'admitted') continue;
      const updated: LedgerRecord = {
        ...record,
        state: 'unknown',
        reason: 'the app stopped before this dispatch settled',
        settledAt: Date.now(),
      };
      this.#records.set(record.id, updated);
      changed.push(updated);
    }
    if (changed.length) await this.#persist();
    return changed;
  }

  /** Write the ledger, keeping the newest records. */
  async #persist(): Promise<void> {
    const records = this.all().slice(-MAX_RECORDS);
    // The in-memory index is trimmed too, so the ledger's size is bounded in
    // memory as well as on disk.
    for (const record of this.#records.keys()) {
      if (!records.some((kept) => kept.id === record)) {
        this.#records.delete(record);
      }
    }
    try {
      await this.#file.write({ version: 1, records });
    } catch (error) {
      // A ledger that cannot be written is a problem the app must report,
      // but it must not stop the dispatch it was recording.
      this.#log('warn', 'minibots.ledger_save_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
