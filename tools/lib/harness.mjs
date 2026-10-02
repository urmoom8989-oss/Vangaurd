/**
 * Shared harness plumbing for tools/shot.mjs, tools/perf.mjs and tools/audio.mjs.
 *
 *  - startServer(): private Vite dev server on a free port (safe for many concurrent runs:
 *    no file watching (no reloads mid-capture), error overlay off, per-process cache dir,
 *    dependency optimizer disabled).
 *  - launchBrowser(): Playwright Chromium with real GPU acceleration (ANGLE/D3D11 on Windows).
 *    Verifies the WebGL renderer is a hardware GPU; falls back to a headed off-screen window if
 *    headless only offers SwiftShader.
 *  - cleanup is registered for SIGINT/SIGTERM/uncaught errors so no server/browser is leaked.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SHOTS_DIR = path.join(ROOT, 'shots');

const log = (...a) => { if (!process.env.HARNESS_QUIET) console.error('[harness]', ...a); };
export { log };

// ------------------------------------------------------------------------------------------ args
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

export function timestamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}-${process.pid}`;
}

// ------------------------------------------------------------------------------------------ cleanup
const cleanups = [];
let cleaning = false;
export function onCleanup(fn) { cleanups.push(fn); }
export async function cleanupAll() {
  if (cleaning) return;
  cleaning = true;
  for (const fn of cleanups.reverse()) {
    try { await Promise.race([fn(), new Promise((r) => setTimeout(r, 5000))]); } catch { /* ignore */ }
  }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => { await cleanupAll(); process.exit(130); });
}
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, async (e) => {
    console.error('[harness] fatal:', e?.stack || e);
    await cleanupAll();
    process.stdout.write(JSON.stringify({ ok: false, error: String(e?.message || e) }) + String.fromCharCode(10));
    process.exit(1);
  });
}

// ------------------------------------------------------------------------------------------ server
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function startServer() {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-vite-'));
  const port = await freePort();
  const server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.js'),
    cacheDir,
    logLevel: 'error',
    clearScreen: false,
    server: {
      host: '127.0.0.1',
      port,
      strictPort: false,
      hmr: { overlay: false }, // never `hmr: false`: that re-enables the error overlay that covers the canvas
      watch: null, // no file watching => no reloads mid-capture when other agents edit files
      open: false,
    },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  await server.listen();
  const addr = server.httpServer.address();
  const url = `http://127.0.0.1:${addr.port}`;
  onCleanup(async () => {
    await server.close();
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  log(`vite dev server ${url}`);
  return { server, url };
}

// ------------------------------------------------------------------------------------------ browser
const GPU_ARGS = [
  '--use-angle=d3d11',
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
  '--enable-zero-copy',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--autoplay-policy=no-user-gesture-required',
];
const UNCAPPED_ARGS = ['--disable-gpu-vsync', '--disable-frame-rate-limit'];

export function isHardwareRenderer(r = '') {
  return !!r && !/swiftshader|llvmpipe|softpipe|microsoft basic render|software/i.test(r);
}

async function probeRenderer(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    return await page.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      if (!gl) return 'no-webgl2';
      const e = gl.getExtension('WEBGL_debug_renderer_info');
      return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    });
  } finally {
    await ctx.close();
  }
}

/**
 * @param {{ width?: number, height?: number, uncapped?: boolean, headed?: boolean }} o
 * @returns {Promise<{ browser, mode: string, renderer: string }>}
 */
export async function launchBrowser({ width = 1920, height = 1080, uncapped = false, headed = false } = {}) {
  const args = [...GPU_ARGS, ...(uncapped ? UNCAPPED_ARGS : [])];
  const attempts = headed
    ? [['headed-offscreen', { channel: 'chromium', headless: false, args: [...args, '--window-position=-32000,-32000', `--window-size=${width},${height + 100}`] }]]
    : [
        ['headless', { channel: 'chromium', headless: true, args }],
        ['headless-shell', { headless: true, args }],
        ['headed-offscreen', { channel: 'chromium', headless: false, args: [...args, '--window-position=-32000,-32000', `--window-size=${width},${height + 100}`] }],
      ];
  let last = null;
  for (const [mode, opts] of attempts) {
    let browser;
    try {
      browser = await chromium.launch(opts);
      const renderer = await probeRenderer(browser);
      if (isHardwareRenderer(renderer)) {
        onCleanup(() => browser.close());
        log(`browser mode=${mode} renderer="${renderer}"`);
        return { browser, mode, renderer };
      }
      log(`browser mode=${mode} gave software renderer "${renderer}", trying next mode`);
      // keep only the most recent software browser, as a last resort
      if (last) try { await last.browser.close(); } catch { /* ignore */ }
      last = { browser, mode, renderer };
    } catch (e) {
      log(`browser mode=${mode} failed: ${e.message.split('\n')[0]}`);
      try { await browser?.close(); } catch { /* ignore */ }
    }
  }
  if (last) {
    onCleanup(() => last.browser.close());
    log(`WARNING: no hardware GPU available; using software renderer "${last.renderer}"`);
    return last;
  }
  throw new Error('could not launch Chromium');
}

/** Open a page at the given viewport and collect console/page/network errors. */
export async function openPage(browser, { width, height }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const diag = { consoleErrors: [], consoleWarnings: [], pageErrors: [], networkErrors: [] };
  const cap = (arr, v) => { if (arr.length < 50) arr.push(v); };
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error') cap(diag.consoleErrors, m.text());
    else if (t === 'warning') cap(diag.consoleWarnings, m.text());
  });
  page.on('pageerror', (e) => cap(diag.pageErrors, String(e?.stack || e).split('\n').slice(0, 4).join('\n')));
  page.on('requestfailed', (r) => cap(diag.networkErrors, `${r.failure()?.errorText || 'failed'} ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400) cap(diag.networkErrors, `${r.status()} ${r.url()}`); });
  return { context, page, diag };
}

/** Wait until the page signals readiness (or failure). */
export async function waitForReady(page, timeoutMs) {
  const handle = await page.waitForFunction(
    () => (window.__SHOT_READY__ === true ? 'ready' : window.__SHOT_FAILED__ ? 'failed:' + window.__SHOT_FAILED__ : false),
    null,
    { timeout: timeoutMs, polling: 100 },
  );
  const v = await handle.jsonValue();
  if (typeof v === 'string' && v.startsWith('failed:')) throw new Error(v.slice(7));
  return v;
}

export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

export function buildUrl(base, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== false) q.set(k, String(v));
  return `${base}/?${q.toString()}`;
}

export function printJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}
