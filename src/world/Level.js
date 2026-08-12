// Strike Compound — world geometry, collision and raycast.
// Contract surface: group, spawnPoint, spawnYaw, collideMove, heightAt, raycast, update.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createMaterials } from './Textures.js';
import { Builders } from './Props.js';
import { makeFbm, makeValueNoise, smoothstep, clamp } from './Noise.js';
import { sunDirection } from './Config.js';

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

export class Level {
  constructor(game) {
    this.game = game;
    this.group = new THREE.Group();
    this.spawnPoint = null;
    this.spawnYaw = null;
    this.solids = [];
    this._terrainSeed = null;
  }

  // -------------------------------------------------------------------------
  // Terrain height field (analytic => heightAt is always consistent)
  // -------------------------------------------------------------------------
  _terrainH(x, z) {
    let h = (this.nBig(x * 0.021, z * 0.021) - 0.5) * 1.05
      + (this.nSmall(x * 0.09, z * 0.09) - 0.5) * 0.24;
    return h * this._flatMask(x, z);
  }

  /** 0 in flattened playable zones, 1 where the raw noise applies. */
  _flatMask(x, z) {
    let m = 1;
    const rectDist = (x0, z0, x1, z1) => {
      const dx = Math.max(x0 - x, x - x1, 0);
      const dz = Math.max(z0 - z, z - z1, 0);
      return Math.hypot(dx, dz);
    };
    // courtyard bowl
    m *= smoothstep(15, 27, Math.hypot(x, z - 2));
    // gate road
    m *= smoothstep(0.5, 5, rectDist(-7.5, 22, 7.5, 76));
    // building pads
    m *= smoothstep(0.5, 4, rectDist(-31.5, -41.5, -0.5, -14.5));
    m *= smoothstep(0.5, 3, rectDist(-43.5, 8.5, -30.5, 21.5));
    m *= smoothstep(0.5, 3, rectDist(26.5, -9.5, 37.5, 1.5));
    m *= smoothstep(0.5, 3, rectDist(28.5, 28.5, 42.5, 39.5));
    // pad under the wrecked truck
    m *= smoothstep(0.5, 3, rectDist(5.5, 25.5, 14.5, 34.5));
    // strips hugging the perimeter walls
    const dw = Math.min(Math.abs(z + 52), Math.abs(z - 52), Math.abs(x + 52), Math.abs(x - 52));
    m *= smoothstep(0.7, 4.2, dw);
    return m;
  }

  init(game) {
    game.scene.add(this.group);
    this.M = createMaterials(game.renderer);
    this.nBig = makeFbm(1234, 4);
    this.nSmall = makeValueNoise(5678);
    this.timeUniform = { value: 0 };
    this._contacts = [];

    // ---- terrain mesh ----
    const T_SIZE = 176, T_SEG = 132;
    const tg = new THREE.PlaneGeometry(T_SIZE, T_SIZE, T_SEG, T_SEG);
    tg.rotateX(-Math.PI / 2);
    const tp = tg.attributes.position;
    const tc = new Float32Array(tp.count * 3);
    const uv = tg.attributes.uv;
    for (let i = 0; i < tp.count; i++) {
      const x = tp.getX(i), z = tp.getZ(i);
      tp.setY(i, this._terrainH(x, z));
      uv.setXY(i, uv.getX(i) * T_SIZE * 0.125, uv.getY(i) * T_SIZE * 0.125);
      const tint = 0.88 + this.nSmall(x * 0.05 + 3, z * 0.05) * 0.18;
      const warm = this.nBig(x * 0.013, z * 0.013) * 0.07;
      tc[i * 3] = tint + warm; tc[i * 3 + 1] = tint; tc[i * 3 + 2] = tint - warm * 0.6;
    }
    tg.setAttribute('color', new THREE.BufferAttribute(tc, 3));
    tg.computeVertexNormals();
    const terrain = new THREE.Mesh(tg, this.M.dirt);
    terrain.receiveShadow = true;
    this.group.add(terrain);

    // ---- decal overlay (tire tracks, wet patches, baked wall-base AO) ----
    const dg = new THREE.PlaneGeometry(140, 140, 72, 72);
    dg.rotateX(-Math.PI / 2);
    const dp = dg.attributes.position;
    for (let i = 0; i < dp.count; i++) {
      dp.setY(i, this._terrainH(dp.getX(i), dp.getZ(i)) + 0.015);
    }
    dg.computeVertexNormals();
    const decal = new THREE.Mesh(dg, this.M.decal);
    decal.renderOrder = 1;
    decal.receiveShadow = true;
    this.group.add(decal);

    // ---- structures & props ----
    const buckets = { concrete: [], tin: [], planks: [], painted: [], rubber: [], glass: [] };
    const W = {
      M: this.M,
      group: this.group,
      timeUniform: this.timeUniform,
      bucket: (name, geo) => { if (buckets[name]) buckets[name].push(geo); },
      solid: (x0, y0, z0, x1, y1, z1, m) => {
        if (x1 < x0) [x0, x1] = [x1, x0];
        if (z1 < z0) [z0, z1] = [z1, z0];
        this.solids.push({ x0, y0, z0, x1, y1: Math.max(y1, y0 + 0.05), z1, m });
      },
      contact: (x, z, sx, sz, ry) => this._contacts.push({ x, z, sx, sz, ry }),
      heightAt: (x, z) => this._terrainH(x, z)
    };

    Builders.buildPerimeter(W);
    Builders.buildMainBuilding(W);
    Builders.buildShed(W);
    Builders.buildCommsHut(W);
    Builders.buildWatchtower(W);
    Builders.buildTruck(W);
    Builders.buildCrates(W);
    Builders.buildBarrels(W);
    Builders.buildPallets(W);
    Builders.buildSandbags(W);
    Builders.buildBarriers(W);
    Builders.buildRocks(W);
    Builders.buildDebris(W);
    Builders.buildGrass(W);
    Builders.buildDistant(W, sunDirection());

    // keep practical-light anchors + beacon material for the lighting system
    this.beaconMat = W.beaconMat || null;
    this.beaconPos = W.beaconPos || null;
    this.bulbPos = W.bulbPos || null;
    this.commsBulbPos = W.commsBulbPos || null;

    // ---- merge buckets into single meshes ----
    for (const [name, geos] of Object.entries(buckets)) {
      if (!geos.length) continue;
      const merged = mergeGeometries(geos, false);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, this.M[name]);
      mesh.castShadow = name !== 'glass';
      mesh.receiveShadow = name !== 'glass';
      if (name === 'glass') mesh.renderOrder = 3;
      this.group.add(mesh);
    }

    // ---- contact-shadow blobs under props ----
    if (this._contacts.length) {
      const quad = new THREE.PlaneGeometry(1, 1);
      quad.rotateX(-Math.PI / 2);
      const im = new THREE.InstancedMesh(quad, this.M.contactAO, this._contacts.length);
      this._contacts.forEach((c, i) => {
        _e.set(0, c.ry || 0, 0);
        _q.setFromEuler(_e);
        _s.set(c.sx, 1, c.sz);
        _v.set(c.x, this._terrainH(c.x, c.z) + 0.028, c.z);
        _m4.compose(_v, _q, _s);
        im.setMatrixAt(i, _m4);
      });
      im.instanceMatrix.needsUpdate = true;
      im.frustumCulled = false;
      im.renderOrder = 2;
      this.group.add(im);
    }

    // ---- ambient dust motes ----
    this._buildDust();

    // ---- spawn: outside the breached gate, looking into the compound ----
    const sx = 0, sz = 61;
    this.spawnPoint = new THREE.Vector3(sx, this._terrainH(sx, sz) + 0.02, sz);
    this.spawnYaw = 0; // yaw 0 looks down -Z, straight through the breach
  }

  _buildDust() {
    const regions = [
      { x0: -4, y0: 0.2, z0: 46, x1: 4, y1: 3.4, z1: 58, n: 100 },
      { x0: -24.5, y0: 0.2, z0: -19, x1: -19.5, y1: 3.2, z1: -11, n: 70 },
      { x0: -10.5, y0: 0.2, z0: -19, x1: -5.5, y1: 3.2, z1: -11, n: 70 },
      { x0: -28, y0: 0.4, z0: -27.5, x1: -4, y1: 5.2, z1: -16.5, n: 100 },
      { x0: -36, y0: 0.1, z0: -12, x1: 36, y1: 2.8, z1: 46, n: 240 }
    ];
    let total = 0;
    for (const r of regions) total += r.n;
    const pos = new Float32Array(total * 3);
    const vel = new Float32Array(total * 3);
    const reg = new Uint8Array(total);
    const rng = (() => { let a = 48271; return () => { a = Math.imul(a, 48271) % 2147483647; return (a & 0x7fffffff) / 2147483647; }; })();
    let i = 0;
    regions.forEach((r, ri) => {
      for (let k = 0; k < r.n; k++, i++) {
        pos[i * 3] = r.x0 + rng() * (r.x1 - r.x0);
        pos[i * 3 + 1] = r.y0 + rng() * (r.y1 - r.y0);
        pos[i * 3 + 2] = r.z0 + rng() * (r.z1 - r.z0);
        vel[i * 3] = 0.02 + (rng() - 0.5) * 0.05;
        vel[i * 3 + 1] = 0.002 + (rng() - 0.3) * 0.02;
        vel[i * 3 + 2] = 0.01 + (rng() - 0.5) * 0.04;
        reg[i] = ri;
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this._dustVel = vel;
    this._dustReg = reg;
    this._dustRegions = regions;
    const pts = new THREE.Points(geo, this.M.particle);
    pts.frustumCulled = false;
    pts.renderOrder = 3;
    this._dust = pts;
    this.group.add(pts);
  }

  // -------------------------------------------------------------------------
  // Collision
  // -------------------------------------------------------------------------
  _floorUnder(x, z, yFeet, r) {
    let f = this._terrainH(x, z);
    for (let i = 0; i < this.solids.length; i++) {
      const b = this.solids[i];
      if (b.y1 > f && b.y1 <= yFeet + 0.45 &&
        x + r > b.x0 && x - r < b.x1 && z + r > b.z0 && z - r < b.z1) {
        f = b.y1;
      }
    }
    return f;
  }

  /** Public ground query for AI/props: terrain + low walkables (steps, slabs, pallets). */
  heightAt(x, z) {
    const t = this._terrainH(x, z);
    let f = t;
    const r = 0.3;
    for (let i = 0; i < this.solids.length; i++) {
      const b = this.solids[i];
      if (b.y1 > f && b.y1 <= t + 0.62 &&
        x + r > b.x0 && x - r < b.x1 && z + r > b.z0 && z - r < b.z1) {
        f = b.y1;
      }
    }
    return f;
  }

  _moveAxis(pos, vel, dt, axis, r, h, STEP) {
    const v = axis === 0 ? vel.x : vel.z;
    if (v === 0) return;
    const p0 = axis === 0 ? pos.x : pos.z;
    const dir = v > 0 ? 1 : -1;
    if (axis === 0) pos.x += v * dt; else pos.z += v * dt;

    for (let iter = 0; iter < 3; iter++) {
      let block = null, blockFace = 0;
      for (let i = 0; i < this.solids.length; i++) {
        const b = this.solids[i];
        if (pos.y + h - 0.02 <= b.y0 || pos.y + 0.02 >= b.y1) continue;
        if (!(pos.x + r > b.x0 && pos.x - r < b.x1 && pos.z + r > b.z0 && pos.z - r < b.z1)) continue;
        // only solids we actually moved into count as blockers
        const startedClear = axis === 0
          ? (dir > 0 ? p0 <= b.x0 - r + 1e-3 : p0 >= b.x1 + r - 1e-3)
          : (dir > 0 ? p0 <= b.z0 - r + 1e-3 : p0 >= b.z1 + r - 1e-3);
        if (!startedClear) continue;
        const face = axis === 0
          ? (dir > 0 ? b.x0 - r : b.x1 + r)
          : (dir > 0 ? b.z0 - r : b.z1 + r);
        if (!block || (dir > 0 ? face < blockFace : face > blockFace)) {
          block = b; blockFace = face;
        }
      }
      if (!block) return;

      // step-up: walkable ledges and stair slices
      if (block.y1 - pos.y <= STEP && block.y1 > pos.y - 0.02) {
        const ny = block.y1;
        let fits = true;
        for (let i = 0; i < this.solids.length; i++) {
          const c = this.solids[i];
          if (c === block) continue;
          if (ny + h - 0.02 <= c.y0 || ny + 0.02 >= c.y1) continue;
          if (pos.x + r > c.x0 && pos.x - r < c.x1 && pos.z + r > c.z0 && pos.z - r < c.z1) {
            fits = false; break;
          }
        }
        if (fits) { pos.y = ny; continue; }
      }

      if (axis === 0) { pos.x = blockFace; vel.x = 0; }
      else { pos.z = blockFace; vel.z = 0; }
      return;
    }
  }

  collideMove(pos, vel, dt, opts = {}) {
    const r = opts.radius ?? 0.35;
    const h = opts.height ?? 1.8;
    const STEP = 0.45;

    this._moveAxis(pos, vel, dt, 0, r, h, STEP);
    this._moveAxis(pos, vel, dt, 2, r, h, STEP);

    pos.y += vel.y * dt;
    let grounded = false;
    const floorY = this._floorUnder(pos.x, pos.z, pos.y, r);
    if (pos.y <= floorY + 1e-4) {
      pos.y = floorY;
      if (vel.y < 0) vel.y = 0;
      grounded = true;
    } else if (pos.y - floorY < 0.08 && vel.y <= 0) {
      grounded = true;
    }

    // ceilings
    if (vel.y > 0) {
      const headY = pos.y + h;
      for (let i = 0; i < this.solids.length; i++) {
        const b = this.solids[i];
        if (headY > b.y0 && pos.y < b.y0 &&
          pos.x + r > b.x0 && pos.x - r < b.x1 && pos.z + r > b.z0 && pos.z - r < b.z1) {
          pos.y = b.y0 - h - 0.001;
          vel.y = 0;
        }
      }
    }

    // soft world bounds
    pos.x = clamp(pos.x, -120, 120);
    pos.z = clamp(pos.z, -120, 120);
    if (pos.y < -25) pos.y = -25;
    return grounded;
  }

  // -------------------------------------------------------------------------
  // Raycast (bullets + AI line of sight)
  // -------------------------------------------------------------------------
  raycast(origin, dir, maxDist) {
    const o = this._ro.copy(origin);
    const d = this._rd.copy(dir);
    const len = d.length();
    if (len < 1e-8) return null;
    d.multiplyScalar(1 / len);

    let bestT = Infinity, bestM = null;
    let bnx = 0, bny = 1, bnz = 0;

    // solids (slab test)
    for (let i = 0; i < this.solids.length; i++) {
      const b = this.solids[i];
      let tmin = 0, tmax = maxDist;
      let axis = -1;
      // X
      if (Math.abs(d.x) < 1e-9) {
        if (o.x < b.x0 || o.x > b.x1) continue;
      } else {
        let t1 = (b.x0 - o.x) / d.x, t2 = (b.x1 - o.x) / d.x;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        if (t1 > tmin) { tmin = t1; axis = 0; }
        if (t2 < tmax) tmax = t2;
      }
      // Y
      if (Math.abs(d.y) < 1e-9) {
        if (o.y < b.y0 || o.y > b.y1) continue;
      } else {
        let t1 = (b.y0 - o.y) / d.y, t2 = (b.y1 - o.y) / d.y;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        if (t1 > tmin) { tmin = t1; axis = 1; }
        if (t2 < tmax) tmax = t2;
      }
      // Z
      if (Math.abs(d.z) < 1e-9) {
        if (o.z < b.z0 || o.z > b.z1) continue;
      } else {
        let t1 = (b.z0 - o.z) / d.z, t2 = (b.z1 - o.z) / d.z;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        if (t1 > tmin) { tmin = t1; axis = 2; }
        if (t2 < tmax) tmax = t2;
      }
      if (tmax < tmin || tmin > maxDist) continue;
      if (tmin < bestT) {
        bestT = tmin; bestM = b.m;
        if (axis === 0) { bnx = d.x > 0 ? -1 : 1; bny = 0; bnz = 0; }
        else if (axis === 1) { bnx = 0; bny = d.y > 0 ? -1 : 1; bnz = 0; }
        else if (axis === 2) { bnx = 0; bny = 0; bnz = d.z > 0 ? -1 : 1; }
        else { bnx = -d.x; bny = -d.y; bnz = -d.z; } // origin inside
      }
    }

    // terrain heightfield march (bounded by the nearest solid hit)
    if (!(d.y >= 0 && o.y > 30)) {
      const limit = Math.min(maxDist, bestT);
      const step = 0.45;
      let prevT = 0;
      let prevD = o.y - this._terrainH(o.x, o.z);
      if (prevD <= 0) {
        if (0 < bestT) {
          bestT = 0; bestM = 'dirt';
          bnx = 0; bny = 1; bnz = 0;
        }
      } else {
        for (let t = step; t <= limit; t += step) {
          const y = o.y + d.y * t;
          const dd = y - this._terrainH(o.x + d.x * t, o.z + d.z * t);
          if (dd < 0) {
            let lo = prevT, hi = t;
            for (let i = 0; i < 7; i++) {
              const tm = (lo + hi) / 2;
              const dm = o.y + d.y * tm - this._terrainH(o.x + d.x * tm, o.z + d.z * tm);
              if (dm < 0) hi = tm; else lo = tm;
            }
            const th = (lo + hi) / 2;
            if (th < bestT) {
              bestT = th; bestM = 'dirt';
              const e = 0.35;
              const px = o.x + d.x * th, pz = o.z + d.z * th;
              const gx = this._terrainH(px + e, pz) - this._terrainH(px - e, pz);
              const gz = this._terrainH(px, pz + e) - this._terrainH(px, pz - e);
              _v.set(-gx / (2 * e), 1, -gz / (2 * e)).normalize();
              bnx = _v.x; bny = _v.y; bnz = _v.z;
            }
            break;
          }
          prevT = t; prevD = dd;
        }
      }
    }

    if (!bestM || bestT > maxDist) return null;
    return {
      point: new THREE.Vector3(o.x + d.x * bestT, o.y + d.y * bestT, o.z + d.z * bestT),
      normal: new THREE.Vector3(bnx, bny, bnz),
      material: bestM,
      distance: bestT
    };
  }

  // -------------------------------------------------------------------------
  update(dt, game) {
    this.timeUniform.value = game.time;

    // drift the ambient dust motes, wrapping inside their region boxes
    const attr = this._dust.geometry.attributes.position;
    const pos = attr.array, vel = this._dustVel, reg = this._dustReg, regions = this._dustRegions;
    for (let i = 0; i < reg.length; i++) {
      const r = regions[reg[i]];
      const j = i * 3;
      pos[j] += vel[j] * dt;
      pos[j + 1] += vel[j + 1] * dt;
      pos[j + 2] += vel[j + 2] * dt;
      if (pos[j] > r.x1) pos[j] = r.x0; else if (pos[j] < r.x0) pos[j] = r.x1;
      if (pos[j + 1] > r.y1) pos[j + 1] = r.y0; else if (pos[j + 1] < r.y0) pos[j + 1] = r.y1;
      if (pos[j + 2] > r.z1) pos[j + 2] = r.z0; else if (pos[j + 2] < r.z0) pos[j + 2] = r.z1;
    }
    attr.needsUpdate = true;
  }
}

// scratch vectors for raycast (no per-call allocation)
Level.prototype._ro = new THREE.Vector3();
Level.prototype._rd = new THREE.Vector3();
