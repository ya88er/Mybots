// @ts-check
/**
 * The packaging run.
 *
 * It builds the Windows installer and then **primes** the release directory:
 * the installer is copied out under its final name, and the checksums are
 * written beside it.
 *
 * The output directory is **per build**, for a Windows reason. A freshly
 * written archive is often opened by a scanner without `FILE_SHARE_DELETE`,
 * and such a file cannot be deleted — not even renamed. The next build then
 * fails with:
 *
 *     remove …\release\win-unpacked\resources\app.asar: The process cannot
 *     access the file because it is being used by another process.
 *
 * So every build writes into a fresh directory and the previous one is left
 * alone. The stale directory is reported rather than silently forgotten, so
 * that the disk does not fill up unnoticed.
 *
 * Run:  npm run dist:win
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const releaseDir = join(root, 'release');

/** The build's own output directory, named after the moment it was built. */
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outputDir = join(releaseDir, `build-${stamp}`);

// ---------------------------------------------------------------------------
// The build.
// ---------------------------------------------------------------------------

const builder = join(root, 'node_modules', '.bin', 'electron-builder.cmd');

/**
 * Run electron-builder.
 *
 * On Windows the command is a `.cmd` file, which has to be run through the
 * shell; on every other platform it is a plain executable.
 */
function runBuilder() {
  const args = [
    '--win',
    '--x64',
    '--config',
    'electron-builder.yml',
    '--config.directories.output',
    outputDir,
  ];
  const isWindows = process.platform === 'win32';
  const result = spawnSync(isWindows ? builder : builder, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWindows,
  });
  if (result.status !== 0) {
    throw new Error('The packaging failed.');
  }
}

/**
 * Clear the previous build directories.
 *
 * A directory that Windows will not let go is **kept** and reported: it is
 * usually a scanner's handle, and it clears on its own within a minute or
 * two. Forcing it would be worse than leaving it.
 */
function clearOldBuilds() {
  const kept = [];
  for (const entry of readdirSync(releaseDir)) {
    if (!entry.startsWith('build-')) continue;
    const directory = join(releaseDir, entry);
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
    } catch {
      kept.push(entry);
    }
  }
  if (kept.length) {
    // eslint-disable-next-line no-console
    console.log(
      `[minibots] ${kept.length} earlier build directory(ies) are still locked by Windows and were kept: ${kept.join(', ')}`,
    );
  }
}

mkdirSync(releaseDir, { recursive: true });
clearOldBuilds();

// eslint-disable-next-line no-console
console.log(`[minibots] packaging into ${outputDir}`);
runBuilder();

// ---------------------------------------------------------------------------
// The release directory.
// ---------------------------------------------------------------------------

/** The installer that was built. */
function findInstaller(directory) {
  for (const entry of readdirSync(directory)) {
    if (entry.startsWith('MiniBots-Setup') && entry.endsWith('.exe')) {
      return join(directory, entry);
    }
  }
  return undefined;
}

const built = findInstaller(outputDir);
if (!built) {
  throw new Error('The packaging finished but produced no installer.');
}

// The installer is copied under its final name, so that the release
// directory holds one obvious artifact.
const installerName = 'MiniBots-Setup-0.1.0-x64.exe';
const installer = join(releaseDir, installerName);
copyFileSync(built, installer);

// The checksums are written beside the installer, in the format
// `sha256sum` understands.
const digest = createHash('sha256').update(readFileSync(installer)).digest('hex');
const size = statSync(installer).size;
writeFileSync(
  join(releaseDir, 'SHA256SUMS.txt'),
  `${digest}  ${installerName}\n`,
  'utf8',
);

// eslint-disable-next-line no-console
console.log(`\n[minibots] the installer is ${installer}`);
console.log(`[minibots]   ${size} bytes`);
console.log(`[minibots]   sha256 ${digest}`);
console.log(`[minibots] the checksums are in ${join(releaseDir, 'SHA256SUMS.txt')}`);
