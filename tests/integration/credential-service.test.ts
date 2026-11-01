import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CredentialService, type SafeStorageLike } from '../../src/main/credential-service.ts';

// A provider key must never be readable from the file on disk, and must
// never be returned by the service. These tests check both.

/**
 * A stand-in for Electron's `safeStorage`.
 *
 * It mirrors Electron 45's **async** API: `encryptStringAsync` returns an
 * object whose `result` holds the ciphertext, not a string. The sync methods
 * exist too, so the test proves the async path is the one used.
 */
function fakeSafeStorage(): SafeStorageLike & { calls: string[] } {
  const calls: string[] = [];
  const encrypt = (plain: string): Buffer => Buffer.from(`enc:${plain}`, 'utf8');
  return {
    calls,
    isEncryptionAvailable: () => true,
    encryptString: (plain) => {
      calls.push('sync-encrypt');
      return encrypt(plain);
    },
    decryptString: (cipher) => {
      calls.push('sync-decrypt');
      return cipher.toString('utf8').replace(/^enc:/, '');
    },
    encryptStringAsync: async (plain) => {
      calls.push('async-encrypt');
      return { result: encrypt(plain) };
    },
    decryptStringAsync: async (cipher) => {
      calls.push('async-decrypt');
      return { result: cipher.toString('utf8').replace(/^enc:/, '') };
    },
  };
}

async function serviceFixture(t: { after: (fn: () => unknown) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'minibots-credentials-'));
  const path = join(root, 'credentials.enc.json');
  const safeStorage = fakeSafeStorage();
  const service = new CredentialService({ path, safeStorage });
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return { root, path, service, safeStorage };
}

test('a saved key is not readable in plain text from the file', async (t) => {
  const h = await serviceFixture(t);

  await h.service.save('deepseek', 'sk-super-secret-value');

  const raw = await readFile(h.path, 'utf8');
  assert.ok(!raw.includes('sk-super-secret-value'), 'the plaintext key is not in the file');
  assert.ok(raw.includes('deepseek'), 'the file names the provider');
});

test('the async API is used, not the deprecated sync one', async (t) => {
  const h = await serviceFixture(t);

  await h.service.save('deepseek', 'sk-secret');
  const loaded = await h.service.load();

  assert.ok(h.safeStorage.calls.includes('async-encrypt'), 'the async encryption was used');
  assert.ok(
    !h.safeStorage.calls.includes('sync-encrypt'),
    'the deprecated sync encryption was not used',
  );
  assert.ok(h.safeStorage.calls.includes('async-decrypt'), 'the async decryption was used');
  assert.deepEqual(loaded.loaded, ['deepseek'], 'the credential was loaded back');
});

test('a saved key is readable through the service but never leaves it', async (t) => {
  const h = await serviceFixture(t);

  await h.service.save('openai', 'sk-another-secret');
  assert.equal(h.service.get('openai'), 'sk-another-secret', 'the service resolves the key');
  assert.deepEqual(h.service.providers(), ['openai'], 'the provider is listed');

  // The list of providers is what the renderer is told. It carries no key.
  const publicList = JSON.stringify({ providers: h.service.providers() });
  assert.ok(!publicList.includes('sk-another-secret'), 'the provider list carries no key');
});

test('a key is restored after a restart', async (t) => {
  const h = await serviceFixture(t);
  await h.service.save('minimax', 'sk-restored');

  // A new service over the same file, as a restart would build.
  const restarted = new CredentialService({ path: h.path, safeStorage: h.safeStorage });
  const result = await restarted.load();

  assert.deepEqual(result.loaded, ['minimax']);
  assert.equal(restarted.resolve('minimax'), 'sk-restored', 'the key came back');
});

test('a removed key is gone from the file', async (t) => {
  const h = await serviceFixture(t);
  await h.service.save('openai', 'sk-to-remove');
  await h.service.save('deepseek', 'sk-to-keep');

  await h.service.remove('openai');

  const restarted = new CredentialService({ path: h.path, safeStorage: h.safeStorage });
  await restarted.load();
  assert.equal(restarted.resolve('openai'), undefined, 'the removed key is gone');
  assert.equal(restarted.resolve('deepseek'), 'sk-to-keep', 'the other key is untouched');

  const raw = await readFile(h.path, 'utf8');
  assert.ok(!raw.includes('sk-to-remove'), 'the removed key is not in the file');
});

test('a file that cannot be decrypted is reported, not silently ignored', async (t) => {
  const h = await serviceFixture(t);
  await h.service.save('openai', 'sk-secret');

  // A service whose key store cannot read the file: the OS key store changed,
  // or the file was tampered with.
  const broken = new CredentialService({
    path: h.path,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(plain, 'utf8'),
      decryptString: () => {
        throw new Error('the key store refused');
      },
      encryptStringAsync: async (plain) => ({ result: Buffer.from(plain, 'utf8') }),
      decryptStringAsync: async () => {
        throw new Error('the key store refused');
      },
    },
  });

  const result = await broken.load();
  assert.deepEqual(result.loaded, [], 'nothing was loaded');
  assert.deepEqual(result.failed, ['openai'], 'the failure names the provider');
});

test('a service without an OS key store refuses to store a key', async (t) => {
  const h = await serviceFixture(t);
  const service = new CredentialService({
    path: h.path,
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
    },
  });

  await assert.rejects(
    () => service.save('openai', 'sk-secret'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /encryption/i);
      return true;
    },
  );
});

test('no credential file exists before a key is saved', async (t) => {
  const h = await serviceFixture(t);
  const result = await h.service.load();
  assert.deepEqual(result.loaded, []);
  assert.deepEqual(result.failed, []);
});
