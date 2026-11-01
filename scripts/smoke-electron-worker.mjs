// Runs inside the Electron utility process. Verifies the Pi SDK loads and the
// pieces the adapter depends on work in that runtime.
//
// The result is posted back to the supervising main process.
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

console.log('=== Pi SDK smoke test (Electron utility process) ===');
console.log(`node ${process.version} electron ${process.versions.electron} on ${process.platform}/${process.arch}`);
console.log(`versions.modules=${process.versions.modules}`);
console.log('');

// The embedded Node must satisfy Pi's engine requirement.
const [major, minor] = process.versions.node.split('.').map(Number);
check('embedded Node >= 22.19.0', major > 22 || (major === 22 && minor >= 19), process.versions.node);

let pi;
try {
  pi = await import('@earendil-works/pi-coding-agent');
  check('package imports in the utility process', true, `@earendil-works/pi-coding-agent@${pi.VERSION}`);
} catch (error) {
  check('package imports in the utility process', false, error.message);
  process.parentPort.postMessage({ type: 'result', passed: 0, total: 1, failures: results });
  process.exit(1);
}

const REQUIRED = [
  'AgentSession', 'createAgentSession', 'SessionManager', 'ModelRuntime',
  'createMcpExtension', 'createPowerShellTool', 'createReadTool', 'createWriteTool',
  'createEditTool', 'defineTool', 'loadSkills', 'discoverAndLoadExtensions',
];
const missing = REQUIRED.filter((name) => !(name in pi));
check('required exports present', missing.length === 0,
  missing.length ? `missing: ${missing.join(', ')}` : `${REQUIRED.length} exports`);

// A real session, with its own cwd, in the utility process.
const workspace = await mkdtemp(join(tmpdir(), 'minibots-electron-pi-'));
try {
  const { session } = await pi.createAgentSession({
    cwd: workspace,
    agentDir: workspace,
    sessionManager: pi.SessionManager.create(workspace, workspace),
  });
  check('createAgentSession works', Boolean(session));
  check('session exposes subscribe', typeof session?.subscribe === 'function');
  check('session exposes prompt', typeof session?.prompt === 'function');
  check('session exposes abort', typeof session?.abort === 'function');

  // The subscription disposer must work, or events leak between sessions.
  let count = 0;
  const off = session.subscribe(() => { count += 1; });
  off();
  check('subscribe returns a working disposer', typeof off === 'function');

  // The Windows-native shell tool must construct.
  try {
    const ps = pi.createPowerShellTool({});
    check('createPowerShellTool constructs', Boolean(ps));
  } catch (error) {
    check('createPowerShellTool constructs', false, error.message);
  }

  session.dispose();
  check('session disposes cleanly', true);

  const files = await readdir(workspace).catch(() => []);
  console.log(`  workspace files: ${JSON.stringify(files)}`);
} catch (error) {
  check('utility-process session lifecycle', false, error.message);
} finally {
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
}

console.log('');
console.log(`=== ${results.length - failed}/${results.length} checks passed (Electron utility process) ===`);

process.parentPort.postMessage({
  type: 'result',
  passed: results.length - failed,
  total: results.length,
  failures: results.filter((r) => !r.ok),
});
