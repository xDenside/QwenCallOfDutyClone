// Sounds.js — every one-shot recipe in the game, fully procedural.
// A recipe is (a, o) => void where:
//   a = AudioSystem (a.ctx, a.route(voice, o, cfg), a.track(node, until))
//   o = normalized opts from play(): { position, volume, pitch, material, _dist, _t0 }
// Recipes build their layers into a local 'voice' GainNode and hand it to
// a.route(), which applies o.volume, distance attenuation (1/(1+d/10)),
// distance-based air-absorption lowpass, HRTF panning and reverb send.

import { noiseBuffer, tanhCurve, hardClipCurve, env, swell, rnd, clamp } from './Synth.js';

// --- small helpers ----------------------------------------------------------

function noiseSrc(a) {
  const ctx = a.ctx;
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(ctx, 2);
  s.loop = true;
  return s;
}

// Start a looping noise source at a random offset (so repeats never sound identical).
function startNoise(a, s, t0, dur) {
  try {
    s.start(t0, Math.random() * Math.max(0.05, s.buffer.duration - 0.5));
    s.stop(t0 + dur);
  } catch (e) { /* already started/stopped — ignore */ }
  a.track(s, t0 + dur + 0.1);
}

// Short resonant click: highpassed noise tick + a small pitched blip.
function click(a, out, t, { f = 2000, g = 0.4, hp = 1200, dur = 0.018 } = {}) {
  const ctx = a.ctx;
  const n = noiseSrc(a);
  const hpf = ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = hp; hpf.Q.value = 0.7;
  const ng = ctx.createGain(); env(ng.gain, t, g, 0.0004, dur * 0.45);
  n.connect(hpf); hpf.connect(ng); ng.connect(out);
  startNoise(a, n, t, dur);

  const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
  const og = ctx.createGain(); env(og.gain, t, g * 0.5, 0.0005, dur * 0.55);
  o.connect(og); og.connect(out);
  o.start(t); o.stop(t + dur + 0.06); a.track(o, t + dur + 0.08);
}

// Low pitched thump with fast pitch drop.
function thud(a, out, t, { f = 140, g = 0.5, dur = 0.05, drop = 0.55, wave = 'sine' } = {}) {
  const ctx = a.ctx;
  const o = ctx.createOscillator(); o.type = wave;
  o.frequency.setValueAtTime(Math.max(30, f), t);
  o.frequency.exponentialRampToValueAtTime(Math.max(26, f * drop), t + dur);
  const og = ctx.createGain(); env(og.gain, t, g, 0.0015, dur * 0.6);
  o.connect(og); og.connect(out);
  o.start(t); o.stop(t + dur + 0.15); a.track(o, t + dur + 0.2);
}

// Metallic ring: noise burst through a narrow resonant bandpass + quiet osc body.
function ping(a, out, t, { f = 800, g = 0.3, q = 10, dur = 0.14 } = {}) {
  const ctx = a.ctx;
  const n = noiseSrc(a);
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
  const ng = ctx.createGain(); env(ng.gain, t, g, 0.0006, dur * 0.5);
  n.connect(bp); bp.connect(ng); ng.connect(out);
  startNoise(a, n, t, dur);

  const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f * 1.003;
  const og = ctx.createGain(); env(og.gain, t, g * 0.45, 0.0006, dur * 0.45);
  o.connect(og); og.connect(out);
  o.start(t); o.stop(t + dur + 0.1); a.track(o, t + dur + 0.12);
}

// --- GUNSHOTS ---------------------------------------------------------------
// Layered MW-style: (1) click transient, (2) noise crack through a bandpass
// sweeping ~4kHz -> ~800Hz, (3) pitched body thump with fast pitch drop,
// (4) sub punch, (5) decaying lowpassed noise tail feeding the convolution
// reverb. The crack+body+sub sum runs through a tanh waveshaper so the shot
// gets dirty and glued instead of sounding like separate sine blips.

function gunshot(a, o, cfg) {
  const ctx = a.ctx;
  const t0 = o._t0 != null ? o._t0 : ctx.currentTime;
  const p = o.pitch || 1;
  const voice = ctx.createGain(); voice.gain.value = cfg.gain != null ? cfg.gain : 1;

  const bus = ctx.createGain(); bus.gain.value = 1;
  const clip = ctx.createWaveShaper();
  clip.curve = tanhCurve(2.4); clip.oversample = '2x';
  bus.connect(clip); clip.connect(voice);

  // (1) click transient — the snap at the very first millisecond
  {
    const n = noiseSrc(a);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2700 * p;
    const g = ctx.createGain(); env(g.gain, t0, cfg.click, 0.0004, 0.006);
    n.connect(hp); hp.connect(g); g.connect(bus);
    startNoise(a, n, t0, 0.03);
  }
  // (2) crack — noise burst through a sweeping bandpass
  {
    const n = noiseSrc(a); n.playbackRate.value = p;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.85;
    bp.frequency.setValueAtTime(cfg.crackHi * p, t0);
    bp.frequency.exponentialRampToValueAtTime(Math.max(220, cfg.crackLo * p), t0 + 0.08);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 170;
    const g = ctx.createGain(); env(g.gain, t0, cfg.crack, 0.001, 0.034);
    n.connect(bp); bp.connect(hp); hp.connect(g); g.connect(bus);
    startNoise(a, n, t0, 0.17);
  }
  // (3) body — low triangle thump, fast pitch drop
  {
    const osc = ctx.createOscillator(); osc.type = cfg.bodyWave || 'triangle';
    const f = cfg.body * p;
    osc.frequency.setValueAtTime(f, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(30, f * 0.42), t0 + 0.09);
    const g = ctx.createGain(); env(g.gain, t0, cfg.bodyGain, 0.002, cfg.bodyDecay);
    osc.connect(g); g.connect(bus);
    osc.start(t0); osc.stop(t0 + 0.32); a.track(osc, t0 + 0.35);
  }
  // (4) sub punch
  {
    const osc = ctx.createOscillator(); osc.type = 'sine';
    const f = cfg.sub * p;
    osc.frequency.setValueAtTime(f, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(24, f * 0.5), t0 + 0.12);
    const g = ctx.createGain(); env(g.gain, t0, cfg.subGain, 0.003, 0.07);
    osc.connect(g); g.connect(bus);
    osc.start(t0); osc.stop(t0 + 0.36); a.track(osc, t0 + 0.4);
  }
  // (5) tail — decaying lowpassed noise; sits outside the clip for air, and
  // gets the biggest share of the reverb send via route()
  {
    const n = noiseSrc(a); n.playbackRate.value = p * 0.92;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.7;
    lp.frequency.setValueAtTime(cfg.tailHi, t0);
    lp.frequency.exponentialRampToValueAtTime(310, t0 + cfg.tailT);
    const g = ctx.createGain(); env(g.gain, t0, cfg.tailGain, 0.004, cfg.tailT * 0.5);
    n.connect(lp); lp.connect(g); g.connect(voice);
    startNoise(a, n, t0, cfg.tailT + 0.12);
  }

  a.route(voice, o, { wet: cfg.wet, air: cfg.air });
}

// --- EXPLOSION --------------------------------------------------------------

function explosion(a, o) {
  const ctx = a.ctx;
  const t0 = o._t0 != null ? o._t0 : ctx.currentTime;
  const voice = ctx.createGain(); voice.gain.value = 1;
  const bus = ctx.createGain(); bus.gain.value = 1;
  const clip = ctx.createWaveShaper();
  clip.curve = hardClipCurve(5); clip.oversample = '2x';
  bus.connect(clip); clip.connect(voice);

  // initial crack
  {
    const n = noiseSrc(a);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.7;
    bp.frequency.setValueAtTime(2800, t0);
    bp.frequency.exponentialRampToValueAtTime(320, t0 + 0.07);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 140;
    const g = ctx.createGain(); env(g.gain, t0, 0.9, 0.001, 0.045);
    n.connect(bp); bp.connect(hp); hp.connect(g); g.connect(bus);
    startNoise(a, n, t0, 0.2);
  }
  // distorted boom, lowpass closing down
  {
    const n = noiseSrc(a); n.playbackRate.value = 0.85;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.8;
    lp.frequency.setValueAtTime(850, t0);
    lp.frequency.exponentialRampToValueAtTime(70, t0 + 1.0);
    const g = ctx.createGain(); env(g.gain, t0, 1.15, 0.004, 0.3);
    n.connect(lp); lp.connect(g); g.connect(bus);
    startNoise(a, n, t0, 1.6);
  }
  // sub-bass swell 30 -> 55Hz
  {
    const osc = ctx.createOscillator(); osc.type = 'sine';
    osc.frequency.setValueAtTime(30, t0);
    osc.frequency.linearRampToValueAtTime(55, t0 + 0.09);
    osc.frequency.setTargetAtTime(34, t0 + 0.5, 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.95, t0 + 0.06);
    g.gain.setValueAtTime(0.95, t0 + 0.18);
    g.gain.setTargetAtTime(0.0001, t0 + 0.18, 0.45);
    osc.connect(g); g.connect(bus);
    osc.start(t0); osc.stop(t0 + 2.6); a.track(osc, t0 + 2.7);
  }
  // debris rumble falling off into the reverb tail
  {
    const n = noiseSrc(a); n.playbackRate.value = 0.7;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.5;
    lp.frequency.value = 300;
    const g = ctx.createGain(); env(g.gain, t0, 0.34, 0.05, 0.55);
    n.connect(lp); lp.connect(g); g.connect(voice);
    startNoise(a, n, t0, 2.3);
  }

  a.route(voice, o, { wet: 0.5, air: 8 });
}

// --- RELOADS (mechanical foley) ----------------------------------------------

function reloadM4Start(a, o) {
  const ctx = a.ctx;
  const t0 = o._t0 != null ? o._t0 : ctx.currentTime;
  const p = o.pitch || 1;
  const voice = ctx.createGain(); voice.gain.value = 0.9;
  click(a, voice, t0, { f: 2300 * p, g: 0.42, hp: 1500 });              // selector / grip
  click(a, voice, t0 + 0.055, { f: 1250 * p, g: 0.6, hp: 700, dur: 0.02 }); // mag release
  { // mag sliding out
    const n = noiseSrc(a);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.6;
    bp.frequency.setValueAtTime(950 * p, t0 + 0.09);
    bp.frequency.exponentialRampToValueAtTime(430 * p, t0 + 0.19);
    const g = ctx.createGain(); env(g.gain, t0 + 0.09, 0.3, 0.004, 0.035);
    n.connect(bp); bp.connect(g); g.connect(voice);
    startNoise(a, n, t0 + 0.09, 0.12);
  }
  click(a, voice, t0 + 0.17, { f: 1900 * p, g: 0.2, hp: 1000 });       // mag clear rattle
  click(a, voice, t0 + 0.205, { f: 1500 * p, g: 0.15, hp: 900 });
  a.route(voice, o, { wet: 0.08 });
}

function reloadM4End(a, o) {
  const ctx = a.ctx;
  const t0 = o._t0 != null ? o._t0 : ctx.currentTime;
  const p = o.pitch || 1;
  const voice = ctx.createGain(); voice.gain.value = 0.95;
  thud(a, voice, t0, { f: 150 * p, g: 0.5, dur: 0.03 });               // mag slap in
  { // mag scrape
    const n = noiseSrc(a);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1300;
    const g = ctx.createGain(); env(g.gain, t0, 0.35, 0.002, 0.02);
    n.connect(lp); lp.connect(g); g.connect(voice);
    startNoise(a, n, t0, 0.05);
  }
  click(a, voice, t0 + 0.09, { f: 2600 * p, g: 0.55, hp: 1800 });      // bolt catch
  ping(a, voice, t0 + 0.095, { f: 1750 * p, g: 0.22, q: 8, dur: 0.07 });
  click(a, voice, t0 + 0.165, { f: 1100 * p, g: 0.3, hp: 600 });       // hand back on grip
  a.route(voice, o, { wet: 0.08 });
}

function reloadP1911(a, o) {
  const ctx = a.ctx;
  const t0 = o._t0 != null ? o._t0 : ctx.currentTime;
  const p = o.pitch || 1;
  const voice = ctx.createGain(); voice.gain.value = 0.9;
  click(a, voice, t0, { f: 1350 * p, g: 0.5, hp: 800 });               // mag release
  { // empty mag drops
    const n = noiseSrc(a);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 800 * p; bp.Q.value = 2;
    const g = ctx.createGain(); env(g.gain, t0 + 0.04, 0.28, 0.004, 0.03);
    n.connect(bp); bp.connect(g); g.connect(voice);
    startNoise(a, n, t0 + 0.04, 0.07);
  }
  thud(a, voice, t0 + 0.14, { f: 165 * p, g: 0.45, dur: 0.028 });      // fresh mag slap
  click(a, voice, t0 + 0.15, { f: 2100 * p, g: 0.45, hp: 1300 });
  ping(a, voice, t0 + 0.24, { f: 1350 * p, g: 0.3, q: 9, dur: 0.09 }); // slide release snap
  click(a, voice, t0 + 0.245, { f: 2900 * p, g: 0.5, hp: 2000, dur: 0.014 });
  thud(a, voice, t0 + 0.30, { f: 190 * p, g: 0.35, dur: 0.03 });       // slide forward
  a.route(voice, o, { wet: 0.08 });
}

function reloadP1911End(a, o) {
  const ctx = a.ctx;
  const t0 = o._t0 != null ? o._t0 : ctx.currentTime;
  const voice = ctx.createGain(); voice.gain.value = 0.8;
  click(a, voice, t0, { f: 2400, g: 0.35, hp: 1600 });                 // safety / grip settle
  a.route(voice, o, { wet: 0.06 });
}

// --- FOOTSTEPS --------------------------------------------------------------

function footstep(a, o, cfg) {
  const ctx = a.ctx;
  const t0 = o._t0 != null ? o._t0 : ctx.currentTime;
  const p = o.pitch || 1;
  const voice = ctx.createGain(); voice.gain.value = cfg.gain != null ? cfg.gain : 1;

  thud(a, voice, t0, { f: cfg.thudF * p, g: cfg.thudG, dur: cfg.dur, drop: 0.62 });

  const n = noiseSrc(a);
  let head = n;
  if (cfg.bp) {
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.value = cfg.bp * p; bp.Q.value = cfg.bq != null ? cfg.bq : 1.2;
    head.connect(bp); head = bp;
  }
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
  lp.frequency.value = cfg.lp * p; lp.Q.value = 0.6;
  head.connect(lp); head = lp;
  const g = ctx.createGain(); env(g.gain, t0, cfg.noiseG, cfg.attack != null ? cfg.attack : 0.0012, cfg.dur * 0.55);
  head.connect(g); g.connect(voice);
  startNoise(a, n, t0, cfg.dur + 0.03);

  if (cfg.extra) cfg.extra(a, voice, t0, p);
  a.route(voice, o, { wet: 0.05 });
}

const FS = {
  dirt: { lp: 750, dur: 0.06, noiseG: 0.42, thudF: 118, thudG: 0.3,
    extra: (a, v, t0, p) => click(a, v, t0 + rnd(0.008, 0.03), { f: rnd(900, 1500) * p, g: 0.1, hp: 700, dur: 0.012 }) }, // gravel grit
  concrete: { lp: 1600, dur: 0.05, noiseG: 0.5, thudF: 150, thudG: 0.34, attack: 0.0008,
    extra: (a, v, t0, p) => click(a, v, t0, { f: 2600 * p, g: 0.16, hp: 1800, dur: 0.01 }) },
  metal: { lp: 1000, dur: 0.065, noiseG: 0.34, thudF: 185, thudG: 0.5,
    extra: (a, v, t0, p) => ping(a, v, t0 + 0.004, { f: rnd(360, 540) * p, g: 0.2, q: 12, dur: 0.15 }) },
  wood: { bp: 520, bq: 1.4, lp: 1200, dur: 0.055, noiseG: 0.36, thudF: 132, thudG: 0.38 },
  sandbag: { lp: 420, dur: 0.075, noiseG: 0.3, thudF: 95, thudG: 0.24, attack: 0.006 },
  glass: { bp: 2800, bq: 1.3, lp: 6000, dur: 0.05, noiseG: 0.45, thudF: 210, thudG: 0.16,
    extra: (a, v, t0, p) => {
      click(a, v, t0 + 0.018, { f: rnd(3000, 4200) * p, g: 0.18, hp: 2400, dur: 0.012 });
      click(a, v, t0 + 0.034, { f: rnd(2600, 3800) * p, g: 0.12, hp: 2200, dur: 0.012 });
    } }
};

// --- IMPACTS (bullets hitting the world) --------------------------------------

function impact(a, o, cfg) {
  const ctx = a.ctx;
  const t0 = o._t0 != null ? o._t0 : ctx.currentTime;
  const p = o.pitch || 1;
  const voice = ctx.createGain(); voice.gain.value = cfg.gain != null ? cfg.gain : 1;

  const n = noiseSrc(a);
  let head = n;
  if (cfg.bp) {
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.value = cfg.bp * p; bp.Q.value = cfg.bq != null ? cfg.bq : 1.5;
    head.connect(bp); head = bp;
  }
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = cfg.lp * p; lp.Q.value = 0.7;
  head.connect(lp); head = lp;
  const g = ctx.createGain(); env(g.gain, t0, cfg.noiseG, cfg.attack != null ? cfg.attack : 0.001, cfg.dur * 0.5);
  head.connect(g); g.connect(voice);
  startNoise(a, n, t0, cfg.dur + 0.02);

  if (cfg.thudF) thud(a, voice, t0, { f: cfg.thudF * p, g: cfg.thudG != null ? cfg.thudG : 0.3, dur: 0.035 });
  if (cfg.pingF) ping(a, voice, t0 + 0.003, { f: cfg.pingF * p, g: cfg.pingG != null ? cfg.pingG : 0.3, q: cfg.pingQ != null ? cfg.pingQ : 11, dur: cfg.pingDur != null ? cfg.pingDur : 0.16 });
  if (cfg.extra) cfg.extra(a, voice, t0, p);
  a.route(voice, o, { wet: 0.14, air: 9 });
}

const IMP = {
  dirt:     { lp: 800, dur: 0.06, noiseG: 0.5, thudF: 108 },
  concrete: { lp: 2400, dur: 0.045, noiseG: 0.55, thudF: 190, thudG: 0.22,
    extra: (a, v, t0, p) => click(a, v, t0, { f: 3000 * p, g: 0.18, hp: 2000, dur: 0.01 }) },
  metal:    { lp: 1400, dur: 0.03, noiseG: 0.35, pingF: 520, pingG: 0.4, pingQ: 12, pingDur: 0.19 },
  wood:     { bp: 480, bq: 1.8, lp: 1500, dur: 0.055, noiseG: 0.45, thudF: 170, thudG: 0.3 },
  sandbag:  { lp: 400, dur: 0.07, noiseG: 0.4, attack: 0.004, thudF: 90, thudG: 0.2 },
  glass:    { bp: 3000, bq: 1.4, lp: 7000, dur: 0.05, noiseG: 0.5,
    extra: (a, v, t0, p) => click(a, v, t0 + 0.02, { f: rnd(3200, 4500) * p, g: 0.2, hp: 2500, dur: 0.012 }) },
  flesh:    { lp: 520, dur: 0.04, noiseG: 0.22, thudF: 142, thudG: 0.42, gain: 0.85 }
};

// --- AMBIENT creak ------------------------------------------------------------

function creak(a, o) {
  const ctx = a.ctx;
  const t0 = o._t0 != null ? o._t0 : ctx.currentTime;
  const p = o.pitch || 1;
  const voice = ctx.createGain(); voice.gain.value = 0.55;
  const f0 = rnd(68, 150) * p;
  for (let i = 0; i < 2; i++) {
    const osc = ctx.createOscillator(); osc.type = 'sawtooth';
    const f = f0 * (i ? 1.013 : 1);
    osc.frequency.setValueAtTime(f, t0);
    osc.frequency.linearRampToValueAtTime(f * rnd(0.86, 1.12), t0 + rnd(0.9, 1.7));
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.value = f * rnd(3.2, 5.2); bp.Q.value = rnd(7, 11);
    const g = ctx.createGain();
    swell(g.gain, t0, i ? 0.24 : 0.32, rnd(0.3, 0.6), rnd(0.2, 0.6), 0.45);
    osc.connect(bp); bp.connect(g); g.connect(voice);
    osc.start(t0); osc.stop(t0 + 3); a.track(osc, t0 + 3.1);
  }
  a.route(voice, o, { wet: 0.5, air: 5 });
}

// --- RECIPE TABLE -------------------------------------------------------------

export const RECIPES = {
  // weapons
  shot_m4: (a, o) => gunshot(a, o, {
    crackHi: 4300, crackLo: 850, crack: 1.0, click: 0.5,
    body: 138, bodyGain: 0.9, bodyDecay: 0.05, bodyWave: 'triangle',
    sub: 95, subGain: 0.55,
    tailHi: 2400, tailT: 0.34, tailGain: 0.38,
    wet: 0.16, air: 11, gain: 1.0
  }),
  shot_p1911: (a, o) => gunshot(a, o, {
    crackHi: 5400, crackLo: 1100, crack: 0.95, click: 0.68,
    body: 186, bodyGain: 0.62, bodyDecay: 0.04, bodyWave: 'triangle',
    sub: 112, subGain: 0.32,
    tailHi: 2900, tailT: 0.24, tailGain: 0.3,
    wet: 0.14, air: 11, gain: 0.95
  }),
  shot_enemy: (a, o) => gunshot(a, o, {
    crackHi: 3800, crackLo: 700, crack: 0.82, click: 0.34,
    body: 128, bodyGain: 1.0, bodyDecay: 0.06, bodyWave: 'triangle',
    sub: 88, subGain: 0.6,
    tailHi: 2100, tailT: 0.5, tailGain: 0.45,
    wet: 0.32, air: 5.5, gain: 0.92
  }),

  // explosion & combat feedback
  explosion,
  npc_hit: (a, o) => {
    const ctx = a.ctx;
    const t0 = o._t0 != null ? o._t0 : ctx.currentTime;
    const voice = ctx.createGain(); voice.gain.value = 0.8;
    thud(a, voice, t0, { f: 150, g: 0.45, dur: 0.04 });
    const n = noiseSrc(a);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600;
    const g = ctx.createGain(); env(g.gain, t0, 0.25, 0.001, 0.022);
    n.connect(lp); lp.connect(g); g.connect(voice);
    startNoise(a, n, t0, 0.05);
    a.route(voice, o, { wet: 0.15 });
  },
  hitmarker: (a, o) => {
    const ctx = a.ctx;
    const t0 = o._t0 != null ? o._t0 : ctx.currentTime;
    const p = o.pitch || 1;
    const voice = ctx.createGain(); voice.gain.value = 0.9;
    for (const [dt, gg] of [[0, 0.3], [0.014, 0.12]]) {
      const osc = ctx.createOscillator(); osc.type = 'square';
      osc.frequency.value = 2080 * p;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1300;
      const g = ctx.createGain(); env(g.gain, t0 + dt, gg, 0.0003, 0.0045);
      osc.connect(hp); hp.connect(g); g.connect(voice);
      osc.start(t0 + dt); osc.stop(t0 + dt + 0.05); a.track(osc, t0 + dt + 0.06);
    }
    a.route(voice, o, { wet: 0 }); // bone dry
  },
  player_hurt: (a, o) => {
    const ctx = a.ctx;
    const t0 = o._t0 != null ? o._t0 : ctx.currentTime;
    const voice = ctx.createGain(); voice.gain.value = 1;
    thud(a, voice, t0, { f: 70, g: 0.8, dur: 0.12, drop: 0.6 });
    { // breath-like filtered noise
      const n = noiseSrc(a);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 460; bp.Q.value = 0.8;
      const g = ctx.createGain(); swell(g.gain, t0 + 0.03, 0.38, 0.09, 0.1, 0.22);
      n.connect(bp); bp.connect(g); g.connect(voice);
      startNoise(a, n, t0 + 0.03, 0.65);
    }
    { // low blood-rush wash
      const n = noiseSrc(a); n.playbackRate.value = 0.6;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 190;
      const g = ctx.createGain(); env(g.gain, t0, 0.22, 0.03, 0.25);
      n.connect(lp); lp.connect(g); g.connect(voice);
      startNoise(a, n, t0, 0.7);
    }
    a.route(voice, o, { wet: 0.2 });
  },

  // grenades
  grenade_throw: (a, o) => {
    const ctx = a.ctx;
    const t0 = o._t0 != null ? o._t0 : ctx.currentTime;
    const voice = ctx.createGain(); voice.gain.value = 0.9;
    const n = noiseSrc(a);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(280, t0);
    bp.frequency.exponentialRampToValueAtTime(1500, t0 + 0.18);
    bp.frequency.exponentialRampToValueAtTime(380, t0 + 0.45);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 150;
    const g = ctx.createGain(); swell(g.gain, t0, 0.5, 0.12, 0.06, 0.14);
    n.connect(bp); bp.connect(hp); hp.connect(g); g.connect(voice);
    startNoise(a, n, t0, 0.58);
    a.route(voice, o, { wet: 0.12 });
  },
  grenade_bounce: (a, o) => {
    const soft = o.material === 'dirt' || o.material === 'sandbag' || o.material === 'wood';
    const ctx = a.ctx;
    const t0 = o._t0 != null ? o._t0 : ctx.currentTime;
    const p = o.pitch || 1;
    const voice = ctx.createGain(); voice.gain.value = 0.85;
    if (soft) {
      thud(a, voice, t0, { f: 110 * p, g: 0.5, dur: 0.05 });
      const n = noiseSrc(a);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520;
      const g = ctx.createGain(); env(g.gain, t0, 0.3, 0.002, 0.03);
      n.connect(lp); lp.connect(g); g.connect(voice);
      startNoise(a, n, t0, 0.06);
    } else {
      ping(a, voice, t0, { f: rnd(620, 1050) * p, g: 0.5, q: 11, dur: 0.17 });
      click(a, voice, t0, { f: 2500 * p, g: 0.28, hp: 1800, dur: 0.012 });
    }
    a.route(voice, o, { wet: 0.22, air: 8 });
  },

  // UI / meta
  ui_click: (a, o) => {
    const ctx = a.ctx;
    const t0 = o._t0 != null ? o._t0 : ctx.currentTime;
    const voice = ctx.createGain(); voice.gain.value = 1;
    click(a, voice, t0, { f: 1080, g: 0.32, hp: 1500, dur: 0.014 });
    a.route(voice, o, { wet: 0 });
  },
  ui_objective: (a, o) => {
    const ctx = a.ctx;
    const t0 = o._t0 != null ? o._t0 : ctx.currentTime;
    const voice = ctx.createGain(); voice.gain.value = 1;
    [[0, 740], [0.09, 988]].forEach(([dt, f]) => {
      const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = f;
      const g = ctx.createGain(); env(g.gain, t0 + dt, 0.22, 0.004, 0.05);
      osc.connect(g); g.connect(voice);
      osc.start(t0 + dt); osc.stop(t0 + dt + 0.25); a.track(osc, t0 + dt + 0.3);
    });
    a.route(voice, o, { wet: 0.1 });
  },
  weapon_swap: (a, o) => {
    const ctx = a.ctx;
    const t0 = o._t0 != null ? o._t0 : ctx.currentTime;
    const voice = ctx.createGain(); voice.gain.value = 0.9;
    { // cloth rustle
      const n = noiseSrc(a);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 660; bp.Q.value = 1.1;
      const g = ctx.createGain(); swell(g.gain, t0, 0.3, 0.05, 0.04, 0.06);
      n.connect(bp); bp.connect(g); g.connect(voice);
      startNoise(a, n, t0, 0.2);
    }
    click(a, voice, t0 + 0.08, { f: 1500, g: 0.3, hp: 900 });
    thud(a, voice, t0 + 0.12, { f: 175, g: 0.22, dur: 0.03 });
    a.route(voice, o, { wet: 0.08 });
  },
  death: (a, o) => {
    const ctx = a.ctx;
    const t0 = o._t0 != null ? o._t0 : ctx.currentTime;
    const voice = ctx.createGain(); voice.gain.value = 1;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 280; lp.Q.value = 0.7;
    lp.connect(voice);
    for (const det of [1, 1.023]) {
      const osc = ctx.createOscillator(); osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(55 * det, t0);
      osc.frequency.linearRampToValueAtTime(50.5 * det, t0 + 3.2);
      const g = ctx.createGain(); swell(g.gain, t0, 0.34, 0.5, 1.0, 1.0);
      osc.connect(g); g.connect(lp);
      osc.start(t0); osc.stop(t0 + 3.6); a.track(osc, t0 + 3.7);
    }
    { // dark noise wash
      const n = noiseSrc(a); n.playbackRate.value = 0.5;
      const lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = 200;
      const g = ctx.createGain(); swell(g.gain, t0, 0.22, 0.7, 0.6, 1.0);
      n.connect(lp2); lp2.connect(g); g.connect(voice);
      startNoise(a, n, t0, 2.9);
    }
    a.route(voice, o, { wet: 0.45 });
  },

  // footsteps
  footstep_dirt: (a, o) => footstep(a, o, FS.dirt),
  footstep_concrete: (a, o) => footstep(a, o, FS.concrete),
  footstep_metal: (a, o) => footstep(a, o, FS.metal),
  footstep_wood: (a, o) => footstep(a, o, FS.wood),
  footstep_sandbag: (a, o) => footstep(a, o, FS.sandbag),
  footstep_glass: (a, o) => footstep(a, o, FS.glass),
  footstep: (a, o) => footstep(a, o, FS.dirt),

  // bullet impacts
  impact_dirt: (a, o) => impact(a, o, IMP.dirt),
  impact_concrete: (a, o) => impact(a, o, IMP.concrete),
  impact_metal: (a, o) => impact(a, o, IMP.metal),
  impact_wood: (a, o) => impact(a, o, IMP.wood),
  impact_sandbag: (a, o) => impact(a, o, IMP.sandbag),
  impact_glass: (a, o) => impact(a, o, IMP.glass),
  impact_flesh: (a, o) => impact(a, o, IMP.flesh),

  // reloads
  reload_m4_start: reloadM4Start,
  reload_m4_end: reloadM4End,
  reload_p1911: reloadP1911,
  reload_p1911_end: reloadP1911End,

  // ambience event
  amb_creak: creak
};
