import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { evaluateCommand, evaluateDeploy, evaluateMerge, resolveInside, safeProcessEnv } from '../public/coding-policy.mjs';
import {
  buildContext, probeCodingHosts, resumeCodingTask, rollbackWorkspace, runCodingTask, selectProvider, toolCallsFromContent
} from '../public/coding-runtime.mjs';
import { LIMITS } from '../public/coding-policy.mjs';

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'octa-repo-'));
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  }
  sh('git', ['init'], dir);
  sh('git', ['add', '-A'], dir);
  sh('git', ['commit', '-m', 'init'], dir);
  return dir;
}

const ADD = {
  'package.json': JSON.stringify({ name: 'add', version: '1.0.0', scripts: { test: 'node test.js' } }),
  'src/add.js': 'function add(a, b) { return a - b; }\nmodule.exports = { add };\n',
  'test.js': "const assert = require('assert');\nconst { add } = require('./src/add.js');\nassert.strictEqual(add(2, 3), 5);\nconsole.log('ok');\n",
  '.gitignore': '.env\nnode_modules\n'
};

function wsRoot() { return mkdtempSync(join(tmpdir(), 'octa-ws-')); }

async function run(repo, extra) {
  const provider = extra.provider || await selectProvider({ engine: 'fixture', model: extra.mode || 'repair', allowFixture: true });
  return runCodingTask({
    id: extra.id || 'ct-' + Math.random().toString(16).slice(2),
    title: extra.title || 'fix add',
    prompt: extra.prompt || 'make add return a sum',
    criteria: extra.criteria || '測試要通過',
    engine: 'fixture',
    model: extra.mode || 'repair',
    maxRepairs: extra.maxRepairs,
    repoPath: repo,
    workspacesRoot: extra.workspacesRoot || wsRoot(),
    provider,
    commandTimeoutMs: extra.commandTimeoutMs,
    pauseAfter: extra.pauseAfter,
    onPhase: extra.onPhase,
    isCancelled: extra.isCancelled,
    signal: extra.signal,
    persist: extra.persist
  });
}

test('ollama, opencode, unity, and unreal are unavailable in this environment', async () => {
  const hosts = await probeCodingHosts({ timeoutMs: 400 });
  assert.equal(hosts.ollama.available, false);
  assert.equal(hosts.opencode.available, false);
  assert.equal(hosts.unity.available, false);
  assert.equal(hosts.unreal.available, false);
  assert.equal(hosts.node.available, true);
  assert.match(hosts.ollama.reason, /Ollama/);
});

test('fixture provider is refused unless explicitly enabled', async () => {
  const off = await selectProvider({ engine: 'fixture', model: 'repair', allowFixture: false });
  assert.equal(off.available, false);
  const on = await selectProvider({ engine: 'fixture', model: 'repair', allowFixture: true });
  assert.equal(on.available, true);
});

test('json tool-call fallback parses writes and ignores a bare success claim', () => {
  const ok = toolCallsFromContent('Done.\n{"writes":[{"path":"src/add.js","content":"module.exports={add:(a,b)=>a+b}"}]}');
  assert.equal(ok.fallback, 'json-writes');
  assert.equal(ok.toolCalls[0].name, 'write_file');
  const talk = toolCallsFromContent('SUCCESS all tests passed');
  assert.equal(talk.fallback, 'no-tool-call');
  assert.equal(talk.toolCalls.length, 0);
});

test('a task fixes a project in an isolated worktree and reviews the real diff', async () => {
  const repo = makeRepo(ADD);
  const seen = [];
  const provider = await selectProvider({ engine: 'fixture', model: 'repair', allowFixture: true });
  const wrapped = { ...provider, async complete(ctx) { seen.push(ctx); return provider.complete(ctx); } };
  const state = await run(repo, { provider: wrapped, criteria: '測試要通過' });
  assert.equal(state.status, 'tested');
  assert.equal(state.testsPassed, true);
  assert.equal(state.complete, true);
  assert.equal(state.deployed, false);
  assert.equal(state.merged, false);
  assert.equal(state.acceptance, 'met');
  assert.equal(state.repairs, 1);
  assert.equal(state.tests.length, 2);
  assert.equal(state.tests[0].passed, false);
  assert.equal(state.tests[1].passed, true);
  assert.equal(state.tests[0].cmd, state.tests[1].cmd);
  assert.match(state.tests[0].stderr + state.tests[0].stdout, /ERR_ASSERTION|strictEqual|5/);
  assert.ok(seen.some(c => c.phase === 'edit' && c.failures?.length), 'repair saw the real failure');
  assert.match(state.diff, /a \+ b/);
  assert.ok(state.events.some(e => e.role === 'reviewer' && e.kind === 'diff'));
  assert.match(readFileSync(join(repo, 'src/add.js'), 'utf8'), /a - b/);
  assert.equal(sh('git', ['status', '--porcelain'], repo).trim(), '');
  assert.equal(state.deployGate.allowed, false);
  assert.equal(state.mergeGate.executed, false);
  const rb = await rollbackWorkspace(state);
  assert.equal(rb.removed, true);
  assert.equal(existsSync(state.worktree), false);
  rmSync(repo, { recursive: true, force: true });
});

test('an extra acceptance line stays open when only the test exit code is proven', async () => {
  const repo = makeRepo(ADD);
  const state = await run(repo, { criteria: '測試要通過\n解釋為什麼這樣改' });
  assert.equal(state.testsPassed, true);
  assert.equal(state.status, 'tested');
  assert.equal(state.complete, false);
  assert.equal(state.criteria[1].met, false);
  rmSync(repo, { recursive: true, force: true });
  rmSync(join(state.worktree, '..'), { recursive: true, force: true });
});

test('a model success message does not complete a failing task', async () => {
  const repo = makeRepo(ADD);
  const state = await run(repo, { mode: 'talk-only', maxRepairs: 0 });
  assert.equal(state.status, 'failed');
  assert.equal(state.complete, false);
  assert.equal(state.testsPassed, false);
  assert.equal(state.reason, 'retry_limit');
  assert.match(JSON.stringify(state.events), /SUCCESS/);
  rmSync(repo, { recursive: true, force: true });
});

test('retry limit stops further repairs and reruns the test each time', async () => {
  const repo = makeRepo(ADD);
  const state = await run(repo, { mode: 'always-wrong', maxRepairs: 3 });
  assert.equal(state.status, 'failed');
  assert.equal(state.reason, 'retry_limit');
  assert.equal(state.repairs, 3);
  assert.equal(state.tests.length, 4);
  assert.ok(state.tests.every(t => t.passed === false));
  rmSync(repo, { recursive: true, force: true });
});

test('identical repairs are treated as stalled', async () => {
  const repo = makeRepo(ADD);
  const state = await run(repo, { mode: 'stall', maxRepairs: 3 });
  assert.equal(state.reason, 'stalled');
  assert.equal(state.status, 'failed');
  assert.equal(state.tests.length, 1);
  rmSync(repo, { recursive: true, force: true });
});

test('cancellation stops the edit that would have followed the plan', async () => {
  const repo = makeRepo(ADD);
  let stop = false;
  let edits = 0;
  const provider = {
    id: 'watch', available: true, toolCalls: true,
    async complete(ctx) {
      if (ctx.phase === 'edit') edits++;
      return ctx.phase === 'plan'
        ? { text: 'plan only', toolCalls: [] }
        : { text: 'should not run', toolCalls: [{ name: 'write_file', args: { path: 'src/add.js', content: 'nope' } }] };
    }
  };
  const state = await run(repo, {
    provider,
    onPhase: async phase => { if (phase === 'planned') stop = true; },
    isCancelled: () => stop
  });
  assert.equal(state.status, 'cancelled');
  assert.equal(edits, 0);
  assert.equal(state.files.length, 0);
  assert.match(readFileSync(join(repo, 'src/add.js'), 'utf8'), /a - b/);
  rmSync(repo, { recursive: true, force: true });
});

test('paused state on disk resumes and still uses the saved task', async () => {
  const repo = makeRepo(ADD);
  const root = wsRoot();
  const paused = await run(repo, { pauseAfter: 'first-failure', workspacesRoot: root, id: 'ct-resume' });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.tests.length, 1);
  assert.equal(paused.tests[0].passed, false);
  const file = paused.stateFile;
  const disk = JSON.parse(readFileSync(file, 'utf8'));
  disk.note = 'from-disk';
  writeFileSync(file, JSON.stringify(disk));
  const provider = await selectProvider({ engine: 'fixture', model: 'repair', allowFixture: true });
  const done = await resumeCodingTask(file, { workspacesRoot: root, repoPath: repo, provider, maxRepairs: 3 });
  assert.equal(done.note, 'from-disk');
  assert.equal(done.status, 'tested');
  assert.ok(done.tests.length >= 2);
  assert.equal(done.tests.at(-1).passed, true);
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test('paths outside the worktree and secret files cannot be read or written', async () => {
  const repo = makeRepo(ADD);
  const root = wsRoot();
  const outside = join(root, 'outside.txt');
  const state = await run(repo, { mode: 'escape', workspacesRoot: root, id: 'ct-escape' });
  assert.equal(state.status, 'failed');
  assert.equal(state.reason, 'policy');
  assert.equal(existsSync(outside), false);
  assert.equal(existsSync(join(root, 'ctescape', 'outside.txt')), false);
  const blob = JSON.stringify(state);
  assert.doesNotMatch(blob, /root:x:0:0/);
  assert.ok(state.events.some(e => e.role === 'policy'));
  const wt = state.worktree;
  writeFileSync(join(wt, '.env'), 'API_TOKEN=super-secret-token-value\n');
  writeFileSync(join(wt, 'notes.txt'), 'token=super-secret-token-value\n');
  symlinkSync('/etc/passwd', join(wt, 'escape-link'));
  assert.throws(() => resolveInside(wt, '../outside.txt'));
  assert.throws(() => resolveInside(wt, '/etc/passwd'));
  assert.throws(() => resolveInside(wt, '.env'));
  assert.throws(() => resolveInside(wt, 'escape-link'));
  const ctx = buildContext(wt);
  assert.doesNotMatch(ctx, /super-secret-token-value/);
  assert.ok(ctx.length <= LIMITS.maxContextChars);
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test('weakening or deleting a test is rejected', async () => {
  const repo = makeRepo(ADD);
  const state = await run(repo, { mode: 'weaken' });
  assert.equal(state.reason, 'policy');
  assert.match(readFileSync(join(state.worktree, 'test.js'), 'utf8'), /strictEqual/);
  assert.doesNotMatch(readFileSync(join(state.worktree, 'test.js'), 'utf8'), /process\.exit/);
  rmSync(repo, { recursive: true, force: true });
});

test('a second writer cannot take the same worktree', async () => {
  const repo = makeRepo(ADD);
  const root = wsRoot();
  let release;
  const gate = new Promise(r => { release = r; });
  let seen = null;
  const provider = await selectProvider({ engine: 'fixture', model: 'repair', allowFixture: true });
  const first = run(repo, {
    id: 'ct-lock', workspacesRoot: root, provider,
    onPhase: async (phase, s) => { if (phase === 'editing' && !seen) { seen = s; await gate; } }
  });
  while (!seen) await new Promise(r => setTimeout(r, 15));
  const second = await runCodingTask({
    resume: { ...JSON.parse(JSON.stringify(seen)), id: 'ct-other', status: 'paused', needsEdit: true },
    workspacesRoot: root, repoPath: repo, provider, maxRepairs: 3
  });
  assert.equal(second.reason, 'worktree_busy');
  release();
  const done = await first;
  assert.equal(done.status, 'tested');
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test('hung tests stop on timeout instead of being reported as passed', async () => {
  const repo = makeRepo({
    'package.json': JSON.stringify({ name: 'sleep', scripts: { test: 'node sleep.js' } }),
    'sleep.js': 'setInterval(() => {}, 1000);\n'
  });
  const provider = { id: 'noop', available: true, async complete(ctx) { return { text: ctx.phase === 'plan' ? 'plan' : 'no edit', toolCalls: [] }; } };
  const state = await run(repo, { provider, commandTimeoutMs: 700, maxRepairs: 3 });
  assert.equal(state.reason, 'timeout');
  assert.equal(state.status, 'failed');
  assert.equal(state.testsPassed, false);
  assert.equal(state.tests.length, 1);
  rmSync(repo, { recursive: true, force: true });
});

test('unity and unreal projects are blocked when those tools are missing', async () => {
  const repo = makeRepo({ 'Game.uproject': '{}\n', 'README.md': 'game\n' });
  const state = await run(repo, { mode: 'pass-first' });
  assert.equal(state.status, 'blocked');
  assert.equal(state.reason, 'unreal_unavailable');
  assert.equal(state.testsPassed, false);
  assert.equal(state.files.length, 0);
  rmSync(repo, { recursive: true, force: true });
});

test('command policy denies shell, installs, pushes, and production deploy', () => {
  const root = mkdtempSync(join(tmpdir(), 'octa-pol-'));
  const ctx = { root, cwd: root, scripts: { test: 'node test.js', deploy: 'wrangler pages deploy' } };
  assert.equal(evaluateCommand(['npm', 'test'], ctx).allow, true);
  assert.equal(evaluateCommand(['node', 'test.js'], ctx).allow, true);
  assert.equal(evaluateCommand(['curl', 'https://example.com'], ctx).allow, false);
  assert.equal(evaluateCommand(['rm', '-rf', '.'], ctx).allow, false);
  assert.equal(evaluateCommand(['bash', '-c', 'echo hi'], ctx).allow, false);
  assert.equal(evaluateCommand(['npm', 'install', 'left-pad'], ctx).needsApproval, 'dependencies');
  assert.equal(evaluateCommand(['git', 'push', 'origin', 'main'], ctx).needsApproval, 'git');
  assert.equal(evaluateCommand(['wrangler', 'pages', 'deploy'], ctx).needsApproval, 'deploy');
  assert.equal(evaluateCommand(['npm', 'run', 'deploy'], ctx).needsApproval, 'deploy');
  assert.equal(evaluateDeploy(null).allowed, false);
  assert.equal(evaluateDeploy({ deploy: { allow: true, target: 'production', by: 'model' } }).allowed, false);
  const approved = evaluateDeploy({ deploy: { allow: true, target: 'production', by: 'user' } });
  assert.equal(approved.allowed, true);
  assert.equal(approved.executed, false);
  assert.equal(approved.deployed, false);
  assert.equal(evaluateMerge({ merge: { allow: true, by: 'user' } }).executed, false);
  process.env.OCTA_SECRET_TOKEN = 'super-secret-token-value';
  const env = safeProcessEnv();
  assert.equal(env.OCTA_SECRET_TOKEN, undefined);
  assert.equal('PATH' in env, true);
  rmSync(root, { recursive: true, force: true });
});

test('simulated quota switches once and does not repeat the finished edit', async () => {
  const repo = makeRepo(ADD);
  let primaryCalls = 0;
  const primary = {
    id: 'primary', available: true, toolCalls: true, label: 'simulated primary',
    async complete(ctx) {
      primaryCalls++;
      if (ctx.phase === 'plan') return { text: '計畫：只改 src/add.js', toolCalls: [] };
      if (!(ctx.failures || []).length) {
        return { text: 'first edit', toolCalls: [{ name: 'write_file', args: { path: 'src/add.js', content: 'function add(a, b) { return a + b + 1; }\nmodule.exports = { add };\n' } }] };
      }
      return { errorClass: 'quota', text: 'usage limit exceeded' };
    }
  };
  const backup = await selectProvider({ engine: 'fixture', model: 'repair', allowFixture: true });
  let backupCalls = 0;
  const wrapped = { ...backup, async complete(ctx) { backupCalls++; return backup.complete(ctx); } };
  const state = await runCodingTask({
    id: 'ct-route-quota', title: 'fix', prompt: 'sum', criteria: '測試要通過',
    engine: 'claude', model: 'primary', repoPath: repo, workspacesRoot: wsRoot(),
    provider: primary,
    routeChain: [{ engine: 'claude', model: 'primary' }, { engine: 'fixture', model: 'repair' }],
    providerFor: async () => wrapped
  });
  assert.equal(state.status, 'tested');
  assert.equal(state.complete, true);
  assert.ok(state.modelSwitches.some(s => s.kind === 'quota' && s.action === 'switch'));
  assert.equal(primaryCalls, 3);
  assert.equal(backupCalls, 1);
  assert.equal(state.files.filter(f => f.path === 'src/add.js').length, 2);
  assert.match(readFileSync(join(repo, 'src/add.js'), 'utf8'), /a - b/);
  rmSync(repo, { recursive: true, force: true });
});

test('simulated execution and auth failures do not switch models', async () => {
  const repo = makeRepo(ADD);
  let calls = 0;
  let hops = 0;
  const primary = {
    id: 'primary', available: true, toolCalls: true,
    async complete(ctx) {
      calls++;
      if (ctx.phase === 'plan') return { text: '計畫', toolCalls: [] };
      return { errorClass: 'execution', text: 'AssertionError in test.js' };
    }
  };
  const state = await runCodingTask({
    id: 'ct-route-exec', title: 'fix', prompt: 'sum', criteria: '測試要通過',
    engine: 'claude', model: '', repoPath: repo, workspacesRoot: wsRoot(), provider: primary,
    routeChain: [{ engine: 'claude', model: '' }, { engine: 'gemini', model: '' }],
    providerFor: async () => { hops++; return { available: true, id: 'gemini', async complete() { return { text: 'no', toolCalls: [] }; } }; }
  });
  assert.equal(state.status, 'failed');
  assert.match(state.reason, /execution/);
  assert.equal(hops, 0);
  assert.equal(state.files.length, 0);
  assert.equal(calls, 2);
  rmSync(repo, { recursive: true, force: true });

  const repo2 = makeRepo(ADD);
  let authCalls = 0;
  const auth = { id: 'primary', available: true, async complete() { authCalls++; return { errorClass: 'auth', text: 'invalid api key' }; } };
  const stopped = await runCodingTask({
    id: 'ct-route-auth', title: 'fix', prompt: 'sum', criteria: '測試要通過',
    engine: 'claude', model: '', repoPath: repo2, workspacesRoot: wsRoot(), provider: auth,
    routeChain: [{ engine: 'claude', model: '' }, { engine: 'gemini', model: '' }],
    providerFor: async () => { throw new Error('should not switch'); }
  });
  assert.equal(authCalls, 1);
  assert.equal(stopped.status, 'failed');
  assert.match(stopped.reason, /auth/);
  assert.match(stopped.error, /API Key/);
  rmSync(repo2, { recursive: true, force: true });
});

