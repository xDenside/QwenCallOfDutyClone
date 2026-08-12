// Weapon tuning data for the two playable weapons.
// All angles in radians, distances in meters, times in seconds.

export const WEAPON_ORDER = ['M4A1', 'P1911'];

export const WEAPON_DEFS = {
  M4A1: {
    name: 'M4A1',
    kind: 'rifle',
    auto: true,
    rpm: 700,                          // full-auto fire interval = 60/700 ≈ 0.0857s
    damage: 34,                        // body; head = damage * headMult
    headMult: 2,
    magSize: 30,
    reserveStart: 120,
    reserveMax: 120,
    reloadTime: 2.05,
    range: 400,
    audioShot: 'shot_m4',
    adsFov: 55,
    eyeDist: 0.10,                     // eye -> rear sight distance when ADS (cheek weld)
    // Spread: half-angle of the shot cone.
    // hip = standing still, move scales with hSpeed/7.4, sprint is an extra add,
    // ads is the aimed value (adsMoveScale shrinks the movement penalty while aimed).
    spread: { hip: 0.024, move: 0.034, sprint: 0.052, ads: 0.0024, adsMoveScale: 0.25 },
    // Camera punch per shot, applied through game.player.addRecoil(pitch, yaw).
    // Positive pitch = climb up; negative yaw = drift right.
    recoil: { pitch: 0.0205, pitchJitter: 0.0042, yaw: -0.0031, yawJitter: 0.0026, sustainedRamp: 0.30 },
    // Viewmodel kick (local-space shove on the gun rig).
    vmKick: { z: 0.052, pitch: 0.062, roll: 0.007 },
    bobAmp: 1.0,
    raiseTime: 0.36,                   // sprint -> fire raise delay
  },

  P1911: {
    name: 'P1911',
    kind: 'pistol',
    auto: false,                       // semi-auto: edge-triggered
    rpm: 480,                          // fastest possible trigger cadence cap
    damage: 45,
    headMult: 2,
    magSize: 7,
    reserveStart: 49,
    reserveMax: 49,
    reloadTime: 1.45,
    range: 120,
    audioShot: 'shot_p1911',
    adsFov: 62,
    eyeDist: 0.115,
    spread: { hip: 0.019, move: 0.030, sprint: 0.050, ads: 0.0045, adsMoveScale: 0.30 },
    recoil: { pitch: 0.031, pitchJitter: 0.0068, yaw: 0.0, yawJitter: 0.0038, sustainedRamp: 0 },
    vmKick: { z: 0.042, pitch: 0.088, roll: 0.011 },
    bobAmp: 1.18,
    raiseTime: 0.30,
  },
};
