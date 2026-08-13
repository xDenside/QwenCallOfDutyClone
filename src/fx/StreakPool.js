import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Instanced quad pool for stretched light streaks: tracers and metal sparks.
// Each quad is extruded along its axis and billboarded around that axis toward
// the camera. One draw call per pool. Zero per-frame allocation.
// ---------------------------------------------------------------------------

const VERT = /* glsl */`
attribute vec3 iCenter;
attribute vec3 iAxis;
attribute float iLen;
attribute float iWidth;
attribute float iAlpha;
attribute vec3 iColor;
uniform vec4 uUv;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main() {
	vec3 axis = normalize( iAxis );
	vec3 toCam = cameraPosition - iCenter;
	vec3 side = cross( axis, toCam );
	float sl = length( side );
	side = sl > 1e-4 ? side / sl : vec3( 0.0, 1.0, 0.0 );
	// taper width to zero at the camera so near-passing tracers stay thin streaks
	vec3 base = iCenter + axis * ( position.x * iLen );
	float wScale = clamp( length( cameraPosition - base ) * 0.5, 0.0, 1.0 );
	vec3 wp = base + side * ( position.y * iWidth * wScale );
	vUv = uUv.xy + uv * uUv.zw;
	vColor = iColor;
	vAlpha = iAlpha;
	gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
}`;

const FRAG = /* glsl */`
uniform sampler2D uMap;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main() {
	if ( vAlpha <= 0.003 ) discard;
	vec4 t = texture2D( uMap, vUv );
	float a = t.a * vAlpha;
	if ( a <= 0.003 ) discard;
	gl_FragColor = vec4( vColor * t.rgb * vAlpha, a );
}`;

const KIND_TRACER = 0;
const KIND_SPARK = 1;
const EMPTY = {};
const DEFAULT_TRACER_COLOR = [2.2, 1.9, 1.4];
const DEFAULT_SPARK_COLOR = [2.4, 1.35, 0.45];

export class StreakPool {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Texture} map atlas texture
   * @param {number[]} uvRect [u,v,w,h] of the streak cell
   * @param {object} o { cap, renderOrder }
   */
  constructor(scene, map, uvRect, o = {}) {
    const cap = o.cap || 64;
    this.cap = cap;
    this.count = 0;

    const base = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.getAttribute('position'));
    g.setAttribute('uv', base.getAttribute('uv'));

    this.iCenter = new Float32Array(cap * 3);
    this.iAxis = new Float32Array(cap * 3);
    this.iLen = new Float32Array(cap);
    this.iWidth = new Float32Array(cap);
    this.iAlpha = new Float32Array(cap);
    this.iColor = new Float32Array(cap * 3);
    g.setAttribute('iCenter', new THREE.InstancedBufferAttribute(this.iCenter, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iAxis', new THREE.InstancedBufferAttribute(this.iAxis, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iLen', new THREE.InstancedBufferAttribute(this.iLen, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iWidth', new THREE.InstancedBufferAttribute(this.iWidth, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iAlpha', new THREE.InstancedBufferAttribute(this.iAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iColor', new THREE.InstancedBufferAttribute(this.iColor, 3).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount = 0;
    this.geometry = g;

    // CPU sim data
    this.kind = new Uint8Array(cap);
    this.ox = new Float32Array(cap * 3);   // tracer: shot origin | spark: unused
    this.dx = new Float32Array(cap * 3);   // tracer: direction   | spark: velocity
    this.f = new Float32Array(cap * 6);
    this.fDroop = new Float32Array(cap);   // tracer gravity droop factor
    // tracer: [speed, dist, traveled, trail, width0, alphaMax]
    // spark:  [life, maxLife, grav, width0, alphaMax, lenK]

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: map },
        uUv: { value: new THREE.Vector4(uvRect[0], uvRect[1], uvRect[2], uvRect[3]) }
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
      side: THREE.DoubleSide
    });

    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = o.renderOrder !== undefined ? o.renderOrder : 7;
    scene.add(this.mesh);
  }

  /** from/to: Vector3. opts: { speed, width, color:[r,g,b], droop } */
  spawnTracer(from, to, opts) {
    if (!opts) opts = EMPTY;
    const col = opts.color || DEFAULT_TRACER_COLOR;
    if (this.count >= this.cap) this._kill(0);
    const i = this.count++;
    const i3 = i * 3, f6 = i * 6;
    let dxv = to.x - from.x, dyv = to.y - from.y, dzv = to.z - from.z;
    const dist = Math.sqrt(dxv * dxv + dyv * dyv + dzv * dzv);
    if (dist < 0.01) { this.count--; return; }
    const inv = 1 / dist;
    dxv *= inv; dyv *= inv; dzv *= inv;
    this.kind[i] = KIND_TRACER;
    this.ox[i3] = from.x; this.ox[i3 + 1] = from.y; this.ox[i3 + 2] = from.z;
    this.dx[i3] = dxv; this.dx[i3 + 1] = dyv; this.dx[i3 + 2] = dzv;
    this.f[f6] = opts.speed || 520;
    this.f[f6 + 1] = dist;
    this.f[f6 + 2] = 0;
    this.f[f6 + 3] = Math.min(6, Math.max(2, dist * 0.5)); // trail length
    this.f[f6 + 4] = opts.width || 0.045;
    this.f[f6 + 5] = 1;
    this.iColor[i3] = col[0]; this.iColor[i3 + 1] = col[1]; this.iColor[i3 + 2] = col[2];
    this.iAxis[i3] = dxv; this.iAxis[i3 + 1] = dyv; this.iAxis[i3 + 2] = dzv;
    this.fDroop[i] = opts.droop !== undefined ? opts.droop : 0.5;
  }

  /** pos/vel: Vector3. opts: { life, width, color:[r,g,b], grav } */
  spawnSpark(pos, vel, opts) {
    if (!opts) opts = EMPTY;
    const col = opts.color || DEFAULT_SPARK_COLOR;
    if (this.count >= this.cap) this._kill(0);
    const i = this.count++;
    const i3 = i * 3, f6 = i * 6;
    this.kind[i] = KIND_SPARK;
    this.iCenter[i3] = pos.x; this.iCenter[i3 + 1] = pos.y; this.iCenter[i3 + 2] = pos.z;
    this.dx[i3] = vel.x; this.dx[i3 + 1] = vel.y; this.dx[i3 + 2] = vel.z;
    this.f[f6] = 0;
    this.f[f6 + 1] = Math.max(0.08, opts.life || 0.3);
    this.f[f6 + 2] = opts.grav !== undefined ? opts.grav : 16;
    this.f[f6 + 3] = opts.width || 0.02;
    this.f[f6 + 4] = 1;
    this.f[f6 + 5] = opts.lenK || 0.03;
    this.iColor[i3] = col[0]; this.iColor[i3 + 1] = col[1]; this.iColor[i3 + 2] = col[2];
    this.iAxis[i3] = 0; this.iAxis[i3 + 1] = 1; this.iAxis[i3 + 2] = 0;
    this.iAlpha[i] = 1;
  }

  _kill(i) {
    const last = this.count - 1;
    if (i !== last) this._copyTo(i, last);
    this.count--;
  }

  _copyTo(i, j) {
    const i3 = i * 3, j3 = j * 3, i6 = i * 6, j6 = j * 6;
    this.iCenter[i3] = this.iCenter[j3]; this.iCenter[i3 + 1] = this.iCenter[j3 + 1]; this.iCenter[i3 + 2] = this.iCenter[j3 + 2];
    this.iAxis[i3] = this.iAxis[j3]; this.iAxis[i3 + 1] = this.iAxis[j3 + 1]; this.iAxis[i3 + 2] = this.iAxis[j3 + 2];
    this.iLen[i] = this.iLen[j];
    this.iWidth[i] = this.iWidth[j];
    this.iAlpha[i] = this.iAlpha[j];
    this.iColor[i3] = this.iColor[j3]; this.iColor[i3 + 1] = this.iColor[j3 + 1]; this.iColor[i3 + 2] = this.iColor[j3 + 2];
    this.kind[i] = this.kind[j];
    this.ox[i3] = this.ox[j3]; this.ox[i3 + 1] = this.ox[j3 + 1]; this.ox[i3 + 2] = this.ox[j3 + 2];
    this.dx[i3] = this.dx[j3]; this.dx[i3 + 1] = this.dx[j3 + 1]; this.dx[i3 + 2] = this.dx[j3 + 2];
    for (let k = 0; k < 6; k++) this.f[i6 + k] = this.f[j6 + k];
    this.fDroop[i] = this.fDroop[j];
  }

  /** heightFn(x,z)->y or null; used to kill sparks that hit the ground. */
  update(dt, heightFn) {
    if (this.count === 0) { this.geometry.instanceCount = 0; return; }
    let i = 0;
    while (i < this.count) {
      const i3 = i * 3, f6 = i * 6;
      let dead = false;

      if (this.kind[i] === KIND_TRACER) {
        const speed = this.f[f6], dist = this.f[f6 + 1], trail = this.f[f6 + 3];
        let traveled = this.f[f6 + 2] + speed * dt;
        this.f[f6 + 2] = traveled;
        if (traveled >= dist + trail) { dead = true; }
        else {
          const headD = traveled < dist ? traveled : dist;
          let tailD = traveled - trail; if (tailD < 0) tailD = 0; if (tailD > dist) tailD = dist;
          const midD = (headD + tailD) * 0.5;
          const tc = traveled / speed; // seconds since firing
          const drop = this.fDroop[i] * 2.4 * tc * tc;
          this.iCenter[i3] = this.ox[i3] + this.dx[i3] * midD;
          this.iCenter[i3 + 1] = this.ox[i3 + 1] + this.dx[i3 + 1] * midD - drop;
          this.iCenter[i3 + 2] = this.ox[i3 + 2] + this.dx[i3 + 2] * midD;
          this.iLen[i] = Math.max(0.02, headD - tailD);
          this.iWidth[i] = this.f[f6 + 4];
          const remain = dist + trail - traveled;
          const fadeIn = traveled < 0.4 ? traveled / 0.4 : 1;
          const fadeOut = remain < trail * 0.6 ? remain / (trail * 0.6) : 1;
          this.iAlpha[i] = this.f[f6 + 5] * fadeIn * fadeOut;
        }
      } else {
        // spark
        let life = this.f[f6] + dt;
        this.f[f6] = life;
        const maxLife = this.f[f6 + 1];
        if (life >= maxLife) { dead = true; }
        else {
          let vx = this.dx[i3], vy = this.dx[i3 + 1], vz = this.dx[i3 + 2];
          vy -= this.f[f6 + 2] * dt;
          this.dx[i3] = vx; this.dx[i3 + 1] = vy; this.dx[i3 + 2] = vz;
          let px = this.iCenter[i3] + vx * dt;
          let py = this.iCenter[i3 + 1] + vy * dt;
          let pz = this.iCenter[i3 + 2] + vz * dt;
          if (heightFn && py < heightFn(px, pz) + 0.02) dead = true;
          if (!dead) {
            this.iCenter[i3] = px; this.iCenter[i3 + 1] = py; this.iCenter[i3 + 2] = pz;
            const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
            if (sp > 1e-4) {
              const inv = 1 / sp;
              this.iAxis[i3] = vx * inv; this.iAxis[i3 + 1] = vy * inv; this.iAxis[i3 + 2] = vz * inv;
            }
            const t = life / maxLife;
            this.iLen[i] = Math.min(0.9, Math.max(0.06, sp * this.f[f6 + 5])) * (1 - t * 0.45);
            this.iWidth[i] = this.f[f6 + 3] * (1 - t * 0.5);
            const fo = 1 - t;
            this.iAlpha[i] = this.f[f6 + 4] * fo * fo;
          }
        }
      }

      if (dead) { this._kill(i); continue; }
      i++;
    }

    const attrs = this.geometry.attributes;
    attrs.iCenter.needsUpdate = true;
    attrs.iAxis.needsUpdate = true;
    attrs.iLen.needsUpdate = true;
    attrs.iWidth.needsUpdate = true;
    attrs.iAlpha.needsUpdate = true;
    attrs.iColor.needsUpdate = true;
    this.geometry.instanceCount = this.count;
  }
}
