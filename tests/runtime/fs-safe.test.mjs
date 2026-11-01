import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renameWithRetry } from '../../vendor/minimax-bot/miniapp/node/fs-safe.mjs';
import { removeTempDir } from '../../vendor/minimax-bot/tests/helpers/temp-dir.mjs';

// The upstream Mini App was developed on macOS, where rename() replaces the
// destination inode even while another handle holds it open. On Windows the
// same call fails with EPERM. The upstream suite therefore passed on the
// developer's machine and failed on Windows with:
//
//   {"status":"error","errorCode":"EPERM"}
//
// This is a Windows porting defect, not a flaky test. The fix is a bounded
// retry on the transient lock. These tests prove the retry actually fires:
// without it, the very first attempt fails.

const isWindows = process.platform === 'win32';

test('a plain rename over a held-open destination fails on Windows', async (t) => {
  if (!isWindows) {
    t.skip('POSIX replaces the inode; the race cannot surface here');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'minibots-rename-race-'));
  t.after(async () => { await removeTempDir(dir); });

  const target = join(dir, 'state.json');
  const source = join(dir, 'state.json.tmp');
  await writeFile(target, '{"v":1}', 'utf8');

  // Hold the destination open the way a concurrent reader or writer would.
  const held = await open(target, 'r+');
  t.after(async () => { await held.close().catch(() => {}); });

  await writeFile(source, '{"v":2}', 'utf8');

  // This is the exact call the upstream code made, and it is what failed.
  await assert.rejects(
    () => import('node:fs/promises').then((fs) => fs.rename(source, target)),
    (error) => {
      assert.equal(error.code, 'EPERM');
      return true;
    },
  );
});

test('renameWithRetry succeeds where a plain rename fails', async (t) => {
  if (!isWindows) {
    t.skip('the transient lock is a Windows behaviour');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'minibots-rename-retry-'));
  t.after(async () => { await removeTempDir(dir); });

  const target = join(dir, 'state.json');
  const source = join(dir, 'state.json.tmp');
  await writeFile(target, '{"v":1}', 'utf8');

  // A competing writer holds the destination for a moment and then releases it.
  // That short overlap is what the upstream store hits when two turns append
  // a message at the same time; the retry waits it out.
  const held = await open(target, 'r+');
  setTimeout(() => { void held.close(); }, 60);

  await writeFile(source, '{"v":2}', 'utf8');

  // The retry waits out the lock window instead of failing the write.
  await renameWithRetry(source, target);

  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(target, 'utf8'), '{"v":2}');
});

test('renameWithRetry rethrows a non-transient error immediately', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'minibots-rename-missing-'));
  try {
    await assert.rejects(
      () => renameWithRetry(join(dir, 'missing.tmp'), join(dir, 'target.json')),
      (error) => {
        // ENOENT is not a lock: it must not be retried away.
        assert.equal(error.code, 'ENOENT');
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
