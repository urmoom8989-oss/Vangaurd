// Probe WebGL2 compressed-texture extension support in the harness browser.
import { launchBrowser, cleanupAll } from '../lib/harness.mjs';
const { browser } = await launchBrowser();
const p = await browser.newPage();
const r = await p.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  return gl.getSupportedExtensions().filter((e) => /compress|anisotropic|float|half/i.test(e));
});
console.log(r);
await cleanupAll();
process.exit(0);
