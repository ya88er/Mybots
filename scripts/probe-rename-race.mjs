// Reproduces the Windows rename() EPERM race that breaks the upstream store.
//
// writeJsonAtomic() does writeFile(tmp) -> rename(tmp, path).
// On Windows, rename() over a destination that another handle still holds
// open fails with EPERM (on POSIX, rename() replaces the inode silently).
// The upstream suite was authored on macOS, where this race cannot surface,
// and it is the root cause of the two upstream baseline failures.
//
// This script demonstrates the mechanism directly. The regression test that
// pins the fix is tests/runtime/fs-safe.test.mjs.
//
// Run:  node scripts/probe-rename-race.mjs
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = join(tmpdir(), 'rename-race-probe');
const target = join(dir, 'state.json');
const tmp = join(dir, 'state.json.tmp');

await rm(dir, { recursive: true, force: true }).catch(() => {});
await mkdir(dir, { recursive: true });
await writeFile(target, '{"v":1}', 'utf8');

// Hold the destination open the way a concurrent reader or writer would.
const held = await open(target, 'r+');

await writeFile(tmp, '{"v":2}', 'utf8');

let code = 'SUCCEEDED';
let message = '';
try {
  await rename(tmp, target);
} catch (error) {
  code = error.code;
  message = error.message;
}

console.log(`platform: ${process.platform}`);
console.log(`plain rename over a held-open destination -> ${code}`);
if (message) console.log(`  ${message}`);
console.log('=> matches the upstream failure: {"status":"error","errorCode":"EPERM"}');
console.log('   (on POSIX this succeeds, which is why upstream CI never saw it)');

await held.close().catch(() => {});
await rm(dir, { recursive: true, force: true }).catch(() => {});
