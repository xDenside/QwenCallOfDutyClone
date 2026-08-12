import * as THREE from 'three';

// STUB — replaced by the World & Lighting agent. Contract in /CONTRACT.md.
export class Level {
  constructor(game) {
    this.game = game;
    this.group = new THREE.Group();
    this.spawnPoint = null;
    this.spawnYaw = null;
  }

  init(game) {
    game.scene.add(this.group);
    const geo = new THREE.PlaneGeometry(500, 500);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x8a7f66, roughness: 1, metalness: 0 });
    this.ground = new THREE.Mesh(geo, mat);
    this.ground.receiveShadow = true;
    this.group.add(this.ground);
  }

  collideMove(pos, vel, dt, opts) {
    pos.x += vel.x * dt;
    pos.y += vel.y * dt;
    pos.z += vel.z * dt;
    let grounded = false;
    if (pos.y <= 0) { pos.y = 0; if (vel.y < 0) vel.y = 0; grounded = true; }
    return grounded;
  }

  heightAt(x, z) { return 0; }

  raycast(origin, dir, maxDist) {
    if (dir.y >= -1e-6) return null;
    const t = -origin.y / dir.y;
    if (t < 0 || t > maxDist) return null;
    return {
      point: origin.clone().addScaledVector(dir, t),
      normal: new THREE.Vector3(0, 1, 0),
      material: 'dirt'
    };
  }

  update(dt, game) {}
}
