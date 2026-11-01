// @ts-check
/**
 * Atomic JSON storage.
 *
 * Every app-owned state file is written whole through a temporary file and an
 * atomic replacement, so a crash never leaves a half-written document. The
 * rename is retried for the transient Windows file lock; see the vendored
 * `fs-safe.mjs`, which the upstream Mini App now uses for the same reason.
 *
 * Writes are serialised per file, so two writers never interleave.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Error codes that mean "another handle holds the file", not "this will never work". */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_ATTEMPTS = 10;
const RENAME_RETRY_BASE_MS = 5;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Rename with a bounded retry for the transient Windows lock. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RENAME_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      const code = errorCodeOf(error);
      if (!code || !TRANSIENT_RENAME_CODES.has(code)) throw error;
      await sleep(RENAME_RETRY_BASE_MS * (attempt + 1));
    }
  }
  throw lastError;
}

/** The `code` of a Node system error, when it has one. */
function errorCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** A JSON document that lives in one file, written atomically. */
export class AtomicJsonFile<T> {
  readonly #path: string;
  /** Serialises writes so two writers never interleave on the same file. */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  /**
   * Read the document, or `fallback` when it does not exist.
   *
   * A file that exists but cannot be parsed is treated as absent: a
   * half-written or corrupted document must not stop the app from starting.
   * The caller is told through `fallback`, and the file is replaced on the
   * next write.
   */
  async read(fallback: T): Promise<T> {
    let raw: string;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === 'ENOENT') return fallback;
      throw error;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  /**
   * Write the document atomically.
   *
   * The write is queued behind any write already in flight for this file, so
   * the last write wins and no two writes ever overlap.
   */
  write(value: T): Promise<void> {
    const next = this.#chain.then(
      () => this.#writeNow(value),
      () => this.#writeNow(value),
    );
    // The chain must not reject, or every later write would be poisoned.
    this.#chain = next.catch(() => {});
    return next;
  }

  async #writeNow(value: T): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
      await renameWithRetry(tmp, this.#path);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }

  /** Wait for every queued write to finish. */
  async flush(): Promise<void> {
    await this.#chain.catch(() => {});
  }
}
