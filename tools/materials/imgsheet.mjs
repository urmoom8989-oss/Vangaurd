// node tools/materials/imgsheet.mjs out.png a.png,b.png,...  -> labelled contact sheet of local images (debug)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const out = process.argv[2]; const files = process.argv[3].split(',');
const size = +(process.argv[4] || 380);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 400 } });
const html = `<body style="margin:0;background:#222;color:#fff;font:14px sans-serif;display:flex;flex-wrap:wrap">${files.map((f) => `<div style="width:${size}px;margin:4px"><img src="data:image/png;base64,${fs.readFileSync(f).toString('base64')}" width=${size} height=${size}><div>${path.basename(f)}</div></div>`).join('')}</body>`;
await p.setContent(html, { waitUntil: 'load' });
await p.screenshot({ path: out, fullPage: true });
await b.close();
