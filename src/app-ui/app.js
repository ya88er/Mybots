// @ts-check
/**
 * The app's own window.
 *
 * It shows the things the desktop app owns: the provider keys, the session
 * inspector and the dispatch inspector. The chat itself is the upstream Mini
 * App, in its own window.
 *
 * The window is served from the app's own loopback origin, so a relative
 * `fetch` reaches the app's routes directly — there is no token here, because
 * the browser never holds one. The bridge in the preload carries the
 * credential operations that must not be reachable from a plain HTTP request.
 */

/**
 * The bridge the preload exposes.
 *
 * @typedef {object} AppBridge
 * @property {() => Promise<{ providers: string[] }>} listCredentials
 * @property {(providerId: string, apiKey: string) => Promise<{ ok: boolean }>} saveCredential
 * @property {(providerId: string) => Promise<{ ok: boolean }>} removeCredential
 * @property {(providerId: string) => Promise<{ ok: boolean; stage?: string; message?: string }>} testProvider
 * @property {() => Promise<{ providers: { id: string; name: string; description: string; keyUrl: string }[] }>} listProviders
 * @property {() => Promise<{ version: string; electron: string; node: string; pi: string; dataDir: string; backend: boolean; locale: string }>} appInfo
 * @property {(locale: string) => Promise<{ locale: string }>} setLocale
 */

/** @type {AppBridge} */
const bridge = /** @type {any} */ (window).minibots;

/**
 * The providers the app offers.
 *
 * The list comes from the main process, which owns Pi's provider ids, so the
 * two can never drift apart.
 */
/** The active section. */
let section = 'providers';

/**
 * The app's language.
 *
 * `auto` resolves to the operating system's language, which is what the main
 * process reports.
 */
let locale = 'en';

/** The translations for the active language. */
const DICTIONARY = (await import('./strings.js')).default;

/** The strings for the active language. */
let strings = DICTIONARY.en ?? {};

/** The locales the app speaks. */
const LOCALES = ['en', 'zh'];

/**
 * Translate a key.
 *
 * English is the fallback, so a gap shows English rather than a blank.
 *
 * @param {string} key
 * @param {Record<string, unknown>} [params]
 */
function t(key, params) {
  const entry = strings[key] ?? DICTIONARY.en?.[key] ?? DICTIONARY.zh?.[key];
  if (entry === undefined) return key;
  if (typeof entry === 'function') return entry(params ?? {});
  return params ? entry.replace(/\{(\w+)\}/g, (_m, name) => String(params[name] ?? _m)) : entry;
}

/** Create an element. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') el.className = String(value);
    else if (key === 'text') el.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== undefined && value !== null) {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Show a message at the bottom of the window. */
let toastTimer = 0;
function toast(message, bad = false) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('bad', bad);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

/** Call the app's own route and return its body. */
async function call(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.message ?? `The request failed with ${response.status}.`);
  }
  return body;
}

// ------------------------------------------------------------------ providers

/**
 * The provider card.
 *
 * The key is never read back: the app shows whether one is configured, and
 * the user may replace it, but the stored key never leaves the main process.
 */
function providerCard(provider, isConfigured) {
  const keyInput = h('input', {
    type: 'password',
    placeholder: t('providers.apiKeyPlaceholder'),
    autocomplete: 'off',
    spellcheck: 'false',
    id: `key-${provider.id}`,
  });

  const status = h('span', {
    class: `chip ${isConfigured ? 'good' : ''}`,
    text: t(isConfigured ? 'providers.configured' : 'providers.notConfigured'),
  });
  const testResult = h('span', { class: 'chip' });

  const save = h(
    'button',
    {
      class: 'btn primary',
      type: 'button',
      onclick: async () => {
        const apiKey = keyInput.value.trim();
        if (!apiKey) return;
        save.disabled = true;
        try {
          await bridge.saveCredential(provider.id, apiKey);
          keyInput.value = '';
          status.className = 'chip good';
          status.textContent = t('providers.configured');
          toast(t('providers.saved'));
          await refreshProviders();
        } catch (error) {
          toast(`${t('providers.saveFailed')} ${error?.message ?? ''}`.trim(), true);
        } finally {
          save.disabled = false;
        }
      },
    },
    t('providers.save'),
  );

  const remove = h(
    'button',
    {
      class: 'btn danger',
      type: 'button',
      onclick: async () => {
        remove.disabled = true;
        try {
          await bridge.removeCredential(provider.id);
          status.className = 'chip';
          status.textContent = t('providers.notConfigured');
          toast(t('providers.removed'));
          await refreshProviders();
        } catch (error) {
          toast(`${t('providers.removeFailed')} ${error?.message ?? ''}`.trim(), true);
        } finally {
          remove.disabled = false;
        }
      },
    },
    t('providers.remove'),
  );

  const test = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: async () => {
        test.disabled = true;
        test.textContent = t('providers.testing');
        try {
          const result = await bridge.testProvider(provider.id);
          const stage = result?.stage ?? 'unknown';
          const key = `providers.test.${stage === 'ok' ? 'ok' : stage === 'authentication' ? 'authFailed' : 'serviceFailed'}`;
          testResult.className = `chip ${result?.ok ? 'good' : 'bad'}`;
          testResult.textContent = result?.message ? result.message : t(key);
        } catch (error) {
          testResult.className = 'chip bad';
          testResult.textContent = error?.message ?? t('providers.test.unknown');
        } finally {
          test.disabled = false;
          test.textContent = t('providers.test');
        }
      },
    },
    t('providers.test'),
  );

  return h(
    'section',
    { class: 'card' },
    h(
      'div',
      { class: 'card-head' },
      h('h3', { text: provider.name }),
      status,
    ),
    h('p', { class: 'hint', text: provider.description }),
    h('label', { for: `key-${provider.id}`, text: t('providers.apiKey') }),
    h(
      'div',
      { class: 'key-row' },
      keyInput,
      save,
      remove,
    ),
    h(
      'div',
      { class: 'row', style: { marginTop: '12px' } },
      test,
      testResult,
      h('span', { class: 'spacer' }),
      h('a', {
        href: provider.keyUrl,
        target: '_blank',
        rel: 'noreferrer',
        class: 'chip',
        text: provider.keyUrl,
      }),
    ),
  );
}

/** Render the providers section. */
async function renderProviders() {
  const main = document.getElementById('main');
  if (!main) return;
  main.replaceChildren(
    h('header', {}, h('h2', { text: t('providers.title') }), h('p', { text: t('providers.subtitle') })),
  );

  const list = await bridge.listProviders();
  const providers = list?.providers ?? [];

  if (!providers.length) {
    main.append(h('p', { class: 'empty', text: t('providers.empty') }));
    return;
  }

  const configured = new Set((await bridge.listCredentials())?.providers ?? []);
  for (const provider of providers) {
    main.append(providerCard(provider, configured.has(provider.id)));
  }
}

/** Refresh the provider list. */
async function refreshProviders() {
  if (section === 'providers') await renderProviders();
}

// ------------------------------------------------------------------ sessions

/** Render the sessions section. */
async function renderSessions() {
  const main = document.getElementById('main');
  if (!main) return;
  main.replaceChildren(
    h('header', {}, h('h2', { text: t('sessions.title') }), h('p', { text: t('sessions.subtitle') })),
  );

  let body;
  try {
    body = await call('/api/app/sessions');
  } catch (error) {
    main.append(h('p', { class: 'empty', text: error?.message ?? t('common.loadingFailed') }));
    return;
  }

  const sessions = body?.sessions ?? [];
  if (!sessions.length) {
    main.append(h('p', { class: 'empty', text: t('sessions.empty') }));
    return;
  }

  const rows = sessions.map((session) =>
    h(
      'tr',
      {},
      h('td', { text: session.chatId ?? t('common.unknown') }),
      h('td', { text: session.botName ?? session.botId ?? t('common.unknown') }),
      h('td', { text: String(session.generation ?? 0) }),
      h('td', {}, h('code', { text: session.piSessionId ?? t('common.none') })),
      h('td', { text: session.model ? `${session.model.providerId}/${session.model.modelId}` : t('common.none') }),
      h('td', { text: formatTime(session.updatedAt) }),
    ),
  );

  main.append(
    h(
      'table',
      {},
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { text: t('sessions.chat') }),
          h('th', { text: t('sessions.bot') }),
          h('th', { text: t('sessions.generation') }),
          h('th', { text: t('sessions.piSession') }),
          h('th', { text: t('sessions.model') }),
          h('th', { text: t('sessions.updated') }),
        ),
      ),
      h('tbody', {}, rows),
    ),
  );
}

// ------------------------------------------------------------------ dispatches

/** Render the dispatches section. */
async function renderDispatches() {
  const main = document.getElementById('main');
  if (!main) return;
  main.replaceChildren(
    h('header', {}, h('h2', { text: t('dispatches.title') }), h('p', { text: t('dispatches.subtitle') })),
  );

  let body;
  try {
    body = await call('/api/app/dispatches');
  } catch (error) {
    main.append(h('p', { class: 'empty', text: error?.message ?? t('common.loadingFailed') }));
    return;
  }

  const records = (body?.records ?? []).slice().reverse();
  if (!records.length) {
    main.append(h('p', { class: 'empty', text: t('dispatches.empty') }));
    return;
  }

  const unsettled = body?.unsettled ?? 0;
  const rows = records.map((record) => {
    const state = record?.state ?? 'admitted';
    const chipClass =
      state === 'settled' ? 'good' : state === 'failed' ? 'bad' : state === 'unknown' ? 'warn' : '';
    return h(
      'tr',
      {},
      h('td', {}, h('code', { text: record?.id ?? '' })),
      h('td', { text: record?.subject ?? t('common.unknown') }),
      h('td', {}, h('span', { class: `chip ${chipClass}`, text: t(`dispatches.state.${state}`) })),
      h('td', { text: record?.reason ?? t('common.none') }),
      h('td', { text: formatTime(record?.admittedAt) }),
    );
  });

  main.append(
    h(
      'div',
      { class: 'row', style: { marginBottom: '10px' } },
      h('span', { class: 'chip', text: t('dispatches.unsettled', { n: unsettled }) }),
    ),
    h(
      'table',
      {},
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { text: t('dispatches.id') }),
          h('th', { text: t('dispatches.tool') }),
          h('th', { text: t('dispatches.state') }),
          h('th', { text: t('dispatches.reason') }),
          h('th', { text: t('dispatches.admittedAt') }),
        ),
      ),
      h('tbody', {}, rows),
    ),
  );
}

// ------------------------------------------------------------------ about

/** Render the about section. */
async function renderAbout() {
  const main = document.getElementById('main');
  if (!main) return;
  main.replaceChildren(
    h('header', {}, h('h2', { text: t('about.title') }), h('p', { text: t('about.subtitle') })),
  );

  let info = {};
  try {
    info = (await bridge.appInfo()) ?? {};
  } catch {
    info = {};
  }

  const localeSelect = h(
    'select',
    {
      onchange: async (event) => {
        const value = event.target.value;
        await bridge.setLocale(value);
        await applyLocale(value);
      },
    },
    ...['auto', 'en', 'zh'].map((value) =>
      h('option', { value, selected: (info.locale ?? 'auto') === value, text: t(`about.locale.${value}`) }),
    ),
  );

  main.append(
    h(
      'section',
      { class: 'card' },
      h(
        'dl',
        { class: 'kv' },
        h('dt', { text: t('about.version') }),
        h('dd', { text: info.version ?? t('common.unknown') }),
        h('dt', { text: t('about.electron') }),
        h('dd', { text: info.electron ?? t('common.unknown') }),
        h('dt', { text: t('about.node') }),
        h('dd', { text: info.node ?? t('common.unknown') }),
        h('dt', { text: t('about.pi') }),
        h('dd', { text: info.pi ?? t('common.unknown') }),
        h('dt', { text: t('about.backend') }),
        h(
          'dd',
          {},
          h('span', {
            class: `chip ${info.backend ? 'good' : 'bad'}`,
            text: t(info.backend ? 'about.backend.up' : 'about.backend.down'),
          }),
        ),
        h('dt', { text: t('about.dataDir') }),
        h('dd', {}, h('code', { text: info.dataDir ?? '' })),
      ),
    ),
    h(
      'section',
      { class: 'card' },
      h('h3', { text: t('about.locale') }),
      h('div', { style: { marginTop: '10px', maxWidth: '260px' } }, localeSelect),
    ),
  );
}

// ------------------------------------------------------------------ shell

/** The sections the rail shows, in order. */
const SECTIONS = [
  { id: 'providers', label: 'nav.providers' },
  { id: 'sessions', label: 'nav.sessions' },
  { id: 'dispatches', label: 'nav.dispatches' },
  { id: 'about', label: 'nav.about' },
];

/** Draw the rail. */
function renderRail() {
  const rail = document.getElementById('rail');
  if (!rail) return;
  rail.replaceChildren(
    h('h1', { text: t('app.title') }),
    ...SECTIONS.map((entry) =>
      h(
        'button',
        {
          type: 'button',
          'aria-current': section === entry.id ? 'page' : null,
          onclick: () => {
            section = entry.id;
            renderRail();
            void renderSection();
          },
        },
        t(entry.label),
      ),
    ),
  );
}

/** Draw the active section. */
async function renderSection() {
  if (section === 'providers') return renderProviders();
  if (section === 'sessions') return renderSessions();
  if (section === 'dispatches') return renderDispatches();
  return renderAbout();
}

/** Format a timestamp. */
function formatTime(value) {
  if (!value) return t('common.none');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

/** Switch the app's language and redraw. */
async function applyLocale(next) {
  locale = LOCALES.includes(next) ? next : 'en';
  strings = DICTIONARY[locale] ?? DICTIONARY.en ?? {};
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en-US';
  renderRail();
  await renderSection();
}

/** Start the app's window. */
async function boot() {
  try {
    const info = await bridge.appInfo();
    const preferred = info?.locale ?? 'en';
    await applyLocale(LOCALES.includes(preferred) ? preferred : 'en');
  } catch {
    await applyLocale('en');
  }
  renderRail();
  await renderSection();
}

void boot();
