// @ts-check
/**
 * The app's own pages.
 *
 * The app's window is served over HTTP, so its files are read from disk on
 * each request. Two things must hold:
 *
 * - a request for one of the app's own files is answered with that file and
 *   the right content type;
 * - a request for anything else is refused. The app's folder is flat, and a
 *   path that walks out of it must never be served.
 */
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { appUiDir, isAppPath, readAppFile } from '../../src/main/app-ui-server.ts';

test("the app's own pages are found", () => {
  const dir = appUiDir();
  assert.ok(dir.length > 0, 'the app UI directory is resolved');
});

test('the app window\'s paths are recognised', () => {
  assert.equal(isAppPath('/app'), true);
  assert.equal(isAppPath('/app/'), true);
  assert.equal(isAppPath('/app/app.js'), true);
  assert.equal(isAppPath('/api/state'), false);
  assert.equal(isAppPath('/bot'), false);
});

test("the app's own files are served with the right content type", async () => {
  const page = await readAppFile('/app/index.html');
  assert.ok(page, 'the index page exists');
  assert.equal(page.status, 200);
  assert.match(page.contentType, /text\/html/);
  assert.match(page.body.toString('utf8'), /<!doctype html>/i);

  const script = await readAppFile('/app/app.js');
  assert.ok(script, 'the script exists');
  assert.match(script.contentType, /javascript/);

  const style = await readAppFile('/app/app.css');
  assert.ok(style, 'the stylesheet exists');
  assert.match(style.contentType, /text\/css/);
});

test('a path that walks out of the folder is refused', async () => {
  assert.equal(await readAppFile('/app/../secrets.json'), undefined);
  assert.equal(await readAppFile('/app/../../package.json'), undefined);
  assert.equal(await readAppFile('/app/nested/app.js'), undefined);
});

test('an unknown extension is refused', async () => {
  assert.equal(await readAppFile('/app/data.json'), undefined);
  assert.equal(await readAppFile('/app/secret.env'), undefined);
});

test('the folder is read at request time, so an edit shows up', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'minibots-appui-'));
  const previous = process.env.MINIBOTS_APP_UI_DIR;
  try {
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>first</title>', 'utf8');
    process.env.MINIBOTS_APP_UI_DIR = dir;

    const first = await readAppFile('/app/index.html');
    assert.match(first?.body.toString('utf8') ?? '', /first/);

    await writeFile(join(dir, 'index.html'), '<!doctype html><title>second</title>', 'utf8');
    const second = await readAppFile('/app/index.html');
    assert.match(second?.body.toString('utf8') ?? '', /second/);
  } finally {
    if (previous === undefined) delete process.env.MINIBOTS_APP_UI_DIR;
    else process.env.MINIBOTS_APP_UI_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
