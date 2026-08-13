#!/usr/bin/env node
// One-off verification of the round-6 east/SE/north fill pass.
import puppeteer from 'puppeteer';

const url = process.argv[2] || 'http://localhost:4173/';
const outDir = process.argv[3] || '/tmp/r7';
const views = [
  { name: 'user_east', pos: [28, 1.7, 38], look: [52, 2, 20] },
  { name: 'se_open', pos: [20, 1.7, 30], look: [40, 2, 46] },
  { name: 'north_sheds', pos: [16, 1.7, -30], look: [16, 2, -50] },
  { name: 'sun_face', pos: [40, 1.7, 42], look: [13, 2.2, 29] },
  { name: 'courtyard', pos: [0, 1.7, 40], look: [2, 1.4, 10] },
  { name: 'south_horizon', pos: [10, 2.5, -20], look: [14, 1.5, 80] },
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
  await page.screenshot({ path: `${outDir}/${v.name}.jpg`, type: 'jpeg', quality: 80 });
  console.log(`CAPTURED ${outDir}/${v.name}.jpg`);
  await page.close();
}
await browser.close();
