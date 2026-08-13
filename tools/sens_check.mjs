#!/usr/bin/env node
// Measures yaw response per injected mouse delta in hip-fire vs ADS.
import puppeteer from 'puppeteer';

const url = process.argv[2] || 'http://localhost:4173/';
const browser = await puppeteer.launch({
  headless: true,
  args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=metal']
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__GAME_READY__ === true', { timeout: 45000 });
await page.evaluate(() => { window.game.debug.allowPausedUpdate = true; });

const measure = async () => page.evaluate(async () => {
  const g = window.game;
  const y0 = g.player.yaw;
  g.input.dx = 600;
  await new Promise((r) => setTimeout(r, 120));
  const dYaw = Math.abs(g.player.yaw - y0);
  return { dYaw, fov: g.camera.fov };
});

await new Promise((r) => setTimeout(r, 800));
const hip = await measure();
await page.evaluate(() => window.game.input.buttons.add(2));
await new Promise((r) => setTimeout(r, 900));
const ads = await measure();
await page.evaluate(() => window.game.input.buttons.delete(2));

const screenRate = (m) => m.dYaw / Math.tan((m.fov * Math.PI / 180) / 2);
console.log(JSON.stringify({
  hipfire: { degPer100px: +(hip.dYaw * 180 / Math.PI / 6).toFixed(2), fov: +hip.fov.toFixed(1) },
  ads: { degPer100px: +(ads.dYaw * 180 / Math.PI / 6).toFixed(2), fov: +ads.fov.toFixed(1) },
  screenRateRatioHipOverAds: +(screenRate(hip) / screenRate(ads)).toFixed(3)
}, null, 2));
await browser.close();
