// OCTA desktop (Electron): window + tray around the local server.
import { app, BrowserWindow, Tray, Menu, Notification, shell, nativeImage } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { startServer } from './server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const unpacked = p => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('tw.yzproject.octa');

let win = null, tray = null, server = null, quitting = false;
const icon = () => nativeImage.createFromPath(join(here, 'icon.png'));

function showWindow() {
  if (!win) {
    win = new BrowserWindow({
      width: 1180, height: 800, minWidth: 380, minHeight: 520, backgroundColor: '#12110e', title: 'OCTA｜奧克塔', icon: icon(),
      autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true }
    });
    win.loadURL(server.url);
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('blob:') || url.startsWith(server.url)) return { action: 'allow' };
      shell.openExternal(url); return { action: 'deny' };
    });
    win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
    win.on('closed', () => (win = null));
  }
  win.show(); win.focus();
}

app.on('second-instance', () => server && showWindow());
app.on('before-quit', () => (quitting = true));
app.on('window-all-closed', e => e.preventDefault());   // keep running in the tray

// keep data from installs made before the rename
const oldDir = join(app.getPath('appData'), 'E·BOT');
const dataDir = existsSync(join(oldDir, 'ebot.sqlite')) && !existsSync(join(app.getPath('userData'), 'ebot.sqlite')) ? oldDir : app.getPath('userData');

app.whenReady().then(async () => {
  const pwCli = unpacked(join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js'));
  server = await startServer({
    dataDir,
    onNotify: text => new Notification({ title: 'OCTA', body: text.replace(/^【OCTA】/, '').slice(0, 240), icon: icon() }).on('click', showWindow).show(),
    hooks: {
      openFolder: () => shell.openPath(dataDir),
      getAutostart: () => app.getLoginItemSettings().openAtLogin,
      setAutostart: on => app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] })
    },
    // run the bundled Playwright MCP with Electron's own Node, so users don't need Node installed
    runnerOpts: { pwCli, nodeBin: process.execPath, nodeEnv: { ELECTRON_RUN_AS_NODE: '1' } }
  });

  tray = new Tray(icon().resize({ width: 16, height: 16 }));
  tray.setToolTip('OCTA｜奧克塔');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '開啟 OCTA', click: showWindow },
    { label: '打開資料夾', click: () => shell.openPath(dataDir) },
    { type: 'separator' },
    { label: '結束（機器人會停止工作）', click: async () => { quitting = true; await server.close(); app.quit(); } }
  ]));
  tray.on('click', showWindow);
  if (!process.argv.includes('--hidden')) showWindow();
});
