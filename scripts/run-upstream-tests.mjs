// Runs the imported upstream test suite unmodified.
//
// The upstream suite lives in vendor/minimax-bot/tests and imports its engine
// through relative paths (../miniapp/node/...), so it must run with that
// directory as the working directory. Node's test runner does not expand
// shell globs on Windows, so the file list is enumerated here and passed
// explicitly.
//
// Usage:
//   node scripts/run-upstream-tests.mjs            # all upstream tests
//   node scripts/run-upstream-tests.mjs engine     # only files matching "engine"
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const TESTS_DIR = resolve('vendor', 'minimax-bot', 'tests');
const filter = process.argv[2] ?? '';

const files = readdirSync(TESTS_DIR)
  .filter((name) => name.endsWith('.test.mjs'))
  .filter((name) => (filter ? name.includes(filter) : true))
  .sort()
  .map((name) => join(TESTS_DIR, name));

if (files.length === 0) {
  console.error(`no upstream test files matched${filter ? ` "${filter}"` : ''}`);
  process.exit(1);
}

console.log(`running ${files.length} upstream test file(s)`);
if (filter) console.log(`filter: ${filter}`);

// The upstream tests resolve fixtures and import the engine from
// vendor/minimax-bot/, so the child runs with that as cwd.
const child = spawn(
  process.execPath,
  ['--test', '--test-reporter=spec', ...files],
  { cwd: TESTS_DIR, stdio: 'inherit', env: { ...process.env } },
);

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`upstream tests terminated by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
