// Desktop auto-update.
// The game page asks for the update (with no "later" option) when the Vangaurd server says this build is
// too old; closing that prompt quits the game. "Update now" calls check(win, 'required'), which goes
// straight to the download:
//   Windows - downloads the installer, runs it silently and restarts the game.
//   macOS   - downloads the disk image and opens it so the new app can be dragged over the old one.
// If it cannot update by itself it returns why, and the page offers the download page instead.
// The check at launch only records whether a newer build exists; it never shows a prompt of its own.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const RELEASE_PAGE = process.env.VANGAURD_RELEASE_PAGE || 'https://github.com/urmoom8989-oss/opus-of-duty/releases/latest';
const DOWNLOAD_BASE = process.env.VANGAURD_DOWNLOAD_BASE || `${RELEASE_PAGE}/download`;
const VERSION_URL = process.env.VANGAURD_VERSION_URL || `${DOWNLOAD_BASE}/version.json`;

function buildOf(version) {
  const m = /^\d+\.\d+\.(\d+)/.exec(String(version || ''));
  return m ? Number(m[1]) : 0;
}

function installerFor(info, platform = process.platform, arch = process.arch) {
  const f = info && info.files ? info.files : {};
  if (platform === 'win32') return f.win || null;
  if (platform === 'darwin') return arch === 'arm64' ? f.macArm || null : f.macX64 || f.macArm || null;
  return null;
}

async function fetchLatest(fetchImpl = fetch) {
  const res = await fetchImpl(`${VERSION_URL}?t=${Date.now()}`, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`version check failed (HTTP ${res.status})`);
  const info = await res.json();
  if (!info || !Number.isFinite(Number(info.build))) throw new Error('version.json has no build number');
  return info;
}

async function download(url, file, onProgress, fetchImpl = fetch) {
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = `${file}.part`;
  const out = fs.createWriteStream(tmp);
  let got = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
      if (onProgress) onProgress(total ? got / total : -1, got, total);
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (total && got !== total) throw new Error(`download incomplete (${got} of ${total} bytes)`);
  fs.renameSync(tmp, file);
  return file;
}

function createUpdater({ app, dialog, shell, log = () => {}, fetchImpl, platform = process.platform, arch = process.arch, run = spawn }) {
  let busy = false;
  const doFetch = fetchImpl || ((...a) => fetch(...a));

  async function check(win, reason = 'launch') {
    if (busy) return { busy: true };
    busy = true;
    const live = () => win && !win.isDestroyed();
    const progress = (f) => {
      if (!live()) return;
      win.setProgressBar(f < 0 ? 2 : f);
      try { win.webContents?.send?.('vangaurd:update-progress', f); } catch { /* window closing */ }
    };
    try {
      const mine = buildOf(app.getVersion());
      let info;
      try {
        info = await fetchLatest(doFetch);
      } catch (e) {
        log(`Update check (${reason}) failed: ${e.message}`);
        return { error: e.message };
      }
      const latest = Math.floor(Number(info.build));
      log(`Update check (${reason}): this is build ${mine}, newest is build ${latest}`);
      if (!(latest > mine)) return { upToDate: true, latest, mine };
      if (reason === 'launch') return { available: true, latest, mine };
      const file = installerFor(info, platform, arch);
      if (!file) return { noInstaller: true, latest, mine, page: RELEASE_PAGE };
      const dir = platform === 'darwin' ? app.getPath('downloads') : app.getPath('temp');
      const target = path.join(dir, file);
      try {
        progress(0);
        await download(`${DOWNLOAD_BASE}/${encodeURIComponent(file)}`, target, progress, doFetch);
      } catch (e) {
        log(`Update download failed: ${e.message}`);
        if (live()) win.setProgressBar(-1);
        return { error: e.message, latest, mine, page: RELEASE_PAGE };
      }
      if (live()) win.setProgressBar(-1);
      log(`Update downloaded to ${target}`);
      if (platform === 'win32') {
        // Silent install into the existing location, then start the updated game.
        const child = run(target, ['/S', '--force-run'], { detached: true, stdio: 'ignore' });
        child.unref?.();
        setTimeout(() => app.quit(), 400);
        return { installing: true, latest, mine, file: target };
      }
      await shell.openPath(target);
      await dialog.showMessageBox(win, { type: 'info', buttons: ['Quit Vangaurd'], defaultId: 0, cancelId: 0, noLink: true, title: 'Finish the update', message: 'Drag Vangaurd into Applications', detail: 'In the window that just opened, drag Vangaurd onto the Applications folder and choose Replace. Then open Vangaurd again.' });
      app.quit();
      return { opened: true, latest, mine, file: target };
    } finally {
      busy = false;
    }
  }

  return { check };
}

module.exports = { createUpdater, buildOf, installerFor, fetchLatest, download, RELEASE_PAGE, VERSION_URL };
