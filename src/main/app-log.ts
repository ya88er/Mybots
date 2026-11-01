// @ts-check
/**
 * The app's log.
 *
 * An installed desktop app has nowhere to print: on Windows, a GUI
 * application does not write to a console at all. So the app writes its own
 * log, and the **startup trace** is the first thing in it.
 *
 * The trace matters because a packaged app that hangs during start-up gives
 * no other clue: there is no console, no exit code, and the window never
 * appears. The trace records each step of the start-up as it happens, so a
 * hang is located by the last line before it.
 *
 * The log lives beside the app's other data, in the user's own profile.
 */
import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** How much of the log is kept. */
const MAX_BYTES = 2 * 1024 * 1024;

/** The log file's path, once it is known. */
let logPath: string | undefined;

/**
 * Point the log at a directory.
 *
 * The directory is created if it does not exist. A failure is not fatal: the
 * app must still start when its log cannot be written.
 */
export function useLogDirectory(directory: string): void {
  try {
    mkdirSync(directory, { recursive: true });
    logPath = join(directory, 'minibots.log');
  } catch {
    logPath = undefined;
  }
}

/** Where the log is, if it is known. */
export function logFile(): string | undefined {
  return logPath;
}

/**
 * Write a line to the log.
 *
 * The log is **best effort**: a failure to write must never take the app
 * down, so every error here is swallowed.
 */
export function log(line: string): void {
  const path = logPath;
  if (!path) return;
  try {
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    // A log that cannot be written is not a reason to stop.
  }
}

/**
 * Record a step of the start-up.
 *
 * The name is short, because the trace is read by eye, and the detail — when
 * there is one — follows it.
 */
export function trace(step: string, detail?: string): void {
  log(`[start] ${step}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Record a failure.
 *
 * The stack is kept, because the message alone rarely says which of a dozen
 * awaits was the one that failed.
 */
export function traceError(step: string, error: unknown): void {
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  log(`[error] ${step} — ${detail}`);
}

/** The log's size, so it can be trimmed. */
export function logSize(): number {
  if (!logPath) return 0;
  try {
    return statSync(logPath).size;
  } catch {
    return 0;
  }
}

/** The limit the log is kept under. */
export { MAX_BYTES };
