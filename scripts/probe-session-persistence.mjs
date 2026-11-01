// Shows when a Pi session file actually appears on disk.
//
// Observed result: a session file is written only once the session has
// content. An empty session leaves nothing behind. That is why the app keeps
// its own application-session to Pi-file association and persists it before
// it acknowledges a turn.
//
// Run:  node scripts/probe-session-persistence.mjs
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, createAgentSession } from '@earendil-works/pi-coding-agent';

const dir = await mkdtemp(join(tmpdir(), 'pi-persist-probe-'));
const list = async (label) => {
  const files = await readdir(dir).catch(() => []);
  console.log(`${label}: ${JSON.stringify(files)}`);
};

console.log('=== newSession() only ===');
const manager = SessionManager.create(dir, dir);
const file = manager.newSession();
console.log('newSession ->', file);
console.log('getSessionId ->', manager.getSessionId());
await list('files after newSession');

console.log('\n=== after createAgentSession ===');
const { session } = await createAgentSession({
  cwd: dir,
  agentDir: dir,
  sessionManager: SessionManager.create(dir, dir),
});
await list('files after createAgentSession');
session.dispose();
await list('files after dispose');

console.log('\n=== is a .jsonl session file present? ===');
const files = await readdir(dir).catch(() => []);
const jsonl = files.find((f) => f.endsWith('.jsonl'));
console.log(jsonl
  ? `yes: ${jsonl}`
  : 'no — an empty session writes nothing, so the app must persist its own association');

await rm(dir, { recursive: true, force: true }).catch(() => {});
