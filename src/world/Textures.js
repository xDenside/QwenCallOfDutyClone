// Procedural PBR texture sets, painted on offscreen canvases (<=1024^2).
// Every albedo has matching roughness variation + a normal map where it helps.
import * as THREE from 'three';
import { makeValueNoiseTiled, mulberry32, clamp, smoothstep } from './Noise.js';

// Noise sampled in UV space with integer frequencies => seamless texture tiles.
function makeTValue(seed) {
  const n = makeValueNoiseTiled(seed);
  return (u, v, fx, fy = fx) => n(u * fx, v * fy, fx | 0, fy | 0);
}
function makeTFbm(seed, octaves = 4) {
  const n = makeValueNoiseTiled(seed);
  return (u, v, fx, fy = fx) => {
    let amp = 0.5, frx = fx | 0, fry = fy | 0, sum = 0, tot = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * n(u * frx, v * fry, frx, fry);
      tot += amp; amp *= 0.5; frx *= 2; fry *= 2;
    }
    return sum / tot;
  };
}

function cnv(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/**
 * Run a per-pixel pass producing albedo / height / roughness ImageData in one loop.
 * fn(u, v, out) with u,v in [0,1); out = { r, g, b, h (0..1 height), rough (0..255) }.
 */
function pixelPass(size, fn) {
  const alb = new ImageData(size, size);
  const hgt = new Float32Array(size * size);
  const rgh = new ImageData(size, size);
  const out = { r: 128, g: 128, b: 128, h: 0.5, rough: 200 };
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      out.r = 128; out.g = 128; out.b = 128; out.h = 0.5; out.rough = 200;
      fn(u, v, out);
      const i = (y * size + x);
      const j = i * 4;
      alb.data[j] = clamp(out.r, 0, 255);
      alb.data[j + 1] = clamp(out.g, 0, 255);
      alb.data[j + 2] = clamp(out.b, 0, 255);
      alb.data[j + 3] = 255;
      hgt[i] = clamp(out.h, 0, 1);
      const ro = clamp(out.rough, 8, 255);
      rgh.data[j] = ro; rgh.data[j + 1] = ro; rgh.data[j + 2] = ro; rgh.data[j + 3] = 255;
    }
  }
  return { alb, hgt, rgh };
}

/** Sobel height -> tangent-space normal map canvas. */
function heightToNormal(hgt, size, strength) {
  const c = cnv(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const at = (x, y) => hgt[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const j = (y * size + x) * 4;
      img.data[j] = clamp(128 - dx * inv * 127, 0, 255);
      img.data[j + 1] = clamp(128 + dy * inv * 127, 0, 255); // flip for OpenGL-style tangent space
      img.data[j + 2] = clamp(inv * 255, 0, 255);
      img.data[j + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function tex(canvas, renderer, { srgb = false, repeat = true, aniso = 1 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = Math.min(aniso, renderer.capabilities.getMaxAnisotropy());
  return t;
}

function put(ctx, img) { ctx.putImageData(img, 0, 0); }

function buildSet(renderer, size, fn, opts = {}) {
  const { alb, hgt, rgh } = pixelPass(size, fn);
  const cA = cnv(size, size); put(cA.getContext('2d'), alb);
  const cR = cnv(size, size); put(cR.getContext('2d'), rgh);
  const cN = heightToNormal(hgt, size, opts.normalStrength ?? 2.2);
  const aniso = opts.aniso ?? 4;
  return {
    map: tex(cA, renderer, { srgb: true, aniso }),
    roughnessMap: tex(cR, renderer, { aniso }),
    normalMap: tex(cN, renderer, { aniso }),
    height: hgt, size
  };
}

// ---------------------------------------------------------------------------
// Individual surface families
// ---------------------------------------------------------------------------

function genConcrete(renderer) {
  const size = 1024;
  const fbm = makeTFbm(11, 4);
  const hi = makeTValue(29);
  const rnd = mulberry32(77);
  // per-column drip streak strengths (tileable: columns 0 and size-1 are neighbors,
  // each column is independent so the wrap introduces no visible seam)
  const drip = new Float32Array(size);
  for (let x = 0; x < size; x++) drip[x] = rnd() < 0.055 ? 0.35 + rnd() * 0.65 : 0;
  const seam = 128; // px between pour seams (divides 1024 -> seamless)

  const set = buildSet(renderer, size, (u, v, o) => {
    const px = u * size, py = v * size;
    const big = fbm(u, v, 9);
    const band = fbm(u + 0.13, v + 0.5, 2);
    const stain = fbm(u + 0.77, v + 0.31, 3);
    const vstreak = smoothstep(0.55, 0.85, fbm(u + 0.42, v, 3, 24));
    let r = 176, g = 168, b = 150;
    const shade = (big - 0.5) * 18 + (band - 0.5) * 44;
    r += shade; g += shade * 0.97; b += shade * 0.9;
    // sun-bleached warm patches
    if (big > 0.66) { r += 7; g += 5; b += 1; }
    // brown water staining + vertical weather streaks
    const st = smoothstep(0.58, 0.85, stain);
    r -= st * 46; g -= st * 42; b -= st * 34;
    r -= vstreak * 26; g -= vstreak * 24; b -= vstreak * 20;
    // pores
    const pore = hi(u, v, 220);
    let h = 0.5 + (big - 0.5) * 0.12;
    if (pore > 0.93) { r -= 26; g -= 26; b -= 24; h -= 0.22; }
    else if (pore < 0.05) { r += 8; g += 8; b += 8; }
    // hairline shrinkage cracks in weathered patches
    const crM = smoothstep(0.6, 0.85, fbm(u + 0.24, v + 0.62, 3));
    const crW = 0.0035 + 0.004 * crM;
    const crN = Math.abs(hi(u + 0.5, v + 0.25, 42) - 0.5);
    if (crN < crW) {
      const k = 1 - crN / crW;
      r -= 30 * k; g -= 30 * k; b -= 28 * k; h -= 0.22 * k;
    }
    // pour seams + drips below them
    const sy = py % seam;
    if (sy < 3) { r -= 42; g -= 42; b -= 40; h -= 0.3; }
    else if (sy > 3 && drip[(px | 0)] > 0) {
      const len = 26 + drip[(px | 0)] * 90;
      if (sy < len) {
        const k = (1 - sy / len) * drip[(px | 0)] * 0.5 * smoothstep(0.62, 0.5, stain);
        r -= k * 55; g -= k * 52; b -= k * 40;
      }
    }
    o.r = r; o.g = g; o.b = b; o.h = h;
    o.rough = 196 + st * 34 + (hi(u, v, 40) - 0.5) * 36 - (big > 0.62 ? 14 : 0);
  }, { normalStrength: 2.0, aniso: 8 });
  return set;
}

function genTin(renderer) {
  const size = 1024;
  const fbm = makeTFbm(41, 4);
  const dust = makeTFbm(53, 3);
  const corr = 16; // corrugations per tile (integer -> seamless)
  const set = buildSet(renderer, size, (u, v, o) => {
    const wave = Math.cos(u * corr * Math.PI * 2);
    const lit = 0.78 + 0.22 * wave;
    let r = 118 * lit, g = 116 * lit, b = 86 * lit;
    const grunge = fbm(u, v, 7);
    // olive drab paint variation
    r += (grunge - 0.5) * 26; g += (grunge - 0.5) * 24; b += (grunge - 0.5) * 14;
    let h = 0.5 + wave * 0.34;
    let rough = 148 + (grunge - 0.5) * 50;
    // rust, stronger toward sheet bottoms and where paint fails
    const rustSeed = fbm(u + 0.33, v + 0.71, 10);
    const rustBias = smoothstep(0.55, 1, v) * 0.1;
    const rust = smoothstep(0.66, 0.84, rustSeed + rustBias);
    if (rust > 0) {
      r = r + (110 - r) * rust; g = g + (80 - g) * rust; b = b + (54 - b) * rust;
      h -= rust * 0.2;
      rough += rust * 80;
    }
    // bright scratches down to bare metal (vertical streaks)
    const scratch = fbm(u, v, 90, 6);
    if (scratch > 0.74 && Math.abs(Math.sin(v * Math.PI * 2 * 57)) > 0.75) {
      r += 46; g += 46; b += 40; rough -= 55;
    }
    // dust film on upward-facing profile ridges
    const d = dust(u + 0.9, v, 4);
    if (wave > 0.55 && d > 0.52) {
      const k = (d - 0.52) * 1.4;
      r += k * 52; g += k * 44; b += k * 30; rough += k * 40;
    }
    // shallow dents from impacts
    const dent = fbm(u + 0.62, v + 0.35, 5);
    if (dent > 0.72) { h -= (dent - 0.72) * 0.5; r -= 8; g -= 8; b -= 6; }
    // sheet laps + bolt rows
    const by = v % 0.25;
    if (by < 0.012 || by > 0.238) { r -= 18; g -= 18; b -= 14; h += 0.12; }
    const bx = u % 0.125;
    if ((by < 0.03 || by > 0.22) && Math.min(bx, 0.125 - bx) < 0.008) {
      r += 30; g += 30; b += 26; h += 0.2; rough -= 30;
    }
    o.r = r; o.g = g; o.b = b; o.h = h; o.rough = rough;
  }, { normalStrength: 3.4, aniso: 4 });
  return set;
}

function genDirt(renderer) {
  const size = 1024;
  const fbm = makeTFbm(101, 4);
  const gravel = makeTValue(211);
  const fine = makeTValue(307);
  const patch = makeTFbm(431, 3);
  const set = buildSet(renderer, size, (u, v, o) => {
    const big = fbm(u, v, 4);
    const mid = fbm(u + 0.35, v, 14);
    let r = 150, g = 128, b = 97;
    const shade = (big - 0.5) * 58 + (mid - 0.5) * 26;
    r += shade; g += shade * 0.94; b += shade * 0.85;
    let h = 0.5 + (big - 0.5) * 0.3;
    // gravel speckle — fine, never sparkly
    const gr = gravel(u, v, 340);
    if (gr > 0.9) { r += 16; g += 14; b += 11; h += 0.08; }
    else if (gr < 0.07) { r -= 24; g -= 22; b -= 19; h -= 0.1; }
    // hairline desiccation cracks, broken up by a patch mask so no
    // continuous contour net ever reads at world scale
    const mask = smoothstep(0.44, 0.66, patch(u + 0.61, v + 0.17, 3));
    const ck = Math.abs(fine(u, v, 96) - 0.5);
    const cw = (0.008 + 0.005 * mid) * mask;
    if (mask > 0.05 && ck < cw) {
      const k = 1 - ck / cw;
      r -= 15 * k; g -= 14 * k; b -= 11 * k; h -= 0.09 * k;
    }
    // clustered pebbles: small proud stones in patches
    const cl = smoothstep(0.62, 0.8, patch(u + 0.2, v + 0.5, 5));
    const st = gravel(u + 0.5, v + 0.5, 140);
    if (cl > 0 && st > 0.72) {
      const k = Math.min(1, (st - 0.72) * 3.5) * cl;
      r += k * 22; g += k * 20; b += k * 16; h += k * 0.16;
    }
    // scuffed dark trails
    const scuff = smoothstep(0.7, 0.9, fbm(u + 0.8, v + 0.15, 3, 14));
    r -= scuff * 18; g -= scuff * 16; b -= scuff * 13;
    o.r = r; o.g = g; o.b = b; o.h = h;
    o.rough = 226 + (fine(u, v, 22) - 0.5) * 40 - (gr > 0.9 ? 12 : 0);
  }, { normalStrength: 0.9, aniso: 8 });
  return set;
}

function genPlanks(renderer) {
  const size = 1024;
  const fbm = makeTFbm(401, 4);
  const grain = makeTValue(501);
  const rows = 6;
  const rowTint = mulberry32(555);
  const tints = Array.from({ length: rows }, () => (rowTint() - 0.5) * 30);
  const joints = Array.from({ length: rows }, () => 0.15 + rowTint() * 0.7);
  const knots = Array.from({ length: rows }, () => [0.1 + rowTint() * 0.8, rowTint()]);
  const set = buildSet(renderer, size, (u, v, o) => {
    const row = Math.floor(v * rows);
    const lv = v * rows - row;
    const tint = tints[row];
    // stretched grain streaks along u
    const g1 = fbm(u + row * 5.77, v, 3, 46);
    const g2 = grain(u + row * 0.96, v, 8, 160);
    const g3 = grain(u + row * 1.31, v, 3, 320); // fine splinter pass
    let r = 141 + tint, g = 110 + tint * 0.8, b = 74 + tint * 0.5;
    const streak = smoothstep(0.42, 0.3, g1) * 26 + smoothstep(0.8, 0.95, g2) * 12 +
      smoothstep(0.86, 0.97, g3) * 8;
    r -= streak; g -= streak * 1.05; b -= streak * 0.9;
    let h = 0.55 + (g1 - 0.5) * 0.1;
    let rough = 208 + (g2 - 0.5) * 30;
    // knot: concentric dark grain around a core
    const [kx, kr] = knots[row];
    const kd = Math.hypot((u - kx) * 2.2, (lv - (0.3 + kr * 0.4)) * 1.4);
    if (kd < 0.16) {
      const ring = Math.sin(kd * 90) * 0.5 + 0.5;
      const k = 1 - kd / 0.16;
      r -= 34 * k + ring * 10 * k; g -= 30 * k + ring * 9 * k; b -= 24 * k + ring * 7 * k;
      h -= 0.16 * k; rough += 12 * k;
    }
    // butt joint where two boards meet end-to-end
    if (Math.abs(u - joints[row]) < 0.006) { r -= 70; g -= 66; b -= 58; h -= 0.4; rough += 20; }
    // plank gaps
    if (lv < 0.028 || lv > 0.972) { r -= 74; g -= 72; b -= 62; h -= 0.42; rough += 20; }
    // sun bleaching / dust on upper half
    const dustK = smoothstep(0.4, 0, lv) * 0.14;
    r += dustK * 60; g += dustK * 52; b += dustK * 38;
    o.r = r; o.g = g; o.b = b; o.h = h; o.rough = rough;
  }, { normalStrength: 2.4, aniso: 4 });
  return set;
}

function genCrate(renderer) {
  const size = 512;
  const fbm = makeTFbm(601, 4);
  const grain = makeTValue(701);
  const rnd = mulberry32(901);
  const nails = [];
  for (let i = 0; i < 14; i++) nails.push([0.05 + rnd() * 0.9, 0.05 + rnd() * 0.9]);
  const set = buildSet(renderer, size, (u, v, o) => {
    const g1 = fbm(u, v, 3, 34);
    const g2 = grain(u, v, 9, 120);
    let r = 132, g = 106, b = 70;
    const streak = smoothstep(0.4, 0.28, g1) * 24;
    r -= streak; g -= streak; b -= streak * 0.8;
    r += (g2 - 0.5) * 16; g += (g2 - 0.5) * 14; b += (g2 - 0.5) * 10;
    let h = 0.55 + (g1 - 0.5) * 0.12;
    let rough = 210;
    // frame battens: vertical at edges + horizontal mid band
    const bat = u < 0.1 || u > 0.9 || Math.abs(v - 0.5) < 0.07;
    if (bat) { r -= 26; g -= 24; b -= 18; h += 0.2; }
    // stencil ghosting (dark worn paint block)
    if (u > 0.28 && u < 0.72 && v > 0.3 && v < 0.42) {
      const wob = grain(u, v, 60);
      if (wob > 0.35) { r -= 34; g -= 30; b -= 22; rough += 14; }
    }
    // nail heads
    for (const [nx, ny] of nails) {
      const d = Math.hypot(u - nx, v - ny);
      if (d < 0.011) { r = 52; g = 50; b = 48; h -= 0.2; rough = 140; }
    }
    // edge wear brightening
    const edge = Math.min(u, 1 - u, v, 1 - v);
    if (edge < 0.02) { r += 30; g += 26; b += 20; }
    o.r = r; o.g = g; o.b = b; o.h = h; o.rough = rough;
  }, { normalStrength: 2.6, aniso: 4 });
  return set;
}

function genSandbag(renderer) {
  const size = 512;
  const fbm = makeTFbm(801, 4);
  const set = buildSet(renderer, size, (u, v, o) => {
    const weaveU = Math.sin(u * Math.PI * 2 * 44);
    const weaveV = Math.sin(v * Math.PI * 2 * 44);
    const w = weaveU * weaveV;
    let r = 172, g = 156, b = 120;
    const blotch = fbm(u + 0.2, v, 3);
    r += (blotch - 0.5) * 52; g += (blotch - 0.5) * 46; b += (blotch - 0.5) * 34;
    r += w * 22; g += w * 20; b += w * 15;
    // dirt staining on lower courses
    const dirt = smoothstep(0.5, 1, v) * fbm(u, v, 6) * 0.6;
    r -= dirt * 70; g -= dirt * 66; b -= dirt * 52;
    o.r = r; o.g = g; o.b = b;
    o.h = 0.5 + w * 0.5 + (fbm(u, v, 20) - 0.5) * 0.14;
    o.rough = 236 + w * 8 - dirt * 20;
  }, { normalStrength: 3.0, aniso: 2 });
  return set;
}

function genRubber(renderer) {
  const size = 512;
  const fbm = makeTFbm(950, 4);
  const crack = makeTValue(960);
  const set = buildSet(renderer, size, (u, v, o) => {
    const n = fbm(u, v, 6);
    let r = 34, g = 34, b = 37;
    r += (n - 0.5) * 16; g += (n - 0.5) * 16; b += (n - 0.5) * 16;
    let h = 0.5 + (n - 0.5) * 0.14;
    // cracking veins
    const c = Math.abs(crack(u, v, 26) - 0.5);
    if (c < 0.011) { r += 20; g += 20; b += 22; h -= 0.24; }
    // grey scuffing
    const scuff = fbm(u + 0.4, v, 15);
    if (scuff > 0.66) { r += 26; g += 26; b += 26; }
    o.r = r; o.g = g; o.b = b; o.h = h;
    o.rough = 232 + (crack(u, v, 12) - 0.5) * 20;
  }, { normalStrength: 2.2, aniso: 2 });
  return set;
}

function genPaintedMetal(renderer) {
  const size = 1024;
  const fbm = makeTFbm(1100, 4);
  const scratch = makeTValue(1200);
  const set = buildSet(renderer, size, (u, v, o) => {
    const n = fbm(u, v, 6);
    let r = 94, g = 98, b = 72; // olive drab
    r += (n - 0.5) * 30; g += (n - 0.5) * 30; b += (n - 0.5) * 22;
    let h = 0.5 + (n - 0.5) * 0.1;
    let rough = 158 + (n - 0.5) * 40;
    // rust bloom
    const rust = smoothstep(0.62, 0.8, fbm(u + 0.7, v, 10));
    if (rust > 0) {
      r += (122 - r) * rust; g += (66 - g) * rust; b += (38 - b) * rust;
      rough += rust * 70; h -= rust * 0.16;
    }
    // scratches to bright metal
    const s = scratch(u, v, 70, 8);
    if (s > 0.78 && scratch(u, v, 9, 70) > 0.55) {
      r += 52; g += 52; b += 46; rough -= 60;
    }
    // panel seams with rivet rows + edge wear along them
    const sy = v % 0.25, sx = u % 0.5;
    const dy = Math.min(sy, 0.25 - sy), dx = Math.min(sx, 0.5 - sx);
    if (dy < 0.006 || dx < 0.004) { r -= 30; g -= 30; b -= 26; h -= 0.25; rough += 24; }
    else if (dy < 0.014 && (u * 32) % 1 < 0.07) { r += 40; g += 40; b += 36; h += 0.25; rough -= 40; }
    else if (dy < 0.024 || dx < 0.018) {
      const w = smoothstep(0.6, 0.9, scratch(u, v, 40));
      r += w * 26; g += w * 26; b += w * 22;
    }
    // dust settling on lower band
    const dustK = smoothstep(0.72, 1, v) * 0.5;
    r += dustK * 60; g += dustK * 50; b += dustK * 34; rough += dustK * 50;
    o.r = r; o.g = g; o.b = b; o.h = h; o.rough = rough;
  }, { normalStrength: 1.8, aniso: 4 });
  return set;
}

function genStucco(renderer) {
  const size = 1024;
  const fbm = makeTFbm(1301, 4);
  const fine = makeTValue(1401);
  const crack = makeTValue(1501);
  const rnd = mulberry32(1601);
  // per-column drip streak strengths (tileable, see genConcrete)
  const drip = new Float32Array(size);
  for (let x = 0; x < size; x++) drip[x] = rnd() < 0.05 ? 0.3 + rnd() * 0.7 : 0;
  const set = buildSet(renderer, size, (u, v, o) => {
    const px = u * size, py = v * size;
    const big = fbm(u, v, 8);
    const blotch = fbm(u + 0.31, v + 0.7, 3);
    const grain = fine(u, v, 300);
    let r = 198, g = 188, b = 168;
    const shade = (big - 0.5) * 22 + (blotch - 0.5) * 30;
    r += shade; g += shade * 0.97; b += shade * 0.9;
    // grime pooling in patches
    const grime = smoothstep(0.6, 0.85, fbm(u + 0.77, v + 0.13, 4));
    r -= grime * 40; g -= grime * 38; b -= grime * 30;
    // vertical weather drips
    const sy = py % 256;
    if (sy > 4 && drip[px | 0] > 0) {
      const len = 40 + drip[px | 0] * 140;
      if (sy < len) {
        const k = (1 - sy / len) * drip[px | 0] * 0.45;
        r -= k * 46; g -= k * 44; b -= k * 36;
      }
    }
    let h = 0.5 + (big - 0.5) * 0.1 + (grain - 0.5) * 0.06;
    // hairline cracks in weathered patches
    const cmk = smoothstep(0.5, 0.75, fbm(u + 0.12, v + 0.44, 3));
    const cw = 0.0015 + 0.006 * cmk;
    const ck = Math.abs(crack(u, v, 60) - 0.5);
    if (ck < cw) {
      const k = 1 - ck / cw;
      r -= 34 * k; g -= 33 * k; b -= 30 * k; h -= 0.25 * k;
    }
    // sand grain pits
    if (grain > 0.94) { r -= 14; g -= 14; b -= 12; h -= 0.12; }
    o.r = r; o.g = g; o.b = b; o.h = h;
    o.rough = 208 + (grain - 0.5) * 30 + grime * 26;
  }, { normalStrength: 1.6, aniso: 8 });
  return set;
}

function genBrick(renderer) {
  const size = 1024;
  const fbm = makeTFbm(1701, 4);
  const fine = makeTValue(1801);
  const rnd = mulberry32(1901);
  const rows = 16, cols = 8; // running bond, tile = ~2.2 m of wall
  const tints = [];
  for (let i = 0; i < rows * cols; i++) tints.push((rnd() - 0.5) * 46);
  const set = buildSet(renderer, size, (u, v, o) => {
    const row = Math.floor(v * rows);
    const off = (row % 2) * 0.5 / cols;
    const cu = (u + off) % 1;
    const col = Math.floor(cu * cols);
    const lv = v * rows - row;
    const lu = cu * cols - col;
    const soot = smoothstep(0.55, 0.85, fbm(u + 0.4, v + 0.2, 4));
    const sp = fine(u, v, 200);
    if (lv < 0.09 || lv > 0.91 || lu < 0.06 || lu > 0.94) {
      // mortar joint: pale, gritty, recessed
      let r = 168 - soot * 60, g = 160 - soot * 58, b = 146 - soot * 50;
      r += (sp - 0.5) * 24; g += (sp - 0.5) * 22; b += (sp - 0.5) * 18;
      o.r = r; o.g = g; o.b = b;
      o.h = 0.32; o.rough = 230;
      return;
    }
    const tint = tints[row * cols + col];
    let r = 146 + tint, g = 96 + tint * 0.72, b = 74 + tint * 0.5;
    const n = fbm(u, v, 24);
    r += (n - 0.5) * 26; g += (n - 0.5) * 22; b += (n - 0.5) * 18;
    r -= soot * 46; g -= soot * 42; b -= soot * 36;
    let h = 0.55 + (n - 0.5) * 0.1;
    // chipped corners down to pale clay
    const edge = Math.min(lu, 1 - lu, lv, 1 - lv);
    if (edge < 0.05 && sp > 0.8) { r += 26; g += 24; b += 20; h = 0.42; }
    o.r = r; o.g = g; o.b = b; o.h = h;
    o.rough = 200 + soot * 30;
  }, { normalStrength: 2.6, aniso: 8 });
  return set;
}

// ---------------------------------------------------------------------------
// Decals: tire tracks + wet patches + baked AO gradients (one big overlay)
// ---------------------------------------------------------------------------
function genGroundDecal() {
  const size = 1024;
  const c = cnv(size, size);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  // world span: -70..70 m -> 0..size px  (7.31 px per m)
  const px = (m) => ((m + 70) / 140) * size;
  const pm = 7.314; // px per meter

  const rnd = mulberry32(1234);

  // --- wet dark patches (blotchy, soft) ---
  const wet = [
    [-16, -24, 7], [9, -18, 5], [-4, 12, 6], [18, 22, 4.5], [-26, -2, 5],
    [2, 34, 4], [-12, 44, 5], [26, 6, 4], [-38, 14, 4.5], [12, -32, 5]
  ];
  for (const [wx, wz, wr] of wet) {
    for (let i = 0; i < 4; i++) {
      const ox = px(wx + (rnd() - 0.5) * wr), oy = px(wz + (rnd() - 0.5) * wr);
      const rad = wr * pm * (0.4 + rnd() * 0.5);
      const g = ctx.createRadialGradient(ox, oy, 0, ox, oy, rad);
      g.addColorStop(0, 'rgba(38,30,22,0.34)');
      g.addColorStop(1, 'rgba(38,30,22,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(ox, oy, rad, 0, Math.PI * 2); ctx.fill();
    }
  }

  // --- oil / scorch stains under wrecks, pumps, barrels, the breach ---
  const stain = (sx, sz, sr, col, a) => {
    for (let i = 0; i < 5; i++) {
      const ox = px(sx + (rnd() - 0.5) * sr), oy = px(sz + (rnd() - 0.5) * sr);
      const rad = sr * pm * (0.3 + rnd() * 0.45);
      const g = ctx.createRadialGradient(ox, oy, 0, ox, oy, rad);
      g.addColorStop(0, `rgba(${col},${a})`);
      g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(ox, oy, rad, 0, Math.PI * 2); ctx.fill();
    }
  };
  stain(10, 30, 3.2, '20,16,12', 0.5);     // truck wreck
  stain(5.5, 30, 2.6, '16,12,9', 0.55);    // burnt sedan
  stain(45.5, 28.5, 2.2, '22,18,14', 0.4); // fuel pumps
  stain(-31, 12, 1.8, '24,20,14', 0.35);   // barrel cluster
  stain(0, 52, 3.5, '26,22,16', 0.42);     // breach scorch
  stain(26.8, -4.5, 1.4, '20,16,12', 0.4); // generator
  stain(43, 21, 1.4, '20,16,12', 0.4);     // generator

  // --- tire tracks (pair of ruts with tread marks) ---
  function trackPair(path, alpha) {
    // path: array of [x,z] control points; two ruts offset ±0.8m perpendicular
    for (const side of [-0.8, 0.8]) {
      ctx.beginPath();
      for (let i = 0; i < path.length; i++) {
        const [x, z] = path[i];
        const [nx, nz] = path[Math.min(i + 1, path.length - 1)];
        const [px2, pz2] = path[Math.max(i - 1, 0)];
        let dx = nx - px2, dz = nz - pz2;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len; dz /= len;
        const ox = x + -dz * side, oz = z + dx * side;
        if (i === 0) ctx.moveTo(px(ox), px(oz));
        else ctx.lineTo(px(ox), px(oz));
      }
      ctx.strokeStyle = `rgba(52,42,30,${alpha})`;
      ctx.lineWidth = 0.36 * pm;
      ctx.lineCap = 'round';
      ctx.stroke();
      // darker center depression
      ctx.strokeStyle = `rgba(40,32,22,${alpha * 0.7})`;
      ctx.lineWidth = 0.16 * pm;
      ctx.stroke();
    }
    // tread cross-bars along the path
    ctx.strokeStyle = `rgba(30,24,16,${alpha * 0.5})`;
    ctx.lineWidth = 0.06 * pm;
    for (let i = 0; i < path.length - 1; i++) {
      const [x, z] = path[i];
      const [nx, nz] = path[i + 1];
      let dx = nx - x, dz = nz - z;
      const segLen = Math.hypot(dx, dz);
      const steps = Math.max(1, Math.floor(segLen / 0.5));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const cx = x + dx * t, cz = z + dz * t;
        const len = Math.hypot(dx, dz) || 1;
        const pxn = -dz / len, pzn = dx / len;
        for (const side of [-0.8, 0.8]) {
          ctx.beginPath();
          ctx.moveTo(px(cx + pxn * (side - 0.16)), px(cz + pzn * (side - 0.16)));
          ctx.lineTo(px(cx + pxn * (side + 0.16)), px(cz + pzn * (side + 0.16)));
          ctx.stroke();
        }
      }
    }
  }
  // gate -> courtyard -> truck; gate -> shed; a loop inside
  trackPair([[0, 70], [0.6, 58], [-0.8, 46], [1.2, 36], [6, 31], [10, 30]], 0.5);
  trackPair([[0, 66], [-3, 52], [-8, 40], [-18, 28], [-30, 20], [-36, 15]], 0.42);
  trackPair([[6, 31], [10, 22], [6, 10], [-2, 2], [-10, -6], [-14, -13]], 0.36);

  // --- baked AO: dark gradients hugging wall bases (inside faces) ---
  function aoRect(x0, z0, x1, z1, inset) {
    // fill soft dark frame around a rect footprint
    const g0 = 'rgba(0,0,0,0)';
    const g1 = 'rgba(0,0,0,0.42)';
    const X0 = px(x0), Z0 = px(z0), X1 = px(x1), Z1 = px(z1), I = inset * pm;
    // top edge
    let g = ctx.createLinearGradient(0, Z0, 0, Z0 + I);
    g.addColorStop(0, g1); g.addColorStop(1, g0);
    ctx.fillStyle = g; ctx.fillRect(X0, Z0, X1 - X0, I);
    // bottom edge
    g = ctx.createLinearGradient(0, Z1, 0, Z1 - I);
    g.addColorStop(0, g1); g.addColorStop(1, g0);
    ctx.fillStyle = g; ctx.fillRect(X0, Z1 - I, X1 - X0, I);
    // left edge
    g = ctx.createLinearGradient(X0, 0, X0 + I, 0);
    g.addColorStop(0, g1); g.addColorStop(1, g0);
    ctx.fillStyle = g; ctx.fillRect(X0, Z0, I, Z1 - Z0);
    // right edge
    g = ctx.createLinearGradient(X1, 0, X1 - I, 0);
    g.addColorStop(0, g1); g.addColorStop(1, g0);
    ctx.fillStyle = g; ctx.fillRect(X1 - I, Z0, I, Z1 - Z0);
  }
  // perimeter walls (inner faces)
  aoRect(-52, -52, 52, -50.4, 2.0);
  aoRect(-52, 50.4, 52, 52, 2.0);
  aoRect(-52, -52, -50.4, 52, 2.0);
  aoRect(50.4, -52, 52, 52, 2.0);
  // main building footprint
  aoRect(-30, -40, -2, -16, 2.4);
  // shed, comms hut, watchtower legs
  aoRect(-42, 10, -32, 20, 1.6);
  aoRect(28, -8, 36, 0, 1.6);
  aoRect(35.6, 31.6, 40.4, 36.4, 1.4);
  // urban blocks (round-6 map pass)
  aoRect(26, -48, 48, -30, 2.4);
  aoRect(22, 6, 46, 24, 2.4);
  aoRect(-28, 26, -14, 42, 2.0);
  aoRect(-8, -36, 4, -24, 2.0);
  aoRect(12, 34, 26, 48, 2.0);
  aoRect(45, -18, 51, 6, 1.8);
  aoRect(44, 16, 50, 30, 1.6);
  aoRect(8, -50.5, 26, -44, 1.6);
  aoRect(3, 28, 8, 32, 1.2);      // gate-road sedan wreck
  aoRect(-8, 19, 9, 21.5, 0.8);   // broken low wall
  aoRect(11, 21, 18, 27, 1.6);    // container pair

  return c;
}

/** Soft radial contact-shadow sprite. */
function genAOSprite() {
  const size = 128;
  const c = cnv(size, size);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.5)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.28)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

/** Dry straw tuft card: tapered blades on transparent bg, alpha-tested. */
function genGrass() {
  const size = 256;
  const c = cnv(size, size);
  const ctx = c.getContext('2d');
  const rnd = mulberry32(4711);
  ctx.lineCap = 'round';
  const blade = (bx, len, lean, w0, col) => {
    const x0 = bx, y0 = size;
    const x1 = bx + lean * 0.3, y1 = size - len * 0.6;
    const x2 = bx + lean, y2 = size - len;
    const segs = 6;
    let px = x0, py = y0;
    ctx.strokeStyle = col;
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const mx = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * x1 + t * t * x2;
      const my = (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * y1 + t * t * y2;
      ctx.lineWidth = Math.max(0.8, w0 * (1 - t * 0.85));
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(mx, my);
      ctx.stroke();
      px = mx; py = my;
    }
  };
  for (let i = 0; i < 17; i++) {
    const hue = 42 + rnd() * 14;
    const sat = 26 + rnd() * 30;
    const lig = 42 + rnd() * 26;
    blade(size * (0.12 + rnd() * 0.76), size * (0.42 + rnd() * 0.5),
      (rnd() - 0.5) * size * 0.55, 2.2 + rnd() * 2.6, `hsla(${hue}, ${sat}%, ${lig}%, 1)`);
  }
  // short stubble at the base so the card doesn't read as floating spikes
  for (let i = 0; i < 10; i++) {
    blade(size * (0.1 + rnd() * 0.8), size * (0.14 + rnd() * 0.16),
      (rnd() - 0.5) * size * 0.2, 2 + rnd() * 2,
      `hsla(${40 + rnd() * 12}, ${22 + rnd() * 20}%, ${34 + rnd() * 18}%, 1)`);
  }
  return c;
}

/** Soft round particle sprite. */
function genParticleSprite() {
  const size = 32;
  const c = cnv(size, size);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,240,214,1)');
  g.addColorStop(0.4, 'rgba(255,240,214,0.55)');
  g.addColorStop(1, 'rgba(255,240,214,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

// ---------------------------------------------------------------------------

export function createMaterials(renderer) {
  const concrete = genConcrete(renderer);
  const tin = genTin(renderer);
  const dirt = genDirt(renderer);
  const planks = genPlanks(renderer);
  const crate = genCrate(renderer);
  const sandbag = genSandbag(renderer);
  const rubber = genRubber(renderer);
  const painted = genPaintedMetal(renderer);
  const stucco = genStucco(renderer);
  const brick = genBrick(renderer);

  const std = (set, extra = {}) => new THREE.MeshStandardMaterial(Object.assign({
    map: set.map, roughnessMap: set.roughnessMap, normalMap: set.normalMap,
    roughness: 1, metalness: 0
  }, extra));

  const M = {
    concrete: std(concrete, { normalScale: new THREE.Vector2(0.75, 0.75), vertexColors: true }),
    tin: std(tin, { metalness: 0.5, normalScale: new THREE.Vector2(1.5, 0.7), envMapIntensity: 2.0 }),
    dirt: std(dirt, { normalScale: new THREE.Vector2(0.55, 0.55), vertexColors: true }),
    rock: std(dirt, { normalScale: new THREE.Vector2(0.9, 0.9) }),
    planks: std(planks, { normalScale: new THREE.Vector2(0.9, 0.9) }),
    crate: std(crate, { normalScale: new THREE.Vector2(1.0, 1.0) }),
    sandbag: std(sandbag, { normalScale: new THREE.Vector2(1.1, 1.1) }),
    rubber: std(rubber, { normalScale: new THREE.Vector2(0.8, 0.8) }),
    painted: std(painted, { metalness: 0.42, normalScale: new THREE.Vector2(0.8, 0.8), vertexColors: true, envMapIntensity: 2.0 }),
    stucco: std(stucco, { normalScale: new THREE.Vector2(0.7, 0.7), vertexColors: true }),
    brick: std(brick, { normalScale: new THREE.Vector2(1.0, 1.0), vertexColors: true }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x46585c, transparent: true, opacity: 0.45, roughness: 0.2,
      metalness: 0.1, side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 2.0
    }),
    grass: new THREE.MeshStandardMaterial({
      map: tex(genGrass(), renderer, { srgb: true, repeat: false, aniso: 4 }),
      roughness: 0.96, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.42
    }),
    mountain: new THREE.MeshBasicMaterial({ vertexColors: true, fog: true }),
    skirt: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xc9a24a, metalness: 0.92, roughness: 0.32 }),
    decal: new THREE.MeshStandardMaterial({
      map: tex(genGroundDecal(), renderer, { srgb: true, repeat: false }),
      transparent: true, roughness: 1, metalness: 0, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    }),
    contactAO: new THREE.MeshBasicMaterial({
      map: tex(genAOSprite(), renderer, { srgb: false, repeat: false }),
      color: 0x000000, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    }),
    particle: new THREE.PointsMaterial({
      map: tex(genParticleSprite(), renderer, { repeat: false }),
      size: 0.028, transparent: true, opacity: 0.24, depthWrite: false,
      color: 0xd8b489, sizeAttenuation: true
    })
  };
  return M;
}
