// Shared seeded noise helpers for the world builder (textures + terrain).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix, iy, seed) {
  let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 974634581);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}

function smooth(t) { return t * t * (3 - 2 * t); }

/** 2D value noise in [0,1]. */
export function makeValueNoise(seed) {
  const s = seed | 0;
  return function (x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const a = hash2(ix, iy, s), b = hash2(ix + 1, iy, s);
    const c = hash2(ix, iy + 1, s), d = hash2(ix + 1, iy + 1, s);
    const u = smooth(fx), v = smooth(fy);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}

/** Fractal brownian motion, [0,1]. */
export function makeFbm(seed, octaves = 4) {
  const n = makeValueNoise(seed);
  return function (x, y) {
    let amp = 0.5, f = 1, sum = 0, tot = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * n(x * f, y * f);
      tot += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    return sum / tot;
  };
}

/** Ridged noise in [0,1] (sharp peaks) — good for mountain silhouettes. */
export function makeRidged(seed, octaves = 3) {
  const n = makeValueNoise(seed);
  return function (x, y) {
    let amp = 0.6, f = 1, sum = 0, tot = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * (1 - Math.abs(2 * n(x * f, y * f) - 1));
      tot += amp;
      amp *= 0.5;
      f *= 2.11;
    }
    return sum / tot;
  };
}

export function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
export function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
export function lerp(a, b, t) { return a + (b - a) * t; }
