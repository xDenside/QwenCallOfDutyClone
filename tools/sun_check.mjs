#!/usr/bin/env node
// Captures the sun-facing silhouette view to check glow levels.
// Usage: node tools/sun_check.mjs [outFile]
import puppeteer from 'puppeteer';

const outPrefix = process.argv[2] || '/tmp/sun_v';
const url = process.argv[3] || 'http://localhost:4173/';
const views = [
  { name: 'current', pos: [0, 1.7, 42], look: [-40, 8, 0], fov: 75 },
  { name: 'nobloom', pos: [0, 1.7, 42], look: [-40, 8, 0], fov: 75, evalJS: 'window.game.postfx.bloom.strength = 0' },
  { name: 'th30', pos: [0, 1.7, 42], look: [-40, 8, 0], fov: 75, evalJS: 'window.game.postfx.bloom.strength = 0.04; window.game.postfx.bloom.threshold = 30' },
];

const browser = await puppeteer.launch({
  headless: true,
  args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=metal', '--window-size=1280,720']
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__GAME_READY__ === true', { timeout: 45000 });
await page.evaluate(() => {
  window.game.debug.allowPausedUpdate = true;
  document.getElementById('overlay').classList.add('hidden');
});
for (const v of views) {
  if (v.evalJS) await page.evaluate(v.evalJS);
  await page.evaluate((p, l, f) => window.game.debug.setCamera(p, l, f), v.pos, v.look, v.fov);
  await new Promise((r) => setTimeout(r, 1200));
  const outFile = `${outPrefix}${v.name}.jpg`;
  await page.screenshot({ path: outFile, type: 'jpeg', quality: 80 });
  console.log(`CAPTURED ${outFile}`);
}
await browser.close();
