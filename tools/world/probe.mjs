// World probe: loads a shot preset, then evaluates a JS expression file/string in the page and prints JSON.
// Usage: node tools/world/probe.mjs <preset> <script.js | --expr "code">
// The script body runs as an async function with (game, THREE, world) in scope and must `return` a value.
import fs from 'node:fs';
import { startServer, launchBrowser, openPage, waitForReady, buildUrl, printJson, cleanupAll } from '../lib/harness.mjs';

const [preset, a2, a3] = process.argv.slice(2);
const code = a2 === '--expr' ? `return (${a3});` : fs.readFileSync(a2, 'utf8');

try {
  const { url } = await startServer();
  const { browser } = await launchBrowser({ width: 1280, height: 720 });
  const { page, diag } = await openPage(browser, { width: 1280, height: 720 });
  const logs = [];
  page.on('console', (m) => { if (/world/i.test(m.text())) logs.push(m.text().slice(0, 400)); });
  await page.goto(buildUrl(url, { shot: preset, w: 1280, h: 720 }));
  await waitForReady(page, 120000);
  const result = await page.evaluate(async (src) => {
    const game = window.__GAME__;
    const THREE = game.THREE;
    const world = game.ctx.services.world;
    const fn = new Function('game', 'THREE', 'world', `return (async () => { ${src} })();`);
    return fn(game, THREE, world);
  }, code);
  printJson({ result, logs, errors: diag.consoleErrors, pageErrors: diag.pageErrors });
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await cleanupAll();
}
