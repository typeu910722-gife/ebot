// OCTA desktop server: the same web app and API as the cloud version, but on this computer.
// - Data lives in a local SQLite file (sql.js, no native build needed).
// - No accounts: the app on this computer is trusted; phones pair with a one-time code.
// - The runner is built in and talks to this server over loopback.
// Can run inside Electron (main.mjs) or on its own: `node server.mjs`.

import http from 'node:http';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, chmodSync, cpSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync, execFile } from 'node:child_process';
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
  const dirty = () => { if (!timer) timer = setTimeout(save, 3000); };   // saving rewrites the whole file, so batch writes
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
const MIGRATIONS = ["ALTER TABLE bots ADD COLUMN engine TEXT NOT NULL DEFAULT 'claude'", 'ALTER TABLE bots ADD COLUMN model TEXT', 'ALTER TABLE users ADD COLUMN engines TEXT', 'ALTER TABLE jobs ADD COLUMN result TEXT', 'ALTER TABLE bots ADD COLUMN avatar TEXT', 'ALTER TABLE bots ADD COLUMN browser TEXT',
  // 2.0: host computer, live updates, files on the computer, devices
  'ALTER TABLE users ADD COLUMN host TEXT', 'ALTER TABLE users ADD COLUMN rev INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE users ADD COLUMN reset TEXT',
  'ALTER TABLE sessions ADD COLUMN seen INTEGER', 'ALTER TABLE sessions ADD COLUMN ua TEXT', 'ALTER TABLE sessions ADD COLUMN ip TEXT', 'ALTER TABLE sessions ADD COLUMN place TEXT', 'ALTER TABLE sessions ADD COLUMN info TEXT',
  'ALTER TABLE bots ADD COLUMN shot_file TEXT',
  'ALTER TABLE files ADD COLUMN conv TEXT', 'ALTER TABLE files ADD COLUMN loc TEXT', 'ALTER TABLE files ADD COLUMN path TEXT', 'ALTER TABLE files ADD COLUMN size INTEGER', 'ALTER TABLE files ADD COLUMN want INTEGER',
  'CREATE INDEX IF NOT EXISTS file_user ON files(user_id, loc)', 'ALTER TABLE jobs ADD COLUMN progress TEXT', 'ALTER TABLE jobs ADD COLUMN tokens INTEGER',
  'ALTER TABLE routines ADD COLUMN hook TEXT', 'ALTER TABLE routines ADD COLUMN watch TEXT', 'ALTER TABLE routines ADD COLUMN wstate TEXT', 'CREATE INDEX IF NOT EXISTS routine_hook ON routines(hook)', 'ALTER TABLE files ADD COLUMN pc TEXT', 'ALTER TABLE bots ADD COLUMN bpc TEXT', 'ALTER TABLE jobs ADD COLUMN pc TEXT', 'ALTER TABLE bots ADD COLUMN fb TEXT', 'ALTER TABLE jobs ADD COLUMN eng TEXT'];

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
// Windows reserves random port ranges (Hyper-V, WSL, Docker): a blocked port fails with EACCES, a used one with EADDRINUSE.
function listen(server, port, tries = 0) {
  return new Promise((ok, no) => {
    server.once('error', e => {
      if (!['EADDRINUSE', 'EACCES', 'EPERM'].includes(e.code)) return no(e);
      ok(listen(server, tries < 20 ? port + 2 : 0, tries + 1));   // after 20 tries let the system pick a free port
    });
    server.listen(port, '127.0.0.1', () => ok(server.address().port));
  });
}
function openExternal(target) {
  if (WIN) spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
}

// ---------- file folder ----------
// Google Drive for desktop shows up as a drive (G:\我的雲端硬碟) or under CloudStorage on a Mac
function googleDrive() {
  const names = ['我的雲端硬碟', 'My Drive', '我的云端硬盘', 'マイドライブ'];
  if (WIN) {
    for (const L of 'GHIJKLMNOPQRSTUVWXYZDEF') for (const n of names) { const p = `${L}:\\${n}`; if (existsSync(p)) return p; }
    for (const n of names) { const p = join(os.homedir(), 'Google Drive', n); if (existsSync(p)) return p; }
    const old = join(os.homedir(), 'Google Drive'); if (existsSync(old)) return old;
  } else {
    const cs = join(os.homedir(), 'Library', 'CloudStorage');
    try { for (const d of readdirSync(cs).filter(x => x.startsWith('GoogleDrive'))) for (const n of names) { const p = join(cs, d, n); if (existsSync(p)) return p; } } catch { }
  }
  return null;
}
function moveDir(from, to) {   // move existing files into the new folder (merge, keep anything already there)
  for (const f of readdirSync(from)) {
    const a = join(from, f), b = join(to, f);
    if (existsSync(b)) continue;
    try { renameSync(a, b); } catch { cpSync(a, b, { recursive: true }); rmSync(a, { recursive: true, force: true }); }
  }
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
  const base = { DB: db, TZ_OFFSET_MIN: String(tzOffset), ALLOW_SIGNUP: 'false' };
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
      await callApi(req, res, { ...base, isLocal: true, runnerOnline: () => Date.now() - runnerSeen < 60000 }, `http://${host}`);
    } catch (e) { json(res, { error: e.message }, 500); }
  });
  // reuse last port so the window keeps its saved preferences (language, drafts)
  const portFile = join(dataDir, 'port.txt');
  let want = opts.port || 17777;
  try { const p = +readFileSync(portFile, 'utf8'); if (p > 1024 && p < 65535) want = p; } catch { }
  localPort = await listen(local, want);
  try { writeFileSync(portFile, String(localPort)); } catch { }

  // remote port: only reached through the tunnel; phone must pair first
  const remoteSrv = http.createServer(async (req, res) => {
    try {
      if (!remote.on) { res.writeHead(503); return res.end('遠端已關閉'); }
      if (!req.url.startsWith('/api/')) return serveStatic(req, res);
      if (req.url.startsWith('/api/desktop/') || req.url.startsWith('/api/runner')) { res.writeHead(403); return res.end(); }
      await callApi(req, res, {
        ...base, runnerOnline: () => Date.now() - runnerSeen < 60000,
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
      if (WIN) spawn('cmd', ['/c', 'start', '', 'powershell', '-NoProfile', '-NoExit', '-Command', "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Host 'Type /login to sign in to Claude, then close this window.'; claude"], { detached: true, stdio: 'ignore' }).unref();
      else if (process.platform === 'darwin') spawn('osascript', ['-e', 'tell application "Terminal" to do script "claude"']).unref();
      else spawn('x-terminal-emulator', ['-e', 'claude'], { detached: true, stdio: 'ignore' }).unref();
    },
    openFolder: () => openExternal(dataDir),
    installEngine: async (key) => {   // opens a terminal window that installs the tool, then starts its sign-in
      const { ENGINES } = await import(pathToFileURL(join(WEB, 'octa-runner.mjs')).href);
      const e = ENGINES[key];
      if (!e) throw new Error('沒有這個 AI');
      const dir = join(dataDir, 'bin'); mkdirSync(dir, { recursive: true });
      const installCmd = e.npm ? `npm install -g ${e.npm}` : e.install[WIN ? 'win' : 'mac'];
      const preCmd = e.pre ? e.pre[WIN ? 'win' : 'mac'] : '';
      if (WIN) {   // PowerShell script saved as UTF-8 with BOM: cmd batch files mangle Chinese text ("'◆' is not recognized")
        const q = t => "'" + String(t).replace(/'/g, "''") + "'";
        const say = t => `Write-Host ${q(t)}`;
        const f = join(dir, `install-${key}.ps1`);
        // "powershell -Command '...'" installers run with the progress bar off
        // (Windows PowerShell 5's progress bar makes downloads crawl)
        // (an installer run in a child PowerShell, so an `exit` inside it can't close this window)
        const inline = c => { const m = /^(powershell .*?-Command )"(.*)"$/.exec(c || ''); return m ? `${m[1]}"\`$ProgressPreference='SilentlyContinue'; ${m[2]}"` : c; };
        const install = inline(installCmd), pre = inline(preCmd);
        writeFileSync(f, '\ufeff' + ['[Console]::OutputEncoding = [Text.Encoding]::UTF8', `$Host.UI.RawUI.WindowTitle = ${q('安裝 ' + e.label)}`,
          '$ErrorActionPreference = "Continue"', "$ProgressPreference = 'SilentlyContinue'",
          e.npm ? `if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { ${say('先安裝 Node.js（安裝 AI 工具需要它）…')}; winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements; $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }` : '',
          e.npm ? `if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { ${say('無法自動安裝 Node.js，請到 https://nodejs.org 安裝後重新按一次「安裝並登入」')}; Start-Process 'https://nodejs.org'; Read-Host ${q('按 Enter 關閉')}; exit }` : '',
          'Set-Location $HOME',   // not the OCTA folder: AI tools ask whether to trust the folder they start in
          say(`正在安裝 ${e.label}…`), pre, install,
          e.paths ? `$env:Path = [Environment]::ExpandEnvironmentVariables(${q(e.paths.win)}) + ';' + $env:Path` : '',
          e.npm ? `$env:Path = (npm prefix -g) + ';' + $env:Path` : '',
          // installer servers sometimes refuse for a moment (rate limits); try once more
          `if (-not (Get-Command ${q(e.bin)} -ErrorAction SilentlyContinue)) { ${say('安裝沒有成功，10 秒後再試一次…')}; Start-Sleep 10; ${install}; $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path }`,
          `if (-not (Get-Command ${q(e.bin)} -ErrorAction SilentlyContinue)) { ${say('還是沒有安裝成功，請把上面的錯誤訊息截圖給我們，或稍後再按一次「安裝並登入」。')}; Read-Host ${q('按 Enter 關閉')}; exit }`,
          "Write-Host ''", say(`安裝完成。接著登入：${e.loginHint}`), "Write-Host ''", e.login,
          "Write-Host ''", `Read-Host ${q('完成後按 Enter 關閉這個視窗，回到 OCTA 按「測試」')}`].filter(Boolean).join('\r\n'));
        spawn('cmd', ['/c', 'start', '', 'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f], { cwd: os.homedir(), detached: true, stdio: 'ignore', windowsHide: false }).unref();
      } else {
        const f = join(dir, `install-${key}.command`);
        const install = installCmd, pre = preCmd;
        writeFileSync(f, ['#!/bin/bash', e.npm ? 'command -v npm >/dev/null || { echo "需要先安裝 Node.js：https://nodejs.org"; read -p "按 Enter 關閉"; exit; }' : '',
          `echo "正在安裝 ${e.label}…"`, pre, install, e.paths ? `export PATH="${e.paths.mac}:$PATH"` : '',
          `echo; echo "安裝完成。接著登入：${e.loginHint}"; echo`, e.login, 'echo; read -p "完成後按 Enter 關閉，回到 OCTA 按「測試」"'].filter(Boolean).join('\n'));
        chmodSync(f, 0o755);
        if (process.platform === 'darwin') spawn('open', ['-a', 'Terminal', f], { detached: true, stdio: 'ignore' }).unref();
        else spawn('x-terminal-emulator', ['-e', f], { detached: true, stdio: 'ignore' }).unref();
      }
    },
    getAutostart: () => false,
    getExtToken: () => { try { return JSON.parse(readFileSync(join(dataDir, 'desktop.json'), 'utf8')).extToken || ''; } catch { return ''; } },
    setExtToken: t => { let c = {}; try { c = JSON.parse(readFileSync(join(dataDir, 'desktop.json'), 'utf8')); } catch { } c.extToken = t; writeFileSync(join(dataDir, 'desktop.json'), JSON.stringify(c, null, 2)); },
    setAutostart: () => { throw new Error('只有安裝版支援開機自動啟動'); },
    getStore: () => { try { return JSON.parse(readFileSync(join(dataDir, 'desktop.json'), 'utf8')).store || join(dataDir, 'files'); } catch { return join(dataDir, 'files'); } },
    setStore: p => { let c = {}; try { c = JSON.parse(readFileSync(join(dataDir, 'desktop.json'), 'utf8')); } catch { } c.store = p; writeFileSync(join(dataDir, 'desktop.json'), JSON.stringify(c, null, 2)); },
    pickFolder: async () => null,
    ...opts.hooks
  };
  // which AI tools are installed; checked in parallel without blocking, cached for a minute
  let engCache = null, engAt = 0, engJob = null;
  async function engineStatus(fresh) {
    if (!fresh && engCache && Date.now() - engAt < 60000) return engCache;
    if (engJob) return engJob;
    const { ENGINES } = await import(pathToFileURL(join(WEB, 'octa-runner.mjs')).href);
    const ver = bin => new Promise(ok => execFile(bin, ['--version'], { shell: WIN, timeout: 15000, windowsHide: true, encoding: 'utf8' },
      (err, out) => ok({ ok: !err, version: (out || '').trim().split(/\s/).find(x => /\d/.test(x)) || '' })));
    engJob = Promise.all(Object.entries(ENGINES).map(async ([k, e]) => { const v = await ver(e.bin); if (v.ok && e.also) v.ok = (await ver(e.also)).ok; return [k, v]; }))
      .then(r => { engCache = Object.fromEntries(r); engAt = Date.now(); return engCache; }).finally(() => (engJob = null));
    return engJob;
  }
  engineStatus().catch(() => { });   // warm the cache in the background
  async function desktopApi(req, res) {
    const p = new URL(req.url, 'http://x').pathname.slice('/api/desktop/'.length);
    const body = req.method === 'POST' ? await readJson(req) : {};
    if (p === 'status') {
      const engines = await engineStatus(!!body.fresh || new URL(req.url, 'http://x').searchParams.has('fresh'));
      const { findChrome } = await import(pathToFileURL(join(WEB, 'octa-runner.mjs')).href);
      return json(res, {
        version: APP_VERSION,
        claude: engines.claude, engines,
        chrome: !!findChrome(),
        autostart: !!hooks.getAutostart(), extToken: !!hooks.getExtToken(), store: hooks.getStore(),
        remote: remote.on ? { on: true, url: remote.url, code: remote.code, qr: await qr(remote.url) } : { on: false }
      });
    }
    try {
      if (p === 'remote') return json(res, await setRemote(!!body.on));
      if (p === 'login-claude') { hooks.loginClaude(); return json(res, { ok: true }); }
      if (p === 'install') { await hooks.installEngine(String(body.engine || '')); return json(res, { ok: true }); }
      if (p === 'open-folder') { hooks.openFolder(); return json(res, { ok: true }); }
      // files that live on this computer: read, show or open them here instead of fetching a copy through the cloud
      if (p === 'file' || p === 'show-file' || p === 'open-file') {
        const rel = String(body.path || '').replace(/\\/g, '/');
        if (!rel || rel.split('/').includes('..') || /^([a-z]:|\/)/i.test(rel)) return json(res, { error: '路徑不正確' }, 400);
        const full = join(hooks.getStore(), ...rel.split('/'));
        if (!existsSync(full)) return json(res, { missing: true });
        if (p === 'show-file') {
          if (WIN) spawn('explorer', ['/select,', full], { detached: true, stdio: 'ignore' }).unref();
          else if (process.platform === 'darwin') spawn('open', ['-R', full], { detached: true, stdio: 'ignore' }).unref();
          else openExternal(dirname(full));
          return json(res, { ok: true });
        }
        if (p === 'open-file') { openExternal(full); return json(res, { ok: true }); }
        if (statSync(full).size > 40 * 1024 * 1024) return json(res, { tooBig: true });
        return json(res, { data: readFileSync(full).toString('base64') });
      }
      if (p === 'autostart') { hooks.setAutostart(!!body.on); return json(res, { ok: true }); }
      if (p === 'store') {   // where attachments, screenshots and outputs are kept
        const cur = hooks.getStore(), def = join(dataDir, 'files'), gd = googleDrive();
        if (body.set) {
          let to = body.set === 'default' ? def : body.set === 'google' ? (gd ? join(gd, 'OCTA') : null) : body.set === 'pick' ? await hooks.pickFolder() : null;
          if (!to) return json(res, { error: body.set === 'google' ? '找不到 Google 雲端硬碟。請先安裝「Google 雲端硬碟電腦版」並登入。' : '沒有選擇資料夾' }, 400);
          if (body.set === 'pick' && !/OCTA$/i.test(to)) to = join(to, 'OCTA');
          if (to !== cur) {
            mkdirSync(to, { recursive: true });
            if (body.move && existsSync(cur)) moveDir(cur, to);
            hooks.setStore(to);
          }
        }
        const now = hooks.getStore();
        return json(res, { path: now, isDefault: now === def, google: gd ? join(gd, 'OCTA') : '', onGoogle: !!gd && now.startsWith(gd) });
      }
      if (p === 'open-store') { mkdirSync(hooks.getStore(), { recursive: true }); openExternal(hooks.getStore()); return json(res, { ok: true }); }
      if (p === 'ext-token') {   // token from the Playwright Extension, kept only on this computer
        if (body.token !== undefined) hooks.setExtToken(String(body.token).trim().slice(0, 200));
        return json(res, { set: !!hooks.getExtToken() });
      }
    } catch (e) { return json(res, { error: e.message }, 400); }
    json(res, { error: '找不到' }, 404);
  }

  // call the desktop API from the Electron main process (the cloud page reaches it through the preload bridge)
  async function callDesktop(p, body) {
    const r = await fetch(`http://127.0.0.1:${localPort}/api/desktop/${p}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
    return d;
  }

  // built-in runner
  const { startRunner } = await import(pathToFileURL(join(WEB, 'octa-runner.mjs')).href);
  let bundled = {};
  try { bundled = { pwCli: join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js'), nodeBin: process.execPath }; } catch { }
  // the desktop app runs the runner itself when signed in to the cloud; local mode runs it here
  const runner = opts.runner === false ? { stop() { } } : startRunner({ url: `http://127.0.0.1:${localPort}`, token: '', home: dataDir, getExtToken: () => hooks.getExtToken(), getStore: () => hooks.getStore(), openInstall: k => hooks.installEngine(k), ...bundled, ...opts.runnerOpts });

  return {
    url: `http://127.0.0.1:${localPort}`, dataDir, webDir: WEB, desktopApi: (p, body) => callDesktop(p, body), getStore: () => hooks.getStore(), installEngine: k => hooks.installEngine(k),
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
