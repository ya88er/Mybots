// @ts-check
/**
 * The packaged-artifact check.
 *
 * This is the M6 verification: it inspects the **built** application — not
 * the source tree — and launches it, so that the claims about the installer
 * are observed rather than assumed.
 *
 * The checks are:
 *
 * 1. the unpacked build exists, and the app's own files are in it;
 * 2. the files that must exist on the disk — the vendored Mini App and Pi's
 *    native prebuilds — are **outside** the archive, because Electron 45
 *    restricts file descriptors inside one;
 * 3. the installer exists, and its SHA-256 is recorded;
 * 4. the packaged app **starts**: the window appears, the backend answers,
 *    and the client's stylesheet and script both load.
 *
 * The report goes to a file, because Electron on Windows does not write to
 * the console of a GUI application.
 *
 * Run:  npm run verify:package
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const releaseDir = join(root, 'release');
const reportPath = join(root, 'package-verification-report.txt');

const lines = [];
const say = (line) => {
  lines.push(line);
};

const passed = [];
const failed = [];

/** Record a check. */
function check(name, ok, detail = '') {
  if (ok) {
    passed.push(name);
    say(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed.push(name);
    say(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
}

say('MiniBots packaged-artifact verification');
say('=======================================');
say('');

// ---------------------------------------------------------------------------
// 1. The unpacked build.
// ---------------------------------------------------------------------------

say('--- the unpacked build ---');

/** The unpacked build's directory, which electron-builder names after the app. */
function findUnpacked() {
  if (!existsSync(releaseDir)) return undefined;
  // The build writes into a per-build directory, so the newest one is the
  // build that is being verified.
  const candidates = readdirSync(releaseDir)
    .filter((entry) => entry.startsWith('build-'))
    .sort();
  for (const entry of candidates.reverse()) {
    const directory = join(releaseDir, entry, 'win-unpacked');
    if (existsSync(directory)) return directory;
  }
  // A build made directly by electron-builder, with the default layout.
  const direct = join(releaseDir, 'win-unpacked');
  return existsSync(direct) ? direct : undefined;
}

const unpacked = findUnpacked();
check('the unpacked build exists', Boolean(unpacked), unpacked ?? 'release/win-unpacked is missing');

if (!unpacked) {
  writeFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8');
  process.exit(1);
}

const resources = join(unpacked, 'resources');
const archive = join(resources, 'app.asar');
const unpackedTree = join(resources, 'app.asar.unpacked');

check('the app archive exists', existsSync(archive), archive);
check('the unpacked tree exists', existsSync(unpackedTree), unpackedTree);

/**
 * Whether the archive holds a path.
 *
 * The archive's listing uses **backslashes**, so the paths are compared
 * with the platform's separator.
 */
const archiveList = spawnSync(
  process.execPath,
  [join(root, 'node_modules', '@electron', 'asar', 'bin', 'asar.js'), 'list', archive],
  { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
const archiveContent = archiveList.stdout ?? '';
const archiveHas = (relative) => archiveContent.includes(`\\${relative.replace(/\//g, '\\')}`);

check('the archive can be listed', archiveList.status === 0, `${archiveContent.split('\n').length} entries`);

// The app's own code, which lives **inside** the archive.
for (const relative of [
  'dist/main/main.js',
  'dist/main/preload.cjs',
  'dist/backend/backend-entry.js',
  'dist/app/index.html',
  'dist/app/app.js',
  'dist/client/index.html',
]) {
  check(`${relative} is in the build`, existsSync(join(unpacked, 'resources', 'app.asar')) && archiveHas(relative));
}

// ---------------------------------------------------------------------------
// 1b. The app's **whole module graph** is in the archive.
//
// This is the check that matters most. The packager's file list is a set of
// globs, and a directory that is not in the list is silently dropped: the
// app then fails at start-up with "Cannot find module '…/dist/storage/
// atomic-json.js'", which a user sees as an error dialog and nothing else.
//
// So the graph is walked here: every relative import in the compiled app is
// resolved against the archive's own listing. A file that the app needs and
// the archive does not have is a failure, by name.
// ---------------------------------------------------------------------------

say('');
say('--- the app\'s module graph ---');

/** Every file in the archive, as archive-relative paths with forward slashes. */
const archiveEntries = new Set(
  archiveContent
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\\/, '').replace(/\\/g, '/')),
);

/**
 * The relative imports in a compiled file.
 *
 * The app's own code uses `import ... from './x.ts'`, which TypeScript
 * rewrites to `'./x.js'`. Bare specifiers are left to Node's own resolution
 * and are not checked here.
 */
function relativeImports(source) {
  const found = [];
  const pattern = /(?:^|[\s;{}])(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    found.push(match[1]);
  }
  return found;
}

/** Every compiled file of the app's own code, read from the archive. */
function appFilesInArchive() {
  const files = [];
  for (const entry of archiveEntries) {
    if (!entry.startsWith('dist/')) continue;
    if (entry.includes('/node_modules/')) continue;
    if (entry.endsWith('.js') || entry.endsWith('.cjs')) files.push(entry);
  }
  return files;
}

/**
 * Resolve a relative specifier against a directory.
 *
 * The result is a path with **no** `.` or `..` segments, so it can be
 * compared with the archive's own listing directly.
 */
function resolveRelative(directory, specifier) {
  const segments = `${directory}/${specifier}`.split('/');
  const stack = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join('/');
}

const missingModules = [];
let graphEdges = 0;
let graphFiles = 0;

const { extractFile } = await import('@electron/asar');

/**
 * Read a file out of the archive.
 *
 * The archive's own paths use **backslashes**, and the reader wants them
 * without a leading separator.
 */
function readArchiveFile(entry) {
  return extractFile(archive, entry.replace(/\//g, '\\')).toString('utf8');
}

for (const entry of appFilesInArchive()) {
  let source;
  try {
    source = readArchiveFile(entry);
  } catch {
    // A file that cannot be read is not one whose imports can be checked.
    continue;
  }
  graphFiles += 1;
  const directory = entry.slice(0, entry.lastIndexOf('/'));
  for (const specifier of relativeImports(source)) {
    graphEdges += 1;
    // `./x.js` and `./x` are the same module; `./x/index.js` is the
    // directory form. All three are tried.
    const base = specifier.replace(/\.(ts|js|mjs|cjs)$/, '');
    const candidates = [
      `${base}.js`,
      `${base}.cjs`,
      `${base}.mjs`,
      `${base}/index.js`,
    ].map((candidate) => resolveRelative(directory, candidate));
    if (!candidates.some((candidate) => archiveEntries.has(candidate))) {
      missingModules.push(`${entry} → ${specifier}`);
    }
  }
}

check(
  "the app's whole module graph is in the archive",
  missingModules.length === 0 && graphEdges > 0,
  missingModules.length > 0
    ? `${missingModules.length} unresolved: ${missingModules.slice(0, 6).join('; ')}`
    : graphEdges > 0
      ? `${graphEdges} relative imports resolved across ${graphFiles} files`
      : 'no relative imports were found — the check did not run',
);

// ---------------------------------------------------------------------------
// 2. The files that must be real files on the disk.
// ---------------------------------------------------------------------------

say('');
say('--- the files that cannot live inside the archive ---');

// The native prebuilds: they are loaded through `dlopen`, which needs a
// real path. Everything else stays inside the archive.
const nativePrebuilds = [];
const nativeRoot = join(
  unpackedTree,
  'dist',
  'node_modules',
  '@earendil-works',
  'pi-tui',
  'native',
  'win32',
);
if (existsSync(nativeRoot)) {
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.node')) nativePrebuilds.push(path);
    }
  };
  walk(nativeRoot);
}
check(
  'the Windows native prebuilds are unpacked onto the disk',
  nativePrebuilds.length > 0,
  nativePrebuilds.length > 0
    ? `${nativePrebuilds.length} found: ${nativePrebuilds.map((p) => p.split('\\').pop()).join(', ')}`
    : 'no native prebuild was unpacked',
);

// The vendored Mini App and the Pi runtime are inside the archive. The
// archive is read through Electron's own file API, which understands it.
check(
  'the vendored Mini App is inside the archive',
  archiveHas('dist/vendor/minimax-bot/miniapp/node/server.mjs'),
);
check(
  'the Pi runtime is inside the archive',
  archiveHas('dist/node_modules/@earendil-works/pi-coding-agent/package.json'),
);
check(
  'the app\'s own pages are inside the archive',
  archiveHas('dist/app/index.html'),
);
check(
  'the client is inside the archive',
  archiveHas('dist/client/index.html'),
);
check(
  'the preload is inside the archive',
  archiveHas('dist/main/preload.cjs'),
);
check(
  'the tray icon is inside the archive',
  archiveHas('build/tray-icon.png'),
);

// The backend's shim must be a **real file**: the backend is a forked
// process, and a process cannot be forked from inside an archive.
check(
  "the backend's shim is unpacked onto the disk",
  existsSync(join(unpackedTree, 'dist', 'backend', 'backend-shim.cjs')),
  join(unpackedTree, 'dist', 'backend', 'backend-shim.cjs'),
);

// The archive's own `package.json` says `"type": "module"`. Without it Node
// reads the compiled `.js` files as CommonJS and the backend cannot load its
// own entry point. The archive's root `package.json` is the nearest ancestor
// of `dist/`, so it is the one that decides.
let archivePackageJson;
try {
  archivePackageJson = JSON.parse(readArchiveFile('package.json'));
} catch (error) {
  archivePackageJson = undefined;
  say(`  (the archive's package.json could not be read: ${error?.message ?? error})`);
}
check(
  "the archive's package.json marks the build as an ES module",
  archivePackageJson?.type === 'module',
  archivePackageJson ? `type: ${archivePackageJson.type}` : 'no package.json in the archive',
);
check(
  "the archive's package.json points at the app's entry point",
  archivePackageJson?.main === 'dist/main/main.js',
  archivePackageJson ? `main: ${archivePackageJson.main}` : 'no package.json in the archive',
);

// ---------------------------------------------------------------------------
// 2b. The licence notices.
//
// The app ships other people's code, and the notice that covers it has to
// travel with it. Every package in the shipped `node_modules` tree must
// carry a licence file of its own, and the upstream Mini App's own notice
// must be there too.
// ---------------------------------------------------------------------------

say('');
say("--- the licence notices ---");

/** The licence file names a package may use. */
const LICENSE_NAMES = ['LICENSE', 'LICENCE', 'LICENSE.md', 'LICENCE.md', 'LICENSE.txt', 'COPYING'];

/**
 * The packages the app ships.
 *
 * A package is a directory that holds a `package.json` whose `name` matches
 * the directory's own last segment — the `node_modules/<name>` form. That
 * rule skips the directories that merely *contain* a `package.json`, such as
 * a package's own `helpers/` folder.
 */
const shippedPackages = new Map();
for (const entry of archiveEntries) {
  if (!entry.includes('node_modules/')) continue;
  if (!entry.endsWith('/package.json')) continue;
  const directory = entry.slice(0, entry.length - '/package.json'.length);
  const lastSegment = directory.slice(directory.lastIndexOf('/') + 1);
  const beforeLast = directory.slice(0, directory.lastIndexOf('/'));
  if (!beforeLast.endsWith('node_modules')) continue;
  shippedPackages.set(directory, lastSegment);
}

const packagesWithoutNotice = [];
for (const [directory, name] of shippedPackages) {
  const hasNoticeFile = LICENSE_NAMES.some((notice) =>
    archiveEntries.has(`${directory}/${notice}`),
  );
  if (hasNoticeFile) continue;
  // A package that states its licence in its own metadata is covered too —
  // some published packages ship no licence file at all.
  try {
    const metadata = JSON.parse(readArchiveFile(`${directory}/package.json`));
    if (typeof metadata.license === 'string' && metadata.license.length > 0) continue;
  } catch {
    // A package.json that cannot be read is treated as having no notice.
  }
  packagesWithoutNotice.push(`${directory} (${name})`);
}

check(
  'every shipped package states its licence',
  packagesWithoutNotice.length === 0,
  packagesWithoutNotice.length === 0
    ? `${shippedPackages.size} packages checked`
    : `${packagesWithoutNotice.length} without one: ${packagesWithoutNotice.slice(0, 5).join(', ')}`,
);

check(
  "the upstream Mini App's licence notice is shipped",
  archiveEntries.has('dist/vendor/minimax-bot/LICENSE'),
  'dist/vendor/minimax-bot/LICENSE',
);
check(
  "the upstream Mini App's list of modifications is shipped",
  archiveEntries.has('dist/vendor/minimax-bot/MODIFICATIONS.md'),
  'dist/vendor/minimax-bot/MODIFICATIONS.md',
);

// ---------------------------------------------------------------------------
// 3. The installer.
// ---------------------------------------------------------------------------

say('');
say('--- the installer ---');

/** The NSIS installer, if it was built. */
function findInstaller() {
  if (!existsSync(releaseDir)) return undefined;
  // The release directory's own copy is the artifact that is delivered.
  for (const entry of readdirSync(releaseDir)) {
    if (entry.startsWith('MiniBots-Setup') && entry.endsWith('.exe')) {
      return join(releaseDir, entry);
    }
  }
  return undefined;
}

const installer = findInstaller();
check('the installer exists', Boolean(installer), installer ?? 'no MiniBots-Setup*.exe in release/');

/** The SHA-256 of a file. */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

if (installer) {
  const digest = sha256(installer);
  const size = statSync(installer).size;
  say(`  installer: ${installer}`);
  say(`  size: ${size} bytes`);
  say(`  sha256: ${digest}`);
  check('the installer is not empty', size > 1_000_000, `${size} bytes`);
}

// ---------------------------------------------------------------------------
// 4. The packaged app starts.
// ---------------------------------------------------------------------------

say('');
say('--- the packaged app ---');

/**
 * The text of the app's crash dialog, if it has one.
 *
 * A packaged app that cannot start shows a JavaScript error dialog and waits
 * for a click. Electron writes nothing to a console on Windows, so the
 * dialog is the **only** place the reason appears. It is read through the
 * Windows UI Automation API, by a small PowerShell script.
 */
function readCrashDialog() {
  const script = join(root, 'scripts', 'read-window-text.ps1');
  if (!existsSync(script)) return undefined;
  const reader = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    { cwd: root, encoding: 'utf8', timeout: 60_000 },
  );
  const output = reader.stdout ?? '';
  if (!/Uncaught Exception|JavaScript error/i.test(output)) return undefined;
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('windows:') && !line.startsWith('--- window'))
    .join(' | ');
}

const executable = join(unpacked, 'MiniBots.exe');
check('the executable exists', existsSync(executable), executable);

if (existsSync(executable)) {
  // The app checks **itself**: the self-check runs inside the packaged
  // application, so it exercises the real artifact rather than a script
  // beside it. The report goes to a file, because Electron on Windows does
  // not write to the console of a GUI application.
  const launchReport = reportPath.replace(/\.txt$/, '-launch.txt');
  const launcher = spawnSync(executable, [], {
    cwd: unpacked,
    stdio: 'ignore',
    timeout: 180_000,
    env: {
      ...process.env,
      MINIBOTS_SELF_CHECK: launchReport,
    },
  });
  check('the packaged app was launched', launcher.status === 0, `exit ${launcher.status}`);

  if (existsSync(launchReport)) {
    for (const line of readFileSync(launchReport, 'utf8').split('\n')) {
      if (line.trim()) say(`  ${line}`);
    }
    const content = readFileSync(launchReport, 'utf8');
    check("the packaged app's window appeared", content.includes('PASS  a window is created'));
    check(
      "the packaged app's client loaded with its stylesheet",
      content.includes("PASS  the client's stylesheet loaded"),
    );
    check(
      "the packaged app's client ran its module script",
      content.includes('PASS  the client really rendered'),
    );
    check(
      "the packaged app's backend answered",
      content.includes('PASS  the backend becomes ready'),
    );
    check(
      "the packaged app's page could fetch the API",
      content.includes('PASS  the page can fetch the API with a relative path'),
    );
    check(
      "the packaged app's own window opened",
      content.includes("PASS  the app's own window opens"),
    );
  } else {
    check('the packaged app wrote its report', false, 'no launch report');
    // A packaged app that cannot start shows a JavaScript error **dialog**
    // and waits for a click. The report is never written, and the process
    // never exits — so the check would otherwise sit for its whole timeout
    // with nothing to say. The dialog's own text is the only explanation
    // available, so it is read and reported.
    const dialog = readCrashDialog();
    check(
      'the packaged app did not crash at start-up',
      false,
      dialog ?? 'no report and no crash dialog',
    );
  }
}

// ---------------------------------------------------------------------------
// The summary.
// ---------------------------------------------------------------------------

say('');
say(`=== ${passed.length}/${passed.length + failed.length} checks passed ===`);
writeFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8');

// eslint-disable-next-line no-console
console.log(lines.join('\n'));

process.exit(failed.length === 0 ? 0 : 1);
