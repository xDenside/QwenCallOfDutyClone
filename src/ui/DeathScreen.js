// Death overlay: desaturated vignette, "K.I.A." reveal, and a
// "REDEPLOYING IN n…" countdown read straight off player.respawnTimer.

import { el } from './dom.js';

export class DeathScreen {
  constructor(root) {
    this.box = el('div', 'death', root);
    el('div', 'death-tint', this.box);
    const core = el('div', 'death-core', this.box);
    this.kia = el('div', 'kia', core, 'K.I.A.');
    this.count = el('div', 'death-count', core, 'REDEPLOYING IN 3\u2026');
    el('div', 'death-sub', core, 'Stay in the fight');

    this.on = false;
    this.lastN = -1;
  }

  show() {
    if (this.on) return;
    this.on = true;
    this.lastN = -1;
    this.box.classList.add('on');
  }

  hide() {
    if (!this.on) return;
    this.on = false;
    this.box.classList.remove('on');
  }

  update(dt, game) {
    if (!this.on) return;
    const p = game.player;
    if (!p) return;
    const t = Number.isFinite(p.respawnTimer) ? p.respawnTimer : 0;
    const n = Math.max(1, Math.ceil(t - 0.5)); // 3.5 s timer reads 3…2…1
    if (n !== this.lastN) {
      this.lastN = n;
      this.count.textContent = `REDEPLOYING IN ${n}\u2026`;
      this.count.animate(
        [{ opacity: 0.35, transform: 'scale(1.07)' }, { opacity: 1, transform: 'scale(1)' }],
        { duration: 240, easing: 'cubic-bezier(.2,.7,.3,1)' }
      );
    }
  }
}
