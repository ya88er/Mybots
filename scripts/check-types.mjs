// @ts-check
/**
 * Type-check the MiniBots source tree.
 *
 * Two configurations are checked, because they are not the same check:
 *
 * - `tsconfig.json` covers the whole tree — `src`, `tests` and `scripts` —
 *   with the strict settings the code is written against. The vendored
 *   upstream subtree is excluded: it is upstream code we do not own, and it
 *   is type checked by its own suite.
 * - `tsconfig.build.json` is what the build actually compiles, with the
 *   emit settings. It catches the errors that only appear under the
 *   build's own module resolution and strictness — a header value's type,
 *   for instance, is checked differently there.
 *
 * The preload is checked separately as CommonJS, because a sandboxed preload
 * is loaded as a CommonJS script and cannot be part of the ESM build.
 *
 * A failure in any of them fails the run.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

/** Run one type check. */
function check(label, args) {
  const result = spawnSync(process.execPath, [tsc, ...args], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    // eslint-disable-next-line no-console
    console.error(`[minibots] the type check failed: ${label}`);
    process.exit(result.status ?? 1);
  }
  // eslint-disable-next-line no-console
  console.log(`[minibots] the type check passed: ${label}`);
}

// The whole tree, with the strict settings the code is written against.
check('the source tree', ['--noEmit', '-p', join(root, 'tsconfig.json')]);

// The build's own configuration, which compiles what the app ships.
check('the build', ['--noEmit', '-p', join(root, 'tsconfig.build.json')]);

// The preload, as CommonJS.
check(
  'the preload',
  [
    '--noEmit',
    '--module',
    'CommonJS',
    '--moduleResolution',
    'Node10',
    '--target',
    'ES2022',
    '--skipLibCheck',
    '--esModuleInterop',
    '--strict',
    '--noUncheckedIndexedAccess',
    join(root, 'src', 'main', 'preload.ts'),
  ],
);

process.exit(0);
