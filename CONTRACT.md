# STRIKE COMPOUND — Architecture Contract

A Three.js FPS built to the visual bar of Call of Duty: Modern Warfare (2019) — golden-hour
desert compound, PBR everywhere, heavy but disciplined post-FX, pooled particles, procedural
soldiers. **Every system is built by a separate agent working ONLY on its own files.**

## Run / verify commands

```bash
npm run build          # MUST pass before you report done
npm run capture -- --name myshot --pos 0,3,50 --look 0,2,0 --wait 1500   # screenshot harness (see below)
```

- Do NOT run `npm run dev` / `npm run preview` (shared ports; the integrator runs them).
- Do NOT `git commit` (the integrator commits).
- Do NOT add npm dependencies. three + three/addons only.
- If you believe a core file must change, do NOT change it — describe the need in your report.

## File ownership (hard rule: write only inside your scope)

| Agent | Owns |
|---|---|
| World & Lighting | `src/world/**` (Level.js, Lighting.js, + any helper files in src/world/) |
| Weapons | `src/weapons/**` |
| AI | `src/ai/**` |
| FX | `src/fx/**` |
| Audio | `src/audio/**` |
| HUD/UI | `src/ui/**` and the `<style>`/`#hud` markup of `index.html` |
| LOCKED (integrator) | `src/core/**`, `src/player/**`, `src/main.js`, `tools/**` |

You may create additional files inside your scope (e.g. `src/world/Props.js`) and import them
from your entry class file. Cross-scope imports are forbidden except importing from `three`
and reading the `game` context at runtime.

## The `game` context (single argument everywhere)

```
game.engine    { renderer, scene, camera, composer }
game.input     { keys:Set, buttons:Set, down(code), button(i), consumeDeltas(), consumeWheel(), locked }
game.events    { on(name, fn)->unsub, off, emit }
game.player    { position(feet), velocity, yaw, pitch, eyeHeight, health, dead, ads(0..1), hSpeed,
                 isSprinting, isMoving, onGround, addRecoil(pitch,yaw), lastDamageFrom }
game.level     { group, spawnPoint, spawnYaw, collideMove(pos,vel,dt,opts)->grounded,
                 heightAt(x,z), raycast(origin,dir,maxDist)->{point,normal,material}|null }
game.enemies   { npcs:[], raycastTargets(origin,dir,maxDist)->{point,npc,part,distance}|null,
                 damage(npc,amount,point,{headshot}) }
game.fx        { muzzleFlash, tracer, impact, explosion, shell, blood }   // all safe no-ops until FX lands
game.audio     { play(name,{position,volume,pitch}), setListenerFromCamera(camera) }
game.hud       {}
game.time      seconds since boot
game.paused    true until pointer lock; capture harness sets debug.allowPausedUpdate
game.debug     { freeCam, allowPausedUpdate, setCamera(pos,look,fov), releaseCamera(), ... }
```

Headless capture runs WITHOUT pointer lock: `game.paused` stays true but
`game.debug.allowPausedUpdate=true` is set, so `update()` still runs. Anything that requires
real mouse/key input must also work when state is injected directly into `game.input.keys`,
`game.input.buttons`, and `game.input.dx/dy`.

## Event names (emit/on exactly these)

```
shot              { weapon, origin, dir, hitPoint, npc|null }
impact            { point, normal, material, weapon }
npc-hit           { npc, damage, point, headshot }
npc-killed        { npc, weapon }
player-damaged    { amount, origin }
player-dead       {}
player-respawn    {}
explosion         { point, radius, damage }
reload-start      { weapon }   reload-end { weapon }
weapon-changed    { weapon }   ammo-changed { mag, reserve, weapon }
health-changed    { health }
grenade-thrown    { origin, dir }
objective-updated { text }
```

## System APIs you must implement (your entry class)

All systems get `init(game)` once (scene is live, stubs of other systems exist) and
`update(dt, game)` every frame. Extra requirements per system:

- **Level**: `collideMove` must resolve player capsule vs all solid geometry (AABB list is fine);
  `raycast` must hit world geometry for bullets and return a `material` string from:
  `dirt, concrete, metal, wood, sandbag, glass, flesh` (drives FX/audio response).
  Export a `spawnPoint`/`spawnYaw` the player uses.
- **WeaponSystem**: `current` must always expose `{ name, adsFov }`. Must provide `debugFire()`
  (fires one shot without input — used by the capture harness).
- **EnemySystem**: `raycastTargets(origin, dir, maxDist)` for player bullets; `damage(npc, ...)`.
- **EffectsSystem**: keep the exact method names of the stub (muzzleFlash/tracer/impact/explosion/shell/blood).
- **AudioSystem**: `play(name, opts)` must never throw for unknown names. Unlock AudioContext on
  first user gesture AND when `game.debug.allowPausedUpdate` is true (headless capture).
- **HUD**: DOM-only inside `#hud`; never touch the WebGL canvas.

## Performance budget (hard)

- ≤ 300 draw calls, ≤ 500k triangles. Merge static geometry (`BufferGeometryUtils`), instance repeats.
- One shadow-casting light (the sun). Shadow map ≤ 4096. Only mid/large props cast shadows.
- Particle pools with hard caps; no per-frame allocations in hot paths.
- Texture canvases ≤ 1024², reused across materials where possible.

## Visual bar (this is the whole point)

Reference: CoD MW2019 golden-hour desert/urban ops. Concretely:

- No flat untextured surfaces. Every material needs albedo variation + roughness variation
  (procedural canvas noise is fine, but it must read as grunge/wear, not checkerboards).
- Edge wear, dust accumulation on upward faces, AO in corners (bake vertex AO or use SSAO in PostFX).
- Warm low sun (elev ~12–20°), long soft shadows, cool sky fill opposite the sun, dust haze.
- Clutter sells realism: debris, cables, pallets, rocks, tire tracks, sparse vegetation.
- Camera feel: subtle bob, ADS FOV kick, recoil, muzzle-flash light flicker on nearby geometry.

## Screenshot capture harness (your visual feedback loop)

The integrator runs `npm run preview` for you on request — but you can also capture during
development ONLY if a preview server is already running (check `curl -s localhost:4173`). If not,
skip captures and rely on code correctness; the critic round catches visuals later.

```bash
npm run capture -- --name courtyard --pos 0,2.2,30 --look 0,1.6,0 [--fov 75] [--wait 1500] [--out shots]
                     [--eval "game.input.keys.add('KeyW')"] [--eval "game.weapons.debugFire()"]
```

`--eval` snippets run in page context (awaited, in order) before the screenshot. Use
`game.debug.setCamera([...],[...],fov)` for free camera poses. Read the PNGs you produce to
actually look at your work.

## Definition of done (every agent)

1. `npm run build` passes with zero errors.
2. Your stub contract surface is fully implemented (no missing methods another system may call).
3. Your code has zero console errors at runtime (defensive against other systems still being stubs).
4. You iterated on quality: re-read your code once looking for the "student project" smell
   (flat colors, magic floating objects, missing shadows/AO, linear-motion animations) and fix it.
5. Report: what you built, files touched, known gaps, any core-file change requests.

## Critique process (what happens after integration)

A harsh critic agent renders 10+ scripted gameplay frames (advancing, firing, explosions, ADS),
compares them side-by-side with real CoD reference imagery, scores 0–10 across
lighting/materials/FX/animation/composition/performance, and files a ranked fix list.
Fix agents then attack the findings. This loops until the critic signs off. Build accordingly:
the things critics always nuke are flat lighting, plastic materials, empty ground, stiff
animation, weak muzzle flash/tracers, and UI that looks like a dev placeholder.
