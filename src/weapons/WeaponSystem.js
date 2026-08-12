import * as THREE from 'three';
import { WEAPON_DEFS, WEAPON_ORDER } from './WeaponDefs.js';
import { createWeaponMaterials } from './GunBuilders.js';
import { ViewModel } from './ViewModel.js';

// ---------------------------------------------------------------------------
// WeaponSystem — M4A1 (full-auto) + P1911 (semi-auto), hitscan, procedural
// viewmodels. Contract: init(game), update(dt, game), `current` always
// exposes { name, adsFov }, and debugFire() performs one full shot cycle
// with zero input (used by the capture harness while paused).
//
// Everything cross-system (fx / audio / enemies / level) is guarded: while
// other agents' systems are stubs, nothing here can throw.
// ---------------------------------------------------------------------------

const SWITCH_OUT_TIME = 0.18; // lower old weapon
const SWITCH_IN_TIME = 0.30;  // raise new weapon
const SPRINT_DROP_TIME = 0.16;
const RAISE_FIRE_GATE = 0.95; // raise*raiseTime ≈ 0.34s sprint-to-fire delay
const SUSTAIN_RESET_TIME = 0.45;

function approach(cur, target, delta) {
  if (cur < target) return Math.min(cur + delta, target);
  return Math.max(cur - delta, target);
}

function smooth01(t) {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
}

export class WeaponSystem {
  constructor(game) {
    this.game = game;
    this.current = { name: 'M4A1', adsFov: WEAPON_DEFS.M4A1.adsFov, mag: 0, reserve: 0 };
    this._weapons = {};
    for (const n of WEAPON_ORDER) {
      const d = WEAPON_DEFS[n];
      this._weapons[n] = { def: d, mag: d.magSize, reserve: d.reserveStart };
    }
    this.current.mag = this._weapons.M4A1.mag;
    this.current.reserve = this._weapons.M4A1.reserve;

    this._vm = null;
    this._raise = 1;             // 0 = sprinted/lowered, 1 = ready
    this._fireTimer = 0;
    this._reloading = false;
    this._reloadT = 0;
    this._reloadSlideLock = false;
    this._autoReloadT = 0;
    this._switching = false;
    this._switchT = 0;
    this._switchPhase = 0;
    this._switchTarget = '';
    this._sustained = 0;
    this._sustainT = 99;
    this._lastTrigger = false;
    this._pd1 = false;
    this._pd2 = false;
    this._adsSup = 1;            // ADS suppression while reloading/switching

    // preallocated firing-path temporaries (no per-shot geometry allocation
    // beyond the event payloads themselves)
    this._dir = new THREE.Vector3();
    this._origin = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._far = new THREE.Vector3();
    this._muzz = new THREE.Vector3();
    this._eject = new THREE.Vector3();
    this._ejectDir = new THREE.Vector3();

    this._vmState = {
      adsEff: 0, lower: 0, switchLower: 0, reloadU: -1, slideLock: false,
      time: 0, bobTime: 0, hSpeed: 0, raise: 1, def: null, vel: null, camera: null,
    };
  }

  init(game) {
    const renderer = game.engine && game.engine.renderer;
    const mats = createWeaponMaterials(renderer);
    this._vm = new ViewModel(WEAPON_DEFS);
    this._vm.build(mats);

    // Viewmodels render as children of the camera; the camera must be part of
    // the scene graph for that traversal to happen.
    const cam = game.camera;
    if (cam && game.scene && cam.parent !== game.scene) game.scene.add(cam);
    if (cam) cam.add(this._vm.root);
    this._vm.setActive(this.current.name);

    if (game.events && game.events.on) {
      game.events.on('player-dead', () => {
        if (this._reloading) {
          this._reloading = false;
          this._reloadT = 0;
          this._emitEvent('reload-end', { weapon: this.current.name, cancelled: true });
        }
      });
      game.events.on('player-respawn', () => { this._raise = 0; if (this._vm) this._vm.resetKick(); });
    }

    // settle transforms once so markers have valid world matrices pre-first-frame
    this._vm.update(0, this._buildVmState(game, 0));

    this._emitAmmo();
    this._emitEvent('weapon-changed', { weapon: this.current.name });
  }

  update(dt, game) {
    const p = game.player;
    const input = game.input;
    if (!p || !input || !this._vm) return;
    const active = !game.paused || (game.debug && game.debug.allowPausedUpdate);
    const wName = this.current.name;
    const w = this._weapons[wName];
    const def = w.def;

    // --- weapon switching: Digit1 / Digit2 / mouse wheel ---
    const wheel = typeof input.consumeWheel === 'function' ? input.consumeWheel() : 0;
    const d1 = !!input.down('Digit1');
    const d2 = !!input.down('Digit2');
    if (active && !p.dead) {
      if (wheel !== 0) {
        this._requestSwitch(wName === WEAPON_ORDER[0] ? WEAPON_ORDER[1] : WEAPON_ORDER[0]);
      } else if (d1 && !this._pd1) {
        this._requestSwitch(WEAPON_ORDER[0]);
      } else if (d2 && !this._pd2) {
        this._requestSwitch(WEAPON_ORDER[1]);
      }
    }
    this._pd1 = d1;
    this._pd2 = d2;

    // --- raise / sprint-lower ---
    const lowered = p.dead || p.isSprinting;
    this._raise = lowered
      ? approach(this._raise, 0, dt / SPRINT_DROP_TIME)
      : approach(this._raise, 1, dt / def.raiseTime);

    // --- reload ---
    if (this._reloading) {
      this._reloadT += dt;
      if (this._reloadT >= def.reloadTime) this._finishReload();
    }
    if (this._autoReloadT > 0) {
      this._autoReloadT -= dt;
      if (this._autoReloadT <= 0) this._startReload();
    }
    if (active && !p.dead && !this._reloading && !this._switching &&
        this._raise > 0.9 && typeof input.down === 'function' && input.down('KeyR')) {
      this._startReload();
    }

    // --- firing ---
    this._fireTimer = Math.max(0, this._fireTimer - dt);
    this._sustainT += dt;
    if (this._sustainT > SUSTAIN_RESET_TIME) this._sustained = 0;
    const triggerHeld = !!input.button(0) && active && !p.dead;
    const edge = triggerHeld && !this._lastTrigger;
    this._lastTrigger = triggerHeld;
    const canFire = !this._reloading && !this._switching && this._raise > RAISE_FIRE_GATE &&
      w.mag > 0 && this._fireTimer <= 0;
    if (triggerHeld && canFire && (def.auto || edge)) {
      this._fireShot(game);
    } else if (edge && w.mag <= 0 && !this._reloading && active) {
      this._playSound('dryfire', 0.5);
      if (this._autoReloadT <= 0) this._autoReloadT = 0.16;
    }

    // --- switch animation ---
    let switchLower = 0;
    if (this._switching) {
      this._switchT += dt;
      if (this._switchPhase === 0) {
        switchLower = smooth01(this._switchT / SWITCH_OUT_TIME);
        if (this._switchT >= SWITCH_OUT_TIME) {
          this._activate(this._switchTarget);
          this._switchPhase = 1;
          this._switchT = 0;
        }
      } else {
        switchLower = 1 - smooth01(this._switchT / SWITCH_IN_TIME);
        if (this._switchT >= SWITCH_IN_TIME) {
          this._switching = false;
          switchLower = 0;
        }
      }
    }

    // --- ADS suppression while reloading/switching ---
    this._adsSup = THREE.MathUtils.damp(this._adsSup, (this._reloading || this._switching) ? 0 : 1, 10, dt);

    // --- drive the viewmodel ---
    this._vm.update(dt, this._buildVmState(game, switchLower));
  }

  // -------------------------------------------------------------------------
  // Capture-harness hook: one full shot cycle with zero input. Works while
  // paused-with-allowPausedUpdate, and even with FX/audio/enemies still stubs.
  // -------------------------------------------------------------------------
  debugFire() {
    const game = this.game;
    if (!this._vm || !game) return;
    // force a clean, fireable state regardless of animation mid-states
    this._switching = false;
    this._reloading = false;
    this._autoReloadT = 0;
    this._raise = 1;
    this._adsSup = 1;
    const w = this._weapons[this.current.name];
    if (!w) return;
    if (w.mag <= 0) {
      if (w.reserve > 0) {
        const take = Math.min(w.def.magSize, w.reserve);
        w.mag = take;
        w.reserve -= take;
      } else {
        w.mag = w.def.magSize; // harness fallback: never hard-lock the capture
      }
      this._emitAmmo();
    }
    this._vm.update(0, this._buildVmState(game, 0)); // settle matrices for muzzle pos
    this._fireTimer = 0;
    this._sustained = 0;
    this._fireShot(game);
  }

  // -------------------------------------------------------------------------

  _buildVmState(game, switchLower) {
    const p = game.player;
    const st = this._vmState;
    const w = this._weapons[this.current.name];
    st.def = w.def;
    st.adsEff = (p.ads || 0) * this._adsSup;
    st.lower = 1 - this._raise;
    st.raise = this._raise;
    st.switchLower = switchLower;
    st.reloadU = this._reloading ? Math.min(1, this._reloadT / w.def.reloadTime) : -1;
    st.slideLock = this._reloadSlideLock;
    st.time = game.time || 0;
    st.bobTime = p.bobTime || 0;
    st.hSpeed = p.hSpeed || 0;
    st.vel = p.velocity;
    st.camera = game.camera;
    return st;
  }

  _requestSwitch(name) {
    if (!WEAPON_DEFS[name] || name === this.current.name || this._switching) return;
    if (this._reloading) {
      this._reloading = false;
      this._emitEvent('reload-end', { weapon: this.current.name, cancelled: true });
    }
    this._switching = true;
    this._switchPhase = 0;
    this._switchT = 0;
    this._switchTarget = name;
    this._autoReloadT = 0;
    this._playSound('weapon_switch', 0.7);
  }

  _activate(name) {
    const w = this._weapons[name];
    if (!w) return;
    this.current.name = name;
    this.current.adsFov = w.def.adsFov;
    this.current.mag = w.mag;
    this.current.reserve = w.reserve;
    if (this._vm) this._vm.setActive(name);
    this._fireTimer = 0;
    this._sustained = 0;
    this._lastTrigger = false;
    this._emitEvent('weapon-changed', { weapon: name });
    this._emitAmmo();
  }

  _startReload() {
    const w = this._weapons[this.current.name];
    const def = w.def;
    if (this._reloading || this._switching) return;
    if (w.mag >= def.magSize || w.reserve <= 0) return;
    this._reloading = true;
    this._reloadT = 0;
    this._reloadSlideLock = w.mag <= 0; // empty 1911 locks the slide back
    this._emitEvent('reload-start', { weapon: def.name });
    this._playSound(def.kind === 'pistol' ? 'reload_start_p1911' : 'reload_start_m4', 0.85);
  }

  _finishReload() {
    const w = this._weapons[this.current.name];
    const def = w.def;
    const take = Math.min(def.magSize - w.mag, w.reserve);
    w.mag += take;
    w.reserve -= take;
    this._reloading = false;
    this._emitEvent('reload-end', { weapon: def.name });
    this._emitAmmo();
  }

  _fireShot(game) {
    const p = game.player;
    const cam = game.camera;
    const w = this._weapons[this.current.name];
    const def = w.def;
    if (!p || !cam || w.mag <= 0) return;

    w.mag--;
    this._emitAmmo();
    // carry the negative remainder so frame quantization doesn't drag the
    // effective rpm below the tuned value (700rpm stays 700rpm at 60fps)
    this._fireTimer += 60 / def.rpm;
    this._sustained = Math.min(this._sustained + 1, 8);
    this._sustainT = 0;

    // --- aim: camera center + spread cone ---
    cam.getWorldDirection(this._dir);
    this._right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    this._up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const sp = def.spread;
    const moveAmt = Math.min((p.hSpeed || 0) / 7.4, 1);
    let spread = sp.hip + sp.move * moveAmt + (p.isSprinting ? sp.sprint : 0);
    const a = p.ads || 0;
    const adsS = a * a * (3 - 2 * a);
    spread += (sp.ads + sp.move * moveAmt * sp.adsMoveScale - spread) * adsS;
    if (spread > 1e-5) {
      const r = spread * Math.sqrt(Math.random());
      const th = Math.random() * Math.PI * 2;
      this._dir.addScaledVector(this._right, Math.cos(th) * r)
        .addScaledVector(this._up, Math.sin(th) * r)
        .normalize();
    }
    cam.getWorldPosition(this._origin);

    // --- raycast: enemies first, then level; nearest wins ---
    let npcHit = null;
    let worldHit = null;
    const enemies = game.enemies;
    if (enemies && typeof enemies.raycastTargets === 'function') {
      try { npcHit = enemies.raycastTargets(this._origin, this._dir, def.range); } catch (e) { npcHit = null; }
    }
    const level = game.level;
    if (level && typeof level.raycast === 'function') {
      try { worldHit = level.raycast(this._origin, this._dir, def.range); } catch (e) { worldHit = null; }
    }
    let bestDist = Infinity;
    let useNpc = false;
    let useWorld = false;
    if (npcHit && npcHit.point) {
      bestDist = typeof npcHit.distance === 'number' ? npcHit.distance : npcHit.point.distanceTo(this._origin);
      useNpc = true;
    }
    if (worldHit && worldHit.point) {
      const d = worldHit.point.distanceTo(this._origin);
      if (d < bestDist) { bestDist = d; useNpc = false; useWorld = true; }
    }
    const hitDist = bestDist === Infinity ? def.range : Math.min(bestDist, def.range);
    this._far.copy(this._dir).multiplyScalar(hitDist).add(this._origin);

    const fx = game.fx;
    let hitNpc = null;
    if (useNpc) {
      const head = npcHit.part === 'head';
      const dmg = def.damage * (head ? def.headMult : 1);
      hitNpc = npcHit.npc;
      if (enemies && typeof enemies.damage === 'function') {
        try { enemies.damage(npcHit.npc, dmg, npcHit.point, { headshot: head }); } catch (e) { /* stub */ }
      }
      this._emitEvent('npc-hit', { npc: npcHit.npc, damage: dmg, point: npcHit.point, headshot: head });
      if (fx && typeof fx.blood === 'function') {
        try { fx.blood(npcHit.point, this._dir); } catch (e) { /* stub */ }
      }
    } else if (useWorld) {
      this._emitEvent('impact', { point: worldHit.point, normal: worldHit.normal, material: worldHit.material, weapon: def.name });
      if (fx && typeof fx.impact === 'function') {
        try { fx.impact(worldHit.point, worldHit.normal, worldHit.material, { weapon: def.name }); } catch (e) { /* stub */ }
      }
    }
    this._emitEvent('shot', {
      weapon: def.name,
      origin: this._origin.clone(),
      dir: this._dir.clone(),
      hitPoint: (useNpc || useWorld) ? this._far.clone() : null,
      npc: hitNpc,
    });

    // --- FX: muzzle flash, tracer, shell (all no-op-safe) ---
    if (this._vm) this._vm.muzzleWorld(this._muzz);
    if (fx) {
      if (typeof fx.muzzleFlash === 'function') {
        try { fx.muzzleFlash(this._muzz, this._dir, def.name); } catch (e) { /* stub */ }
      }
      if (typeof fx.tracer === 'function') {
        try { fx.tracer(this._muzz, this._far, { weapon: def.name }); } catch (e) { /* stub */ }
      }
      if (typeof fx.shell === 'function' && this._vm) {
        this._vm.ejectWorld(this._eject);
        this._ejectDir.set(
          0.7 + Math.random() * 0.4,
          0.55 + Math.random() * 0.4,
          0.2 + Math.random() * 0.3
        ).applyQuaternion(cam.quaternion);
        try { fx.shell(this._eject, this._ejectDir); } catch (e) { /* stub */ }
      }
    }
    this._playSound(def.audioShot, 1);

    // --- camera punch + viewmodel kick ---
    const rc = def.recoil;
    const ramp = 1 + rc.sustainedRamp * Math.min(this._sustained, 6) / 6;
    const pitchKick = (rc.pitch + (Math.random() * 2 - 1) * rc.pitchJitter) * ramp;
    const yawKick = rc.yaw + (Math.random() * 2 - 1) * rc.yawJitter;
    if (typeof p.addRecoil === 'function') p.addRecoil(pitchKick, yawKick);
    if (this._vm) this._vm.impulse(def.vmKick);

    if (w.mag <= 0) this._autoReloadT = Math.max(this._autoReloadT, 0.24);
  }

  // -------------------------------------------------------------------------

  _emitEvent(name, data) {
    const ev = this.game && this.game.events;
    if (ev && typeof ev.emit === 'function') {
      try { ev.emit(name, data); } catch (e) { /* listener error must not kill firing */ }
    }
  }

  _emitAmmo() {
    this.current.mag = this._weapons[this.current.name].mag;
    this.current.reserve = this._weapons[this.current.name].reserve;
    this._emitEvent('ammo-changed', { mag: this.current.mag, reserve: this.current.reserve, weapon: this.current.name });
  }

  _playSound(name, volume) {
    const a = this.game && this.game.audio;
    if (a && typeof a.play === 'function') {
      try { a.play(name, { volume, pitch: 0.96 + Math.random() * 0.08 }); } catch (e) { /* stub */ }
    }
  }
}
