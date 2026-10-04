// Small bridge from the game page to the desktop window (display mode and VSync).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vangaurdDesktop', {
  setDisplayMode: (mode) => ipcRenderer.invoke('vangaurd:display-mode', String(mode || 'windowed')),
  setVsync: (on) => ipcRenderer.invoke('vangaurd:vsync', !!on),
  platform: process.platform,
});
