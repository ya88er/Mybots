// @ts-check
/**
 * The schedule catch-up.
 *
 * A schedule that came due while the app was closed is **overdue**. When the
 * app starts again, the user gets **one** delivery for it — not one per
 * missed occurrence. A daily reminder that was missed for a week must not
 * arrive seven times at once.
 *
 * The upstream engine already moves a schedule's `nextRunAt` forward when it
 * fires, so a schedule that is overdue fires once and then settles into its
 * next slot. What the upstream does not do is record *that* the catch-up
 * happened, which is what stops a second catch-up when the app restarts
 * again before the schedule's next slot.
 *
 * This module keeps that record: the id of the schedule, the run it caught
 * up on, and when. A schedule whose catch-up has already been delivered is
 * not delivered again until its next slot comes round.
 */

/** What the catch-up remembers about one schedule. */
export interface CatchUpRecord {
  /** The schedule's id. */
  readonly scheduleId: string;
  /** The run the catch-up delivered. */
  readonly nextRunAt: number;
  /** When the catch-up was delivered. */
  readonly deliveredAt: number;
}

/** The catch-up document, as it is written. */
interface CatchUpDocument {
  readonly version: 1;
  readonly records: readonly CatchUpRecord[];
}

/** How many records are kept. */
const MAX_RECORDS = 200;

export interface ScheduleCatchUpOptions {
  /** Where the catch-up records are stored. */
  readonly path: string;
}

/**
 * The schedule catch-up.
 *
 * One instance per backend process.
 */
export class ScheduleCatchUp {
  readonly #path: string;
  /** @type {Map<string, CatchUpRecord>} */
  readonly #records = new Map<string, CatchUpRecord>();
  #loaded = false;

  constructor(options: ScheduleCatchUpOptions) {
    this.#path = options.path;
  }

  /** Load the records from disk. */
  async load(): Promise<void> {
    if (this.#loaded) return;
    const { AtomicJsonFile } = await import('../storage/atomic-json.ts');
    const file = new AtomicJsonFile<CatchUpDocument>(this.#path);
    const document = await file.read({ version: 1, records: [] });
    for (const record of document.records ?? []) {
      if (!record || typeof record.scheduleId !== 'string') continue;
      this.#records.set(record.scheduleId, record);
    }
    this.#loaded = true;
  }

  /** Every record. */
  all(): CatchUpRecord[] {
    return [...this.#records.values()];
  }

  /**
   * Whether a schedule's catch-up has already been delivered.
   *
   * It has when a record exists for the schedule and the run it covered is
   * the same one that is now overdue.
   */
  async alreadyDelivered(scheduleId: string, nextRunAt: number): Promise<boolean> {
    await this.load();
    const record = this.#records.get(scheduleId);
    return record !== undefined && record.nextRunAt === nextRunAt;
  }

  /** Record that a catch-up was delivered. */
  async record(scheduleId: string, nextRunAt: number): Promise<void> {
    await this.load();
    this.#records.set(scheduleId, {
      scheduleId,
      nextRunAt,
      deliveredAt: Date.now(),
    });
    await this.#persist();
  }

  /**
   * Forget a schedule's records.
   *
   * A deleted schedule must not keep its record forever.
   */
  async forget(scheduleId: string): Promise<void> {
    await this.load();
    if (!this.#records.delete(scheduleId)) return;
    await this.#persist();
  }

  /** Write the records, keeping the newest ones. */
  async #persist(): Promise<void> {
    const { AtomicJsonFile } = await import('../storage/atomic-json.ts');
    const file = new AtomicJsonFile<CatchUpDocument>(this.#path);
    const records = this.all()
      .sort((a, b) => a.deliveredAt - b.deliveredAt)
      .slice(-MAX_RECORDS);
    await file.write({ version: 1, records });
  }
}
