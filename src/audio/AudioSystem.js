// AudioSystem.js — 100% procedural WebAudio for STRIKE COMPOUND.
// Bar: CoD MW2019 — layered punchy gunshots, spatial enemy fire, foley detail,
// atmospheric bed. No audio asset files; every sound is synthesized (see
// Synth.js for DSP primitives, Sounds.js for the recipes).
//
// Contract surface:
//   init(game)                       — once at boot
//   update(dt, game)                 — every frame
//   play(name, opts)                 — opts: { position:Vector3, volume, pitch, material }; NEVER throws
//   setListenerFromCamera(camera)    — listener position + forward/up from camera
//   forceUnlock()                    — create/resume AudioContext immediately (capture harness)
//   debugShot(name)                  — harness hook: preview any sound headlessly
//
// Master chain:  voices ─┬─> master gain ─> DynamicsCompressor (-18dB, 4:1) ─> destination
//                        └─> wet gain ─> pre-delay ─> convolution reverb ─> compressor

import * as THREE from 'three';
import { noiseBuffer, impulseResponse, rnd, clamp } from './Synth.js';
import { RECIPES } from './Sounds.js';

const DOWN = new THREE.Vector3(0, -1, 0);

export class AudioSystem {
  constructor(game) {
    this.game = game;
    this.supported = false;
    this.ctx = null;
    this.master = null;
    this.comp = null;
    this.reverbSend = null;
    this.convolver = null;
    this.listenerPos = new THREE.Vector3(0, 1.6, 0);
    this._fwd = new THREE.Vector3(0, 0, -1);
    this._up = new THREE.Vector3(0, 1, 0);
    this._tmpPos = new THREE.Vector3();
    this._tmpOrigin = new THREE.Vector3();
    this._voices = [];            // [{ node, until }] for the voice cap
    this._lastPlay = new Map();   // name -> ctx time, dedup gate
    this._ambienceOn = false;
    this._ambienceNodes = null;
    this._nextCreak = 10;
    this._stepDist = 0;
    this._stepAlt = false;
    this._gestureSeen = false;
    this._resumeTimer = 0;
    this._unlockedOnce = false;
  }

  // ------------------------------------------------------------------ boot

  init(game) {
    this.game = game || this.game;
    try {
      const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
      if (AC) this.ctx = new AC();
    } catch (e) { this.ctx = null; }
    if (!this.ctx) { this.supported = false; return; }
    this.supported = true;

    try { this._buildGraph(); } catch (e) { this.supported = false; return; }

    // Unlock on any user gesture (pointer lock click, keys…).
    const unlock = () => { this._gestureSeen = true; this.forceUnlock(); };
    try {
      window.addEventListener('pointerdown', unlock, { passive: true, capture: true });
      window.addEventListener('keydown', unlock, { passive: true, capture: true });
      window.addEventListener('touchstart', unlock, { passive: true, capture: true });
    } catch (e) { /* ignore */ }

    // Gameplay event bus -> sounds. The dedup gate in play() means it is safe
    // if another system ALSO calls play() directly for the same moment —
    // whichever arrives first wins, the double is dropped.
    const ev = game && game.events;
    if (ev && typeof ev.on === 'function') {
      ev.on('shot', (d) => {
        const w = (d && d.weapon) || '';
        const name = /1911|pistol/i.test(w) ? 'shot_p1911' : 'shot_m4';
        this.play(name, { position: d && d.origin, volume: 1 });
      });
      ev.on('impact', (d) => this._onImpact(d));
      ev.on('npc-hit', () => { this.play('npc_hit'); this.play('hitmarker', { volume: 0.9 }); });
      ev.on('npc-killed', () => this.play('hitmarker', { volume: 0.7, pitch: 1.12 }));
      ev.on('player-damaged', () => this.play('player_hurt'));
      ev.on('player-dead', () => this.play('death'));
      ev.on('explosion', (d) => this.play('explosion', { position: d && d.point, volume: 1 }));
      ev.on('reload-start', (d) => this._reloadSound(d, true));
      ev.on('reload-end', (d) => this._reloadSound(d, false));
      ev.on('grenade-thrown', (d) => this.play('grenade_throw', { position: d && d.origin }));
      ev.on('weapon-changed', () => this.play('weapon_swap'));
      ev.on('objective-updated', () => this.play('ui_objective'));
    }

    this.setListenerFromCamera(game && game.camera);
  }

  _buildGraph() {
    const ctx = this.ctx;
    // master -> compressor -> speakers
    this.master = ctx.createGain();
    this.master.gain.value = 0; // fades up to 0.85 on first unlock (no pop)
    this.comp = ctx.createDynamicsCompressor();
    try {
      this.comp.threshold.value = -18;
      this.comp.knee.value = 12;
      this.comp.ratio.value = 4;
      this.comp.attack.value = 0.003;
      this.comp.release.value = 0.24;
    } catch (e) { /* keep defaults */ }
    this.master.connect(this.comp);
    this.comp.connect(ctx.destination);

    // convolution reverb bus (procedural IR, stereo uncorrelated, 2.2s)
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 1;
    const pre = ctx.createDelay(0.5);
    pre.delayTime.value = 0.028; // pre-delay keeps gun cracks out of the early reverb
    this.convolver = ctx.createConvolver();
    try {
      this.convolver.buffer = impulseResponse(ctx, { duration: 2.2, decay: 3.3, brightness: 0.62 });
    } catch (e) { this.convolver = null; }
    const ret = ctx.createGain();
    ret.gain.value = 0.9;
    this.reverbSend.connect(pre);
    if (this.convolver) {
      pre.connect(this.convolver);
      this.convolver.connect(ret);
    } else {
      pre.connect(ret); // graceful fallback: pre-delayed slap
    }
    ret.connect(this.comp);
  }

  // ------------------------------------------------------------------ unlock

  forceUnlock() {
    if (!this.supported || !this.ctx) return;
    try {
      const st = this.ctx.state;
      if (st === 'suspended' || st === 'interrupted') {
        const p = this.ctx.resume();
        if (p && p.then) p.then(() => this._onRunning(), () => {});
      } else if (st === 'running') {
        this._onRunning();
      }
    } catch (e) { /* never throw */ }
  }

  _onRunning() {
    if (this._unlockedOnce) { this._startAmbience(); return; }
    this._unlockedOnce = true;
    const t = this.ctx.currentTime;
    this.master.gain.setValueAtTime(0, t);
    this.master.gain.setTargetAtTime(0.85, t, 0.18); // gentle fade-up
    this._startAmbience();
  }

  // ------------------------------------------------------------------ API

  // Play a named sound. opts: { position:Vector3, volume, pitch, material }.
  // NEVER throws — unknown names and unsupported environments just return false.
  play(name, opts) {
    try {
      if (!this.supported || !this.ctx || this.ctx.state === 'closed') return false;
      const recipe = RECIPES[name];
      if (!recipe) return false;

      // Voice cap: protect against pathological spam; critical sounds get a
      // higher ceiling (but still capped — a suspended/headless context never
      // retires voices because its clock is frozen).
      const critical = name.indexOf('shot') === 0 || name === 'explosion' ||
        name === 'player_hurt' || name === 'death';
      if (this._voices.length > 64 && !critical) return false;
      if (this._voices.length > 180) return false;

      // Dedup gate: same sound retriggered within a few ms (e.g. an event handler
      // AND a direct play() call for the same moment) — keep the first only.
      const now = this.ctx.currentTime;
      const last = this._lastPlay.get(name);
      const gate = name.indexOf('shot') === 0 ? 0.045 : 0.03;
      if (last != null && now - last < gate) return false;
      this._lastPlay.set(name, now);

      const o = Object.assign({}, opts);
      let d = 0;
      if (o.position) d = this._distTo(o.position);
      o._dist = d;
      // Speed-of-sound flight time for distant events (capped) — sells scale.
      o._delay = d > 5 ? Math.min(d / 340, 0.4) : 0;
      o._t0 = now + o._delay;
      recipe(this, o);
      return true;
    } catch (e) {
      return false; // contract: play() must never throw
    }
  }

  // Harness hook: preview any sound headlessly. Places it 6m ahead of the
  // camera so the full spatial path (panner + distance + reverb) executes.
  debugShot(name) {
    try {
      this.forceUnlock();
      const cam = this.game && this.game.camera;
      let pos;
      if (cam && cam.getWorldDirection) {
        pos = cam.getWorldDirection(this._tmpPos).clone().multiplyScalar(6).add(cam.position);
      }
      return this.play(name || 'shot_m4', { position: pos, volume: 1 });
    } catch (e) { return false; }
  }

  setListenerFromCamera(camera) {
    try {
      const cam = camera || (this.game && this.game.camera);
      if (!cam) return;
      if (cam.position) this.listenerPos.copy(cam.position);
      if (cam.getWorldDirection) cam.getWorldDirection(this._fwd);
      if (cam.quaternion) this._up.set(0, 1, 0).applyQuaternion(cam.quaternion);
      if (!this.ctx) return;
      const L = this.ctx.listener;
      if (!L) return;
      const t = this.ctx.currentTime;
      this._setParam(L.positionX, this.listenerPos.x, t);
      this._setParam(L.positionY, this.listenerPos.y, t);
      this._setParam(L.positionZ, this.listenerPos.z, t);
      this._setParam(L.forwardX, this._fwd.x, t);
      this._setParam(L.forwardY, this._fwd.y, t);
      this._setParam(L.forwardZ, this._fwd.z, t);
      this._setParam(L.upX, this._up.x, t);
      this._setParam(L.upY, this._up.y, t);
      this._setParam(L.upZ, this._up.z, t);
    } catch (e) {
      // very old Safari: fall back to the deprecated positional API
      try {
        const L = this.ctx && this.ctx.listener;
        if (L && L.setPosition) L.setPosition(this.listenerPos.x, this.listenerPos.y, this.listenerPos.z);
        if (L && L.setOrientation) L.setOrientation(this._fwd.x, this._fwd.y, this._fwd.z, this._up.x, this._up.y, this._up.z);
      } catch (e2) { /* ignore */ }
    }
  }

  _setParam(param, v, t) {
    if (!param) throw new Error('no param'); // -> caught by outer try, fallback path
    if (typeof param.setTargetAtTime === 'function') param.setTargetAtTime(v, t, 0.03);
    else param.value = v;
  }

  update(dt, game) {
    if (!this.supported || !this.ctx) return;
    try {
      const g = game || this.game;

      // Auto-unlock: capture harness sets allowPausedUpdate; also keep trying
      // after the first gesture until the context actually runs.
      if (this.ctx.state === 'suspended' || this.ctx.state === 'interrupted') {
        const can = (g && g.debug && g.debug.allowPausedUpdate) || this._gestureSeen;
        if (can) {
          this._resumeTimer -= dt;
          if (this._resumeTimer <= 0) { this._resumeTimer = 0.75; this.forceUnlock(); }
        }
      } else if (this.ctx.state === 'running' && !this._unlockedOnce) {
        // Context was allowed to start immediately (rare) — still fade up + start bed.
        this._onRunning();
      }

      this.setListenerFromCamera(g && g.camera);
      this._footsteps(dt, g);

      if (this._ambienceOn) {
        this._nextCreak -= dt;
        if (this._nextCreak <= 0) {
          this._nextCreak = rnd(8, 20);
          const ang = rnd(0, Math.PI * 2);
          const r = rnd(30, 70);
          this._tmpPos.set(
            this.listenerPos.x + Math.cos(ang) * r,
            this.listenerPos.y + rnd(0.5, 5),
            this.listenerPos.z + Math.sin(ang) * r
          );
          this.play('amb_creak', { position: this._tmpPos, volume: rnd(0.5, 1), pitch: rnd(0.85, 1.2) });
        }
      }

      this._prune();
    } catch (e) { /* never let audio take the game loop down */ }
  }

  // ------------------------------------------------------------------ routing

  // Connect a finished 'voice' node into the world:
  //  voice -> [distance air-absorption lowpass] -> [1/(1+d/10) gain] -> [HRTF panner] -> master
  //  voice -> [wet gain (wetter when far)] -> reverbSend
  // o.volume is applied here so recipes never have to think about it.
  route(voice, o, cfg) {
    cfg = cfg || {};
    const ctx = this.ctx;
    const d = o._dist || 0;
    const positioned = !!o.position && d > 0.6;
    const vol = clamp(o.volume == null ? 1 : o.volume, 0, 4);
    const wetBase = cfg.wet != null ? cfg.wet : 0.12;
    const airDiv = cfg.air != null ? cfg.air : 10;

    let tail = voice;
    if (positioned) {
      // air absorption: the lowpass closes as distance grows
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = clamp(16000 / (1 + d / airDiv), 320, 16000);
      lp.Q.value = 0.4;
      voice.connect(lp);
      tail = lp;
    }

    const g = ctx.createGain();
    g.gain.value = positioned ? vol / (1 + d / 10) : vol;
    tail.connect(g);

    if (positioned) {
      const p = ctx.createPanner();
      try { p.panningModel = 'HRTF'; } catch (e) { /* fall back to equalpower */ }
      p.distanceModel = 'linear';
      p.rolloffFactor = 0; // we do our own distance attenuation above
      p.refDistance = 1;
      p.maxDistance = 100000;
      const pos = o.position;
      if (p.positionX) {
        p.positionX.value = pos.x || 0;
        p.positionY.value = pos.y || 0;
        p.positionZ.value = pos.z || 0;
      } else if (p.setPosition) {
        p.setPosition(pos.x || 0, pos.y || 0, pos.z || 0);
      }
      g.connect(p);
      p.connect(this.master);
    } else {
      g.connect(this.master);
    }

    const wet = clamp(wetBase + (positioned ? Math.min(0.4, d / 180) : 0), 0, 0.95);
    if (wet > 0.01 && this.reverbSend) {
      const wg = ctx.createGain();
      wg.gain.value = wet * vol * (positioned ? Math.max(1 / (1 + d / 10), 0.3) : 1);
      voice.connect(wg);
      wg.connect(this.reverbSend);
    }
    return g;
  }

  track(node, until) {
    this._voices.push({ node, until });
  }

  _prune() {
    const t = this.ctx.currentTime;
    const v = this._voices;
    for (let i = v.length - 1; i >= 0; i--) {
      if (v[i].until <= t) {
        v[i] = v[v.length - 1];
        v.pop();
      }
    }
  }

  _distTo(pos) {
    const L = this.listenerPos;
    if (pos && typeof pos.distanceTo === 'function') {
      try { return pos.distanceTo(L); } catch (e) { /* fall through */ }
    }
    const dx = (pos.x || 0) - L.x;
    const dy = (pos.y || 0) - L.y;
    const dz = (pos.z || 0) - L.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // ------------------------------------------------------------------ gameplay hooks

  _onImpact(d) {
    if (!d) return;
    const mat = d.material || 'dirt';
    const known = { dirt: 1, concrete: 1, metal: 1, wood: 1, sandbag: 1, glass: 1, flesh: 1 };
    const name = 'impact_' + (known[mat] ? mat : 'dirt');
    this.play(name, { position: d.point, volume: 0.5, pitch: rnd(0.9, 1.15) });
  }

  _reloadSound(d, start) {
    const w = (d && d.weapon) || '';
    if (/1911|pistol/i.test(w)) {
      this.play(start ? 'reload_p1911' : 'reload_p1911_end');
    } else {
      this.play(start ? 'reload_m4_start' : 'reload_m4_end');
    }
  }

  // Player footsteps derived from movement (no footstep events exist upstream):
  // stride-distance accumulator + a raycast for the surface material underfoot.
  _footsteps(dt, g) {
    const p = g && g.player;
    if (!p || p.dead) { this._stepDist = 0; return; }
    const sp = p.hSpeed || 0;
    if (!p.onGround || sp < 1.2) { this._stepDist = 0; return; }
    this._stepDist += sp * dt;
    const stride = p.isSprinting ? 1.35 : 0.85;
    if (this._stepDist < stride) return;
    this._stepDist = 0;
    this._stepAlt = !this._stepAlt;

    let material = 'dirt';
    try {
      const lvl = g.level;
      if (lvl && typeof lvl.raycast === 'function' && p.position) {
        this._tmpOrigin.set(p.position.x, p.position.y + 0.4, p.position.z);
        const hit = lvl.raycast(this._tmpOrigin, DOWN, 1.6);
        if (hit && hit.material) material = hit.material;
      }
    } catch (e) { /* keep default */ }
    const known = { dirt: 1, concrete: 1, metal: 1, wood: 1, sandbag: 1, glass: 1 };
    const mat = known[material] ? material : 'dirt';
    const vol = clamp(0.22 + sp * 0.055, 0.2, 0.55) * (p.isSprinting ? 1.25 : 1);
    this.play('footstep_' + mat, { volume: vol, pitch: this._stepAlt ? 1.07 : 0.94 });
  }

  // ------------------------------------------------------------------ ambience

  // Continuous bed: gusting wind (looped noise + drifting lowpass + gain LFOs),
  // a faint distant sine-cluster rumble, and rare far-away metal creaks
  // (scheduled in update, 8-20s apart).
  _startAmbience() {
    if (this._ambienceOn || !this.ctx || this.ctx.state !== 'running') return;
    this._ambienceOn = true;
    try {
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const bus = ctx.createGain();
      bus.gain.value = 0;
      bus.connect(this.master);
      bus.gain.setTargetAtTime(1, t, 1.6); // slow fade-in

      // --- wind
      const wind = ctx.createBufferSource();
      wind.buffer = noiseBuffer(ctx, 2);
      wind.loop = true;
      const wlp = ctx.createBiquadFilter();
      wlp.type = 'lowpass'; wlp.frequency.value = 380; wlp.Q.value = 0.6;
      const wg = ctx.createGain(); wg.gain.value = 0.055;
      wind.connect(wlp); wlp.connect(wg); wg.connect(bus);
      const lfo1 = ctx.createOscillator(); lfo1.frequency.value = 0.07;
      const lfo1g = ctx.createGain(); lfo1g.gain.value = 0.028;
      lfo1.connect(lfo1g); lfo1g.connect(wg.gain);           // gusts
      const lfo2 = ctx.createOscillator(); lfo2.frequency.value = 0.045;
      const lfo2g = ctx.createGain(); lfo2g.gain.value = 140;
      lfo2.connect(lfo2g); lfo2g.connect(wlp.frequency);     // filter drift
      // high whistling layer
      const whistle = ctx.createBufferSource();
      whistle.buffer = wind.buffer; whistle.loop = true; whistle.playbackRate.value = 1.31;
      const wbp = ctx.createBiquadFilter();
      wbp.type = 'bandpass'; wbp.frequency.value = 950; wbp.Q.value = 5;
      const w2g = ctx.createGain(); w2g.gain.value = 0.01;
      whistle.connect(wbp); wbp.connect(w2g); w2g.connect(bus);
      const lfo3 = ctx.createOscillator(); lfo3.frequency.value = 0.11;
      const lfo3g = ctx.createGain(); lfo3g.gain.value = 0.007;
      lfo3.connect(lfo3g); lfo3g.connect(w2g.gain);

      // --- distant rumble: very low sine cluster, slow breathing
      const rumbles = [];
      [31.5, 38.2, 44.7].forEach((f, i) => {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
        const og = ctx.createGain(); og.gain.value = 0.013;
        o.connect(og); og.connect(bus);
        const rl = ctx.createOscillator(); rl.frequency.value = 0.03 + i * 0.017;
        const rlg = ctx.createGain(); rlg.gain.value = 0.006;
        rl.connect(rlg); rlg.connect(og.gain);
        o.start(t); rl.start(t);
        rumbles.push(o, rl);
      });

      wind.start(t); lfo1.start(t); lfo2.start(t); whistle.start(t); lfo3.start(t);
      this._ambienceNodes = { bus, wind, whistle, lfo1, lfo2, lfo3, rumbles };
      this._nextCreak = rnd(5, 10);
    } catch (e) { /* ambience is decorative — never fatal */ }
  }
}
