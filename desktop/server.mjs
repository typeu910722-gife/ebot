// OCTA desktop server: the same web app and API as the cloud version, but on this computer.
// - Data lives in a local SQLite file (sql.js, no native build needed).
// - No accounts: the app on this computer is trusted; phones pair with a one-time code.
// - The runner is built in and talks to this server over loopback.
// Can run inside Electron (main.mjs) or on its own: `node server.mjs`.

import http from 'node:http';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, createWriteStream, chmodSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const WIN = process.platform === 'win32';
const pick = (...ps) => ps.find(p => existsSync(p));

// When packaged, build.mjs copies the web app, API and schema next to this file.
const WEB = pick(join(here, 'web'), join(here, '..', 'public'));
const API = pick(join(here, 'api.js'), join(here, '..', 'functions', 'api', '[[path]].js'));
const SCHEMA = pick(join(here, 'schema.sql'), join(here, '..', 'schema.sql'));
export const APP_VERSION = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version;

// ---------- D1-compatible wrapper around sql.js ----------
async function openDb(file) {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ locateFile: f => join(dirname(require.resolve('sql.js')), f) });
  const db = existsSync(file) ? new SQL.Database(readFileSync(file)) : new SQL.Database();
  let timer = null;
  const save = () => {
    clearTimeout(timer); timer = null;
    const tmp = file + '.tmp';
    writeFileSync(tmp, Buffer.from(db.export()));
    renameSync(tmp, file);
  };
  const dirty = () => { if (!timer) timer = setTimeout(save, 400); };
  const norm = a => a.map(v => (v === undefined ? null : typeof v === 'boolean' ? +v : v));
  class Stmt {
    constructor(sql) { this.sql = sql; this.args = []; }
    bind(...a) { this.args = norm(a); return this; }
    _all() {
      const st = db.prepare(this.sql); st.bind(this.args);
      const rows = []; while (st.step()) rows.push(st.getAsObject()); st.free();
      return rows;
    }
    _run() {
      db.run(this.sql, this.args);
      const changes = db.getRowsModified();
      const last = db.exec('SELECT last_insert_rowid() AS id')[0]?.values[0][0] ?? 0;
      dirty();
      return { success: true, meta: { changes, last_row_id: last } };
    }
    _exec() { return /^\s*(SELECT|WITH)/i.test(this.sql) ? { results: this._all(), meta: {} } : { results: [], ...this._run() }; }
    async first() { return this._all()[0] ?? null; }
    async all() { return { results: this._all(), meta: {} }; }
    async run() { return this._run(); }
  }
  const d1 = {
    prepare: sql => new Stmt(sql),
    async batch(stmts) {
      db.run('BEGIN');
      try { const out = stmts.map(s => s._exec()); db.run('COMMIT'); dirty(); return out; }
      catch (e) { db.run('ROLLBACK'); throw e; }
    },
    exec: sql => { db.exec(sql); dirty(); },
    save
  };
  return d1;
}
// Columns added after a release go here so existing installs upgrade in place.
const MIGRATIONS = ["ALTER TABLE bots ADD COLUMN engine TEXT NOT NULL DEFAULT 'claude'", 'ALTER TABLE bots ADD COLUMN model TEXT', 'ALTER TABLE users ADD COLUMN engines TEXT', 'ALTER TABLE jobs ADD COLUMN result TEXT', 'ALTER TABLE bots ADD COLUMN avatar TEXT'];

// ---------- helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const f = normalize(join(WEB, p));
  if (!f.startsWith(WEB) || !existsSync(f)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
  res.end(readFileSync(f));
}
async function toRequest(req, base) {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(base + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
}
async function sendResponse(res, r) {
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}
const json = (res, data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
const readJson = async req => { const c = []; for await (const x of req) c.push(x); try { return JSON.parse(Buffer.concat(c).toString() || '{}'); } catch { return {}; } };
function listen(server, port) {
  return new Promise((ok, no) => {
    server.once('error', e => (e.code === 'EADDRINUSE' ? ok(listen(server, port + 2)) : no(e)));
    server.listen(port, '127.0.0.1', () => ok(server.address().port));
  });
}
function openExternal(target) {
  if (WIN) spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
}

// ---------- remote access (Cloudflare quick tunnel) ----------
const CF_URL = {
  win32: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
  darwin: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${os.arch() === 'arm64' ? 'arm64' : 'amd64'}.tgz`,
  linux: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${os.arch() === 'arm64' ? 'arm64' : 'amd64'}`
};
async function ensureCloudflared(dir) {
  const bin = join(dir, WIN ? 'cloudflared.exe' : 'cloudflared');
  if (existsSync(bin)) return bin;
  mkdirSync(dir, { recursive: true });
  const url = CF_URL[process.platform];
  if (!url) throw new Error('這個作業系統不支援手機遠端');
  const r = await fetch(url);
  if (!r.ok) throw new Error('下載連線工具失敗（' + r.status + '）');
  const buf = Buffer.from(await r.arrayBuffer());
  if (url.endsWith('.tgz')) {
    const tgz = bin + '.tgz'; writeFileSync(tgz, buf);
    spawnSync('tar', ['-xzf', tgz, '-C', dir]);
  } else writeFileSync(bin, buf);
  if (!WIN) chmodSync(bin, 0o755);
  return bin;
}
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 8 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');

// ---------- main ----------
// opts: { dataDir, port, onNotify(text), hooks: { loginClaude, openFolder, getAutostart, setAutostart }, runnerOpts }
export async function startServer(opts = {}) {
  const dataDir = opts.dataDir || (existsSync(join(os.homedir(), '.ebot')) ? join(os.homedir(), '.ebot') : join(os.homedir(), '.octa'));
  mkdirSync(dataDir, { recursive: true });
  const db = await openDb(join(dataDir, 'ebot.sqlite'));
  db.exec(readFileSync(SCHEMA, 'utf8'));
  for (const m of MIGRATIONS) { try { db.exec(m); } catch { } }
  await db.prepare("INSERT OR IGNORE INTO users (id,name,pw,created) VALUES ('local','本機','-',?)").bind(Date.now()).run();
  const { onRequest } = await import(pathToFileURL(API).href);

  const tzOffset = -new Date().getTimezoneOffset();
  let runnerSeen = 0;
  const remote = { on: false, url: '', code: '', proc: null, fails: 0 };
  const base = { DB: db, TZ_OFFSET_MIN: String(tzOffset), ALLOW_SIGNUP: 'false', onNotify: opts.onNotify };
  const callApi = async (req, res, env, origin) => {
    const request = await toRequest(req, origin);
    const path = new URL(request.url).pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    if (path[0] === 'runner') runnerSeen = Date.now();
    await sendResponse(res, await onRequest({ request, env, params: { path } }));
  };

  // local port: the desktop window and the built-in runner; trusted, no login
  let localPort = 0;
  const local = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) { res.writeHead(403); return res.end(); }   // DNS-rebinding guard
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) { res.writeHead(403); return res.end(); }
      if (!req.url.startsWith('/api/')) return serveStatic(req, res);
      if (req.method !== 'GET' && !(req.headers['content-type'] || '').includes('application/json')) { res.writeHead(415); return res.end(); }   // forces a CORS preflight for other sites
      if (req.url.startsWith('/api/desktop/')) return desktopApi(req, res);
      await callApi(req, res, { ...base, isLocal: true, runnerOnline: () => Date.now() - runnerSeen < 30000 }, `http://${host}`);
    } catch (e) { json(res, { error: e.message }, 500); }
  });
  localPort = await listen(local, opts.port || 17777);

  // remote port: only reached through the tunnel; phone must pair first
  const remoteSrv = http.createServer(async (req, res) => {
    try {
      if (!remote.on) { res.writeHead(503); return res.end('遠端已關閉'); }
      if (!req.url.startsWith('/api/')) return serveStatic(req, res);
      if (req.url.startsWith('/api/desktop/') || req.url.startsWith('/api/runner')) { res.writeHead(403); return res.end(); }
      await callApi(req, res, {
        ...base, runnerOnline: () => Date.now() - runnerSeen < 30000,
        pairCheck: code => {
          if (remote.code && code.trim().toUpperCase() === remote.code) { remote.fails = 0; return true; }
          if (++remote.fails >= 10) { remote.code = newCode(); remote.fails = 0; }   // too many guesses: rotate
          return false;
        }
      }, 'https://' + (req.headers.host || 'remote'));
    } catch (e) { json(res, { error: e.message }, 500); }
  });
  const remotePort = await listen(remoteSrv, localPort + 1);

  async function setRemote(on) {
    if (!on) { remote.proc?.kill(); Object.assign(remote, { on: false, url: '', code: '', proc: null }); return { on: false }; }
    if (remote.on && remote.url) return { on: true, url: remote.url, code: remote.code, qr: await qr(remote.url) };
    const bin = await ensureCloudflared(join(dataDir, 'bin'));
    const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${remotePort}`], { windowsHide: true });
    remote.proc = proc; remote.code = newCode(); remote.on = true;
    remote.url = await new Promise((ok, no) => {
      const t = setTimeout(() => no(new Error('連線逾時，請再試一次')), 45000);
      const scan = d => { const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m) { clearTimeout(t); ok(m[0]); } };
      proc.stdout.on('data', scan); proc.stderr.on('data', scan);
      proc.on('exit', () => { clearTimeout(t); no(new Error('連線工具結束了')); });
    }).catch(e => { proc.kill(); Object.assign(remote, { on: false, proc: null }); throw e; });
    proc.on('exit', () => { if (remote.proc === proc) Object.assign(remote, { on: false, url: '', proc: null }); });
    return { on: true, url: remote.url, code: remote.code, qr: await qr(remote.url) };
  }
  async function qr(text) { try { return await require('qrcode').toDataURL(text, { margin: 1, width: 360 }); } catch { return ''; } }

  const hooks = {
    loginClaude: () => {
      if (WIN) spawn('cmd', ['/c', 'start', 'cmd', '/k', 'echo 在下面輸入 /login 登入 Claude，完成後關掉這個視窗 && claude'], { detached: true, stdio: 'ignore' }).unref();
      else if (process.platform === 'darwin') spawn('osascript', ['-e', 'tell application "Terminal" to do script "claude"']).unref();
      else spawn('x-terminal-emulator', ['-e', 'claude'], { detached: true, stdio: 'ignore' }).unref();
    },
    openFolder: () => openExternal(dataDir),
    installEngine: async (key) => {   // opens a terminal window that installs the tool, then starts its sign-in
      const { ENGINES } = await import(pathToFileURL(join(WEB, 'octa-runner.mjs')).href);
      const e = ENGINES[key];
      if (!e) throw new Error('沒有這個 AI');
      const dir = join(dataDir, 'bin'); mkdirSync(dir, { recursive: true });
      const install = e.npm ? `npm install -g ${e.npm}` : e.install[WIN ? 'win' : 'mac'];
      if (WIN) {
        const f = join(dir, `install-${key}.cmd`);
        writeFileSync(f, ['@echo off', 'chcp 65001 >nul', `title 安裝 ${e.label}`,
          e.npm ? 'where npm >nul 2>nul || (echo 需要先安裝 Node.js：https://nodejs.org ，裝好後重新按一次「安裝並登入」 & start https://nodejs.org & pause & exit /b)' : '',
          `echo 正在安裝 ${e.label}…`, install,
          e.paths ? `set "PATH=${e.paths.win};%PATH%"` : '',
          'echo.', `echo 安裝完成。接著登入：${e.loginHint}`, 'echo.', e.login,
          'echo.', 'echo 完成後可以關掉這個視窗，回到 OCTA 按「測試」。', 'pause'].filter(Boolean).join('\r\n'));
        spawn('cmd', ['/c', 'start', '', f], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      } else {
        const f = join(dir, `install-${key}.command`);
        writeFileSync(f, ['#!/bin/bash', e.npm ? 'command -v npm >/dev/null || { echo "需要先安裝 Node.js：https://nodejs.org"; read -p "按 Enter 關閉"; exit; }' : '',
          `echo "正在安裝 ${e.label}…"`, install, e.paths ? `export PATH="${e.paths.mac}:$PATH"` : '',
          `echo; echo "安裝完成。接著登入：${e.loginHint}"; echo`, e.login, 'echo; read -p "完成後按 Enter 關閉，回到 OCTA 按「測試」"'].filter(Boolean).join('\n'));
        chmodSync(f, 0o755);
        if (process.platform === 'darwin') spawn('open', ['-a', 'Terminal', f], { detached: true, stdio: 'ignore' }).unref();
        else spawn('x-terminal-emulator', ['-e', f], { detached: true, stdio: 'ignore' }).unref();
      }
    },
    getAutostart: () => false,
    setAutostart: () => { throw new Error('只有安裝版支援開機自動啟動'); },
    ...opts.hooks
  };
  async function desktopApi(req, res) {
    const p = new URL(req.url, 'http://x').pathname.slice('/api/desktop/'.length);
    const body = req.method === 'POST' ? await readJson(req) : {};
    if (p === 'status') {
      const ver = bin => { const c = spawnSync(bin, ['--version'], { shell: WIN, encoding: 'utf8', timeout: 15000, windowsHide: true }); return { ok: c.status === 0, version: (c.stdout || '').trim().split(/\s/).find(x => /\d/.test(x)) || '' }; };
      const { findChrome } = await import(pathToFileURL(join(WEB, 'octa-runner.mjs')).href);
      const { ENGINES } = await import(pathToFileURL(join(WEB, 'octa-runner.mjs')).href);
      const engines = Object.fromEntries(Object.entries(ENGINES).map(([k, e]) => [k, ver(e.bin)]));
      return json(res, {
        version: APP_VERSION,
        claude: engines.claude, engines,
        chrome: !!findChrome(),
        autostart: !!hooks.getAutostart(),
        remote: remote.on ? { on: true, url: remote.url, code: remote.code, qr: await qr(remote.url) } : { on: false }
      });
    }
    try {
      if (p === 'remote') return json(res, await setRemote(!!body.on));
      if (p === 'login-claude') { hooks.loginClaude(); return json(res, { ok: true }); }
      if (p === 'install') { await hooks.installEngine(String(body.engine || '')); return json(res, { ok: true }); }
      if (p === 'open-folder') { hooks.openFolder(); return json(res, { ok: true }); }
      if (p === 'autostart') { hooks.setAutostart(!!body.on); return json(res, { ok: true }); }
    } catch (e) { return json(res, { error: e.message }, 400); }
    json(res, { error: '找不到' }, 404);
  }

  // built-in runner
  const { startRunner } = await import(pathToFileURL(join(WEB, 'octa-runner.mjs')).href);
  let bundled = {};
  try { bundled = { pwCli: join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js'), nodeBin: process.execPath }; } catch { }
  const runner = startRunner({ url: `http://127.0.0.1:${localPort}`, token: '', home: dataDir, ...bundled, ...opts.runnerOpts });

  return {
    url: `http://127.0.0.1:${localPort}`, dataDir,
    async close() { runner.stop(); remote.proc?.kill(); db.save(); local.close(); remoteSrv.close(); }
  };
}

// standalone: node server.mjs
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = await startServer({ onNotify: t => console.log('🔔 ' + t) });
  console.log(`OCTA 已啟動：${s.url}　資料夾：${s.dataDir}`);
  if (!process.argv.includes('--no-open')) openExternal(s.url);
  const bye = async () => { await s.close(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
