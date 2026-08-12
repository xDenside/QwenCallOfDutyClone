// Synth.js — procedural DSP primitives for the AudioSystem.
// Every sound in the game is synthesized from these helpers: noise buffers,
// convolution impulse responses, waveshaper curves and envelope scheduling.
// No audio asset files exist anywhere in the project.

export function rnd(a, b) { return a + Math.random() * (b - a); }
export function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
export function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }

// ---------------------------------------------------------------------------
// Shared looping noise buffer (per AudioContext, cached). Slightly pink-tilted
// white noise — less fizzy than pure white, recipes shape it further with filters.
// ---------------------------------------------------------------------------
const noiseCache = new WeakMap();
export function noiseBuffer(ctx, seconds = 2) {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const w = Math.random() * 2 - 1;
        lp += 0.32 * (w - lp);
        d[i] = w * 0.6 + lp * 0.4;
      }
    }
    noiseCache.set(ctx, buf);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Convolution reverb impulse response: exponentially decaying noise, stereo
// uncorrelated, progressively darker toward the tail (the one-pole coefficient
// ramps down over time so early reflections stay bright and the tail gets warm).
// ---------------------------------------------------------------------------
export function impulseResponse(ctx, { duration = 2.2, decay = 3.3, brightness = 0.62 } = {}) {
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.floor(sr * duration));
  const buf = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const env = Math.exp(-decay * t) * Math.pow(1 - t, 0.4);
      const w = Math.random() * 2 - 1;
      const k = clamp(0.14 + brightness * (1 - t) * 0.55, 0.05, 0.9);
      lp += k * (w - lp);
      const v = lp * env;
      d[i] = v;
      const av = Math.abs(v);
      if (av > peak) peak = av;
    }
    if (peak > 0) {
      const g = 0.55 / peak;
      for (let i = 0; i < n; i++) d[i] *= g;
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Waveshaper curves — used to dirty up gunshots/explosions so nothing sounds
// like a clean student-project sine blip.
// ---------------------------------------------------------------------------
export function tanhCurve(k = 2.2) {
  const n = 1024;
  const c = new Float32Array(n);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  return c;
}

export function hardClipCurve(drive = 5) {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * drive;
    c[i] = x > 1 ? 1 : (x < -1 ? -1 : x);
  }
  return c;
}

// ---------------------------------------------------------------------------
// Envelope scheduling helpers.
// ---------------------------------------------------------------------------

// Sharp attack -> exponential decay toward floor. The classic gunshot/percussion shape.
export function env(param, t0, peak, attack, tau, floor = 0.00012) {
  param.setValueAtTime(0, t0);
  param.linearRampToValueAtTime(Math.max(peak, floor), t0 + Math.max(0.0004, attack));
  param.setTargetAtTime(floor, t0 + attack, Math.max(0.004, tau));
}

// Slow swell -> hold -> exponential release. For drones, whooshes, creaks.
export function swell(param, t0, peak, attack, hold, tau, floor = 0.00012) {
  param.setValueAtTime(0, t0);
  param.linearRampToValueAtTime(Math.max(peak, floor), t0 + Math.max(0.01, attack));
  param.setValueAtTime(Math.max(peak, floor), t0 + attack + Math.max(0, hold));
  param.setTargetAtTime(floor, t0 + attack + hold, Math.max(0.01, tau));
}
