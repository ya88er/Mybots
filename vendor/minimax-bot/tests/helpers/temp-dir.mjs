// @ts-check
/**
 * Test helpers for the imported upstream suite.
 *
 * Windows note: `rm(dir, { recursive: true })` can fail with ENOTEMPTY when a
 * file is written into the directory while the removal is walking it. The
 * upstream suite was authored on macOS, where the removal is atomic. A
 * background helper turn can still be settling its files when the test's
 * cleanup hook runs, which is exactly the window that produces ENOTEMPTY.
 *
 * `removeTempDir` retries that transient failure instead of failing the test.
 */
import { rm } from 'node:fs/promises';

const TRANSIENT_RM_CODES = new Set(['ENOTEMPTY', 'EPERM', 'EACCES', 'EBUSY']);
const RM_RETRY_ATTEMPTS = 6;
const RM_RETRY_BASE_MS = 10;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Remove a temporary directory, retrying the transient Windows failure.
 *
 * @param {string} dir
 */
export async function removeTempDir(dir) {
  let lastError;
  for (let attempt = 0; attempt < RM_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (!code || !TRANSIENT_RM_CODES.has(code)) throw error;
      await sleep(RM_RETRY_BASE_MS * (attempt + 1));
    }
  }
  throw lastError;
}
