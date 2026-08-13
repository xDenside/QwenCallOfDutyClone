#!/usr/bin/env node
// Isolate the vertical sky bands: list transparent objects, then hide the Sky mesh.
import puppeteer from 'puppeteer';

const url = process.argv[2] || 'http://localhost:4173/';
const view = { pos: [26, 1.7, 6], look: [-1.2, 2.2, -6.7] };
const browser = await puppeteer.launch({
  headless: true,
  args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=metal', '--window-size=1280,720']
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__GAME_READY__ === true', { timeout: 45000 });
await page.evaluate(() => {
  window.game.debug.allowPausedUpdate = true;
  document.getElementById('overlay').classList.add('hidden');
});
const info = await page.evaluate(() => {
  const g = window.game;
  const list = [];
  g.scene.traverse((o) => {
    if (o.material && o.material.transparent) list.push(`${o.type}:${o.name || ''}:op=${o.material.opacity}`);
  });
  return { list, far: g.camera.far };
});
console.log(JSON.stringify(info, null, 1));
await page.evaluate((p, l) => {
  const g = window.game;
  g.scene.traverse((o) => { if (o.type === 'Sky' || (o.material && o.material.uniforms && o.material.uniforms.sunPosition)) o.visible = false; });
  window.game.debug.setCamera(p, l, null);
}, view.pos, view.look);
await new Promise((r) => setTimeout(r, 900));
await page.screenshot({ path: '/tmp/r7/seam_hidesky.jpg', type: 'jpeg', quality: 80 });
console.log('CAPTURED seam_hidesky');
await browser.close();
