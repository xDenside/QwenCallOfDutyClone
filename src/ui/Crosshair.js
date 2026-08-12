// MW2019-style dynamic crosshair (4 lines + dot) and the hitmarker X.
// Per-frame work is transform/opacity writes on cached nodes only.

import { el } from './dom.js';

const LINE = 9; // length of a crosshair line in px

export class Crosshair {
  constructor(root) {
    this.box = el('div', 'xh', root);
    this.lnT = el('i', 't', this.box);
    this.lnB = el('i', 'b', this.box);
    this.lnL = el('i', 'l', this.box);
    this.lnR = el('i', 'r', this.box);
    this.dot = el('i', 'xh-dot', this.box);

    // hitmarker — 4 diagonal ticks forming an X, animated via WAAPI (no reflow)
    this.hm = el('div', 'hm', root);
    for (let i = 0; i < 4; i++) el('i', '', this.hm);
    this.hmAnim = null;

    this.gap = 7;
    this.bloom = 0;      // firing bloom, decays exponentially
    this.lowerT = 0;     // weapon-lower delay after sprint ends
    this.alpha = 1;
  }

  /** 'shot' → crosshair bloom (gap kick). */
  onShot() {
    this.bloom = Math.min(this.bloom + 6.5, 17);
  }

  /** 'npc-hit' / 'npc-killed' → hitmarker pop. Kill confirm is larger, headshot red. */
  hit(headshot, kill) {
    this.hm.classList.toggle('hm-red', !!(headshot || kill));
    const s0 = kill ? 1.72 : 1.32;
    const s1 = kill ? 1.12 : 0.92;
    if (this.hmAnim) this.hmAnim.cancel();
    this.hmAnim = this.hm.animate(
      [
        { opacity: 1, transform: `scale(${s0})` },
        { opacity: 0, transform: `scale(${s1})` }
      ],
      { duration: kill ? 170 : 120, easing: 'cubic-bezier(.18,.7,.3,1)', fill: 'forwards' }
    );
  }

  update(dt, game) {
    const p = game.player;
    if (!p) return;

    // gap model: base + movement + firing bloom, smoothed
    this.bloom *= Math.exp(-8.5 * dt);
    if (p.isSprinting) this.lowerT = 0.16;
    else this.lowerT = Math.max(0, this.lowerT - dt);

    const speed = p.hSpeed || 0;
    const target =
      6.5 +
      Math.min(speed / 7.4, 1.25) * 7 +
      (p.isMoving ? 1.5 : 0) +
      this.bloom;
    this.gap += (target - this.gap) * Math.min(1, dt * 14);

    // visibility: hidden dead / sprinting / lowering, fades out through ADS
    let a = 1;
    if (p.dead || p.isSprinting || this.lowerT > 0) a = 0;
    a *= 1 - Math.min(1, Math.max(0, ((p.ads || 0) - 0.12) / 0.45));
    const rate = a < this.alpha ? 20 : 8; // fade out fast, raise back slower
    this.alpha += (a - this.alpha) * Math.min(1, dt * rate);

    const g = this.gap;
    this.lnT.style.transform = `translate3d(-1px, ${(-(g + LINE)).toFixed(2)}px, 0)`;
    this.lnB.style.transform = `translate3d(-1px, ${g.toFixed(2)}px, 0)`;
    this.lnL.style.transform = `translate3d(${(-(g + LINE)).toFixed(2)}px, -1px, 0)`;
    this.lnR.style.transform = `translate3d(${g.toFixed(2)}px, -1px, 0)`;
    this.box.style.opacity = this.alpha.toFixed(3);

    // center dot only when settled and not ADS
    const dotA = this.alpha * Math.max(0, 1 - this.bloom / 9) * ((p.ads || 0) < 0.5 ? 1 : 0);
    this.dot.style.opacity = dotA.toFixed(3);
  }
}
