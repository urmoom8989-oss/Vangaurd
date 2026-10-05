// Small bridge from the game page to the desktop window (display mode, update, quit).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vangaurdDesktop', {
  setDisplayMode: (mode) => ipcRenderer.invoke('vangaurd:display-mode', String(mode || 'windowed')),
  checkForUpdate: (reason) => ipcRenderer.invoke('vangaurd:check-update', String(reason || 'manual')),
  appInfo: () => ipcRenderer.invoke('vangaurd:app-info'),
  quit: () => ipcRenderer.invoke('vangaurd:quit'),
  onUpdateProgress: (cb) => {
    const h = (_event, f) => { try { cb(Number(f)); } catch { /* page handler */ } };
    ipcRenderer.on('vangaurd:update-progress', h);
    return () => ipcRenderer.removeListener('vangaurd:update-progress', h);
  },
  platform: process.platform,
});
