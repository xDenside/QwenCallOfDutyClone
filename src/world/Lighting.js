// Golden-hour lighting rig: low warm sun + cool bounce + dust haze.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { sunDirection, FOG_COLOR, FOG_DENSITY } from './Config.js';

export class Lighting {
  constructor(game) {
    this.game = game;
    this._practicals = [];
  }

  init(game) {
    const scene = game.scene;
    const sunDir = sunDirection();

    // ---- physically-ish sky ----
    const sky = new Sky();
    sky.scale.setScalar(2000);
    sky.frustumCulled = false;
    const u = sky.material.uniforms;
    u.turbidity.value = 5.0;
    u.rayleigh.value = 1.7;
    u.mieCoefficient.value = 0.00045;
    u.mieDirectionalG.value = 0.8;
    u.sunPosition.value.copy(sunDir);
    // raw Sky HDR peaks in the hundreds near the sun; bloom smears that
    // across building silhouettes. Soft-clamp the peak so the disc still
    // reads white-hot but the halo stays contained.
    sky.material.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace(
        'gl_FragColor = vec4( texColor, 1.0 );',
        'vec3 sunOver = max( texColor - vec3( 12.0 ), 0.0 );\n' +
        'texColor = min( texColor, vec3( 12.0 ) ) + ( 1.0 - exp( -sunOver * 0.25 ) );\n' +
        'gl_FragColor = vec4( texColor, 1.0 );'
      );
    };
    scene.add(sky);

    // IBL from the same sky so metals/glass have something to reflect;
    // without it, shadow-side metal faces render near-black
    const pmrem = new THREE.PMREMGenerator(game.renderer);
    const envScene = new THREE.Scene();
    const envSky = new Sky();
    envSky.scale.setScalar(2000);
    const eu = envSky.material.uniforms;
    eu.turbidity.value = u.turbidity.value;
    eu.rayleigh.value = u.rayleigh.value;
    eu.mieCoefficient.value = u.mieCoefficient.value;
    eu.mieDirectionalG.value = u.mieDirectionalG.value;
    eu.sunPosition.value.copy(sunDir);
    envScene.add(envSky);
    scene.environment = pmrem.fromScene(envScene, 0.04).texture;
    // keep global low so the grade stays golden-hour; metals boost per-material
    scene.environmentIntensity = 0.15;
    pmrem.dispose();

    // ---- the sun ----
    const sun = new THREE.DirectionalLight(0xffca8f, 3.0);
    sun.position.copy(sunDir).multiplyScalar(170);
    sun.target.position.set(0, 0, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    const sc = sun.shadow.camera;
    sc.left = -104; sc.right = 104; sc.top = 104; sc.bottom = -104;
    sc.near = 30; sc.far = 380;
    sc.updateProjectionMatrix();
    sun.shadow.bias = -0.00012;
    sun.shadow.normalBias = 0.6;
    scene.add(sun);
    scene.add(sun.target);
    this.sun = sun;

    // cool sky bounce opposite the sun — keeps shadow sides legible but distinctly cooler
    const hemi = new THREE.HemisphereLight(0x9fc3e8, 0x8a6f4d, 0.46);
    scene.add(hemi);
    const fill = new THREE.DirectionalLight(0x8fb4dc, 0.38);
    const fillDir = new THREE.Vector3().setFromSphericalCoords(
      1, THREE.MathUtils.degToRad(90 - 32), THREE.MathUtils.degToRad(65));
    fill.position.copy(fillDir).multiplyScalar(120);
    scene.add(fill);

    // ---- warm dust haze matched to the horizon ----
    scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);

    // exposure tuned for ACES with a hot low sun
    game.renderer.toneMappingExposure = 1.05;

    // ---- cheap practical lights (no shadows) ----
    const lvl = game.level || {};

    // blinking comms-mast beacon
    if (lvl.beaconPos) {
      const beacon = new THREE.PointLight(0xff3018, 0, 30, 1.6);
      beacon.position.copy(lvl.beaconPos);
      scene.add(beacon);
      this.beacon = beacon;
    }

    const bulbMat = new THREE.MeshStandardMaterial({
      color: 0x3a2a12, emissive: 0xffc98c, emissiveIntensity: 2.6, roughness: 0.4
    });
    const addBulb = (p, intensity, dist) => {
      if (!p) return null;
      const light = new THREE.PointLight(0xffc27a, intensity, dist, 1.8);
      light.position.copy(p);
      scene.add(light);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), bulbMat);
      bulb.position.copy(p);
      scene.add(bulb);
      return light;
    };
    this.hallBulb = addBulb(lvl.bulbPos, 42, 26);
    this.commsBulb = addBulb(lvl.commsBulbPos, 10, 14);
    // mezzanine + entry practicals so the hall never reads as a dim void
    this.mezzBulb = addBulb(new THREE.Vector3(-24, 2.7, -37.6), 16, 13);
    this.entryBulb = addBulb(new THREE.Vector3(-6, 3.2, -18), 18, 15);
  }

  update(dt, game) {
    const t = game.time;

    // double-flash beacon pattern
    if (this.beacon) {
      const c = t % 2.6;
      const on = (c < 0.13) || (c > 0.30 && c < 0.43);
      const target = on ? 26 : 0;
      this.beacon.intensity += (target - this.beacon.intensity) * Math.min(1, dt * 22);
      const lvl = game.level;
      if (lvl && lvl.beaconMat) {
        lvl.beaconMat.emissiveIntensity = on ? 3.4 : 0.18;
      }
    }

    // faint filament flicker on the practicals
    if (this.hallBulb) {
      this.hallBulb.intensity = 42 + Math.sin(t * 13.7) * 1.2 + Math.sin(t * 7.3) * 0.9;
    }
    if (this.commsBulb) {
      this.commsBulb.intensity = 10 + Math.sin(t * 9.1 + 2) * 0.3;
    }
  }
}
