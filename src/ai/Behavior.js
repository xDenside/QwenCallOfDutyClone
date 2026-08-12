import * as THREE from 'three';
import { rayCapsuleT, normAngle, yawToward } from './Trace.js';

const clamp = THREE.MathUtils.clamp;
const damp = THREE.MathUtils.damp;

// ---------------------------------------------------------------------------
// Tuning. Everything a critic might want to poke lives here.
// ---------------------------------------------------------------------------
export const TUNE = {
  sightRange: 58,           // m, max distance an NPC can spot the player
  fovHalfPatrol: 0.96,      // rad (~55 deg half-angle while patrolling)
  fovHalfAlert: 1.40,       // rad (~80 deg once roused)
  suspicionAlert: 0.45,     // meter value that triggers PATROL -> ALERT
  suspicionCombat: 1.0,     // meter value that triggers -> COMBAT
  gunshotRadius: 45,        // m, gunfire instantly alerts everyone inside
  maxShooters: 3,           // max NPCs firing simultaneously
  shotInterval: 0.1,        // s between burst rounds (600 rpm)
  burstPauseMin: 0.5,       // s
  burstPauseVar: 0.7,       // s of extra random pause
  damageClose: 16,          // hp per hit at point-blank
  damageFar: 10,            // hp per hit at damageRange
  damageRange: 40,          // m, falloff distance
  corpseLife: 12,           // s a corpse persists before fading
  corpseFade: 2,            // s the fade takes
  loseSightTime: 5,         // s without LOS before combat de-escalates
  engagementMin: 7,         // m, back off inside this
  engagementMax: 34,        // m, close distance outside this
  playerCapsuleR: 0.44,     // aim hit-check vs the player
};

// States
const PATROL = 'PATROL', ALERT = 'ALERT', COMBAT = 'COMBAT';

export class Behavior {
  constructor(npc, sys) {
    this.npc = npc;
    this.sys = sys;
  }

  update(dt, game) {
    const npc = this.npc;
    if (npc.dead) return;
    npc.stateT += dt;

    // staggered gunfire reactions (set by EnemySystem.gunshotAlert)
    if (npc.alertPending) {
      npc.alertDelay -= dt;
      if (npc.alertDelay <= 0) {
        npc.alertPending = false;
        if (npc.state === PATROL) this.toAlert(npc.pendingAlert);
      }
    }

    this.sense(dt, game);
    switch (npc.state) {
      case PATROL: this.patrol(dt, game); break;
      case ALERT: this.alert(dt, game); break;
      case COMBAT: this.combat(dt, game); break;
    }
  }

  // ---------------- senses ------------------------------------------------

  sense(dt, game) {
    const npc = this.npc, p = game.player;
    const dx = p.position.x - npc.position.x;
    const dz = p.position.z - npc.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    npc.distTo = dist;
    npc.canSee = false;

    if (!p.dead && dist < TUNE.sightRange) {
      const half = npc.state === PATROL ? TUNE.fovHalfPatrol : TUNE.fovHalfAlert;
      const d2 = Math.max(0.001, dist);
      const dot = (-Math.sin(npc.yaw) * dx - Math.cos(npc.yaw) * dz) / d2;
      if (dot > Math.cos(half) || dist < 5) {   // hearing/awareness up close
        if (this.los(game)) npc.canSee = true;
      }
    }

    if (npc.canSee) {
      const rate = (2.05 - dist * 0.02)
        * (p.hSpeed > 4.2 ? 1.45 : 1)
        * (p.ads > 0.5 ? 0.85 : 1)
        * (0.85 + npc.aggression * 0.3);
      npc.suspicion += rate * dt;
      npc.lastSeenPos.copy(p.position);
      npc.lastSeenTime = game.time;
    } else if (npc.state === PATROL) {
      npc.suspicion = Math.max(0, npc.suspicion - 0.25 * dt);
    }
    // a sprinting player is audible nearby
    if (!p.dead && p.hSpeed > 5.5 && dist < 13) npc.suspicion += 0.5 * dt;
  }

  /** Line of sight via the world raycaster. Allocation-free. */
  los(game) {
    const npc = this.npc, p = game.player;
    const eye = npc.tv1.set(npc.position.x, npc.position.y + 1.56, npc.position.z);
    const tgt = npc.tv2.set(p.position.x, p.position.y + 1.32, p.position.z);
    const dir = npc.tv3.copy(tgt).sub(eye);
    const d = dir.length();
    if (d < 0.001) return true;
    dir.multiplyScalar(1 / d);
    const hit = game.level.raycast(eye, dir, d - 0.4);
    if (!hit) return true;
    const hx = hit.point.x - eye.x, hy = hit.point.y - eye.y, hz = hit.point.z - eye.z;
    return (hx * hx + hy * hy + hz * hz) > (d - 0.35) * (d - 0.35);
  }

  // ---------------- locomotion helpers ------------------------------------

  stand(dt) {
    const npc = this.npc;
    npc.velocity.x = damp(npc.velocity.x, 0, 8, dt);
    npc.velocity.z = damp(npc.velocity.z, 0, 8, dt);
  }

  moveToward(dt, tx, tz, speed) {
    const npc = this.npc;
    const dx = tx - npc.position.x, dz = tz - npc.position.z;
    const d = Math.hypot(dx, dz) || 1;
    npc.velocity.x = damp(npc.velocity.x, (dx / d) * speed, 7, dt);
    npc.velocity.z = damp(npc.velocity.z, (dz / d) * speed, 7, dt);
  }

  faceToward(dt, targetYaw, rate) {
    const npc = this.npc;
    const diff = normAngle(targetYaw - npc.yaw);
    const maxStep = rate * npc.turnBias * dt;
    npc.yaw += Math.abs(diff) < maxStep ? diff : Math.sign(diff) * maxStep;
  }

  // ---------------- state transitions -------------------------------------

  toAlert(pos) {
    const npc = this.npc;
    npc.state = ALERT; npc.stateT = 0;
    npc.alertPos.copy(pos);
    npc.alertPause = 0.4 + Math.random() * 0.4;
  }

  toCombat(game) {
    const npc = this.npc;
    npc.state = COMBAT; npc.stateT = 0;
    npc.reactT = 0.28 + Math.random() * 0.35;  // human reaction delay
    npc.spreadBoost = 2.6;                      // first shots go wide
    npc.burstPause = 0.15 + Math.random() * 0.3;
    npc.anim.crouch = 0.22;
    game.audio.play('npc_alert', { position: npc.position.clone(), volume: 0.8 });
    // shout: rouse nearby squadmates
    for (const o of this.sys.npcs) {
      if (o === npc || o.dead) continue;
      const dx = o.position.x - npc.position.x, dz = o.position.z - npc.position.z;
      if (dx * dx + dz * dz < 26 * 26) {
        o.suspicion = Math.min(1.25, o.suspicion + 0.45);
        if (o.state === PATROL) o.alertPos.copy(game.player.position);
      }
    }
  }

  toPatrol() {
    const npc = this.npc;
    npc.state = PATROL; npc.stateT = 0;
    npc.suspicion *= 0.35;
    npc.anim.crouch = 0;
    npc.anim.aim = 0;
    npc.dwell = 0.4 + Math.random();
  }

  // ---------------- PATROL -------------------------------------------------

  patrol(dt, game) {
    const npc = this.npc;
    if (npc.suspicion >= TUNE.suspicionAlert && !game.player.dead) {
      this.toAlert(game.player.position);
      return;
    }
    const a = npc.anim;
    a.crouch = 0; a.aim = 0;

    if (!npc.waypoints || npc.waypoints.length === 0) { this.stand(dt); return; }
    const wp = npc.waypoints[npc.wpIndex];

    if (npc.dwell > 0) {
      npc.dwell -= dt;
      // stand and scan
      this.stand(dt);
      a.headYaw = Math.sin(this.sys.timeNow * 0.5 + npc.seed * 3) * 0.6;
      a.headPitch = Math.sin(this.sys.timeNow * 0.23 + npc.seed) * 0.06;
      return;
    }

    const dx = wp.x - npc.position.x, dz = wp.z - npc.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.8) {
      npc.wpIndex = (npc.wpIndex + 1) % npc.waypoints.length;
      if (Math.random() < 0.6) npc.dwell = 0.5 + Math.random() * 2.2;
      this.stand(dt);
      return;
    }
    this.moveToward(dt, wp.x, wp.z, npc.walkSpeed);
    this.faceToward(dt, yawToward(npc.position.x, npc.position.z, wp.x, wp.z), 2.6);
    a.headYaw = Math.sin(this.sys.timeNow * 0.4 + npc.seed * 3) * 0.45;
    a.headPitch = 0;
  }

  // ---------------- ALERT ---------------------------------------------------

  alert(dt, game) {
    const npc = this.npc;
    const ayaw = yawToward(npc.position.x, npc.position.z, npc.alertPos.x, npc.alertPos.z);
    // sweep a little while searching — nobody snaps perfectly onto a bearing
    this.faceToward(dt, ayaw + Math.sin(this.sys.timeNow * 0.7 + npc.seed) * 0.12, 5.5);

    const a = npc.anim;
    a.crouch = 0.55;             // crouch-ish wary pause
    a.aim = 0.55;                // rifle half-raised
    a.headYaw = clamp(normAngle(ayaw - npc.yaw), -0.8, 0.8)
      + Math.sin(this.sys.timeNow * 1.1 + npc.seed) * 0.08;
    a.headPitch = 0.02;
    this.stand(dt);

    if (npc.canSee && npc.suspicion >= TUNE.suspicionCombat) {
      this.toCombat(game);
      return;
    }
    if (!npc.canSee && npc.stateT > npc.alertPause + 1.8) this.toPatrol();
  }

  // ---------------- COMBAT ----------------------------------------------------

  combat(dt, game) {
    const npc = this.npc, p = game.player;
    npc.reactT -= dt;
    npc.spreadBoost = Math.max(0, npc.spreadBoost - 3.2 * dt);
    npc.burstPause -= dt;
    npc.repositionCd -= dt;

    const seen = npc.canSee && !p.dead;
    const a = npc.anim;
    a.crouch = npc.hasMoveTarget ? 0.08 : 0.22;

    // aim at the player, or at last known position
    const tx = seen ? p.position.x : npc.lastSeenPos.x;
    const tz = seen ? p.position.z : npc.lastSeenPos.z;
    const ty = (seen ? p.position.y : npc.lastSeenPos.y) + 1.45;
    const dx = tx - npc.position.x, dz = tz - npc.position.z;
    const horiz = Math.max(0.001, Math.hypot(dx, dz));
    const ayaw = Math.atan2(-dx, -dz);
    const apitch = Math.atan2(ty - (npc.position.y + 1.5), horiz);
    a.aim = 1;
    a.aimYaw = normAngle(ayaw - npc.yaw);
    a.aimPitch = apitch;
    a.headYaw = clamp(a.aimYaw, -0.8, 0.8);
    a.headPitch = clamp(apitch, -0.45, 0.5);

    // facing: follow movement while maneuvering, otherwise track the target
    if (npc.hasMoveTarget) this.faceToward(dt, npc.moveYaw, 6.5);
    else this.faceToward(dt, ayaw, 7.5);

    // lost them for good -> search the last known spot
    if (!seen && game.time - npc.lastSeenTime > TUNE.loseSightTime) {
      this.toAlert(npc.lastSeenPos);
      return;
    }

    // ---- movement decisions
    if (npc.hasMoveTarget) {
      const mdx = npc.moveTarget.x - npc.position.x, mdz = npc.moveTarget.z - npc.position.z;
      if (mdx * mdx + mdz * mdz < 1.2) npc.hasMoveTarget = false;
      else {
        this.moveToward(dt, npc.moveTarget.x, npc.moveTarget.z, npc.runSpeed);
        npc.moveYaw = Math.atan2(-mdx, -mdz);
      }
    } else if (!seen) {
      const adx = npc.lastSeenPos.x - npc.position.x, adz = npc.lastSeenPos.z - npc.position.z;
      const ad = Math.hypot(adx, adz);
      if (ad > 6) {
        const k = Math.min(1, (ad - 5) / ad);
        this.moveToward(dt, npc.position.x + adx * k, npc.position.z + adz * k, npc.runSpeed * 0.9);
      } else this.stand(dt);
    } else if (npc.distTo > TUNE.engagementMax) {
      this.moveToward(dt, p.position.x, p.position.z, npc.runSpeed * 0.85);
    } else if (npc.distTo < TUNE.engagementMin) {
      // back off, keep a fighting distance
      this.moveToward(dt,
        npc.position.x - (p.position.x - npc.position.x),
        npc.position.z - (p.position.z - npc.position.z), 2.0);
    } else {
      // strafing jitter while holding position — never a statue
      if (npc.strafeT > 0) {
        npc.strafeT -= dt;
        const rx = Math.cos(npc.yaw) * npc.strafeDir;
        const rz = -Math.sin(npc.yaw) * npc.strafeDir;
        this.moveToward(dt, npc.position.x + rx * 2.5, npc.position.z + rz * 2.5, 2.2);
      } else {
        this.stand(dt);
        if (Math.random() < 0.01) {
          npc.strafeDir = Math.random() < 0.5 ? -1 : 1;
          npc.strafeT = 0.5 + Math.random() * 0.9;
        }
      }
    }

    // ---- fire control
    if (seen && npc.reactT <= 0) this.engage(dt, game);
  }

  /** Burst fire with slot arbitration (max TUNE.maxShooters at once). */
  engage(dt, game) {
    const npc = this.npc;
    // hard rule: enemy fire must never spawn while paused (unless debug capture)
    if (game.paused && !(game.debug && game.debug.allowPausedUpdate)) return;

    if (npc.firing) {
      npc.shotTimer -= dt;
      let guard = 0;
      while (npc.shotTimer <= 0 && npc.burstLeft > 0 && guard++ < 3) {
        this.fireShot(game);
        npc.shotTimer += TUNE.shotInterval;
        npc.burstLeft--;
      }
      if (npc.burstLeft <= 0) {
        npc.firing = false;
        npc.burstPause = TUNE.burstPauseMin + Math.random() * TUNE.burstPauseVar
          + (1 - npc.aggression) * 0.25;
        // sometimes reposition between bursts
        if (npc.repositionCd <= 0 && Math.random() < 0.2 + npc.aggression * 0.2) {
          const c = this.sys.pickCover(npc);
          if (c) {
            npc.moveTarget.set(c.x, 0, c.z);
            npc.hasMoveTarget = true;
            npc.repositionCd = 4 + Math.random() * 4;
          }
        }
      }
      return;
    }

    if (npc.burstPause > 0 || npc.hasMoveTarget) return;
    if (this.sys.firingCount >= TUNE.maxShooters) return;
    if (game.time - this.sys.lastGrantTime < 0.13) return; // no lockstep openings

    npc.firing = true;
    this.sys.lastGrantTime = game.time;
    npc.burstLeft = 3 + Math.floor(Math.random() * (2 + npc.aggression * 3)); // 3..6
    npc.shotTimer = 0;
  }

  /** One round: tracer from muzzle toward the player camera ± error. */
  fireShot(game) {
    const npc = this.npc, p = game.player, sys = this.sys;
    const muzzle = sys.tmpV1;
    npc.soldier.getMuzzleWorld(muzzle);
    npc.soldier.gunKick = Math.min(0.09, npc.soldier.gunKick + 0.035);

    const cam = game.camera.position;
    const dist = muzzle.distanceTo(cam);

    // aim at the eye, with a little lead on the player's velocity
    const aim = sys.tmpV2.set(cam.x, cam.y, cam.z);
    const tof = (dist / 780) * npc.lead;
    aim.x += p.velocity.x * tof;
    aim.y += p.velocity.y * tof * 0.5;
    aim.z += p.velocity.z * tof;

    const dir = sys.tmpV3.copy(aim).sub(muzzle).normalize();

    // miss bias: distance, player speed, fresh-acquire spread, own accuracy
    const moving = p.hSpeed > 1.2 ? p.hSpeed : 0;
    let err = (0.8 + dist * 0.021 + moving * 0.42 + npc.spreadBoost)
      * (1.25 - npc.accuracy * 0.5);
    if (npc.hasMoveTarget) err += 1.6; // firing on the move is sloppy
    const er = err * 0.01745;
    dir.x += (Math.random() - 0.5) * 2.4 * er;
    dir.y += (Math.random() - 0.5) * 2.0 * er;
    dir.z += (Math.random() - 0.5) * 2.4 * er;
    dir.normalize();

    // does the round actually connect with the player capsule?
    const t = rayCapsuleT(
      muzzle.x, muzzle.y, muzzle.z, dir.x, dir.y, dir.z,
      p.position.x, p.position.y + 0.15, p.position.z,
      p.position.x, p.position.y + 1.68, p.position.z,
      TUNE.playerCapsuleR
    );

    const end = sys.tmpV4;
    if (t < dist + 2) {
      const falloff = Math.min(dist, TUNE.damageRange) / TUNE.damageRange;
      const dmg = Math.round((TUNE.damageClose - falloff * (TUNE.damageClose - TUNE.damageFar))
        * (0.9 + Math.random() * 0.2));
      game.events.emit('player-damaged', { amount: dmg, origin: npc.position });
      end.set(cam.x, cam.y, cam.z);
    } else {
      const hit = game.level.raycast(muzzle, dir, 160);
      if (hit) {
        end.copy(hit.point);
        game.fx.impact(hit.point, hit.normal, hit.material, {});
      } else {
        end.copy(muzzle).addScaledVector(dir, 140);
      }
    }

    game.fx.tracer(muzzle, end, {});
    game.fx.muzzleFlash(muzzle, dir, 'enemy_rifle');
    game.audio.play('shot_enemy', { position: npc.position.clone(), volume: 0.9 });
    sys.gunshotAlert(npc, muzzle, TUNE.gunshotRadius);
  }
}
