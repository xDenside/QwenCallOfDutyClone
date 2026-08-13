import * as THREE from 'three';
import { buildFXTextures } from './Textures.js';
import { PointsPool } from './PointsPool.js';
import { StreakPool } from './StreakPool.js';
import { DecalPool } from './DecalPool.js';

// ---------------------------------------------------------------------------
// EffectsSystem — pooled, hard-capped combat FX in the MW2019 spirit:
//   muzzleFlash / tracer / impact / explosion / shell / blood
// Every effect family is a GPU pool (Points or instanced quads) with a hard
// cap and zero per-frame allocation. Additive glows ignore fog; smoke/dust
// respect scene fog. Camera shake is applied after all systems update by
// wrapping engine.render at runtime (no core-file changes needed).
// ---------------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);
const EMPTY = {};

// scratch temps — never exposed, never allocated at runtime
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _rs = new THREE.Vector3();
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

// HDR-ish colour ramps (pre-tonemap)
const C_TRACER_P = [2.3, 2.0, 1.5];
const C_TRACER_E = [2.0, 1.2, 0.4];
const C_GLOW_P = [2.2, 1.5, 0.75];
const C_GLOW_E = [1.9, 1.15, 0.5];
const C_SPARK = [2.4, 1.35, 0.45];
const C_FIRE0 = [2.6, 1.4, 0.45];
const C_FIRE1 = [1.15, 0.32, 0.06];
const C_CORE0 = [3.0, 2.4, 1.5];
const C_CORE1 = [1.7, 0.7, 0.2];
const C_SMOKE_LIT = [0.55, 0.46, 0.38];
const C_SMOKE_MID = [0.42, 0.38, 0.34];
const C_SMOKE_DARK = [0.3, 0.28, 0.27];
const C_SMOKE_END = [0.145, 0.14, 0.135];
const C_BLOOD0 = [0.4, 0.05, 0.045];
const C_BLOOD1 = [0.17, 0.02, 0.02];
const C_DUST_CONC0 = [0.6, 0.56, 0.5];
const C_DUST_CONC1 = [0.42, 0.4, 0.36];
const C_DUST_DIRT0 = [0.55, 0.45, 0.33];
const C_DUST_DIRT1 = [0.4, 0.34, 0.27];
const C_DUST_BAG0 = [0.62, 0.55, 0.44];
const C_DUST_BAG1 = [0.44, 0.4, 0.33];
const C_DUST_WOOD0 = [0.5, 0.4, 0.28];
const C_DUST_WOOD1 = [0.36, 0.3, 0.22];
const C_SPLINTER = [0.4, 0.28, 0.15];
const C_GRAVEL0 = [1.7, 1.15, 0.5];
const C_GRAVEL1 = [0.9, 0.4, 0.1];
const C_GLASS0 = [1.5, 1.8, 2.1];
const C_GLASS1 = [0.6, 0.8, 1.0];
const C_METALSMOKE0 = [0.3, 0.29, 0.28];
const C_METALSMOKE1 = [0.18, 0.17, 0.17];
const C_WHITESMOKE0 = [0.75, 0.8, 0.85];
const C_WHITESMOKE1 = [0.5, 0.55, 0.6];

// muzzle scale per known player weapon (anything unknown defaults to 1.0)
const FLASH_SCALE = {
  M4A1: 1.0, M4: 1.0, 'AK-47': 1.05, AK47: 1.05, MP5: 0.85, SCAR: 1.05,
  M249: 1.15, Barrett: 1.3, M82: 1.3, Deagle: 1.2, DesertEagle: 1.2,
  Glock: 0.8, Pistol: 0.8
};

function rndSphere(out) {
  let x, y, z, l2;
  do {
    x = Math.random() * 2 - 1;
    y = Math.random() * 2 - 1;
    z = Math.random() * 2 - 1;
    l2 = x * x + y * y + z * z;
  } while (l2 > 1 || l2 < 1e-4);
  const inv = 1 / Math.sqrt(l2);
  out.set(x * inv, y * inv, z * inv);
  return out;
}

function coneDir(out, n, spread) {
  rndSphere(_rs);
  out.set(n.x + _rs.x * spread, n.y + _rs.y * spread, n.z + _rs.z * spread);
  if (out.lengthSq() < 1e-6) out.copy(n);
  return out.normalize();
}

export class EffectsSystem {
  constructor(game) {
    this.game = game;
    this.ready = false;
    this._time = 0;
  }

  // ------------------------------------------------------------------ init
  init(game) {
    try {
      this._init(game);
      this.ready = true;
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[fx] init failed, FX disabled:', e);
    }
  }

  _init(game) {
    this.game = game;
    this.scene = game.scene;
    this.camera = game.camera;
    this.renderer = game.renderer;
    this._lastH = 0;
    this._time = (game && isFinite(game.time)) ? game.time : 0;

    const T = buildFXTextures();
    this.tex = T;
    this._smokeUVs = [T.UV.smokeA, T.UV.smokeB, T.UV.smokeC];

    // particle pools -------------------------------------------------------
    // normal-blended soft particles (smoke/dust/blood/splinters) — fog aware
    this.soft = new PointsPool(this.scene, T.atlasTex, {
      cap: 260, blending: THREE.NormalBlending, fog: true, renderOrder: 3
    });
    // additive glow particles (fireballs, embers, glints) — no fog
    this.glow = new PointsPool(this.scene, T.atlasTex, {
      cap: 180, blending: THREE.AdditiveBlending, fog: false, renderOrder: 6
    });
    // streak pools (tracers / metal sparks)
    this.tracers = new StreakPool(this.scene, T.atlasTex, T.UV.streak, { cap: 44, renderOrder: 7 });
    this.sparks = new StreakPool(this.scene, T.atlasTex, T.UV.streak, { cap: 110, renderOrder: 7 });
    // decals
    this.decals = new DecalPool(this.scene, T.hole, 80);
    this._dress();

    // muzzle flash sprites --------------------------------------------------
    this.flashes = [];
    for (let i = 0; i < 12; i++) {
      const mat = new THREE.SpriteMaterial({
        map: i % 2 ? T.starB : T.starA,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        fog: false,
        transparent: true,
        rotation: 0
      });
      const spr = new THREE.Sprite(mat);
      spr.visible = false;
      spr.renderOrder = 9;
      this.scene.add(spr);
      this.flashes.push({
        spr, mat, active: false, life: 0, maxLife: 1,
        baseScale: 1, rotA: 0, rotB: 0, scaleB: 1
      });
    }
    this._flashRR = 0;

    // pooled flash lights — always visible (intensity 0 when idle) so the
    // light count stays constant and shaders never recompile mid-game
    this.mLights = [];
    for (let i = 0; i < 9; i++) {
      const L = new THREE.PointLight(0xffc890, 0, 15, 2);
      this.scene.add(L);
      this.mLights.push({ L, active: false, life: 0, maxLife: 1, base: 0 });
    }
    this.bLights = [];
    for (let i = 0; i < 4; i++) {
      const L = new THREE.PointLight(0xff9a4d, 0, 36, 2);
      this.scene.add(L);
      this.bLights.push({ L, active: false, life: 0, maxLife: 1, base: 0 });
    }
    this._mRR = 0;
    this._bRR = 0;

    // brass shells ----------------------------------------------------------
    const shellGeo = new THREE.CapsuleGeometry(0.008, 0.022, 2, 6);
    const shellMat = new THREE.MeshStandardMaterial({ color: 0xc9a24b, metalness: 0.9, roughness: 0.35 });
    this.shellsMesh = new THREE.InstancedMesh(shellGeo, shellMat, 60);
    this.shellsMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shellsMesh.count = 0;
    this.shellsMesh.frustumCulled = false;
    this.scene.add(this.shellsMesh);
    this.shells = [];
    for (let i = 0; i < 60; i++) {
      this.shells.push({
        alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        ax: 0, ay: 0, az: 0, wax: 0, way: 0, waz: 0,
        settled: false, settleT: 0, s: 1
      });
    }
    this._shellRR = 0;
    this._lastShellCount = 0;

    // explosion debris ------------------------------------------------------
    const debGeo = new THREE.BoxGeometry(1, 1, 1);
    const debMat = new THREE.MeshStandardMaterial({ color: 0x6f5b49, roughness: 1, metalness: 0 });
    this.debMesh = new THREE.InstancedMesh(debGeo, debMat, 28);
    this.debMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debMesh.count = 0;
    this.debMesh.frustumCulled = false;
    this.scene.add(this.debMesh);
    this.debris = [];
    for (let i = 0; i < 28; i++) {
      this.debris.push({
        alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        ax: 0, ay: 0, az: 0, wax: 0, way: 0, waz: 0,
        life: 0, maxLife: 1, sx: 0.06, sy: 0.06, sz: 0.06
      });
    }
    this._debRR = 0;
    this._lastDebCount = 0;

    // shockwave rings ---------------------------------------------------------
    const ringGeo = new THREE.PlaneGeometry(1, 1);
    this.rings = [];
    for (let i = 0; i < 5; i++) {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        map: T.ring,
        color: new THREE.Color(1.35, 0.95, 0.62), // hot HDR tint, fog-free glow
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        fog: false,
        side: THREE.DoubleSide
      }));
      m.visible = false;
      m.renderOrder = 5;
      this.scene.add(m);
      this.rings.push({ m, active: false, life: 0, maxLife: 0.45, end: 8 });
    }
    this._ringRR = 0;

    // camera shake state ------------------------------------------------------
    this.shakeAmp = 0;
    this._nx = 0; this._ny = 0; this._nz = 0;
    this._nrx = 0; this._nry = 0; this._nrz = 0;
    this._tx = 0; this._ty = 0; this._tz = 0;
    this._trx = 0; this._try = 0; this._trz = 0;
    this._retT = 0;
    this._aox = 0; this._aoy = 0; this._aoz = 0;
    this._arx = 0; this._ary = 0; this._arz = 0;
    this._shakeApplied = false;

    // reusable spawn configs (zero-alloc API) ----------------------------------
    this._softCfg = {
      pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      life: 0.5, size0: 0.1, size1: 0.3, rot: 0, rotV: 0,
      drag: 0, grav: 0, turb: 0, alpha: 1,
      c0: C_SMOKE_MID, c1: C_SMOKE_END, uv: T.UV.smokeA
    };
    this._glowCfg = {
      pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      life: 0.3, size0: 0.05, size1: 0.03, rot: 0, rotV: 0,
      drag: 0, grav: 0, turb: 0, alpha: 1,
      c0: C_SPARK, c1: C_GRAVEL1, uv: T.UV.dot
    };
    this._tracerOpts = { speed: 520, width: 0.07, color: C_TRACER_P, droop: 0.5 };
    this._sparkOpts = { life: 0.3, width: 0.02, color: C_SPARK, grav: 15, lenK: 0.03 };
    this._hf = (x, z) => this._heightAt(x, z);

    // apply camera shake AFTER all systems updated, right before render
    const eng = game.engine;
    if (eng && !eng.__fxWrapped) {
      const orig = eng.render;
      const self = this;
      eng.render = function () {
        self._applyShake();
        try { orig.call(eng); } finally { self._unapplyShake(); }
      };
      eng.__fxWrapped = true;
    }
    if (game.debug && typeof game.debug === 'object' && !game.debug.shake) {
      game.debug.shake = (a) => this.cameraShake(a);
    }
  }

  /** Permanent bullet-hole clusters: the gate fight already happened here. */
  _dress() {
    let a = 0xC0FFEE;
    const rnd = () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const hole = (x, y, z, nz, s) => {
      this.decals.spawn(
        new THREE.Vector3(x + (rnd() - 0.5) * 0.35, y + (rnd() - 0.5) * 0.3, z),
        new THREE.Vector3(0, 0, nz), s, 0, 0.9, true
      );
    };
    // main building south face (z=-15.6, +Z): suppression around doors + window
    const wall = [
      [-21.6, 1.5], [-20.4, 1.75], [-21.1, 2.15], [-19.7, 1.3],
      [-7.5, 1.6], [-6.6, 1.95], [-8.3, 1.35],
      [-14.5, 1.15], [-13.3, 1.35], [-15.3, 1.05],
      [-25.2, 2.4], [-11.2, 2.6]
    ];
    // quads read ~4x the visible core, so size generously for distance legibility
    for (const [x, y] of wall) hole(x, y, -15.6, 1, 0.5 + rnd() * 0.3);
    // perimeter wall flanking the breached gate (z=51.8, -Z)
    const gate = [[-6, 1.5], [-7.2, 1.85], [-5.1, 2.2], [6.1, 1.6], [7.4, 1.3], [5.2, 2.0]];
    for (const [x, y] of gate) hole(x, y, 51.8, -1, 0.5 + rnd() * 0.3);
  }

  // ------------------------------------------------------------ public API

  /** Camera-facing star flash + glow particle + pooled PointLight. */
  muzzleFlash(pos, dir, weaponName, opts) {
    if (!this.ready || !pos || !dir) return;
    if (!opts) opts = EMPTY;
    const nm = weaponName == null ? '' : String(weaponName);
    let scale = FLASH_SCALE[nm] !== undefined ? FLASH_SCALE[nm] : 1.0;
    let enemy;
    if (opts.enemy !== undefined) {
      enemy = opts.enemy === true; // explicit flag always wins
    } else {
      enemy = /(^|[^a-z])(ai|npc|enemy)/i.test(nm);
      // distant shooters are NPCs — their flashes read smaller
      if (!enemy && this.camera && this.camera.position.distanceTo(pos) > 7) enemy = true;
    }
    if (enemy) scale *= 0.58;
    if (opts.scale) scale *= opts.scale;

    // sprite (2-frame scale/rotate variation)
    const f = this.flashes[this._flashRR];
    this._flashRR = (this._flashRR + 1) % this.flashes.length;
    f.active = true;
    f.life = 0;
    f.maxLife = 0.04 + Math.random() * 0.02; // 40–60 ms
    f.baseScale = 0.42 * scale * (0.92 + Math.random() * 0.2);
    f.rotA = Math.random() * Math.PI * 2;
    f.rotB = f.rotA + (0.5 + Math.random() * 1.6) * (Math.random() < 0.5 ? -1 : 1);
    f.scaleB = 1.25 + Math.random() * 0.25;
    f.spr.position.copy(pos).addScaledVector(dir, 0.16 + 0.12 * scale);
    f.spr.visible = true;
    if (enemy) f.mat.color.setRGB(2.2, 1.5, 0.8);
    else f.mat.color.setRGB(2.4, 1.95, 1.3);
    f.mat.rotation = f.rotA;
    f.mat.opacity = 1;

    // additive halo particle
    const cfg = this._glowCfg;
    cfg.pos.copy(pos).addScaledVector(dir, 0.12);
    cfg.vel.copy(dir).multiplyScalar(1.5);
    cfg.life = 0.05;
    cfg.size0 = 0.85 * scale;
    cfg.size1 = 1.55 * scale;
    cfg.drag = 2; cfg.grav = 0; cfg.turb = 0; cfg.rotV = 0; cfg.rot = 0;
    cfg.alpha = 0.95;
    cfg.c0 = enemy ? C_GLOW_E : C_GLOW_P;
    cfg.c1 = C_FIRE1;
    cfg.uv = this.tex.UV.glow;
    this.glow.spawn(cfg);

    // pooled point light so nearby geometry lights up
    const ml = this.mLights[this._mRR];
    this._mRR = (this._mRR + 1) % this.mLights.length;
    ml.active = true;
    ml.life = 0;
    ml.maxLife = 0.055 + Math.random() * 0.02;
    ml.base = (13 + Math.random() * 7) * (enemy ? 0.55 : 1) * (opts.intensity || 1);
    ml.L.position.copy(pos).addScaledVector(dir, 0.3);
    ml.L.color.setRGB(1, 0.78, 0.52);
    ml.L.intensity = ml.base;
  }

  /** Bright travelling streak from -> to (~480-560 m/s). Warm white player, amber enemy. */
  tracer(from, to, opts) {
    if (!this.ready || !from || !to) return;
    if (!opts) opts = EMPTY;
    let enemy;
    if (opts.enemy !== undefined) {
      enemy = opts.enemy === true;
    } else {
      // player tracers always start at the muzzle next to the camera — a
      // distant origin is NPC fire (AI may call us without an enemy flag)
      enemy = this.camera ? this.camera.position.distanceTo(from) > 7 : false;
    }
    const o = this._tracerOpts;
    o.speed = opts.speed || (enemy ? 480 : 560);
    o.width = opts.width || (enemy ? 0.05 : 0.075);
    o.color = opts.color || (enemy ? C_TRACER_E : C_TRACER_P);
    o.droop = opts.droop !== undefined ? opts.droop : 0.5;
    this.tracers.spawnTracer(from, to, o);
  }

  /** Material-driven impact response + bullet-hole decal for solid materials. */
  impact(point, normal, material, opts) {
    if (!this.ready || !point) return;
    if (!opts) opts = EMPTY;
    let n = normal && isFinite(normal.x) && isFinite(normal.y) && isFinite(normal.z) ? normal : UP;
    if (!(n.x * n.x + n.y * n.y + n.z * n.z > 1e-8)) n = UP;
    const mat = typeof material === 'string' ? material.toLowerCase() : 'dirt';
    switch (mat) {
      case 'metal': this._impactMetal(point, n, opts); break;
      case 'wood': this._impactWood(point, n); break;
      case 'sandbag': this._impactSandbag(point, n); break;
      case 'glass': this._impactGlass(point, n); break;
      case 'flesh': this.blood(point, opts.dir || n); break;
      case 'concrete': this._impactConcrete(point, n); break;
      case 'dirt':
      default: this._impactDirt(point, n); break;
    }
  }

  /** Layered explosion: fireball, smoke column, embers, dust ring, shockwave,
   *  light, debris, camera shake. Visuals only — weapons/AI own the
   *  'explosion' event; we never emit it. */
  explosion(point, opts) {
    if (!this.ready || !point) return;
    if (!opts) opts = EMPTY;
    const s = opts.scale || 1;
    const on = opts.normal;
    const nrm = on && isFinite(on.x) && isFinite(on.y) && isFinite(on.z) &&
      (on.x * on.x + on.y * on.y + on.z * on.z > 1e-8) ? on : UP;

    // (a) fireball — 8-14 fast additive sprites
    const nf = 8 + ((Math.random() * 6) | 0);
    for (let i = 0; i < nf; i++) {
      rndSphere(_v2);
      const cfg = this._glowCfg;
      cfg.pos.copy(point).addScaledVector(_v2, 0.2 * s);
      cfg.vel.copy(_v2).multiplyScalar((1.6 + Math.random() * 3.2) * s);
      cfg.vel.y += 1.2 * s;
      cfg.life = 0.32 + Math.random() * 0.22;
      cfg.size0 = (0.5 + Math.random() * 0.45) * s;
      cfg.size1 = cfg.size0 * (2.6 + Math.random() * 1.2);
      cfg.drag = 2.5; cfg.grav = 0; cfg.turb = 0; cfg.rot = Math.random() * 6.28; cfg.rotV = (Math.random() - 0.5) * 3;
      cfg.alpha = 1;
      cfg.c0 = C_FIRE0; cfg.c1 = C_FIRE1;
      cfg.uv = this.tex.UV.fire;
      this.glow.spawn(cfg);
    }
    // white-hot core
    {
      const cfg = this._glowCfg;
      cfg.pos.copy(point);
      cfg.vel.set(0, 0.5, 0);
      cfg.life = 0.1;
      cfg.size0 = 1.9 * s; cfg.size1 = 2.6 * s;
      cfg.drag = 0; cfg.grav = 0; cfg.turb = 0; cfg.rot = 0; cfg.rotV = 0;
      cfg.alpha = 1;
      cfg.c0 = C_CORE0; cfg.c1 = C_CORE1;
      cfg.uv = this.tex.UV.glow;
      this.glow.spawn(cfg);
    }

    // (b) smoke column — rising turbulent sprites, lit warm at first
    const ns = Math.round((16 + ((Math.random() * 10) | 0)) * Math.min(s, 1.6));
    for (let i = 0; i < ns; i++) {
      rndSphere(_v2);
      const cfg = this._softCfg;
      cfg.pos.copy(point).addScaledVector(_v2, 0.35 * s);
      cfg.vel.set(_v2.x * 1.5 * s, (1.6 + Math.random() * 2.2) * s + Math.abs(_v2.y), _v2.z * 1.5 * s);
      cfg.life = 2.6 + Math.random() * 1.2;
      cfg.size0 = (0.6 + Math.random() * 0.5) * s;
      cfg.size1 = cfg.size0 * (3.6 + Math.random() * 1.6);
      cfg.rot = Math.random() * 6.28; cfg.rotV = (Math.random() - 0.5) * 1.2;
      cfg.drag = 1.1; cfg.grav = -0.55; cfg.turb = 1.5;
      cfg.alpha = 0.85;
      const r = Math.random();
      cfg.c0 = r < 0.35 ? C_SMOKE_LIT : (r < 0.75 ? C_SMOKE_MID : C_SMOKE_DARK);
      cfg.c1 = C_SMOKE_END;
      cfg.uv = this._smokeUVs[(Math.random() * 3) | 0];
      this.soft.spawn(cfg);
    }

    // (b2) embers — hot glowing motes drifting up out of the fireball
    const ne = 6 + ((Math.random() * 5) | 0);
    for (let i = 0; i < ne; i++) {
      rndSphere(_v2);
      const cfg = this._glowCfg;
      cfg.pos.copy(point).addScaledVector(_v2, 0.3 * s);
      cfg.vel.set(_v2.x * 1.4 * s, (1.5 + Math.random() * 2.6) * s, _v2.z * 1.4 * s);
      cfg.life = 0.9 + Math.random() * 0.9;
      cfg.size0 = (0.045 + Math.random() * 0.03) * Math.min(s, 1.5);
      cfg.size1 = cfg.size0 * 0.5;
      cfg.drag = 1.2; cfg.grav = -0.6; cfg.turb = 2.4;
      cfg.rot = 0; cfg.rotV = 0;
      cfg.alpha = 1;
      cfg.c0 = C_GRAVEL0; cfg.c1 = C_FIRE1;
      cfg.uv = this.tex.UV.dot;
      this.glow.spawn(cfg);
    }

    // (b3) ground dust ring sweeping outward ahead of the shockwave
    const nd = 7 + ((Math.random() * 3) | 0);
    for (let i = 0; i < nd; i++) {
      rndSphere(_v2);
      _v2.y = 0;
      if (_v2.x * _v2.x + _v2.z * _v2.z < 1e-4) _v2.set(1, 0, 0);
      _v2.normalize();
      const cfg = this._softCfg;
      cfg.pos.copy(point).addScaledVector(_v2, 0.3 * s);
      cfg.pos.y += 0.05;
      cfg.vel.copy(_v2).multiplyScalar((3.5 + Math.random() * 3.5) * s);
      cfg.vel.y = (0.4 + Math.random() * 0.7) * s;
      cfg.life = 0.65 + Math.random() * 0.5;
      cfg.size0 = (0.3 + Math.random() * 0.2) * s;
      cfg.size1 = cfg.size0 * 2.6;
      cfg.rot = Math.random() * 6.28; cfg.rotV = (Math.random() - 0.5) * 1.5;
      cfg.drag = 2.4; cfg.grav = -0.12; cfg.turb = 1.4;
      cfg.alpha = 0.5;
      cfg.c0 = C_DUST_DIRT0; cfg.c1 = C_DUST_DIRT1;
      cfg.uv = this._smokeUVs[(Math.random() * 3) | 0];
      this.soft.spawn(cfg);
    }

    // (c) ground shockwave ring
    const ring = this.rings[this._ringRR];
    this._ringRR = (this._ringRR + 1) % this.rings.length;
    ring.active = true;
    ring.life = 0;
    ring.maxLife = 0.42 + Math.random() * 0.1;
    ring.end = (7 + Math.random() * 2.5) * s;
    ring.m.position.copy(point).addScaledVector(nrm, 0.05);
    _q.setFromUnitVectors(_v1.set(0, 0, 1), nrm);
    ring.m.quaternion.copy(_q);
    ring.m.visible = true;

    // (d) big pooled flash light
    const bl = this.bLights[this._bRR];
    this._bRR = (this._bRR + 1) % this.bLights.length;
    bl.active = true;
    bl.life = 0;
    bl.maxLife = 0.32 + Math.random() * 0.1;
    bl.base = (140 + Math.random() * 60) * s;
    bl.L.position.copy(point).addScaledVector(UP, 0.6 * s);
    bl.L.color.setRGB(1, 0.6, 0.3);
    bl.L.intensity = bl.base;

    // (e) debris chunks
    this._spawnDebris(point, 8 + ((Math.random() * 4) | 0), s);

    // scorch mark
    this.decals.spawn(point, nrm, (1.4 + Math.random() * 0.8) * s, this._time, 0.85);

    // (f) camera shake — visuals only, the 'explosion' event is owned by weapons/AI
    if (this.camera) {
      const d = this.camera.position.distanceTo(point);
      const a = 1.5 * (1 - d / 28) * Math.sqrt(s);
      if (a > 0) this.cameraShake(Math.min(0.9, a));
    }
  }

  /** Ejected brass casing: right+up, spin, one bounce, settle, fade after 6 s. */
  shell(pos, dir) {
    if (!this.ready || !pos || !dir) return;
    const sh = this.shells[this._shellRR];
    this._shellRR = (this._shellRR + 1) % this.shells.length;
    _v1.crossVectors(dir, UP);
    if (_v1.lengthSq() < 1e-6) _v1.set(1, 0, 0);
    _v1.normalize();
    sh.alive = true;
    sh.x = pos.x + _v1.x * 0.05;
    sh.y = pos.y + 0.02;
    sh.z = pos.z + _v1.z * 0.05;
    const r = 1.3 + Math.random() * 0.9;
    const f = Math.random() * 0.5 - 0.15;
    sh.vx = _v1.x * r + dir.x * f + (Math.random() - 0.5) * 0.3;
    sh.vy = 1.5 + Math.random() * 1.2 + dir.y * 0.3;
    sh.vz = _v1.z * r + dir.z * f + (Math.random() - 0.5) * 0.3;
    sh.ax = Math.random() * 6.28; sh.ay = Math.random() * 6.28; sh.az = Math.random() * 6.28;
    sh.wax = (Math.random() - 0.5) * 28;
    sh.way = (Math.random() - 0.5) * 28;
    sh.waz = (Math.random() - 0.5) * 28;
    sh.settled = false;
    sh.settleT = 0;
    sh.s = 0.85 + Math.random() * 0.3;
  }

  /** Subtle dark-red puff (4-6 particles). */
  blood(point, dir) {
    if (!this.ready || !point) return;
    const d = dir && isFinite(dir.x) ? dir : UP;
    const count = 4 + ((Math.random() * 3) | 0);
    for (let i = 0; i < count; i++) {
      coneDir(_v2, d, 0.7);
      const cfg = this._softCfg;
      cfg.pos.copy(point).addScaledVector(_v2, 0.02);
      cfg.vel.copy(_v2).multiplyScalar(0.6 + Math.random() * 1.2);
      cfg.life = 0.2 + Math.random() * 0.18;
      cfg.size0 = 0.05 + Math.random() * 0.05;
      cfg.size1 = cfg.size0 * 1.9;
      cfg.rot = Math.random() * 6.28; cfg.rotV = (Math.random() - 0.5) * 4;
      cfg.drag = 1.5; cfg.grav = 2.5; cfg.turb = 0;
      cfg.alpha = 0.85;
      cfg.c0 = C_BLOOD0; cfg.c1 = C_BLOOD1;
      cfg.uv = this.tex.UV.splat;
      this.soft.spawn(cfg);
    }
  }

  /** Add decaying camera shake. Weapons/AI/debug may call this. */
  cameraShake(amount) {
    if (!this.ready || !(amount > 0)) return;
    this.shakeAmp = Math.min(1.35, this.shakeAmp + amount);
  }

  /** Self-test showcase used by the capture harness / debugging. */
  debugBurst() {
    if (!this.ready) return;
    try {
      const cam = this.camera;
      if (!cam) return;
      cam.getWorldDirection(_v1);
      _v2.copy(cam.position).addScaledVector(_v1, 9);
      const gy = this._heightAt(_v2.x, _v2.z);
      if (_v2.y < gy + 0.1) _v2.y = gy + 0.1;
      _v3.copy(cam.position).addScaledVector(_v1, 1.2);
      this.muzzleFlash(_v3, _v1, 'M4A1');
      this.tracer(_v3, _v2, { enemy: false });
      this.impact(_v2, UP, 'concrete', { dir: _v1 });
      _v4.copy(_v2); _v4.x += 0.7;
      this.impact(_v4, UP, 'metal', { dir: _v1 });
      this.shell(_v3, _v1);
      _v4.copy(cam.position).addScaledVector(_v1, 5);
      this.blood(_v4, _v1);
      _v5.copy(cam.position).addScaledVector(_v1, 6.5);
      _v5.y = this._heightAt(_v5.x, _v5.z) + 0.4;
      this.explosion(_v5, EMPTY);
    } catch (e) { /* never throw from debug */ }
  }

  // -------------------------------------------------------- impact variants

  _impactConcrete(p, n) {
    this._emitDust(p, n, 6 + ((Math.random() * 7) | 0), 1.4, 3.6, 0.9,
      C_DUST_CONC0, C_DUST_CONC1, 0.12, 3.4, 0.8, 1.5, 0.58, 0.22, 2.4, 0.7);
    this._emitGlowDots(p, n, 3 + ((Math.random() * 3) | 0), 0.8, 2.5, 6,
      C_GRAVEL0, C_GRAVEL1, 0.035, 0.22, 0.42, 9);
    this.decals.spawn(p, n, 0.1 * (0.85 + Math.random() * 0.3), this._time, 0.95);
  }

  _impactDirt(p, n) {
    this._emitDust(p, n, 8 + ((Math.random() * 6) | 0), 1.4, 3.2, 0.9,
      C_DUST_DIRT0, C_DUST_DIRT1, 0.14, 3.2, 0.8, 1.55, 0.6, 0.18, 2.2, 0.6);
    if (Math.random() < 0.5) {
      this._emitGlowDots(p, n, 2, 0.8, 2, 4.5, C_GRAVEL0, C_GRAVEL1, 0.03, 0.2, 0.35, 9);
    }
    this.decals.spawn(p, n, 0.15 * (0.85 + Math.random() * 0.3), this._time, 0.8);
  }

  _impactSandbag(p, n) {
    // heavy, billowing dust — sandbags throw a lot of fine material
    this._emitDust(p, n, 12 + ((Math.random() * 5) | 0), 1.2, 3.0, 1.0,
      C_DUST_BAG0, C_DUST_BAG1, 0.17, 3.8, 0.95, 1.8, 0.68, -0.15, 2.0, 0.8);
    this.decals.spawn(p, n, 0.17 * (0.85 + Math.random() * 0.3), this._time, 0.65);
  }

  _impactMetal(p, n, opts) {
    // bright orange spark streaks biased around the reflection direction
    if (opts.dir && isFinite(opts.dir.x)) {
      _v1.copy(opts.dir);
      const d = _v1.dot(n);
      _v1.addScaledVector(n, -2 * d);
      if (_v1.lengthSq() < 1e-4) _v1.copy(n);
      _v1.normalize();
    } else {
      _v1.copy(n);
    }
    const count = 6 + ((Math.random() * 5) | 0);
    for (let i = 0; i < count; i++) {
      coneDir(_v2, _v1, 0.6);
      _v3.copy(p).addScaledVector(n, 0.02);
      _v4.copy(_v2).multiplyScalar(5 + Math.random() * 8);
      this._sparkOpts.life = 0.24 + Math.random() * 0.2;
      this._sparkOpts.width = 0.016 + Math.random() * 0.008;
      this.sparks.spawnSpark(_v3, _v4, this._sparkOpts);
    }
    // tiny smoke
    this._emitDust(p, n, 2 + ((Math.random() * 3) | 0), 0.5, 1.4, 0.6,
      C_METALSMOKE0, C_METALSMOKE1, 0.06, 2.6, 0.5, 0.9, 0.4, -0.3, 1.6, 0.8);
    // hot flash at the hit
    const cfg = this._glowCfg;
    cfg.pos.copy(p).addScaledVector(n, 0.02);
    cfg.vel.copy(n).multiplyScalar(0.5);
    cfg.life = 0.06;
    cfg.size0 = 0.12; cfg.size1 = 0.2;
    cfg.drag = 0; cfg.grav = 0; cfg.turb = 0; cfg.rot = 0; cfg.rotV = 0;
    cfg.alpha = 0.9;
    cfg.c0 = C_CORE0; cfg.c1 = C_FIRE1;
    cfg.uv = this.tex.UV.dot;
    this.glow.spawn(cfg);
    this.decals.spawn(p, n, 0.075 * (0.85 + Math.random() * 0.3), this._time, 0.9);
  }

  _impactWood(p, n) {
    // splinters
    const count = 4 + ((Math.random() * 4) | 0);
    for (let i = 0; i < count; i++) {
      coneDir(_v2, n, 0.7);
      const cfg = this._softCfg;
      cfg.pos.copy(p).addScaledVector(_v2, 0.02);
      cfg.vel.copy(_v2).multiplyScalar(2.5 + Math.random() * 3.5);
      cfg.life = 0.3 + Math.random() * 0.2;
      cfg.size0 = 0.035 + Math.random() * 0.02;
      cfg.size1 = cfg.size0 * 1.4;
      cfg.rot = Math.random() * 6.28; cfg.rotV = (Math.random() - 0.5) * 10;
      cfg.drag = 0.4; cfg.grav = 8; cfg.turb = 0;
      cfg.alpha = 0.8;
      cfg.c0 = C_SPLINTER; cfg.c1 = C_SPLINTER;
      cfg.uv = this.tex.UV.splat;
      this.soft.spawn(cfg);
    }
    this._emitDust(p, n, 5 + ((Math.random() * 4) | 0), 1.2, 2.8, 0.9,
      C_DUST_WOOD0, C_DUST_WOOD1, 0.11, 3.0, 0.7, 1.3, 0.5, 0.15, 2.2, 0.6);
    this.decals.spawn(p, n, 0.12 * (0.85 + Math.random() * 0.3), this._time, 0.9);
  }

  _impactGlass(p, n) {
    this._emitGlowDots(p, n, 6 + ((Math.random() * 4) | 0), 1.2, 2, 5,
      C_GLASS0, C_GLASS1, 0.03, 0.25, 0.45, 12);
    this._emitDust(p, n, 1 + ((Math.random() * 2) | 0), 0.4, 1.0, 0.8,
      C_WHITESMOKE0, C_WHITESMOKE1, 0.09, 2.2, 0.4, 0.7, 0.3, -0.2, 1.4, 0.6);
    // no decal — glass shatters
  }

  // ------------------------------------------------------------- emitters

  _emitDust(p, n, count, spdMin, spdMax, spread, c0, c1, s0, grow, lifeMin, lifeMax, alpha, grav, drag, turb) {
    const cfg = this._softCfg;
    for (let i = 0; i < count; i++) {
      coneDir(_v2, n, spread);
      cfg.pos.copy(p).addScaledVector(_v2, 0.03);
      cfg.vel.copy(_v2).multiplyScalar(spdMin + Math.random() * (spdMax - spdMin));
      cfg.life = lifeMin + Math.random() * (lifeMax - lifeMin);
      cfg.size0 = s0 * (0.8 + Math.random() * 0.5);
      cfg.size1 = cfg.size0 * grow;
      cfg.rot = Math.random() * 6.28;
      cfg.rotV = (Math.random() - 0.5) * 1.4;
      cfg.drag = drag; cfg.grav = grav; cfg.turb = turb;
      cfg.alpha = alpha;
      cfg.c0 = c0; cfg.c1 = c1;
      cfg.uv = this._smokeUVs[(Math.random() * 3) | 0];
      this.soft.spawn(cfg);
    }
  }

  _emitGlowDots(p, n, count, spread, spdMin, spdMax, c0, c1, size, lifeMin, lifeMax, grav) {
    const cfg = this._glowCfg;
    for (let i = 0; i < count; i++) {
      coneDir(_v2, n, spread);
      cfg.pos.copy(p).addScaledVector(_v2, 0.02);
      cfg.vel.copy(_v2).multiplyScalar(spdMin + Math.random() * (spdMax - spdMin));
      cfg.life = lifeMin + Math.random() * (lifeMax - lifeMin);
      cfg.size0 = size * (0.8 + Math.random() * 0.5);
      cfg.size1 = cfg.size0 * 0.6;
      cfg.rot = 0; cfg.rotV = 0;
      cfg.drag = 0.3; cfg.grav = grav; cfg.turb = 0;
      cfg.alpha = 1;
      cfg.c0 = c0; cfg.c1 = c1;
      cfg.uv = this.tex.UV.dot;
      this.glow.spawn(cfg);
    }
  }

  _spawnDebris(point, count, s) {
    for (let i = 0; i < count; i++) {
      const d = this.debris[this._debRR];
      this._debRR = (this._debRR + 1) % this.debris.length;
      rndSphere(_v2);
      d.alive = true;
      d.x = point.x + _v2.x * 0.3 * s;
      d.y = point.y + Math.abs(_v2.y) * 0.25 * s + 0.05;
      d.z = point.z + _v2.z * 0.3 * s;
      rndSphere(_v2);
      d.vx = _v2.x * (2 + Math.random() * 4) * s;
      d.vz = _v2.z * (2 + Math.random() * 4) * s;
      d.vy = (2.5 + Math.random() * 4.5) * s;
      d.life = 0;
      d.maxLife = 1 + Math.random() * 0.8;
      d.sx = (0.04 + Math.random() * 0.1) * s;
      d.sy = (0.03 + Math.random() * 0.08) * s;
      d.sz = (0.04 + Math.random() * 0.1) * s;
      d.ax = Math.random() * 6.28; d.ay = Math.random() * 6.28; d.az = Math.random() * 6.28;
      d.wax = (Math.random() - 0.5) * 16;
      d.way = (Math.random() - 0.5) * 16;
      d.waz = (Math.random() - 0.5) * 16;
    }
  }

  // --------------------------------------------------------------- update

  update(dt, game) {
    if (!this.ready) return;
    const g = game || this.game;
    if (g && isFinite(g.time)) this._time = g.time;
    else this._time += dt;

    // keep point-size uniform in sync with the drawing buffer height
    const cv = this.renderer && this.renderer.domElement;
    if (cv && cv.height !== this._lastH) {
      this._lastH = cv.height;
      this.soft.setViewportHeight(cv.height);
      this.glow.setViewportHeight(cv.height);
    }

    this.soft.update(dt, this._time);
    this.glow.update(dt, this._time);
    this.tracers.update(dt, this._hf);
    this.sparks.update(dt, this._hf);
    this._updateFlashes(dt);
    this._updateLights(dt);
    this._updateShells(dt);
    this._updateDebris(dt);
    this._updateRings(dt);
    this.decals.update(this._time);
    this._updateShake(dt);
  }

  _updateFlashes(dt) {
    for (let i = 0; i < this.flashes.length; i++) {
      const f = this.flashes[i];
      if (!f.active) continue;
      f.life += dt;
      const t = f.life / f.maxLife;
      if (t >= 1) {
        f.active = false;
        f.spr.visible = false;
        continue;
      }
      const frameB = t >= 0.5; // 2-frame flipbook feel
      f.mat.rotation = frameB ? f.rotB : f.rotA;
      const scl = f.baseScale * (frameB ? f.scaleB : 1);
      const ain = t < 0.12 ? t / 0.12 : 1;
      const aout = t > 0.62 ? 1 - (t - 0.62) / 0.38 : 1;
      f.mat.opacity = ain * aout;
      f.spr.scale.set(scl, scl, 1);
    }
  }

  _updateLights(dt) {
    for (let i = 0; i < this.mLights.length; i++) {
      const ml = this.mLights[i];
      if (!ml.active) continue;
      ml.life += dt;
      const t = ml.life / ml.maxLife;
      if (t >= 1) {
        ml.active = false;
        ml.L.intensity = 0;
        continue;
      }
      const k = 1 - t;
      ml.L.intensity = ml.base * k * k * (0.88 + 0.24 * Math.random());
    }
    for (let i = 0; i < this.bLights.length; i++) {
      const bl = this.bLights[i];
      if (!bl.active) continue;
      bl.life += dt;
      const t = bl.life / bl.maxLife;
      if (t >= 1) {
        bl.active = false;
        bl.L.intensity = 0;
        continue;
      }
      const k = 1 - t;
      bl.L.intensity = bl.base * k * k * k * (0.9 + 0.2 * Math.random());
    }
  }

  _updateShells(dt) {
    let slot = 0;
    for (let i = 0; i < this.shells.length; i++) {
      const sh = this.shells[i];
      if (!sh.alive) continue;
      if (!sh.settled) {
        sh.vy -= 13 * dt;
        sh.x += sh.vx * dt;
        sh.y += sh.vy * dt;
        sh.z += sh.vz * dt;
        const gy = this._heightAt(sh.x, sh.z) + 0.011;
        if (sh.y <= gy) {
          sh.y = gy;
          if (Math.abs(sh.vy) < 0.9) {
            sh.settled = true;
            sh.vx = 0; sh.vy = 0; sh.vz = 0;
            sh.wax *= 0.1; sh.way *= 0.1; sh.waz *= 0.1;
          } else {
            sh.vy = -sh.vy * 0.3;
            sh.vx *= 0.55; sh.vz *= 0.55;
            sh.wax *= 0.5; sh.way *= 0.5; sh.waz *= 0.5;
          }
        }
        sh.ax += sh.wax * dt;
        sh.ay += sh.way * dt;
        sh.az += sh.waz * dt;
      } else {
        sh.settleT += dt;
      }
      let k = 1;
      if (sh.settled && sh.settleT > 6) {
        k = 1 - (sh.settleT - 6) / 0.5;
        if (k <= 0) { sh.alive = false; continue; }
      }
      _e.set(sh.ax, sh.ay, sh.az);
      _q.setFromEuler(_e);
      _v1.set(sh.x, sh.y, sh.z);
      _v2.set(sh.s * k, sh.s * k, sh.s * k);
      _m.compose(_v1, _q, _v2);
      this.shellsMesh.setMatrixAt(slot++, _m);
    }
    this.shellsMesh.count = slot;
    if (slot > 0 || slot !== this._lastShellCount) this.shellsMesh.instanceMatrix.needsUpdate = true;
    this._lastShellCount = slot;
  }

  _updateDebris(dt) {
    let slot = 0;
    for (let i = 0; i < this.debris.length; i++) {
      const d = this.debris[i];
      if (!d.alive) continue;
      d.life += dt;
      if (d.life >= d.maxLife) { d.alive = false; continue; }
      d.vy -= 15 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;
      const gy = this._heightAt(d.x, d.z) + d.sy * 0.5;
      if (d.y < gy) {
        d.y = gy;
        if (Math.abs(d.vy) > 0.8) {
          d.vy = -d.vy * 0.35;
          d.vx *= 0.6; d.vz *= 0.6;
          d.wax *= 0.6; d.way *= 0.6; d.waz *= 0.6;
        } else {
          d.vy = 0;
          const fr = Math.max(0, 1 - 3 * dt);
          d.vx *= fr; d.vz *= fr;
        }
      }
      d.ax += d.wax * dt;
      d.ay += d.way * dt;
      d.az += d.waz * dt;
      let k = Math.min(1, d.life / 0.05);
      const rem = d.maxLife - d.life;
      if (rem < 0.35) k *= rem / 0.35;
      _e.set(d.ax, d.ay, d.az);
      _q.setFromEuler(_e);
      _v1.set(d.x, d.y, d.z);
      _v2.set(d.sx * k, d.sy * k, d.sz * k);
      _m.compose(_v1, _q, _v2);
      this.debMesh.setMatrixAt(slot++, _m);
    }
    this.debMesh.count = slot;
    if (slot > 0 || slot !== this._lastDebCount) this.debMesh.instanceMatrix.needsUpdate = true;
    this._lastDebCount = slot;
  }

  _updateRings(dt) {
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i];
      if (!r.active) continue;
      r.life += dt;
      const t = r.life / r.maxLife;
      if (t >= 1) {
        r.active = false;
        r.m.visible = false;
        continue;
      }
      const k = 1 - (1 - t) * (1 - t) * (1 - t); // easeOutCubic
      const sc = 0.4 + (r.end - 0.4) * k;
      r.m.scale.set(sc, sc, sc);
      r.m.material.opacity = (1 - t) * (1 - t) * 0.9;
    }
  }

  // -------------------------------------------------------- camera shake

  _updateShake(dt) {
    if (this.shakeAmp <= 0) return;
    this.shakeAmp *= Math.exp(-5.5 * dt);
    if (this.shakeAmp < 0.0015) {
      this.shakeAmp = 0;
      return;
    }
    this._retT -= dt;
    if (this._retT <= 0) {
      this._retT = 0.028 + Math.random() * 0.022;
      this._tx = Math.random() * 2 - 1;
      this._ty = Math.random() * 2 - 1;
      this._tz = Math.random() * 2 - 1;
      this._trx = Math.random() * 2 - 1;
      this._try = Math.random() * 2 - 1;
      this._trz = Math.random() * 2 - 1;
    }
    const k = 1 - Math.exp(-26 * dt);
    this._nx += (this._tx - this._nx) * k;
    this._ny += (this._ty - this._ny) * k;
    this._nz += (this._tz - this._nz) * k;
    this._nrx += (this._trx - this._nrx) * k;
    this._nry += (this._try - this._nry) * k;
    this._nrz += (this._trz - this._nrz) * k;
  }

  _applyShake() {
    this._shakeApplied = false;
    if (!this.ready || this.shakeAmp <= 0 || !this.camera) return;
    const cam = this.camera;
    const pa = this.shakeAmp * 0.11;
    const ra = this.shakeAmp * 0.03;
    _v1.setFromMatrixColumn(cam.matrixWorld, 0); // right
    _v2.setFromMatrixColumn(cam.matrixWorld, 1); // up
    _v3.setFromMatrixColumn(cam.matrixWorld, 2); // forward
    const ox = this._nx * pa;
    const oy = this._ny * pa * 0.7;
    const oz = this._nz * pa * 0.5;
    cam.position.addScaledVector(_v1, ox).addScaledVector(_v2, oy).addScaledVector(_v3, oz);
    const rx = this._nrx * ra;
    const ry = this._nry * ra;
    const rz = this._nrz * ra;
    cam.rotation.x += rx;
    cam.rotation.y += ry;
    cam.rotation.z += rz;
    this._aox = ox; this._aoy = oy; this._aoz = oz;
    this._arx = rx; this._ary = ry; this._arz = rz;
    this._shakeApplied = true;
  }

  _unapplyShake() {
    if (!this._shakeApplied || !this.camera) return;
    const cam = this.camera;
    // rotation columns are unchanged by the render, so the same basis applies
    _v1.setFromMatrixColumn(cam.matrixWorld, 0);
    _v2.setFromMatrixColumn(cam.matrixWorld, 1);
    _v3.setFromMatrixColumn(cam.matrixWorld, 2);
    cam.position.addScaledVector(_v1, -this._aox).addScaledVector(_v2, -this._aoy).addScaledVector(_v3, -this._aoz);
    cam.rotation.x -= this._arx;
    cam.rotation.y -= this._ary;
    cam.rotation.z -= this._arz;
    this._shakeApplied = false;
  }

  // -------------------------------------------------------------- helpers

  _heightAt(x, z) {
    const L = this.game && this.game.level;
    if (L && typeof L.heightAt === 'function') {
      try {
        const h = L.heightAt(x, z);
        if (isFinite(h)) return h;
      } catch (e) { /* level may still be a stub */ }
    }
    return 0;
  }
}
