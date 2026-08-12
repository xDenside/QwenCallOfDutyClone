import * as THREE from 'three';

// ---------------------------------------------------------------------------
// CPU-simulated, GPU-rendered Points pool. Structure-of-arrays, zero per-frame
// allocation, swap-remove compaction. Per-particle atlas rect, colour lerp,
// rotation, drag/gravity/turbulence. Used for smoke, dust, fireballs, glows,
// blood and spark dots.
// ---------------------------------------------------------------------------

const VERT = /* glsl */`
attribute vec4 aUv;
attribute vec3 aColor;
attribute float aAlpha;
attribute float aSize;
attribute float aRot;
uniform float uHeight;
varying vec4 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vRot;
#include <fog_pars_vertex>
void main() {
	vUv = aUv;
	vColor = aColor;
	vAlpha = aAlpha;
	vRot = aRot;
	vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
	float dist = max( 0.12, -mvPosition.z );
	float ps = aSize * uHeight * 0.5 * projectionMatrix[1][1] / dist;
	gl_PointSize = clamp( ps, 0.0, 820.0 );
	gl_Position = projectionMatrix * mvPosition;
	#include <fog_vertex>
}`;

const FRAG = /* glsl */`
uniform sampler2D uMap;
varying vec4 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vRot;
#include <fog_pars_fragment>
void main() {
	if ( vAlpha <= 0.003 ) discard;
	vec2 p = gl_PointCoord - 0.5;
	float cs = cos( vRot );
	float sn = sin( vRot );
	p = vec2( p.x * cs - p.y * sn, p.x * sn + p.y * cs );
	if ( abs( p.x ) > 0.5 || abs( p.y ) > 0.5 ) discard;
	vec2 uv = vUv.xy + ( p + 0.5 ) * vUv.zw;
	vec4 t = texture2D( uMap, uv );
	float a = t.a * vAlpha;
	if ( a <= 0.003 ) discard;
	gl_FragColor = vec4( vColor * t.rgb * vAlpha, a );
	#include <fog_fragment>
}`;

export class PointsPool {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Texture} map atlas texture
   * @param {object} o { cap, blending, fog, renderOrder }
   */
  constructor(scene, map, o = {}) {
    const cap = o.cap || 256;
    this.cap = cap;
    this.count = 0;
    this._over = 0;

    const g = new THREE.BufferGeometry();
    this.aPos = new Float32Array(cap * 3);
    this.aUv = new Float32Array(cap * 4);
    this.aCol = new Float32Array(cap * 3);
    this.aAlpha = new Float32Array(cap);
    this.aSize = new Float32Array(cap);
    this.aRot = new Float32Array(cap);
    g.setAttribute('position', new THREE.BufferAttribute(this.aPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aUv', new THREE.BufferAttribute(this.aUv, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.aCol, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.aAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.aSize, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aRot', new THREE.BufferAttribute(this.aRot, 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.geometry = g;

    // CPU-only sim data
    this.vel = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.size0 = new Float32Array(cap);
    this.size1 = new Float32Array(cap);
    this.rotV = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    this.grav = new Float32Array(cap);
    this.turb = new Float32Array(cap);
    this.seed = new Float32Array(cap);
    this.alphaMax = new Float32Array(cap);
    this.c0 = new Float32Array(cap * 3);
    this.c1 = new Float32Array(cap * 3);

    const uniforms = { uMap: { value: map }, uHeight: { value: 1024 } };
    if (o.fog) Object.assign(uniforms, THREE.UniformsUtils.clone(THREE.UniformsLib.fog));
    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: o.blending !== undefined ? o.blending : THREE.NormalBlending,
      fog: !!o.fog
    });

    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = o.renderOrder !== undefined ? o.renderOrder : 4;
    scene.add(this.points);
  }

  setViewportHeight(devicePxHeight) {
    this.material.uniforms.uHeight.value = devicePxHeight;
  }

  /**
   * cfg: { pos:Vector3, vel:Vector3, life, size0, size1, rot, rotV, drag,
   *        grav, turb, alpha, c0:[r,g,b], c1:[r,g,b], uv:[u,v,w,h] }
   * All fields are copied immediately — cfg objects are safe to reuse.
   */
  spawn(cfg) {
    let i;
    if (this.count < this.cap) {
      i = this.count++;
    } else {
      this._over = (this._over + 7) % this.cap;
      i = this._over;
    }
    const i3 = i * 3, i4 = i * 4;
    const p = cfg.pos, v = cfg.vel;
    this.aPos[i3] = p.x; this.aPos[i3 + 1] = p.y; this.aPos[i3 + 2] = p.z;
    this.vel[i3] = v.x; this.vel[i3 + 1] = v.y; this.vel[i3 + 2] = v.z;
    this.life[i] = 0;
    this.maxLife[i] = Math.max(0.03, cfg.life || 0.5);
    this.size0[i] = cfg.size0 || 0.1;
    this.size1[i] = cfg.size1 !== undefined ? cfg.size1 : cfg.size0 || 0.1;
    this.aRot[i] = cfg.rot || 0;
    this.rotV[i] = cfg.rotV || 0;
    this.drag[i] = cfg.drag || 0;
    this.grav[i] = cfg.grav || 0;
    this.turb[i] = cfg.turb || 0;
    this.seed[i] = Math.random() * 97;
    this.alphaMax[i] = cfg.alpha !== undefined ? cfg.alpha : 1;
    const c0 = cfg.c0, c1 = cfg.c1 || cfg.c0;
    this.c0[i3] = c0[0]; this.c0[i3 + 1] = c0[1]; this.c0[i3 + 2] = c0[2];
    this.c1[i3] = c1[0]; this.c1[i3 + 1] = c1[1]; this.c1[i3 + 2] = c1[2];
    const uv = cfg.uv;
    this.aUv[i4] = uv[0]; this.aUv[i4 + 1] = uv[1]; this.aUv[i4 + 2] = uv[2]; this.aUv[i4 + 3] = uv[3];
  }

  _copyTo(i, j) {
    const i3 = i * 3, j3 = j * 3, i4 = i * 4, j4 = j * 4;
    this.aPos[i3] = this.aPos[j3]; this.aPos[i3 + 1] = this.aPos[j3 + 1]; this.aPos[i3 + 2] = this.aPos[j3 + 2];
    this.aUv[i4] = this.aUv[j4]; this.aUv[i4 + 1] = this.aUv[j4 + 1]; this.aUv[i4 + 2] = this.aUv[j4 + 2]; this.aUv[i4 + 3] = this.aUv[j4 + 3];
    this.aCol[i3] = this.aCol[j3]; this.aCol[i3 + 1] = this.aCol[j3 + 1]; this.aCol[i3 + 2] = this.aCol[j3 + 2];
    this.aAlpha[i] = this.aAlpha[j];
    this.aSize[i] = this.aSize[j];
    this.aRot[i] = this.aRot[j];
    this.vel[i3] = this.vel[j3]; this.vel[i3 + 1] = this.vel[j3 + 1]; this.vel[i3 + 2] = this.vel[j3 + 2];
    this.life[i] = this.life[j];
    this.maxLife[i] = this.maxLife[j];
    this.size0[i] = this.size0[j];
    this.size1[i] = this.size1[j];
    this.rotV[i] = this.rotV[j];
    this.drag[i] = this.drag[j];
    this.grav[i] = this.grav[j];
    this.turb[i] = this.turb[j];
    this.seed[i] = this.seed[j];
    this.alphaMax[i] = this.alphaMax[j];
    this.c0[i3] = this.c0[j3]; this.c0[i3 + 1] = this.c0[j3 + 1]; this.c0[i3 + 2] = this.c0[j3 + 2];
    this.c1[i3] = this.c1[j3]; this.c1[i3 + 1] = this.c1[j3 + 1]; this.c1[i3 + 2] = this.c1[j3 + 2];
  }

  update(dt, time) {
    const n0 = this.count;
    if (n0 === 0) return;
    const aPos = this.aPos, vel = this.vel, life = this.life, maxLife = this.maxLife;
    const aCol = this.aCol, aAlpha = this.aAlpha, aSize = this.aSize, aRot = this.aRot;
    const c0 = this.c0, c1 = this.c1;

    let i = 0;
    while (i < this.count) {
      life[i] += dt;
      if (life[i] >= maxLife[i]) {
        const last = this.count - 1;
        if (i !== last) this._copyTo(i, last);
        this.count--;
        continue;
      }
      const i3 = i * 3;
      const t = life[i] / maxLife[i];

      // integrate
      const dmp = Math.max(0, 1 - this.drag[i] * dt);
      vel[i3] *= dmp; vel[i3 + 1] *= dmp; vel[i3 + 2] *= dmp;
      vel[i3 + 1] -= this.grav[i] * dt;
      const tb = this.turb[i];
      if (tb > 0) {
        const sd = this.seed[i];
        vel[i3] += Math.sin(time * 2.9 + sd) * tb * dt;
        vel[i3 + 2] += Math.cos(time * 2.3 + sd * 1.31) * tb * dt;
        vel[i3 + 1] += Math.sin(time * 1.7 + sd * 0.71) * tb * 0.35 * dt;
      }
      aPos[i3] += vel[i3] * dt;
      aPos[i3 + 1] += vel[i3 + 1] * dt;
      aPos[i3 + 2] += vel[i3 + 2] * dt;

      // appearance
      aSize[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * t;
      aRot[i] += this.rotV[i] * dt;
      const ain = t < 0.08 ? t / 0.08 : 1;
      const aout = t > 0.55 ? 1 - (t - 0.55) / 0.45 : 1;
      aAlpha[i] = this.alphaMax[i] * ain * aout;
      const ct = t < 0.5 ? t * 1.4 : 0.7 + (t - 0.5) * 0.6; // warm phase decays faster
      const ic = Math.min(1, ct);
      aCol[i3] = c0[i3] + (c1[i3] - c0[i3]) * ic;
      aCol[i3 + 1] = c0[i3 + 1] + (c1[i3 + 1] - c0[i3 + 1]) * ic;
      aCol[i3 + 2] = c0[i3 + 2] + (c1[i3 + 2] - c0[i3 + 2]) * ic;
      i++;
    }

    if (n0 > 0) {
      const attrs = this.geometry.attributes;
      attrs.position.needsUpdate = true;
      attrs.aUv.needsUpdate = true;
      attrs.aColor.needsUpdate = true;
      attrs.aAlpha.needsUpdate = true;
      attrs.aSize.needsUpdate = true;
      attrs.aRot.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, this.count);
  }
}
