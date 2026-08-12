import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Pooled instanced bullet-hole / scorch decals. Fixed ring buffer of cap
// quads (oldest recycled), oriented to the impact normal with a random roll,
// lifted a hair off the surface + polygon offset to avoid z-fighting.
// Hold, then fade out starting ~20 s after impact. One draw call.
// ---------------------------------------------------------------------------

const LIFE = 26;
const FADE = 6; // fade begins at LIFE - FADE = 20 s

const VERT = /* glsl */`
attribute vec3 aPos;
attribute vec4 aQuat;
attribute float aSize;
attribute float aAlpha;
varying vec2 vUv;
varying float vAlpha;
#include <fog_pars_vertex>
vec3 qrot( vec4 q, vec3 v ) {
	return v + 2.0 * cross( q.xyz, cross( q.xyz, v ) + q.w * v );
}
void main() {
	vUv = uv;
	vAlpha = aAlpha;
	vec3 wp = aPos + qrot( aQuat, vec3( position.xy * aSize, 0.0 ) );
	vec4 mvPosition = viewMatrix * vec4( wp, 1.0 );
	gl_Position = projectionMatrix * mvPosition;
	#include <fog_vertex>
}`;

const FRAG = /* glsl */`
uniform sampler2D uMap;
varying vec2 vUv;
varying float vAlpha;
#include <fog_pars_fragment>
void main() {
	if ( vAlpha <= 0.004 ) discard;
	vec4 t = texture2D( uMap, vUv );
	float a = t.a * vAlpha;
	if ( a <= 0.004 ) discard;
	gl_FragColor = vec4( t.rgb, a );
	#include <fog_fragment>
}`;

const _t = new THREE.Vector3();
const _n = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _btan = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

export class DecalPool {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Texture} map bullet-hole texture
   * @param {number} cap
   */
  constructor(scene, map, cap = 80) {
    this.cap = cap;
    this.writeIdx = 0;

    const base = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.getAttribute('position'));
    g.setAttribute('uv', base.getAttribute('uv'));

    this.aPos = new Float32Array(cap * 3);
    this.aQuat = new Float32Array(cap * 4);
    this.aSize = new Float32Array(cap);
    this.aAlpha = new Float32Array(cap); // all zero => invisible
    this.birth = new Float32Array(cap);
    this.aMax = new Float32Array(cap);

    g.setAttribute('aPos', new THREE.InstancedBufferAttribute(this.aPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aQuat', new THREE.InstancedBufferAttribute(this.aQuat, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.InstancedBufferAttribute(this.aSize, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(this.aAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount = cap;
    this.geometry = g;

    const uniforms = { uMap: { value: map } };
    Object.assign(uniforms, THREE.UniformsUtils.clone(THREE.UniformsLib.fog));
    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      fog: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3
    });

    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
  }

  /**
   * @param {THREE.Vector3} point surface point
   * @param {THREE.Vector3} normal surface normal
   * @param {number} size decal quad size in metres
   * @param {number} time current game time
   * @param {number} alphaMax peak opacity (scorch marks dimmer than holes etc.)
   */
  spawn(point, normal, size, time, alphaMax) {
    const i = this.writeIdx;
    this.writeIdx = (this.writeIdx + 1) % this.cap;

    // sanitise the normal (stubs / edge geometry may hand us junk)
    _n.copy(normal);
    if (!isFinite(_n.x) || !isFinite(_n.y) || !isFinite(_n.z) || _n.lengthSq() < 1e-8) _n.set(0, 1, 0);
    _n.normalize();

    // tangent frame around the normal
    _t.set(0, 1, 0);
    if (Math.abs(_n.y) > 0.93) _t.set(1, 0, 0);
    _tan.crossVectors(_n, _t).normalize();
    _btan.crossVectors(_n, _tan);
    _m.makeBasis(_tan, _btan, _n);
    _q.setFromRotationMatrix(_m);
    _q2.setFromAxisAngle(_n, Math.random() * Math.PI * 2);
    _q.premultiply(_q2);

    const i3 = i * 3, i4 = i * 4;
    this.aPos[i3] = point.x + _n.x * 0.007;
    this.aPos[i3 + 1] = point.y + _n.y * 0.007;
    this.aPos[i3 + 2] = point.z + _n.z * 0.007;
    this.aQuat[i4] = _q.x; this.aQuat[i4 + 1] = _q.y; this.aQuat[i4 + 2] = _q.z; this.aQuat[i4 + 3] = _q.w;
    this.aSize[i] = size;
    this.aAlpha[i] = alphaMax !== undefined ? alphaMax : 1;
    this.aMax[i] = this.aAlpha[i];
    this.birth[i] = time;

    const attrs = this.geometry.attributes;
    attrs.aPos.needsUpdate = true;
    attrs.aQuat.needsUpdate = true;
    attrs.aSize.needsUpdate = true;
    attrs.aAlpha.needsUpdate = true;
  }

  update(time) {
    let dirty = false;
    for (let i = 0; i < this.cap; i++) {
      if (this.aAlpha[i] <= 0 && this.aMax[i] <= 0) continue;
      const age = time - this.birth[i];
      if (age >= LIFE) {
        if (this.aAlpha[i] !== 0) { this.aAlpha[i] = 0; dirty = true; }
        this.aMax[i] = 0;
      } else {
        dirty = true;
        const fadeStart = LIFE - FADE;
        this.aAlpha[i] = age > fadeStart ? this.aMax[i] * (1 - (age - fadeStart) / FADE) : this.aMax[i];
      }
    }
    if (dirty) this.geometry.attributes.aAlpha.needsUpdate = true;
  }
}
