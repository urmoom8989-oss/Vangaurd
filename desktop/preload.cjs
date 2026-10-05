// Small bridge from the game page to the desktop window (display mode, update check, quit).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vangaurdDesktop', {
  setDisplayMode: (mode) => ipcRenderer.invoke('vangaurd:display-mode', String(mode || 'windowed')),
  checkForUpdate: (reason) => ipcRenderer.invoke('vangaurd:check-update', String(reason || 'manual')),
  appInfo: () => ipcRenderer.invoke('vangaurd:app-info'),
  quit: () => ipcRenderer.invoke('vangaurd:quit'),
  platform: process.platform,
});
