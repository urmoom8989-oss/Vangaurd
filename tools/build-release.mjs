// Builds the current game (prebuilt/game-module.js) into:
//   --standalone <file>  one self-contained HTML file (all assets embedded, runs from file://)
//   --dist <dir>         a regular web build (index.html + game-<hash>.js + assets/) used by the desktop apps
// No npm dependencies are needed; only Node 18+.
import { readFile, writeFile, mkdir, readdir, copyFile, rm, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const standaloneOut = opt('--standalone');
const distOut = opt('--dist');
if (!standaloneOut && !distOut) {
  console.error('usage: node tools/build-release.mjs [--standalone Vangaurd.html] [--dist dist]');
  process.exit(1);
}

const head = await readFile(path.join(root, 'prebuilt', 'standalone-head.html'), 'utf8');
// BUILD_NUMBER (set by the release workflow) is stamped into the game so it can tell the server and the
// desktop updater which build it is. Local builds are build 0.
const buildNumber = String(Math.max(0, Math.floor(Number(process.env.BUILD_NUMBER) || 0)));
const moduleCode = (await readFile(path.join(root, 'prebuilt', 'game-module.js'), 'utf8')).replaceAll('"__VGD_BUILD__"', JSON.stringify(buildNumber));
const ARCHIVE_OPEN = '<script id="asset-archive" type="application/octet-stream">';
const MODULE_OPEN = '</script><script type="module">\n';
if (!head.endsWith(ARCHIVE_OPEN)) throw new Error('prebuilt/standalone-head.html must end with the asset-archive script tag.');
if (!moduleCode.includes('await standaloneAssetsReady;')) throw new Error('prebuilt/game-module.js is not the standalone game module.');

async function collectFiles(dir, prefix = '') {
  const files = [];
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(absolute, relative));
    else if (entry.isFile()) files.push({ path: relative, absolute });
  }
  return files;
}

const assetsDir = path.join(root, 'public', 'assets');
const assetFiles = await collectFiles(assetsDir);
if (!assetFiles.length) throw new Error('No public/assets files were found.');

if (standaloneOut) {
  const chunks = [];
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(assetFiles.length);
  chunks.push(header);
  for (const file of assetFiles) {
    const data = await readFile(file.absolute);
    const name = Buffer.from(file.path, 'utf8');
    const entry = Buffer.allocUnsafe(6);
    entry.writeUInt16BE(name.length, 0);
    entry.writeUInt32BE(data.length, 2);
    chunks.push(entry, name, data);
  }
  const packed = gzipSync(Buffer.concat(chunks), { level: 6 }).toString('base64');
  const out = path.resolve(standaloneOut);
  await writeFile(out, head + packed + MODULE_OPEN + moduleCode);
  const { size } = await stat(out);
  console.log(`standalone: ${out} (${(size / 1048576).toFixed(1)} MiB, ${assetFiles.length} assets)`);
}

if (distOut) {
  const dist = path.resolve(distOut);
  await rm(dist, { recursive: true, force: true });
  await mkdir(path.join(dist, 'assets'), { recursive: true });
  // Page shell: same styles and elements as the standalone page, but no inline scripts
  // (the desktop app serves it with a strict Content-Security-Policy).
  const bodyEnd = head.indexOf('<script id="worker-manifest"');
  if (bodyEnd < 0) throw new Error('worker manifest not found in the standalone head.');
  const manifestMatch = head.slice(bodyEnd).match(/<script id="worker-manifest" type="application\/json">([\s\S]*?)<\/script>/);
  const workers = manifestMatch ? JSON.parse(manifestMatch[1]) : {};
  const workerMap = {};
  for (const [url, encoded] of Object.entries(workers)) {
    const file = path.join(dist, url.replace(/^\/+/, ''));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(encoded, 'base64'));
    workerMap[url] = url;
  }
  // Script names carry a hash of their contents, so an update can never pick up an older cached copy.
  const hashed = (name, text) => `${name}-${createHash('sha256').update(text).digest('hex').slice(0, 12)}.js`;
  const bootCode = `window.__STANDALONE_WORKERS__=${JSON.stringify(workerMap)};\n`;
  // Game code without the embedded-asset loader: assets are plain files next to it.
  const start = moduleCode.indexOf('await standaloneAssetsReady;');
  let game = moduleCode.slice(moduleCode.indexOf('\n', start) + 1);
  game = game.replace(/<\/script><\/body><\/html>\s*$/, '');
  const gameCode = `document.getElementById('standalone-status-text').textContent='Loading Vangaurd…';\n${game}\n`;
  const bootName = hashed('boot', bootCode), gameName = hashed('game', gameCode);
  await writeFile(path.join(dist, bootName), bootCode);
  await writeFile(path.join(dist, gameName), gameCode);
  await writeFile(path.join(dist, 'index.html'), `${head.slice(0, bodyEnd)}<script src="/${bootName}"></script><script type="module" src="/${gameName}"></script></body></html>\n`);
  for (const file of assetFiles) {
    const target = path.join(dist, 'assets', file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(file.absolute, target);
  }
  console.log(`dist: ${dist} (${assetFiles.length} assets, ${Object.keys(workerMap).length} worker(s), build ${buildNumber})`);
}
