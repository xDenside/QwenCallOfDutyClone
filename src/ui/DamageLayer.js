// MW-style health feedback — no bar:
//  - red screen-edge vignette that intensifies as health drops
//  - 400 ms red flash on 'player-damaged'
//  - subtle white regen "breathe" once health starts recovering
//  - directional damage arc pointing toward lastDamageFrom relative to player yaw

import { el, svgEl } from './dom.js';

const DIR_WINDOW = 2.4; // seconds the directional arc stays visible

export class DamageLayer {
  constructor(root) {
    this.vignette = el('div', 'layer vignette', root);
    this.hurt = el('div', 'layer hurt', root);
    this.flash = el('div', 'layer flash', root);
    this.regen = el('div', 'layer regen', root);

    this.dir = el('div', 'dmgdir', root);
    const rot = el('div', 'dmgdir-rot', this.dir);
    this.rot = rot;
    const chev = el('div', 'dmgdir-chev', rot);
    const svg = svgEl('svg', { width: 72, height: 34, viewBox: '0 0 72 34' }, chev);
    svgEl('path', {
      d: 'M6 31 A 38 38 0 0 1 66 31',
      fill: 'none',
      'stroke-width': 5,
      'stroke-linecap': 'round'
    }, svg);

    this.lastHealth = -1;
    this.regenOn = false;
    this.dirOn = false;
    this.flashAnim = null;
  }

  /** 'player-damaged' → quick red edge flash. */
  onDamaged() {
    if (this.flashAnim) this.flashAnim.cancel();
    this.flashAnim = this.flash.animate(
      [{ opacity: 0.95 }, { opacity: 0 }],
      { duration: 400, easing: 'cubic-bezier(.2,.6,.35,1)', fill: 'forwards' }
    );
  }

  invalidate() { this.lastHealth = -1; }

  update(dt, game) {
    const p = game.player;
    if (!p) return;
    const max = p.maxHealth || 100;
    const h = p.health;

    // low-health vignette (ramps below 75% of max)
    if (h !== this.lastHealth) {
      this.lastHealth = h;
      const t = Math.min(1, Math.max(0, (max * 0.75 - h) / (max * 0.75)));
      this.hurt.style.opacity = (Math.pow(t, 1.35) * 0.92).toFixed(3);
    }

    // regen cue: player heals after 4 s without damage
    const regening = !p.dead && h < max && p.timeSinceDamage > 4;
    if (regening !== this.regenOn) {
      this.regenOn = regening;
      this.regen.classList.toggle('on', regening);
    }

    // directional arc toward the last damage source
    const from = p.lastDamageFrom;
    if (!p.dead && from && p.timeSinceDamage < DIR_WINDOW) {
      const dx = from.x - p.position.x;
      const dz = from.z - p.position.z;
      if (dx * dx + dz * dz > 0.01) {
        // signed angle from player forward to source; + = to the right
        const yaw = p.yaw;
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
        const rx = Math.cos(yaw), rz = -Math.sin(yaw);
        const f = dx * fx + dz * fz;
        const r = dx * rx + dz * rz;
        const deg = (Math.atan2(r, f) * 180) / Math.PI;
        const fade = Math.max(0, 1 - p.timeSinceDamage / DIR_WINDOW);
        this.rot.style.transform = `rotate(${deg.toFixed(1)}deg)`;
        this.dir.style.opacity = (Math.min(1, fade * 1.7) * 0.9).toFixed(3);
        this.dirOn = true;
      }
    } else if (this.dirOn) {
      this.dirOn = false;
      this.dir.style.opacity = '0';
    }
  }
}
