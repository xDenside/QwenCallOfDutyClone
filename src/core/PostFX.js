import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// Display grade applied after tonemap/sRGB, like a film DI pass:
// gentle S-curve, teal shadows / warm highlights, vignette, fine grain.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 }
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      c = clamp((c - 0.5) * 1.07 + 0.5, 0.0, 1.0);
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      vec3 shadowTint = vec3(0.82, 0.95, 1.02);
      vec3 highTint = vec3(1.07, 0.99, 0.88);
      c *= mix(shadowTint, highTint, smoothstep(0.10, 0.72, l));
      vec2 q = vUv - 0.5;
      c *= 1.0 - dot(q, q) * 0.5;
      float g = fract(sin(dot(vUv * vec2(1920.0, 1080.0) + vec2(uTime * 61.7), vec2(12.9898, 78.233))) * 43758.5453);
      c += (g - 0.5) * 0.026;
      gl_FragColor = vec4(c, 1.0);
    }
  `
};

export class PostFX {
  constructor(game) { this.game = game; }

  init(game) {
    const { renderer, scene, camera } = game;
    const size = renderer.getSize(new THREE.Vector2());
    // HalfFloat target so HDR highlights (sun, flashes, fire) survive to bloom
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType, samples: 4
    });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(scene, camera));
    // strength kept low: the Sky sun disc is HDR in the thousands, and any
    // appreciable strength smears it across half the frame via the mip chain
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.04, 0.25, 8.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    game.engine.composer = this.composer;
    window.addEventListener('resize', () => this.onResize());
  }

  onResize() {
    if (this.composer) {
      this.composer.setSize(window.innerWidth, window.innerHeight);
    }
  }

  update(dt, game) {
    if (this.grade) this.grade.uniforms.uTime.value = game.time;
  }
}
