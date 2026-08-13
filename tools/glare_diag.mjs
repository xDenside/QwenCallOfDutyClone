#!/usr/bin/env node
// Isolate the sun-glare source: kill one suspect at a time, read values back.
import puppeteer from 'puppeteer';

const url = process.argv[2] || 'http://localhost:4173/';
const view = { pos: [26, 1.7, 6], look: [-1.2, 2.2, -6.7] };
const sets = [
  { tag: 'mie0', fn: (g) => { g.scene.traverse((o) => { const u = o.material && o.material.uniforms; if (u && u.sunPosition) u.mieCoefficient.value = 0; }); } },
  { tag: 'ray0', fn: (g) => { g.scene.traverse((o) => { const u = o.material && o.material.uniforms; if (u && u.sunPosition) u.rayleigh.value = 0; }); } },
  { tag: 'nofog', fn: (g) => { g.scene.fog = null; } },
  { tag: 'nobloom', fn: (g) => { const b = g.engine.composer.passes.find((p) => 'threshold' in p && 'strength' in p); if (b) b.strength = 0; } },
];

const browser = await puppeteer.launch({
  headless: true,
  args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=metal', '--window-size=1280,720']
});

for (const s of sets) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error(`[${s.tag} pageerror]`, e.message));
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__GAME_READY__ === true', { timeout: 45000 });
  await page.evaluate(() => {
    window.game.debug.allowPausedUpdate = true;
    document.getElementById('overlay').classList.add('hidden');
  });
  const info = await page.evaluate((src) => {
    const g = window.game;
    const fn = new Function('g', src);
    fn(g);
    let sky = null;
    g.scene.traverse((o) => { const u = o.material && o.material.uniforms; if (u && u.sunPosition) sky = u; });
    const b = g.engine.composer.passes.find((p) => 'threshold' in p && 'strength' in p);
    return {
      mie: sky ? sky.mieCoefficient.value : 'no-sky',
      rayleigh: sky ? sky.rayleigh.value : 'no-sky',
      fog: !!g.scene.fog,
      bloomStrength: b ? b.strength : 'no-bloom'
    };
  }, s.fn.toString().replace(/^.*?\{/, '{').replace(/\}$/, '}'));
  console.log(s.tag, JSON.stringify(info));
  await page.evaluate((p, l) => window.game.debug.setCamera(p, l, null), view.pos, view.look);
  await new Promise((r) => setTimeout(r, 900));
  await page.screenshot({ path: `/tmp/r7/diag_${s.tag}.jpg`, type: 'jpeg', quality: 80 });
  console.log(`CAPTURED diag_${s.tag}`);
  await page.close();
}
await browser.close();
