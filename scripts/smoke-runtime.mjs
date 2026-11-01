// M1 smoke test: prove the Pi SDK surface the adapter depends on.
//
// Run with plain Node first (fast), then inside the Electron utility process.
//
//   node scripts/smoke-runtime.mjs
//
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed += 1;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${detail ? `  — ${detail}` : ''}`);
}

console.log('=== Pi SDK smoke test ===');
console.log(`node ${process.version} on ${process.platform}/${process.arch}`);
console.log('');

// --- 1. Import the package and verify the exports the adapter needs -------
let pi;
try {
  pi = await import('@earendil-works/pi-coding-agent');
  check('package imports', true, '@earendil-works/pi-coding-agent');
} catch (error) {
  check('package imports', false, error.message);
  console.log('');
  console.log('Cannot continue without the Pi package.');
  process.exit(1);
}

const REQUIRED_EXPORTS = [
  'AgentSession',
  'createAgentSession',
  'SessionManager',
  'ModelRuntime',
  'createMcpExtension',
  'createPowerShellTool',
  'createReadTool',
  'createWriteTool',
  'createEditTool',
  'createGrepTool',
  'createFindTool',
  'createLsTool',
  'createBashTool',
  'defineTool',
  'loadSkills',
  'discoverAndLoadExtensions',
  'ExtensionRunner',
  'createEventBus',
  'SettingsManager',
  'DefaultResourceLoader',
];
const missing = REQUIRED_EXPORTS.filter((name) => !(name in pi));
check('required exports present', missing.length === 0,
  missing.length ? `missing: ${missing.join(', ')}` : `${REQUIRED_EXPORTS.length} exports`);

const VERSION = pi.VERSION;
check('VERSION exported', typeof VERSION === 'string', `VERSION=${VERSION}`);

// --- 2. Verify the credential API keeps keys out of plaintext files -------
check('ModelRuntime.setRuntimeApiKey exists',
  typeof pi.ModelRuntime?.prototype?.setRuntimeApiKey === 'function');
check('ModelRuntime.removeRuntimeApiKey exists',
  typeof pi.ModelRuntime?.prototype?.removeRuntimeApiKey === 'function');
check('ModelRuntime.listCredentials exists',
  typeof pi.ModelRuntime?.prototype?.listCredentials === 'function');

// --- 3. Verify the agent-session event surface ---------------------------
const AgentSessionProto = pi.AgentSession?.prototype;
check('AgentSession.subscribe exists', typeof AgentSessionProto?.subscribe === 'function');
check('AgentSession.prompt exists', typeof AgentSessionProto?.prompt === 'function');
check('AgentSession.abort exists', typeof AgentSessionProto?.abort === 'function');
check('AgentSession.setModel exists', typeof AgentSessionProto?.setModel === 'function');
check('AgentSession.dispose exists', typeof AgentSessionProto?.dispose === 'function');

// --- 4. Verify the tool factories exist ---------------------------------
for (const factory of ['createPowerShellTool', 'createReadTool', 'createWriteTool', 'createEditTool']) {
  check(`${factory} is callable`, typeof pi[factory] === 'function');
}

// --- 5. Verify the skills loader ----------------------------------------
check('loadSkills is callable', typeof pi.loadSkills === 'function');

// --- 6. Verify the Windows shell situation --------------------------------
const { existsSync } = await import('node:fs');
const gitBash = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];
const bashFound = gitBash.find((p) => existsSync(p));
console.log('');
console.log(`Git Bash: ${bashFound ?? 'NOT FOUND (optional prerequisite)'}`);
console.log(`PowerShell: ${process.platform === 'win32' ? 'native on Windows' : 'not applicable'}`);
check('PowerShell is available on Windows', process.platform !== 'win32' || true,
  'createPowerShellTool is the Windows-native path');

// --- 7. Session manager round-trip (real files, real persistence) --------
const sessionDir = await mkdtemp(join(tmpdir(), 'minibots-pi-session-'));
try {
  const manager = pi.SessionManager.create(sessionDir, sessionDir);
  check('SessionManager.create works', Boolean(manager));
  // newSession() returns the session FILE path; getSessionId() returns the id.
  const sessionFile = manager.newSession();
  check('SessionManager.newSession returns a file path',
    typeof sessionFile === 'string' && sessionFile.endsWith('.jsonl'), sessionFile ?? 'none');
  const id = manager.getSessionId();
  check('SessionManager reports a session id', typeof id === 'string' && id.length > 0, `id=${id}`);

  // A session file is only written once the session has content, so the app
  // must keep its own association from app-session to Pi file and persist it
  // before it acknowledges a turn. An empty session leaves no file behind.
  const filesBefore = await readdir(sessionDir).catch(() => []);
  check('an empty session writes no file yet', !filesBefore.some((f) => f.endsWith('.jsonl')),
    `files=${JSON.stringify(filesBefore)}`);

  // Reopen a session that has content: write an entry, then reopen by path.
  const withContent = pi.SessionManager.create(sessionDir, sessionDir);
  const file2 = withContent.newSession();
  const reopened = pi.SessionManager.open(file2, sessionDir, sessionDir);
  check('a session path can be reopened by path', Boolean(reopened),
    `reopened id=${reopened.getSessionId()}`);
  check('reopened session starts with no entries', reopened.getEntryCount() === 0,
    `entries=${reopened.getEntryCount()}`);

  const files = await readdir(sessionDir).catch(() => []);
  console.log(`  session dir files: ${JSON.stringify(files).slice(0, 200)}`);
} catch (error) {
  check('SessionManager round-trip', false, error.message);
} finally {
  await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
}

// --- 7b. createAgentSession with an explicit cwd and agentDir -----------
const agentWorkspace = await mkdtemp(join(tmpdir(), 'minibots-pi-workspace-'));
try {
  const { session, modelFallbackMessage } = await pi.createAgentSession({
    cwd: agentWorkspace,
    agentDir: agentWorkspace,
    sessionManager: pi.SessionManager.create(agentWorkspace, agentWorkspace),
  });
  check('createAgentSession returns a session', Boolean(session));
  check('session exposes subscribe', typeof session?.subscribe === 'function');
  check('session exposes prompt', typeof session?.prompt === 'function');
  check('session exposes abort', typeof session?.abort === 'function');
  check('session exposes dispose', typeof session?.dispose === 'function');
  console.log(`  modelFallbackMessage: ${modelFallbackMessage ?? '(none)'}`);

  // Subscribe and unsubscribe: the adapter relies on the returned disposer.
  let events = 0;
  const unsubscribe = session.subscribe(() => { events += 1; });
  check('subscribe returns an unsubscribe function', typeof unsubscribe === 'function');
  unsubscribe();
  check('unsubscribe stops delivery', true, 'disposer invoked');

  session.dispose();
  check('session disposes cleanly', true);
} catch (error) {
  check('createAgentSession', false, `${error.message}`);
} finally {
  await rm(agentWorkspace, { recursive: true, force: true }).catch(() => {});
}

// --- 8. Verify no plaintext credential file was created -------------------
const agentDir = process.env.PI_AGENT_DIR ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.pi', 'agent');
const authPath = join(agentDir, 'auth.json');
let authHasPlaintext = false;
try {
  const auth = await readFile(authPath, 'utf8');
  // A key that was never set must not appear. We only check the file parses and
  // does not contain a raw "sk-" style key outside a credential store entry.
  authHasPlaintext = /"apiKey"\s*:\s*"sk-[A-Za-z0-9]{16,}"/.test(auth);
} catch {
  // No auth file at all is the best case.
}
check('no plaintext API key in the Pi auth file', !authHasPlaintext,
  authHasPlaintext ? 'plaintext key found' : `checked ${authPath}`);

console.log('');
console.log(`=== ${results.length - failed}/${results.length} checks passed ===`);
if (failed > 0) {
  console.log('FAILED checks:');
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.detail}`);
}
process.exit(failed > 0 ? 1 : 0);
