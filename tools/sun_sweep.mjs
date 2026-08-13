#!/usr/bin/env node
// Live sky/bloom/shadow parameter sweep — tweaks uniforms in-page, no rebuild.
import puppeteer from 'puppeteer';

const url = process.argv[2] || 'http://localhost:4173/';
const views = [
  { name: 'north_sheds', pos: [16, 1.7, -30], look: [16, 2, -50] },
];
const sets = [
  { tag: 'F', noShadow: true },
];

const browser = await puppeteer.launch({
  headless: true,
  args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=metal', '--window-size=1280,720']
});

for (const s of sets) {
  for (const v of views) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => console.error(`[${s.tag}/${v.name} pageerror]`, e.message));
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction('window.__GAME_READY__ === true', { timeout: 45000 });
    await page.evaluate(() => {
      window.game.debug.allowPausedUpdate = true;
      document.getElementById('overlay').classList.add('hidden');
    });
    await page.evaluate((cfg) => {
      const g = window.game;
      g.scene.traverse((o) => {
        const u = o.material && o.material.uniforms;
        if (u && u.sunPosition) {
          if (cfg.mie != null) u.mieCoefficient.value = cfg.mie;
          if (cfg.g != null) u.mieDirectionalG.value = cfg.g;
          if (cfg.rayleigh != null) u.rayleigh.value = cfg.rayleigh;
          if (cfg.turbidity != null) u.turbidity.value = cfg.turbidity;
        }
        if (o.isHemisphereLight && cfg.hemi != null) o.intensity = cfg.hemi;
        if (cfg.noShadow && o.isDirectionalLight) o.castShadow = false;
        if (o.isDirectionalLight && !o.castShadow && cfg.fill != null) o.intensity = cfg.fill;
      });
      if (cfg.bloomThreshold != null) {
        const b = g.engine.composer.passes.find((p) => 'threshold' in p && 'strength' in p);
        if (b) b.threshold = cfg.bloomThreshold;
      }
    }, s);
    await page.evaluate((p, l) => window.game.debug.setCamera(p, l, null), v.pos, v.look);
    await new Promise((r) => setTimeout(r, 900));
    await page.screenshot({ path: `/tmp/r7/sweep_${s.tag}_${v.name}.jpg`, type: 'jpeg', quality: 80 });
    console.log(`CAPTURED sweep_${s.tag}_${v.name}`);
    await page.close();
  }
}
await browser.close();
