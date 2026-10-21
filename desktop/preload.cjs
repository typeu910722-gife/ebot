// Bridge between the OCTA page (cloud or local) and the desktop app.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('octaDesktop', {
  isDesktop: true,
  version: () => ipcRenderer.invoke('octa:version'),
  call: (path, body) => ipcRenderer.invoke('octa:desk', path, body),   // this-computer features: status, install AI, autostart…
  connect: webToken => ipcRenderer.invoke('octa:connect', webToken),   // signed in: start this computer's runner for the account
  disconnect: () => ipcRenderer.invoke('octa:disconnect'),
  useOffline: () => ipcRenderer.invoke('octa:offline'),
  useCloud: () => ipcRenderer.invoke('octa:cloud')
});
