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
// While the game loads behind the launch window, a display mode it asks for (fullscreen / borderless) is kept
// and applied when the game window appears, so the game can't cover the launch window.
let gameRevealed = false;
let pendingDisplayMode = null;
ipcMain.handle('vangaurd:display-mode', (event, mode) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && win === gameWindow && !gameRevealed) {
    pendingDisplayMode = String(mode || 'windowed');
    log(`Display mode ${pendingDisplayMode} will apply when the game window opens`);
    return true;
  }
  return applyDisplayMode(win, String(mode || 'windowed'));
});

// Auto-update: checked shortly after launch, and again when the multiplayer server reports this build is outdated.
let updater = null;
ipcMain.handle('vangaurd:check-update', async (event, reason) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  try { return updater ? await updater.check(win, String(reason || 'manual')) : { error: 'not ready' }; } catch (e) { log(`Update check error: ${e?.message || e}`); return { error: String(e?.message || e) }; }
});
ipcMain.handle('vangaurd:quit', () => { log('Quit from the game menu'); setTimeout(() => app.quit(), 50); return true; });
ipcMain.handle('vangaurd:app-info', () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch }));

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  console.error(line.trimEnd());
  try { if (logFile) fs.appendFileSync(logFile, line); } catch { /* logging must not block launch */ }
}

// ---------- launch window (Vangaurd Anti-Cheat) ----------
// A small window on a graphite background shown while the game starts (like the anti-cheat windows other
// games show). Its bar follows the real start-up: app checks first, then the game's own loading progress
// (window.__VGD_BOOT__). The game window loads behind it, invisible, and appears when the game is ready.
const SPLASH_MIN_MS = 5000;
const SPLASH_APP_SHARE = 0.15;
const SPLASH_GAP_MS = 1000; // pause between the launch window closing and the game window opening // the bar's first 15 % is the app starting; the rest is the game loading
let splash = null;
let splashAt = 0;
function createSplash() {
  try {
    splashAt = Date.now();
    splash = new BrowserWindow({
      width: 800, height: 450, frame: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      center: true, show: false, backgroundColor: '#2b2d31', title: 'Vangaurd Anti-Cheat', autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    });
    const win = splash;
    win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
    win.on('closed', () => { if (splash === win) splash = null; });
    win.loadFile(path.join(__dirname, 'splash.html')).catch((e) => log(`Launch window failed to load: ${e?.message || e}`));
  } catch (e) {
    log(`Launch window failed: ${e?.message || e}`);
    splash = null;
  }
}
let splashShown = 0;
function splashStatus(text, progress) {
  if (!splash || splash.isDestroyed()) return;
  const p = Math.max(splashShown, Math.min(1, Number(progress) || 0)); // never goes backwards
  splashShown = p;
  splash.webContents.executeJavaScript(`window.setStatus && setStatus(${JSON.stringify(text)}, ${p})`).catch(() => {});
}
function closeSplash(delay = 300) {
  const win = splash;
  splash = null;
  if (!win || win.isDestroyed()) return;
  if (delay > 0) {
    win.webContents.executeJavaScript('window.setStatus && setStatus("Ready", 1)').catch(() => {});
    setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, delay);
  } else win.destroy();
}

function showLaunchError(message) {
  closeSplash(0);
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
  window.once('ready-to-show', () => {
    if (window.isDestroyed() || window.isVisible()) return;
    if (splash && !splash.isDestroyed() && process.platform !== 'linux') {
      // Shown (so it keeps drawing frames and loading) but fully transparent and out of the taskbar,
      // while the launch window shows the progress.
      try { window.setOpacity(0); window.setSkipTaskbar(true); } catch { /* not supported: just show it */ }
      window.showInactive();
    } else window.show();
  });
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
    let lastP = -1, lastMove = Date.now(), unveiled = false;
    // Make the game window visible (behind the launch window if that is still up).
    const unveil = () => {
      if (unveiled || window.isDestroyed()) return;
      unveiled = true;
      try { window.setOpacity(1); window.setSkipTaskbar(false); } catch { /* ignore */ }
      if (!window.isVisible()) window.showInactive();
    };
    let revealing = false;
    const openGame = () => {
      if (window.isDestroyed()) return;
      unveil();
      window.show();
      window.focus();
      gameRevealed = true;
      if (pendingDisplayMode) { applyDisplayMode(window, pendingDisplayMode); pendingDisplayMode = null; }
    };
    const reveal = () => {
      if (window.isDestroyed() || revealing) return;
      revealing = true;
      if (!(splash && !splash.isDestroyed())) return openGame();
      // The launch window finishes first: the bar fills to 100 %, the window closes, and one second later
      // the game window opens.
      splashStatus('Ready', 1);
      setTimeout(() => {
        closeSplash(0);
        setTimeout(openGame, SPLASH_GAP_MS);
      }, 700);
    };
    const revealWhenReady = async () => {
      if (window.isDestroyed()) return;
      try {
        const r = await window.webContents.executeJavaScript('({ ready: window.__APP_STARTUP_READY__ === true, boot: window.__VGD_BOOT__ || null })');
        const ready = r === true || !!r?.ready, boot = r && typeof r === 'object' ? r.boot : null;
        if (boot && Number.isFinite(boot.p)) {
          splashStatus(String(boot.stage || 'Loading'), SPLASH_APP_SHARE + (1 - SPLASH_APP_SHARE) * Math.min(1, boot.p));
          if (boot.p !== lastP) { lastP = boot.p; lastMove = Date.now(); }
        }
        // Some systems only draw frames for a visible window: if loading stops moving, show the game
        // window behind the launch window so it can finish.
        if (!ready && !unveiled && Date.now() - lastMove > 8000) { log('Start-up paused while hidden; showing the game window behind the launch window.'); if (splash && !splash.isDestroyed()) { splash.setAlwaysOnTop(true, 'screen-saver'); splash.moveTop?.(); } unveil(); if (splash && !splash.isDestroyed()) splash.moveTop?.(); }
        if ((ready && Date.now() - splashAt >= SPLASH_MIN_MS) || Date.now() - startedAt >= 120_000) {
          reveal();
          return;
        }
      } catch { /* renderer is still booting */ }
      setTimeout(revealWhenReady, 150);
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
  createSplash();
  log(`Starting Vangaurd ${app.getVersion()} on ${process.platform} ${process.arch}; Electron ${process.versions.electron}, Chromium ${process.versions.chrome}`);
  log(`Game build directory: ${GAME_ROOT}`);
  try {
    splashStatus('Checking game files', 0.04);
    await fs.promises.access(path.join(GAME_ROOT, 'index.html'), fs.constants.R_OK);
    splashStatus('Starting game services', 0.08);
    await startGameServer();
    // Older builds told the browser to keep game.js forever, so an updated app kept running the old
    // game. Empty the browser cache on every launch (saved settings and progress are not touched).
    try {
      await session.defaultSession.clearCache();
      log('Cleared the browser cache.');
    } catch (error) {
      log(`Could not clear the browser cache: ${error?.message || error}`);
    }
    splashStatus('Launching Vangaurd', 0.12);
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
