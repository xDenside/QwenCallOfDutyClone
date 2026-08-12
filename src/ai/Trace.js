// Analytic ray intersection helpers for the AI system.
// Used for per-NPC hitboxes (capsule body + sphere head) without touching scene meshes,
// and for the NPCs' own aim traces against the player capsule.
// All functions are allocation-free scalar math.

/**
 * Ray vs sphere. Returns nearest positive t along ray (origin + t*dir), or Infinity.
 * dir must be normalized.
 */
export function raySphereT(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const ex = ox - cx, ey = oy - cy, ez = oz - cz;
  const b = ex * dx + ey * dy + ez * dz;
  const c = ex * ex + ey * ey + ez * ez - r * r;
  const h = b * b - c;
  if (h < 0) return Infinity;
  const t = -b - Math.sqrt(h);
  if (t > 0) return t;
  // origin inside the sphere — return exit point so shots inside still register
  const t2 = -b + Math.sqrt(h);
  return t2 > 0 ? t2 : Infinity;
}

/**
 * Ray vs capsule (segment a→b swept with radius r).
 * Returns nearest positive t or Infinity. dir must be normalized.
 * (Standard iq capsule intersection + end-cap spheres.)
 */
export function rayCapsuleT(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, r) {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const oax = ox - ax, oay = oy - ay, oaz = oz - az;

  const baba = bax * bax + bay * bay + baz * baz;
  const bard = bax * dx + bay * dy + baz * dz;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = dx * oax + dy * oay + dz * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;

  const a = baba - bard * bard;
  const b = baba * rdoa - baoa * bard;
  const c = baba * oaoa - baoa * baoa - r * r * baba;

  let t = Infinity;
  if (Math.abs(a) > 1e-8) {
    const h = b * b - a * c;
    if (h >= 0) {
      const tt = (-b - Math.sqrt(h)) / a;
      const s = (baoa + tt * bard) / baba;
      if (tt > 0 && s >= 0 && s <= 1) t = tt;
    }
  }
  // end caps
  const t1 = raySphereT(ox, oy, oz, dx, dy, dz, ax, ay, az, r);
  if (t1 < t) t = t1;
  const t2 = raySphereT(ox, oy, oz, dx, dy, dz, bx, by, bz, r);
  if (t2 < t) t = t2;
  return t;
}

/** Wrap an angle to [-PI, PI]. */
export function normAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Yaw (game convention: forward = (-sin yaw, -cos yaw)) that faces from (x,z) toward (tx,tz). */
export function yawToward(x, z, tx, tz) {
  return Math.atan2(-(tx - x), -(tz - z));
}
