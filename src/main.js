import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { Input } from './core/Input.js';
import { Player } from './player/Player.js';
import { PostFX } from './core/PostFX.js';
import { Level } from './world/Level.js';
import { Lighting } from './world/Lighting.js';
import { WeaponSystem } from './weapons/WeaponSystem.js';
import { EnemySystem } from './ai/EnemySystem.js';
import { EffectsSystem } from './fx/EffectsSystem.js';
import { AudioSystem } from './audio/AudioSystem.js';
import { HUD } from './ui/HUD.js';

class Emitter {
  constructor() { this.m = new Map(); }
  on(e, fn) {
    if (!this.m.has(e)) this.m.set(e, new Set());
    this.m.get(e).add(fn);
    return () => this.off(e, fn);
  }
  off(e, fn) { const s = this.m.get(e); if (s) s.delete(fn); }
  emit(e, data) { const s = this.m.get(e); if (s) s.forEach((fn) => fn(data)); }
}

const container = document.getElementById('app');
const engine = new Engine(container);

const game = {
  engine,
  scene: engine.scene,
  camera: engine.camera,
  renderer: engine.renderer,
  input: new Input(engine.renderer.domElement),
  events: new Emitter(),
  time: 0,
  paused: true,
  systems: [],
  debug: {
    freeCam: false,
    allowPausedUpdate: false,
    setCamera(pos, look, fov) {
      game.camera.position.set(pos[0], pos[1], pos[2]);
      game.camera.lookAt(look[0], look[1], look[2]);
      if (fov) { game.camera.fov = fov; game.camera.updateProjectionMatrix(); }
      game.debug.freeCam = true;
    },
    releaseCamera() { game.debug.freeCam = false; }
  }
};
window.game = game;
window.THREE = THREE;

game.level = new Level(game);
game.lighting = new Lighting(game);
game.player = new Player(game);
game.fx = new EffectsSystem(game);
game.audio = new AudioSystem(game);
game.enemies = new EnemySystem(game);
game.weapons = new WeaponSystem(game);
game.hud = new HUD(game);
game.postfx = new PostFX(game);

const bootOrder = [
  game.level, game.lighting, game.fx, game.audio,
  game.player, game.enemies, game.weapons, game.hud, game.postfx
];
for (const s of bootOrder) {
  if (s.init) s.init(game);
  game.systems.push(s);
}

const overlay = document.getElementById('overlay');
overlay.addEventListener('click', () => engine.renderer.domElement.requestPointerLock());
game.input.onLock(() => { game.paused = false; overlay.classList.add('hidden'); });
game.input.onUnlock(() => { game.paused = true; overlay.classList.remove('hidden'); });

const clock = engine.clock;
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 1 / 20);
  game.time += dt;
  const run = !game.paused || game.debug.allowPausedUpdate;
  if (run) {
    for (const s of game.systems) {
      if (s.update) s.update(dt, game);
    }
  }
  engine.render();
}
frame();

window.__GAME_READY__ = true;
