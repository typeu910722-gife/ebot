// OCTA desktop (Electron): window + tray around the local server.
import { app, BrowserWindow, Tray, Menu, Notification, shell, nativeImage, dialog } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { startServer } from './server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const unpacked = p => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }   // already running: the first copy shows its window
app.setAppUserModelId('tw.yzproject.octa');

let win = null, tray = null, server = null, quitting = false;
const LOGIN_ARGS = ['--hidden'];
const hiddenStart = process.argv.includes('--hidden') || app.getLoginItemSettings({ args: LOGIN_ARGS }).wasOpenedAtLogin;

// anything that goes wrong at startup is written to octa-error.log and shown, instead of failing silently
function logError(where, e) {
  const line = `[${new Date().toISOString()}] ${where}: ${e?.stack || e}\n`;
  try { mkdirSync(app.getPath('userData'), { recursive: true }); appendFileSync(join(app.getPath('userData'), 'octa-error.log'), line); } catch { }
  return line;
}
process.on('uncaughtException', e => logError('uncaught', e));
process.on('unhandledRejection', e => logError('unhandled', e));
const icon = () => nativeImage.createFromPath(join(here, 'icon.png'));

function showWindow() {
  if (!win) {
    win = new BrowserWindow({
      width: 1180, height: 800, minWidth: 380, minHeight: 520, backgroundColor: '#12110e', title: 'OCTA｜奧克塔', icon: icon(), show: false,
      autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true }
    });
    win.loadURL(server.url);
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('blob:') || url.startsWith(server.url)) return { action: 'allow' };
      shell.openExternal(url); return { action: 'deny' };
    });
    win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
    win.on('closed', () => (win = null));
    win.once('ready-to-show', () => { win.show(); win.focus(); });
    win.webContents.on('did-fail-load', (_e, code, desc) => logError('load', `${code} ${desc}`));
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

app.on('second-instance', () => {
  if (server) return showWindow();
  // still starting (or stuck): let the user restart instead of nothing happening
  const r = dialog.showMessageBoxSync({ type: 'info', title: 'OCTA', message: 'OCTA 還在啟動中。', detail: '如果一直沒有出現，按「重新啟動」。', buttons: ['重新啟動', '再等一下'], defaultId: 0, cancelId: 1 });
  if (r === 0) { app.relaunch(); app.exit(0); }
});
app.on('before-quit', () => (quitting = true));
app.on('window-all-closed', e => e.preventDefault());   // keep running in the tray

// keep data from installs made before the rename
const oldDir = join(app.getPath('appData'), 'E·BOT');
const dataDir = existsSync(join(oldDir, 'ebot.sqlite')) && !existsSync(join(app.getPath('userData'), 'ebot.sqlite')) ? oldDir : app.getPath('userData');

app.whenReady().then(start).catch(e => {
  const msg = logError('start', e);
  dialog.showErrorBox('OCTA 無法啟動', `${e?.message || e}\n\n詳細紀錄：${join(app.getPath('userData'), 'octa-error.log')}\n\n${msg.slice(0, 1500)}`);
  app.exit(1);
});

async function start() {
  const slow = setTimeout(() => {   // startup should take a few seconds; tell the user if it doesn't
    const r = dialog.showMessageBoxSync({ type: 'warning', title: 'OCTA', message: 'OCTA 啟動比平常久。', detail: `可以再等一下，或按「重新啟動」。\n紀錄檔：${join(app.getPath('userData'), 'octa-error.log')}`, buttons: ['重新啟動', '再等一下'], defaultId: 1, cancelId: 1 });
    if (r === 0) { app.relaunch(); app.exit(0); }
  }, 45000);
  const pwCli = unpacked(join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js'));
  logError('start', 'v' + app.getVersion() + ' starting, data ' + dataDir);
  server = await startServer({
    dataDir,
    onNotify: text => new Notification({ title: 'OCTA', body: text.replace(/^【OCTA】/, '').slice(0, 240), icon: icon() }).on('click', showWindow).show(),
    hooks: {
      openFolder: () => shell.openPath(dataDir),
      // Windows only reports the entry when asked with the same args it was registered with
      getAutostart: () => app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin,
      setAutostart: on => app.setLoginItemSettings({ openAtLogin: on, args: LOGIN_ARGS, path: process.execPath })
    },
    // run the bundled Playwright MCP with Electron's own Node, so users don't need Node installed
    runnerOpts: { pwCli, nodeBin: process.execPath, nodeEnv: { ELECTRON_RUN_AS_NODE: '1' } }
  });

  clearTimeout(slow);
  tray = new Tray(icon().resize({ width: 16, height: 16 }));
  tray.setToolTip('OCTA｜奧克塔');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '開啟 OCTA', click: showWindow },
    { label: '打開資料夾', click: () => shell.openPath(dataDir) },
    { type: 'separator' },
    { label: '結束（機器人會停止工作）', click: async () => { quitting = true; await server.close(); app.quit(); } }
  ]));
  tray.on('click', showWindow);
  if (!hiddenStart) showWindow();
  else new Notification({ title: 'OCTA', body: '已在背景啟動，點右下角章魚圖示打開。', icon: icon() }).on('click', showWindow).show();
}
