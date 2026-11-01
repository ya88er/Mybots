// Verify which vendored files differ from the pinned upstream commit.
// Prints the list of modified and added files so the attribution stays honest.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SOURCE = 'C:\\Users\\book\\AppData\\Local\\Temp\\minibots-upstream-20261101\\plugins\\minimax-ai\\minimax-bot';
const DEST = resolve('vendor', 'minimax-bot');

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    if (entry.isDirectory()) walk(join(dir, entry.name), base, out);
    else if (entry.isFile()) out.push(relative(base, join(dir, entry.name)));
  }
  return out;
}

const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const sourceFiles = new Set(walk(SOURCE));
const destFiles = new Set(walk(DEST));

const modified = [];
const added = [];
const removed = [];

for (const rel of sourceFiles) {
  if (!destFiles.has(rel)) { removed.push(rel); continue; }
  if (hash(join(SOURCE, rel)) !== hash(join(DEST, rel))) modified.push(rel);
}
for (const rel of destFiles) {
  if (!sourceFiles.has(rel)) added.push(rel);
}

console.log(`upstream files: ${sourceFiles.size}`);
console.log(`vendored files: ${destFiles.size}`);
console.log('');
console.log(`MODIFIED (${modified.length}):`);
for (const rel of modified.sort()) console.log(`  ${rel}`);
console.log('');
console.log(`ADDED (${added.length}):`);
for (const rel of added.sort()) console.log(`  ${rel}`);
console.log('');
console.log(`REMOVED (${removed.length}):`);
for (const rel of removed.sort()) console.log(`  ${rel}`);

// The client must be untouched: the port preserves its layout and artwork.
const clientChanged = modified.filter((rel) => rel.startsWith('miniapp' + String.fromCharCode(92) + 'client'));
console.log('');
console.log(`client files changed: ${clientChanged.length}`);
if (clientChanged.length) for (const rel of clientChanged) console.log(`  ${rel}`);
