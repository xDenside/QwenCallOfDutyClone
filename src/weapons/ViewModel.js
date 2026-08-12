import * as THREE from 'three';
import { buildM4, buildP1911 } from './GunBuilders.js';

// ---------------------------------------------------------------------------
// ViewModel: owns both procedural gun rigs, hangs them off the camera and
// animates them every frame with pure math on preallocated objects.
//
// Sight alignment guarantee:
//   The ADS camera offset is derived from the rig's sight marker Object3D:
//     adsPos = (-sight.x, -sight.y, -(eyeDist + sight.z))
//   With the rig rotation at exactly identity when ads == 1, the marker maps
//   to camera-local (0, 0, -eyeDist) — a point on the camera's -Z axis, i.e.
//   dead-center on screen. The front sight shares the marker's x/y, so the
//   whole sight picture aligns by construction.
// ---------------------------------------------------------------------------

const IDENTITY_Q = new THREE.Quaternion();

// Keyframe tracks: [time, value] stops, smoothstep-interpolated. No allocation.
function track(stops, u) {
  if (u <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (u <= stops[i][0]) {
      const t0 = stops[i - 1][0], v0 = stops[i - 1][1];
      const t1 = stops[i][0], v1 = stops[i][1];
      const f = (u - t0) / Math.max(1e-6, t1 - t0);
      const s = f * f * (3 - 2 * f);
      return v0 + (v1 - v0) * s;
    }
  }
  return stops[stops.length - 1][1];
}

// Reload choreography per weapon (u = normalized reload time 0..1).
const RELOAD_ANIM = {
  M4A1: {
    lean: [[0, 0], [0.13, 1], [0.74, 1], [0.92, 0]],
    mag: [[0.10, 0], [0.38, 1], [0.56, 1], [0.76, 0]],
    boltReload: [[0.76, 0], [0.83, 1], [0.92, 0]],
    leanAmp: { pitch: -0.22, y: -0.052, z: 0.03, roll: 0.06 },
    magDist: 0.19, magRotX: 0.45, magRotZ: 0.08, boltPull: 0.052,
  },
  P1911: {
    lean: [[0, 0], [0.12, 1], [0.70, 1], [0.90, 0]],
    mag: [[0.10, 0], [0.30, 1], [0.46, 1], [0.64, 0]],
    boltReload: null,
    slideLock: [[0, 1], [0.80, 1], [0.88, 0]], // slide locked back, released near the end
    leanAmp: { pitch: -0.30, y: -0.06, z: 0.02, roll: 0.10 },
    magDist: 0.15, magRotX: 0, magRotZ: 0.06, boltPull: 0,
  },
};

const POSES = {
  M4A1: {
    hipPos: new THREE.Vector3(0.205, -0.185, -0.52),
    hipEuler: new THREE.Euler(-0.012, 0.030, 0.008),
    sprintPos: new THREE.Vector3(0.05, -0.27, -0.34),
    sprintEuler: new THREE.Euler(-0.52, -0.30, 0.16),
  },
  P1911: {
    hipPos: new THREE.Vector3(0.185, -0.175, -0.36),
    hipEuler: new THREE.Euler(-0.05, 0.05, 0),
    sprintPos: new THREE.Vector3(0.05, -0.26, -0.30),
    sprintEuler: new THREE.Euler(-0.6, -0.35, 0.12),
  },
};

export class ViewModel {
  constructor(defs) {
    this.defs = defs;
    this.root = new THREE.Group();       // parented to the camera
    this.rigs = {};
    this.adsPos = {};
    this.activeName = null;

    // preallocated animation state
    this._pos = new THREE.Vector3();
    this._off = new THREE.Vector3();
    this._vel = new THREE.Vector3();
    this._lag = new THREE.Vector3();
    this._lagT = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._qA = new THREE.Quaternion();
    this._qB = new THREE.Quaternion();
    this._qInv = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._e2 = new THREE.Euler();

    // recoil/slide impulses (attack instant, release exponential)
    this.kickZ = 0;
    this.kickPitch = 0;
    this.kickRoll = 0;
    this.slideBack = 0;
  }

  build(mats) {
    this.rigs.M4A1 = buildM4(mats);
    this.rigs.P1911 = buildP1911(mats);
    for (const name of Object.keys(this.rigs)) {
      const rig = this.rigs[name];
      rig.root.visible = false;
      this.root.add(rig.root);
      // ADS offset from the actual sight marker — alignment by construction.
      const s = rig.sight.position;
      this.adsPos[name] = new THREE.Vector3(-s.x, -s.y, -(this.defs[name].eyeDist + s.z));
    }
  }

  setActive(name) {
    this.activeName = name;
    for (const n of Object.keys(this.rigs)) {
      this.rigs[n].root.visible = (n === name);
    }
    this.resetKick();
    this._resetRigTransforms(name);
  }

  resetKick() {
    this.kickZ = 0;
    this.kickPitch = 0;
    this.kickRoll = 0;
    this.slideBack = 0;
  }

  _resetRigTransforms(name) {
    const rig = this.rigs[name];
    if (!rig) return;
    rig.body.position.set(0, 0, 0);
    rig.body.quaternion.identity();
    const mb = rig.mag.userData.base;
    rig.mag.position.set(rig.mag.position.x, mb.y, rig.mag.position.z);
    rig.mag.rotation.set(mb.rx, 0, mb.rz);
    rig.bolt.position.z = rig.slideBaseZ;
  }

  // Called by WeaponSystem when a shot fires. Attack is instant here;
  // the exponential release happens in update() (fast, near-symmetric recovery).
  impulse(k) {
    const j = 0.85 + Math.random() * 0.3;
    this.kickZ = Math.min(this.kickZ + k.z * j, 0.095);
    this.kickPitch = Math.min(this.kickPitch + k.pitch * j, 0.13);
    this.kickRoll = THREE.MathUtils.clamp(this.kickRoll + (Math.random() < 0.5 ? -1 : 1) * k.roll, -0.03, 0.03);
    this.slideBack = 1;
  }

  muzzleWorld(out) {
    const rig = this.rigs[this.activeName];
    if (rig) rig.muzzle.getWorldPosition(out);
    return out;
  }

  ejectWorld(out) {
    const rig = this.rigs[this.activeName];
    if (rig) rig.eject.getWorldPosition(out);
    return out;
  }

  update(dt, s) {
    const rig = this.rigs[this.activeName];
    if (!rig || !s) return;
    const anim = RELOAD_ANIM[this.activeName];
    const pose = POSES[this.activeName];
    const def = s.def;

    // --- release recoil impulses (fast recover) ---
    this.kickZ = THREE.MathUtils.damp(this.kickZ, 0, 10.5, dt);
    this.kickPitch = THREE.MathUtils.damp(this.kickPitch, 0, 10.5, dt);
    this.kickRoll = THREE.MathUtils.damp(this.kickRoll, 0, 10.5, dt);
    this.slideBack = THREE.MathUtils.damp(this.slideBack, 0, 13, dt);

    const adsIn = Math.max(0, Math.min(1, s.adsEff));
    const adsE = adsIn * adsIn * (3 - 2 * adsIn);
    const raise = s.raise;

    // --- body transform: recoil shove + reload lean (muzzle marker rides this) ---
    let bodyPitch = this.kickPitch;
    let bodyRoll = this.kickRoll;
    let bodyY = 0;
    let bodyZ = this.kickZ;
    let magDrop = 0;
    let boltExtra = 0;
    if (s.reloadU >= 0) {
      const lean = track(anim.lean, s.reloadU);
      bodyPitch += anim.leanAmp.pitch * lean;
      bodyRoll += anim.leanAmp.roll * lean;
      bodyY += anim.leanAmp.y * lean;
      bodyZ += anim.leanAmp.z * lean;
      magDrop = track(anim.mag, s.reloadU);
      if (anim.boltReload) boltExtra = anim.boltPull * track(anim.boltReload, s.reloadU);
      if (anim.slideLock && s.slideLock) {
        this.slideBack = Math.max(this.slideBack, track(anim.slideLock, s.reloadU));
      }
    }
    rig.body.position.set(0, bodyY, bodyZ);
    this._e.set(bodyPitch, 0, bodyRoll);
    rig.body.quaternion.setFromEuler(this._e);

    // magazine drop / bolt travel
    const mb = rig.mag.userData.base;
    rig.mag.position.y = mb.y - anim.magDist * magDrop;
    rig.mag.rotation.x = mb.rx + anim.magRotX * magDrop;
    rig.mag.rotation.z = mb.rz + anim.magRotZ * magDrop;
    rig.bolt.position.z = rig.slideBaseZ + rig.boltTravel * this.slideBack + boltExtra;

    // --- root pose: hip <-> ADS <-> sprint ---
    this._pos.lerpVectors(pose.hipPos, this.adsPos[this.activeName], adsE);
    let lower = Math.max(0, Math.min(1, s.lower));
    lower = lower * lower * (3 - 2 * lower); // ease the raise/lower ramp
    if (lower > 0) this._pos.lerp(pose.sprintPos, lower);
    this._pos.y -= s.switchLower * 0.3;

    this._qA.setFromEuler(pose.hipEuler);
    this._q.copy(this._qA).slerp(IDENTITY_Q, adsE); // ADS rotation == identity exactly
    if (lower > 0) {
      this._qB.setFromEuler(pose.sprintEuler);
      this._q.slerp(this._qB, lower);
    }

    // --- additive offsets: movement bob, idle sway, velocity lag ---
    const bt = s.bobTime || 0;
    this._off.set(0, 0, 0);
    this._e2.set(0, 0, 0);

    const amp = Math.min((s.hSpeed || 0) / 4.5, 1.5) * (def.bobAmp || 1) * (1 - adsE * 0.78) * raise;
    if (amp > 0.001) {
      this._off.x += Math.cos(bt) * 0.0125 * amp;
      this._off.y += Math.sin(bt * 2) * 0.0102 * amp;
      this._e2.x += Math.sin(bt * 2) * 0.0058 * amp;
      this._e2.y += Math.cos(bt) * 0.0049 * amp;
      this._e2.z += Math.sin(bt) * 0.0094 * amp;
    }
    if (lower > 0.05) { // sprint bounce
      this._off.y += Math.abs(Math.sin(bt * 1.4)) * 0.008 * lower * Math.min((s.hSpeed || 0) / 7, 1);
    }

    const idle = Math.max(0, 1 - (s.hSpeed || 0) / 2.2) * (1 - adsE * 0.65) * raise;
    if (idle > 0.01) { // breathing + figure-8 sway
      const t = s.time || 0;
      this._off.x += Math.sin(t * 0.9) * 0.0021 * idle;
      this._off.y += (Math.sin(t * 1.8 + 0.7) * 0.0015 + Math.sin(t * 0.55) * 0.0026) * idle;
      this._e2.x += Math.sin(t * 0.55) * 0.0038 * idle;
      this._e2.y += Math.sin(t * 0.33) * 0.0031 * idle;
    }

    // gun lags behind player velocity a touch — sells weight on strafe/jumps
    if (s.vel && s.camera) {
      this._qInv.copy(s.camera.quaternion).invert();
      this._vel.copy(s.vel).applyQuaternion(this._qInv);
      const k = 0.005 * (1 - adsE * 0.6);
      this._lagT.set(
        THREE.MathUtils.clamp(-this._vel.x * k, -0.026, 0.026),
        THREE.MathUtils.clamp(-this._vel.y * k * 0.5, -0.012, 0.012),
        THREE.MathUtils.clamp(-this._vel.z * k * 0.7, -0.02, 0.02)
      );
      this._lag.x = THREE.MathUtils.damp(this._lag.x, this._lagT.x, 7, dt);
      this._lag.y = THREE.MathUtils.damp(this._lag.y, this._lagT.y, 7, dt);
      this._lag.z = THREE.MathUtils.damp(this._lag.z, this._lagT.z, 7, dt);
    }

    this._pos.add(this._off).add(this._lag);
    this._qB.setFromEuler(this._e2);
    this._q.multiply(this._qB);

    rig.root.position.copy(this._pos);
    rig.root.quaternion.copy(this._q);
  }
}
