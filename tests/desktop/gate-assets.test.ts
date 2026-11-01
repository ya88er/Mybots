// @ts-check
/**
 * The gate's public assets.
 *
 * The gate is the app's only door onto the backend. It refuses every request
 * that does not carry the bearer token — with one narrow exception: the
 * application's own static files.
 *
 * The exception is necessary, not convenient. A browser loads a page's
 * stylesheet, its scripts and its images as **subresources**, and a
 * subresource request cannot carry an `Authorization` header. A gate that
 * demanded a token for them would leave the window blank.
 *
 * The rule is deliberately narrow: only the paths below are public, and every
 * `/api/…` route — every route that can carry the user's chats, their keys or
 * their memory — still needs the token.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { isPublicAsset } from '../../src/backend/backend-gate.ts';

test('the chat page and its assets are public', () => {
  assert.equal(isPublicAsset('/bot'), true);
  assert.equal(isPublicAsset('/bot/'), true);
  assert.equal(isPublicAsset('/bot/app.css'), true);
  assert.equal(isPublicAsset('/bot/app.js'), true);
  assert.equal(isPublicAsset('/bot/skins/default.png'), true);
});

test("the app's own window and its assets are public", () => {
  assert.equal(isPublicAsset('/app'), true);
  assert.equal(isPublicAsset('/app/'), true);
  assert.equal(isPublicAsset('/app/app.css'), true);
  assert.equal(isPublicAsset('/app/app.js'), true);
  assert.equal(isPublicAsset('/app/strings.js'), true);
});

test('every API route needs the token', () => {
  for (const path of [
    '/api/state',
    '/api/bots',
    '/api/schedules',
    '/api/models',
    '/api/events',
    '/api/chats/bot_1/messages',
    '/api/app/sessions',
    '/api/app/dispatches',
    '/api/avatars',
    '/api/uploads/abc',
  ]) {
    assert.equal(isPublicAsset(path), false, `${path} must not be public`);
  }
});

test('the MCP endpoint needs the token', () => {
  assert.equal(isPublicAsset('/mcp/minimax-bot'), false);
});

test('a path that merely looks like an asset is not public', () => {
  // The upstream server's own static rule allows flat names only. A path
  // that walks out of the folder, or that asks for an unknown extension, is
  // not one of the app's files and must not be served without a token.
  assert.equal(isPublicAsset('/bot/../secrets.json'), false);
  assert.equal(isPublicAsset('/bot/app.exe'), false);
  assert.equal(isPublicAsset('/bot/nested/app.js'), false);
  assert.equal(isPublicAsset('/app/../secrets.json'), false);
  assert.equal(isPublicAsset('/app/data.json'), false);
});

test('a lookalike prefix is not public', () => {
  assert.equal(isPublicAsset('/botdata'), false);
  assert.equal(isPublicAsset('/application'), false);
  assert.equal(isPublicAsset('/api'), false);
});
