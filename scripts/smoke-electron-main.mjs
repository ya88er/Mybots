// Electron entry point for the M1 runtime smoke test.
//
// Electron needs a main script; this one forks the utility process (the place
// the backend actually runs) and reports the result.
//
// Run:  npx electron scripts/smoke-electron-main.mjs
import { app, utilityProcess } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workerPath = resolve(here, 'smoke-electron-worker.mjs');

app.whenReady().then(() => {
  const child = utilityProcess.fork(workerPath, [], {
    serviceName: 'minibots-smoke',
    stdio: 'inherit',
  });

  let settled = false;
  const finish = (code) => {
    if (settled) return;
    settled = true;
    app.exit(code);
  };

  child.on('message', (message) => {
    if (message?.type === 'result') {
      console.log('');
      console.log(`=== ${message.passed}/${message.total} checks passed (Electron utility process) ===`);
      if (message.failures?.length) {
        console.log('FAILED checks:');
        for (const failure of message.failures) console.log(`  - ${failure.name}: ${failure.detail}`);
      }
      finish(message.failures?.length ? 1 : 0);
    }
  });

  child.on('exit', (code) => {
    if (!settled) {
      console.error(`utility process exited with code ${code} before reporting`);
      finish(1);
    }
  });
});

app.on('window-all-closed', () => {
  // No window is created; the smoke test is headless by design.
});
