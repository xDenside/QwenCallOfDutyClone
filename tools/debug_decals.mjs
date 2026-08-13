import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ headless: true, args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=metal', '--window-size=1280,720'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://localhost:4173/', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__GAME_READY__ === true', { timeout: 45000 });
await page.evaluate(() => {
  window.game.debug.allowPausedUpdate = true;
  document.getElementById('overlay').classList.add('hidden');
  const d = window.game.fx.decals;
  // giant test decal dead-center on the south wall
  d.spawn(
    { x: -14, y: 1.7, z: -15.59, isVector3: true, clone() { return this; }, normalize() { return this; }, lengthSq() { return 1; }, set() { return this; } },
    { x: 0, y: 0, z: 1, normalize() { return this; }, lengthSq() { return 1; } },
    2.0, 0, 1, true
  );
  window.game.debug.setCamera([-14, 1.7, -10], [-14, 1.7, -15.6], null);
});
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: '/tmp/r5/decal_test.jpg', type: 'jpeg', quality: 80 });
const info = await page.evaluate(() => {
  const d = window.game.fx.decals;
  return {
    instanceCount: d.geometry.instanceCount,
    idx: d.writeIdx,
    alphaLast: d.aAlpha[d.writeIdx - 1],
    sizeLast: d.aSize[d.writeIdx - 1],
    posLast: Array.from(d.aPos.slice((d.writeIdx - 1) * 3, d.writeIdx * 3)),
    quatLast: Array.from(d.aQuat.slice((d.writeIdx - 1) * 4, d.writeIdx * 4)),
    meshVisible: d.mesh.visible,
    frustumCulled: d.mesh.frustumCulled,
  };
});
console.log(JSON.stringify(info));
console.log('CONSOLE:', logs.filter((l) => /error|warn/i.test(l)).slice(0, 20).join('\n') || '(no errors/warnings)');
await browser.close();
