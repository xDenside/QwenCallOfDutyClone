// Top-right kill feed: "YOU ✕ ENEMY [M4A1]" rows. Max 4 stacked, auto-fade after 5 s.
// Entry/exit via class toggles + CSS transitions — no reflow, no per-frame work.

import { el } from './dom.js';

const MAX_ROWS = 4;
const LIFE_MS = 5000;
const EXIT_MS = 420;

export class KillFeed {
  constructor(root) {
    this.box = el('div', 'killfeed', root);
    this.rows = [];
  }

  add(npc, weapon) {
    const rawName = npc && (npc.name || npc.callsign || npc.type);
    const name = rawName ? String(rawName).toUpperCase() : 'ENEMY';
    let wname = '';
    if (weapon) wname = typeof weapon === 'string' ? weapon : weapon.name || weapon.id || '';

    const row = el('div', 'kf-row', this.box);
    el('span', 'kf-you', row, 'YOU');
    el('span', 'kf-x', row, '\u2715');
    el('span', 'kf-enemy', row, name);
    if (wname) el('span', 'kf-w', row, `[${String(wname).toUpperCase()}]`);

    // slide in on the next frame (class change between frames → CSS transition fires)
    requestAnimationFrame(() => row.classList.add('in'));

    this.rows.push(row);
    while (this.rows.length > MAX_ROWS) this.dismiss(this.rows[0]);
    row._t = setTimeout(() => this.dismiss(row), LIFE_MS);
  }

  dismiss(row) {
    if (!row || !row.parentNode) return;
    const i = this.rows.indexOf(row);
    if (i >= 0) this.rows.splice(i, 1);
    if (row._t) { clearTimeout(row._t); row._t = null; }
    row.classList.remove('in');
    row.classList.add('out');
    setTimeout(() => { if (row.parentNode) row.remove(); }, EXIT_MS);
  }

  clear() {
    while (this.rows.length) this.dismiss(this.rows[0]);
  }
}
