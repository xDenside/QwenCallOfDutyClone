import * as THREE from 'three';

// STUB — replaced by the World & Lighting agent. Contract in /CONTRACT.md.
export class Lighting {
  constructor(game) { this.game = game; }

  init(game) {
    const hemi = new THREE.HemisphereLight(0xcfe0ee, 0x6b5d45, 0.55);
    game.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xffdfae, 2.4);
    sun.position.set(60, 42, -38);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -90; sc.right = 90; sc.top = 90; sc.bottom = -90;
    sc.near = 1; sc.far = 300;
    sun.shadow.bias = -0.0004;
    game.scene.add(sun);
    game.scene.add(sun.target);
    this.sun = sun;

    game.scene.fog = new THREE.FogExp2(0xd9c9a5, 0.0038);
    game.scene.background = new THREE.Color(0xcfe0ee);
  }

  update(dt, game) {}
}
