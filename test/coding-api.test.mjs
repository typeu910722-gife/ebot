import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runCodingTask, selectProvider } from '../public/coding-runtime.mjs';

const apiUrl = pathToFileURL(join(import.meta.dirname, '..', 'functions', 'api', '[[path]].js')).href;
const { onRequest } = await import(apiUrl);
const schema = readFileSync(join(import.meta.dirname, '..', 'schema.sql'), 'utf8');

function openD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const norm = a => a.map(v => (v === undefined ? null : typeof v === 'boolean' ? +v : v));
  class Stmt {
    constructor(sql) { this.sql = sql; this.args = []; }
    bind(...a) { this.args = norm(a); return this; }
    async first() { return db.prepare(this.sql).get(...this.args) ?? null; }
    async all() { return { results: db.prepare(this.sql).all(...this.args) }; }
    _run() {
      const info = db.prepare(this.sql).run(...this.args);
      return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    }
    async run() { return this._run(); }
    _exec() { return /^\s*(SELECT|WITH)/i.test(this.sql) ? { results: db.prepare(this.sql).all(...this.args), meta: {} } : { results: [], ...this._run() }; }
  }
  return {
    prepare: sql => new Stmt(sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map(s => s._exec()); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch { /* already closed */ } throw e; }
    },
    exec: sql => db.exec(sql),
    raw: db
  };
}

let ip = 20;
async function call(db, method, path, { token, body, ipOverride, query } = {}) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': ipOverride || `203.0.113.${ip++}` };
  if (token) headers.authorization = 'Bearer ' + token;
  const url = new URL('http://octa.test/api/' + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const req = new Request(url, {
    method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body || {})
  });
  const res = await onRequest({
    request: req,
    env: { DB: db, ALLOW_SIGNUP: 'true', TZ_OFFSET_MIN: '480', isLocal: false, OCTA_CODE_ALLOW_FIXTURE: '1' },
    params: { path: path.split('/').filter(Boolean) }
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'octa-api-repo-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'add', scripts: { test: 'node test.js' } }));
  writeFileSync(join(dir, 'src/add.js'), 'function add(a, b) { return a - b; }\nmodule.exports = { add };\n');
  writeFileSync(join(dir, 'test.js'), "const assert = require('assert');\nconst { add } = require('./src/add.js');\nassert.strictEqual(add(2, 3), 5);\n");
  const git = (args) => { const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); };
  git(['init']); git(['add', '-A']); git(['commit', '-m', 'init']);
  return dir;
}

test('existing account, bot, and message flow still works', async () => {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'ada', pw: 'correcthorsebattery' } });
  assert.equal(su.status, 200);
  assert.ok(su.data.token);
  const bad = await call(db, 'POST', 'login', { body: { name: 'ada', pw: 'wrong-password' } });
  assert.equal(bad.status, 401);
  const bot = await call(db, 'POST', 'bots', { token: su.data.token, body: { name: '助理', task: '回答問題' } });
  assert.equal(bot.status, 200);
  const msg = await call(db, 'POST', 'messages', { token: su.data.token, body: { conv: bot.data.id, text: '你好' } });
  assert.equal(msg.status, 200);
  const state = await call(db, 'GET', 'state', { token: su.data.token });
  assert.equal(state.status, 200);
  assert.equal(state.data.bots.length, 1);
  assert.equal(state.data.bots[0].name, '助理');
  const anon = await call(db, 'GET', 'code/tasks');
  assert.equal(anon.status, 401);
});

test('code routes reject fixture when the server flag is off and require auth', async () => {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'bea', pw: 'correcthorsebattery' } });
  const repo = await call(db, 'POST', 'code/repos', { token: su.data.token, body: { name: 'app', path: '/tmp/octa-nope' } });
  assert.equal(repo.status, 200);
  const saved = process.env.OCTA_CODE_ALLOW_FIXTURE;
  const blocked = await onRequest({
    request: new Request('http://octa.test/api/code/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + su.data.token, 'cf-connecting-ip': '198.51.100.8' },
      body: JSON.stringify({ repoId: repo.data.id, title: 't', prompt: 'p', criteria: '測試要通過', engine: 'fixture' })
    }),
    env: { DB: db, ALLOW_SIGNUP: 'true', TZ_OFFSET_MIN: '0', isLocal: false },
    params: { path: ['code', 'tasks'] }
  });
  assert.equal(blocked.status, 400);
  if (saved === undefined) delete process.env.OCTA_CODE_ALLOW_FIXTURE; else process.env.OCTA_CODE_ALLOW_FIXTURE = saved;
  const rel = await call(db, 'POST', 'code/repos', { token: su.data.token, body: { name: 'bad', path: 'relative/path' } });
  assert.equal(rel.status, 400);
  const dot = await call(db, 'POST', 'code/repos', { token: su.data.token, body: { name: 'bad', path: '/tmp/../etc' } });
  assert.equal(dot.status, 400);
});

test('one coding task is queued, executed in a worktree, persisted, and not deployed', async () => {
  const db = openD1();
  const repoPath = makeRepo();
  const su = await call(db, 'POST', 'signup', { body: { name: 'cy', pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const repo = await call(db, 'POST', 'code/repos', { token, body: { name: 'add', path: repoPath } });
  assert.equal(repo.status, 200);
  const created = await call(db, 'POST', 'code/tasks', {
    token, body: { repoId: repo.data.id, title: '修正加法', prompt: '讓 add(2, 3) 等於 5', criteria: '測試要通過', engine: 'fixture', model: 'repair', maxRetries: 3 }
  });
  assert.equal(created.status, 200);
  const runner = await call(db, 'POST', 'runner-token', { token, body: { label: 'test-host' } });
  const rt = runner.data.token;
  const next = await call(db, 'POST', 'runner/next', { token: rt, body: { slots: 1, wait: false, coding: { ollama: { available: false, reason: '這台電腦連不到 Ollama（127.0.0.1:11434）', models: [] }, opencode: { available: false, reason: '這台電腦沒有安裝 OpenCode' }, unity: { available: false }, unreal: { available: false } } } });
  assert.equal(next.status, 200);
  assert.equal(next.data.job.kind, 'code');
  assert.equal(next.data.job.repo.path, repoPath);
  const provider = await selectProvider({ engine: 'fixture', model: 'repair', allowFixture: true });
  const root = mkdtempSync(join(tmpdir(), 'octa-api-ws-'));
  const state = await runCodingTask({
    id: created.data.id, title: '修正加法', prompt: '讓 add(2, 3) 等於 5', criteria: '測試要通過',
    engine: 'fixture', model: 'repair', maxRepairs: 3, repoPath, workspacesRoot: root, provider,
    persist: async summary => {
      const fresh = summary.events || [];
      const r = await call(db, 'POST', 'runner/code/event', { token: rt, body: {
        taskId: summary.id, status: summary.status, phase: summary.phase, role: summary.role,
        workspaceId: summary.workspaceId, branch: summary.branch, baseRef: summary.baseRef, headRef: summary.headRef,
        retries: summary.repairs, summary, events: fresh.slice(-3)
      } });
      assert.equal(r.status, 200);
      return r.data;
    }
  });
  assert.equal(state.status, 'tested');
  await call(db, 'POST', 'runner/done', { token: rt, body: { id: next.data.job.id, ok: true, text: 'tested' } });
  const got = await call(db, 'GET', 'code/tasks/' + created.data.id, { token });
  assert.equal(got.status, 200);
  assert.equal(got.data.task.status, 'tested');
  assert.equal(got.data.task.deployed, false);
  assert.match(got.data.task.summary.diff, /a \+ b/);
  assert.equal(got.data.task.summary.tests.at(-1).passed, true);
  assert.ok(got.data.events.some(e => e.role === 'reviewer' || e.kind === 'diff' || e.kind === 'test'));
  assert.match(readFileSync(join(repoPath, 'src/add.js'), 'utf8'), /a - b/);
  const no = await call(db, 'POST', 'code/tasks/' + created.data.id + '/approve', { token, body: { action: 'deploy', allow: true } });
  assert.equal(no.status, 400);
  const yes = await call(db, 'POST', 'code/tasks/' + created.data.id + '/approve', { token, body: { action: 'deploy', allow: true, target: 'production' } });
  assert.equal(yes.status, 200);
  assert.equal(yes.data.executed, false);
  assert.equal(yes.data.deployed, false);
  const providers = await call(db, 'GET', 'code/providers', { token });
  assert.equal(providers.data.providers.find(p => p.id === 'ollama').available, false);
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test('queued coding tasks cancel before the host starts, and migrations add the tables', async () => {
  const bare = new DatabaseSync(':memory:');
  const old = schema.replace(/CREATE TABLE IF NOT EXISTS code_repos[\s\S]*$/m, '');
  bare.exec(old);
  assert.throws(() => bare.prepare('SELECT id FROM code_tasks').get());
  const db = openD1From(bare);
  const su = await call(db, 'POST', 'signup', { body: { name: 'dee', pw: 'correcthorsebattery' } });
  assert.equal(su.status, 200);
  assert.doesNotThrow(() => bare.prepare('SELECT id FROM code_tasks').get());
  const repo = await call(db, 'POST', 'code/repos', { token: su.data.token, body: { name: 'app', path: '/tmp/octa-cancel-repo' } });
  const task = await call(db, 'POST', 'code/tasks', { token: su.data.token, body: { repoId: repo.data.id, title: '稍後', prompt: '先不要做', criteria: '測試要通過', engine: 'ollama' } });
  const cancel = await call(db, 'POST', 'code/tasks/' + task.data.id + '/cancel', { token: su.data.token, body: {} });
  assert.equal(cancel.data.cancelled, true);
  const got = await call(db, 'GET', 'code/tasks/' + task.data.id, { token: su.data.token });
  assert.equal(got.data.task.status, 'cancelled');
});

test('local mode state loads when there is no host computer row', async () => {
  const db = openD1();
  await db.prepare("INSERT OR IGNORE INTO users (id,name,pw,created) VALUES ('local','本機','-',?)").bind(Date.now()).run();
  const res = await onRequest({
    request: new Request('http://127.0.0.1/api/state', { headers: { host: '127.0.0.1' } }),
    env: { DB: db, ALLOW_SIGNUP: 'false', TZ_OFFSET_MIN: '480', isLocal: true },
    params: { path: ['state'] }
  });
  const data = await res.json();
  assert.equal(res.status, 200, data.error || '');
  assert.equal(data.local, true);
  assert.equal(data.host, 'local');
  assert.equal(data.runnerOnline, true);
  assert.ok(Array.isArray(data.codeTasks));
});

test('state does not return notification tokens', async () => {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'eve', pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const secret = 'tg-secret-should-not-leak-9f3a';
  const line = 'line-secret-should-not-leak-9f3a';
  const saved = await call(db, 'PUT', 'settings', { token, body: { tg: { token: secret, chat: '100' }, line: { token: line, to: 'Uabc' } } });
  assert.equal(saved.status, 200);
  const state = await call(db, 'GET', 'state', { token });
  assert.equal(state.status, 200);
  const raw = JSON.stringify(state.data);
  assert.equal(raw.includes('should-not-leak'), false);
  assert.equal(raw.includes(secret), false);
  const settings = await call(db, 'GET', 'settings', { token });
  assert.match(settings.data.tg.token, /^••••/);
  assert.equal(String(settings.data.tg.token).includes('should-not-leak'), false);
  assert.equal(String(settings.data.line.token).includes('should-not-leak'), false);
});

async function runnerOf(db, token) {
  const runner = await call(db, 'POST', 'runner-token', { token, body: { label: 'route-host' } });
  assert.equal(runner.status, 200, JSON.stringify(runner.data));
  return runner.data.token;
}
async function claimChat(db, rt) {
  const next = await call(db, 'POST', 'runner/next', { token: rt, body: { slots: 1, wait: false } });
  assert.equal(next.status, 200, JSON.stringify(next.data));
  return next.data.job;
}

test('simulated model failures keep the chat queue and classify the route', async () => {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'fay', pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const bot = await call(db, 'POST', 'bots', { token, body: { name: '助理', task: '回答', fb: ['gemini', 'opencode|qwen3'] } });
  const id = bot.data.id;
  await call(db, 'POST', 'messages', { token, body: { conv: id, text: '請回答這題' } });
  const rt = await runnerOf(db, token);
  const first = await claimChat(db, rt);
  assert.equal(first.kind, 'chat');
  assert.equal(first.bot.engine, 'claude');
  const quota = await call(db, 'POST', 'runner/done', { token: rt, body: { id: first.id, ok: false, text: 'usage limit exceeded. Resets in 1h' } });
  assert.equal(quota.status, 200);
  const second = await claimChat(db, rt);
  assert.equal(second.bot.engine, 'gemini');
  assert.equal(second.prompt, '請回答這題');
  assert.equal(second.routeTries, 0);
  const limited = await call(db, 'POST', 'runner/done', { token: rt, body: { id: second.id, ok: false, text: 'HTTP 429 too many requests' } });
  assert.equal(limited.status, 200);
  const third = await claimChat(db, rt);
  assert.equal(third.bot.engine, 'gemini');
  assert.equal(third.routeTries, 1);
  const still = await call(db, 'POST', 'runner/done', { token: rt, body: { id: third.id, ok: false, text: 'HTTP 429 too many requests' } });
  assert.equal(still.status, 200);
  const fourth = await claimChat(db, rt);
  assert.equal(fourth.bot.engine, 'opencode');
  assert.equal(fourth.bot.model, 'qwen3');
  const auth = await call(db, 'POST', 'runner/done', { token: rt, body: { id: fourth.id, ok: false, text: 'invalid api key' } });
  assert.equal(auth.status, 200);
  const none = await claimChat(db, rt);
  assert.equal(none, null);
  const msgs = await call(db, 'GET', 'messages', { token, query: { conv: id } });
  const text = msgs.data.msgs.map(m => m.text).join('\n');
  assert.match(text, /額度用完/);
  assert.match(text, /被限流/);
  assert.match(text, /API Key/);
  assert.equal(text.includes('請回答這題'), true);
  const okRun = await call(db, 'POST', 'messages', { token, body: { conv: id, text: '再說一次' } });
  assert.equal(okRun.status, 200);
  const again = await claimChat(db, rt);
  assert.equal(again.kind, 'chat');
  assert.equal(again.prompt, '再說一次');
  const done = await call(db, 'POST', 'runner/done', { token: rt, body: { id: again.id, ok: true, text: '這是真實回覆' } });
  assert.equal(done.status, 200);
  const after = await call(db, 'GET', 'messages', { token, query: { conv: id } });
  assert.ok(after.data.msgs.some(m => m.text === '這是真實回覆'));
});

test('a stopped chat and a code failure do not queue another model', async () => {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'gia', pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const bot = await call(db, 'POST', 'bots', { token, body: { name: '助理', task: '回答', fb: ['gemini'] } });
  await call(db, 'POST', 'messages', { token, body: { conv: bot.data.id, text: '做這個' } });
  const rt = await runnerOf(db, token);
  const first = await claimChat(db, rt);
  await call(db, 'POST', 'runner/done', { token: rt, body: { id: first.id, ok: false, stopped: true, text: 'usage limit exceeded' } });
  const stopped = await claimChat(db, rt);
  assert.equal(stopped, null);
  await call(db, 'POST', 'messages', { token, body: { conv: bot.data.id, text: '改程式' } });
  const code = await claimChat(db, rt);
  const failed = await call(db, 'POST', 'runner/done', { token: rt, body: { id: code.id, ok: false, text: 'AssertionError test.js failed' } });
  assert.equal(failed.status, 200, JSON.stringify(failed.data));
  const noSwitch = await claimChat(db, rt);
  assert.equal(noSwitch, null);
  const msgs = await call(db, 'GET', 'messages', { token, query: { conv: bot.data.id } });
  const text = msgs.data.msgs.map(m => m.text).join('\n');
  assert.match(text, /已停止/);
  assert.match(text, /AssertionError/);
  assert.equal(/改由/.test(text), false);
});

test('dragging a message copies it, and replace removes the original', async () => {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'copya', pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const a = await call(db, 'POST', 'bots', { token, body: { name: '甲', task: '收訊息' } });
  const b = await call(db, 'POST', 'bots', { token, body: { name: '乙', task: '收訊息' } });
  const up = await call(db, 'POST', 'files', { token, body: { conv: a.data.id, name: '圖.jpg', mime: 'image/jpeg', data: 'aGVsbG8=' } });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const sent = await call(db, 'POST', 'messages', { token, body: { conv: a.data.id, text: '照這張圖', files: [up.data.id] } });
  assert.equal(sent.status, 200);
  const src = await call(db, 'GET', 'messages', { token, query: { conv: a.data.id } });
  const msg = src.data.msgs.find(m => m.text === '照這張圖');
  assert.ok(msg);
  assert.equal(msg.files[0].id, up.data.id);
  const same = await call(db, 'POST', 'messages/copy', { token, body: { to: a.data.id, from: a.data.id, id: msg.id, replace: false } });
  assert.equal(same.status, 400);
  const copied = await call(db, 'POST', 'messages/copy', { token, body: { to: b.data.id, from: a.data.id, id: msg.id, replace: false } });
  assert.equal(copied.status, 200, JSON.stringify(copied.data));
  assert.equal(copied.data.replaced, false);
  const kept = await call(db, 'GET', 'messages', { token, query: { conv: a.data.id } });
  assert.ok(kept.data.msgs.some(m => m.id === msg.id));
  const dest = await call(db, 'GET', 'messages', { token, query: { conv: b.data.id } });
  const copy = dest.data.msgs.find(m => m.text === '照這張圖');
  assert.ok(copy);
  assert.notEqual(copy.files[0].id, up.data.id);
  const file = await call(db, 'GET', 'file/' + copy.files[0].id, { token });
  assert.equal(file.status, 200);
  assert.equal(file.data.data, 'aGVsbG8=');
  const jobs = db.raw.prepare("SELECT conv, prompt FROM jobs WHERE kind IS NULL OR kind='chat' OR kind=''").all();
  assert.ok(jobs.some(j => j.conv === b.data.id && j.prompt === '照這張圖'));
  const other = await call(db, 'POST', 'signup', { body: { name: 'copyb', pw: 'correcthorsebattery' } });
  const stolen = await call(db, 'POST', 'messages/copy', { token: other.data.token, body: { to: b.data.id, from: a.data.id, id: msg.id, replace: true } });
  assert.equal(stolen.status, 404);
  const replaced = await call(db, 'POST', 'messages/copy', { token, body: { to: b.data.id, from: a.data.id, id: msg.id, replace: true } });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.data.replaced, true);
  const gone = await call(db, 'GET', 'messages', { token, query: { conv: a.data.id } });
  assert.equal(gone.data.msgs.some(m => m.id === msg.id), false);
  const still = await call(db, 'GET', 'file/' + up.data.id, { token });
  assert.equal(still.status, 200);
  const g = await call(db, 'POST', 'groups', { token, body: { name: '組', task: '', members: [a.data.id] } });
  assert.equal(g.status, 200, JSON.stringify(g.data));
  const joined = await call(db, 'PUT', 'groups/' + g.data.id, { token, body: { name: '組', task: '', members: [a.data.id, b.data.id], folder: null } });
  assert.equal(joined.status, 200, JSON.stringify(joined.data));
  const state = await call(db, 'GET', 'state', { token });
  assert.deepEqual(state.data.groups.find(x => x.id === g.data.id).members, [a.data.id, b.data.id]);
  const page = readFileSync(join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(page, /複製並蓋掉原本的訊息/);
  assert.match(page, /messages\/copy/);
  assert.match(page, /加入群組/);
  assert.match(page, /確定要複製？/);
  const runner = readFileSync(join(import.meta.dirname, '..', 'public', 'octa-runner.mjs'), 'utf8');
  assert.match(runner, /octa:open/);
  const api = readFileSync(join(import.meta.dirname, '..', 'functions', 'api', '[[path]].js'), 'utf8');
  assert.match(api, /body\.expand/);
});

function openD1From(raw) {
  const norm = a => a.map(v => (v === undefined ? null : typeof v === 'boolean' ? +v : v));
  class Stmt {
    constructor(sql) { this.sql = sql; this.args = []; }
    bind(...a) { this.args = norm(a); return this; }
    async first() { return raw.prepare(this.sql).get(...this.args) ?? null; }
    async all() { return { results: raw.prepare(this.sql).all(...this.args) }; }
    _run() {
      const info = raw.prepare(this.sql).run(...this.args);
      return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    }
    async run() { return this._run(); }
    _exec() { return /^\s*(SELECT|WITH)/i.test(this.sql) ? { results: raw.prepare(this.sql).all(...this.args), meta: {} } : { results: [], ...this._run() }; }
  }
  return { prepare: sql => new Stmt(sql), async batch(stmts) { raw.exec('BEGIN'); try { const out = stmts.map(s => s._exec()); raw.exec('COMMIT'); return out; } catch (e) { try { raw.exec('ROLLBACK'); } catch { /* */ } throw e; } }, exec: sql => raw.exec(sql) };
}
