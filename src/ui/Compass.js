// Top-center compass strip (N/E/S/W + degree ticks) scrolling with player yaw,
// with the current objective line under it.
// yaw convention (from Player): forward = (-sin yaw, -cos yaw), so yaw 0 faces -Z (north)
// and heading (compass degrees, N=0 E=90) = -yaw in degrees, normalized to [0,360).

import { el } from './dom.js';

const PPD = 2.4;          // pixels per degree
const WIDTH = 400;        // must match .compass-wrap width in CSS
const CENTER = WIDTH / 2;
const CARDINALS = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };

export class Compass {
  constructor(root) {
    this.wrap = el('div', 'compass-wrap', root);
    this.strip = el('div', 'compass', this.wrap);
    this.track = el('div', 'compass-track', this.strip);
    el('div', 'compass-caret', this.strip);
    el('div', 'obj-head', this.wrap, 'Current Objective');
    this.obj = el('div', 'objective', this.wrap, 'ELIMINATE HOSTILE FORCES');

    this.track.style.width = `${720 * PPD}px`;
    this._buildTicks();
    this.lastDeg = -999;
  }

  _buildTicks() {
    const frag = document.createDocumentFragment();
    for (let copy = 0; copy < 2; copy++) {
      for (let d = 0; d < 360; d += 5) {
        const deg = d + copy * 360;
        const x = `${deg * PPD}px`;
        let n;
        if (CARDINALS[d]) {
          n = el('span', d % 90 === 0 ? 'cl' : 'cl minor', null, CARDINALS[d]);
        } else if (d % 30 === 0) {
          n = el('span', 'cl num', null, String(d));
        } else {
          n = el('i', d % 15 === 0 ? 'ck maj' : 'ck');
        }
        n.style.left = x;
        frag.appendChild(n);
      }
    }
    this.track.appendChild(frag);
  }

  setObjective(text) {
    const t = typeof text === 'string' ? text : text && text.text;
    if (!t) return;
    this.obj.textContent = t.toUpperCase();
    this.obj.animate(
      [
        { opacity: 0, transform: 'translateY(-6px)' },
        { opacity: 1, transform: 'translateY(0)' }
      ],
      { duration: 380, easing: 'cubic-bezier(.2,.7,.3,1)' }
    );
  }

  update(dt, game) {
    const p = game.player;
    if (!p) return;
    let deg = ((-p.yaw * 180) / Math.PI) % 360;
    if (deg < 0) deg += 360;
    if (Math.abs(deg - this.lastDeg) < 0.05) return; // skip identical writes
    this.lastDeg = deg;
    // representative heading in [360,720) keeps the visible window inside the 2-copy track
    const tx = CENTER - (deg + 360) * PPD;
    this.track.style.transform = `translate3d(${tx.toFixed(2)}px, 0, 0)`;
  }
}
