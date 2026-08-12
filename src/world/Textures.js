// Procedural PBR texture sets, painted on offscreen canvases (<=1024^2).
// Every albedo has matching roughness variation + a normal map where it helps.
import * as THREE from 'three';
import { makeFbm, makeValueNoise, mulberry32, clamp, smoothstep } from './Noise.js';

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
  const fbm = makeFbm(11, 4);
  const hi = makeValueNoise(29);
  const rnd = mulberry32(77);
  // per-column drip streak strengths from every seam
  const drip = new Float32Array(size);
  for (let x = 0; x < size; x++) drip[x] = rnd() < 0.055 ? 0.35 + rnd() * 0.65 : 0;
  const seam = 170; // px between pour seams

  const set = buildSet(renderer, size, (u, v, o) => {
    const px = u * size, py = v * size;
    const big = fbm(u * 5.2, v * 5.2);
    const stain = fbm(u * 2.3 + 7.7, v * 2.6 + 3.1);
    let r = 178, g = 170, b = 152;
    const shade = (big - 0.5) * 34;
    r += shade; g += shade * 0.97; b += shade * 0.9;
    // sun-bleached warm patches
    if (big > 0.62) { r += 12; g += 8; b += 2; }
    // brown water staining
    const st = smoothstep(0.58, 0.85, stain);
    r -= st * 46; g -= st * 42; b -= st * 34;
    // pores
    const pore = hi(u * 220, v * 220);
    let h = 0.5 + (big - 0.5) * 0.12;
    if (pore > 0.93) { r -= 26; g -= 26; b -= 24; h -= 0.22; }
    else if (pore < 0.05) { r += 8; g += 8; b += 8; }
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
    o.rough = 196 + st * 34 + (hi(u * 40, v * 40) - 0.5) * 36 - (big > 0.62 ? 14 : 0);
  }, { normalStrength: 2.0, aniso: 8 });
  return set;
}

function genTin(renderer) {
  const size = 1024;
  const fbm = makeFbm(41, 4);
  const dust = makeFbm(53, 3);
  const corr = 26; // px per corrugation
  const set = buildSet(renderer, size, (u, v, o) => {
    const wave = Math.cos(u * size / corr * Math.PI * 2);
    const lit = 0.78 + 0.22 * wave;
    let r = 118 * lit, g = 116 * lit, b = 86 * lit;
    const grunge = fbm(u * 7, v * 7);
    // olive drab paint variation
    r += (grunge - 0.5) * 26; g += (grunge - 0.5) * 24; b += (grunge - 0.5) * 14;
    let h = 0.5 + wave * 0.34;
    let rough = 148 + (grunge - 0.5) * 50;
    // rust, stronger toward sheet bottoms and where paint fails
    const rustSeed = fbm(u * 9.5 + 3.3, v * 9.5);
    const rustBias = smoothstep(0.55, 1, v) * 0.16;
    const rust = smoothstep(0.60, 0.78, rustSeed + rustBias);
    if (rust > 0) {
      r = r + (128 - r) * rust; g = g + (70 - g) * rust; b = b + (38 - b) * rust;
      h -= rust * 0.2;
      rough += rust * 80;
    }
    // bright scratches down to bare metal
    const scratch = fbm(u * 90, v * 6);
    if (scratch > 0.74 && Math.abs(Math.sin(v * size * 0.7)) > 0.75) {
      r += 46; g += 46; b += 40; rough -= 55;
    }
    // dust film on upward-facing profile ridges
    const d = dust(u * 4 + 9, v * 4);
    if (wave > 0.55 && d > 0.52) {
      const k = (d - 0.52) * 1.4;
      r += k * 52; g += k * 44; b += k * 30; rough += k * 40;
    }
    o.r = r; o.g = g; o.b = b; o.h = h; o.rough = rough;
  }, { normalStrength: 3.4, aniso: 4 });
  return set;
}

function genDirt(renderer) {
  const size = 1024;
  const fbm = makeFbm(101, 4);
  const gravel = makeValueNoise(211);
  const fine = makeValueNoise(307);
  const set = buildSet(renderer, size, (u, v, o) => {
    const big = fbm(u * 4.1, v * 4.1);
    const mid = fbm(u * 14 + 5, v * 14);
    let r = 152, g = 131, b = 101;
    const shade = (big - 0.5) * 44 + (mid - 0.5) * 20;
    r += shade; g += shade * 0.94; b += shade * 0.85;
    let h = 0.5 + (big - 0.5) * 0.3;
    // gravel speckle
    const gr = gravel(u * 340, v * 340);
    if (gr > 0.9) { r += 34; g += 30; b += 24; h += 0.16; }
    else if (gr < 0.07) { r -= 30; g -= 28; b -= 22; h -= 0.14; }
    // hairline desiccation cracks
    const ck = Math.abs(fine(u * 46, v * 46) - 0.5);
    if (ck < 0.013) { r -= 34; g -= 32; b -= 26; h -= 0.3; }
    o.r = r; o.g = g; o.b = b; o.h = h;
    o.rough = 226 + (fine(u * 22, v * 22) - 0.5) * 40 - (gr > 0.9 ? 18 : 0);
  }, { normalStrength: 1.5, aniso: 8 });
  return set;
}

function genPlanks(renderer) {
  const size = 1024;
  const fbm = makeFbm(401, 4);
  const grain = makeValueNoise(501);
  const rows = 6;
  const set = buildSet(renderer, size, (u, v, o) => {
    const row = Math.floor(v * rows);
    const lv = v * rows - row;
    const tint = (grain(row * 13.7, 0.5) - 0.5) * 30;
    // stretched grain streaks along u
    const g1 = fbm(u * 3 + row * 17.3, v * 46);
    const g2 = grain(u * 8 + row * 7.7, v * 160);
    let r = 141 + tint, g = 110 + tint * 0.8, b = 74 + tint * 0.5;
    const streak = smoothstep(0.42, 0.3, g1) * 26 + smoothstep(0.8, 0.95, g2) * 12;
    r -= streak; g -= streak * 1.05; b -= streak * 0.9;
    let h = 0.55 + (g1 - 0.5) * 0.1;
    let rough = 208 + (g2 - 0.5) * 30;
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
  const fbm = makeFbm(601, 4);
  const grain = makeValueNoise(701);
  const rnd = mulberry32(901);
  const nails = [];
  for (let i = 0; i < 14; i++) nails.push([0.05 + rnd() * 0.9, 0.05 + rnd() * 0.9]);
  const set = buildSet(renderer, size, (u, v, o) => {
    const g1 = fbm(u * 3.2, v * 34);
    const g2 = grain(u * 9, v * 120);
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
      const wob = grain(u * 60, v * 60);
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
  const fbm = makeFbm(801, 4);
  const set = buildSet(renderer, size, (u, v, o) => {
    const weaveU = Math.sin(u * Math.PI * 2 * 44);
    const weaveV = Math.sin(v * Math.PI * 2 * 44);
    const w = weaveU * weaveV;
    let r = 179, g = 162, b = 124;
    const blotch = fbm(u * 3.4 + 2, v * 3.4);
    r += (blotch - 0.5) * 40; g += (blotch - 0.5) * 36; b += (blotch - 0.5) * 26;
    r += w * 12; g += w * 11; b += w * 8;
    // dirt staining on lower courses
    const dirt = smoothstep(0.5, 1, v) * fbm(u * 6, v * 6) * 0.6;
    r -= dirt * 60; g -= dirt * 56; b -= dirt * 44;
    o.r = r; o.g = g; o.b = b;
    o.h = 0.5 + w * 0.3 + (fbm(u * 20, v * 20) - 0.5) * 0.1;
    o.rough = 236 + w * 8 - dirt * 20;
  }, { normalStrength: 3.0, aniso: 2 });
  return set;
}

function genRubber(renderer) {
  const size = 512;
  const fbm = makeFbm(950, 4);
  const crack = makeValueNoise(960);
  const set = buildSet(renderer, size, (u, v, o) => {
    const n = fbm(u * 6, v * 6);
    let r = 34, g = 34, b = 37;
    r += (n - 0.5) * 16; g += (n - 0.5) * 16; b += (n - 0.5) * 16;
    let h = 0.5 + (n - 0.5) * 0.14;
    // cracking veins
    const c = Math.abs(crack(u * 26, v * 26) - 0.5);
    if (c < 0.011) { r += 20; g += 20; b += 22; h -= 0.24; }
    // grey scuffing
    const scuff = fbm(u * 15 + 4, v * 15);
    if (scuff > 0.66) { r += 26; g += 26; b += 26; }
    o.r = r; o.g = g; o.b = b; o.h = h;
    o.rough = 232 + (crack(u * 12, v * 12) - 0.5) * 20;
  }, { normalStrength: 2.2, aniso: 2 });
  return set;
}

function genPaintedMetal(renderer) {
  const size = 1024;
  const fbm = makeFbm(1100, 4);
  const scratch = makeValueNoise(1200);
  const set = buildSet(renderer, size, (u, v, o) => {
    const n = fbm(u * 6, v * 6);
    let r = 94, g = 98, b = 72; // olive drab
    r += (n - 0.5) * 30; g += (n - 0.5) * 30; b += (n - 0.5) * 22;
    let h = 0.5 + (n - 0.5) * 0.1;
    let rough = 158 + (n - 0.5) * 40;
    // rust bloom
    const rust = smoothstep(0.62, 0.8, fbm(u * 10 + 7, v * 10));
    if (rust > 0) {
      r += (122 - r) * rust; g += (66 - g) * rust; b += (38 - b) * rust;
      rough += rust * 70; h -= rust * 0.16;
    }
    // scratches to bright metal
    const s = scratch(u * 70, v * 8);
    if (s > 0.78 && scratch(u * 9, v * 70) > 0.55) {
      r += 52; g += 52; b += 46; rough -= 60;
    }
    // dust settling on lower band
    const dustK = smoothstep(0.72, 1, v) * 0.5;
    r += dustK * 60; g += dustK * 50; b += dustK * 34; rough += dustK * 50;
    o.r = r; o.g = g; o.b = b; o.h = h; o.rough = rough;
  }, { normalStrength: 1.8, aniso: 4 });
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

  const std = (set, extra = {}) => new THREE.MeshStandardMaterial(Object.assign({
    map: set.map, roughnessMap: set.roughnessMap, normalMap: set.normalMap,
    roughness: 1, metalness: 0
  }, extra));

  const M = {
    concrete: std(concrete, { normalScale: new THREE.Vector2(0.75, 0.75), vertexColors: true }),
    tin: std(tin, { metalness: 0.5, normalScale: new THREE.Vector2(1.5, 0.7) }),
    dirt: std(dirt, { normalScale: new THREE.Vector2(0.6, 0.6), vertexColors: true }),
    planks: std(planks, { normalScale: new THREE.Vector2(0.9, 0.9) }),
    crate: std(crate, { normalScale: new THREE.Vector2(1.0, 1.0) }),
    sandbag: std(sandbag, { normalScale: new THREE.Vector2(1.1, 1.1) }),
    rubber: std(rubber, { normalScale: new THREE.Vector2(0.8, 0.8) }),
    painted: std(painted, { metalness: 0.42, normalScale: new THREE.Vector2(0.8, 0.8) }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x9fc2c9, transparent: true, opacity: 0.32, roughness: 0.14,
      metalness: 0.1, side: THREE.DoubleSide, depthWrite: false
    }),
    grass: new THREE.MeshStandardMaterial({
      color: 0xb5a05a, roughness: 0.96, metalness: 0, side: THREE.DoubleSide
    }),
    mountain: new THREE.MeshBasicMaterial({ vertexColors: true, fog: true }),
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
      size: 0.055, transparent: true, opacity: 0.42, depthWrite: false,
      color: 0xffe9c4, sizeAttenuation: true
    })
  };
  return M;
}
