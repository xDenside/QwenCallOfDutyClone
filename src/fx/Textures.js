import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Procedural canvas sprite atlas + standalone FX textures.
// All sprites are drawn GREYSCALE/WHITE (tinted per-particle via color attrs)
// except the bullet-hole decal which carries its own colour.
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function cellCanvas(size, draw) {
  const c = makeCanvas(size, size);
  draw(c.getContext('2d'), size);
  return c;
}

// Soft radial white glow -----------------------------------------------------
function drawGlow() {
  return cellCanvas(256, (ctx, s) => {
    const c = s / 2;
    const g = ctx.createRadialGradient(c, c, 0, c, c, s * 0.5);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, 'rgba(255,255,255,0.62)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.18)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

// Bright dot: hot core + wide halo (gravel sparks, glass glints) ------------
function drawDot() {
  return cellCanvas(256, (ctx, s) => {
    const c = s / 2;
    const g = ctx.createRadialGradient(c, c, 0, c, c, s * 0.5);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.12, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.32, 'rgba(255,255,255,0.28)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

// Smoke puff: layered noise circles + erosion holes + round mask ------------
function drawSmoke(seed) {
  return cellCanvas(256, (ctx, s) => {
    const rnd = mulberry32(seed);
    const cx = s / 2, cy = s / 2;
    const n = 13;
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = rnd() * s * 0.17;
      const px = cx + Math.cos(a) * rr;
      const py = cy + Math.sin(a) * rr;
      const r = s * (0.13 + rnd() * 0.16);
      const al = 0.13 + rnd() * 0.15;
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, `rgba(255,255,255,${al})`);
      g.addColorStop(0.6, `rgba(246,246,246,${al * 0.5})`);
      g.addColorStop(1, 'rgba(240,240,240,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    }
    // erosion holes so the blob isn't a smooth grey ball
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 5; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = s * (0.07 + rnd() * 0.2);
      const px = cx + Math.cos(a) * rr;
      const py = cy + Math.sin(a) * rr;
      const r = s * (0.045 + rnd() * 0.08);
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, `rgba(0,0,0,${0.35 + rnd() * 0.3})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    }
    // circular boundary mask — destination-in KEEPS the inside; the previous
    // destination-out would have erased the sprite core entirely
    ctx.globalCompositeOperation = 'destination-in';
    const m = ctx.createRadialGradient(cx, cy, 0, cx, cy, s * 0.5);
    m.addColorStop(0, 'rgba(0,0,0,1)');
    m.addColorStop(0.55, 'rgba(0,0,0,1)');
    m.addColorStop(0.85, 'rgba(0,0,0,0.45)');
    m.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = m;
    ctx.fillRect(0, 0, s, s);
    ctx.globalCompositeOperation = 'source-over';
  });
}

// Fireball: white-hot core -> orange -> dark edge + irregular blobs ----------
function drawFire() {
  return cellCanvas(256, (ctx, s) => {
    const rnd = mulberry32(97);
    const c = s / 2;
    // irregular tongues first
    for (let i = 0; i < 7; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = s * (0.08 + rnd() * 0.14);
      const px = c + Math.cos(a) * rr;
      const py = c + Math.sin(a) * rr;
      const r = s * (0.1 + rnd() * 0.12);
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, 'rgba(255,176,64,0.5)');
      g.addColorStop(1, 'rgba(255,96,16,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    }
    const g = ctx.createRadialGradient(c, c, 0, c, c, s * 0.5);
    g.addColorStop(0, 'rgba(255,253,242,1)');
    g.addColorStop(0.22, 'rgba(255,226,132,0.95)');
    g.addColorStop(0.5, 'rgba(255,128,40,0.6)');
    g.addColorStop(0.78, 'rgba(196,52,6,0.22)');
    g.addColorStop(1, 'rgba(120,24,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

// Horizontal streak (tracers / spark streaks): wide glow + hot core ----------
function drawStreak() {
  return cellCanvas(256, (ctx, s) => {
    const c = s / 2;
    ctx.save();
    ctx.translate(c, c);
    // wide soft glow
    ctx.save();
    ctx.scale(1, 0.3);
    let g = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 0.46);
    g.addColorStop(0, 'rgba(255,255,255,0.75)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.22)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, s * 0.46, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // bright core line
    ctx.save();
    ctx.scale(1, 0.085);
    g = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 0.44);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.7)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, s * 0.44, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.restore();
    // fade out the ends
    ctx.globalCompositeOperation = 'destination-in';
    const lg = ctx.createLinearGradient(0, 0, s, 0);
    lg.addColorStop(0, 'rgba(0,0,0,0)');
    lg.addColorStop(0.15, 'rgba(0,0,0,1)');
    lg.addColorStop(0.85, 'rgba(0,0,0,1)');
    lg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = lg;
    ctx.fillRect(0, 0, s, s);
    ctx.globalCompositeOperation = 'source-over';
  });
}

// Irregular soft blob (blood) -------------------------------------------------
function drawSplat() {
  return cellCanvas(256, (ctx, s) => {
    const rnd = mulberry32(55);
    const c = s / 2;
    for (let i = 0; i < 8; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = rnd() * s * 0.14;
      const px = c + Math.cos(a) * rr;
      const py = c + Math.sin(a) * rr;
      const r = s * (0.1 + rnd() * 0.15);
      const al = 0.35 + rnd() * 0.3;
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, `rgba(255,255,255,${al})`);
      g.addColorStop(0.7, `rgba(255,255,255,${al * 0.4})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    }
    const m = ctx.createRadialGradient(c, c, 0, c, c, s * 0.5);
    m.addColorStop(0, 'rgba(0,0,0,1)');
    m.addColorStop(0.6, 'rgba(0,0,0,1)');
    m.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = m;
    ctx.fillRect(0, 0, s, s);
    ctx.globalCompositeOperation = 'source-over';
  });
}

// Muzzle flash star sprite (white; tinted by material colour) ----------------
function drawStar(spikes, seed, longLen, wMul) {
  return cellCanvas(128, (ctx, s) => {
    const rnd = mulberry32(seed);
    const c = s / 2;
    // hot core glow
    const g = ctx.createRadialGradient(c, c, 0, c, c, s * 0.5);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.24, 'rgba(255,250,235,0.62)');
    g.addColorStop(0.55, 'rgba(255,240,210,0.16)');
    g.addColorStop(1, 'rgba(255,235,200,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    // spikes
    const spike = (ang, len, w, alpha) => {
      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(ang);
      const lg = ctx.createLinearGradient(0, 0, len, 0);
      lg.addColorStop(0, `rgba(255,255,255,${alpha})`);
      lg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = lg;
      ctx.beginPath(); ctx.moveTo(0, -w); ctx.lineTo(len, 0); ctx.lineTo(0, w); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(0, -w); ctx.lineTo(-len, 0); ctx.lineTo(0, w); ctx.closePath(); ctx.fill();
      ctx.restore();
    };
    for (let k = 0; k < spikes; k++) {
      const ang = (k / spikes) * Math.PI * 2 + rnd() * 0.22;
      const len = (k % 2 === 0 ? longLen : longLen * 0.55) * (0.85 + rnd() * 0.3);
      spike(ang, len, s * (0.016 + rnd() * 0.012) * wMul, 0.9);
    }
  });
}

// Expanding shockwave ring -----------------------------------------------------
function drawRing() {
  return cellCanvas(128, (ctx, s) => {
    const c = s / 2;
    const g = ctx.createRadialGradient(c, c, 0, c, c, s * 0.5);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.55, 'rgba(255,255,255,0)');
    g.addColorStop(0.68, 'rgba(255,255,255,0.5)');
    g.addColorStop(0.78, 'rgba(255,255,255,1)');
    g.addColorStop(0.88, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

// Bullet hole: dark centre, rough edge, faint dust halo ------------------------
function drawBulletHole() {
  return cellCanvas(128, (ctx, s) => {
    const rnd = mulberry32(77);
    const c = s / 2;
    // faint dust/scuff halo
    let g = ctx.createRadialGradient(c, c, 0, c, c, s * 0.5);
    g.addColorStop(0.3, 'rgba(74,66,56,0)');
    g.addColorStop(0.52, 'rgba(74,66,56,0.2)');
    g.addColorStop(0.75, 'rgba(74,66,56,0.06)');
    g.addColorStop(1, 'rgba(74,66,56,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    // rough hole: overlapping dark blotches
    for (let i = 0; i < 10; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = rnd() * s * 0.055;
      const px = c + Math.cos(a) * rr;
      const py = c + Math.sin(a) * rr;
      const r = s * (0.065 + rnd() * 0.055);
      g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, 'rgba(10,9,8,0.95)');
      g.addColorStop(0.65, 'rgba(21,18,15,0.85)');
      g.addColorStop(1, 'rgba(38,33,28,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    }
    // a couple of radial cracks / chips
    ctx.strokeStyle = 'rgba(16,14,12,0.5)';
    for (let i = 0; i < 5; i++) {
      const a = rnd() * Math.PI * 2;
      ctx.lineWidth = s * (0.006 + rnd() * 0.008);
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a) * s * 0.06, c + Math.sin(a) * s * 0.06);
      ctx.lineTo(c + Math.cos(a) * s * (0.1 + rnd() * 0.07), c + Math.sin(a) * s * (0.1 + rnd() * 0.07));
      ctx.stroke();
    }
  });
}

function toTexture(canvas, srgb = true) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// Atlas layout (1024x512, 256px cells) ----------------------------------------
const LAYOUT = {
  glow: [0, 0],
  smokeA: [1, 0],
  smokeB: [2, 0],
  smokeC: [3, 0],
  fire: [0, 1],
  dot: [1, 1],
  streak: [2, 1],
  splat: [3, 1]
};

export function buildFXTextures() {
  const atlas = makeCanvas(1024, 512);
  const ctx = atlas.getContext('2d');

  const cells = {
    glow: drawGlow(),
    smokeA: drawSmoke(11),
    smokeB: drawSmoke(23),
    smokeC: drawSmoke(37),
    fire: drawFire(),
    dot: drawDot(),
    streak: drawStreak(),
    splat: drawSplat()
  };
  for (const key in LAYOUT) {
    const [col, row] = LAYOUT[key];
    ctx.drawImage(cells[key], col * 256, row * 256);
  }

  const atlasTex = toTexture(atlas);

  // UV rects (u, v, w, h) — CanvasTexture is flipY, row 0 = top of canvas = high v
  const UV = {};
  for (const key in LAYOUT) {
    const [col, row] = LAYOUT[key];
    UV[key] = [col * 0.25, 1 - (row + 1) * 0.5, 0.25, 0.5];
  }

  return {
    atlasTex,
    UV,
    starA: toTexture(drawStar(4, 5, 56, 1.15)),   // bold 4-point
    starB: toTexture(drawStar(7, 9, 52, 0.8)),    // thin 7-point
    ring: toTexture(drawRing()),
    hole: toTexture(drawBulletHole())
  };
}
