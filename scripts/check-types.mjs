// @ts-check
/**
 * Type-check the MiniBots source tree.
 *
 * `tsc --noEmit` over `src`, `tests` and `scripts`. The vendored upstream
 * subtree is excluded: it is upstream code we do not own, and it is type
 * checked by its own suite.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const result = spawnSync(
  process.execPath,
  [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', join(root, 'tsconfig.json')],
  { cwd: root, stdio: 'inherit' },
);

process.exit(result.status ?? 1);
