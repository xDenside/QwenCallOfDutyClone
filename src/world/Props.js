// Procedural structures and props for Strike Compound.
// All builders receive the world-builder context `W` provided by Level.js:
//   W.M        materials (from Textures.js)
//   W.bucket(name, geo)   -> queue transformed geometry for merged meshes
//   W.solid(x0,y0,z0, x1,y1,z1, mat) -> add collision AABB with raycast material
//   W.contact(x, z, sx, sz, ry)      -> add a contact-shadow blob instance
//   W.heightAt(x, z)                  -> analytic terrain height
//   W.group    the level group
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './Noise.js';

const _m4 = new THREE.Matrix4();
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

// tiles-per-meter UV density per material family
const UV_SCALE = { concrete: 0.18, tin: 0.16, planks: 0.34, painted: 0.4, rubber: 0.7, dirt: 0.125 };

function ensureColor(geo, c = 1) {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c; arr[i * 3 + 1] = c; arr[i * 3 + 2] = c; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function scaleBoxUV(geo, w, h, d, s) {
  if (!s) return geo;
  const uv = geo.attributes.uv;
  // BoxGeometry face order: +x,-x,+y,-y,+z,-z (4 verts each)
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let i = 0; i < 24; i++) {
    const f = (i / 4) | 0;
    uv.setXY(i, uv.getX(i) * dims[f][0] * s, uv.getY(i) * dims[f][1] * s);
  }
  return geo;
}

function scaleUVCyl(geo, r, h, s) {
  if (!s) return geo;
  const uv = geo.attributes.uv;
  const su = Math.PI * 2 * r * s, sv = h * s;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return geo;
}

function xform(geo, x, y, z, rx = 0, ry = 0, rz = 0) {
  if (rx || ry || rz) {
    _e.set(rx, ry, rz);
    _m4.makeRotationFromEuler(_e);
    geo.applyMatrix4(_m4);
  }
  geo.translate(x, y, z);
  return geo;
}

/** Box with base at yBase; optional rotation about its center. */
function box(W, bucket, w, h, d, x, yBase, z, o = {}) {
  const g = new THREE.BoxGeometry(w, h, d);
  scaleBoxUV(g, w, h, d, o.uv !== undefined ? o.uv : UV_SCALE[bucket]);
  ensureColor(g, o.c ?? 1);
  const cy = yBase + h / 2 + (o.dy || 0);
  xform(g, x + (o.dx || 0), cy, z + (o.dz || 0), o.rx || 0, o.ry || 0, o.rz || 0);
  W.bucket(bucket, g);
  return g;
}

function cyl(W, bucket, r, h, x, yBase, z, o = {}) {
  const seg = o.seg || 10;
  const g = new THREE.CylinderGeometry(r * (o.topScale ?? 1), r, h, seg);
  scaleUVCyl(g, r, h, o.uv !== undefined ? o.uv : UV_SCALE[bucket]);
  ensureColor(g, o.c ?? 1);
  xform(g, x, yBase + h / 2 + (o.dy || 0), z, o.rx || 0, o.ry || 0, o.rz || 0);
  W.bucket(bucket, g);
  return g;
}

function tube(W, bucket, p0, p1, sag, radius = 0.02) {
  const a = new THREE.Vector3(...p0), b = new THREE.Vector3(...p1);
  const mid = a.clone().lerp(b, 0.5); mid.y -= sag;
  const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
  const g = new THREE.TubeGeometry(curve, 22, radius, 5);
  ensureColor(g, 1);
  W.bucket(bucket, g);
}

function solidBoxRot(W, x, yBase, z, w, h, d, ry, mat) {
  const cw = Math.abs(Math.cos(ry)), sw = Math.abs(Math.sin(ry));
  const ex = (w * cw + d * sw) / 2, ez = (w * sw + d * cw) / 2;
  W.solid(x - ex, yBase, z - ez, x + ex, yBase + h, z + ez, mat);
}

function makeInstanced(W, geo, mat, items, opts = {}) {
  if (!items.length) return null;
  const im = new THREE.InstancedMesh(geo, mat, items.length);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    _e.set(it.rx || 0, it.ry || 0, it.rz || 0);
    _q.setFromEuler(_e);
    _s.set(it.sx ?? 1, it.sy ?? 1, it.sz ?? 1);
    _v.set(it.x, it.y, it.z);
    _m4.compose(_v, _q, _s);
    im.setMatrixAt(i, _m4);
    if (it.color) im.setColorAt(i, _c.set(it.color));
  }
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  im.castShadow = opts.castShadow !== false;
  im.receiveShadow = true;
  im.frustumCulled = false;
  W.group.add(im);
  return im;
}

// ---------------------------------------------------------------------------
// Perimeter walls + gate
// ---------------------------------------------------------------------------
function buildPerimeter(W) {
  const H = 3.0, T = 0.4;
  const run = (x0, z0, x1, z1) => {
    const w = Math.abs(x1 - x0) || T, d = Math.abs(z1 - z0) || T;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    box(W, 'concrete', w, H, d, cx, 0, cz, { c: 0.96 });
    box(W, 'concrete', w + 0.16, 0.14, d + 0.16, cx, H, cz, { c: 0.9 }); // cap
    W.solid(Math.min(x0, x1) - 0.08, 0, Math.min(z0, z1) - 0.08,
      Math.max(x0, x1) + 0.08, H + 0.14, Math.max(z0, z1) + 0.08, 'concrete');
  };
  run(-52, -52.2, 52, -51.8);           // north
  run(51.8, -52, 52.2, 52);             // east
  run(-52.2, -52, -51.8, 52);           // west
  run(-52, 51.8, -3.6, 52.2);           // south left of gate
  run(3.6, 51.8, 52, 52.2);             // south right of gate

  // pilasters
  for (let i = 0; i <= 16; i++) {
    const t = -52 + i * (104 / 16);
    for (const [px, pz, horiz] of [[t, -52, true], [t, 52, true], [-52, t, false], [52, t, false]]) {
      if (horiz && Math.abs(pz - 52) < 1 && Math.abs(px) < 5) continue; // gate gap
      box(W, 'concrete', 0.62, 3.34, 0.62, px, 0, pz, { c: 0.93 });
    }
  }

  // tin fencing strip on top of north + partial west walls
  box(W, 'tin', 104, 0.62, 0.05, 0, 3.14, -52, { c: 0.95 });
  box(W, 'tin', 0.05, 0.62, 46, -52, 3.14, -29, { c: 0.95 });

  // gate posts
  for (const gx of [-4.1, 4.1]) {
    box(W, 'concrete', 0.85, 3.6, 0.85, gx, 0, 52, { c: 0.94 });
    W.solid(gx - 0.43, 0, 51.57, gx + 0.43, 3.6, 52.43, 'concrete');
  }

  // sliding gate panels shoved aside (breached)
  box(W, 'tin', 3.5, 2.5, 0.07, -6.6, 0.06, 52.6, { ry: 0.14, rz: 0.05, c: 0.9 });
  box(W, 'tin', 3.5, 2.5, 0.07, 6.3, 0.02, 52.9, { ry: -0.1, rz: -0.07, c: 0.9 });
  W.solid(-8.3, 0, 51.9, -4.9, 2.6, 53.4, 'metal');
  W.solid(4.6, 0, 52.2, 8, 2.6, 53.6, 'metal');

  // torn tin shards in the breach (low enough to step over, still solid for bullets)
  box(W, 'tin', 1.3, 0.55, 0.04, -2.2, 0, 52.2, { ry: 0.5, rz: 0.8, c: 0.85 });
  box(W, 'tin', 1.0, 0.5, 0.04, 2.6, 0, 51.7, { ry: -0.8, rz: -0.75, c: 0.85 });
  box(W, 'tin', 0.9, 0.45, 0.04, 0.4, 0, 52.7, { ry: 1.9, rz: 0.6, c: 0.85 });
  W.solid(-2.9, 0, 51.7, -1.5, 0.4, 52.7, 'metal');
  W.solid(2.1, 0, 51.3, 3.1, 0.4, 52.1, 'metal');
  W.solid(0.0, 0, 52.3, 0.8, 0.35, 53.1, 'metal');

  // cables + poles over the gate road
  for (const px of [-6.2, 6.2]) {
    cyl(W, 'planks', 0.085, 4.6, px, 0, 44, { seg: 8, c: 0.85, uv: 0.3 });
    box(W, 'planks', 1.7, 0.09, 0.09, px, 4.28, 44, { c: 0.85 });
    W.solid(px - 0.1, 0, 43.9, px + 0.1, 4.6, 44.1, 'wood');
    W.contact(px, 44, 0.55, 0.55, 0);
  }
  tube(W, 'rubber', [-6.2, 4.35, 44], [6.2, 4.35, 44], 0.9, 0.018);
  tube(W, 'rubber', [-6.2, 4.3, 44], [-24, 5.1, -16.2], 1.6, 0.016);
}

// ---------------------------------------------------------------------------
// Main building
// ---------------------------------------------------------------------------
function buildMainBuilding(W) {
  const H = 5.4, T = 0.4;
  // north + west walls (solid runs)
  box(W, 'concrete', 28.8, H, T, -16, 0, -39.8, { c: 0.97 });
  W.solid(-30.4, 0, -40, -1.6, H, -39.6, 'concrete');
  box(W, 'concrete', T, H, 24.4, -29.8, 0, -28, { c: 0.97 });
  W.solid(-30, 0, -40.2, -29.6, H, -15.8, 'concrete');

  // south wall: doors at x[-24,-20] & x[-10,-6], window x[-17,-13] y3.4..4.6
  const segs = [[-30.2, -24], [-20, -17], [-13, -10], [-6, -1.8]];
  for (const [a, b] of segs) {
    box(W, 'concrete', b - a, H, T, (a + b) / 2, 0, -15.8, { c: 0.97 });
    W.solid(a, 0, -16, b, H, -15.6, 'concrete');
  }
  // lintels over the two doors
  for (const [a, b] of [[-24, -20], [-10, -6]]) {
    box(W, 'concrete', b - a, H - 3.2, T, (a + b) / 2, 3.2, -15.8, { c: 0.97 });
    W.solid(a, 3.2, -16, b, H, -15.6, 'concrete');
  }
  // window sill + header
  box(W, 'concrete', 4, 3.4, T, -15, 0, -15.8, { c: 0.97 });
  box(W, 'concrete', 4, H - 4.6, T, -15, 4.6, -15.8, { c: 0.97 });
  W.solid(-17, 0, -16, -13, 3.4, -15.6, 'concrete');

  // east wall with doorway z[-30,-26]
  for (const [a, b] of [[-40.2, -30], [-26, -15.8]]) {
    box(W, 'concrete', T, H, b - a, -1.8, 0, (a + b) / 2, { c: 0.97 });
    W.solid(-2, 0, a, -1.6, H, b, 'concrete');
  }
  box(W, 'concrete', T, H - 3.2, 4, -1.8, 3.2, -28, { c: 0.97 });
  W.solid(-2, 3.2, -30, -1.6, H, -26, 'concrete');

  // floor slab with baked vertex AO: darkened toward the walls and under the mezzanine
  {
    const g = new THREE.BoxGeometry(28, 0.12, 24);
    scaleBoxUV(g, 28, 0.12, 24, 0.14);
    const p = g.attributes.position;
    const col = new Float32Array(p.count * 3);
    const smooth = (t) => { const k = Math.min(1, Math.max(0, t)); return k * k * (3 - 2 * k); };
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) - -16, z = p.getZ(i) - -28; // local, centered
      const dEdge = Math.min(14 - Math.abs(x), 12 - Math.abs(z));
      let ao = 0.52 + 0.42 * smooth(dEdge / 3.6);
      if (z < -8.5) ao *= 0.82; // mezzanine side stays dimmer
      if (p.getY(i) < 0) ao *= 0.6; // slab underside
      col[i * 3] = 0.86 * ao; col[i * 3 + 1] = 0.86 * ao; col[i * 3 + 2] = 0.86 * ao;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.translate(-16, 0.06, -28);
    W.bucket('concrete', g);
  }
  W.solid(-30, 0, -40, -2, 0.12, -16, 'concrete');

  // interior columns
  for (const cx of [-23, -16, -9]) {
    for (const cz of [-34, -22]) {
      cyl(W, 'concrete', 0.28, 5.28, cx, 0.12, cz, { seg: 12, c: 0.9 });
      W.solid(cx - 0.3, 0, cz - 0.3, cx + 0.3, 5.4, cz + 0.3, 'concrete');
    }
  }

  // ---- mezzanine along north wall ----
  box(W, 'painted', 28, 0.1, 3.4, -16, 2.9, -38.3, { c: 0.8 });
  W.solid(-30, 2.9, -40, -2, 3.0, -36.6, 'metal');
  // deck underside beams + posts
  for (const bx of [-26, -18, -10]) {
    box(W, 'painted', 0.14, 2.78, 0.14, bx, 0.12, -37.4, { c: 0.7 });
    W.solid(bx - 0.08, 0.12, -37.5, bx + 0.08, 2.9, -37.3, 'metal');
  }
  box(W, 'painted', 28, 0.24, 0.16, -16, 2.66, -37.4, { c: 0.7 });
  // railing along deck edge (gap at ramp top x -22..-20.2)
  for (const [r0, r1] of [[-30, -22], [-20.2, -2]]) {
    box(W, 'painted', r1 - r0, 0.06, 0.05, (r0 + r1) / 2, 3.92, -36.62, { c: 0.75 });
    box(W, 'painted', r1 - r0, 0.05, 0.04, (r0 + r1) / 2, 3.5, -36.62, { c: 0.75 });
    W.solid(r0, 3.0, -36.7, r1, 4.0, -36.54, 'metal');
    for (let px = r0 + 0.3; px < r1; px += 1.9) {
      box(W, 'painted', 0.05, 1.0, 0.05, px, 3.0, -36.62, { c: 0.75 });
    }
  }
  // ramp up to the deck (walkable slices), rising off the 0.12m floor slab
  const RAMP_N = 16, rampX0 = -28.4, rampW = 1.5;
  for (let i = 0; i < RAMP_N; i++) {
    const topY = 3.0 * (i + 1) / RAMP_N;
    const cx = rampX0 + 0.25 + i * 0.5;
    const h = Math.max(0.03, topY - 0.12);
    box(W, 'painted', 0.52, h, rampW, cx, 0.12, -35.75, { c: 0.78 });
    W.solid(cx - 0.26, 0, -36.5, cx + 0.26, topY, -35.0, 'metal');
  }
  // ramp side rails
  for (const zz of [-36.45, -35.05]) {
    box(W, 'painted', 8.1, 0.05, 0.04, -24.4, 2.05, zz, { c: 0.75, rz: 0.36 });
  }

  // ---- roof ----
  // solid north half (tin)
  box(W, 'tin', 28.9, 0.07, 12.7, -16, 5.46, -33.75, { c: 0.94 });
  // roof beams under it
  for (const bz of [-39.3, -35.5, -31.7, -27.9]) {
    box(W, 'painted', 28.6, 0.3, 0.16, -16, 5.14, bz, { c: 0.72 });
  }
  // exposed beams over the open south half (light-shaft comb)
  for (const bz of [-26.2, -22.4, -18.6]) {
    box(W, 'painted', 28.6, 0.3, 0.18, -16, 5.14, bz, { c: 0.72 });
  }
  // roof edge trim
  box(W, 'tin', 28.9, 0.22, 0.1, -16, 5.5, -27.5, { c: 0.9 });
  // roof as a bullet surface (player never reaches it)
  W.solid(-30.5, 5.4, -40.2, -1.5, 5.56, -27.3, 'metal');

  // hanging bulb in the middle of the hall (practical light anchor)
  cyl(W, 'rubber', 0.012, 0.9, -16, 4.55, -22.4, { seg: 5, uv: 0.3 });
  W.bulbPos = new THREE.Vector3(-16, 4.42, -22.4);

  // interior crate stacks + sandbag row are added by the prop builders
}

// ---------------------------------------------------------------------------
// Storage shed
// ---------------------------------------------------------------------------
function buildShed(W) {
  const x0 = -42, x1 = -32, z0 = 10, z1 = 20;
  // corner posts
  for (const [px, pz] of [[x0 + 0.2, z0 + 0.2], [x1 - 0.2, z0 + 0.2], [x0 + 0.2, z1 - 0.2], [x1 - 0.2, z1 - 0.2]]) {
    box(W, 'planks', 0.17, 2.95, 0.17, px, 0, pz, { c: 0.82, uv: 0.3 });
    W.solid(px - 0.09, 0, pz - 0.09, px + 0.09, 2.95, pz + 0.09, 'wood');
  }
  // tin walls: north, west, east (south face open)
  box(W, 'tin', x1 - x0, 2.7, 0.05, (x0 + x1) / 2, 0, z1 - 0.15, { c: 0.92 });
  W.solid(x0, 0, z1 - 0.25, x1, 2.7, z1 - 0.05, 'metal');
  box(W, 'tin', 0.05, 2.7, z1 - z0, x0 + 0.15, 0, (z0 + z1) / 2, { c: 0.92 });
  W.solid(x0 + 0.05, 0, z0, x0 + 0.25, 2.7, z1, 'metal');
  box(W, 'tin', 0.05, 2.7, z1 - z0, x1 - 0.15, 0, (z0 + z1) / 2, { c: 0.92 });
  W.solid(x1 - 0.25, 0, z0, x1 - 0.05, 2.7, z1, 'metal');
  // gabled roof
  const slope = 0.16;
  box(W, 'tin', x1 - x0 + 0.9, 0.05, 5.5, (x0 + x1) / 2, 2.95, 12.5, { rx: slope, c: 0.95 });
  box(W, 'tin', x1 - x0 + 0.9, 0.05, 5.5, (x0 + x1) / 2, 2.95, 17.5, { rx: -slope, c: 0.95 });
  box(W, 'planks', x1 - x0 + 0.5, 0.12, 0.12, (x0 + x1) / 2, 3.32, 15, { c: 0.8, uv: 0.3 });
  W.solid(x0 - 0.5, 2.9, z0 - 0.3, x1 + 0.5, 3.5, z1 + 0.3, 'metal'); // roof stops bullets
  W.contact((x0 + x1) / 2, (z0 + z1) / 2, 3.2, 3.2, 0);
}

// ---------------------------------------------------------------------------
// Comms hut
// ---------------------------------------------------------------------------
function buildCommsHut(W) {
  const x0 = 28, x1 = 36, z0 = -8, z1 = 0, H = 3.0, T = 0.25;
  // north, east walls
  box(W, 'concrete', x1 - x0, H, T, 32, 0, z0 + T / 2, { c: 0.95 });
  W.solid(x0, 0, z0, x1, H, z0 + T, 'concrete');
  box(W, 'concrete', T, H, z1 - z0, x1 - T / 2, 0, -4, { c: 0.95 });
  W.solid(x1 - T, 0, z0, x1, H, z1, 'concrete');
  // south wall with window x[30,33] y1.4..2.2
  for (const [a, b] of [[x0, 30], [33, x1]]) {
    box(W, 'concrete', b - a, H, T, (a + b) / 2, 0, z1 - T / 2, { c: 0.95 });
    W.solid(a, 0, z1 - T, b, H, z1, 'concrete');
  }
  box(W, 'concrete', 3, 1.4, T, 31.5, 0, z1 - T / 2, { c: 0.95 });
  box(W, 'concrete', 3, H - 2.2, T, 31.5, 2.2, z1 - T / 2, { c: 0.95 });
  W.solid(30, 0, z1 - T, 33, 1.4, z1, 'concrete');
  // west wall with door z[-5.5,-2.5]
  for (const [a, b] of [[z0, -5.5], [-2.5, z1]]) {
    box(W, 'concrete', T, H, b - a, x0 + T / 2, 0, (a + b) / 2, { c: 0.95 });
    W.solid(x0, 0, a, x0 + T, H, b, 'concrete');
  }
  box(W, 'concrete', T, H - 2.4, 3, x0 + T / 2, 2.4, -4, { c: 0.95 });
  W.solid(x0, 2.4, -5.5, x0 + T, H, -2.5, 'concrete');
  // open door panel swung inward
  box(W, 'planks', 0.06, 2.3, 1.0, 28.7, 0, -5.3, { ry: 0.9, c: 0.8, uv: 0.35 });
  // roof slab + tin cap
  box(W, 'concrete', x1 - x0 + 0.5, 0.12, z1 - z0 + 0.5, 32, H, -4, { c: 0.9 });
  box(W, 'tin', x1 - x0 + 0.6, 0.05, z1 - z0 + 0.6, 32, H + 0.12, -4, { c: 0.93 });
  W.solid(x0 - 0.3, H, z0 - 0.3, x1 + 0.3, H + 0.2, z1 + 0.3, 'concrete');
  // glass window pane
  const g = new THREE.BoxGeometry(2.9, 0.76, 0.04);
  ensureColor(g, 1);
  xform(g, 31.5, 1.78, z1 - T / 2);
  W.bucket('glass', g);
  W.solid(30.1, 1.4, z1 - 0.2, 32.9, 2.2, z1 - 0.05, 'glass');
  // antenna mast + crossarms + beacon
  cyl(W, 'painted', 0.05, 9, 35.1, 0, -7.1, { seg: 8, c: 0.85 });
  box(W, 'painted', 1.5, 0.05, 0.05, 35.1, 7.4, -7.1, { c: 0.85 });
  box(W, 'painted', 1.0, 0.05, 0.05, 35.1, 8.1, -7.1, { ry: Math.PI / 2, c: 0.85 });
  W.solid(35.0, 0, -7.2, 35.2, 9, -7.0, 'metal');
  const beaconGeo = new THREE.SphereGeometry(0.1, 10, 8);
  const beaconMat = new THREE.MeshStandardMaterial({
    color: 0x550501, emissive: 0xff2a12, emissiveIntensity: 0.2, roughness: 0.4
  });
  W.beaconMat = beaconMat;
  W.beaconPos = new THREE.Vector3(35.1, 9.08, -7.1);
  const beacon = new THREE.Mesh(beaconGeo, beaconMat);
  beacon.position.copy(W.beaconPos);
  W.group.add(beacon);
  // guy wires
  tube(W, 'rubber', [35.1, 8.5, -7.1], [31.6, 0.1, -10.4], 0.7, 0.012);
  tube(W, 'rubber', [35.1, 8.5, -7.1], [38.6, 0.1, -3.9], 0.7, 0.012);
  tube(W, 'rubber', [35.1, 8.5, -7.1], [38.9, 0.1, -9.8], 0.7, 0.012);
  // interior console with glowing screen
  box(W, 'painted', 1.5, 0.95, 0.55, 32, 0, -7.3, { c: 0.8 });
  W.solid(31.25, 0, -7.6, 32.75, 0.95, -7.0, 'metal');
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5, 0.32),
    new THREE.MeshBasicMaterial({ color: 0x7dffa8 })
  );
  screen.position.set(32, 1.12, -7.28);
  screen.rotation.x = -0.35;
  W.group.add(screen);
  W.commsBulbPos = new THREE.Vector3(32.5, 2.5, -4);
  W.contact(35.1, -7.1, 0.7, 0.7, 0);
}

// ---------------------------------------------------------------------------
// Watchtower
// ---------------------------------------------------------------------------
function buildWatchtower(W) {
  const tx = 38, tz = 34;
  const legH = 5.4;
  for (const [dx, dz] of [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]]) {
    box(W, 'planks', 0.2, legH, 0.2, tx + dx, 0, tz + dz, { c: 0.8, uv: 0.3 });
    W.solid(tx + dx - 0.11, 0, tz + dz - 0.11, tx + dx + 0.11, legH, tz + dz + 0.11, 'wood');
  }
  // cross braces
  for (const s of [-1, 1]) {
    box(W, 'planks', 0.09, 4.1, 0.09, tx, 0.55, tz + s * 1.5, { rz: 0.62 * s, c: 0.75, uv: 0.3 });
    box(W, 'planks', 0.09, 4.1, 0.09, tx + s * 1.5, 0.55, tz, { rx: -0.62 * s, c: 0.75, uv: 0.3 });
  }
  // deck
  box(W, 'planks', 4.6, 0.12, 4.6, tx, legH - 0.12, tz, { c: 0.88 });
  W.solid(tx - 2.3, legH - 0.12, tz - 2.3, tx + 2.3, legH, tz + 2.3, 'wood');
  // railings (west edge has a gap where the stairs land)
  for (const [ax, az, len, horiz] of [
    [tx, tz - 2.28, 4.6, true], [tx, tz + 2.28, 4.6, true],
    [tx - 2.28, tz - 1.54, 1.48, false], [tx - 2.28, tz + 1.54, 1.48, false],
    [tx + 2.28, tz, 4.6, false]
  ]) {
    box(W, 'planks', horiz ? len : 0.06, 0.07, horiz ? 0.06 : len, ax, legH + 0.92, az, { c: 0.85, uv: 0.3 });
    box(W, 'planks', horiz ? len : 0.05, 0.05, horiz ? 0.05 : len, ax, legH + 0.5, az, { c: 0.85, uv: 0.3 });
    W.solid(ax - (horiz ? len / 2 : 0.05), legH, az - (horiz ? 0.05 : len / 2),
      ax + (horiz ? len / 2 : 0.05), legH + 1.0, az + (horiz ? 0.05 : len / 2), 'wood');
    const nPosts = Math.max(2, Math.round(len / 1.5) + 1);
    for (let pi = 0; pi < nPosts; pi++) {
      const t = pi / (nPosts - 1) - 0.5;
      box(W, 'planks', 0.05, 1.0, 0.05,
        horiz ? ax + t * len : ax, legH, horiz ? az : az + t * len, { c: 0.82, uv: 0.3 });
    }
  }
  // roof posts + gable (high enough for headroom over the stair landing)
  for (const [dx, dz] of [[-2.0, -2.0], [2.0, -2.0], [-2.0, 2.0], [2.0, 2.0]]) {
    box(W, 'planks', 0.1, 2.3, 0.1, tx + dx, legH, tz + dz, { c: 0.8, uv: 0.3 });
  }
  box(W, 'tin', 5.4, 0.05, 2.9, tx, legH + 2.5, tz - 1.2, { rx: 0.34, c: 0.95 });
  box(W, 'tin', 5.4, 0.05, 2.9, tx, legH + 2.5, tz + 1.2, { rx: -0.34, c: 0.95 });
  W.solid(tx - 2.7, legH + 2.0, tz - 2.7, tx + 2.7, legH + 3.1, tz + 2.7, 'metal');
  // stairs on the west side
  const steps = 15, rise = legH / steps, tread = 0.42;
  for (let i = 0; i < steps; i++) {
    const sx = tx - 2.4 - (steps - 1 - i) * tread;
    box(W, 'planks', tread + 0.04, rise * (i + 1), 1.25, sx, 0, tz, { c: 0.82, uv: 0.3 });
    W.solid(sx - tread / 2, 0, tz - 0.62, sx + tread / 2, rise * (i + 1), tz + 0.62, 'wood');
  }
  // stair rail
  box(W, 'planks', steps * tread + 0.4, 0.06, 0.06, tx - 2.4 - (steps * tread) / 2 + tread / 2, legH / 2 + 0.95, tz - 0.65, { rz: -Math.atan2(legH, steps * tread), c: 0.82, uv: 0.3 });
  W.contact(tx, tz, 4.6, 4.6, 0);
}

// ---------------------------------------------------------------------------
// Wrecked 4x4 truck
// ---------------------------------------------------------------------------
function buildTruck(W) {
  const pos = new THREE.Vector3(10, W.heightAt(10, 30), 30);
  const yaw = -0.62, roll = 0.085, pitch = 0.03;
  const M = new THREE.Matrix4().compose(
    pos,
    new THREE.Quaternion().setFromEuler(new THREE.Euler(roll, yaw, pitch, 'YXZ')),
    new THREE.Vector3(1, 1, 1)
  );
  const t = (geo, bucket, c = 1) => {
    ensureColor(geo, c);
    geo.applyMatrix4(M);
    W.bucket(bucket, geo);
  };
  const bx = (w, h, d, x, y, z, bucket, c, ry = 0, rz = 0) => {
    const g = new THREE.BoxGeometry(w, h, d);
    scaleBoxUV(g, w, h, d, UV_SCALE[bucket]);
    if (ry || rz) {
      g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0, ry, rz)));
    }
    g.translate(x, y, z);
    t(g, bucket, c);
    return g;
  };
  // chassis + driveline
  bx(4.35, 0.32, 1.8, 0, 0.6, 0, 'painted', 0.72);
  bx(4.0, 0.14, 0.5, 0, 0.4, 0, 'painted', 0.55);
  // hood (crushed: slight tilt)
  bx(1.3, 0.52, 1.7, 1.42, 1.02, 0, 'painted', 0.9, 0, 0.045);
  bx(1.32, 0.06, 1.72, 1.42, 1.3, 0, 'painted', 0.8, 0, 0.045);
  // cab
  bx(1.5, 1.0, 1.74, 0.2, 1.5, 0, 'painted', 0.92);
  bx(1.34, 0.08, 1.62, 0.14, 2.06, 0, 'painted', 0.85);
  // cab rear + bed
  bx(0.08, 0.5, 1.7, -0.56, 1.3, 0, 'painted', 0.85);
  bx(1.6, 0.1, 1.7, -1.38, 1.04, 0, 'painted', 0.7);
  bx(1.6, 0.46, 0.07, -1.38, 1.32, 0.82, 'painted', 0.86);
  bx(1.6, 0.46, 0.07, -1.38, 1.32, -0.82, 'painted', 0.86);
  bx(0.07, 0.46, 1.7, -2.16, 1.32, 0, 'painted', 0.86, 0.22); // tailgate ajar
  // bumpers
  bx(0.16, 0.24, 1.86, 2.2, 0.62, 0, 'painted', 0.6);
  bx(0.14, 0.22, 1.86, -2.26, 0.62, 0, 'painted', 0.6);
  // windshield (cracked, slanted)
  const ws = new THREE.BoxGeometry(0.05, 0.6, 1.5);
  scaleBoxUV(ws, 0.05, 0.6, 1.5, 0);
  ws.applyMatrix4(new THREE.Matrix4().makeRotationZ(-0.46));
  ws.translate(0.86, 1.78, 0);
  t(ws, 'glass', 1);
  // wheels: front-left missing (axle rests on a rock)
  const wheel = (x, z) => {
    const g = new THREE.CylinderGeometry(0.44, 0.44, 0.3, 14);
    scaleUVCyl(g, 0.44, 0.3, UV_SCALE.rubber);
    g.rotateX(Math.PI / 2);
    g.translate(x, 0.44, z);
    t(g, 'rubber', 1);
    // hub
    const hub = new THREE.CylinderGeometry(0.16, 0.16, 0.32, 8);
    scaleUVCyl(hub, 0.16, 0.32, UV_SCALE.painted);
    hub.rotateX(Math.PI / 2);
    hub.translate(x, 0.44, z);
    t(hub, 'painted', 0.7);
  };
  wheel(1.45, -0.86); wheel(-1.4, 0.86); wheel(-1.4, -0.86);
  // detached flat tire lying beside the wreck
  const flat = new THREE.CylinderGeometry(0.44, 0.44, 0.3, 14);
  scaleUVCyl(flat, 0.44, 0.3, UV_SCALE.rubber);
  flat.rotateX(Math.PI / 2);
  flat.rotateZ(1.35);
  flat.translate(3.1, 0.3, 1.9);
  t(flat, 'rubber', 1);

  // collision: conservative AABBs transformed to world
  const aabb = (cx, cy, cz, w, h, d) => {
    const corners = [];
    for (const sx of [-1, 1]) for (const sy of [0, 1]) for (const sz of [-1, 1]) {
      corners.push(new THREE.Vector3(cx + sx * w / 2, cy + sy * h, cz + sz * d / 2).applyMatrix4(M));
    }
    const mn = new THREE.Vector3(Infinity, Infinity, Infinity);
    const mx = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const c of corners) { mn.min(c); mx.max(c); }
    W.solid(mn.x, mn.y, mn.z, mx.x, mx.y, mx.z, 'metal');
  };
  aabb(1.3, 0.35, 0, 2.1, 1.1, 1.9);  // hood + front axle
  aabb(-0.5, 0.35, 0, 2.6, 1.85, 1.9); // cab
  aabb(-1.7, 0.35, 0, 1.8, 1.6, 1.9);  // bed
  W.contact(pos.x, pos.z, 5.6, 3.0, yaw);
}

// ---------------------------------------------------------------------------
// Cover props: crates, barrels, pallets, sandbags, jersey barriers
// ---------------------------------------------------------------------------
function buildCrates(W) {
  const rnd = mulberry32(4242);
  const items = [];
  const put = (x, z, lvl, baseY = null) => {
    const y = (baseY ?? W.heightAt(x, z)) + lvl * 1.02 + 0.5;
    items.push({
      x, y, z, ry: (rnd() - 0.5) * 0.5, sx: 0.94 + rnd() * 0.1, sy: 0.94 + rnd() * 0.1, sz: 0.94 + rnd() * 0.1,
      color: new THREE.Color().setHSL(0.09, 0.25, 0.42 + rnd() * 0.16)
    });
    W.solid(x - 0.56, y - 0.51, z - 0.56, x + 0.56, y + 0.51, z + 0.56, 'wood');
    if (lvl === 0) W.contact(x, z, 1.5, 1.5, rnd());
  };
  // courtyard clusters
  put(-14, -6, 0); put(-12.9, -5.8, 0); put(-13.9, -4.9, 0); put(-13.4, -5.4, 1);
  put(16, 4, 0); put(17.06, 4.2, 0); put(16.5, 5.05, 0);
  put(6, -8, 0);
  put(18, -13, 0); put(19.05, -12.8, 0);
  // near shed / inside shed
  put(-35, 13, 0); put(-33.9, 13.4, 0); put(-39, 16.5, 0); put(-37.2, 6.8, 0);
  // inside main building
  put(-25, -30, 0); put(-23.9, -30.5, 0); put(-24.4, -29.6, 1); put(-5.5, -28, 0);
  // on the mezzanine deck
  put(-27, -38, 0, 3.0); put(-25.9, -38.3, 0, 3.0);
  // near comms hut + tower
  put(24, -2, 0); put(25.06, -1.8, 0);
  put(30, 27, 0); put(31.05, 27.3, 0);
  // outside the gate
  put(-6.4, 57, 0); put(7.2, 60, 0);
  makeInstanced(W, new THREE.BoxGeometry(1.02, 1.02, 1.02), W.M.crate, items);
}

function buildBarrels(W) {
  const rnd = mulberry32(5150);
  const items = [];
  const colors = [0x5c6247, 0x5c6247, 0x77432f, 0x51606b, 0x6b6b52];
  const up = (x, z, tipped = false, ry = 0) => {
    const col = colors[(rnd() * colors.length) | 0];
    if (!tipped) {
      const y = W.heightAt(x, z) + 0.44;
      items.push({ x, y, z, ry: rnd() * Math.PI, color: new THREE.Color(col) });
      W.solid(x - 0.31, y - 0.44, z - 0.31, x + 0.31, y + 0.44, z + 0.31, 'metal');
      W.contact(x, z, 0.85, 0.85, 0);
    } else {
      const y = W.heightAt(x, z) + 0.29;
      items.push({ x, y, z, ry, rz: Math.PI / 2, color: new THREE.Color(col) });
      W.solid(x - 0.48, y - 0.29, z - 0.32, x + 0.48, y + 0.29, z + 0.32, 'metal');
      W.contact(x, z, 1.3, 0.8, ry);
    }
  };
  up(-31, 11.5); up(-30.3, 12.2); up(-31.4, 12.7); up(-30.1, 11.0, true, 0.7);
  up(-33.5, 12, ); up(-33.0, 11.3);
  up(-4.6, -20); up(-4.1, -20.8); up(-4.9, -21.2);
  up(8.4, 28.2, true, 1.2);
  up(27, -6.2);
  up(-28, -37.5, false); // inside building against north wall
  const geo = new THREE.CylinderGeometry(0.29, 0.29, 0.88, 12);
  scaleUVCyl(geo, 0.29, 0.88, UV_SCALE.painted);
  makeInstanced(W, geo, W.M.painted, items);
}

function buildPallets(W) {
  // bake one pallet geometry: deck planks + stringers
  const parts = [];
  const plank = (w, h, d, x, y, z) => {
    const g = new THREE.BoxGeometry(w, h, d);
    scaleBoxUV(g, w, h, d, UV_SCALE.planks);
    ensureColor(g, 0.92);
    g.translate(x, y, z);
    parts.push(g);
  };
  for (let i = 0; i < 5; i++) plank(1.2, 0.022, 0.145, 0, 0.135, -0.52 + i * 0.26);
  for (const sx of [-0.5, 0, 0.5]) plank(0.09, 0.09, 1.2, sx, 0.075, 0);
  for (const sx of [-0.5, 0, 0.5]) plank(0.09, 0.022, 1.2, sx, 0.012, 0);
  const geo = mergeGeometries(parts);
  const rnd = mulberry32(6060);
  const items = [];
  const flat = (x, z, stack = 1) => {
    for (let i = 0; i < stack; i++) {
      items.push({ x, y: W.heightAt(x, z) + 0.02 + i * 0.16, z, ry: (rnd() - 0.5) * 0.4 });
    }
    W.solid(x - 0.65, 0, z - 0.65, x + 0.65, stack * 0.16, z + 0.65, 'wood');
    W.contact(x, z, 1.6, 1.6, rnd());
  };
  // lean geometry with rx=+1.32: top edge ends ~1.2m up at the instance pos,
  // bottom edge kicked out ~0.17m along +z (rotated by ry), so place the
  // instance on the wall face with the yard behind the bottom edge.
  const lean = (x, z, ry) => {
    items.push({ x, y: 0.578, z, ry, rx: 1.32 });
  };
  flat(15.2, 2.6, 2); flat(-12.6, -4.2, 1); flat(-36, 17.5, 2); flat(-8, -38, 1); flat(4, 22, 1);
  lean(-14, -15.6, 0.06);            // against main building south face
  lean(-20, -15.6, -0.04);
  lean(12, -51.8, 0.05);             // against north perimeter wall
  lean(28.02, -1, -Math.PI / 2 + 0.05); // against comms hut west face
  lean(-51.8, 24, Math.PI / 2 - 0.04);  // against west perimeter wall
  makeInstanced(W, geo, W.M.planks, items);
}

function buildSandbags(W) {
  // squashed, jittered sphere reads as a filled hessian bag
  const rnd = mulberry32(7777);
  const geo = new THREE.SphereGeometry(0.5, 8, 6);
  const posAttr = geo.attributes.position;
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
    const j = (rnd() - 0.5) * 0.045;
    posAttr.setXYZ(i, x * 1.24 + j, y * 0.44, z * 0.72 + j);
  }
  geo.computeVertexNormals();
  const items = [];
  const wall = (x0, z0, x1, z1, rows) => {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const n = Math.max(1, Math.round(len / 0.68));
    const yaw = Math.atan2(-dz, dx);
    const minX = Math.min(x0, x1) - 0.4, maxX = Math.max(x0, x1) + 0.4;
    const minZ = Math.min(z0, z1) - 0.4, maxZ = Math.max(z0, z1) + 0.4;
    const baseY = W.heightAt((x0 + x1) / 2, (z0 + z1) / 2) - 0.04;
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * 0.34;
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5 + off / 0.68) / n;
        if (t > 1) continue;
        const x = x0 + dx * t + (rnd() - 0.5) * 0.06;
        const z = z0 + dz * t + (rnd() - 0.5) * 0.06;
        items.push({
          x, y: W.heightAt(x, z) + 0.1 + r * 0.2, z,
          ry: yaw + (rnd() - 0.5) * 0.14,
          sx: 0.9 + rnd() * 0.25, sy: 0.85 + rnd() * 0.3, sz: 0.9 + rnd() * 0.25,
          color: new THREE.Color().setHSL(0.1 + rnd() * 0.03, 0.28, 0.5 + rnd() * 0.14)
        });
      }
    }
    W.solid(minX, baseY, minZ, maxX, baseY + rows * 0.21 + 0.1, maxZ, 'sandbag');
  };
  // arc emplacement facing the gate
  const cx = 0, cz = 3, r = 4.3;
  let px0 = null, pz0 = null;
  for (let a = 20; a <= 160; a += 17) {
    const rad = a * Math.PI / 180;
    const x1 = cx + Math.cos(rad) * r, z1 = cz + Math.sin(rad) * r;
    if (px0 !== null) wall(px0, pz0, x1, z1, 3);
    px0 = x1; pz0 = z1;
  }
  // gate road flanking walls
  wall(-6.6, 26, -6.6, 40, 3);
  wall(6.6, 24, 6.6, 38, 3);
  // low walls inside the breach
  wall(-3.6, 49.6, -1.2, 48.6, 2);
  wall(2.2, 48.2, 4.4, 49.4, 2);
  // inside the main building along the north wall
  wall(-27, -39.2, -19, -39.2, 2);
  // courtyard L
  wall(18, -8, 22.4, -8, 2);
  wall(22.4, -8, 22.4, -3.8, 2);
  makeInstanced(W, geo, W.M.sandbag, items);
}

function buildBarriers(W) {
  // jersey barrier: tapered profile from two boxes, merged once
  const g1 = new THREE.BoxGeometry(2.0, 0.5, 0.44);
  scaleBoxUV(g1, 2.0, 0.5, 0.44, UV_SCALE.concrete);
  ensureColor(g1, 0.94);
  g1.translate(0, 0.25, 0);
  const g2 = new THREE.BoxGeometry(2.0, 0.34, 0.2);
  scaleBoxUV(g2, 2.0, 0.34, 0.2, UV_SCALE.concrete);
  ensureColor(g2, 0.94);
  g2.translate(0, 0.67, 0);
  const geo = mergeGeometries([g1, g2]);
  const spots = [
    [-2.2, 45.5, 0.22], [3.4, 41, -0.18], [-3.6, 56.5, 0.4], [2.2, 60.5, -0.32],
    [13.5, 12, 1.25], [-12, 1.5, 0.7], [-18, 34, 0.12]
  ];
  const items = spots.map(([x, z, ry]) => ({ x, y: W.heightAt(x, z), z, ry }));
  for (const [x, z, ry] of spots) solidBoxRot(W, x, W.heightAt(x, z), z, 2.1, 0.86, 0.62, ry, 'concrete');
  makeInstanced(W, geo, W.M.concrete, items);
}

// ---------------------------------------------------------------------------
// Clutter: rocks, debris, shells, grass
// ---------------------------------------------------------------------------
function buildRocks(W) {
  const rnd = mulberry32(8888);
  const geo = new THREE.IcosahedronGeometry(0.5, 1);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = 0.75 + rnd() * 0.5;
    p.setXYZ(i, p.getX(i) * k, Math.max(p.getY(i) * k, -0.16), p.getZ(i) * k);
  }
  geo.computeVertexNormals();
  const items = [];
  const put = (x, z, s) => {
    const y = W.heightAt(x, z) + s * 0.08;
    items.push({
      x, y, z, ry: rnd() * Math.PI * 2, sx: s, sy: s * (0.7 + rnd() * 0.4), sz: s,
      color: new THREE.Color().setHSL(0.08, 0.12 + rnd() * 0.1, 0.38 + rnd() * 0.2)
    });
    if (s > 0.75) W.solid(x - s * 0.4, 0, z - s * 0.4, x + s * 0.4, s * 0.55, z + s * 0.4, 'concrete');
    if (s > 0.6) W.contact(x, z, s * 1.5, s * 1.5, rnd());
  };
  // gate rubble
  put(-4.3, 51.2, 1.0); put(4.5, 51.8, 0.9); put(-2.6, 53.2, 0.7); put(2.4, 53.6, 0.8); put(0.6, 50.8, 0.5);
  // wall corners + scattered
  const rndSpots = [
    [-48, -48], [-46, -44], [47, -47], [45, -49], [-47, 46], [48, 47], [-49, 20], [49, -18],
    [-44, 5], [46, 12], [-20, 44], [18, 46], [-9, 26], [12, 18], [-24, 8], [24, -12],
    [-38, 26], [34, 20], [8, -2], [-2, 14]
  ];
  for (const [x, z] of rndSpots) put(x + (rnd() - 0.5) * 2, z + (rnd() - 0.5) * 2, 0.28 + rnd() * 0.75);
  // boulders outside the gate
  for (let i = 0; i < 8; i++) {
    put((rnd() - 0.5) * 60, 58 + rnd() * 30, 0.4 + rnd() * 0.8);
  }
  makeInstanced(W, geo, W.M.rock, items);
}

function buildDebris(W) {
  const rnd = mulberry32(9999);
  // broken pallet fragments
  const geo = new THREE.BoxGeometry(0.34, 0.03, 0.12);
  ensureColor(geo, 0.8);
  scaleBoxUV(geo, 0.34, 0.03, 0.12, UV_SCALE.planks);
  const items = [];
  const spots = [];
  for (let i = 0; i < 26; i++) spots.push([(rnd() - 0.5) * 14, 48 + rnd() * 10]); // gate breach
  for (let i = 0; i < 16; i++) spots.push([-14 + (rnd() - 0.5) * 8, -6 + (rnd() - 0.5) * 8]);
  for (let i = 0; i < 12; i++) spots.push([16 + (rnd() - 0.5) * 7, 4 + (rnd() - 0.5) * 7]);
  for (let i = 0; i < 16; i++) spots.push([(rnd() - 0.5) * 90, (rnd() - 0.5) * 90]);
  for (const [x, z] of spots) {
    if (Math.abs(x) < 29 && z < -15 && z > -41) continue;
    items.push({
      x, y: W.heightAt(x, z) + 0.02, z, ry: rnd() * Math.PI * 2, rz: (rnd() - 0.5) * 0.3,
      sx: 0.6 + rnd() * 1.3, sy: 1, sz: 0.6 + rnd() * 1.2
    });
  }
  makeInstanced(W, geo, W.M.planks, items, { castShadow: false });

  // spent shell casings — brass glints near firing positions
  const shellGeo = new THREE.CylinderGeometry(0.011, 0.011, 0.052, 6);
  const shells = [];
  const shellSpots = [
    [0, 4, 34], [-6.4, 33, 16], [6.4, 31, 16], [20, -6, 12], [-13, -5, 10], [2, 44, 14]
  ];
  for (const [sx, sz, n] of shellSpots) {
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2, rr = rnd() * 1.6;
      const x = sx + Math.cos(a) * rr, z = sz + Math.sin(a) * rr;
      shells.push({
        x, y: W.heightAt(x, z) + 0.014, z,
        rx: Math.PI / 2 + (rnd() - 0.5) * 0.5, ry: rnd() * Math.PI
      });
    }
  }
  makeInstanced(W, shellGeo, W.M.brass, shells, { castShadow: false });
}

function buildGrass(W) {
  // tuft: three crossed blades
  const blades = [];
  for (let i = 0; i < 3; i++) {
    const g = new THREE.PlaneGeometry(0.46, 0.44, 1, 2);
    // bend blade tips outward slightly
    const p = g.attributes.position;
    for (let vi = 0; vi < p.count; vi++) {
      const y = p.getY(vi);
      if (y > 0.1) p.setX(vi, p.getX(vi) + (y - 0.1) * 0.5);
    }
    g.translate(0, 0.21, 0);
    g.rotateY(i * Math.PI / 3);
    ensureColor(g, 1);
    blades.push(g);
  }
  const geo = mergeGeometries(blades);
  geo.clearGroups();

  const rnd = mulberry32(31337);
  const items = [];
  const inRect = (x, z, x0, z0, x1, z1) => x > x0 && x < x1 && z > z0 && z < z1;
  let attempts = 0;
  while (items.length < 700 && attempts++ < 6000) {
    const x = (rnd() - 0.5) * 116, z = (rnd() - 0.5) * 116;
    // keep off the main drive and out of building interiors
    if (Math.abs(x) < 6 && z > 20) continue;
    if (inRect(x, z, -31, -41, -1, -15)) continue;
    if (inRect(x, z, 27, -9, 37, 1)) continue;
    // clustering bias: near walls & structures, sparse in open yard
    const nearWall = Math.min(52 - Math.abs(x), 52 - Math.abs(z)) < 7;
    const nearThing = inRect(x, z, -46, 7, -29, 23) || Math.hypot(x - 38, z - 34) < 9 ||
      Math.hypot(x + 14, z + 6) < 5 || Math.hypot(x - 16, z - 4) < 4;
    if (!nearWall && !nearThing && rnd() < 0.82) continue;
    const s = 0.65 + rnd() * 0.85;
    items.push({
      x, y: W.heightAt(x, z) - 0.03, z, ry: rnd() * Math.PI,
      sx: s, sy: s * (0.8 + rnd() * 0.6), sz: s,
      color: new THREE.Color().setHSL(0.11 + rnd() * 0.05, 0.3 + rnd() * 0.2, 0.34 + rnd() * 0.2)
    });
  }
  const mat = W.M.grass;
  const timeUniform = W.timeUniform;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = timeUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
  float wPhase = instanceMatrix[3][0] * 0.45 + instanceMatrix[3][2] * 0.62;
  float wAmp = position.y * position.y * 3.0;
  transformed.x += (sin(uTime * 1.6 + wPhase) + 0.45 * sin(uTime * 3.3 + wPhase * 1.7)) * 0.075 * wAmp;
  transformed.z += cos(uTime * 1.2 + wPhase) * 0.05 * wAmp;
#endif`);
  };
  makeInstanced(W, geo, mat, items, { castShadow: false });
}

// ---------------------------------------------------------------------------
// Distant terrain skirt + mountain ring (no void at the horizon)
// ---------------------------------------------------------------------------
function buildDistant(W, sunDir) {
  // terrain skirt: ring sloping gently down away from the compound
  const rings = 9, segs = 72;
  const posArr = [], colArr = [], idx = [];
  const rnd = mulberry32(1212);
  for (let ri = 0; ri <= rings; ri++) {
    const t = ri / rings;
    const r = 86 + t * t * 470;
    const y = -0.45 - t * t * 11 + (rnd() - 0.5) * 0.35;
    for (let s = 0; s <= segs; s++) {
      const a = s / segs * Math.PI * 2;
      posArr.push(Math.cos(a) * r, y + (ri === 0 ? W.heightAt(Math.cos(a) * r, Math.sin(a) * r) * 0.6 : 0), Math.sin(a) * r);
      const fade = Math.min(1, t * 1.15);
      const cr = 0.58 - fade * 0.12, cg = 0.5 - fade * 0.12, cb = 0.39 - fade * 0.1;
      colArr.push(cr, cg, cb);
    }
  }
  for (let ri = 0; ri < rings; ri++) {
    for (let s = 0; s < segs; s++) {
      const a = ri * (segs + 1) + s, b = a + segs + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const skirt = new THREE.BufferGeometry();
  skirt.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
  skirt.setAttribute('color', new THREE.Float32BufferAttribute(colArr, 3));
  skirt.setIndex(idx);
  skirt.computeVertexNormals();
  const skirtMesh = new THREE.Mesh(skirt, W.M.skirt);
  skirtMesh.receiveShadow = false;
  W.group.add(skirtMesh);

  // two mountain ridges
  const ridge = (radius, height, seed, colBase, colTop, warm) => {
    const n = 110;
    const ridged = (a, f, s2) => {
      const v = Math.sin(a * f + s2) * 0.5 + Math.sin(a * f * 2.7 + s2 * 1.7) * 0.3 + Math.sin(a * f * 6.1 + s2 * 0.4) * 0.2;
      return Math.abs(v);
    };
    const P = [], C = [], I = [];
    const sx = sunDir.x, sz = sunDir.z;
    for (let i = 0; i <= n; i++) {
      const a = i / n * Math.PI * 2;
      const rr = radius * (0.86 + ridged(a, 3.0, seed) * 0.24);
      const h = height * (0.35 + ridged(a, 2.2, seed * 2.3) * 0.75);
      P.push(Math.cos(a) * rr * 1.06, -8, Math.sin(a) * rr * 1.06);
      P.push(Math.cos(a) * rr * 0.93, h, Math.sin(a) * rr * 0.93);
      // warm the sun-facing slopes
      const face = Math.max(0, Math.cos(a) * sx + Math.sin(a) * sz);
      const haze = 0.16;
      C.push(colBase[0], colBase[1], colBase[2]);
      C.push(
        colTop[0] + face * warm + haze, colTop[1] + face * warm * 0.7 + haze * 0.8, colTop[2] + face * warm * 0.4 + haze * 0.6
      );
    }
    for (let i = 0; i < n; i++) {
      const a = i * 2;
      I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    g.setIndex(I);
    const m = new THREE.Mesh(g, W.M.mountain);
    m.frustumCulled = false;
    W.group.add(m);
  };
  ridge(640, 120, 3.7, [0.5, 0.41, 0.34], [0.55, 0.47, 0.44], 0.14);
  ridge(860, 210, 9.2, [0.56, 0.48, 0.42], [0.62, 0.55, 0.5], 0.1);
}

// ---------------------------------------------------------------------------

export const Builders = {
  buildPerimeter, buildMainBuilding, buildShed, buildCommsHut, buildWatchtower,
  buildTruck, buildCrates, buildBarrels, buildPallets, buildSandbags,
  buildBarriers, buildRocks, buildDebris, buildGrass, buildDistant
};
