import { build } from 'vite';
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'Vangaurd-standalone.html');

async function collectFiles(dir, prefix = '') {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(absolute, relative));
    else if (entry.isFile()) files.push({ path: relative, data: await readFile(absolute) });
  }
  return files;
}

function packAssets(files) {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(files.length);
  const chunks = [header];
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    if (name.length > 0xffff) throw new Error(`Asset path is too long: ${file.path}`);
    const entry = Buffer.allocUnsafe(6);
    entry.writeUInt16BE(name.length, 0);
    entry.writeUInt32BE(file.data.length, 2);
    chunks.push(entry, name, file.data);
  }
  return gzipSync(Buffer.concat(chunks), { level: 1 });
}

const assetFiles = await collectFiles(path.join(root, 'public', 'assets'));
if (!assetFiles.length) throw new Error('No public/assets files were found; refusing to create a non-playable standalone file.');
const packedAssets = packAssets(assetFiles).toString('base64');

const viteResult = await build({
  configFile: path.join(root, 'vite.config.js'),
  root,
  publicDir: false,
  logLevel: 'warn',
  build: {
    write: false,
    minify: 'esbuild',
    sourcemap: false,
    lib: { entry: path.join(root, 'src/main.js'), formats: ['es'], fileName: () => 'game.js' },
    rollupOptions: { output: { codeSplitting: false } },
  },
});
const outputs = Array.isArray(viteResult) ? viteResult.flatMap((r) => r.output) : viteResult.output;
const app = outputs.find((o) => o.type === 'chunk' && o.isEntry);
if (!app) throw new Error('Vite did not produce the application entry bundle.');
const extraOutputs = outputs.filter((o) => o.type === 'asset' && typeof o.source === 'string' && /worker/i.test(o.fileName));
const workers = Object.fromEntries(extraOutputs.map((o) => [`/${o.fileName}`, Buffer.from(o.source).toString('base64')]));
let appCode = app.code;
for (const worker of extraOutputs) {
  const url = `/${worker.fileName}`;
  let replacements = 0;
  const literal = JSON.stringify(url);
  let pathAt = appCode.indexOf(literal);
  while (pathAt >= 0) {
    const callAt = appCode.lastIndexOf('new URL(', pathAt);
    const metaAt = appCode.indexOf('import.meta.url', pathAt);
    const callEnd = metaAt < 0 ? -1 : appCode.indexOf(')', metaAt);
    if (callAt < 0 || callEnd < 0) throw new Error(`Could not rewrite the emitted worker URL ${url} for standalone Blob modules.`);
    const replacement = `window.__STANDALONE_WORKERS__[${literal}]`;
    appCode = appCode.slice(0, callAt) + replacement + appCode.slice(callEnd + 1);
    replacements++;
    pathAt = appCode.indexOf(literal, callAt + replacement.length);
  }
  if (!replacements) throw new Error(`Could not find emitted worker URL ${url} in the bundled entry.`);
}

const index = await readFile(path.join(root, 'index.html'), 'utf8');
const style = [...index.matchAll(/<style>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
if (!style || !index.includes('id="app"')) throw new Error('Expected original game page structure was not found in index.html.');
const safeAppCode = appCode.replace(/<\/script/gi, '<\\/script');
const shell = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vangaurd</title><link rel="icon" href="data:,"><style>${style}\n#standalone-status{position:fixed;inset:0;z-index:100;display:grid;place-items:center;background:radial-gradient(ellipse at 50% 42%,#28322d 0,#111513 62%,#090b0a 100%);color:#f3efe4;font:14px/1.6 system-ui,sans-serif;text-align:center;padding:24px}#standalone-status.hidden{display:none}#standalone-status section{padding:28px 34px;border-left:2px solid #c79758;background:#111613e8;max-width:min(620px,92vw)}#standalone-status h1{font-size:clamp(26px,5vw,44px);letter-spacing:.05em;text-transform:uppercase;margin:0 0 12px}#standalone-status p{color:#d3d0c6;margin:8px 0}#standalone-status code{color:#e2b56f}</style></head><body><div id="standalone-status"><section><h1>Vangaurd</h1><p id="standalone-status-text">Starting the original game…</p></section></div><div id="app"></div><div id="hud"></div><div id="ui"></div><div id="boot-overlay" class="hidden"><h1>Vangaurd</h1><p>Click to deploy</p></div><div id="core-diag"></div><script id="worker-manifest" type="application/json">${JSON.stringify(workers)}</script><script>window.__STANDALONE_WORKERS__={};for(const [name,encoded] of Object.entries(JSON.parse(document.getElementById('worker-manifest').textContent))){const binary=atob(encoded),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);window.__STANDALONE_WORKERS__[name]=URL.createObjectURL(new Blob([bytes],{type:'text/javascript'}))}</script><script id="asset-archive" type="application/octet-stream">${packedAssets}</script><script type="module">
const mimeFor = (name) => ({'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.json':'application/json','.omat':'text/plain','.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.glb':'model/gltf-binary','.gltf':'model/gltf+json'})[name.slice(name.lastIndexOf('.')).toLowerCase()] || 'application/octet-stream';
async function installStandaloneAssets(encoded){
  const binary=atob(encoded),compressed=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)compressed[i]=binary.charCodeAt(i);
  const stream=new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
  const archive=new Uint8Array(await new Response(stream).arrayBuffer()),view=new DataView(archive.buffer);
  let offset=0;const count=view.getUint32(offset);offset+=4;const urls=new Map();
  for(let i=0;i<count;i++){
    const pathLength=view.getUint16(offset);offset+=2;const size=view.getUint32(offset);offset+=4;
    const name=new TextDecoder().decode(archive.subarray(offset,offset+pathLength));offset+=pathLength;
    const bytes=archive.slice(offset,offset+size);offset+=size;
    const assetPath = name.split('/').filter(Boolean).join('/');
    const normalizedName = assetPath.startsWith('assets/') ? '/' + assetPath : '/assets/' + assetPath;
    const keys = new Set([normalizedName, normalizedName.slice(1), decodeURIComponent(normalizedName)]);
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mimeFor(name) }));
    for (const key of keys) {
      if (key && key !== 'null' && key !== 'undefined') urls.set(key, blobUrl);
    }
  }
  window.__STANDALONE_ASSETS__=urls;
  window.__resolveStandaloneAsset=(input)=>{
    const candidates = new Set();
    const pushCandidate=(value)=>{ if (typeof value === 'string' && value) candidates.add(value); };
    const pushPath=(value)=>{
      if (typeof value !== 'string' || !value) return;
      const normalized = '/' + value.split('/').filter(Boolean).join('/');
      pushCandidate(normalized);
      pushCandidate(normalized.slice(1));
      const assetIndex = normalized.indexOf('/assets/');
      if (assetIndex >= 0) {
        const assetPath = normalized.slice(assetIndex);
        pushCandidate(assetPath);
        pushCandidate(assetPath.slice(1));
      }
    };
    pushCandidate(input);
    if (typeof input === 'string') {
      const trimmed = input.trim();
      pushCandidate(trimmed);
      pushPath(trimmed);
      try {
        const u = new URL(trimmed, location.href);
        const pathname = decodeURIComponent(u.pathname);
        pushPath(pathname);
      } catch {}
    }
    for (const candidate of candidates) {
      if (urls.has(candidate)) return urls.get(candidate);
    }
    return input;
  };
  const originalFetch=window.fetch.bind(window);
  window.fetch=(input,init)=>{const raw=input instanceof Request?input.url:input;const mapped=window.__resolveStandaloneAsset(raw);if(mapped===raw)return originalFetch(input,init);return originalFetch(mapped,init)};
}
const assetArchive=document.getElementById('asset-archive');
let packedAssets=assetArchive.firstChild?.data||'';
assetArchive.remove();
const standaloneAssetsReady=installStandaloneAssets(packedAssets);
packedAssets='';
document.getElementById('standalone-status-text').textContent='Preparing bundled game assets…';
await standaloneAssetsReady;
${safeAppCode}
const status=document.getElementById('standalone-status'),statusText=document.getElementById('standalone-status-text');
const monitor=async()=>{for(let i=0;i<900&&!window.__GAME__&&!window.__SHOT_FAILED__;i++)await new Promise(requestAnimationFrame);if(window.__SHOT_FAILED__){statusText.textContent='Game startup failed: '+window.__SHOT_FAILED__;return}if(!window.__GAME__){statusText.textContent='Game startup timed out. Reload to try again.';return}for(let i=0;i<1800&&window.__GAME__.runner.status().some(s=>['loaded','created'].includes(s.status));i++)await new Promise(requestAnimationFrame);await window.__GAME__.ctx.assets.whenIdle();for(let i=0;i<5400&&!window.__APP_STARTUP_READY__&&!window.__SHOT_FAILED__;i++)await new Promise(requestAnimationFrame);if(window.__SHOT_FAILED__){statusText.textContent='Game startup failed: '+window.__SHOT_FAILED__;return}if(!window.__APP_STARTUP_READY__){statusText.textContent='Map rendering is taking longer than expected. Reload to try again.';return}status.classList.add('hidden')};
monitor().catch(error=>{statusText.textContent='Game startup failed: '+(error?.message||error);console.error('[standalone] startup monitor failed',error)});
</script></body></html>`;
await writeFile(outFile, shell);
const { size } = await stat(outFile);
console.log(`Created ${path.relative(root, outFile)} (${(size / 1024 / 1024).toFixed(1)} MiB, ${assetFiles.length} embedded assets, bundled game code and ${extraOutputs.length} worker bundle(s); playable directly from file://).`);
