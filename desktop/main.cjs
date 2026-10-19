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

// ---------- Steam (Beta 1.3) ----------
// The Steam version ships with desktop/steam.json { "appId": <the game's Steam App ID>, "required": true }.
// Steam sets SteamAppId when it starts the game. With steamworks.js bundled (the release workflow adds it), the
// app checks that Steam is running and that this Steam user owns the game, and gets a session ticket the
// Vangaurd server can verify with Steam. Without Steam the game can still sign in (the server decides: the
// owner can let some players play without Steam), but it can't be played offline.
const steamCfg = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'steam.json'), 'utf8')) || {}; } catch { return {}; }
})();
const STEAM_APP_ID = Math.floor(Number(process.env.SteamAppId || process.env.SteamGameId || steamCfg.appId) || 0);
let steamClient = null, steamApi = null, steamState = { present: false, required: steamCfg.required === true && STEAM_APP_ID > 0 };
function loadSteamworks() {
  for (const p of [path.join(process.resourcesPath || '', 'steamworks.js'), 'steamworks.js']) {
    try { return require(p); } catch { /* next */ }
  }
  return null;
}
function initSteam() {
  if (!STEAM_APP_ID) { log('Steam: no App ID set (not the Steam version)'); return; }
  steamApi = loadSteamworks();
  if (!steamApi) { log('Steam: steamworks.js is not bundled'); return; }
  try {
    // Started outside Steam: Steam restarts the game through itself (and this copy quits).
    if (app.isPackaged && steamCfg.relaunch !== false && steamApi.restartAppIfNecessary?.(STEAM_APP_ID)) { log('Steam: restarting through Steam'); app.quit(); return; }
  } catch (e) { log(`Steam: restart check failed: ${e?.message || e}`); }
  try {
    steamClient = steamApi.init(STEAM_APP_ID);
    const sid = steamClient.localplayer.getSteamId();
    steamState = { ...steamState, present: true, id: String(sid?.steamId64 ?? sid ?? ''), app: String(STEAM_APP_ID) };
    try { steamApi.electronEnableSteamOverlay?.(); } catch { /* overlay is optional */ }
    log(`Steam: running, user ${steamState.id}`);
  } catch (e) {
    steamClient = null;
    log(`Steam: not running or the game is not owned (${e?.message || e})`);
  }
}
let steamTicket = null;
ipcMain.handle('vangaurd:steam', async () => {
  if (!steamClient) return { ...steamState, present: false };
  if (!steamTicket) {
    try {
      const auth = steamClient.auth;
      const t = auth.getAuthTicketForWebApi ? await auth.getAuthTicketForWebApi('vangaurd') : await auth.getSessionTicket();
      steamTicket = { hex: Buffer.from(t.getBytes()).toString('hex'), kind: auth.getAuthTicketForWebApi ? 'web' : 'session' };
    } catch (e) { log(`Steam: could not get a ticket (${e?.message || e})`); }
  }
  return { ...steamState, ticket: steamTicket?.hex || null, kind: steamTicket?.kind || null };
});
ipcMain.handle('vangaurd:app-info', () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch }));
// Release 1.0: DLC on Steam. Whether this Steam account owns a DLC (by its Steam App ID), and opening its store page
// in the Steam overlay (or the browser when Steam isn't running).
ipcMain.handle('vangaurd:steam-dlc', async (_e, appId) => {
  const id = Math.floor(Number(appId)) || 0;
  if (!steamClient || !id) return { owned: false, steam: !!steamClient };
  try {
    const a = steamClient.apps;
    return { owned: !!(a?.isDlcInstalled?.(id) || a?.isSubscribedApp?.(id)), steam: true };
  } catch (e) {
    return { owned: false, steam: true, error: String(e?.message || e) };
  }
});
ipcMain.handle('vangaurd:steam-store', async (_e, appId) => {
  const id = Math.floor(Number(appId)) || 0;
  if (!id) return { error: 'no app id' };
  try {
    if (steamClient?.overlay?.activateToStore) { steamClient.overlay.activateToStore(id, 0); return { overlay: true }; }
  } catch (e) { log(`Steam: could not open the store overlay (${e?.message || e})`); }
  await shell.openExternal(`https://store.steampowered.com/app/${id}/`);
  return { opened: true };
});
// Beta 1.3: the game shows its start-up screen (Patching / Logging in) once its window is on screen.
ipcMain.handle('vangaurd:revealed', () => gameRevealed);

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
      try { window.webContents.send('vangaurd:reveal'); } catch { /* closing */ }
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

// Release 1.0: party voice chat needs the microphone, and gyro aiming opens PlayStation and Switch Pro controllers
// over WebHID (the browser's Gamepad API has no motion sensors). Both are allowed for the game's own pages only.
const GYRO_VENDORS = new Set([0x054c, 0x057e]);
function gameUrl(url) {
  return !!gameOrigin && String(url || '').startsWith(gameOrigin);
}
function setupDevicePermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission === 'media') return callback(gameUrl(details?.requestingUrl || wc?.getURL?.()) && (!details?.mediaTypes || details.mediaTypes.every((t) => t === 'audio')));
    if (permission === 'hid') return callback(gameUrl(wc?.getURL?.()));
    callback(true);
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => (permission === 'hid' || permission === 'media' ? gameUrl(origin) : true));
  ses.setDevicePermissionHandler((details) => details.deviceType === 'hid' && gameUrl(details.origin) && GYRO_VENDORS.has(details.device?.vendorId));
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    const d = (details.deviceList || []).find((x) => GYRO_VENDORS.has(x.vendorId));
    callback(d ? d.deviceId : '');
  });
  log('Device permissions: microphone (voice chat) and controllers (gyro) for the game only.');
}

app.whenReady().then(async () => {
  if (!hasAppLock) return;
  logFile = path.join(app.getPath('userData'), 'launch.log');
  initSteam();
  updater = createUpdater({ app, dialog, shell, log, steam: STEAM_APP_ID > 0 });
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
    setupDevicePermissions();
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
