import { chromium } from 'playwright';
const ids = process.argv[3].split(',');
const out = process.argv[2];
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 400 } });
const html = `<body style="margin:0;background:#222;color:#fff;font:14px sans-serif;display:flex;flex-wrap:wrap">${ids.map(i=>`<div style="width:256px;margin:4px"><img src="https://cdn.polyhaven.com/asset_img/thumbs/${i}.png?width=256&height=256" width=256 height=256><div>${i}</div></div>`).join('')}</body>`;
await p.setContent(html, { waitUntil: 'networkidle' });
await p.screenshot({ path: out, fullPage: true });
await b.close();
