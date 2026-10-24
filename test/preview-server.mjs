// Local preview of the coding-task UI. Not a production server.
// Uses the real API in desktop/offline mode (no account) and, when Ollama is absent,
// can run one task through the fixture provider so the screen shows execution evidence.
//   node test/preview-server.mjs
// Open the printed URL, then 設定 → 程式任務.

import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { probeCodingHosts, runCodingTask, selectProvider } from '../public/coding-runtime.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'public');
const { onRequest } = await import(pathToFileURL(join(root, 'functions', 'api', '[[path]].js')).href);
const schema = readFileSync(join(root, 'schema.sql'), 'utf8');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

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
      catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
    },
    exec: sql => db.exec(sql)
  };
}

const db = openD1();
await db.prepare("INSERT OR IGNORE INTO users (id,name,pw,created) VALUES ('local','本機','-',?)").bind(Date.now()).run();
const env = { DB: db, ALLOW_SIGNUP: 'false', TZ_OFFSET_MIN: '480', isLocal: true, OCTA_CODE_ALLOW_FIXTURE: process.env.OCTA_CODE_ALLOW_FIXTURE || '' };

async function call(method, path, body) {
  const req = new Request('http://127.0.0.1/api/' + path, {
    method, headers: { 'content-type': 'application/json', host: '127.0.0.1' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {})
  });
  const res = await onRequest({ request: req, env, params: { path: path.split('/').filter(Boolean) } });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'octa-preview-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'add', scripts: { test: 'node test.js' } }));
  writeFileSync(join(dir, 'src/add.js'), 'function add(a, b) { return a - b; }\nmodule.exports = { add };\n');
  writeFileSync(join(dir, 'test.js'), "const assert = require('assert');\nconst { add } = require('./src/add.js');\nassert.strictEqual(add(2, 3), 5);\n");
  for (const args of [['init'], ['add', '-A'], ['commit', '-m', 'init']]) {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status) throw new Error(r.stderr || r.stdout);
  }
  return dir;
}

async function seed() {
  const hosts = await probeCodingHosts({ timeoutMs: 400 });
  await call('POST', 'runner/next', { slots: 0, wait: false, coding: hosts });
  if (process.env.OCTA_PREVIEW_DEMO !== '1') return;
  process.env.OCTA_CODE_ALLOW_FIXTURE = '1';
  env.OCTA_CODE_ALLOW_FIXTURE = '1';
  const repoPath = makeRepo();
  const repo = await call('POST', 'code/repos', { name: '加法範例', path: repoPath });
  const task = await call('POST', 'code/tasks', { repoId: repo.data.id, title: '修正加法', prompt: '讓 add(2, 3) 等於 5。不要改測試。', criteria: '測試要通過', engine: 'fixture', model: 'repair' });
  const provider = await selectProvider({ engine: 'fixture', model: 'repair', allowFixture: true });
  const rootWs = mkdtempSync(join(tmpdir(), 'octa-preview-ws-'));
  await runCodingTask({
    id: task.data.id, title: '修正加法', prompt: '讓 add(2, 3) 等於 5。不要改測試。', criteria: '測試要通過',
    engine: 'fixture', model: 'repair', maxRepairs: 3, repoPath, workspacesRoot: rootWs, provider,
    persist: summary => call('POST', 'runner/code/event', {
      taskId: summary.id, status: summary.status, phase: summary.phase, role: summary.role,
      workspaceId: summary.workspaceId, branch: summary.branch, baseRef: summary.baseRef, headRef: summary.headRef,
      retries: summary.repairs, summary, events: (summary.events || []).slice(-2)
    })
  });
  console.log('demo task', task.data.id, 'repo', repoPath);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString() || undefined;
      const request = new Request('http://127.0.0.1' + req.url, { method: req.method, headers: { ...req.headers, host: '127.0.0.1' }, body: req.method === 'GET' ? undefined : raw });
      const path = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
      const out = await onRequest({ request, env, params: { path } });
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
      return;
    }
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = normalize(join(web, p));
    if (!file.startsWith(web) || !existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  } catch (e) { res.writeHead(500); res.end(e.message); }
});

await seed();
const port = await new Promise(ok => server.listen(0, '127.0.0.1', () => ok(server.address().port)));
console.log('OCTA preview http://127.0.0.1:' + port);
