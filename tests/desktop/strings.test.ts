// @ts-check
/**
 * The app's own strings.
 *
 * The app ships in English and Chinese, and a missing translation is a bug:
 * the user sees an English sentence in a Chinese window, or a raw key. The
 * test therefore checks that the two tables have **exactly** the same keys,
 * that no value is empty, and that the placeholders match — a translation
 * that drops `{n}` silently loses the count.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import strings from '../../src/app/strings.js';

/** The placeholders a string uses. */
function placeholders(value: string): string[] {
  return [...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
}

test('the app has both languages', () => {
  assert.ok(strings.en, 'the English table exists');
  assert.ok(strings.zh, 'the Chinese table exists');
});

test('the two languages have exactly the same keys', () => {
  const english = Object.keys(strings.en).sort();
  const chinese = Object.keys(strings.zh).sort();
  const missingInChinese = english.filter((key) => !chinese.includes(key));
  const missingInEnglish = chinese.filter((key) => !english.includes(key));
  assert.deepEqual(missingInChinese, [], 'every English string has a Chinese one');
  assert.deepEqual(missingInEnglish, [], 'every Chinese string has an English one');
});

test('no string is empty', () => {
  for (const [language, table] of Object.entries(strings)) {
    for (const [key, value] of Object.entries(table)) {
      assert.ok(
        typeof value === 'string' && value.trim().length > 0,
        `${language}.${key} must not be empty`,
      );
    }
  }
});
test('a translation keeps the placeholders of its English original', () => {
  for (const [key, english] of Object.entries(strings.en)) {
    const chinese = strings.zh[key] ?? '';
    assert.deepEqual(
      placeholders(chinese),
      placeholders(english),
      `zh.${key} must use the same placeholders as en.${key}`,
    );
  }
});

test('the two languages really differ', () => {
  // A copy-paste that leaves the Chinese table in English is a silent
  // failure: every key would exist, and every user would read English.
  const identical = Object.keys(strings.en).filter(
    (key) => strings.zh[key] === strings.en[key],
  );
  // These are the names that are deliberately the same in both languages:
  // product names, technical names, and the language's own name.
  const allowed = new Set([
    'app.title',
    'app.window.title',
    'tray.tooltip',
    'about.locale.en',
    'about.locale.zh',
    'sessions.bot',
    'about.electron',
    'about.node',
    'about.pi',
  ]);
  const wrong = identical.filter((key) => !allowed.has(key));
  assert.deepEqual(wrong, [], 'these strings were not translated');
});

test('the app owns a string for every user-facing surface', () => {
  const required = [
    'providers.title',
    'providers.apiKey',
    'providers.save',
    'providers.remove',
    'providers.test',
    'sessions.title',
    'dispatches.title',
    'about.title',
    'about.locale',
    'common.loadingFailed',
    'nav.providers',
    'nav.sessions',
    'nav.dispatches',
    'nav.about',
    // The tray menu belongs to the main process, but its strings live in
    // this table: the main process reads them from here, so the tray and the
    // app's own window can never drift apart.
    'tray.open',
    'tray.settings',
    'tray.startAtLogin',
    'tray.quit',
    'tray.tooltip',
  ];
  for (const key of required) {
    assert.ok(strings.en[key], `en.${key} exists`);
    assert.ok(strings.zh[key], `zh.${key} exists`);
  }
});

test('the tray menu is labelled, and each item says what it does', () => {
  // A tray menu whose items are all named after the app is a menu nobody can
  // use. The labels are checked here rather than in the Electron suite, so a
  // regression is caught without starting a window server.
  const labels = ['tray.open', 'tray.settings', 'tray.startAtLogin', 'tray.quit'];
  for (const language of ['en', 'zh']) {
    const table = strings[language as 'en' | 'zh'];
    const values = labels.map((key) => table[key] ?? '');
    assert.equal(
      new Set(values).size,
      labels.length,
      `${language}: the tray items must not all carry the same label`,
    );
    for (const value of values) {
      assert.ok(value.trim().length > 0, `${language}: a tray label is empty`);
    }
  }
});
