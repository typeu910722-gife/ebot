// OCTA desktop (Electron).
// Signed in: the window shows the OCTA website (same account as the web version, everything syncs)
// and this computer runs that account's bots. Offline mode: everything stays on this computer.
import { app, BrowserWindow, WebContentsView, Tray, Menu, Notification, shell, nativeImage, dialog, ipcMain } from 'electron';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, appendFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { startServer } from './server.mjs';
import { startCdpBridge } from './cdp-bridge.mjs';

// ---------- updates (GitHub Releases) ----------
const { autoUpdater } = createRequire(import.meta.url)('electron-updater');
let upd = { state: 'idle', version: '', percent: 0, error: '' };   // idle | checking | available | none | downloading | ready | error
function setUpd(u) { upd = { ...upd, ...u }; win?.webContents.send('octa:update', upd); }
autoUpdater.autoDownload = false;                 // ask first: the user presses 更新
autoUpdater.autoInstallOnAppQuit = false;   // install only when the user presses the button (after freeing the install folder)
autoUpdater.on('checking-for-update', () => setUpd({ state: 'checking', error: '' }));
const plainNotes = n => (Array.isArray(n) ? n.map(x => x.note || '').join('\n') : String(n || '')).replace(/<\/(p|li|h\d)>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim().slice(0, 3000);
autoUpdater.on('update-available', i => setUpd({ state: 'available', version: i.version, notes: plainNotes(i.releaseNotes), date: i.releaseDate || '' }));
autoUpdater.on('update-not-available', () => setUpd({ state: 'none' }));
autoUpdater.on('download-progress', p => setUpd({ state: 'downloading', percent: Math.round(p.percent || 0) }));
autoUpdater.on('update-downloaded', i => setUpd({ state: 'ready', version: i.version, percent: 100, admin: needsAdmin() }));
autoUpdater.on('error', e => { setUpd({ state: 'error', error: String(e?.message || e).slice(0, 300) }); });
function checkUpdates() { if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => { }); }

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const unpacked = p => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const CLOUD = (process.env.OCTA_CLOUD || 'https://octa.yzprojecttw.com').replace(/\/+$/, '');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }   // already running: the first copy shows its window
app.setAppUserModelId('tw.yzproject.octa');

let win = null, tray = null, server = null, quitting = false, runner = null, runnerFor = '';
const LOGIN_ARGS = ['--hidden'];
const hiddenStart = process.argv.includes('--hidden') || app.getLoginItemSettings({ args: LOGIN_ARGS }).wasOpenedAtLogin;
const icon = () => nativeImage.createFromPath(join(here, 'icon.png'));

// keep data from installs made before the rename
const oldDir = join(app.getPath('appData'), 'E·BOT');
const dataDir = existsSync(join(oldDir, 'ebot.sqlite')) && !existsSync(join(app.getPath('userData'), 'ebot.sqlite')) ? oldDir : app.getPath('userData');
const cfgFile = join(dataDir, 'desktop.json');
const readCfg = () => { try { return JSON.parse(readFileSync(cfgFile, 'utf8')); } catch { return {}; } };
const writeCfg = c => { try { mkdirSync(dataDir, { recursive: true }); writeFileSync(cfgFile, JSON.stringify(c, null, 2)); } catch { } };
let cfg = readCfg();

// anything that goes wrong is written to octa-error.log and shown, instead of failing silently
function logError(where, e) {
  const line = `[${new Date().toISOString()}] ${where}: ${e?.stack || e}\n`;
  try { mkdirSync(dataDir, { recursive: true }); appendFileSync(join(dataDir, 'octa-error.log'), line); } catch { }
  return line;
}
process.on('uncaughtException', e => logError('uncaught', e));
process.on('unhandledRejection', e => logError('unhandled', e));

// ---------- window ----------
const progress = (p, t) => win?.webContents.executeJavaScript(`window.setP&&setP(${p},${JSON.stringify(t || '')})`).catch(() => { });
const failSplash = t => win?.webContents.executeJavaScript(`window.fail&&fail(${JSON.stringify(t)})`).catch(() => { });

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 800, minWidth: 380, minHeight: 520, backgroundColor: '#12110e', title: 'OCTA｜奧克塔', icon: icon(), show: false,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, preload: join(here, 'preload.cjs'), backgroundThrottling: false }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('blob:')) return { action: 'allow' };
    shell.openExternal(url); return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {   // stay inside OCTA; other links open in the browser
    if (!url.startsWith(CLOUD) && !(server && url.startsWith(server.url)) && !url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); }
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return;   // -3: navigation replaced by another one
    logError('load', `${code} ${desc} ${url}`);
    if (url.startsWith(CLOUD)) showSplash().then(() => failSplash('連不上 OCTA 雲端（' + desc + '）。請檢查網路後重試，或先用離線模式。'));
  });
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault(); win.hide();
    if (!cfg.toldTray) {   // the first time: say the bots keep working in the background
      cfg = { ...cfg, toldTray: true }; writeCfg(cfg);
      new Notification({ title: 'OCTA 還在背景工作', body: '機器人會繼續執行。點右下角章魚圖示可以打開，要完全關閉請在圖示上按右鍵 →「結束」。', icon: icon() }).on('click', showWindow).show();
    }
  });
  win.on('closed', () => (win = null));
  win.on('resize', () => layoutEmbed());
  win.once('ready-to-show', () => { if (!hiddenStart) { win.show(); win.focus(); } });
}
function showWindow() {
  if (!win) { createWindow(); loadMain(); }
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}
const showSplash = () => win.loadFile(join(here, 'splash.html'));

async function loadMain() {
  if (cfg.mode === 'local') { await win.loadURL(server.url); return; }
  progress(70, '連線到 OCTA 雲端…');
  try { await win.loadURL(CLOUD); }
  catch (e) { if (!String(e).includes('ERR_ABORTED')) logError('cloud', e); }
}

// ---------- in-app Chromium (the bot's browser lives in the OCTA window, not a separate Chrome) ----------
const embeds = new Map();
let embedSeq = 0;
function layoutEmbed() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  const main = win.contentView.children.find(v => v.webContents === win.webContents);
  const side = [...embeds.values()].find(e => e.shown);
  if (!side) { if (main) main.setBounds({ x: 0, y: 0, width: w, height: h }); return; }
  const sideW = w >= 980 ? Math.max(420, Math.min(760, Math.round(w * 0.48))) : Math.max(280, Math.round(w * 0.46));
  const left = Math.max(280, w - sideW);
  if (main) main.setBounds({ x: 0, y: 0, width: left, height: h });
  side.view.setBounds({ x: left, y: 0, width: Math.max(200, w - left), height: h });
}
function hookPage(wc, id, bucket) {
  try { if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); } catch (e) { if (!/already/i.test(String(e))) logError('debugger', e); }
  wc.debugger.on('message', (_e, method, params) => bucket.onEvent?.(id, method, params));
  bucket.pages.set(id, { wc });
}
async function embedShow(port, show) {
  const bucket = embeds.get(port);
  if (!bucket || !win || win.isDestroyed()) return;
  bucket.shown = !!show;
  if (show) {
    for (const [p, e] of embeds) if (p !== port && e.shown) {
      e.shown = false;
      try { win.contentView.removeChildView(e.view); } catch { }
    }
  }
  const has = win.contentView.children.includes(bucket.view);
  if (show && !has) win.contentView.addChildView(bucket.view);
  if (!show && has) win.contentView.removeChildView(bucket.view);
  if (show) { const [w, h] = win.getContentSize(); if (w < 980) win.setContentSize(1240, h); }
  layoutEmbed();
}
async function embedStop(port) {
  const bucket = embeds.get(port);
  if (!bucket) return;
  embeds.delete(port);
  try { if (win && !win.isDestroyed()) win.contentView.removeChildView(bucket.view); } catch { }
  for (const w of bucket.hidden) { try { if (!w.isDestroyed()) w.destroy(); } catch { } }
  try { if (!bucket.view.webContents.isDestroyed()) bucket.view.webContents.close(); } catch { }
  try { await bucket.bridge?.close(); } catch { }
  layoutEmbed();
}
async function embedStart(bot, port) {
  if (embeds.has(port)) { await embedShow(port, true); return; }
  if (!win || win.isDestroyed()) throw new Error('視窗還沒開');
  const partition = 'persist:octa-bot-' + String(bot.id || 'bot').replace(/[^\w-]/g, '').slice(0, 40);
  const view = new WebContentsView({ webPreferences: { partition, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const bucket = { view, pages: new Map(), shown: false, onEvent: null, hidden: [], bridge: null };
  hookPage(view.webContents, 'p' + (++embedSeq), bucket);
  view.webContents.setWindowOpenHandler(({ url }) => { view.webContents.loadURL(url).catch(() => { }); return { action: 'deny' }; });
  const name = String(bot.name || '機器人').replace(/[<&]/g, '');
  view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<title>${name} 的瀏覽器</title><body style="margin:0;display:grid;place-items:center;height:100vh;background:#1c1814;color:#f3ead3;font:600 28px sans-serif">🐙 ${name}<div style="font:400 15px sans-serif;margin-top:12px">這個畫面在 OCTA 裡面，登入會留在這台電腦</div></body>`)}`).catch(() => { });
  const adapter = {
    list: () => [...bucket.pages].filter(([, p]) => !p.wc.isDestroyed()).map(([id, p]) => ({ id, title: p.wc.getTitle(), url: p.wc.getURL() || 'about:blank' })),
    bounds: () => ({ windowId: 1, bounds: bucket.shown ? { left: 0, top: 0, width: 1100, height: 800, windowState: 'normal' } : { left: -8000, top: 0, width: 1100, height: 800, windowState: 'minimized' } }),
    setBounds: bounds => embedShow(port, bounds?.windowState !== 'minimized' && !(bounds?.left < -5000)),
    onEvent: cb => { bucket.onEvent = cb; },
    async command(targetId, method, params) {
      const page = bucket.pages.get(targetId);
      if (!page || page.wc.isDestroyed()) throw new Error('找不到分頁');
      if (method === 'Storage.getCookies') {
        const cookies = await page.wc.session.cookies.get({});
        return { cookies: cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expires: c.expirationDate || 0, sameSite: c.sameSite })) };
      }
      if (method === 'Storage.setCookies') {
        for (const c of params.cookies || []) { try { await page.wc.session.cookies.set(c); } catch { } }
        return {};
      }
      return await page.wc.debugger.sendCommand(method, params || {});
    },
    async createTarget(params) {
      const id = 'p' + (++embedSeq);
      const hidden = new BrowserWindow({ show: false, skipTaskbar: true, parent: win, webPreferences: { partition, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
      bucket.hidden.push(hidden);
      hookPage(hidden.webContents, id, bucket);
      hidden.webContents.loadURL(params.url || 'about:blank').catch(() => { });
      return { id, title: '', url: params.url || 'about:blank' };
    },
    async closeTarget(id) {
      const page = bucket.pages.get(id);
      if (!page || page.wc === view.webContents) return;
      bucket.pages.delete(id);
      const hw = bucket.hidden.find(w => !w.isDestroyed() && w.webContents === page.wc);
      try { hw?.destroy(); } catch { }
    },
    activateTarget: async id => { if (bucket.pages.get(id)?.wc === view.webContents) await embedShow(port, true); },
    close: () => embedStop(port)
  };
  bucket.bridge = await startCdpBridge(adapter, port);
  embeds.set(port, bucket);
  win.contentView.addChildView(view);
  await embedShow(port, true);
}

// ---------- runner ----------
async function bundledRunnerOpts() {
  const pwCli = unpacked(join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js'));
  return {
    home: dataDir, pwCli, nodeBin: process.execPath, nodeEnv: { ELECTRON_RUN_AS_NODE: '1' }, getExtToken: () => cfg.extToken || '',
    getStore: () => server.getStore(), appVersion: app.getVersion(),
    embed: { start: embedStart, show: embedShow },
    log: (...a) => console.log(new Date().toLocaleTimeString(), ...a),
    onFatal: m => { logError('runner', m); stopRunner(); cfg.runnerToken = ''; writeCfg(cfg); }
    // notifications are shown by the page itself (same as on phones and other computers)
  };
}
let runnerMod = null, browsersClosed = false;
// close the bots' browsers before OCTA exits (at most a few seconds)
async function closeBrowsers() {
  if (browsersClosed || !runnerMod?.closeAllBrowsers) return; browsersClosed = true;
  await Promise.race([runnerMod.closeAllBrowsers().catch(e => logError('close-browsers', e)), new Promise(r => setTimeout(r, 4000))]);
}
function stopRunner() { runner?.stop(); runner = null; runnerFor = ''; }
async function startRunnerFor(url, token) {
  if (runner && runnerFor === url + token) return;
  stopRunner();
  const mod = await import(pathToFileURL(join(server.webDir, 'octa-runner.mjs')).href); runnerMod = mod;
  const { startRunner } = mod;
  runner = startRunner({ url, token, openInstall: k => server.installEngine(k), ...(await bundledRunnerOpts()) });
  runnerFor = url + token;
}

// only OCTA's own pages may use the bridge
const trusted = e => { const u = e.senderFrame?.url || ''; return u.startsWith(CLOUD + '/') || u === CLOUD || (server && u.startsWith(server.url)) || u.startsWith('file:'); };
const handle = (ch, fn) => ipcMain.handle(ch, (e, ...a) => { if (!trusted(e)) throw new Error('not allowed'); return fn(e, ...a); });
handle('octa:version', () => app.getVersion());
handle('octa:show', () => { showWindow(); return true; });
handle('octa:desk', (_e, p, body) => server.desktopApi(String(p), body));
const call = async (path, token, method = 'GET', body) => {
  const r = await fetch(CLOUD + '/api/' + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || 'HTTP ' + r.status); e.status = r.status; throw e; }
  return d;
};
handle('octa:connect', async (_e, webToken) => {   // the page signed in: run this account's bots on this computer
  if (!webToken || cfg.mode === 'local') return { ok: false };
  const who = await call('me', webToken);
  // keep this computer's key when the same account signs in again (it stays the same computer in the list)
  let reuse = false;
  if (cfg.runnerToken) {
    try { reuse = (await call('runner/hello', cfg.runnerToken, 'POST', { app: app.getVersion() })).user === who.id; }
    catch (e) { if (e.status !== 401 && e.status !== 403 && cfg.runnerUser === who.id) reuse = true; }   // offline: trust the saved key
  }
  if (!reuse) {
    const d = await call('runner-token', webToken, 'POST', { label: 'desktop:' + os.hostname(), device: 'OCTA 電腦版 · ' + os.hostname() });
    cfg = { ...cfg, runnerToken: d.token, runnerUser: who.id };
    writeCfg(cfg);
  } else if (cfg.runnerUser !== who.id) { cfg = { ...cfg, runnerUser: who.id }; writeCfg(cfg); }
  await startRunnerFor(CLOUD, cfg.runnerToken);
  return { ok: true };
});
// signing out: keep=true leaves this computer working for the account (the window just shows the sign-in page)
handle('octa:disconnect', (_e, opts) => {
  if (opts?.keep && cfg.runnerToken) return { ok: true, working: true };
  stopRunner(); cfg = { ...cfg, runnerToken: '', runnerUser: '' }; writeCfg(cfg); return { ok: true };
});
handle('octa:working', () => ({ working: !!runner && runnerFor.startsWith(CLOUD), standby: !!runner?.standby?.() }));
handle('octa:offline', async () => {
  cfg = { ...cfg, mode: 'local' }; writeCfg(cfg);
  stopRunner(); await startRunnerFor(server.url, '');
  await win.loadURL(server.url); return { ok: true };
});
handle('octa:update-status', () => upd);
handle('octa:update-check', () => { checkUpdates(); return upd; });
handle('octa:update-download', () => { if (upd.state === 'available' || upd.state === 'error') { setUpd({ state: 'downloading', percent: 0 }); autoUpdater.downloadUpdate().catch(() => { }); } return upd; });
handle('octa:update-install', () => {
  if (upd.state === 'ready') {
    quitting = true; stopRunner();
    cfg = { ...cfg, updating: { to: upd.version, from: app.getVersion(), at: Date.now() } }; writeCfg(cfg);
    setTimeout(async () => { await closeBrowsers(); freeInstallDir(); reopenAfterUpdate(); autoUpdater.quitAndInstall(true, true); }, 800);
  }
  return upd;
});
// a silent update fails if anything still runs from the install folder (bot browsers' helpers, AI sessions,
// OCTA.exe copies running as node) — end them all first
function freeInstallDir() {
  if (process.platform !== 'win32') return;
  // the folder goes in through an environment variable: non-ASCII paths (e.g. E:\哲\OCTA) got garbled inside the command line
  const ps = `$me=${process.pid}; $dir=$env:OCTA_DIR; $all=Get-CimInstance Win32_Process; ` +
    `function Kids($p){ $all | ? { $_.ParentProcessId -eq $p } | % { Kids $_.ProcessId; $_.ProcessId } }; ` +
    `$ids=@(Kids $me) + @($all | ? { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($dir, 'OrdinalIgnoreCase') -and $_.ProcessId -ne $me } | % { $_.ProcessId }); ` +
    `$ids | Select-Object -Unique | % { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; exit 0`;
  try { execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 15000, windowsHide: true, env: { ...process.env, OCTA_DIR: dirname(process.execPath) } }); } catch (e) { logError('free-install-dir', e); }
}
// the silent installer doesn't always start OCTA again, and a helper started by OCTA dies with it: Windows Task Scheduler
// runs the helper on its own. It waits for the installer to finish, then opens OCTA (the new version, or the old one if
// the update didn't go through)
function reopenAfterUpdate() {
  if (process.platform !== 'win32') return;
  try {
    const f = join(dataDir, 'reopen-octa.ps1'), q = t => "'" + String(t).replace(/'/g, "''") + "'";
    writeFileSync(f, '\ufeff' + [`$exe = ${q(process.execPath)}`, 'Start-Sleep 6', '$end = (Get-Date).AddMinutes(8)',
      "while ((Get-Date) -lt $end -and (Get-Process | Where-Object { $_.ProcessName -like '*octa*setup*' -or $_.ProcessName -like 'Un_A*' })) { Start-Sleep 2 }",
      'Start-Sleep 3', 'if (-not (Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($exe)) -ErrorAction SilentlyContinue)) { Start-Process -FilePath $exe }',
      'schtasks /Delete /TN OCTA-reopen /F | Out-Null'].join('\r\n'));
    execFileSync('schtasks', ['/Create', '/TN', 'OCTA-reopen', '/TR', `powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${f}"`, '/SC', 'ONCE', '/ST', '23:59', '/F'], { windowsHide: true, timeout: 15000 });
    execFileSync('schtasks', ['/Run', '/TN', 'OCTA-reopen'], { windowsHide: true, timeout: 15000 });
  } catch (e) { logError('reopen', e); }
}
// installed "for all users" (e.g. into E:\ or Program Files): Windows asks for permission at every update
function needsAdmin() {
  if (process.platform !== 'win32') return false;
  const t = join(dirname(process.execPath), '.octa-write-test');
  try { writeFileSync(t, ''); rmSync(t, { force: true }); return false; } catch { return true; }
}
// tell the user when the last silent update didn't go through, and offer the installer
function checkLastUpdate() {
  const u = cfg.updating; if (!u) return;
  cfg = { ...cfg, updating: null }; writeCfg(cfg);
  if (u.to === app.getVersion() || Date.now() - u.at > 7 * 864e5) return;
  logError('update', `update to ${u.to} did not complete (still ${app.getVersion()})`);
  const r = dialog.showMessageBoxSync(win, { type: 'warning', title: 'OCTA', message: `更新到 v${u.to} 沒有完成，目前還是 v${app.getVersion()}。`,
    detail: '可能有程式還在使用 OCTA 的檔案。按「下載安裝檔」直接安裝最新版（你的機器人和設定都會保留）。', buttons: ['下載安裝檔', '稍後'], defaultId: 0, cancelId: 1 });
  if (r === 0) shell.openExternal('https://github.com/typeu910722-gife/octa/releases/latest/download/OCTA-Setup.exe');
}
handle('octa:cloud', async () => {
  cfg = { ...cfg, mode: 'cloud' }; writeCfg(cfg);
  stopRunner(); await showSplash(); progress(60, '重新連線…'); await loadMain(); return { ok: true };
});

// ---------- app ----------
app.on('second-instance', () => {
  if (server) return showWindow();
  const r = dialog.showMessageBoxSync({ type: 'info', title: 'OCTA', message: 'OCTA 還在啟動中。', detail: '如果一直沒有出現，按「重新啟動」。', buttons: ['重新啟動', '再等一下'], defaultId: 0, cancelId: 1 });
  if (r === 0) { app.relaunch(); app.exit(0); }
});
app.on('before-quit', e => {
  quitting = true;
  if (browsersClosed || !runnerMod?.closeAllBrowsers) return;
  e.preventDefault(); closeBrowsers().finally(() => app.quit());
});
app.on('window-all-closed', e => e.preventDefault());   // keep running in the tray

app.whenReady().then(start).catch(e => {
  const msg = logError('start', e);
  dialog.showErrorBox('OCTA 無法啟動', `${e?.message || e}\n\n詳細紀錄：${join(dataDir, 'octa-error.log')}\n\n${msg.slice(0, 1500)}`);
  app.exit(1);
});

async function start() {
  createWindow();
  await showSplash();   // the YZ progress bar shows right away while things load
  progress(10, '啟動 OCTA…');
  const slow = setTimeout(() => {
    const r = dialog.showMessageBoxSync({ type: 'warning', title: 'OCTA', message: 'OCTA 啟動比平常久。', detail: `可以再等一下，或按「重新啟動」。\n紀錄檔：${join(dataDir, 'octa-error.log')}`, buttons: ['重新啟動', '再等一下'], defaultId: 1, cancelId: 1 });
    if (r === 0) { app.relaunch(); app.exit(0); }
  }, 45000);

  progress(25, '準備本機服務…');
  server = await startServer({
    dataDir,
    runner: false,   // started below for whichever mode is in use
    hooks: {
      openFolder: () => shell.openPath(dataDir),
      pickFolder: async () => { const r = await dialog.showOpenDialog(win, { title: '選擇 OCTA 檔案資料夾', properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; },
      getStore: () => cfg.store || join(dataDir, 'files'),
      setStore: p => { cfg = { ...cfg, store: p }; writeCfg(cfg); },
      getExtToken: () => cfg.extToken || '',
      setExtToken: t => { cfg = { ...cfg, extToken: t }; writeCfg(cfg); },
      getAutostart: () => app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin,   // Windows needs the same args to find the entry
      setAutostart: on => { app.setLoginItemSettings({ openAtLogin: on, args: LOGIN_ARGS, path: process.execPath }); cfg = { ...cfg, autostartChosen: true }; writeCfg(cfg); }
    }
  });
  // start with Windows by default (after installing or updating), unless the user turned it off themselves
  if (app.isPackaged && !cfg.autostartChosen && !app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin) {
    try { app.setLoginItemSettings({ openAtLogin: true, args: LOGIN_ARGS, path: process.execPath }); } catch (e) { logError('autostart', e); }
  }
  progress(50, '準備機器人…');
  if (cfg.mode === 'local') await startRunnerFor(server.url, '');
  else if (cfg.runnerToken) await startRunnerFor(CLOUD, cfg.runnerToken);   // keep working before the page finishes loading
  clearTimeout(slow);

  tray = new Tray(icon().resize({ width: 16, height: 16 }));
  tray.setToolTip('OCTA｜奧克塔');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '開啟 OCTA', click: showWindow },
    { label: '打開檔案資料夾', click: () => { const p = cfg.store || join(dataDir, 'files'); mkdirSync(p, { recursive: true }); shell.openPath(p); } },
    { type: 'separator' },
    { label: '結束（機器人會停止工作）', click: async () => { quitting = true; await closeBrowsers(); stopRunner(); await server.close(); app.quit(); } }
  ]));
  tray.on('click', showWindow);

  await loadMain();
  setTimeout(checkLastUpdate, 3000);
  setTimeout(checkUpdates, 8000);                       // look for a new version shortly after start…
  setInterval(checkUpdates, 6 * 3600 * 1000);           // …and every six hours
  if (hiddenStart) new Notification({ title: 'OCTA', body: '已在背景啟動，點右下角章魚圖示打開。', icon: icon() }).on('click', showWindow).show();
}
