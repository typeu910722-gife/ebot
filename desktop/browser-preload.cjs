const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('octaBrowser', {
  onFrame(fn) { ipcRenderer.on('octa:browser-frame', (_e, data) => fn(data)); },
  toggle() { ipcRenderer.send('octa:browser-toggle'); }
});
