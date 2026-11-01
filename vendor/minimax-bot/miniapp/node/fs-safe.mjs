// @ts-check
/**
 * Windows-safe filesystem helpers.
 *
 * On POSIX, `rename()` atomically replaces the destination even when another
 * handle has it open. On Windows it fails with EPERM (or EACCES/EBUSY) while
 * any other handle still holds the destination. The upstream Mini App was
 * developed on macOS, so several of its write paths can lose a race on
 * Windows even though they are correct on the developer's machine.
 *
 * These helpers keep the upstream atomic-write semantics and add a bounded
 * retry for the short window in which Windows holds the lock.
 */
import { rename } from 'node:fs/promises';

/** Error codes that mean "another handle holds the file", not "this will never work". */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Attempts per rename, and the base delay for the linear backoff. */
export const RENAME_RETRY_ATTEMPTS = 10;
export const RENAME_RETRY_BASE_MS = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Rename with a bounded retry for the transient Windows lock.
 *
 * A non-transient error is rethrown immediately. When every attempt hits the
 * lock, the last error is rethrown so the caller still sees a real failure
 * rather than a silent partial write.
 *
 * @param {string} from
 * @param {string} to
 */
export async function renameWithRetry(from, to) {
  let lastError;
  for (let attempt = 0; attempt < RENAME_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (!code || !TRANSIENT_RENAME_CODES.has(code)) throw error;
      // Linear backoff: the lock window is short, and jitter would only make
      // contention between many writers worse.
      await sleep(RENAME_RETRY_BASE_MS * (attempt + 1));
    }
  }
  throw lastError;
}
