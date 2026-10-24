// Coding-task runtime. Runs on the host computer (the OCTA runner), never in the public web process.
// One task: isolated git worktree → inspect → plan → edit → test → bounded repair → diff review.
// Completion comes from command exit codes and acceptance evidence, not from a model's success text.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  LIMITS, PolicyError, clampRepairs, evaluateCommand, evaluateDeploy, evaluateMerge,
  evaluateWrite, isSecretPath, redact, resolveInside, safeProcessEnv
} from './coding-policy.mjs';
import { classifyModelFailure, decideRoute } from './model-route.mjs';

const TERMINAL = new Set(['tested', 'failed', 'cancelled', 'blocked']);
const locks = new Map();

export function tryLock(worktree, taskId) {
  const key = existsSync(worktree) ? realpathSync(worktree) : resolve(worktree);
  const cur = locks.get(key);
  if (cur && cur !== taskId) {
    const e = new Error('另一個寫入作業正在使用這個工作區');
    e.code = 'WORKTREE_BUSY';
    throw e;
  }
  locks.set(key, taskId);
  return () => { if (locks.get(key) === taskId) locks.delete(key); };
}

export function codingStatePath(workspacesRoot, id) {
  const safe = String(id || '').replace(/[^\w-]/g, '').slice(0, 80) || 'task';
  return join(workspacesRoot, safe + '.state.json');
}

export function loadCodingState(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function listRecoverableStates(workspacesRoot) {
  let names = [];
  try { names = readdirSync(workspacesRoot); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.state.json')) continue;
    try {
      const state = loadCodingState(join(workspacesRoot, n));
      if (state?.id && !TERMINAL.has(state.status)) out.push(state);
    } catch { /* skip unreadable */ }
  }
  return out;
}

function sha(s) { return createHash('sha256').update(String(s)).digest('hex').slice(0, 16); }

function runProcess(argv, { cwd, timeout = LIMITS.commandTimeoutMs, signal, env } = {}) {
  return new Promise(resolvePromise => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env: env || safeProcessEnv(), shell: false, windowsHide: true });
    } catch (e) {
      resolvePromise({ code: 127, stdout: '', stderr: e.message, timedOut: false });
      return;
    }
    const out = [], err = [];
    let timedOut = false;
    const kill = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
    const onAbort = () => kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', d => out.push(d));
    child.stderr?.on('data', d => err.push(d));
    child.on('error', e => err.push(Buffer.from(e.message)));
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolvePromise({
        code: timedOut ? 124 : (signal?.aborted ? 130 : (code ?? 1)),
        stdout: redact(Buffer.concat(out).toString('utf8')),
        stderr: redact(Buffer.concat(err).toString('utf8')),
        timedOut,
        cancelled: !!signal?.aborted
      });
    });
  });
}

function git(cwd, args, opts = {}) {
  return runProcess(['git', ...args], { cwd, timeout: opts.timeout || 30_000, signal: opts.signal });
}

function lookupBin(name) {
  const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  const p = (r.stdout || '').trim();
  return r.status === 0 && p ? p : '';
}

export async function probeOllama(fetchImpl = globalThis.fetch, timeoutMs = 400) {
  try {
    const r = await fetchImpl('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { available: false, reason: 'ollama HTTP ' + r.status, models: [] };
    const d = await r.json();
    const models = (d.models || []).map(m => m.name).filter(Boolean);
    return { available: models.length > 0, reason: models.length ? '' : 'Ollama 沒有已下載的模型', models };
  } catch {
    return { available: false, reason: '這台電腦連不到 Ollama（127.0.0.1:11434）', models: [] };
  }
}

export function probeOpencode(lookup = lookupBin) {
  const path = lookup('opencode');
  return { available: !!path, path: path || null, reason: path ? '' : '這台電腦沒有安裝 OpenCode' };
}

export async function probeCodingHosts(opts = {}) {
  const lookup = opts.lookup || lookupBin;
  const ollama = await probeOllama(opts.fetchImpl, opts.timeoutMs);
  return {
    ollama,
    opencode: probeOpencode(lookup),
    unity: { available: !!lookup('unity') || !!lookup('Unity'), reason: '這台環境沒有 Unity 編輯器' },
    unreal: { available: !!lookup('UnrealEditor') || !!lookup('RunUAT'), reason: '這台環境沒有 Unreal 建置工具' },
    node: { available: !!lookup('node'), reason: '' },
    npm: { available: !!lookup('npm'), reason: '' }
  };
}

function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

export function toolCallsFromContent(content) {
  const parsed = extractJson(content);
  if (!parsed) return { toolCalls: [], fallback: 'no-tool-call' };
  const writes = parsed.writes || parsed.edits || [];
  if (!Array.isArray(writes) || !writes.length) return { toolCalls: [], fallback: 'no-tool-call', text: parsed.plan || parsed.text || '' };
  return {
    toolCalls: writes.filter(w => w && w.path).map(w => ({ name: 'write_file', args: { path: String(w.path), content: String(w.content ?? '') } })),
    fallback: 'json-writes',
    text: parsed.plan || parsed.text || ''
  };
}

export async function ollamaChat({ model, messages, fetchImpl = globalThis.fetch, base = 'http://127.0.0.1:11434' }) {
  const tools = [{
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Replace one file inside the authorized workspace',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }
    }
  }];
  const r = await fetchImpl(base + '/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, stream: false }),
    signal: AbortSignal.timeout(LIMITS.commandTimeoutMs)
  });
  if (!r.ok) throw new Error('ollama HTTP ' + r.status);
  const d = await r.json();
  const msg = d.message || {};
  let toolCalls = (msg.tool_calls || []).map(t => ({
    name: t.function?.name,
    args: typeof t.function?.arguments === 'string' ? JSON.parse(t.function.arguments) : (t.function?.arguments || {})
  })).filter(t => t.name);
  let fallback = null;
  let text = redact(msg.content || '', 2000);
  if (!toolCalls.length && msg.content) {
    const parsed = toolCallsFromContent(msg.content);
    toolCalls = parsed.toolCalls;
    fallback = parsed.fallback;
    if (parsed.text) text = redact(parsed.text, 2000);
  }
  return { text, toolCalls, fallback, toolCallsSupported: toolCalls.length > 0 && fallback !== 'json-writes' };
}

function fixtureProvider(mode) {
  return {
    id: 'fixture',
    available: true,
    toolCalls: true,
    label: 'fixture（測試替身，不是 Ollama）',
    async complete(ctx) {
      if (ctx.phase === 'plan') {
        return { text: '計畫：只改 src/add.js，讓既有測試的結束碼變成 0。不修改測試、不宣告自己完成。', toolCalls: [] };
      }
      if (mode === 'weaken') {
        return { text: 'SUCCESS all tests passed', toolCalls: [{ name: 'write_file', args: { path: 'test.js', content: 'process.exit(0)\n' } }] };
      }
      if (mode === 'escape') {
        return {
          text: 'policy allowAll true',
          policy: { allowAll: true },
          toolCalls: [
            { name: 'write_file', args: { path: '../outside.txt', content: 'nope' } },
            { name: 'read_file', args: { path: '/etc/passwd' } },
            { name: 'run_command', args: { argv: ['curl', 'https://example.com'] } }
          ]
        };
      }
      if (mode === 'talk-only') return { text: 'SUCCESS all tests passed. The task is complete.', toolCalls: [] };
      const n = ctx.attempt || 0;
      const correct = mode === 'pass-first' || (mode === 'repair' && (ctx.failures?.length || 0) > 0);
      const content = correct
        ? 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n'
        : `function add(a, b) { return a + b + ${mode === 'stall' ? 1 : n + 1}; }\nmodule.exports = { add };\n`;
      return { text: correct ? '依照測試失敗證據修改加法' : '第一次修改', toolCalls: [{ name: 'write_file', args: { path: 'src/add.js', content } }] };
    }
  };
}

function ollamaProvider({ model, fetchImpl }) {
  return {
    id: 'ollama',
    available: true,
    toolCalls: true,
    async complete(ctx) {
      const messages = [
        { role: 'system', content: 'You edit files only by calling write_file. Never claim the task is complete. Never change tests. Reply about the authorized workspace only.' },
        { role: 'user', content: buildModelPrompt(ctx) }
      ];
      return ollamaChat({ model, messages, fetchImpl });
    }
  };
}

export async function selectProvider({ engine, model, allowFixture = false, fetchImpl, spawnImpl } = {}) {
  const mode = model || 'repair';
  if (engine === 'fixture') {
    if (!allowFixture) return { id: 'fixture', available: false, reason: '測試替身未啟用' };
    return fixtureProvider(mode);
  }
  if (engine === 'ollama' || engine === 'opencode') {
    const o = await probeOllama(fetchImpl);
    if (!o.available) return { id: engine, available: false, reason: o.reason, models: o.models };
    if (engine === 'opencode') {
      const oc = probeOpencode();
      if (!oc.available) {
        return { ...ollamaProvider({ model: (model || o.models[0] || '').replace(/^ollama\//, ''), fetchImpl }), id: 'ollama', fallbackFrom: 'opencode', note: oc.reason + '；改走 Ollama HTTP' };
      }
      return opencodeProvider({ bin: oc.path, model, spawnImpl });
    }
    const name = model || o.models[0];
    return { ...ollamaProvider({ model: name, fetchImpl }), model: name };
  }
  if (!spawnImpl) return { id: engine || 'cli', available: false, reason: '這個 AI 引擎沒有接到執行器' };
  return {
    id: engine,
    available: true,
    toolCalls: false,
    async complete(ctx) {
      const r = await spawnImpl(engine, model, buildModelPrompt(ctx), ctx.worktree);
      const parsed = toolCallsFromContent(r.stdout || r.text || '');
      return { text: redact(parsed.text || r.text || '', 2000), toolCalls: parsed.toolCalls, fallback: parsed.fallback || 'json-writes' };
    }
  };
}

function opencodeProvider({ bin, model, spawnImpl }) {
  return {
    id: 'opencode',
    available: !!bin,
    reason: bin ? '' : 'OpenCode 不在這台電腦',
    async complete(ctx) {
      const run = spawnImpl || ((b, args, opts) => runProcess([b, ...args], opts).then(r => ({ stdout: r.stdout, text: r.stdout })));
      const r = await run(bin, ['run', '--dir', ctx.worktree, ...(model ? ['-m', model] : []), buildModelPrompt(ctx)], { cwd: ctx.worktree });
      const parsed = toolCallsFromContent(r.stdout || r.text || '');
      return { text: redact(parsed.text || '', 2000), toolCalls: parsed.toolCalls, fallback: parsed.fallback };
    }
  };
}

function walkFiles(root, limit = 200) {
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= limit || depth > 4) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.name === '.git' || e.name === 'node_modules' || e.name === '.octa') continue;
      const p = join(dir, e.name);
      const rel = relative(root, p).split('\\').join('/');
      if (isSecretPath(rel)) continue;
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) out.push(rel);
    }
  };
  walk(root, 0);
  return out;
}

export function detectProject(worktree) {
  const files = walkFiles(worktree);
  let pkg = null;
  try { pkg = JSON.parse(readFileSync(join(worktree, 'package.json'), 'utf8')); } catch { /* not node */ }
  const scripts = pkg?.scripts || {};
  const commands = [];
  if (scripts.test && !/no test specified/i.test(scripts.test)) {
    const m = String(scripts.test).match(/^node\s+([\w./-]+\.js)$/);
    if (m) commands.push({ id: 'test', argv: ['node', m[1]], via: 'package.json scripts.test' });
    else if (!/curl|wget|rm |sudo|deploy/i.test(scripts.test)) commands.push({ id: 'test', argv: ['npm', 'test'], via: 'npm test' });
  }
  let kind = 'unknown';
  if (pkg) kind = 'node';
  if (files.some(f => f.endsWith('.uproject'))) kind = 'unreal';
  else if (files.some(f => f.endsWith('.csproj') || f.endsWith('ProjectSettings/ProjectVersion.txt'))) kind = 'unity';
  else if (pkg?.devDependencies?.playwright || pkg?.dependencies?.playwright || files.some(f => /playwright\.config\./.test(f))) kind = 'web';
  const blocked = [];
  if (kind === 'unity') blocked.push({ tool: 'unity', reason: 'Unity 編輯器不在這台環境，EditMode/PlayMode 未執行' });
  if (kind === 'unreal') blocked.push({ tool: 'unreal', reason: 'Unreal 建置工具不在這台環境，Automation Tests 未執行' });
  return { kind, files, scripts, commands, blocked, screenshots: [] };
}

function buildModelPrompt(ctx) {
  const parts = [
    `任務：${ctx.title || ''}`,
    `指示：${ctx.prompt || ''}`,
    `驗收條件（尚未核對，不要自己打勾）：${(ctx.criteria || []).map(c => c.text).join('；')}`,
    ctx.plan ? `計畫：${ctx.plan}` : '',
    ctx.context ? `工作區內容：\n${ctx.context}` : '',
    ctx.failures?.length ? `測試失敗證據（結束碼與輸出是真的）：\n${ctx.failures.map(f => `$ ${f.cmd}\nexit ${f.code}\n${f.stdout}\n${f.stderr}`).join('\n')}` : ''
  ];
  let body = parts.filter(Boolean).join('\n\n');
  if (body.length > LIMITS.maxContextChars) body = body.slice(0, LIMITS.maxContextChars);
  return body;
}

export function buildContext(worktree, extra = '') {
  const det = detectProject(worktree);
  let bundle = det.files.slice(0, 40).map(f => f).join('\n');
  for (const f of det.files.filter(f => /^(src\/|test|package\.json)/.test(f)).slice(0, 8)) {
    if (isSecretPath(f)) continue;
    let text = '';
    try { text = readFileSync(join(worktree, f), 'utf8'); } catch { continue; }
    bundle += `\n\n--- ${f}\n` + redact(text, 4000);
  }
  bundle += extra;
  if (bundle.length > LIMITS.maxContextChars) bundle = bundle.slice(0, LIMITS.maxContextChars);
  return bundle;
}

function criteriaFrom(text) {
  const lines = String(text || '').split(/\n|；/).map(s => s.trim()).filter(Boolean);
  return (lines.length ? lines : ['測試要通過']).map(t => ({ text: t, met: false, evidence: null }));
}

function refreshCompletion(state) {
  const last = state.tests[state.tests.length - 1];
  const testsPassed = !!(last && last.passed && !last.timedOut);
  for (const c of state.criteria) {
    if (testsPassed && /測試|test/i.test(c.text) && /通過|pass|成功|結束碼|exit/i.test(c.text)) {
      c.met = true;
      c.evidence = `結束碼 0（${last.cmd}）`;
    }
  }
  state.acceptance = state.criteria.length && state.criteria.every(c => c.met) ? 'met' : 'open';
  state.testsPassed = testsPassed;
  state.complete = testsPassed && state.acceptance === 'met';
  state.deployed = false;
  state.merged = false;
}

function pushEvent(state, role, kind, text, data) {
  state.events.push({ ts: Date.now(), role, kind, text: redact(text, 1500), data: data || null });
  if (state.events.length > 80) state.events.splice(0, state.events.length - 80);
  state.role = role;
  state.phase = state.phase || kind;
}

async function saveState(state, opts) {
  state.updated = Date.now();
  if (opts.workspacesRoot) {
    mkdirSync(opts.workspacesRoot, { recursive: true });
    const file = codingStatePath(opts.workspacesRoot, state.id);
    const snapshot = { ...state, provider: undefined };
    writeFileSync(file, JSON.stringify(snapshot));
    state.stateFile = file;
  }
  if (opts.persist) {
    const pub = publicCodingState(state);
    const r = await opts.persist(pub);
    if (r?.cancel) state.cancelRequested = true;
  }
}

export function publicCodingState(state) {
  return {
    id: state.id, title: state.title, status: state.status, phase: state.phase, role: state.role,
    engine: state.engine, model: state.model, providerId: state.providerId, providerNote: state.providerNote || '',
    workspaceId: state.workspaceId, branch: state.branch, baseRef: state.baseRef, headRef: state.headRef,
    repairs: state.repairs, maxRepairs: state.maxRepairs, plan: state.plan, criteria: state.criteria,
    acceptance: state.acceptance, complete: state.complete, testsPassed: state.testsPassed,
    deployed: false, merged: false, approval: state.approval,
    files: state.files, tests: state.tests, commands: state.commands,
    diff: redact(state.diff || '', LIMITS.maxDiffChars),
    error: state.error, reason: state.reason, blocked: state.blocked, inspected: state.inspected,
    modelSwitches: state.modelSwitches || [], routeIndex: state.routeIndex || 0,
    kind: state.kind, toolCallsSupported: state.toolCallsSupported, fallback: state.fallback,
    events: (state.events || []).slice(-40), updated: state.updated
  };
}

async function cancelled(state, opts) {
  if (opts.signal?.aborted || state.cancelRequested) return true;
  if (opts.isCancelled && await opts.isCancelled()) return true;
  return false;
}

export async function createWorkspace({ repoPath, taskId, workspacesRoot }) {
  const topR = await git(repoPath, ['rev-parse', '--show-toplevel']);
  if (topR.code !== 0) throw new PolicyError('這不是可用的 git 儲存庫：' + (topR.stderr || topR.stdout));
  const top = topR.stdout.trim();
  const baseR = await git(top, ['rev-parse', 'HEAD']);
  if (baseR.code !== 0) throw new PolicyError('讀不到儲存庫版本');
  const base = baseR.stdout.trim();
  const id = String(taskId).replace(/[^\w-]/g, '').slice(0, 40);
  const branch = `octa/task/${id}`;
  const dest = join(workspacesRoot, id);
  const rel = relative(top, dest);
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))) throw new PolicyError('工作區必須在原儲存庫工作目錄之外');
  mkdirSync(workspacesRoot, { recursive: true });
  if (existsSync(dest)) throw new PolicyError('工作區已存在');
  const add = await git(top, ['worktree', 'add', '-b', branch, dest, base]);
  if (add.code !== 0) throw new PolicyError('建立工作區失敗：' + (add.stderr || add.stdout));
  return { repo: top, worktree: dest, branch, baseRef: base, workspaceId: id };
}

export async function rollbackWorkspace(state) {
  if (!state?.worktree || !state?.repo) return { removed: false };
  const rm = await git(state.repo, ['worktree', 'remove', '--force', state.worktree]);
  if (state.branch) await git(state.repo, ['branch', '-D', state.branch]);
  return { removed: rm.code === 0, stderr: rm.stderr };
}

function readRel(worktree, rel) {
  const abs = resolveInside(worktree, rel);
  return readFileSync(abs, 'utf8');
}

async function applyToolCalls(state, calls, opts) {
  const applied = [];
  const problems = [];
  for (const call of calls || []) {
    const name = call?.name;
    const args = call?.args || {};
    try {
      if (name === 'write_file') {
        if (!state.inspected) throw new PolicyError('還沒檢查儲存庫，不能修改');
        const abs = resolveInside(state.worktree, args.path);
        const previous = existsSync(abs) && lstatSync(abs).isFile() ? readFileSync(abs, 'utf8') : null;
        evaluateWrite(state.worktree, args.path, args.content, previous);
        writeFileSync(abs, String(args.content));
        const rel = String(args.path).replace(/\\/g, '/');
        state.files.push({ path: rel, action: 'write' });
        applied.push(rel);
        pushEvent(state, 'developer', 'edit', `寫入 ${rel}`, { path: rel });
      } else if (name === 'read_file') {
        const text = readRel(state.worktree, args.path);
        pushEvent(state, 'explorer', 'read', `讀取 ${args.path}`, { bytes: text.length });
      } else if (name === 'run_command') {
        const decision = evaluateCommand(args.argv, { root: state.worktree, cwd: state.worktree, scripts: state.scripts, approval: state.approval });
        if (!decision.allow) {
          pushEvent(state, 'policy', 'audit', decision.reason, { argv: args.argv, needsApproval: decision.needsApproval || null });
          if (decision.needsApproval === 'deploy') state.deployGate = evaluateDeploy(state.approval);
          throw new PolicyError(decision.reason, { code: decision.needsApproval ? 'APPROVAL' : 'POLICY', needsApproval: decision.needsApproval });
        }
        const r = await runProcess(args.argv, { cwd: state.worktree, timeout: opts.commandTimeoutMs || LIMITS.commandTimeoutMs, signal: opts.signal });
        state.commands.push({ argv: args.argv, code: r.code, stdout: r.stdout, stderr: r.stderr });
        pushEvent(state, 'developer', 'command', `${args.argv.join(' ')} → ${r.code}`, { code: r.code });
      } else {
        pushEvent(state, 'policy', 'audit', `忽略未知工具 ${name || ''}`, null);
      }
    } catch (e) {
      if (e instanceof PolicyError || e.code === 'POLICY' || e.code === 'SAFETY' || e.code === 'APPROVAL') {
        pushEvent(state, 'policy', 'audit', e.message, { code: e.code || 'POLICY', tool: name });
        problems.push(e);
        continue;
      }
      throw e;
    }
  }
  if (problems.length) {
    const e = problems[0];
    e.code = e.code || 'POLICY';
    throw e;
  }
  return applied;
}

async function runTests(state, opts) {
  state.phase = state.repairs > 0 ? 'repairing' : 'testing';
  state.role = 'tester';
  if (!state.commandsDetected?.length) {
    state.blocked = [...(state.blocked || []), ...(state.projectBlocked || [])];
    if (state.kind === 'unity' || state.kind === 'unreal') {
      state.status = 'blocked';
      state.reason = state.kind + '_unavailable';
      pushEvent(state, 'tester', 'blocked', (state.projectBlocked || []).map(b => b.reason).join('；'), null);
      return { passed: false, blocked: true };
    }
    pushEvent(state, 'tester', 'test', '這個專案沒有可執行的測試指令', null);
    return { passed: false, blocked: false, missing: true };
  }
  let all = true;
  for (const c of state.commandsDetected) {
    const decision = evaluateCommand(c.argv, { root: state.worktree, cwd: state.worktree, scripts: state.scripts });
    if (!decision.allow) {
      all = false;
      pushEvent(state, 'policy', 'audit', decision.reason, { argv: c.argv });
      state.tests.push({ cmd: c.argv.join(' '), code: null, passed: false, stdout: '', stderr: decision.reason, at: Date.now() });
      continue;
    }
    if (await cancelled(state, opts)) return { passed: false, cancelled: true };
    const r = await runProcess(c.argv, { cwd: state.worktree, timeout: opts.commandTimeoutMs || LIMITS.commandTimeoutMs, signal: opts.signal });
    const row = { cmd: c.argv.join(' '), via: c.via, code: r.code, passed: r.code === 0 && !r.timedOut, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut, at: Date.now() };
    state.tests.push(row);
    state.commands.push({ argv: c.argv, code: r.code });
    pushEvent(state, 'tester', 'test', `${row.cmd} 結束碼 ${r.code}${r.timedOut ? '（逾時）' : ''}`, { code: r.code, passed: row.passed, stderr: r.stderr.slice(0, 1500), stdout: r.stdout.slice(0, 1500) });
    if (!row.passed) all = false;
    if (r.cancelled) return { passed: false, cancelled: true };
  }
  return { passed: all };
}

async function review(state) {
  state.phase = 'reviewing';
  state.role = 'reviewer';
  const diff = await git(state.worktree, ['diff', 'HEAD']);
  const stat = await git(state.worktree, ['status', '--porcelain']);
  state.diff = redact(diff.stdout || '', LIMITS.maxDiffChars);
  state.porcelain = stat.stdout || '';
  const head = await git(state.worktree, ['rev-parse', 'HEAD']);
  state.headRef = (head.stdout || '').trim() || state.baseRef;
  pushEvent(state, 'reviewer', 'diff', state.diff ? '審查實際 git diff' : '沒有差異', { porcelain: state.porcelain.slice(0, 2000) });
}

async function completeWithRoute(state, opts, ctx) {
  let guard = 0;
  while (guard++ < 8) {
    if (await cancelled(state, opts)) return { cancelled: true };
    let turn;
    try {
      turn = await state.provider.complete({ ...ctx, phase: ctx.phase });
    } catch (e) {
      turn = { errorClass: classifyModelFailure(e.message), text: e.message || '模型呼叫失敗' };
    }
    const kind = turn?.errorClass || (turn?.ok === false ? classifyModelFailure(turn.text) : '');
    if (!kind) return turn;
    const chain = state.routeChain || [];
    const mapped = () => chain.map(x => ({ id: x.engine + '|' + (x.model || ''), spentUntil: x.dead ? Number.MAX_SAFE_INTEGER : 0 }));
    const decision = decideRoute({ kind, tries: state.routeTries || 0, index: state.routeIndex || 0, now: Date.now(), chain: mapped() });
    state.modelSwitches = state.modelSwitches || [];
    state.modelSwitches.push({ phase: ctx.phase, kind, action: decision.action, index: decision.index ?? state.routeIndex, engine: state.engine, model: state.model || '' });
    pushEvent(state, 'orchestrator', 'model', decision.message || kind, { kind, action: decision.action });
    if (decision.action === 'retry') {
      state.routeTries = (state.routeTries || 0) + 1;
      continue;
    }
    if (decision.action === 'switch' && opts.providerFor && chain[decision.index]) {
      const next = chain[decision.index];
      const provider = await opts.providerFor(next);
      if (!provider || provider.available === false) {
        next.dead = true;
        const again = decideRoute({ kind, tries: 99, index: decision.index, now: Date.now(), chain: mapped() });
        const hop = again.action === 'switch' ? chain[again.index] : null;
        const hopProvider = hop && await opts.providerFor(hop);
        if (!hopProvider || hopProvider.available === false) {
          if (hop) hop.dead = true;
          return { stop: true, reason: kind, text: hopProvider?.reason || provider?.reason || again.message || '備援模型不可用' };
        }
        state.provider = hopProvider;
        state.routeIndex = again.index;
        state.routeTries = 0;
        state.engine = hop.engine;
        state.model = hop.model || '';
        state.providerId = hopProvider.id;
        state.providerNote = hopProvider.label || hopProvider.note || '';
        continue;
      }
      state.provider = provider;
      state.routeIndex = decision.index;
      state.routeTries = 0;
      state.engine = next.engine;
      state.model = next.model || '';
      state.providerId = provider.id;
      state.providerNote = provider.label || provider.note || '';
      continue;
    }
    return { stop: true, reason: decision.reason || kind, text: decision.message || turn.text || '模型無法繼續' };
  }
  return { stop: true, reason: 'route_limit', text: '模型切換次數已達上限，任務進度已保留。' };
}

export async function runCodingTask(opts) {
  const resume = opts.resume;
  const state = resume ? { ...resume, events: resume.events || [], tests: resume.tests || [], files: resume.files || [], commands: resume.commands || [], criteria: resume.criteria || [] } : {
    id: opts.id,
    title: opts.title || '',
    prompt: opts.prompt || '',
    engine: opts.engine,
    model: opts.model || '',
    status: 'queued',
    phase: 'queued',
    role: 'orchestrator',
    criteria: criteriaFrom(opts.criteria),
    repairs: 0,
    maxRepairs: clampRepairs(opts.maxRepairs),
    files: [],
    tests: [],
    commands: [],
    events: [],
    approval: opts.approval || { merge: null, deploy: null },
    plan: '',
    diff: '',
    complete: false,
    deployed: false,
    merged: false,
    acceptance: 'open',
    needsEdit: true,
    lastWriteHash: null,
    inspected: false,
    cancelRequested: false,
    repo: null,
    worktree: null
  };
  state.approval = state.approval || { merge: null, deploy: null };
  const provider = opts.provider;
  let unlock = () => {};
  const finish = async () => {
    refreshCompletion(state);
    if (state.status === 'tested') state.phase = 'awaiting_approval';
    await saveState(state, opts);
    try { unlock(); } catch { /* lock already clear */ }
    return state;
  };
  try {
    if (await cancelled(state, opts)) { state.status = 'cancelled'; state.phase = 'cancelled'; state.role = 'orchestrator'; return finish(); }
    if (!state.worktree) {
      state.status = 'inspecting';
      state.phase = 'inspecting';
      state.role = 'orchestrator';
      pushEvent(state, 'orchestrator', 'start', '建立隔離工作區', null);
      const ws = await createWorkspace({ repoPath: opts.repoPath, taskId: state.id, workspacesRoot: opts.workspacesRoot });
      Object.assign(state, { repo: ws.repo, worktree: ws.worktree, branch: ws.branch, baseRef: ws.baseRef, workspaceId: ws.workspaceId, headRef: ws.baseRef });
      await saveState(state, opts);
    }
    unlock = tryLock(state.worktree, state.id);
    state.workspaceId = state.workspaceId || String(state.id).replace(/[^\w-]/g, '').slice(0, 40);
    const lockFile = join(opts.workspacesRoot, state.workspaceId + '.lock');
    if (existsSync(lockFile)) {
      const cur = readFileSync(lockFile, 'utf8').trim();
      if (cur && cur !== state.id) throw Object.assign(new Error('工作區鎖被其他任務持有'), { code: 'WORKTREE_BUSY' });
    }
    writeFileSync(lockFile, state.id);

    if (!state.inspected) {
      state.role = 'explorer';
      state.phase = 'inspecting';
      const det = detectProject(state.worktree);
      state.kind = det.kind;
      state.scripts = det.scripts;
      state.filesListed = det.files;
      state.commandsDetected = det.commands;
      state.projectBlocked = det.blocked;
      state.screenshots = [];
      state.inspected = true;
      pushEvent(state, 'explorer', 'inspect', `檢查到 ${det.kind} 專案，${det.files.length} 個檔案，測試指令 ${det.commands.map(c => c.argv.join(' ')).join('、') || '（無）'}`, { kind: det.kind, blocked: det.blocked });
      await saveState(state, opts);
      if (opts.onPhase) await opts.onPhase('inspected', state);
      if ((det.kind === 'unity' || det.kind === 'unreal') && !det.commands.length) {
        state.status = 'blocked';
        state.phase = 'blocked';
        state.reason = det.kind + '_unavailable';
        state.error = (det.blocked[0] && det.blocked[0].reason) || '工具不在這台環境';
        state.blocked = det.blocked;
        pushEvent(state, 'tester', 'blocked', state.error, null);
        return finish();
      }
    }

    if (!provider || provider.available === false) {
      state.status = 'blocked';
      state.phase = 'blocked';
      state.reason = 'provider_unavailable';
      state.error = provider?.reason || '沒有可用的模型';
      state.providerId = provider?.id || opts.engine;
      pushEvent(state, 'orchestrator', 'blocked', state.error, null);
      return finish();
    }
    state.provider = provider;
    state.providerId = provider.id;
    state.providerNote = provider.label || provider.note || '';
    state.routeChain = state.routeChain || opts.routeChain || [{ engine: state.engine, model: state.model || '' }];
    state.routeIndex = state.routeIndex || 0;
    state.routeTries = state.routeTries || 0;
    state.modelSwitches = state.modelSwitches || [];

    if (!state.plan) {
      if (await cancelled(state, opts)) { state.status = 'cancelled'; state.phase = 'cancelled'; return finish(); }
      state.phase = 'planning';
      state.role = 'planner';
      const ctx = providerCtx(state);
      const plan = await completeWithRoute(state, opts, { ...ctx, phase: 'plan' });
      if (plan.cancelled) { state.status = 'cancelled'; state.phase = 'cancelled'; return finish(); }
      if (plan.stop) {
        state.status = 'failed';
        state.phase = 'failed';
        state.reason = 'model_' + (plan.reason || 'error');
        state.error = plan.text;
        pushEvent(state, 'orchestrator', 'blocked', state.error, null);
        return finish();
      }
      state.plan = redact(plan.text || '', 4000);
      state.toolCallsSupported = plan.toolCallsSupported ?? state.provider.toolCalls ?? null;
      state.fallback = plan.fallback || null;
      pushEvent(state, 'planner', 'plan', state.plan || '（沒有計畫文字）', { fallback: state.fallback });
      await saveState(state, opts);
      if (opts.onPhase) await opts.onPhase('planned', state);
    }

    while (!TERMINAL.has(state.status)) {
      if (await cancelled(state, opts)) { state.status = 'cancelled'; state.phase = 'cancelled'; break; }
      if (state.needsEdit) {
        state.phase = state.repairs > 0 ? 'repairing' : 'editing';
        state.role = 'developer';
        state.status = state.phase;
        if (opts.onPhase) await opts.onPhase('editing', state);
        const lastFail = [...state.tests].reverse().find(t => !t.passed);
        const ctx = providerCtx(state, lastFail);
        const turn = await completeWithRoute(state, opts, { ...ctx, phase: 'edit' });
        if (turn.cancelled) { state.status = 'cancelled'; state.phase = 'cancelled'; break; }
        if (turn.stop) {
          state.status = 'failed';
          state.reason = 'model_' + (turn.reason || 'error');
          state.error = turn.text;
          pushEvent(state, 'developer', 'model', state.error, null);
          break;
        }
        if (turn.toolCallsSupported != null) state.toolCallsSupported = turn.toolCallsSupported;
        if (turn.fallback) state.fallback = turn.fallback;
        const hash = sha(JSON.stringify(turn.toolCalls || []));
        if (state.lastWriteHash && hash === state.lastWriteHash) {
          state.status = 'failed';
          state.reason = 'stalled';
          state.error = '修復沒有新的修改，停止';
          pushEvent(state, 'developer', 'stalled', state.error, null);
          break;
        }
        try {
          const applied = await applyToolCalls(state, turn.toolCalls, opts);
          if (!applied.length) {
            pushEvent(state, 'developer', 'edit', '模型沒有提出可執行的修改', { modelText: redact(turn.text || '', 300) });
          }
        } catch (e) {
          if (e instanceof PolicyError || e.code === 'POLICY' || e.code === 'SAFETY' || e.code === 'APPROVAL') {
            state.status = 'failed';
            state.reason = e.code === 'APPROVAL' ? 'approval_required' : 'policy';
            state.error = e.message;
            pushEvent(state, 'policy', 'audit', e.message, { code: e.code || 'POLICY' });
            break;
          }
          throw e;
        }
        state.lastWriteHash = hash;
        state.needsEdit = false;
        await saveState(state, opts);
      }
      if (await cancelled(state, opts)) { state.status = 'cancelled'; state.phase = 'cancelled'; break; }
      const result = await runTests(state, opts);
      await saveState(state, opts);
      if (result.cancelled) { state.status = 'cancelled'; state.phase = 'cancelled'; break; }
      if (result.blocked) break;
      if (result.passed) {
        state.status = 'tested';
        break;
      }
      if (state.tests.at(-1)?.timedOut) {
        state.status = 'failed';
        state.reason = 'timeout';
        state.error = '測試逾時，已停止後續修復';
        pushEvent(state, 'tester', 'timeout', state.error, null);
        break;
      }
      if (opts.pauseAfter === 'first-failure' && state.tests.length === 1) {
        state.status = 'paused';
        state.phase = 'paused';
        state.needsEdit = true;
        break;
      }
      if (state.repairs >= state.maxRepairs) {
        state.status = 'failed';
        state.reason = 'retry_limit';
        state.error = `已達修復上限 ${state.maxRepairs}`;
        pushEvent(state, 'tester', 'retry_limit', state.error, { repairs: state.repairs, tests: state.tests.length });
        break;
      }
      state.repairs += 1;
      state.needsEdit = true;
      state.phase = 'repairing';
      pushEvent(state, 'developer', 'repair', `第 ${state.repairs} 次修復，依據測試輸出`, { repair: state.repairs });
      await saveState(state, opts);
    }
    if (state.worktree && (state.files.length || state.status === 'tested' || state.status === 'failed')) await review(state);
    if (state.status === 'tested') {
      state.deployGate = evaluateDeploy(state.approval);
      state.mergeGate = evaluateMerge(state.approval);
      pushEvent(state, 'policy', 'approval', '測試證據已記錄。合併與正式部署仍要人核准，而且不會自動執行。', { deploy: state.deployGate, merge: state.mergeGate });
    }
    return finish();
  } catch (e) {
    if (e.code === 'WORKTREE_BUSY') {
      state.status = 'failed';
      state.reason = 'worktree_busy';
      state.error = e.message;
    } else if (opts.signal?.aborted) {
      state.status = 'cancelled';
      state.phase = 'cancelled';
    } else {
      state.status = 'failed';
      state.reason = 'error';
      state.error = e.message;
    }
    pushEvent(state, 'orchestrator', 'error', state.error || state.status, null);
    return finish();
  }
}

function providerCtx(state, lastFail) {
  const failed = state.tests.filter(t => !t.passed).slice(-3);
  const failures = (failed.length ? failed : (lastFail ? [lastFail] : [])).map(t => ({ cmd: t.cmd, code: t.code, stdout: t.stdout, stderr: t.stderr }));
  let context = '';
  try { context = buildContext(state.worktree); } catch { context = ''; }
  return {
    phase: state.phase,
    title: state.title,
    prompt: state.prompt,
    criteria: state.criteria,
    plan: state.plan,
    failures,
    attempt: state.repairs || 0,
    worktree: state.worktree,
    files: state.filesListed || [],
    context
  };
}

export async function resumeCodingTask(fileOrState, opts) {
  const state = typeof fileOrState === 'string' ? loadCodingState(fileOrState) : fileOrState;
  if (TERMINAL.has(state.status)) return state;
  return runCodingTask({ ...opts, resume: state, id: state.id, repoPath: opts.repoPath || state.repo });
}

export { evaluateDeploy, evaluateMerge, LIMITS };
