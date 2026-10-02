#!/usr/bin/env node
/**
 * HUD probe: opens a shot preset in the harness browser and evaluates a JS expression in the page
 * after the shot is ready. Prints the JSON result.
 *   node tools/hud/probe.mjs hud-pause-settings "getComputedStyle(document.querySelector('.od-scrim.dark')).backdropFilter"
 */
import { startServer, launchBrowser, openPage, waitForReady, buildUrl, cleanupAll } from '../lib/harness.mjs';

const [preset = 'hud-gameplay', expr = 'window.__SHOT_INFO__'] = process.argv.slice(2);
try {
  const { url } = await startServer();
  const launched = await launchBrowser({ width: 1920, height: 1080 });
  const browser = launched.browser ?? launched;
  const { page } = await openPage(browser, { width: 1920, height: 1080 });
  await page.goto(buildUrl(url, { shot: preset, w: 1920, h: 1080 }));
  await waitForReady(page, 90000);
  const res = await page.evaluate((e) => {
    try { return JSON.parse(JSON.stringify(eval(e))); } catch (err) { return 'ERR ' + err.message; }
  }, expr);
  console.log(JSON.stringify(res, null, 1));
  const shotPath = process.argv[4];
  if (shotPath) {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.screenshot({ path: shotPath });
    console.log('screenshot', shotPath);
  }
} catch (e) {
  console.error(e);
} finally {
  await cleanupAll();
  process.exit(0);
}
