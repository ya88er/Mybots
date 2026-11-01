// @ts-check
/**
 * The checksums of the release artifacts.
 *
 * The installer is delivered as a file, and an unsigned file needs a way to
 * be checked. This script writes the SHA-256 of every artifact in `release/`
 * into `release/SHA256SUMS.txt`, in the format `sha256sum` understands.
 *
 * Run:  npm run checksums
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const releaseDir = join(root, 'release');

if (!existsSync(releaseDir)) {
  // eslint-disable-next-line no-console
  console.error('[minibots] there is no release directory; run npm run dist:win first.');
  process.exit(1);
}

/** The SHA-256 of a file. */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** The artifacts the checksums cover. */
const artifacts = readdirSync(releaseDir)
  .filter((entry) => entry.endsWith('.exe') || entry.endsWith('.zip'))
  .sort();
if (artifacts.length === 0) {
  // eslint-disable-next-line no-console
  console.error('[minibots] there is no installer in release/; run npm run dist:win first.');
  process.exit(1);
}

const lines = [];
for (const artifact of artifacts) {
  const file = join(releaseDir, artifact);
  const digest = sha256(file);
  const size = statSync(file).size;
  lines.push(`${digest}  ${artifact}`);
  // eslint-disable-next-line no-console
  console.log(`${digest}  ${artifact}  (${size} bytes)`);
}

const target = join(releaseDir, 'SHA256SUMS.txt');
writeFileSync(target, `${lines.join('\n')}\n`, 'utf8');

// eslint-disable-next-line no-console
console.log(`\nThe checksums are in ${target}`);
