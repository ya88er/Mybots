// @ts-check
/**
 * The backend's shim.
 *
 * The backend runs as an Electron **utility process**: a separate Node
 * process that Electron forks. A forked process needs a real file to run, so
 * this one file is unpacked from the ASAR archive while the rest of the app
 * stays inside it.
 *
 * The shim does one thing: it hands over to the real entry point. From there
 * Node's own resolution finds the Pi runtime in `dist/node_modules` — which
 * is inside the archive, and is read through Electron's own file API.
 *
 * The shim is CommonJS on purpose: it is the one file that Electron forks,
 * and it must not depend on the module graph it is bootstrapping.
 *
 * It is also **copied verbatim**, never compiled. TypeScript's CommonJS
 * transform rewrites `import(specifier)` into `require(specifier)`, which
 * would make the shim load the ES module through the CommonJS loader and
 * fail with "Cannot find module 'file:///…'". Copying the source keeps the
 * real dynamic import — the only thing that can load ESM.
 *
 * The entry point's location is **given**, not guessed. The shim is
 * unpacked onto the disk while the entry point stays inside the archive, so
 * the two are in different places and the entry point is not the shim's
 * neighbour. The main process knows where the archive is, and passes the
 * entry point's URL in `MINIBOTS_BACKEND_ENTRY`.
 *
 * Because it is copied rather than compiled, it cannot use TypeScript's
 * syntax: `require` and `import` are used directly, and the one Electron
 * extension it needs is read through a cast expressed in plain JavaScript.
 */
'use strict';

const { pathToFileURL } = require('node:url');
const { dirname, join } = require('node:path');

/**
 * Where the real entry point is.
 *
 * The environment names it, because in a packaged build it is inside the
 * archive while this file is on the disk. Without it — in a development run,
 * where the two really are neighbours — the entry point is found beside the
 * shim.
 */
const given = process.env.MINIBOTS_BACKEND_ENTRY;
const entry = given
  ? given
  : pathToFileURL(join(dirname(__filename), 'backend-entry.js')).href;

import(entry).catch((error) => {
  // The utility process has no console to write to, so the failure is
  // reported to the main process, which does have somewhere to put it.
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  // The utility process's channel to the main process. It is Electron's own
  // extension to `process`, so it is read through a cast.
  const parentPort = process.parentPort;
  if (parentPort) {
    parentPort.postMessage({
      type: 'backend-error',
      error: `The backend could not start: ${message}`,
    });
  }
  process.exit(1);
});
