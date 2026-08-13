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
const UV_SCALE = { concrete: 0.18, tin: 0.16, planks: 0.34, painted: 0.4, rubber: 0.7, dirt: 0.125, stucco: 0.22, brick: 0.45 };

// clutter nests on the main gate->courtyard sightlines: every prop builder
// drops a little cover cluster at each so the mid-ground reads dressed, not dotted
const NESTS = [[-4, 34], [7, 26], [-10, 8], [14, -2], [26, -24], [26, 14], [-18, 34], [-2, -20]];

// building footprints: scatter props stay out of interiors, and weeds/litter
// hug the wall bases so edges read weathered
const FOOTPRINTS = [
  [-31, -41, -1, -15], [27, -9, 37, 1], [25, -49, 49, -29], [21, 5, 47, 25],
  [-29, 25, -13, 43], [-9, -41, 5, -23], [11, 33, 27, 49], [44, -19, 52, 7],
  [43, 15, 51, 31], [7, -51, 27, -43]
];
const inFootprint = (x, z) =>
  FOOTPRINTS.some(([x0, z0, x1, z1]) => x > x0 && x < x1 && z > z0 && z < z1);

// analytic skirt height (mirrors buildDistant's terrain ring) for props placed
// beyond the playable terrain
function skirtY(x, z) {
  const r = Math.hypot(x, z);
  const t = Math.sqrt(Math.max(0, r - 86) / 470);
  return -0.45 - t * t * 11;
}
function groundY(W, x, z) {
  return Math.hypot(x, z) < 86 ? W.heightAt(x, z) : skirtY(x, z);
}

function ensureColor(geo, c = 1) {
  const cr = Array.isArray(c) ? c[0] : c;
  const cg = Array.isArray(c) ? c[1] : c;
  const cb = Array.isArray(c) ? c[2] : c;
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = cr; arr[i * 3 + 1] = cg; arr[i * 3 + 2] = cb; }
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
  // bucket materials are vertexColors:true; without a color attribute the
  // instanced litter would shade black (vColor defaults to 0)
  if (mat.vertexColors && !geo.attributes.color) ensureColor(geo, 1);
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

  // roof slab: interior reads as interior (bulbs + door light shafts), no sky wash
  box(W, 'concrete', 29.2, 0.35, 24.8, -16, H, -28, { c: 0.97 });

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
  // sightline nests
  for (const [nx, nz] of NESTS) {
    put(nx, nz, 0); put(nx + 1.06, nz + 0.2, 0); put(nx + 0.5, nz + 0.9, 1);
  }
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
  for (const [nx, nz] of NESTS) { up(nx - 1.4, nz + 0.6); up(nx - 0.8, nz + 1.1, true, rnd() * 3); }
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
  for (const [nx, nz] of NESTS) flat(nx + 1.8, nz - 1.0, 1);
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
        const x = x0 + dx * t + (rnd() - 0.5) * 0.09;
        const z = z0 + dz * t + (rnd() - 0.5) * 0.09;
        // two-tone: weathered tan bags mixed with olive drab, low saturation
        const tan = rnd() < 0.55;
        items.push({
          x, y: W.heightAt(x, z) + 0.1 + r * 0.2 + (rnd() - 0.5) * 0.03, z,
          ry: yaw + (rnd() - 0.5) * 0.3,
          rx: (rnd() - 0.5) * 0.1, rz: (rnd() - 0.5) * 0.1,
          sx: 0.85 + rnd() * 0.35, sy: 0.8 + rnd() * 0.35, sz: 0.85 + rnd() * 0.35,
          color: tan
            ? new THREE.Color().setHSL(0.09 + rnd() * 0.02, 0.16 + rnd() * 0.1, 0.58 + rnd() * 0.16)
            : new THREE.Color().setHSL(0.16 + rnd() * 0.03, 0.14 + rnd() * 0.1, 0.44 + rnd() * 0.12)
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
    [13.5, 12, 1.25], [-12, 1.5, 0.7], [-18, 34, 0.12],
    // lane cover for the urban blocks: flanking rows + a mid-road chicane
    [10.5, 26, 1.57], [10.5, 32.5, 1.57], [-10.5, 28, 1.57], [-10.5, 34.5, 1.57],
    [0, 24, 0.3], [19, 10, 1.57], [19, 16, 1.57], [22, -24, 1.57], [22, -30, 1.57],
    [6, -20, 0.2], [-11, 24, 1.57],
    [42, -24, 1.57], [42, 14, 1.57], [16, 50, 0.2], [30, 26, 0.4]
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
  const geo = new THREE.IcosahedronGeometry(0.5, 2);
  const p = geo.attributes.position;
  const seed = rnd() * 10;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // smooth positional noise (not per-vertex random) so rocks read as boulders,
    // not crumpled paper
    const k = 0.82 + 0.16 * Math.sin(x * 5.1 + seed) * Math.sin(y * 4.3 + seed * 1.7) +
      0.1 * Math.sin(z * 6.7 + seed * 0.6) * Math.sin(x * 3.3 + z * 4.1);
    p.setXYZ(i, x * k, Math.max(y * k * 0.85, -0.18), z * k);
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
  // boulder field on the skirt so wide shots have horizon texture (no solids)
  for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI * 2, rr = 62 + rnd() * 70;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    if (z > 52 && Math.abs(x) < 12) continue; // keep the gate road approach clear
    const s = 0.7 + rnd() * 1.6;
    items.push({
      x, y: groundY(W, x, z) + s * 0.05, z, ry: rnd() * Math.PI * 2,
      sx: s, sy: s * (0.6 + rnd() * 0.4), sz: s,
      color: new THREE.Color().setHSL(0.08, 0.12 + rnd() * 0.08, 0.36 + rnd() * 0.16)
    });
  }
  makeInstanced(W, geo, W.M.rock, items);
}

function buildPebbles(W) {
  // micro-detail litter: tiny flattened stones clustered like the grass
  const rnd = mulberry32(1234);
  const geo = new THREE.IcosahedronGeometry(0.05, 0);
  const items = [];
  let attempts = 0;
  while (items.length < 700 && attempts++ < 4000) {
    const x = (rnd() - 0.5) * 112, z = (rnd() - 0.5) * 112;
    const nearWall = Math.min(52 - Math.abs(x), 52 - Math.abs(z)) < 6;
    const nearNest = NESTS.some(([nx, nz]) => Math.hypot(x - nx, z - nz) < 5);
    if (!nearWall && !nearNest && rnd() < 0.7) continue;
    const s = 0.5 + rnd() * 1.4;
    items.push({
      x, y: W.heightAt(x, z) + 0.008, z,
      ry: rnd() * Math.PI, sx: s, sy: s * (0.45 + rnd() * 0.3), sz: s,
      color: new THREE.Color().setHSL(0.08, 0.1 + rnd() * 0.1, 0.3 + rnd() * 0.22)
    });
  }
  makeInstanced(W, geo, W.M.rock, items, { castShadow: false });
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
  // tuft: three crossed alpha-tested straw cards
  const blades = [];
  for (let i = 0; i < 3; i++) {
    const g = new THREE.PlaneGeometry(0.6, 0.62, 1, 2);
    // bend blade tips outward slightly
    const p = g.attributes.position;
    for (let vi = 0; vi < p.count; vi++) {
      const y = p.getY(vi);
      if (y > 0.12) p.setX(vi, p.getX(vi) + (y - 0.12) * 0.35);
    }
    if (i === 1) { // mirror UVs so crossed cards don't repeat identically
      const uv = g.attributes.uv;
      for (let vi = 0; vi < uv.count; vi++) uv.setX(vi, 1 - uv.getX(vi));
    }
    g.translate(0, 0.3, 0);
    g.rotateY(i * Math.PI / 3);
    ensureColor(g, 1);
    blades.push(g);
  }
  const geo = mergeGeometries(blades);
  geo.clearGroups();

  const rnd = mulberry32(31337);
  const items = [];
  let attempts = 0;
  while (items.length < 1500 && attempts++ < 14000) {
    const x = (rnd() - 0.5) * 116, z = (rnd() - 0.5) * 116;
    // keep off the main drive and out of building interiors
    if (Math.abs(x) < 6 && z > 20) continue;
    if (inFootprint(x, z)) continue;
    // clustering bias: near walls & structures, sparser in open yard
    const nearWall = Math.min(52 - Math.abs(x), 52 - Math.abs(z)) < 7;
    const nearThing = x > -46 && x < -29 && z > 7 && z < 23 || Math.hypot(x - 38, z - 34) < 9 ||
      Math.hypot(x + 14, z + 6) < 5 || Math.hypot(x - 16, z - 4) < 4 ||
      NESTS.some(([nx, nz]) => Math.hypot(x - nx, z - nz) < 4);
    if (!nearWall && !nearThing && rnd() < 0.62) continue;
    const s = 0.55 + rnd() * 0.75;
    items.push({
      x, y: W.heightAt(x, z) - 0.03, z, ry: rnd() * Math.PI,
      sx: s, sy: s * (0.8 + rnd() * 0.6), sz: s,
      // texture carries the straw colour; tint only adds per-tuft variation
      color: new THREE.Color().setHSL(0.09 + rnd() * 0.05, 0.14 + rnd() * 0.18, 0.66 + rnd() * 0.28)
    });
  }
  // greener weeds hugging building bases and the perimeter wall
  const weed = (x, z) => {
    const s = 0.3 + rnd() * 0.4;
    items.push({
      x, y: W.heightAt(x, z) - 0.03, z, ry: rnd() * Math.PI,
      sx: s, sy: s * (0.7 + rnd() * 0.6), sz: s,
      color: new THREE.Color().setHSL(0.22 + rnd() * 0.08, 0.3 + rnd() * 0.2, 0.42 + rnd() * 0.2)
    });
  };
  for (const [x0, z0, x1, z1] of FOOTPRINTS) {
    for (let i = 0; i < 16; i++) {
      const side = (rnd() * 4) | 0, t = rnd();
      const x = side < 2 ? (side === 0 ? x0 : x1) + (rnd() - 0.5) * 1.4 : x0 + t * (x1 - x0);
      const z = side < 2 ? z0 + t * (z1 - z0) : (side === 2 ? z0 : z1) + (rnd() - 0.5) * 1.4;
      if (!inFootprint(x, z)) weed(x, z);
    }
  }
  for (let i = 0; i < 110; i++) {
    const side = (rnd() * 4) | 0, t = (rnd() - 0.5) * 100;
    const x = side < 2 ? (side === 0 ? -50.6 : 50.6) + (rnd() - 0.5) * 1.8 : t;
    const z = side < 2 ? t : (side === 2 ? -50.6 : 50.6) + (rnd() - 0.5) * 1.8;
    weed(x, z);
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
// Urban blocks (round-6 map pass): multi-story masses with recessed windows,
// floor bands, wainscot brick, rooftop dressing — CoD lane/canyon framing
// ---------------------------------------------------------------------------

/** Recessed window: dark backing + glass sheen + bright sill.
 *  axis 'x': wall plane at x=f, outward sign s, a = center along z.
 *  axis 'z': wall plane at z=f, outward sign s, a = center along x. */
function win(W, axis, s, f, a, yC, w, h) {
  const bw = axis === 'x' ? [0.1, h, w] : [w, h, 0.1];
  const gw = axis === 'x' ? [0.02, h - 0.14, w - 0.14] : [w - 0.14, h - 0.14, 0.02];
  const sw = axis === 'x' ? [0.2, 0.09, w + 0.26] : [w + 0.26, 0.09, 0.2];
  const P = (off) => (axis === 'x' ? [f + s * off, a] : [a, f + s * off]);
  const [bx, bz] = P(0.02);
  box(W, 'concrete', bw[0], bw[1], bw[2], bx, yC - h / 2, bz, { c: 0.16 });
  const g = new THREE.BoxGeometry(gw[0], gw[1], gw[2]);
  ensureColor(g, 1);
  const [gx, gz] = P(0.085);
  xform(g, gx, yC, gz);
  W.bucket('glass', g);
  const [sx, sz] = P(0.05);
  box(W, 'concrete', sw[0], sw[1], sw[2], sx, yC - h / 2 - 0.09, sz, { c: 1.06 });
}

function acUnit(W, axis, s, f, a, yC) {
  const d = 0.36;
  const bw = axis === 'x' ? [d, 0.52, 0.72] : [0.72, 0.52, d];
  const [bx, bz] = axis === 'x' ? [f + s * (d / 2 - 0.04), a] : [a, f + s * (d / 2 - 0.04)];
  box(W, 'painted', bw[0], bw[1], bw[2], bx, yC, bz, { c: 0.82 });
  const fx = axis === 'x' ? f + s * (d - 0.02) : a;
  const fz = axis === 'x' ? a : f + s * (d - 0.02);
  cyl(W, 'rubber', 0.24, 0.05, fx, yC + 0.24, fz, {
    seg: 10, rx: axis === 'z' ? Math.PI / 2 : 0, rz: axis === 'x' ? Math.PI / 2 : 0
  });
}

function awning(W, axis, s, f, a, yC, w) {
  const aw = axis === 'x' ? [w, 0.05, 1.0] : [1.0, 0.05, w];
  const [ax, az] = axis === 'x' ? [f + s * 0.45, a] : [a, f + s * 0.45];
  box(W, 'tin', aw[0], aw[1], aw[2], ax, yC, az, {
    rz: axis === 'x' ? -s * 0.32 : 0, rx: axis === 'z' ? s * 0.32 : 0, c: 0.9
  });
}

/** Solid stucco mass with brick wainscot, floor trim bands, cornice + parapet. */
function blockShell(W, x0, x1, z0, z1, H, floors, tint) {
  const w = x1 - x0, d = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  box(W, 'stucco', w, H, d, cx, 0, cz, { c: tint });
  box(W, 'brick', w + 0.06, 1.15, d + 0.06, cx, 0, cz);
  for (const fy of floors) {
    box(W, 'stucco', w + 0.14, 0.22, d + 0.14, cx, fy - 0.11, cz, { c: tint * 1.06 });
  }
  box(W, 'stucco', w + 0.3, 0.45, d + 0.3, cx, H - 0.1, cz, { c: tint * 1.05 });
  box(W, 'tin', w + 0.36, 0.08, d + 0.36, cx, H + 0.35, cz, { c: 0.9 });
  W.solid(x0, 0, z0, x1, H + 0.45, z1, 'concrete');
  W.contact(cx, cz, w * 0.75, d * 0.75, 0);
}

function roofDress(W, x0, x1, z0, z1, H, seed) {
  const rnd = mulberry32(seed);
  // water tank on legs
  const tx = x0 + 2.5 + rnd() * (x1 - x0 - 5), tz = z0 + 2.5 + rnd() * (z1 - z0 - 5);
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + 0.4;
    box(W, 'painted', 0.09, 0.8, 0.09, tx + Math.cos(a) * 0.85, H + 0.3, tz + Math.sin(a) * 0.85, { c: 0.6 });
  }
  cyl(W, 'painted', 1.1, 1.9, tx, H + 1.05, tz, { seg: 12, c: 0.75 });
  cyl(W, 'painted', 1.12, 0.35, tx, H + 2.95, tz, { seg: 12, topScale: 0.15, c: 0.7 });
  // AC cluster
  for (let i = 0; i < 3; i++) {
    box(W, 'painted', 0.9, 0.6, 0.9, x0 + 2 + rnd() * (x1 - x0 - 4), H + 0.4, z0 + 2 + rnd() * (z1 - z0 - 4), { ry: rnd() * 0.6, c: 0.8 });
  }
  // antenna mast
  const ax = x0 + 1.5 + rnd() * (x1 - x0 - 3), az = z0 + 1.5 + rnd() * (z1 - z0 - 3);
  cyl(W, 'painted', 0.04, 3.2, ax, H + 0.35, az, { seg: 6, c: 0.7 });
  box(W, 'painted', 0.9, 0.04, 0.04, ax, H + 2.9, az, { c: 0.7 });
}

function rubble(W, x, z, n, seed) {
  const rnd = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2, rr = rnd() * 1.5;
    const px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr;
    const s = 0.22 + rnd() * 0.5;
    box(W, rnd() < 0.65 ? 'brick' : 'concrete', s * (0.8 + rnd() * 0.7), s * 0.7, s * (0.8 + rnd() * 0.6),
      px, W.heightAt(px, pz), pz, { ry: rnd() * Math.PI, rz: (rnd() - 0.5) * 0.5, c: 0.75 + rnd() * 0.35 });
  }
  for (let i = 0; i < 3; i++) {
    tube(W, 'painted', [x, 0.2, z], [x + (rnd() - 0.5) * 2.4, 0.7 + rnd() * 0.7, z + (rnd() - 0.5) * 2.4], 0.25, 0.015);
  }
  W.contact(x, z, 2.4, 2.4, 0);
}

function tireStack(W, x, z, n) {
  for (let i = 0; i < n; i++) {
    cyl(W, 'rubber', 0.34 - i * 0.01, 0.24, x + (i % 2) * 0.04, i * 0.22, z, { seg: 12 });
  }
  W.solid(x - 0.36, 0, z - 0.36, x + 0.36, n * 0.22, z + 0.36, 'rubber');
  W.contact(x, z, 0.9, 0.9, 0);
}

// East barracks: three stories framing the courtyard's east lane
function buildBarracks(W) {
  const x0 = 26, x1 = 48, z0 = -48, z1 = -30, H = 10.2;
  blockShell(W, x0, x1, z0, z1, H, [3.4, 6.8], 0.97);
  for (const fy of [1.9, 5.3, 8.7]) {
    for (const a of [-45, -41, -37, -33]) win(W, 'x', -1, x0, a, fy, 1.5, 1.7);
    for (const a of [29.5, 33.5, 37.5, 41.5, 45]) win(W, 'z', 1, z1, a, fy, 1.5, 1.7);
  }
  box(W, 'concrete', 1.8, 2.6, 0.12, 31.5, 0, z1 + 0.02, { c: 0.2 });
  box(W, 'tin', 2.6, 0.06, 1.2, 31.5, 2.7, z1 + 0.5, { rx: 0.3, c: 0.9 });
  acUnit(W, 'x', -1, x0, -41, 4.6); acUnit(W, 'x', -1, x0, -33, 8.0);
  acUnit(W, 'z', 1, z1, 37.5, 4.6); acUnit(W, 'z', 1, z1, 45, 8.0);
  awning(W, 'z', 1, z1, 29.5, 2.9, 1.9); awning(W, 'z', 1, z1, 41.5, 2.9, 1.9);
  roofDress(W, x0, x1, z0, z1, H, 4242);
  tube(W, 'rubber', [x0, 9.6, z1 - 2], [35.1, 8.4, -7.1], 1.1, 0.014);
}

// NE residential block: two stories + stair tower, west face on the gate road
function buildNEBlock(W) {
  const x0 = 22, x1 = 46, z0 = 6, z1 = 24, H = 7.2;
  blockShell(W, x0, x1, z0, z1, H, [3.4], 0.95);
  // stair tower rises above the roofline at the east end
  box(W, 'stucco', 4.4, 9.8, 6.4, 44, 0, 9, { c: 0.93 });
  box(W, 'stucco', 4.7, 0.45, 6.7, 44, 9.7, 9, { c: 1.0 });
  W.solid(41.8, H, 5.8, 46.2, 10.2, 12.2, 'concrete');
  win(W, 'x', -1, 41.8, 9, 8.2, 0.6, 1.9);
  win(W, 'z', 1, 12.2, 44, 8.2, 0.6, 1.9);
  for (const fy of [1.9, 5.1]) {
    for (const a of [9, 13, 17, 21]) win(W, 'x', -1, x0, a, fy, 1.5, 1.7);
    for (const a of [25.5, 29.5, 33.5, 37.5]) win(W, 'z', 1, z1, a, fy, 1.5, 1.7);
    for (const a of [26, 30, 34, 38]) win(W, 'z', -1, z0, a, fy, 1.3, 1.5);
  }
  // balconies on the road face, second floor
  for (const a of [11, 19]) {
    box(W, 'concrete', 1.1, 0.12, 3.2, x0 - 0.55, 3.4, a, { c: 0.9 });
    box(W, 'painted', 0.05, 0.9, 3.2, x0 - 1.05, 3.52, a, { c: 0.7 });
    box(W, 'painted', 1.1, 0.05, 0.05, x0 - 0.55, 4.35, a - 1.55, { c: 0.7 });
    box(W, 'painted', 1.1, 0.05, 0.05, x0 - 0.55, 4.35, a + 1.55, { c: 0.7 });
  }
  box(W, 'concrete', 0.12, 2.6, 1.8, x0 - 0.02, 0, 15, { c: 0.2 });
  box(W, 'tin', 1.2, 0.06, 2.6, x0 - 0.5, 2.7, 15, { rz: 0.3, c: 0.9 });
  awning(W, 'x', -1, x0, 9, 2.9, 1.9); awning(W, 'x', -1, x0, 21, 2.9, 1.9);
  acUnit(W, 'x', -1, x0, 17, 4.4); acUnit(W, 'z', 1, z1, 33.5, 4.4);
  roofDress(W, x0, x1 - 5, z0, z1, H, 777);
  // wires across the gate road to the west block
  tube(W, 'rubber', [x0, 6.9, 20], [-14, 6.4, 34], 1.3, 0.014);
  tube(W, 'rubber', [x0, 6.5, 10], [-14, 6.2, 30], 1.1, 0.012);
}

// West gate block: two stories framing the road's west side
function buildWestBlock(W) {
  const x0 = -28, x1 = -14, z0 = 26, z1 = 42, H = 6.8;
  blockShell(W, x0, x1, z0, z1, H, [3.2], 0.96);
  for (const fy of [1.8, 4.9]) {
    for (const a of [29, 32.5, 36, 39.5]) win(W, 'x', 1, x1, a, fy, 1.4, 1.6);
    for (const a of [-25.5, -21.5, -17.5]) win(W, 'z', 1, z1, a, fy, 1.4, 1.6);
  }
  awning(W, 'x', 1, x1, 29, 2.8, 2.2); awning(W, 'x', 1, x1, 36, 2.8, 2.2);
  acUnit(W, 'x', 1, x1, 32.5, 4.2); acUnit(W, 'z', 1, z1, -21.5, 4.2);
  box(W, 'concrete', 1.6, 2.5, 0.12, -17.5, 0, z1 + 0.02, { c: 0.2 });
  roofDress(W, x0, x1, z0, z1, H, 991);
  tube(W, 'rubber', [x0, 6.3, 38], [-32, 3.2, 18], 1.4, 0.012);
}

// Stair tower annex breaking the main building's silhouette to the north
function buildAnnex(W) {
  const x0 = -8, x1 = 4, z0 = -40.5, z1 = -30, H = 8.6;
  blockShell(W, x0, x1, z0, z1, H, [3.4, 6.2], 0.97);
  win(W, 'z', -1, z0, -5, 2.0, 0.6, 2.0);
  win(W, 'z', -1, z0, -1, 4.4, 0.6, 2.0);
  win(W, 'z', -1, z0, 2.5, 6.8, 0.6, 2.0);
  for (const fy of [2.0, 4.8, 7.4]) win(W, 'x', 1, x1, -35, fy, 1.4, 1.6);
  roofDress(W, x0, x1, z0, z1, H, 5150);
}

// SE block: two stories filling the gap between gate road and watchtower
function buildSEBlock(W) {
  const x0 = 12, x1 = 26, z0 = 34, z1 = 48, H = 7.0;
  blockShell(W, x0, x1, z0, z1, H, [3.3], 0.94);
  for (const fy of [1.8, 5.0]) {
    for (const a of [37, 40.5, 44]) win(W, 'x', -1, x0, a, fy, 1.4, 1.6);
    for (const a of [15, 18.5, 22]) win(W, 'z', -1, z0, a, fy, 1.4, 1.6);
  }
  awning(W, 'x', -1, x0, 40.5, 2.8, 2.0);
  acUnit(W, 'x', -1, x0, 44, 4.3);
  box(W, 'concrete', 0.12, 2.5, 1.6, x0 - 0.02, 0, 37, { c: 0.2 });
  roofDress(W, x0, x1, z0, z1, H, 881);
  tube(W, 'rubber', [x1, 6.6, 40], [38, 5.6, 34.5], 0.9, 0.012);
}

// Open-bay warehouse hugging the east perimeter wall
function buildWarehouse(W) {
  const x0 = 45, x1 = 51, z0 = -18, z1 = 6, H = 4.6;
  box(W, 'stucco', 0.4, H, z1 - z0, x1 - 0.2, 0, (z0 + z1) / 2, { c: 0.94 });
  box(W, 'stucco', x1 - x0, H, 0.4, (x0 + x1) / 2, 0, z0 + 0.2, { c: 0.94 });
  box(W, 'stucco', x1 - x0, H, 0.4, (x0 + x1) / 2, 0, z1 - 0.2, { c: 0.94 });
  W.solid(x1 - 0.4, 0, z0, x1, H, z1, 'concrete');
  W.solid(x0, 0, z0, x1, H, z0 + 0.4, 'concrete');
  W.solid(x0, 0, z1 - 0.4, x1, H, z1, 'concrete');
  for (let z = z0 + 3; z <= z1 - 2; z += 7) {
    box(W, 'concrete', 0.35, H, 0.35, x0 + 0.2, 0, z, { c: 0.9 });
    W.solid(x0, 0, z - 0.2, x0 + 0.45, H, z + 0.2, 'concrete');
  }
  box(W, 'painted', 0.14, 0.3, z1 - z0 - 1, x0 + 0.2, H - 0.3, (z0 + z1) / 2, { c: 0.7 });
  box(W, 'tin', 7.6, 0.06, z1 - z0 + 1.2, (x0 + x1) / 2 - 0.2, H, (z0 + z1) / 2, { rz: 0.1, c: 0.93 });
  W.solid(x0 - 0.4, H, z0 - 0.5, x1 + 0.4, H + 0.3, z1 + 0.5, 'metal');
  // stored cargo in the bays
  for (const [cz, n] of [[-12, 3], [-4, 4], [2, 2]]) {
    for (let i = 0; i < n; i++) {
      box(W, 'planks', 1.1, 1.1, 1.1, 48.4 - (i % 2) * 1.2, (i > 1 ? 1.1 : 0), cz + (i >> 1) * 1.2, { ry: (i * 0.7) % 0.5, c: 0.85 });
    }
    cyl(W, 'painted', 0.42, 1.0, 46.6, 0, cz + 2.2, { seg: 10, c: 0.75 });
  }
  W.contact(48, -6, 4, 12, 0);
}

// Fuel depot: vertical tanks, pump canopy, pipe runs
function buildFuelDepot(W) {
  cyl(W, 'painted', 1.5, 4.6, 47.5, 0, 18, { seg: 14, c: 0.82 });
  cyl(W, 'painted', 1.52, 0.5, 47.5, 4.6, 18, { seg: 14, topScale: 0.2, c: 0.78 });
  cyl(W, 'painted', 1.2, 3.8, 48.2, 0, 24, { seg: 14, c: 0.8 });
  cyl(W, 'painted', 1.22, 0.4, 48.2, 3.8, 24, { seg: 14, topScale: 0.2, c: 0.75 });
  W.solid(46, 0, 16.5, 49.5, 5.1, 19.5, 'metal');
  W.solid(47, 0, 22.8, 49.4, 4.2, 25.2, 'metal');
  tube(W, 'painted', [47.5, 3.4, 19.5], [48.2, 2.9, 22.8], 0.3, 0.07);
  // pump island + canopy
  for (const [px, pz] of [[44, 27], [47, 27], [44, 30], [47, 30]]) {
    box(W, 'painted', 0.14, 3.2, 0.14, px, 0, pz, { c: 0.7 });
  }
  box(W, 'tin', 4.6, 0.12, 4.6, 45.5, 3.2, 28.5, { c: 0.9 });
  box(W, 'painted', 0.5, 1.3, 0.35, 45, 0, 28.5, { c: 0.85 });
  box(W, 'painted', 0.5, 1.3, 0.35, 46.2, 0, 28.5, { c: 0.85 });
  W.solid(43.6, 0, 26.6, 47.4, 3.4, 30.4, 'metal');
  tireStack(W, 44, 22, 3);
  W.contact(47, 21, 4, 6, 0);
}

// Row of open garages along the north wall
function buildNorthSheds(W) {
  const z0 = -50.5, z1 = -44, H = 3.6;
  const bays = [[8, 13.5], [14.5, 20], [21, 26]];
  for (let i = 0; i < bays.length; i++) {
    const [a, b] = bays[i];
    const cx = (a + b) / 2;
    box(W, 'stucco', b - a, H, 0.35, cx, 0, z0 + 0.2, { c: 0.93 });
    box(W, 'stucco', 0.35, H, z1 - z0, a + 0.2, 0, (z0 + z1) / 2, { c: 0.93 });
    box(W, 'stucco', 0.35, H, z1 - z0, b - 0.2, 0, (z0 + z1) / 2, { c: 0.93 });
    box(W, 'tin', b - a + 0.8, 0.14, z1 - z0 + 0.9, cx, H, (z0 + z1) / 2, { rx: 0.09, c: 0.92 });
    box(W, 'tin', b - a + 0.8, 0.42, 0.08, cx, H - 0.1, z1 + 0.4, { c: 0.88 });
    if (i === 0) box(W, 'painted', b - a - 0.7, H - 0.4, 0.1, cx, 0, z1 - 0.3, { c: 0.52 });
    if (i === 2) box(W, 'stucco', b - a - 0.7, 1.3, 0.24, cx, 0, z1 - 0.3, { c: 0.9 });
    W.solid(a, 0, z0, b, H, z0 + 0.4, 'concrete');
    W.solid(a, 0, z0, a + 0.4, H, z1, 'concrete');
    W.solid(b - 0.4, 0, z0, b, H, z1, 'concrete');
    box(W, 'planks', 1.1, 1.1, 1.1, cx - 1, 0, z0 + 2, { c: 0.85 });
    box(W, 'planks', 1.1, 1.1, 1.1, cx - 1, 1.1, z0 + 2, { ry: 0.4, c: 0.8 });
    cyl(W, 'painted', 0.42, 1.0, cx + 1.4, 0, z0 + 2.4, { seg: 10, c: 0.75 });
  }
  // yard in front of the sheds: container, cover, debris
  // (container sits east of the main building's shadow band so it reads lit)
  box(W, 'painted', 6, 2.6, 2.5, 19.5, 0, -35.5, { ry: -0.15, c: [0.42, 0.47, 0.52] });
  solidBoxRot(W, 19.5, 0, -35.5, 6, 2.6, 2.5, -0.15, 'metal');
  box(W, 'planks', 1.1, 1.1, 1.1, 10, 0, -38, { c: 0.85 });
  box(W, 'planks', 1.1, 1.1, 1.1, 11.2, 0, -37.6, { ry: 0.5, c: 0.8 });
  box(W, 'planks', 1.1, 1.1, 1.1, 10.5, 1.1, -37.8, { ry: 0.2, c: 0.82 });
  box(W, 'concrete', 2.2, 0.9, 0.5, 16, 0, -33, { ry: 0.35, c: 0.9 });
  box(W, 'concrete', 2.2, 0.9, 0.5, 17.6, 0, -32.2, { ry: -0.4, c: 0.88 });
  cyl(W, 'painted', 0.42, 1.0, 24.6, 0, -35.5, { seg: 10, c: 0.7 });
  cyl(W, 'painted', 0.42, 1.0, 25.5, 0, -36.2, { seg: 10, c: 0.75 });
  tireStack(W, 8, -31, 3);
  rubble(W, 26, -41, 7, 46);
}

// Lane dressing: containers, rubble, tires between the new blocks
function buildUrbanDress(W) {
  box(W, 'painted', 6, 2.6, 2.5, 17, 0, -23, { ry: 0.1, c: [0.45, 0.17, 0.13] });
  solidBoxRot(W, 17, 0, -23, 6, 2.6, 2.5, 0.1, 'metal');
  box(W, 'painted', 6, 2.6, 2.5, 16.6, 2.6, -22.7, { ry: -0.06, c: [0.17, 0.25, 0.32] });
  solidBoxRot(W, 16.6, 2.6, -22.7, 6, 2.6, 2.5, -0.06, 'metal');
  rubble(W, 24, -28, 10, 31);
  rubble(W, 20, 8, 9, 32);
  rubble(W, -12, 40, 8, 33);
  rubble(W, 6, -22, 8, 34);
  tireStack(W, -10, 44, 4);
  tireStack(W, 14, 20, 3);
  tireStack(W, 24, -14, 4);
  tireStack(W, 40, 2, 3);
  // west-mid container + guard hut between shed and main building
  box(W, 'painted', 6, 2.6, 2.5, -20, 0, -6, { ry: 0.35, c: [0.3, 0.32, 0.24] });
  solidBoxRot(W, -20, 0, -6, 6, 2.6, 2.5, 0.35, 'metal');
  box(W, 'concrete', 1.7, 2.3, 1.7, -13.5, 0, -1, { c: 0.92 });
  box(W, 'concrete', 1.8, 0.35, 0.5, -13.5, 1.35, -1.85, { c: 0.18 });
  box(W, 'tin', 2.1, 0.07, 2.1, -13.5, 2.3, -1, { c: 0.9 });
  W.solid(-14.4, 0, -1.9, -12.6, 2.4, -0.1, 'concrete');
  // cover clusters in the SE open ground
  rubble(W, 42, 42, 9, 41);
  rubble(W, 34, 46, 7, 42);
  tireStack(W, 42, 36, 3);
  for (let i = 0; i < 4; i++) {
    box(W, 'planks', 1.1, 1.1, 1.1, 30 + (i % 2) * 1.3, i > 1 ? 1.1 : 0, 40 + (i >> 1) * 1.3, { ry: i * 0.4, c: 0.85 });
  }
}

// Courtyard mid-ground: burnt sedan, broken low wall, container lane
function buildCourtyardFill(W) {
  // burnt sedan wreck, nose toward the gate road
  const pos = new THREE.Vector3(5.5, W.heightAt(5.5, 30), 30);
  const yaw = -0.9, roll = 0.06, pitch = -0.02;
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
  const bx = (w, h, d, x, y, z, bucket, c, rz = 0) => {
    const g = new THREE.BoxGeometry(w, h, d);
    scaleBoxUV(g, w, h, d, UV_SCALE[bucket]);
    if (rz) g.applyMatrix4(new THREE.Matrix4().makeRotationZ(rz));
    g.translate(x, y, z);
    t(g, bucket, c);
  };
  bx(4.2, 0.3, 1.75, 0, 0.55, 0, 'painted', 0.8);
  bx(1.15, 0.45, 1.7, 1.35, 0.95, 0, 'painted', 0.85, 0.04);
  bx(1.35, 0.95, 1.65, 0.15, 1.3, 0, 'painted', 0.3);
  bx(0.05, 0.55, 1.4, 0.82, 1.66, 0, 'glass', 1);
  bx(1.3, 0.07, 1.6, -1.35, 0.95, 0, 'painted', 0.7);
  const wheel = (x, z) => {
    const g = new THREE.CylinderGeometry(0.38, 0.38, 0.26, 12);
    scaleUVCyl(g, 0.38, 0.26, UV_SCALE.rubber);
    g.rotateX(Math.PI / 2);
    g.translate(x, 0.38, z);
    t(g, 'rubber', 1);
  };
  wheel(1.35, 0.85); wheel(-1.35, 0.85); wheel(-1.35, -0.85);
  solidBoxRot(W, 5.5, 0, 30, 4.4, 1.7, 1.9, yaw, 'metal');
  tireStack(W, 8.6, 31.2, 3);
  cyl(W, 'painted', 0.42, 1.0, 3.2, 0, 31.8, { seg: 10, c: 0.6 });

  // broken low wall splitting the courtyard into two lanes
  for (const [a, b] of [[-8, -4.5], [-4.5, -1], [1.5, 5], [5, 8.5]]) {
    const h = a === 1.5 ? 0.75 : 1.15;
    const cz = 20 + (a + b) * 0.06;
    box(W, 'concrete', b - a, h, 0.35, (a + b) / 2, 0, cz, { c: 0.92 });
    box(W, 'concrete', b - a + 0.1, 0.08, 0.45, (a + b) / 2, h, cz, { c: 0.88 });
    W.solid(a, 0, cz - 0.25, b, h + 0.08, cz + 0.25, 'concrete');
  }
  rubble(W, 0.2, 20.4, 4, 57);

  // container pair closing the NE lane at an angle
  box(W, 'painted', 6, 2.6, 2.5, 14, 0, 24, { ry: 0.5, c: [0.45, 0.17, 0.13] });
  solidBoxRot(W, 14, 0, 24, 6, 2.6, 2.5, 0.5, 'metal');
  box(W, 'painted', 6, 2.6, 2.5, 15.4, 2.6, 24.8, { ry: 0.42, c: 0.8 });
  solidBoxRot(W, 15.4, 2.6, 24.8, 6, 2.6, 2.5, 0.42, 'metal');

  // pallet + crate cluster west of the wreck
  box(W, 'planks', 1.1, 1.1, 1.1, -4, 0, 10, { c: 0.85 });
  box(W, 'planks', 1.1, 1.1, 1.1, -5.2, 0, 10.6, { ry: 0.6, c: 0.8 });
  box(W, 'planks', 1.4, 0.14, 1.4, -4.5, 0, 12, { c: 0.82 });
  box(W, 'planks', 1.4, 0.14, 1.4, -4.5, 0.14, 12, { ry: 0.3, c: 0.78 });
}

// ---------------------------------------------------------------------------
// Site dress: street lamps, floodlight masts, clotheslines, condensers,
// generators, litter, jerry cans, loose tires, dishes, flag — lived-in detail
// ---------------------------------------------------------------------------
function buildSiteDress(W) {
  const rnd = mulberry32(2468);

  // street lamps: pole + arm + head, arm aimed across the road/yard
  const lamp = (x, z, s) => {
    cyl(W, 'painted', 0.07, 4.6, x, 0, z, { seg: 8, c: 0.55 });
    W.solid(x - 0.09, 0, z - 0.09, x + 0.09, 4.6, z + 0.09, 'metal');
    box(W, 'painted', 0.95, 0.08, 0.1, x + s * 0.45, 4.5, z, { c: 0.55 });
    box(W, 'painted', 0.34, 0.14, 0.2, x + s * 0.9, 4.42, z, { c: 0.7 });
    W.contact(x, z, 0.5, 0.5, 0);
  };
  lamp(-8.4, 40, 1); lamp(8.4, 34, -1); lamp(-8.4, 26, 1);
  lamp(8.4, 46, -1); lamp(-16, 2, 1); lamp(22, -2, -1);

  // floodlight masts on opposite corners of the compound
  const flood = (x, z, ry) => {
    cyl(W, 'painted', 0.09, 7, x, 0, z, { seg: 8, c: 0.6 });
    box(W, 'painted', 1.7, 0.1, 0.1, x, 6.8, z, { ry, c: 0.6 });
    for (const s of [-0.55, 0.55]) {
      box(W, 'painted', 0.34, 0.3, 0.12, x + Math.cos(ry) * s, 6.62, z - Math.sin(ry) * s, { ry, rx: 0.5, c: 0.75 });
    }
    W.solid(x - 0.11, 0, z - 0.11, x + 0.11, 7, z + 0.11, 'metal');
    W.contact(x, z, 0.6, 0.6, 0);
  };
  flood(-46, -46, 0.7); flood(44, 10, 1.9);

  // clotheslines with hanging cloth between residential faces
  const line = (x0, z0, x1, z1, seed) => {
    for (const [qx, qz] of [[x0, z0], [x1, z1]]) {
      cyl(W, 'planks', 0.045, 1.7, qx, 0, qz, { seg: 6, c: 0.7, uv: 0.3 });
      W.solid(qx - 0.06, 0, qz - 0.06, qx + 0.06, 1.7, qz + 0.06, 'wood');
    }
    tube(W, 'rubber', [x0, 1.66, z0], [x1, 1.66, z1], 0.16, 0.008);
    const r2 = mulberry32(seed);
    const cols = [[0.62, 0.58, 0.5], [0.45, 0.48, 0.34], [0.55, 0.4, 0.32], [0.5, 0.5, 0.52], [0.6, 0.52, 0.42]];
    for (let i = 0; i < 5; i++) {
      const t = (i + 0.5) / 5 + (r2() - 0.5) * 0.08;
      const h = 0.5 + r2() * 0.25;
      box(W, 'painted', 0.34, h, 0.02, x0 + (x1 - x0) * t, 1.6 - h, z0 + (z1 - z0) * t,
        { ry: r2() * 0.4 - 0.2, rz: (r2() - 0.5) * 0.12, c: cols[(r2() * cols.length) | 0] });
    }
  };
  line(28.5, -27.5, 34.5, -27.5, 11);
  line(-27, 23.5, -21, 23.5, 12);

  // ground-level AC condensers against building faces
  const condenser = (x, z) => {
    box(W, 'painted', 0.75, 0.62, 0.75, x, 0, z, { c: 0.78 });
    cyl(W, 'rubber', 0.28, 0.06, x, 0.62, z, { seg: 10 });
    W.solid(x - 0.4, 0, z - 0.4, x + 0.4, 0.7, z + 0.4, 'metal');
    W.contact(x, z, 1.0, 1.0, 0);
  };
  condenser(25.5, -36); condenser(25.5, -43); condenser(21.5, 12);
  condenser(21.5, 18); condenser(-1.1, -22);

  // diesel generators with exhaust stubs
  const generator = (x, z, ry) => {
    box(W, 'rubber', 1.3, 0.12, 0.8, x, 0, z, { ry });
    box(W, 'painted', 1.2, 0.72, 0.7, x, 0.12, z, { ry, c: 0.5 });
    cyl(W, 'painted', 0.05, 0.9, x + 0.4, 0.8, z, { seg: 6, c: 0.4 });
    solidBoxRot(W, x, 0, z, 1.3, 0.9, 0.8, ry, 'metal');
    W.contact(x, z, 1.6, 1.1, ry);
  };
  generator(26.8, -4.5, 0.3); generator(43, 21, -0.4);

  // loose tires lying flat
  for (const [x, z] of [[2, 47.5], [-5.5, 41], [12.5, 16.5], [-17, -3], [27, -19], [35.5, 41], [8.5, 19]]) {
    cyl(W, 'rubber', 0.34, 0.24, x, 0, z, { seg: 12, ry: rnd() * Math.PI });
    W.contact(x, z, 0.9, 0.9, 0);
  }

  // jerry cans at fighting positions and fuel points
  const jerryItems = [];
  for (const [x, z] of [[1.5, 8], [-1.2, 7.6], [43.5, 25.5], [44.2, 25.1], [36.5, 31.5], [36.9, 31.2], [-6.8, 33.5]]) {
    jerryItems.push({
      x, y: W.heightAt(x, z) + 0.23, z, ry: rnd() * Math.PI,
      color: new THREE.Color().setHSL(rnd() < 0.6 ? 0.22 : 0.07, 0.35, 0.4 + rnd() * 0.12)
    });
  }
  makeInstanced(W, new THREE.BoxGeometry(0.32, 0.46, 0.16), W.M.painted, jerryItems);

  // bin bags clustered at the backs of buildings
  const bagGeo = new THREE.SphereGeometry(0.24, 8, 6);
  bagGeo.scale(1, 0.8, 1);
  const bagItems = [];
  const bagNest = (cx, cz, n) => {
    for (let i = 0; i < n; i++) {
      const x = cx + (rnd() - 0.5) * 1.6, z = cz + (rnd() - 0.5) * 1.2;
      bagItems.push({
        x, y: W.heightAt(x, z) + 0.16, z, ry: rnd() * Math.PI,
        sx: 0.8 + rnd() * 0.5, sy: 0.7 + rnd() * 0.5, sz: 0.8 + rnd() * 0.5,
        color: new THREE.Color().setHSL(0.1, 0.06, 0.07 + rnd() * 0.06)
      });
    }
  };
  bagNest(-33, 21.5, 4); bagNest(12, -42.5, 3); bagNest(47, -28.5, 3); bagNest(-9, 44, 2); bagNest(20, 27, 2);
  makeInstanced(W, bagGeo, W.M.rubber, bagItems);

  // micro litter: crushed cans + paper scraps near traffic points
  const canItems = [], paperItems = [];
  for (let i = 0; i < 70; i++) {
    const [nx, nz] = NESTS[(rnd() * NESTS.length) | 0];
    const gate = rnd() < 0.4;
    const x = gate ? (rnd() - 0.5) * 12 : nx + (rnd() - 0.5) * 6;
    const z = gate ? 44 + rnd() * 14 : nz + (rnd() - 0.5) * 6;
    if (rnd() < 0.5) {
      canItems.push({
        x, y: W.heightAt(x, z) + 0.03, z,
        rx: Math.PI / 2 + (rnd() - 0.5) * 0.6, ry: rnd() * Math.PI,
        color: new THREE.Color().setHSL(0.07 + rnd() * 0.05, 0.25, 0.35 + rnd() * 0.2)
      });
    } else {
      paperItems.push({
        x, y: W.heightAt(x, z) + 0.012, z, ry: rnd() * Math.PI,
        sx: 0.7 + rnd() * 0.8, sz: 0.7 + rnd() * 0.8,
        color: new THREE.Color().setHSL(0.1, 0.08, 0.62 + rnd() * 0.2)
      });
    }
  }
  makeInstanced(W, new THREE.CylinderGeometry(0.035, 0.035, 0.11, 6), W.M.painted, canItems, { castShadow: false });
  const paperGeo = new THREE.PlaneGeometry(0.16, 0.12);
  paperGeo.rotateX(-Math.PI / 2);
  makeInstanced(W, paperGeo, W.M.concrete, paperItems, { castShadow: false });

  // satellite dishes on the two tallest roofs
  const dish = (x, y, z, ry) => {
    cyl(W, 'painted', 0.75, 0.3, x, y, z, { seg: 12, topScale: 0.25, rx: 0.7, ry, c: 0.85 });
    cyl(W, 'painted', 0.03, 0.55, x, y + 0.15, z, { seg: 5, rx: 0.7, ry, c: 0.6 });
  };
  dish(32, 10.6, -40, 0.6); dish(44, 10.15, 9, -0.8);

  // flag pole by the main building's south face
  cyl(W, 'painted', 0.035, 5.6, -6, 0, -18.5, { seg: 6, c: 0.7 });
  box(W, 'painted', 0.5, 0.85, 0.02, -6.26, 4.7, -18.5, { c: [0.35, 0.4, 0.3] });
  W.solid(-6.06, 0, -18.56, -5.94, 5.6, -18.44, 'metal');

  // hazard placards on the gate posts
  box(W, 'painted', 0.55, 0.4, 0.05, -4.1, 1.5, 52.5, { c: [0.72, 0.55, 0.15] });
  box(W, 'painted', 0.55, 0.4, 0.05, 4.1, 1.5, 52.5, { c: [0.72, 0.55, 0.15] });

  // faded posters on residential faces
  box(W, 'painted', 0.04, 0.8, 0.6, 21.98, 1.4, 10, { c: [0.6, 0.55, 0.45] });
  box(W, 'painted', 0.04, 0.9, 0.7, 21.98, 1.5, 20, { c: [0.5, 0.42, 0.35] });
  box(W, 'painted', 0.04, 0.9, 0.7, -13.98, 1.6, 30, { c: [0.55, 0.5, 0.42] });
  box(W, 'painted', 0.7, 0.9, 0.04, -12, 1.6, -15.78, { c: [0.5, 0.45, 0.38] });

  // rest spot: table + two benches south of the barracks
  box(W, 'planks', 1.6, 0.06, 0.8, 31, 0.72, -25.6, { c: 0.8 });
  for (const [lx, lz] of [[30.35, -25.95], [31.65, -25.95], [30.35, -25.25], [31.65, -25.25]]) {
    box(W, 'planks', 0.08, 0.72, 0.08, lx, 0, lz, { c: 0.7 });
  }
  box(W, 'planks', 1.4, 0.42, 0.3, 31, 0, -24.7, { c: 0.75 });
  box(W, 'planks', 1.4, 0.42, 0.3, 31, 0, -26.5, { c: 0.75 });
  W.solid(30.2, 0, -26, 31.8, 0.78, -25.2, 'wood');
}

// Dry scrub clumps: inside the compound edges + out on the skirt
function buildShrubs(W) {
  const rnd = mulberry32(4242);
  const geo = new THREE.IcosahedronGeometry(0.5, 1);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setY(i, p.getY(i) * 0.55 + 0.12);
    p.setX(i, p.getX(i) * (0.8 + 0.4 * Math.sin(i * 12.9)));
  }
  geo.computeVertexNormals();
  const items = [];
  let attempts = 0;
  while (items.length < 260 && attempts++ < 3000) {
    const a = rnd() * Math.PI * 2, rr = 56 + rnd() * 110;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    const s = 0.5 + rnd() * 1.4;
    items.push({
      x, y: groundY(W, x, z) - 0.05, z, ry: rnd() * Math.PI * 2,
      sx: s, sy: s * (0.5 + rnd() * 0.5), sz: s,
      color: new THREE.Color().setHSL(0.09 + rnd() * 0.03, 0.25, 0.3 + rnd() * 0.15)
    });
  }
  for (const [x, z] of [[-46, -20], [46, -30], [-40, 40], [40, 44], [-46, 30], [30, -46]]) {
    items.push({
      x, y: W.heightAt(x, z) - 0.05, z, ry: rnd() * Math.PI * 2,
      sx: 0.7, sy: 0.5, sz: 0.7, color: new THREE.Color().setHSL(0.1, 0.28, 0.32)
    });
  }
  makeInstanced(W, geo, W.M.rock, items, { castShadow: false });
}

// Silhouettes on the skirt so the horizon isn't empty: town row, water tower,
// pylons, ruined block
function buildFarDress(W) {
  const town = [[14, 116, 9, 5, 11], [26, 121, 7, 4, 14], [36, 117, 10, 5, 9], [48, 122, 8, 4, 12], [4, 122, 7, 4, 8], [-8, 118, 9, 5, 10]];
  for (const [x, z, w, d, h] of town) {
    // dark enough to silhouette against the haze band, or the base melts into it
    box(W, 'stucco', w, h, d, x, skirtY(x, z), z, { c: 0.55 });
    box(W, 'tin', w + 0.4, 0.1, d + 0.4, x, skirtY(x, z) + h, z, { c: 0.5 });
  }
  const wx = -125, wz = 55, wy = skirtY(wx, wz);
  for (const [dx, dz] of [[-2.2, -2.2], [2.2, -2.2], [-2.2, 2.2], [2.2, 2.2]]) {
    cyl(W, 'painted', 0.35, 14, wx + dx, wy, wz + dz, { seg: 8, c: 0.6 });
  }
  cyl(W, 'painted', 4.2, 6, wx, wy + 13, wz, { seg: 14, c: 0.65 });
  cyl(W, 'tin', 4.3, 1.2, wx, wy + 19, wz, { seg: 14, c: 0.6, topScale: 0.4 });
  const pylon = (x, z) => {
    const py = skirtY(x, z);
    box(W, 'painted', 0.5, 16, 0.5, x, py, z, { c: 0.5 });
    box(W, 'painted', 7, 0.35, 0.35, x, py + 13, z, { c: 0.5 });
    box(W, 'painted', 5, 0.3, 0.3, x, py + 15, z, { c: 0.5 });
  };
  pylon(95, -70); pylon(140, -30);
  const rx = -85, rz = -105, ry0 = skirtY(rx, rz);
  box(W, 'stucco', 14, 9, 10, rx, ry0, rz, { c: 0.75 });
  box(W, 'stucco', 6, 5, 10, rx + 10, ry0, rz, { c: 0.72 });
  box(W, 'tin', 8, 0.1, 6, rx - 2, ry0 + 9, rz, { rz: 0.3, c: 0.6 });
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
// Street litter: crushed cans, bottles, bags, rubble, boards, buckets,
// tipped drums — the small trash that makes a compound read lived-in
// ---------------------------------------------------------------------------
function buildStreetLitter(W) {
  const rnd = mulberry32(4242);
  const open = (x, z) => Math.abs(x) < 51 && Math.abs(z) < 51 && !inFootprint(x, z);
  const ANCHORS = [[0, 50], [45.5, 28.5], [-16, 34], [2, 8], [26, 14], [-10, 8],
    [14, -2], [7, 26], [-4, 34], [36, 31], [-24, 40], [20, -6]];
  const spot = (spread) => {
    for (let a = 0; a < 10; a++) {
      const [ax, az] = ANCHORS[(rnd() * ANCHORS.length) | 0];
      const x = ax + (rnd() - 0.5) * spread, z = az + (rnd() - 0.5) * spread;
      if (open(x, z)) return [x, z];
    }
    return null;
  };

  // drink cans — mostly crushed flat, a few whole
  const canItems = [];
  for (let i = 0; i < 54; i++) {
    const s = spot(7);
    if (!s) continue;
    const crushed = rnd() < 0.6;
    canItems.push({
      x: s[0], y: W.heightAt(s[0], s[1]) + (crushed ? 0.012 : 0.05), z: s[1],
      ry: rnd() * Math.PI,
      sx: crushed ? 1.5 : 1, sy: crushed ? 0.35 : 1, sz: crushed ? 1.5 : 1,
      color: new THREE.Color().setHSL(rnd() < 0.5 ? 0.0 : 0.55, 0.25 + rnd() * 0.3, 0.5 + rnd() * 0.3)
    });
  }
  makeInstanced(W, new THREE.CylinderGeometry(0.032, 0.032, 0.1, 7), W.M.tin, canItems, { castShadow: false });

  // glass bottles, most lying on their side
  const bottleItems = [];
  for (let i = 0; i < 22; i++) {
    const s = spot(6);
    if (!s) continue;
    const lying = rnd() < 0.7;
    bottleItems.push({
      x: s[0], y: W.heightAt(s[0], s[1]) + (lying ? 0.03 : 0.085), z: s[1],
      rx: lying ? Math.PI / 2 : 0, ry: rnd() * Math.PI,
      color: new THREE.Color().setHSL(rnd() < 0.6 ? 0.36 : 0.08, 0.4, 0.25 + rnd() * 0.15)
    });
  }
  makeInstanced(W, new THREE.CylinderGeometry(0.028, 0.032, 0.17, 7), W.M.painted, bottleItems, { castShadow: false });

  // flattened plastic bags
  const bagItems = [];
  for (let i = 0; i < 26; i++) {
    const s = spot(8);
    if (!s) continue;
    bagItems.push({
      x: s[0], y: W.heightAt(s[0], s[1]) + 0.02, z: s[1],
      ry: rnd() * Math.PI, sx: 1 + rnd(), sy: 0.35 + rnd() * 0.2, sz: 1 + rnd(),
      color: new THREE.Color().setHSL(0.1, 0.05 + rnd() * 0.08, 0.55 + rnd() * 0.3)
    });
  }
  makeInstanced(W, new THREE.IcosahedronGeometry(0.09, 0), W.M.rubber, bagItems, { castShadow: false });

  // rubble clusters at breach points and damaged corners
  const rubItems = [];
  for (const [cx, cz] of [[0, 50.5], [-20, 44], [30, -26], [-16, -38]]) {
    for (let i = 0; i < 30; i++) {
      const a = rnd() * Math.PI * 2, rr = rnd() * 2.6;
      const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
      if (!open(x, z)) continue;
      const s = 0.4 + rnd() * 1.1;
      rubItems.push({
        x, y: W.heightAt(x, z) + 0.02, z, ry: rnd() * Math.PI,
        sx: s, sy: s * (0.5 + rnd() * 0.4), sz: s,
        color: new THREE.Color().setHSL(0.08, 0.1 + rnd() * 0.1, 0.34 + rnd() * 0.2)
      });
    }
  }
  makeInstanced(W, new THREE.IcosahedronGeometry(0.09, 0), W.M.rock, rubItems, { castShadow: false });

  // loose boards
  const boardGeo = new THREE.BoxGeometry(0.9, 0.025, 0.14);
  ensureColor(boardGeo, 0.85);
  scaleBoxUV(boardGeo, 0.9, 0.025, 0.14, UV_SCALE.planks);
  const boardItems = [];
  for (let i = 0; i < 22; i++) {
    const s = spot(10);
    if (!s) continue;
    boardItems.push({
      x: s[0], y: W.heightAt(s[0], s[1]) + 0.015, z: s[1],
      ry: rnd() * Math.PI, rz: (rnd() - 0.5) * 0.2,
      sx: 0.6 + rnd() * 0.9, sy: 1, sz: 0.7 + rnd() * 0.6
    });
  }
  makeInstanced(W, boardGeo, W.M.planks, boardItems, { castShadow: false });

  // bins/buckets, some tipped
  const bucketItems = [];
  for (const [x, z] of [[-14.5, 33], [24, 12], [4, 46], [-26, -12], [38, 27]]) {
    const tipped = rnd() < 0.4;
    bucketItems.push({
      x, y: W.heightAt(x, z) + (tipped ? 0.11 : 0.12), z,
      rz: tipped ? Math.PI / 2 * 0.9 : 0, ry: rnd() * Math.PI,
      color: new THREE.Color().setHSL(0.55 + rnd() * 0.1, 0.25, 0.35 + rnd() * 0.15)
    });
  }
  makeInstanced(W, new THREE.CylinderGeometry(0.13, 0.1, 0.24, 9), W.M.painted, bucketItems);

  // tipped oil drums
  const drumItems = [];
  for (const [x, z] of [[-29.5, 11], [46.5, 27], [12, 47]]) {
    drumItems.push({
      x, y: W.heightAt(x, z) + 0.27, z,
      rz: Math.PI / 2, ry: rnd() * Math.PI,
      color: new THREE.Color().setHSL(0.05, 0.5, 0.3)
    });
  }
  makeInstanced(W, new THREE.CylinderGeometry(0.27, 0.27, 0.85, 10), W.M.painted, drumItems);
}

// ---------------------------------------------------------------------------

export const Builders = {
  buildPerimeter, buildMainBuilding, buildShed, buildCommsHut, buildWatchtower,
  buildTruck, buildCrates, buildBarrels, buildPallets, buildSandbags,
  buildBarriers, buildRocks, buildPebbles, buildDebris, buildGrass, buildDistant,
  buildBarracks, buildNEBlock, buildWestBlock, buildAnnex, buildUrbanDress,
  buildSEBlock, buildWarehouse, buildFuelDepot, buildNorthSheds,
  buildCourtyardFill, buildSiteDress, buildShrubs, buildFarDress, buildStreetLitter
};
