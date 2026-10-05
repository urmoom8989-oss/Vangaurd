const { app, BrowserWindow, dialog, shell, ipcMain, session } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createUpdater } = require('./updater.cjs');

const GAME_ROOT = path.join(process.resourcesPath, 'game');

// Always use the dedicated graphics card on laptops with two GPUs. (Chromium's frame-limit/VSync
// switches are deliberately not used: they made the GPU redraw nonstop and stalled loading.
// The game's own frame loop runs uncapped.)
app.commandLine.appendSwitch('force_high_performance_gpu');
const PREFERRED_PORT = 8080;
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self' http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:* https://*.up.railway.app wss://*.up.railway.app https://*.railway.app wss://*.railway.app",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

let logFile;
let gameServer;
let gameOrigin;
let gameWindow;

// Display mode requested by the game: windowed, borderless (fills the screen at desktop
// resolution) or fullscreen (fills the screen; the game picks its own render resolution).
// Display mode requested by the game:
//  windowed   - normal window with a title bar
//  borderless - borderless window covering the screen at desktop resolution; Alt+Tab just switches away
//  fullscreen - covers the screen and stays on top like a classic fullscreen game, minimizes on Alt+Tab;
//               the game renders at the resolution chosen in Settings and scales it to the screen
let displayMode = 'windowed';
function applyDisplayMode(win, mode) {
  if (!win || win.isDestroyed()) return false;
  displayMode = mode === 'borderless' || mode === 'fullscreen' ? mode : 'windowed';
  const full = displayMode !== 'windowed';
  if (displayMode !== 'fullscreen') win.setAlwaysOnTop(false);
  if (process.platform === 'darwin') {
    // macOS: borderless uses the classic full-screen (no separate Space), fullscreen the native one.
    const simple = displayMode === 'borderless';
    if (win.isFullScreen() && displayMode !== 'fullscreen') win.setFullScreen(false);
    if (win.isSimpleFullScreen() !== simple) win.setSimpleFullScreen(simple);
    if (displayMode === 'fullscreen' && !win.isFullScreen()) win.setFullScreen(true);
  } else if (win.isFullScreen() !== full) {
    win.setFullScreen(full);
  }
  if (displayMode === 'fullscreen' && process.platform !== 'darwin') win.setAlwaysOnTop(true, 'screen-saver');
  if (!full && !win.isMaximized() && win.getBounds().width < 960) win.setSize(1440, 900);
  log(`Display mode: ${displayMode}`);
  return true;
}
ipcMain.handle('vangaurd:display-mode', (event, mode) => applyDisplayMode(BrowserWindow.fromWebContents(event.sender), String(mode || 'windowed')));

// Auto-update: checked shortly after launch, and again when the multiplayer server reports this build is outdated.
let updater = null;
ipcMain.handle('vangaurd:check-update', async (event, reason) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  try { return updater ? await updater.check(win, String(reason || 'manual')) : { error: 'not ready' }; } catch (e) { log(`Update check error: ${e?.message || e}`); return { error: String(e?.message || e) }; }
});
ipcMain.handle('vangaurd:app-info', () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch }));

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  console.error(line.trimEnd());
  try { if (logFile) fs.appendFileSync(logFile, line); } catch { /* logging must not block launch */ }
}

function showLaunchError(message) {
  log(message);
  dialog.showErrorBox('Vangaurd could not start', `${message}\n\nA diagnostic log was saved at:\n${logFile || app.getPath('userData')}`);
}

process.on('uncaughtException', (error) => showLaunchError(error?.stack || String(error)));
process.on('unhandledRejection', (error) => showLaunchError(error?.stack || String(error)));

function sendError(response, status, message) {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  response.end(message);
}

function startGameServer() {
  gameServer = http.createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      sendError(response, 405, 'Method not allowed');
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, gameOrigin).pathname);
    } catch {
      sendError(response, 400, 'Invalid URL');
      return;
    }

    if (pathname === '/') pathname = '/index.html';
    const filename = path.resolve(GAME_ROOT, `.${pathname}`);
    if (filename !== GAME_ROOT && !filename.startsWith(GAME_ROOT + path.sep)) {
      sendError(response, 403, 'Forbidden');
      return;
    }

    fs.stat(filename, (statError, stat) => {
      if (statError || !stat.isFile()) {
        sendError(response, 404, 'Not found');
        return;
      }
      response.writeHead(200, {
        'Content-Type': MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
        // Never cache: the files are on the local disk anyway, and a cached copy would survive an update.
        'Cache-Control': 'no-store',
      });
      if (request.method === 'HEAD') response.end();
      else fs.createReadStream(filename).pipe(response);
    });
  });

  return new Promise((resolve, reject) => {
    const onListening = () => {
      gameServer.removeListener('error', onError);
      const address = gameServer.address();
      gameOrigin = `http://127.0.0.1:${address.port}`;
      log(`Serving production game files from ${GAME_ROOT} at ${gameOrigin}`);
      resolve();
    };
    const onError = (error) => {
      if (error.code === 'EADDRINUSE' && gameServer.address()) return;
      if (error.code === 'EADDRINUSE' && gameServer.listening === false) {
        log(`Preferred local port ${PREFERRED_PORT} is in use; selecting an available loopback port.`);
        gameServer.removeListener('error', onError);
        gameServer.once('error', reject);
        gameServer.listen(0, '127.0.0.1', onListening);
        return;
      }
      reject(error);
    };
    gameServer.once('error', onError);
    gameServer.listen(PREFERRED_PORT, '127.0.0.1', onListening);
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#090b0a',
    autoHideMenuBar: true,
    title: 'Vangaurd',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  gameWindow = window;

  window.setMenu(null);
  // Show the window as soon as it has something to draw (the loading screen) instead of keeping it
  // hidden until the game is ready: a hidden window does not draw frames, which stalls loading.
  window.once('ready-to-show', () => { if (!window.isDestroyed() && !window.isVisible()) window.show(); });
  // Fullscreen mode behaves like a classic fullscreen game: Alt+Tab minimizes it, coming back restores it.
  window.on('blur', () => {
    if (displayMode === 'fullscreen' && process.platform !== 'darwin' && !window.isDestroyed() && !window.isMinimized()) window.minimize();
  });
  window.on('restore', () => {
    if (displayMode === 'fullscreen' && !window.isDestroyed()) applyDisplayMode(window, 'fullscreen');
  });
  window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) showLaunchError(`Could not load the packaged game (${code}): ${description}\n${url}`);
  });
  window.webContents.on('did-finish-load', () => {
    setTimeout(() => { if (updater && !window.isDestroyed()) updater.check(window, 'launch').catch((e) => log(`Update check error: ${e?.message || e}`)); }, 5000);
    const startedAt = Date.now();
    const revealWhenReady = async () => {
      if (window.isDestroyed()) return;
      try {
        const ready = await window.webContents.executeJavaScript('window.__APP_STARTUP_READY__ === true');
        if (ready || Date.now() - startedAt >= 90_000) {
          window.show();
          return;
        }
      } catch { /* renderer is still booting */ }
      setTimeout(revealWhenReady, 100);
    };
    revealWhenReady();
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    showLaunchError(`The game renderer stopped unexpectedly (${details.reason}${details.exitCode ? `, exit ${details.exitCode}` : ''}).`);
  });
  window.webContents.on('console-message', (_event, details) => {
    if (details.level >= 2) log(`Game console: ${details.message}`);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== `${gameOrigin}/`) event.preventDefault();
  });

  window.loadURL(`${gameOrigin}/`).catch((error) => {
    showLaunchError(`Unable to load the packaged game from ${gameOrigin}:\n${error?.stack || error}`);
  });
}

const hasAppLock = app.requestSingleInstanceLock();
if (!hasAppLock) app.quit();

app.whenReady().then(async () => {
  if (!hasAppLock) return;
  logFile = path.join(app.getPath('userData'), 'launch.log');
  updater = createUpdater({ app, dialog, shell, log });
  log(`Starting Vangaurd ${app.getVersion()} on ${process.platform} ${process.arch}; Electron ${process.versions.electron}, Chromium ${process.versions.chrome}`);
  log(`Game build directory: ${GAME_ROOT}`);
  try {
    await fs.promises.access(path.join(GAME_ROOT, 'index.html'), fs.constants.R_OK);
    await startGameServer();
    // Older builds told the browser to keep game.js forever, so an updated app kept running the old
    // game. Empty the browser cache on every launch (saved settings and progress are not touched).
    try {
      await session.defaultSession.clearCache();
      log('Cleared the browser cache.');
    } catch (error) {
      log(`Could not clear the browser cache: ${error?.message || error}`);
    }
    createWindow();
  } catch (error) {
    showLaunchError(`Could not prepare the packaged game files at ${GAME_ROOT}:\n${error?.stack || error}`);
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && gameOrigin) createWindow();
  });
}).catch((error) => showLaunchError(error?.stack || String(error)));

app.on('before-quit', () => gameServer?.close());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
