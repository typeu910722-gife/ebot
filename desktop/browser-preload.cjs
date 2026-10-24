const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('octaBrowser', {
  onFrame(fn) { ipcRenderer.on('octa:browser-frame', (_e, data) => fn(data)); },
  toggle() { ipcRenderer.send('octa:browser-toggle'); },
  dragStart() { return ipcRenderer.sendSync('octa:browser-drag-start'); },
  dragBy(dx, dy) { ipcRenderer.send('octa:browser-drag-by', { dx, dy }); },
  dragEnd() { ipcRenderer.send('octa:browser-drag-end'); }
});
