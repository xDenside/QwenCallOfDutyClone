#!/usr/bin/env node
// Find oversized triangles in the merged glass bucket geometry.
import puppeteer from 'puppeteer';

const url = process.argv[2] || 'http://localhost:4173/';
const browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__GAME_READY__ === true', { timeout: 45000 });
const out = await page.evaluate(() => {
  const res = [];
  window.game.scene.traverse((o) => {
    if (!o.isMesh || !o.material || !o.material.transparent || o.material.opacity >= 0.6) return;
    const g = o.geometry;
    const p = g.attributes.position;
    const idx = g.index;
    const n = idx ? idx.count : p.count;
    const v = (i) => [p.getX(i), p.getY(i), p.getZ(i)];
    for (let i = 0; i < n; i += 3) {
      const a = v(idx ? idx.getX(i) : i), b = v(idx ? idx.getX(i + 1) : i + 1), c = v(idx ? idx.getX(i + 2) : i + 2);
      const d = (u, w) => Math.hypot(u[0] - w[0], u[1] - w[1], u[2] - w[2]);
      const max = Math.max(d(a, b), d(b, c), d(c, a));
      if (max > 4) res.push({ obj: o.name || o.uuid.slice(0, 6), max: +max.toFixed(1), a: a.map((x) => +x.toFixed(1)), b: b.map((x) => +x.toFixed(1)), c: c.map((x) => +x.toFixed(1)) });
    }
  });
  return res.slice(0, 20);
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
