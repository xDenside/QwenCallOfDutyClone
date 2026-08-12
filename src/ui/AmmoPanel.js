// Bottom-right cluster: grenade "G" hint with cooldown pip + ammo panel
// (weapon name caps, big mag | reserve, low-ammo pulse, reload indicator).
// Fed by events AND a defensive per-frame poll of game.weapons.current,
// so the panel is correct even if one of the two paths never fires.

import { el } from './dom.js';

const NADE_COOLDOWN_MS = 4000;
const LOW_AMMO = 5;

export class AmmoPanel {
  constructor(root) {
    this.box = el('div', 'hud-br', root);

    // grenade hint
    this.nade = el('div', 'nade', this.box);
    this.nadeKey = el('span', 'nade-key', this.nade, 'G');
    this.nadePip = el('i', 'nade-pip', this.nade);
    this.nadeCdTimer = null;
    this.nadePipAnim = null;

    // ammo panel
    this.panel = el('div', 'ammo', this.box);
    this.wname = el('div', 'ammo-name', this.panel, 'M4A1');
    const count = el('div', 'ammo-count', this.panel);
    this.mag = el('span', 'mag', count, '30');
    el('span', 'sep', count, '|');
    this.res = el('span', 'reserve', count, '120');
    this.reloadBox = el('div', 'reload', this.panel);
    el('span', 'reload-label', this.reloadBox, 'RELOADING');
    el('i', 'reload-bar', this.reloadBox);

    this._name = 'M4A1';
    this._mag = 30;
    this._res = 120;
    this._low = false;
    this._dry = false;
    this._reloading = false;
    this._nadeCount = null;
  }

  setWeapon(name) {
    const n = name ? String(name).toUpperCase() : '';
    if (!n || n === this._name) return;
    this._name = n;
    this.wname.textContent = n;
    this.reloadEnd();
    this.panel.animate(
      [
        { opacity: 0.2, transform: 'translateY(9px)' },
        { opacity: 1, transform: 'translateY(0)' }
      ],
      { duration: 260, easing: 'cubic-bezier(.2,.7,.3,1)' }
    );
  }

  setAmmo(mag, reserve) {
    if (!Number.isFinite(mag)) return;
    const m = Math.max(0, Math.round(mag));
    const r = Number.isFinite(reserve) ? Math.max(0, Math.round(reserve)) : this._res;
    if (m === this._mag && r === this._res) return;
    this._mag = m;
    this._res = r;
    this.mag.textContent = m;
    this.res.textContent = r;

    const low = m > 0 && m < LOW_AMMO;
    const dry = m === 0;
    if (low !== this._low) { this._low = low; this.panel.classList.toggle('low', low); }
    if (dry !== this._dry) { this._dry = dry; this.panel.classList.toggle('dry', dry); }
  }

  reloadStart() {
    if (this._reloading) return;
    this._reloading = true;
    this.panel.classList.add('reloading');
  }

  reloadEnd() {
    if (!this._reloading) return;
    this._reloading = false;
    this.panel.classList.remove('reloading');
  }

  /** 'grenade-thrown' → dim the hint and drain the cooldown pip. */
  grenadeThrown() {
    this.nade.classList.add('cd');
    if (this.nadePipAnim) this.nadePipAnim.cancel();
    this.nadePipAnim = this.nadePip.animate(
      [{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }],
      { duration: NADE_COOLDOWN_MS, easing: 'linear', fill: 'forwards' }
    );
    if (this.nadeCdTimer) clearTimeout(this.nadeCdTimer);
    this.nadeCdTimer = setTimeout(() => {
      this.nade.classList.remove('cd');
      this.nadeCdTimer = null;
    }, NADE_COOLDOWN_MS);
  }

  update(dt, game) {
    const ws = game.weapons;
    if (!ws) return;
    const w = ws.current;
    if (w) {
      if (w.name && w.name !== this._name) this.setWeapon(w.name);
      if (Number.isFinite(w.mag) && (w.mag !== this._mag || w.reserve !== this._res)) {
        this.setAmmo(w.mag, w.reserve);
      }
    }
    // optional grenade count, only if the weapon system chooses to expose it
    const g = Number.isFinite(ws.grenades) ? ws.grenades : (w && Number.isFinite(w.grenades) ? w.grenades : null);
    if (g !== null && g !== this._nadeCount) {
      this._nadeCount = g;
      this.nadeKey.textContent = g > 0 ? 'G' : '\u2014';
      this.nade.classList.toggle('empty', g <= 0);
    }
  }
}
