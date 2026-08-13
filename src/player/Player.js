import * as THREE from 'three';

export class Player {
  constructor(game) {
    this.game = game;
    this.spawn = new THREE.Vector3(0, 0, 42);
    this.spawnYaw = Math.PI;
    this.position = this.spawn.clone();
    this.velocity = new THREE.Vector3();
    this.yaw = this.spawnYaw;
    this.pitch = 0;
    this.onGround = true;
    this.health = 100;
    this.maxHealth = 100;
    this.radius = 0.35;
    this.height = 1.8;
    this.eyeHeight = 1.62;
    this.bobTime = 0;
    this.bobAmp = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.ads = 0;
    // hip-fire base sensitivity; tune live via game.player.sensBase in console
    this.sensBase = 0.004;
    this.dead = false;
    this.timeSinceDamage = 99;
    this.respawnTimer = 0;
    this.lastDamageFrom = null;
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._wish = new THREE.Vector3();
  }

  init(game) {
    game.events.on('player-damaged', (d) => this.damage(d.amount, d.origin));
    if (game.level && game.level.spawnPoint) {
      this.spawn.copy(game.level.spawnPoint);
      this.position.copy(this.spawn);
      if (game.level.spawnYaw != null) { this.spawnYaw = game.level.spawnYaw; this.yaw = this.spawnYaw; }
    }
  }

  addRecoil(pitch, yaw) {
    this.recoilPitch += pitch;
    this.recoilYaw += yaw;
  }

  damage(amount, origin) {
    if (this.dead) return;
    this.health -= amount;
    this.timeSinceDamage = 0;
    if (origin) this.lastDamageFrom = origin.clone();
    if (this.health <= 0) {
      this.health = 0;
      this.die();
    }
    this.game.events.emit('health-changed', { health: this.health });
  }

  die() {
    this.dead = true;
    this.respawnTimer = 3.5;
    this.game.events.emit('player-dead', {});
  }

  respawn() {
    this.dead = false;
    this.health = this.maxHealth;
    this.position.copy(this.spawn);
    this.velocity.set(0, 0, 0);
    this.yaw = this.spawnYaw;
    this.pitch = 0;
    this.game.events.emit('player-respawn', {});
    this.game.events.emit('health-changed', { health: this.health });
  }

  get forward() { return this._fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }
  get right() { return this._right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)); }

  update(dt, game) {
    const input = game.input;

    if (this.dead) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.respawn();
      game.camera.position.lerp(
        new THREE.Vector3(this.position.x, this.position.y + 0.5, this.position.z), 1 - Math.exp(-4 * dt));
      return;
    }

    const { dx, dy } = input.consumeDeltas();
    const wantAds = input.button(2);
    this.ads = THREE.MathUtils.damp(this.ads, wantAds ? 1 : 0, 12, dt);
    const baseFov = 75;
    const adsFov = (game.weapons && game.weapons.current && game.weapons.current.adsFov) || 55;
    game.camera.fov = THREE.MathUtils.damp(game.camera.fov, THREE.MathUtils.lerp(baseFov, adsFov, this.ads), 14, dt);
    game.camera.updateProjectionMatrix();

    // ADS keeps the 0.0021 feel; hip-fire uses sensBase (wide FOV reads
    // slower, so it needs a boosted angular rate to feel equal)
    const t = THREE.MathUtils.clamp((game.camera.fov - adsFov) / (baseFov - adsFov), 0, 1);
    const sens = THREE.MathUtils.lerp(0.0021, this.sensBase, t);
    if (!game.debug.freeCam) {
      this.yaw -= dx * sens;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * sens, -1.45, 1.45);
    }

    const sprint = input.down('ShiftLeft') || input.down('ShiftRight');
    const f = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0);
    const s = (input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0);
    const fwd = this.forward;
    const right = this.right;
    const wish = this._wish.set(0, 0, 0).addScaledVector(fwd, f).addScaledVector(right, s);
    if (wish.lengthSq() > 0) wish.normalize();
    const isSprinting = sprint && f > 0 && s === 0 && !wantAds && this.ads < 0.3;
    const maxSpeed = (isSprinting ? 7.4 : 4.5) * (1 - 0.45 * this.ads);
    this.isSprinting = isSprinting;
    this.isMoving = wish.lengthSq() > 0;

    const accel = this.onGround ? 48 : 9;
    const proj = this.velocity.x * wish.x + this.velocity.z * wish.z;
    const add = Math.max(0, maxSpeed - proj);
    const acc = Math.min(accel * dt * (this.onGround ? maxSpeed : maxSpeed * 0.35), add);
    this.velocity.x += wish.x * acc;
    this.velocity.z += wish.z * acc;

    if (this.onGround) {
      const fr = Math.exp(-(wish.lengthSq() > 0 ? 3.5 : 11) * dt);
      this.velocity.x *= fr;
      this.velocity.z *= fr;
      if (input.down('Space')) { this.velocity.y = 7.2; this.onGround = false; }
    }
    this.velocity.y -= 23 * dt;

    this.onGround = !!game.level.collideMove(this.position, this.velocity, dt, {
      radius: this.radius, height: this.height
    });
    if (this.position.y < -50) this.respawn();

    const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.hSpeed = hSpeed;
    this.bobAmp = THREE.MathUtils.damp(this.bobAmp, this.onGround ? Math.min(hSpeed / 4.5, 1.5) : 0, 8, dt);
    this.bobTime += dt * (5.5 + 5.5 * this.bobAmp);

    this.recoilPitch = THREE.MathUtils.damp(this.recoilPitch, 0, 9, dt);
    this.recoilYaw = THREE.MathUtils.damp(this.recoilYaw, 0, 9, dt);

    this.timeSinceDamage += dt;
    if (this.timeSinceDamage > 4 && this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + 14 * dt);
      game.events.emit('health-changed', { health: this.health });
    }

    if (!game.debug.freeCam) {
      const bobY = Math.sin(this.bobTime * 2) * 0.017 * this.bobAmp;
      const bobX = Math.cos(this.bobTime) * 0.011 * this.bobAmp;
      const cam = game.camera;
      cam.position.set(
        this.position.x + right.x * bobX,
        this.position.y + this.eyeHeight + bobY,
        this.position.z + right.z * bobX
      );
      cam.rotation.set(
        this.pitch + this.recoilPitch,
        this.yaw + this.recoilYaw,
        Math.sin(this.bobTime) * 0.0035 * this.bobAmp,
        'YXZ'
      );
    }
  }
}
