import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// Procedural modern infantryman (~1.83m).
//
// One rigid-skinned mesh per soldier (1 draw call + 1 shadow pass). All
// soldiers share ONE BufferGeometry + ONE canvas atlas texture; each gets a
// cloned material so corpses can fade independently.
//
// Bones: hips, spine, head, shoulders/elbows L+R, hips/knees L+R, gun.
// Geometry is authored in "bind space" (mesh-local, feet at origin, facing +Z)
// and every vertex is 100% weighted to one bone (rigid skinning).
// ---------------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);
const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;
const damp = THREE.MathUtils.damp;

// Bone layout: name, parent, local position. Order defines skin indices.
export const BONE_DEFS = [
  { name: 'hips',      parent: null,        pos: [0, 0.95, 0] },        // 0
  { name: 'spine',     parent: 'hips',      pos: [0, 0.13, 0] },        // 1
  { name: 'head',      parent: 'spine',     pos: [0, 0.50, 0] },        // 2
  { name: 'shoulderL', parent: 'spine',     pos: [-0.21, 0.38, 0] },    // 3
  { name: 'elbowL',    parent: 'shoulderL', pos: [0, -0.30, 0] },       // 4
  { name: 'shoulderR', parent: 'spine',     pos: [0.21, 0.38, 0] },     // 5
  { name: 'elbowR',    parent: 'shoulderR', pos: [0, -0.30, 0] },       // 6
  { name: 'hipL',      parent: 'hips',      pos: [-0.105, -0.02, 0] },  // 7
  { name: 'kneeL',     parent: 'hipL',      pos: [0, -0.45, 0] },       // 8
  { name: 'hipR',      parent: 'hips',      pos: [0.105, -0.02, 0] },   // 9
  { name: 'kneeR',     parent: 'hipR',      pos: [0, -0.45, 0] },       // 10
  { name: 'gun',       parent: 'spine',     pos: [0.03, 0.30, 0.14] },  // 11
];

// Atlas quadrants in UV space. Canvas rows: y 0..256 is v 0.5..1.
const REGIONS = {
  camo:  { x: 0.00, y: 0.50 },
  skin:  { x: 0.50, y: 0.50 },
  kit:   { x: 0.00, y: 0.00 },
  metal: { x: 0.50, y: 0.00 },
};

// Deterministic RNG so the camo is stable across reloads.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function speckle(g, rnd, x0, y0, n, dark, light) {
  for (let i = 0; i < n; i++) {
    g.globalAlpha = 0.04 + rnd() * 0.08;
    g.fillStyle = rnd() < 0.5 ? dark : light;
    const w = 1 + rnd() * 3, h = 1 + rnd() * 4;
    g.fillRect(x0 + rnd() * 256, y0 + rnd() * 256, w, h);
  }
  g.globalAlpha = 1;
}

function buildAtlas() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  const rnd = mulberry32(0xC0D);

  // -- camo: olive/tan blotch noise (canvas top-left = UV [0..0.5]x[0.5..1])
  g.fillStyle = '#6d6a4d';
  g.fillRect(0, 0, 256, 256);
  const camoCols = ['#575b3d', '#87795a', '#494d31', '#75704f', '#5e563c', '#3f4430'];
  for (let i = 0; i < 110; i++) {
    g.fillStyle = camoCols[(rnd() * camoCols.length) | 0];
    g.globalAlpha = 0.35 + rnd() * 0.5;
    const x = rnd() * 256, y = rnd() * 256, r = 7 + rnd() * 27;
    g.beginPath();
    g.ellipse(x, y, r, r * (0.45 + rnd() * 0.85), rnd() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  speckle(g, rnd, 0, 0, 700, '#2f3222', '#8d8668');

  // -- skin
  g.fillStyle = '#b78a66';
  g.fillRect(256, 0, 256, 256);
  speckle(g, rnd, 256, 0, 550, '#8f6748', '#c99d78');

  // -- kit fabric (vest/packs/boots): dark olive webbing
  g.fillStyle = '#3b3e2d';
  g.fillRect(0, 256, 256, 256);
  speckle(g, rnd, 0, 256, 950, '#2b2e20', '#4d5138');
  g.globalAlpha = 0.12; g.fillStyle = '#22241a';
  for (let i = 0; i < 5; i++) g.fillRect(rnd() * 250, 256, 3, 256);
  g.globalAlpha = 1;

  // -- gunmetal with machining streaks + scratches
  g.fillStyle = '#24262a';
  g.fillRect(256, 256, 256, 256);
  for (let i = 0; i < 520; i++) {
    g.globalAlpha = 0.03 + rnd() * 0.06;
    g.fillStyle = rnd() < 0.5 ? '#151619' : '#3a3d42';
    g.fillRect(256 + rnd() * 256, 256 + rnd() * 256, 2 + rnd() * 10, 1);
  }
  g.globalAlpha = 0.12; g.fillStyle = '#6b6f75';
  for (let i = 0; i < 14; i++) g.fillRect(256 + rnd() * 236, 256 + rnd() * 250, 6 + rnd() * 18, 1);
  g.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

function remapUV(geo, region) {
  const uv = geo.attributes.uv;
  if (!uv) return;
  for (let i = 0; i < uv.count; i++) {
    const u = clamp(uv.getX(i), 0, 1);
    const v = clamp(uv.getY(i), 0, 1);
    uv.setXY(i, region.x + 0.02 + u * 0.46, region.y + 0.02 + v * 0.46);
  }
}

function skinTo(geo, boneIndex) {
  const n = geo.attributes.position.count;
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { si[i * 4] = boneIndex; sw[i * 4] = 1; }
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
}

function addPart(parts, geo, region, boneIndex, x, y, z, opts) {
  const o = opts || {};
  if (o.scale) geo.scale(o.scale[0], o.scale[1], o.scale[2]);
  if (o.rx) geo.rotateX(o.rx);
  if (o.ry) geo.rotateY(o.ry);
  if (o.rz) geo.rotateZ(o.rz);
  geo.translate(x, y, z);
  remapUV(geo, region);
  skinTo(geo, boneIndex);
  parts.push(geo);
}

// Bone skin indices
const BI = { hips: 0, spine: 1, head: 2, shoulderL: 3, elbowL: 4, shoulderR: 5, elbowR: 6, hipL: 7, kneeL: 8, hipR: 9, kneeR: 10, gun: 11 };

function buildSharedGeometry() {
  const P = [];
  const R = REGIONS;

  // pelvis + torso (camo uniform)
  addPart(P, new THREE.BoxGeometry(0.30, 0.18, 0.20), R.camo, BI.hips, 0, 0.92, 0);
  addPart(P, new THREE.BoxGeometry(0.33, 0.46, 0.21), R.camo, BI.spine, 0, 1.31, 0);

  // vest + pouches + backpack (dark kit accents)
  addPart(P, new THREE.BoxGeometry(0.35, 0.33, 0.26), R.kit, BI.spine, 0, 1.30, 0.012);
  addPart(P, new THREE.BoxGeometry(0.075, 0.095, 0.05), R.kit, BI.spine, -0.095, 1.21, 0.165);
  addPart(P, new THREE.BoxGeometry(0.075, 0.095, 0.05), R.kit, BI.spine, 0, 1.21, 0.165);
  addPart(P, new THREE.BoxGeometry(0.075, 0.095, 0.05), R.kit, BI.spine, 0.095, 1.21, 0.165);
  addPart(P, new THREE.BoxGeometry(0.045, 0.09, 0.11), R.kit, BI.spine, -0.19, 1.26, 0);
  addPart(P, new THREE.BoxGeometry(0.045, 0.09, 0.11), R.kit, BI.spine, 0.19, 1.26, 0);
  addPart(P, new THREE.BoxGeometry(0.26, 0.33, 0.13), R.kit, BI.spine, 0, 1.29, -0.175);

  // head (skin) + helmet with rim and cover band
  addPart(P, new THREE.SphereGeometry(0.105, 12, 10), R.skin, BI.head, 0, 1.66, 0.015, { scale: [1, 1.18, 1.02] });
  addPart(P, new THREE.SphereGeometry(0.135, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.62), R.camo, BI.head, 0, 1.70, 0.005);
  addPart(P, new THREE.TorusGeometry(0.128, 0.015, 6, 18), R.camo, BI.head, 0, 1.658, 0.005, { rx: Math.PI / 2 });
  addPart(P, new THREE.CylinderGeometry(0.138, 0.132, 0.04, 14, 1, true), R.kit, BI.head, 0, 1.685, 0.005);

  // arms: upper (camo sleeves), forearm (camo), hand (skin)
  addPart(P, new THREE.BoxGeometry(0.095, 0.30, 0.095), R.camo, BI.shoulderL, -0.21, 1.31, 0);
  addPart(P, new THREE.BoxGeometry(0.095, 0.30, 0.095), R.camo, BI.shoulderR, 0.21, 1.31, 0);
  addPart(P, new THREE.BoxGeometry(0.085, 0.27, 0.085), R.camo, BI.elbowL, -0.21, 1.03, 0);
  addPart(P, new THREE.BoxGeometry(0.085, 0.27, 0.085), R.camo, BI.elbowR, 0.21, 1.03, 0);
  addPart(P, new THREE.BoxGeometry(0.07, 0.10, 0.08), R.skin, BI.elbowL, -0.21, 0.87, 0.01);
  addPart(P, new THREE.BoxGeometry(0.07, 0.10, 0.08), R.skin, BI.elbowR, 0.21, 0.87, 0.01);

  // legs: thigh (camo), knee pad (kit), shin (camo), boot (kit)
  addPart(P, new THREE.BoxGeometry(0.125, 0.45, 0.135), R.camo, BI.hipL, -0.105, 0.705, 0);
  addPart(P, new THREE.BoxGeometry(0.125, 0.45, 0.135), R.camo, BI.hipR, 0.105, 0.705, 0);
  addPart(P, new THREE.BoxGeometry(0.115, 0.10, 0.115), R.kit, BI.kneeL, -0.105, 0.47, 0.03);
  addPart(P, new THREE.BoxGeometry(0.115, 0.10, 0.115), R.kit, BI.kneeR, 0.105, 0.47, 0.03);
  addPart(P, new THREE.BoxGeometry(0.105, 0.38, 0.115), R.camo, BI.kneeL, -0.105, 0.27, 0);
  addPart(P, new THREE.BoxGeometry(0.105, 0.38, 0.115), R.camo, BI.kneeR, 0.105, 0.27, 0);
  addPart(P, new THREE.BoxGeometry(0.11, 0.12, 0.21), R.kit, BI.kneeL, -0.105, 0.06, 0.035);
  addPart(P, new THREE.BoxGeometry(0.11, 0.12, 0.21), R.kit, BI.kneeR, 0.105, 0.06, 0.035);

  // rifle, weighted to the gun bone (authored gun-local, gun rest origin at (0.03, 1.38, 0.14))
  const gx = 0.03, gy = 1.38, gz = 0.14;
  addPart(P, new THREE.BoxGeometry(0.055, 0.085, 0.44), R.metal, BI.gun, gx, gy, gz + 0.10);                    // receiver
  addPart(P, new THREE.BoxGeometry(0.05, 0.06, 0.24), R.camo, BI.gun, gx, gy + 0.002, gz + 0.40);               // handguard
  addPart(P, new THREE.CylinderGeometry(0.014, 0.014, 0.28, 8), R.metal, BI.gun, gx, gy + 0.012, gz + 0.60, { rx: Math.PI / 2 }); // barrel
  addPart(P, new THREE.BoxGeometry(0.026, 0.026, 0.06), R.metal, BI.gun, gx, gy + 0.012, gz + 0.74);            // muzzle device
  addPart(P, new THREE.BoxGeometry(0.05, 0.095, 0.19), R.metal, BI.gun, gx, gy - 0.012, gz - 0.155);            // stock
  addPart(P, new THREE.BoxGeometry(0.042, 0.14, 0.075), R.metal, BI.gun, gx, gy - 0.10, gz + 0.07, { rx: 0.18 }); // magazine
  addPart(P, new THREE.BoxGeometry(0.02, 0.035, 0.07), R.metal, BI.gun, gx, gy + 0.062, gz + 0.04);             // sight

  const geo = mergeGeometries(P, false);
  for (const g of P) g.dispose();
  geo.computeBoundingSphere();
  if (geo.boundingSphere) geo.boundingSphere.radius = 2.6; // limbs + topple reach
  return geo;
}

export class Soldier {
  /** Build the assets shared by every soldier. Call once, at init. */
  static buildShared(game) {
    const atlas = buildAtlas();
    const renderer = game.engine && game.engine.renderer;
    if (renderer && renderer.capabilities && renderer.capabilities.getMaxAnisotropy) {
      atlas.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    }
    return {
      geometry: buildSharedGeometry(),
      atlas,
      material: new THREE.MeshStandardMaterial({ map: atlas, roughness: 0.85, metalness: 0.06 }),
    };
  }

  constructor(shared) {
    this.shared = shared;
    this.mat = shared.material.clone();
    // subtle per-soldier uniform variation
    this.mat.color.offsetHSL(0, (Math.random() - 0.5) * 0.03, (Math.random() - 0.5) * 0.07);

    this.mesh = new THREE.SkinnedMesh(shared.geometry, this.mat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;

    // per-soldier bone chain (same layout, independent objects)
    this.bones = {};
    this.boneList = [];
    for (const def of BONE_DEFS) {
      const b = new THREE.Bone();
      b.name = def.name;
      b.position.set(def.pos[0], def.pos[1], def.pos[2]);
      this.bones[def.name] = b;
      this.boneList.push(b);
    }
    for (let i = 0; i < BONE_DEFS.length; i++) {
      const def = BONE_DEFS[i];
      if (def.parent) this.bones[def.parent].add(this.boneList[i]);
    }
    this.mesh.add(this.bones.hips);
    this.mesh.updateMatrixWorld(true);
    this.mesh.bind(new THREE.Skeleton(this.boneList));

    // muzzle anchor (child of the gun bone)
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.012, 0.80);
    this.bones.gun.add(this.muzzle);

    // animation state
    this.phase = Math.random() * Math.PI * 2;
    this.swayT = Math.random() * 20;
    this.speedS = 0;
    this.crouchS = 0;
    this.aimS = 0;
    this.flinchS = 0;
    this.flinchSign = 1;
    this.gunKick = 0;
    this._qFall = new THREE.Quaternion();
    this._axis = new THREE.Vector3();
  }

  getMuzzleWorld(out) {
    this.mesh.updateMatrixWorld(true);
    return this.muzzle.getWorldPosition(out);
  }

  /** Advance procedural animation + sync root transform from npc state. */
  animate(dt, npc) {
    const a = npc.anim;
    const B = this.bones;
    const t = (this.swayT += dt);

    if (a.flinchPulse > 0) {
      this.flinchS = 1;
      this.flinchSign = Math.random() < 0.5 ? -1 : 1;
      a.flinchPulse = 0;
    }
    this.flinchS = damp(this.flinchS, 0, 6.5, dt);
    this.gunKick = damp(this.gunKick, 0, 9, dt);
    this.speedS = damp(this.speedS, a.speed, 9, dt);
    const sn = Math.min(1, this.speedS / 4.3);
    this.crouchS = damp(this.crouchS, a.crouch, 7, dt);
    this.aimS = damp(this.aimS, a.aim, 9, dt);
    if (sn > 0.03) this.phase += dt * (2.2 + sn * 8.2);

    if (npc.dead) this.animateDeath(npc, B);
    else this.animateAlive(npc, a, B, sn, t);

    // root transform
    const m = this.mesh;
    m.position.copy(npc.position);
    m.position.y -= npc.sink || 0;
    m.quaternion.setFromAxisAngle(UP, npc.yaw + Math.PI);
    if (npc.dead) {
      // topple with a springy settle, around a horizontal axis perpendicular to fall dir
      const ft = npc.deadT;
      const tilt = npc.fallAmp * (1 - Math.exp(-5.5 * ft) * Math.cos(9 * ft));
      this._axis.set(-Math.cos(npc.fallYaw), 0, Math.sin(npc.fallYaw)).normalize();
      this._qFall.setFromAxisAngle(this._axis, tilt);
      m.quaternion.premultiply(this._qFall);
      // small slide in the fall direction while going down
      const k = Math.min(1, ft / 0.45);
      const slide = 0.35 * k * k * (3 - 2 * k);
      m.position.x += -Math.sin(npc.fallYaw) * slide;
      m.position.z += -Math.cos(npc.fallYaw) * slide;
    }
  }

  animateAlive(npc, a, B, sn, t) {
    const breathe = Math.sin(t * 1.7 + npc.seed);
    const sway = Math.sin(t * 0.55 + npc.seed * 2.1) * (1 - this.aimS);
    const p = this.phase;
    const fl = this.flinchS;

    // hips: bob + lean
    B.hips.position.y = 0.95 + Math.abs(Math.cos(p)) * 0.045 * sn - this.crouchS * 0.17;
    B.hips.rotation.set(sn * 0.06 + this.crouchS * 0.12, sway * 0.06, Math.sin(p) * 0.03 * sn);

    // spine: posture + partial aim yaw + flinch jolt
    B.spine.rotation.set(
      0.04 + sn * 0.10 + this.crouchS * 0.14 + fl * 0.24 + breathe * 0.012,
      clamp(a.aimYaw, -0.65, 0.65) * this.aimS * 0.6 + sway * 0.10,
      Math.sin(p) * 0.04 * sn
    );

    // head: track / scan, counter the flinch
    B.head.rotation.set(
      -clamp(a.headPitch, -0.45, 0.5) + fl * 0.3 * this.flinchSign + breathe * 0.012,
      clamp(a.headYaw, -0.8, 0.8) + sway * 0.12,
      fl * 0.06 * this.flinchSign
    );

    // legs: walk/run cycle with knee flex timed to swing-through
    const crouchHip = this.crouchS * 0.35;
    B.hipL.rotation.x = -Math.sin(p) * 0.62 * sn - crouchHip;
    B.hipR.rotation.x = -Math.sin(p + Math.PI) * 0.62 * sn - crouchHip;
    B.kneeL.rotation.x = Math.max(0, Math.sin(p - 1.05)) * 1.02 * sn + this.crouchS * 0.55;
    B.kneeR.rotation.x = Math.max(0, Math.sin(p + Math.PI - 1.05)) * 1.02 * sn + this.crouchS * 0.55;

    // arms: blend low-ready (patrol) -> two-handed grip (aiming), faint swing when moving unaimed
    const aim = this.aimS;
    B.shoulderL.rotation.set(
      lerp(-0.72, -1.22, aim) + Math.sin(p + Math.PI) * 0.10 * sn * (1 - aim),
      0, lerp(0.16, 0.38, aim));
    B.shoulderR.rotation.set(
      lerp(-0.62, -0.95, aim) + Math.sin(p) * 0.10 * sn * (1 - aim),
      0, lerp(-0.14, -0.34, aim));
    B.elbowL.rotation.set(lerp(-0.5, -0.55, aim) + fl * 0.15, 0, 0);
    B.elbowR.rotation.set(lerp(-0.55, -0.8, aim) + fl * 0.15, 0, 0);

    // rifle: low-ready sway -> muzzle tracking with recoil kick
    B.gun.position.set(0.03, 0.30, 0.14);
    B.gun.rotation.y = lerp(0.18, clamp(a.aimYaw, -0.42, 0.42), aim) + sway * 0.05;
    B.gun.rotation.x = lerp(0.5, -clamp(a.aimPitch, -0.35, 0.32), aim)
      - this.gunKick + breathe * 0.01 * (1 - aim) + fl * 0.1 * this.flinchSign;
    B.gun.rotation.z = sway * 0.03;
  }

  animateDeath(npc, B) {
    const k = Math.min(1, npc.deadT / 0.6);
    // limp limbs
    B.hips.rotation.set(0, 0, 0);
    B.spine.rotation.set(0.1 * k, 0, 0);
    B.head.rotation.set(0.45 * k, 0.2 * k * npc.gunClatterR, 0.15 * k * Math.sign(npc.gunClatterX || 1));
    B.hipL.rotation.x = -0.15 * k; B.hipR.rotation.x = -0.25 * k;
    B.kneeL.rotation.x = 0.5 * k; B.kneeR.rotation.x = 0.35 * k;
    B.shoulderL.rotation.set(-0.25 * k, 0, 0.5 * k);
    B.shoulderR.rotation.set(-0.3 * k, 0, -0.55 * k);
    B.elbowL.rotation.set(-0.35 * k, 0, 0);
    B.elbowR.rotation.set(-0.5 * k, 0, 0);
    // rifle clatter: gun bone drops/sideways in the first 0.6s, then stays
    if (npc.deadT < 0.6) {
      B.gun.position.set(
        0.03 + npc.gunClatterX * k,
        0.30 - 0.62 * k,
        0.14 + npc.gunClatterZ * k
      );
      B.gun.rotation.set(0.4 * k, npc.gunClatterR * 0.4 * k, npc.gunClatterR * 2.2 * k);
    }
  }

  /** f in 0..1 — fade the corpse out. */
  setFade(f) {
    if (f <= 0) return;
    if (!this.mat.transparent) {
      this.mat.transparent = true;
      this.mesh.castShadow = false;
    }
    this.mat.opacity = Math.max(0, 1 - f);
  }

  dispose() {
    this.mat.dispose(); // geometry + atlas are shared and owned by the system
  }
}
