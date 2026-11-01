// @ts-check
/**
 * The app's own settings.
 *
 * The settings file is the app's memory between runs: whether it starts at
 * sign-in, and which language its own windows use. A corrupted file must not
 * stop the app from starting, and a write must survive a crash.
 */
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DEFAULT_SETTINGS, SettingsStore } from '../../src/main/app-settings.ts';

/** A fresh temporary directory. */
async function tempDir() {
  return mkdtemp(join(tmpdir(), 'minibots-settings-'));
}

test('the defaults are the documented ones', () => {
  assert.equal(DEFAULT_SETTINGS.startAtLogin, false);
  assert.equal(DEFAULT_SETTINGS.locale, 'auto');
  assert.equal(DEFAULT_SETTINGS.startMinimized, false);
});

test('a store that has never been written reads the defaults', async () => {
  const dir = await tempDir();
  try {
    const store = new SettingsStore(join(dir, 'settings.json'));
    const settings = await store.load();
    assert.equal(settings.startAtLogin, false);
    assert.equal(settings.locale, 'auto');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a setting survives a restart', async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, 'settings.json');
    const first = new SettingsStore(path);
    await first.load();
    await first.update({ startAtLogin: true, locale: 'zh' });

    const second = new SettingsStore(path);
    const settings = await second.load();
    assert.equal(settings.startAtLogin, true);
    assert.equal(settings.locale, 'zh');
    assert.equal(settings.startMinimized, false, 'the other settings keep their default');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupted settings file does not stop the app', async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, 'settings.json');
    await writeFile(path, '{ this is not json', 'utf8');
    const store = new SettingsStore(path);
    const settings = await store.load();
    assert.equal(settings.startAtLogin, false);
    assert.equal(settings.locale, 'auto');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unknown locale falls back to auto', async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify({ locale: 'kl' }), 'utf8');
    const store = new SettingsStore(path);
    const settings = await store.load();
    assert.equal(settings.locale, 'auto');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the file on disk is readable JSON', async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, 'settings.json');
    const store = new SettingsStore(path);
    await store.load();
    await store.update({ startAtLogin: true });
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.startAtLogin, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
