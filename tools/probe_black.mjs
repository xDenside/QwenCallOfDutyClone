#!/usr/bin/env node
// Enumerate every mesh with verts inside the container region; dump material facts.
import puppeteer from 'puppeteer';

const url = process.argv[2] || 'http://localhost:4173/';
const browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__GAME_READY__ === true', { timeout: 45000 });
const out = await page.evaluate(() => {
  const g = window.game;
  const r = [16, 23, 0.3, 2.6, -37.2, -33.9];
  const found = [];
  g.scene.updateMatrixWorld(true);
  g.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const p = o.geometry.attributes.position;
    const col = o.geometry.attributes.color;
    const m = o.material;
    const mw = o.matrixWorld.elements;
    let hits = 0; const sample = [];
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const wx = mw[0] * x + mw[4] * y + mw[8] * z + mw[12];
      const wy = mw[1] * x + mw[5] * y + mw[9] * z + mw[13];
      const wz = mw[2] * x + mw[6] * y + mw[10] * z + mw[14];
      if (wx >= r[0] && wx <= r[1] && wy >= r[2] && wy <= r[3] && wz >= r[4] && wz <= r[5]) {
        hits++;
        if (sample.length < 2) sample.push({ w: [+wx.toFixed(2), +wy.toFixed(2), +wz.toFixed(2)], col: col ? [+col.getX(i).toFixed(2), +col.getY(i).toFixed(2), +col.getZ(i).toFixed(2)] : null });
      }
    }
    if (hits > 0) found.push({
      verts: p.count, hits, sample,
      vc: !!m.vertexColors, matColor: m.color && m.color.getHexString(),
      map: !!m.map, transparent: m.transparent, opacity: m.opacity,
      emissive: m.emissive && m.emissive.getHexString()
    });
  });
  return found;
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
