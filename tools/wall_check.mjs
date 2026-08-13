#!/usr/bin/env node
// One-off dressing verification: close-ups of the decal-cluster walls.
import puppeteer from 'puppeteer';

const url = process.argv[2] || 'http://localhost:4173/';
const views = [
  { name: 'wall_building', pos: [-14, 1.7, -6], look: [-14, 1.5, -15.6] },
  { name: 'wall_gate', pos: [0, 1.7, 42], look: [0, 1.6, 51.8] },
];

const browser = await puppeteer.launch({
  headless: true,
  args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=metal', '--window-size=1280,720']
});

for (const v of views) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error(`[${v.name} pageerror]`, e.message));
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__GAME_READY__ === true', { timeout: 45000 });
  await page.evaluate(() => {
    window.game.debug.allowPausedUpdate = true;
    document.getElementById('overlay').classList.add('hidden');
  });
  await page.evaluate((p, l) => window.game.debug.setCamera(p, l, null), v.pos, v.look);
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: `/tmp/r5/${v.name}.jpg`, type: 'jpeg', quality: 80 });
  console.log(`CAPTURED /tmp/r5/${v.name}.jpg`);
  await page.close();
}
await browser.close();
