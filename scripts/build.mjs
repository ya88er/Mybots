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
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
 *
 * The upstream tree's **notices** are copied as well: its MIT licence, the
 * list of changes made to it, and the note that says where it came from.
 * The derived work is covered by the upstream's licence, so that licence has
 * to travel with the code.
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
  // The notices, and the metadata that goes with them.
  for (const entry of [
    'LICENSE',
    'MODIFICATIONS.md',
    'UPSTREAM.md',
    'README.md',
    'package.json',
    'icon.png',
    'servers.mcp.json',
  ]) {
    const from = join(source, entry);
    if (!existsSync(from)) continue;
    cpSync(from, join(target, entry));
  }
}

/**
 * Copy the runtime assets Pi needs, unpacked from any archive.
 *
 * They are copied to `dist/node_modules`, which is where Node's own
 * resolution expects them: the backend lives at `dist/backend/`, so a bare
 * import such as `@earendil-works/pi-coding-agent` is resolved by walking
 * up to `dist/node_modules`.
 *
 * The vendored Mini App is copied to `dist/vendor/minimax-bot`, which is
 * where the backend's own path resolution looks for it.
 */
function copyRuntimeAssets() {
  const source = join(root, 'node_modules', '@earendil-works');
  const target = join(dist, 'node_modules', '@earendil-works');
  if (!existsSync(source)) return;
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source)) {
    const from = join(source, entry);
    if (!statSync(from).isDirectory()) continue;
    cpSync(from, join(target, entry), { recursive: true });
  }
}

/**
 * Write `dist/package.json`.
 *
 * The compiled output is ESM — the sources use `import`/`export` — but a
 * `.js` file is only read as ESM when the nearest `package.json` says
 * `"type": "module"`. Without this file Node reads `dist/backend/backend-entry.js`
 * as CommonJS and refuses the `import` statements inside it with
 * "Cannot find module 'file:///…/backend-entry.js'".
 *
 * The `main` field points at the Electron entry point, so the archive's root
 * is a well-formed package.
 */
function writeDistPackageJson() {
  const target = join(dist, 'package.json');
  const contents = {
    name: 'minibots',
    version: '0.1.0',
    private: true,
    type: 'module',
    main: 'main/main.js',
  };
  writeFileSync(target, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
}

/** Copy the app's own pages next to the app. */
function copyAppUi() {
  const source = join(root, 'src', 'app');
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
 * Compile the preload as CommonJS.
 *
 * A sandboxed preload is loaded as a CommonJS script, so it cannot be part
 * of the ESM build. It is compiled on its own with `module: CommonJS`.
 *
 * The backend's shim is **not** compiled: it is copied verbatim, because the
 * CommonJS transform rewrites a dynamic `import()` into `require()`, and the
 * shim's whole job is to load an ES module. The source is already valid
 * CommonJS, so it needs no transform at all.
 */
function compileCommonJs() {
  const result = spawnSync(
    process.execPath,
    [
      tsc,
      '--outDir', dist,
      '--rootDir', join(root, 'src'),
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
  // A `.ts` source is emitted as `.js` in CommonJS mode; the app expects the
  // `.cjs` name.
  const produced = join(dist, 'main', 'preload.js');
  const target = join(dist, 'main', 'preload.cjs');
  if (!existsSync(produced)) {
    throw new Error('The preload was not emitted.');
  }
  if (produced !== target) {
    renameSync(produced, target);
  }
}

/**
 * Copy the backend's shim, unchanged.
 *
 * The shim is the one file Electron forks, so it must not depend on the
 * module graph it is bootstrapping — and it must not be transformed. The
 * CommonJS transform rewrites `import(specifier)` into `require(specifier)`,
 * which would make the shim load the ES module through the CommonJS loader
 * and fail with "Cannot find module 'file:///…'". Copying the source keeps
 * the real dynamic import, which is the only thing that can load ESM.
 */
function copyBackendShim() {
  const source = join(root, 'src', 'backend', 'backend-shim.cts');
  const target = join(dist, 'backend', 'backend-shim.cjs');
  if (!existsSync(source)) {
    throw new Error('The backend shim was not found.');
  }
  mkdirSync(join(dist, 'backend'), { recursive: true });
  cpSync(source, target);
}

/** Remove the previous build. */
function clean() {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
}

/**
 * Generate the app's icons.
 *
 * The tray icon and the taskbar icon are made from the upstream Mini App's
 * own skin, so the app and the Mini App wear the same face and the upstream
 * art keeps its notice.
 */
function makeIcons() {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'make-icons.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error('The icons could not be made.');
  }
}

/**
 * Stage the icon electron-builder builds the installer with.
 *
 * electron-builder needs a 256×256 PNG for the Windows icon, and it makes
 * the `.ico` itself. The source is the upstream skin, so it is copied rather
 * than committed.
 */
function stageBuilderIcon() {
  const source = join(
    root,
    'vendor',
    'minimax-bot',
    'miniapp',
    'client',
    'skins',
    'fuzzy.png',
  );
  const target = join(root, 'build', 'icon.png');
  if (!existsSync(source)) {
    throw new Error('The upstream skin the icon is made from was not found.');
  }
  mkdirSync(join(root, 'build'), { recursive: true });
  cpSync(source, target);
}

clean();
compile();
compileCommonJs();
copyBackendShim();
writeDistPackageJson();
stageBuilderIcon();
makeIcons();
copyClient();
copyAppUi();
copyMiniApp();
copyRuntimeAssets();

// eslint-disable-next-line no-console
console.log('The build is ready in dist/.');
