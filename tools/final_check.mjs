#!/usr/bin/env node
// Bloom fix verification + sky-seam isolation (glass hidden vs camera move).
import puppeteer from 'puppeteer';

const url = process.argv[2] || 'http://localhost:4173/';
const shots = [
  { name: 'fix_sunface', pos: [26, 1.7, 6], look: [-1.2, 2.2, -6.7], bloom: [0.08, 8] },
  { name: 'fix_sunface_alt', pos: [40, 1.7, 42], look: [13, 2.2, 29], bloom: [0.08, 8] },
  { name: 'fix_noglass', pos: [26, 1.7, 6], look: [-1.2, 2.2, -6.7], bloom: [0.08, 8], hideGlass: true },
  { name: 'fix_north', pos: [16, 1.7, -30], look: [16, 2, -50], bloom: [0.08, 8] },
];

const browser = await puppeteer.launch({
  headless: true,
  args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=metal', '--window-size=1280,720']
});

for (const s of shots) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error(`[${s.name} pageerror]`, e.message));
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__GAME_READY__ === true', { timeout: 45000 });
  await page.evaluate(() => {
    window.game.debug.allowPausedUpdate = true;
    document.getElementById('overlay').classList.add('hidden');
  });
  await page.evaluate((cfg) => {
    const g = window.game;
    const b = g.engine.composer.passes.find((p) => 'threshold' in p && 'strength' in p);
    if (b) { b.strength = cfg.bloom[0]; b.threshold = cfg.bloom[1]; }
    if (cfg.hideGlass) {
      g.scene.traverse((o) => {
        if (o.isMesh && o.material && o.material.transparent && o.material.opacity < 0.6) o.visible = false;
      });
    }
  }, s);
  await page.evaluate((p, l) => window.game.debug.setCamera(p, l, null), s.pos, s.look);
  await new Promise((r) => setTimeout(r, 900));
  await page.screenshot({ path: `/tmp/r7/${s.name}.jpg`, type: 'jpeg', quality: 80 });
  console.log(`CAPTURED ${s.name}`);
  await page.close();
}
await browser.close();
