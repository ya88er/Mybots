// One-off importer: copies the pinned upstream MiniBots subtree into vendor/minimax-bot.
// Run once from the repo root: node scripts/import-upstream.mjs
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SOURCE = 'C:\\Users\\book\\AppData\\Local\\Temp\\minibots-upstream-20261101\\plugins\\minimax-ai\\minimax-bot';
const DEST = resolve('vendor', 'minimax-bot');

const SKIP_DIRS = new Set(['node_modules', '.git']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

if (!existsSync(SOURCE)) {
  console.error(`upstream source missing: ${SOURCE}`);
  process.exit(1);
}

mkdirSync(DEST, { recursive: true });

const files = walk(SOURCE);
let copied = 0;
let bytes = 0;

for (const file of files) {
  const target = join(DEST, relative(SOURCE, file));
  mkdirSync(dirname(target), { recursive: true });
  cpSync(file, target, { force: true });
  copied += 1;
  bytes += statSync(target).size;
}

// The upstream subtree carries its own .gitignore; keep it but make the vendored copy explicit.
console.log(`imported ${copied} files (${bytes} bytes) -> ${DEST}`);
