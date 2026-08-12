// HUD — DOM-only tactical interface in the CoD MW2019 style.
// Builds its whole tree inside #hud once at init, caches every node it touches,
// and spends the frame loop writing transform/opacity only (no reads, no reflow).
// Never touches the WebGL canvas.

import { Crosshair } from './Crosshair.js';
import { Compass } from './Compass.js';
import { KillFeed } from './KillFeed.js';
import { AmmoPanel } from './AmmoPanel.js';
import { DamageLayer } from './DamageLayer.js';
import { DeathScreen } from './DeathScreen.js';

export class HUD {
  constructor(game) {
    this.game = game;
    this._dead = false;
  }

  init(game) {
    const root = document.getElementById('hud');
    if (!root) return; // defensive: never throw at boot
    root.textContent = '';

    this.root = root;
    this.xh = new Crosshair(root);
    this.dmg = new DamageLayer(root);
    this.compass = new Compass(root);
    this.feed = new KillFeed(root);
    this.ammo = new AmmoPanel(root);
    this.death = new DeathScreen(root);

    const ev = game.events;
    if (!ev || !ev.on) return;
    this.unsubs = [
      ev.on('shot', () => this.xh.onShot()),
      ev.on('npc-hit', (d) => this.xh.hit(d && d.headshot, false)),
      ev.on('npc-killed', (d) => {
        this.xh.hit(d && d.headshot, true); // kill confirm: larger pop
        this.feed.add(d && d.npc, d && d.weapon);
      }),
      ev.on('ammo-changed', (d) => { if (d) this.ammo.setAmmo(d.mag, d.reserve); }),
      ev.on('weapon-changed', (d) => {
        if (!d) return;
        const w = d.weapon;
        this.ammo.setWeapon(w && (w.name || w));
        this.ammo.reloadEnd();
      }),
      ev.on('reload-start', () => this.ammo.reloadStart()),
      ev.on('reload-end', () => this.ammo.reloadEnd()),
      ev.on('health-changed', () => this.dmg.invalidate()),
      ev.on('player-damaged', () => this.dmg.onDamaged()),
      ev.on('player-dead', () => {
        this.death.show();
        this.feed.clear();
        this.ammo.reloadEnd();
      }),
      ev.on('player-respawn', () => this.death.hide()),
      ev.on('grenade-thrown', () => this.ammo.grenadeThrown()),
      ev.on('objective-updated', (d) => this.compass.setObjective(d))
    ];
  }

  update(dt, game) {
    const p = game.player;
    if (!p) return;

    // dim the furniture while dead (K.I.A. screen owns the view)
    if (p.dead !== this._dead) {
      this._dead = p.dead;
      this.root.classList.toggle('dead', p.dead);
    }

    this.xh.update(dt, game);
    this.compass.update(dt, game);
    this.ammo.update(dt, game);
    this.dmg.update(dt, game);
    this.death.update(dt, game);
  }
}
