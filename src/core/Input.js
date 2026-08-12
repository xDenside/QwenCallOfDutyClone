export class Input {
  constructor(dom) {
    this.dom = dom;
    this.keys = new Set();
    this.buttons = new Set();
    this.dx = 0;
    this.dy = 0;
    this.locked = false;
    this.wheel = 0;
    this._lockCbs = [];
    this._unlockCbs = [];

    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.buttons.clear(); });
    window.addEventListener('mousedown', (e) => this.buttons.add(e.button));
    window.addEventListener('mouseup', (e) => this.buttons.delete(e.button));
    window.addEventListener('mousemove', (e) => {
      if (this.locked) { this.dx += e.movementX; this.dy += e.movementY; }
    });
    window.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === dom;
      (this.locked ? this._lockCbs : this._unlockCbs).forEach((f) => f());
    });
    dom.addEventListener('click', () => { if (!this.locked) dom.requestPointerLock(); });
  }

  consumeDeltas() {
    const d = { dx: this.dx, dy: this.dy };
    this.dx = 0; this.dy = 0;
    return d;
  }

  consumeWheel() { const w = this.wheel; this.wheel = 0; return w; }
  down(code) { return this.keys.has(code); }
  button(b) { return this.buttons.has(b); }
  onLock(f) { this._lockCbs.push(f); }
  onUnlock(f) { this._unlockCbs.push(f); }
}
