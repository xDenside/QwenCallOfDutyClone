#!/usr/bin/env node
// Headless screenshot harness for the critique loop.
// Usage: node tools/capture.mjs --name shot1 --pos 0,2,30 --look 0,1.5,0 [--fov 60]
//        [--eval "..."] (repeatable) [--wait ms] [--out dir] [--url http://localhost:4173/]
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const argv = process.argv.slice(2);
function get(flag, dflt) { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : dflt; }
function getAll(flag) {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === flag) out.push(argv[++i]);
  return out;
}
const parse3 = (s) => s.split(',').map(Number);

const url = get('--url', 'http://localhost:4173/');
const name = get('--name', 'shot');
const outDir = get('--out', 'shots');
const wait = Number(get('--wait', '1500'));
const pos = get('--pos', null);
const look = get('--look', null);
const fov = get('--fov', null);
const evals = getAll('--eval');

let browser;
try {
  browser = await puppeteer.launch({
    headless: true,
    args: [
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
      '--use-angle=metal',
      '--window-size=1920,1080'
    ]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });

  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__GAME_READY__ === true', { timeout: 45000 });
  await page.evaluate(() => {
    window.game.debug.allowPausedUpdate = true;
    document.getElementById('overlay').classList.add('hidden');
    if (window.game.audio && window.game.audio.forceUnlock) window.game.audio.forceUnlock();
  });

  for (const src of evals) {
    await page.evaluate(async (s) => { await (async () => { return eval(s); })(); }, src);
    await new Promise((r) => setTimeout(r, 250));
  }

  if (pos && look) {
    await page.evaluate((p, l, f) => window.game.debug.setCamera(p, l, f ? Number(f) : null),
      parse3(pos), parse3(look), fov);
  }

  await new Promise((r) => setTimeout(r, wait));
  mkdirSync(outDir, { recursive: true });
  const path = `${outDir}/${name}.png`;
  await page.screenshot({ path, type: 'png' });
  console.log(`CAPTURED ${path}`);
} catch (e) {
  console.error('CAPTURE FAILED:', e.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
