// Small bridge from the game page to the desktop window (display mode).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vangaurdDesktop', {
  setDisplayMode: (mode) => ipcRenderer.invoke('vangaurd:display-mode', String(mode || 'windowed')),
  platform: process.platform,
});
