// Probe: can the vendored client actually load its own assets from a file://
// page? The client's index.html refers to "/bot/app.css" and "/bot/app.js",
// which are absolute paths. A file:// page resolves those against the file
// system root, not against a server, so they cannot load.
//
// This writes its findings to a file because Electron on Windows does not
// write to the console of a GUI application.
//
// Run:  npx electron scripts/probe-client-origin.mjs
import { app, BrowserWindow } from 'electron';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const reportPath = resolve(here, '..', 'client-origin-probe.txt');
const clientIndex = resolve(here, '..', 'vendor', 'minimax-bot', 'miniapp', 'client', 'index.html');

writeFileSync(reportPath, 'Client origin probe\n\n', 'utf8');
const say = (line) => appendFileSync(reportPath, `${line}\n`, 'utf8');

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  const failures = [];
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) failures.push(message);
  });
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    failures.push(`did-fail-load ${code} ${description} ${url}`);
  });

  await window.loadFile(clientIndex);
  await new Promise((r) => setTimeout(r, 2500));

  const state = await window.webContents.executeJavaScript(`
    (() => {
      const sheet = document.querySelector('link[rel="stylesheet"]');
      const script = document.querySelector('script[type="module"]');
      return JSON.stringify({
        url: location.href,
        sheetHref: sheet?.getAttribute('href') ?? null,
        scriptSrc: script?.getAttribute('src') ?? null,
        // Did the stylesheet actually apply? The upstream page sets a
        // background on body; an unstyled page has a white body.
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        // Did the module script run? It sets these on window.
        hasSide: Boolean(document.getElementById('side')?.children.length),
        sideHint: document.getElementById('side-list')?.textContent?.trim() ?? null,
      });
    })()
  `);

  say(`page state: ${state}`);
  say(`console failures: ${failures.length}`);
  for (const failure of failures) say(`  - ${failure}`);
  say('\n=== probe done ===');
  app.exit(0);
});
