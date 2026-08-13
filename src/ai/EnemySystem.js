import * as THREE from 'three';
import { Soldier } from './Soldier.js';
import { Behavior, TUNE } from './Behavior.js';
import { raySphereT, rayCapsuleT } from './Trace.js';

// ---------------------------------------------------------------------------
// EnemySystem — squad of 8 procedural infantrymen patrolling the compound.
//
// Contract surface: init(game), update(dt, game), npcs, raycastTargets(...),
// damage(npc, amount, point, opts), debugSpawn(x, z).
//
// Patrol loops hug the real compound features (see src/world/Props.js):
//   player spawns at (0, ~0, 61) outside the south breach, pushes in along the
//   gate road (x ±7.5, z 22..76) toward the courtyard bowl centered ~(0, 2).
//   Main building pad NW (-31..-0.5, -41..-14.5), shed W (-43..-30, 8..21),
//   comms hut E (26..37, -9..1), watchtower SE (38, 34), wrecked truck (10, 30),
//   crate clusters at (-14,-6), (16,4), (6,-8), (18,-13), (24,-2), (30,27)...
// The cover registry self-probes the level raycaster at init, so it adapts
// automatically once real geometry blocks LOS.
// ---------------------------------------------------------------------------

const PATROL_GROUPS = [
  { pts: [[-14, -3], [-19, -11], [-7, -13], [-4, -6]] },  // west crates -> main building front
  { pts: [[13, 6], [21, -2], [23, -11], [10, -8]] },      // east crate clusters -> comms hut
  { pts: [[3, 22], [13, 27], [24, 31], [7, 34]] },        // gate mouth -> truck -> tower pad
];
const GROUP_SIZES = [3, 3, 2]; // 8 soldiers total

export class EnemySystem {
  constructor(game) {
    this.game = game;
    this.npcs = [];
    this.kills = 0;
    this.coverPoints = [];
    this.firingCount = 0;
    this.lastGrantTime = -10;
    this.timeNow = 0;
    this.spawnCounter = 0;
    // shared scratch (no per-frame allocations)
    this.tmpV1 = new THREE.Vector3();
    this.tmpV2 = new THREE.Vector3();
    this.tmpV3 = new THREE.Vector3();
    this.tmpV4 = new THREE.Vector3();
    this._rd = new THREE.Vector3();
    this._capsuleOpts = { radius: 0.32, height: 1.8 };
  }

  init(game) {
    this.scene = game.scene;
    this.shared = Soldier.buildShared(game);
    this.waypointGroups = PATROL_GROUPS.map((g) => g.pts.map((pt) => {
      const y = (game.level && game.level.heightAt && game.level.heightAt(pt[0], pt[1])) || 0;
      return new THREE.Vector3(pt[0], y, pt[1]);
    }));
    this.spawnSquad(game);
    this.buildCoverRegistry(game);

    game.events.on('shot', (d) => {
      if (d && d.origin) this.gunshotAlert(null, d.origin, TUNE.gunshotRadius);
    });
    game.events.on('explosion', (d) => {
      if (d && d.point) this.explosionAlert(d);
    });
    game.events.on('player-respawn', () => this.onPlayerRespawn());
  }

  // ------------------------------------------------------------------ squad

  spawnSquad(game) {
    for (let g = 0; g < PATROL_GROUPS.length; g++) {
      for (let k = 0; k < GROUP_SIZES[g]; k++) {
        const pts = PATROL_GROUPS[g].pts;
        const pt = pts[(k * 2 + g) % pts.length];
        const x = pt[0] + (Math.random() - 0.5) * 3;
        const z = pt[1] + (Math.random() - 0.5) * 3;
        const npc = this.spawnSoldier(game, x, z);
        npc.waypoints = this.waypointGroups[g];
        npc.wpIndex = (k + 1) % npc.waypoints.length;
        npc.yaw = Math.random() * Math.PI * 2;
        npc.dwell = Math.random() * 2;
      }
    }
  }

  spawnSoldier(game, x, z) {
    const y = (game.level && game.level.heightAt && game.level.heightAt(x, z)) || 0;
    const soldier = new Soldier(this.shared);
    const npc = {
      id: this.spawnCounter++,
      soldier,
      mesh: soldier.mesh,
      behavior: null,
      position: new THREE.Vector3(x, y, z),
      velocity: new THREE.Vector3(),
      yaw: Math.random() * Math.PI * 2,
      scale: 0.97 + Math.random() * 0.06,
      health: 100,
      dead: false, deadT: 0, fading: false, fadeT: 0, sink: 0,
      fallYaw: 0, fallAmp: 1.5, gunClatterX: 0, gunClatterZ: 0, gunClatterR: 0,
      state: 'PATROL', stateT: 0,
      waypoints: null, wpIndex: 0, dwell: Math.random() * 1.5,
      suspicion: 0, canSee: false, distTo: 0,
      lastSeenPos: new THREE.Vector3(x, y, z), lastSeenTime: -99,
      alertPos: new THREE.Vector3(), alertPause: 0.5,
      alertPending: false, alertDelay: 0, pendingAlert: new THREE.Vector3(),
      reactT: 0, spreadBoost: 0,
      firing: false, burstLeft: 0, shotTimer: 0, burstPause: Math.random() * 1.2,
      moveTarget: new THREE.Vector3(), hasMoveTarget: false, moveYaw: 0,
      repositionCd: 2 + Math.random() * 3,
      strafeT: 0, strafeDir: 1,
      // personality — the anti-robot knobs
      aggression: 0.35 + Math.random() * 0.6,
      accuracy: 0.35 + Math.random() * 0.55,
      lead: 0.3 + Math.random() * 0.4,
      walkSpeed: 1.45 + Math.random() * 0.5,
      runSpeed: 3.3 + Math.random() * 1.0,
      turnBias: 0.85 + Math.random() * 0.3,
      seed: Math.random() * 10,
      lastWeapon: null,
      anim: { speed: 0, crouch: 0, aim: 0, aimYaw: 0, aimPitch: 0, headYaw: 0, headPitch: 0, flinchPulse: 0 },
      tv1: new THREE.Vector3(), tv2: new THREE.Vector3(), tv3: new THREE.Vector3(),
    };
    npc.behavior = new Behavior(npc, this);
    soldier.mesh.scale.setScalar(npc.scale);
    game.scene.add(soldier.mesh);
    this.npcs.push(npc);
    return npc;
  }

  /** Debug/harness entry: drop one extra soldier at (x, z), already roused. */
  debugSpawn(x, z) {
    const game = this.game;
    if (!this.shared || this.npcs.length > 24) return null;
    const npc = this.spawnSoldier(game, x, z);
    // small local loop so it has something to patrol if left alone
    const y = npc.position.y;
    npc.waypoints = [
      new THREE.Vector3(x + 3, y, z), new THREE.Vector3(x, y, z + 3),
      new THREE.Vector3(x - 3, y, z), new THREE.Vector3(x, y, z - 3),
    ];
    npc.wpIndex = 0;
    npc.yaw = Math.atan2(-(game.player.position.x - x), -(game.player.position.z - z));
    npc.state = 'ALERT';
    npc.stateT = 0;
    npc.alertPos.copy(game.player.position);
    npc.alertPause = 0.3;
    npc.suspicion = 0.9;
    return npc;
  }

  // ----------------------------------------------------------- cover probe

  /**
   * Probe a grid over the compound with horizontal rays at chest height.
   * Any spot with something solid nearby becomes a usable cover point,
   * tagged with the directions that are blocked. Self-adapts to the real
   * level once the world agent's raycaster blocks LOS; on the flat stub it
   * simply yields no points and combat falls back to open-ground maneuvering.
   */
  buildCoverRegistry(game) {
    const lvl = game.level;
    if (!lvl || typeof lvl.raycast !== 'function') return;
    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3();
    for (let x = -28; x <= 28; x += 4) {
      for (let z = -18; z <= 36; z += 4) {
        const gy = (lvl.heightAt && lvl.heightAt(x, z)) || 0;
        origin.set(x, gy + 1.05, z);
        let dirs = 0, count = 0;
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2;
          dir.set(Math.cos(a), 0, Math.sin(a));
          const hit = lvl.raycast(origin, dir, 2.3);
          if (hit) {
            const d = Math.hypot(hit.point.x - origin.x, hit.point.z - origin.z);
            if (d >= 0.3 && d <= 2.3) { dirs |= (1 << k); count++; }
          }
        }
        if (count > 0) this.coverPoints.push({ x, z, dirs });
      }
    }
  }

  /** Pick a cover/move point for an NPC near the threat axis. May return null. */
  pickCover(npc) {
    const pts = this.coverPoints;
    if (!pts.length) return null;
    const px = npc.lastSeenPos.x, pz = npc.lastSeenPos.z;
    const myD = Math.hypot(px - npc.position.x, pz - npc.position.z);
    let best = null, bestScore = -1e9;
    for (let i = 0; i < pts.length; i++) {
      const c = pts[i];
      const dn = Math.hypot(c.x - npc.position.x, c.z - npc.position.z);
      if (dn < 1.5 || dn > 16) continue;
      const dtx = px - c.x, dtz = pz - c.z;
      const dt = Math.hypot(dtx, dtz) || 1;
      let blocked = false;
      for (let k = 0; k < 6; k++) {
        if (!(c.dirs & (1 << k))) continue;
        const a = (k / 6) * Math.PI * 2;
        if ((Math.cos(a) * dtx + Math.sin(a) * dtz) / dt > 0.55) { blocked = true; break; }
      }
      let score = blocked ? 2.2 : 0.25;
      score -= dn * 0.05;
      if (dt < myD) score += 0.5;   // creeping closer is rewarded
      if (dt > 30) score -= 0.6;    // don't wander out of the fight
      score += Math.random() * 0.8; // tie-break jitter
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return bestScore > 0.5 ? best : null;
  }

  // ------------------------------------------------------------ event hooks

  /** Gunfire within radius rouses PATROL/ALERT NPCs (with a human delay). */
  gunshotAlert(sourceNpc, pos, radius) {
    const r2 = radius * radius;
    for (const npc of this.npcs) {
      if (npc === sourceNpc || npc.dead) continue;
      const dx = npc.position.x - pos.x, dz = npc.position.z - pos.z;
      if (dx * dx + dz * dz > r2) continue;
      if (npc.state === 'PATROL') {
        npc.pendingAlert.set(pos.x, pos.y, pos.z);
        npc.alertPending = true;
        npc.alertDelay = Math.random() * 0.22; // no hive-mind snap turns
      } else if (npc.state === 'ALERT') {
        npc.suspicion = Math.min(1.25, npc.suspicion + 0.5);
      }
    }
  }

  explosionAlert(d) {
    const r = (d.radius || 8) + 22;
    const r2 = r * r;
    for (const npc of this.npcs) {
      if (npc.dead) continue;
      const dx = npc.position.x - d.point.x, dz = npc.position.z - d.point.z;
      if (dx * dx + dz * dz > r2) continue;
      npc.anim.flinchPulse = 1;
      if (npc.state === 'PATROL') {
        npc.pendingAlert.set(d.point.x, d.point.y, d.point.z);
        npc.alertPending = true;
        npc.alertDelay = Math.random() * 0.3;
      } else {
        npc.suspicion = Math.min(1.25, npc.suspicion + 0.5);
      }
    }
  }

  onPlayerRespawn() {
    for (const npc of this.npcs) {
      if (npc.dead) continue;
      if (npc.state === 'COMBAT') {
        npc.suspicion = 0.4;
        npc.lastSeenTime = -99;
        npc.firing = false;
        npc.hasMoveTarget = false;
        // search around their own spot, not the death spot, or the squad
        // converges on the player's death point and camps the spawn
        npc.behavior.toAlert(npc.position);
      }
    }
  }

  // ----------------------------------------------------------- contract API

  /**
   * Nearest NPC hit along the ray, tested analytically against per-NPC
   * capsule (body) + sphere (head). Corpses never block shots.
   * Returns { point, npc, part, distance } | null.
   */
  raycastTargets(origin, dir, maxDist) {
    const d = this._rd.copy(dir);
    const len = d.length();
    if (len < 1e-6) return null;
    d.multiplyScalar(1 / len);

    let bestT = (maxDist != null && maxDist > 0) ? maxDist : 1e9;
    let bestNpc = null;
    let bestPart = 'body';

    for (let i = 0; i < this.npcs.length; i++) {
      const npc = this.npcs[i];
      if (npc.dead) continue;
      const s = npc.scale;
      const px = npc.position.x, py = npc.position.y, pz = npc.position.z;
      // head sphere (kept clear of the capsule top so headshots register)
      const ht = raySphereT(origin.x, origin.y, origin.z, d.x, d.y, d.z,
        px, py + 1.66 * s, pz, 0.165 * s);
      if (ht < bestT) { bestT = ht; bestNpc = npc; bestPart = 'head'; }
      // body capsule: feet to shoulders
      const bt = rayCapsuleT(origin.x, origin.y, origin.z, d.x, d.y, d.z,
        px, py + 0.25 * s, pz, px, py + 1.30 * s, pz, 0.28 * s);
      if (bt < bestT) { bestT = bt; bestNpc = npc; bestPart = 'body'; }
    }

    if (!bestNpc) return null;
    return {
      point: new THREE.Vector3().copy(origin).addScaledVector(d, bestT),
      npc: bestNpc,
      part: bestPart,
      distance: bestT,
    };
  }

  /**
   * Weapons call this when a round lands. WE emit npc-hit / npc-killed.
   * opts: { headshot, weapon, dir } — all optional.
   */
  damage(npc, amount, point, opts) {
    if (!npc || npc.dead || amount == null) return;
    const o = opts || {};
    const game = this.game;
    const p = game.player;

    npc.health -= amount;
    npc.lastWeapon = o.weapon || o.name || npc.lastWeapon;
    npc.anim.flinchPulse = 1;
    npc.suspicion = Math.max(npc.suspicion, 1.2); // being shot is convincing

    // blood spray continues the incoming round's direction, roughly
    const dir = this.tmpV2.set(
      point.x - p.position.x,
      point.y - (p.position.y + 1.5),
      point.z - p.position.z
    );
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1);
    dir.normalize();
    if (game.fx && game.fx.blood) game.fx.blood(point, dir);

    game.events.emit('npc-hit', { npc, damage: amount, point, headshot: !!o.headshot });

    if (npc.health <= 0) {
      this.killNpc(npc);
      return;
    }

    if (game.audio && game.audio.play) {
      game.audio.play('npc_hit', { position: npc.position.clone(), volume: 0.75 });
    }
    // react: face the threat, escalate, warn the squad
    if (p && !p.dead) {
      npc.alertPos.set(p.position.x, p.position.y, p.position.z);
      if (npc.state !== 'COMBAT') {
        if (npc.canSee) npc.behavior.toCombat(game);
        else npc.behavior.toAlert(npc.alertPos);
      }
      for (const other of this.npcs) {
        if (other === npc || other.dead) continue;
        const dx = other.position.x - npc.position.x, dz = other.position.z - npc.position.z;
        if (dx * dx + dz * dz < 18 * 18) {
          other.suspicion = Math.min(1.25, other.suspicion + 0.6);
          if (other.state === 'PATROL') {
            other.pendingAlert.copy(npc.alertPos);
            other.alertPending = true;
            other.alertDelay = Math.random() * 0.2;
          }
        }
      }
    }
  }

  killNpc(npc) {
    const game = this.game;
    npc.dead = true;
    npc.deadT = 0;
    npc.health = 0;
    npc.firing = false;
    npc.velocity.set(0, 0, 0);
    npc.fallYaw = Math.random() * Math.PI * 2;
    npc.fallAmp = 1.45 + Math.random() * 0.12;
    npc.gunClatterX = (Math.random() - 0.5) * 0.7;
    npc.gunClatterZ = (Math.random() - 0.5) * 0.7;
    npc.gunClatterR = (Math.random() - 0.5) * 1.2;
    this.kills++;
    if (game.audio && game.audio.play) {
      game.audio.play('npc_death', { position: npc.position.clone(), volume: 0.9 });
    }
    game.events.emit('npc-killed', { npc, weapon: npc.lastWeapon || 'unknown' });
  }

  // ---------------------------------------------------------------- update

  update(dt, game) {
    if (game.paused && !(game.debug && game.debug.allowPausedUpdate)) return;
    this.timeNow = game.time;

    let fc = 0;
    for (let i = 0; i < this.npcs.length; i++) if (this.npcs[i].firing) fc++;
    this.firingCount = fc;

    for (let i = this.npcs.length - 1; i >= 0; i--) {
      const npc = this.npcs[i];
      if (npc.dead) { this.updateCorpse(dt, game, npc, i); continue; }

      npc.behavior.update(dt, game);

      // physics: gravity + capsule collision through the level
      npc.velocity.y -= 22 * dt;
      const grounded = game.level.collideMove(npc.position, npc.velocity, dt, this._capsuleOpts);
      if (grounded && npc.velocity.y < 0) npc.velocity.y = 0;
      npc.anim.speed = Math.hypot(npc.velocity.x, npc.velocity.z);

      if (npc.position.y < -40) { game.scene.remove(npc.mesh); npc.soldier.dispose(); this.npcs.splice(i, 1); continue; }

      npc.soldier.animate(dt, npc);
    }

    this.separate(dt);
  }

  updateCorpse(dt, game, npc, index) {
    npc.deadT += dt;
    npc.soldier.animate(dt, npc);
    if (npc.deadT > TUNE.corpseLife) {
      npc.fading = true;
      npc.fadeT += dt / TUNE.corpseFade;
      npc.sink = npc.fadeT * 0.45;
      npc.soldier.setFade(npc.fadeT);
      if (npc.fadeT >= 1) {
        game.scene.remove(npc.mesh);
        npc.soldier.dispose();
        this.npcs.splice(index, 1);
      }
    }
  }

  /** Cheap pairwise separation so squads don't stack on one spot. */
  separate(dt) {
    const n = this.npcs;
    for (let i = 0; i < n.length; i++) {
      const a = n[i];
      if (a.dead) continue;
      for (let j = i + 1; j < n.length; j++) {
        const b = n[j];
        if (b.dead) continue;
        const dx = b.position.x - a.position.x, dz = b.position.z - a.position.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < 0.81 && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          const push = (0.9 - d) * 1.6 * dt / d;
          a.position.x -= dx * push; a.position.z -= dz * push;
          b.position.x += dx * push; b.position.z += dz * push;
        }
      }
    }
  }
}
