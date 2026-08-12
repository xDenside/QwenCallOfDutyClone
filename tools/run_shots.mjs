#!/usr/bin/env node
// Runs the full critique shot script against the preview server.
// Usage: node tools/run_shots.mjs <roundDir>   (e.g. shots/round-1)
import puppeteer from 'puppeteer';
import { readFileSync, mkdirSync } from 'node:fs';

const roundDir = process.argv[2] || 'shots/round-1';
const shots = JSON.parse(readFileSync(new URL('./shots.json', import.meta.url)));
const url = process.argv[3] || 'http://localhost:4173/';

mkdirSync(roundDir, { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=metal', '--window-size=1920,1080']
});

for (const shot of shots) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error(`[${shot.name} pageerror]`, e.message));
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction('window.__GAME_READY__ === true', { timeout: 45000 });
    await page.evaluate(() => {
      window.game.debug.allowPausedUpdate = true;
      document.getElementById('overlay').classList.add('hidden');
      if (window.game.audio && window.game.audio.forceUnlock) window.game.audio.forceUnlock();
    });
    for (const src of shot.evals || []) {
      await page.evaluate((s) => { (0, eval)(s); }, src);
      await new Promise((r) => setTimeout(r, 200));
    }
    if (shot.pos) {
      await page.evaluate((p, l, f) => window.game.debug.setCamera(p, l, f), shot.pos, shot.look, shot.fov || null);
    }
    await new Promise((r) => setTimeout(r, shot.wait || 1500));
    if (shot.postWait) {
      await new Promise((r) => setTimeout(r, shot.postWait));
    }
    const path = `${roundDir}/${shot.name}.png`;
    await page.screenshot({ path, type: 'png' });
    console.log(`CAPTURED ${path}`);
  } catch (e) {
    console.error(`FAILED ${shot.name}: ${e.message}`);
  } finally {
    await page.close();
  }
}

await browser.close();
console.log('ROUND COMPLETE');
