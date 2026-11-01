// @ts-check
/**
 * The build.
 *
 * The app's own code is TypeScript. The vendored Mini App is plain
 * JavaScript and is copied as it is.
 *
 * Two outputs matter:
 *
 * - `dist/main/main.js` — the Electron main process.
 * - `dist/backend/backend-entry.js` — the utility process's entry point.
 *
 * The preload is emitted separately as CommonJS (`preload.cjs`), because a
 * sandboxed preload is loaded as a CommonJS script.
 *
 * The upstream Mini App is **not** compiled: it is copied verbatim, so the
 * vendored subtree stays byte-identical to the pinned upstream commit.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

/** The TypeScript compiler's own entry point. */
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

/**
 * Compile the app's TypeScript.
 *
 * The main config emits ESM into `dist`; the preload is compiled separately
 * as CommonJS because Electron loads a sandboxed preload that way.
 */
function compile() {
  const result = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error('The TypeScript build failed.');
  }
}

/** Copy the vendored Mini App's client assets next to the app. */
function copyClient() {
  const source = join(root, 'vendor', 'minimax-bot', 'miniapp', 'client');
  const target = join(dist, 'client');
  if (!existsSync(source)) {
    throw new Error('The vendored Mini App client was not found.');
  }
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true });
}

/**
 * Copy the vendored Mini App's node modules next to the app.
 *
 * The backend utility process imports them by relative path, so they have to
 * sit where the source expects them.
 */
function copyMiniApp() {
  const source = join(root, 'vendor', 'minimax-bot');
  const target = join(dist, 'vendor', 'minimax-bot');
  mkdirSync(target, { recursive: true });
  for (const entry of ['miniapp', '.minimax-plugin']) {
    const from = join(source, entry);
    if (!existsSync(from)) continue;
    cpSync(from, join(target, entry), { recursive: true });
  }
}

/** Copy the runtime assets Pi needs, unpacked from any archive. */
function copyRuntimeAssets() {
  const source = join(root, 'node_modules', '@earendil-works');
  const target = join(dist, 'vendor', 'node_modules', '@earendil-works');
  if (!existsSync(source)) return;
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source)) {
    const from = join(source, entry);
    if (!statSync(from).isDirectory()) continue;
    cpSync(from, join(target, entry), { recursive: true });
  }
}

/** Copy the app's own pages next to the app. */
function copyAppUi() {
  const source = join(root, 'src', 'app-ui');
  const target = join(dist, 'app');
  if (!existsSync(source)) {
    throw new Error('The app\'s own pages were not found.');
  }
  mkdirSync(target, { recursive: true });
  for (const entry of ['index.html', 'app.css', 'app.js', 'strings.js']) {
    const from = join(source, entry);
    if (!existsSync(from)) continue;
    cpSync(from, join(target, entry));
  }
}

/**
 * Compile the preload separately, as CommonJS.
 *
 * A sandboxed preload is loaded as a CommonJS script, so it cannot be part of
 * the ESM build. It is compiled on its own with `module: CommonJS`, and the
 * emitted file is named `preload.cjs` — which is the name the main process
 * expects.
 */
function compilePreload() {
  const result = spawnSync(
    process.execPath,
    [
      tsc,
      '--outDir', join(dist, 'main'),
      '--rootDir', join(root, 'src', 'main'),
      '--module', 'CommonJS',
      '--moduleResolution', 'Node10',
      '--target', 'ES2022',
      '--skipLibCheck',
      '--sourceMap',
      '--esModuleInterop',
      '--strict',
      join(root, 'src', 'main', 'preload.ts'),
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error('The preload build failed.');
  }
  // TypeScript emits `preload.js` for a `.ts` source in CommonJS mode; the
  // name the main process expects is `preload.cjs`.
  const emitted = join(dist, 'main', 'preload.js');
  const renamed = join(dist, 'main', 'preload.cjs');
  if (!existsSync(emitted)) {
    throw new Error('The preload was not emitted.');
  }
  renameSync(emitted, renamed);
}

/** Remove the previous build. */
function clean() {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
}

clean();
compile();
compilePreload();
copyClient();
copyAppUi();
copyMiniApp();
copyRuntimeAssets();

// eslint-disable-next-line no-console
console.log('The build is ready in dist/.');
