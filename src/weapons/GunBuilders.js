import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// Gun-space convention for every rig:
//   bore axis lies on y = 0, muzzle points toward -Z, grip toward -Y.
//   The rear-sight aperture / optic window sits at (0, lineY, rearZ).
// The ViewModel derives the ADS camera offset directly from the sight marker,
// so the sights align with screen center by construction when ads == 1.
// ---------------------------------------------------------------------------

function box(w, h, d, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

// Cylinder whose axis runs along Z after the default rotateX(PI/2).
function cylZ(rFront, rRear, len, x, y, z, seg = 12, tilt = 0) {
  const g = new THREE.CylinderGeometry(rFront, rRear, len, seg);
  g.rotateX(Math.PI / 2 + tilt); // +Y (top radius) -> +Z (rear)
  g.translate(x, y, z);
  return g;
}

// Cylinder whose axis runs along X (pins, knobs, tube across the receiver).
function cylX(r, len, x, y, z, seg = 10) {
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  g.rotateZ(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

function mergeInto(list) {
  if (list.length === 0) return null;
  const merged = mergeGeometries(list, false);
  for (const g of list) g.dispose();
  return merged;
}

function makeMesh(geo, mat) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = false;
  m.receiveShadow = false;
  m.frustumCulled = false; // viewmodel lives glued to the near plane
  return m;
}

// ---------------------------------------------------------------------------
// Materials: parkerized gunmetal + warm-black polymer, canvas grunge maps,
// a tiny PMREM environment so metal has something to reflect.
// ---------------------------------------------------------------------------

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Soft mottled base + fine per-pixel noise. Reads as grunge/wear, not checkerboard.
function grungeCanvas(size, base, blobAlpha, blobCount, noiseAmp, streaks = 0) {
  const c = canvasOf(size, size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = `rgb(${base},${base},${base})`;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < blobCount; i++) {
    const x = Math.random() * size, y = Math.random() * size;
    const r = size * (0.04 + Math.random() * 0.22);
    const v = Math.max(0, Math.min(255, base + (Math.random() * 2 - 1) * 85));
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${v | 0},${v | 0},${v | 0},${blobAlpha})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < streaks; i++) {
    const x = Math.random() * size, y = Math.random() * size;
    const len = size * (0.15 + Math.random() * 0.4);
    const a = Math.random() * Math.PI;
    const v = Math.max(0, Math.min(255, base + (Math.random() > 0.5 ? 60 : -55)));
    ctx.strokeStyle = `rgba(${v},${v},${v},${0.05 + Math.random() * 0.09})`;
    ctx.lineWidth = 0.5 + Math.random() * 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() * 2 - 1) * noiseAmp;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Near-white albedo grunge: multiplied by the material color, adds oil smudges.
function albedoCanvas(size) {
  const c = canvasOf(size, size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgb(246,246,246)';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 46; i++) {
    const x = Math.random() * size, y = Math.random() * size;
    const r = size * (0.03 + Math.random() * 0.16);
    const v = 195 + (Math.random() * 45) | 0;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${v},${v},${v},0.22)`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() * 2 - 1) * 9;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Stippled grip texture for bump.
function stippleCanvas(size) {
  const c = canvasOf(size, size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgb(120,120,120)';
  ctx.fillRect(0, 0, size, size);
  const step = 9;
  for (let y = step / 2; y < size; y += step) {
    for (let x = step / 2; x < size; x += step) {
      const jx = (Math.random() - 0.5) * 3, jy = (Math.random() - 0.5) * 3;
      const r = 1.6 + Math.random() * 1.4;
      const g = ctx.createRadialGradient(x + jx, y + jy, 0, x + jx, y + jy, r);
      g.addColorStop(0, 'rgb(205,205,205)');
      g.addColorStop(1, 'rgb(110,110,110)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x + jx, y + jy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return c;
}

// Small equirect environment: warm golden-hour sky + dark ground + sun glow.
function envCanvas() {
  const c = canvasOf(256, 128);
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0.0, '#3d5a80');
  grad.addColorStop(0.42, '#8a93a0');
  grad.addColorStop(0.52, '#e0a35c');
  grad.addColorStop(0.58, '#7a6047');
  grad.addColorStop(1.0, '#2b241d');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 128);
  const sun = ctx.createRadialGradient(185, 62, 1, 185, 62, 30);
  sun.addColorStop(0, 'rgba(255,235,190,0.95)');
  sun.addColorStop(0.25, 'rgba(255,190,110,0.55)');
  sun.addColorStop(1, 'rgba(255,160,70,0)');
  ctx.fillStyle = sun;
  ctx.fillRect(150, 30, 70, 66);
  return c;
}

export function createWeaponMaterials(renderer) {
  // Tiny PMREM environment so metal has something to reflect. Guarded: if no
  // renderer is available we simply ship materials without an envMap.
  let env = null;
  if (renderer) {
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const eq = new THREE.CanvasTexture(envCanvas());
      eq.mapping = THREE.EquirectangularReflectionMapping;
      env = pmrem.fromEquirectangular(eq).texture;
      eq.dispose();
      pmrem.dispose();
    } catch (e) { env = null; }
  }

  const metalRough = new THREE.CanvasTexture(grungeCanvas(512, 117, 0.10, 42, 16, 26)); // ≈0.46 roughness with wear
  const polyRough = new THREE.CanvasTexture(grungeCanvas(512, 158, 0.12, 34, 20, 6));   // ≈0.62
  const grime = new THREE.CanvasTexture(albedoCanvas(512));
  grime.colorSpace = THREE.SRGBColorSpace;
  const stipple = new THREE.CanvasTexture(stippleCanvas(256));
  for (const t of [metalRough, polyRough, grime, stipple]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
  }

  const steel = new THREE.MeshStandardMaterial({
    color: 0x272a2e, metalness: 0.7, roughness: 0.5,
    map: grime, roughnessMap: metalRough, envMap: env, envMapIntensity: 0.9,
  });
  const steelDark = new THREE.MeshStandardMaterial({
    color: 0x1d1f22, metalness: 0.65, roughness: 0.55,
    map: grime, roughnessMap: metalRough, envMap: env, envMapIntensity: 0.7,
  });
  const polymer = new THREE.MeshStandardMaterial({
    color: 0x191512, metalness: 0.1, roughness: 0.7,
    map: grime, roughnessMap: polyRough, bumpMap: stipple, bumpScale: 0.4,
    envMap: env, envMapIntensity: 0.3,
  });
  return { steel, steelDark, polymer, env };
}

// ---------------------------------------------------------------------------
// M4A1
// ---------------------------------------------------------------------------

export function buildM4(mats) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const steelG = [], darkG = [], polyG = [];

  // --- barrel, gas system, muzzle device ---
  steelG.push(cylZ(0.0115, 0.0128, 0.34, 0, 0, -0.30, 14));              // barrel
  steelG.push(cylZ(0.0165, 0.0165, 0.02, 0, 0, -0.135, 14));             // barrel nut
  steelG.push(box(0.024, 0.018, 0.028, 0, 0.015, -0.385));               // gas block
  darkG.push(cylZ(0.0142, 0.0142, 0.05, 0, 0, -0.492, 14));              // muzzle brake
  darkG.push(cylZ(0.0118, 0.0118, 0.008, 0, 0, -0.521, 14));             // crown

  // --- front sight post (A2 style), tip y == lineY (0.076) ---
  steelG.push(box(0.014, 0.02, 0.016, 0, 0.022, -0.45));
  steelG.push(box(0.004, 0.05, 0.0045, 0, 0.051, -0.45));
  steelG.push(box(0.0035, 0.03, 0.012, 0.008, 0.036, -0.45));
  steelG.push(box(0.0035, 0.03, 0.012, -0.008, 0.036, -0.45));

  // --- receiver ---
  steelG.push(box(0.052, 0.036, 0.35, 0, 0.013, 0.005));                 // upper
  steelG.push(box(0.055, 0.04, 0.31, 0, -0.024, 0.012));                 // lower
  steelG.push(box(0.038, 0.024, 0.055, 0, -0.046, -0.008));              // mag well
  steelG.push(box(0.027, 0.009, 0.37, 0, 0.0355, 0.0));                  // top rail (receiver)
  steelG.push(box(0.027, 0.009, 0.24, 0, 0.0355, -0.245));               // top rail (handguard)
  steelG.push(cylX(0.004, 0.058, 0, -0.004, -0.155));                    // takedown pins
  steelG.push(cylX(0.004, 0.058, 0, -0.004, 0.125));
  steelG.push(box(0.006, 0.026, 0.006, 0, -0.05, -0.018));               // trigger guard
  steelG.push(box(0.006, 0.006, 0.06, 0, -0.062, 0.008));
  steelG.push(box(0.004, 0.014, 0.005, 0, -0.046, 0.008));               // trigger
  steelG.push(box(0.008, 0.024, 0.19, 0.029, -0.003, -0.24));            // side rails
  steelG.push(box(0.008, 0.024, 0.19, -0.029, -0.003, -0.24));
  steelG.push(box(0.027, 0.008, 0.19, 0, -0.033, -0.24));                // bottom rail

  // --- ejection port / deflector / forward assist (right side = +x) ---
  darkG.push(box(0.006, 0.028, 0.085, 0.0285, 0.008, 0.02));
  darkG.push(box(0.003, 0.022, 0.07, 0.0325, 0.008, 0.02));
  darkG.push(box(0.010, 0.02, 0.014, 0.030, 0.012, 0.068, 0, 0.55, 0));
  darkG.push(cylX(0.007, 0.012, 0.033, 0.002, 0.055));

  // --- rear sight (aperture center y == lineY 0.076, z == rearZ 0.105) ---
  darkG.push(box(0.032, 0.01, 0.032, 0, 0.045, 0.105));
  darkG.push(box(0.005, 0.026, 0.012, 0.0125, 0.063, 0.108));
  darkG.push(box(0.005, 0.026, 0.012, -0.0125, 0.063, 0.108));
  darkG.push(cylX(0.006, 0.009, 0.023, 0.05, 0.105));

  // --- handguard + furniture (polymer, warm black) ---
  polyG.push(box(0.057, 0.052, 0.235, 0, -0.003, -0.245));
  polyG.push(box(0.032, 0.016, 0.026, 0, -0.036, -0.352));               // hand stop
  polyG.push(box(0.030, 0.070, 0.037, 0, -0.078, 0.088, -0.27));         // pistol grip
  polyG.push(box(0.033, 0.016, 0.043, 0, -0.111, 0.099, -0.27));         // grip flare

  // --- stock (buffer tube + body + buttpad, angled slightly down) ---
  const tilt = 0.045;
  darkG.push(cylZ(0.0155, 0.0155, 0.21, 0, -0.01, 0.275, 12, tilt));
  polyG.push(box(0.042, 0.058, 0.15, 0, -0.038, 0.35, -tilt));
  polyG.push(box(0.030, 0.016, 0.07, 0, -0.012, 0.335, -tilt));          // cheek riser
  darkG.push(box(0.046, 0.066, 0.016, 0, -0.042, 0.428, -tilt));         // buttpad
  const sling = new THREE.TorusGeometry(0.012, 0.0024, 6, 14);
  sling.rotateY(Math.PI / 2);
  sling.translate(0, -0.032, 0.434);
  darkG.push(sling);

  // --- merged meshes ---
  body.add(makeMesh(mergeInto(steelG), mats.steel));
  body.add(makeMesh(mergeInto(darkG), mats.steelDark));
  body.add(makeMesh(mergeInto(polyG), mats.polymer));

  // --- magazine (curved, segmented; drops on reload) ---
  const mag = new THREE.Group();
  mag.position.set(0, -0.05, -0.008);
  const magG = [];
  let my = -0.026, mz = 0, ang = 0;
  const curve = [0.035, 0.10, 0.17, 0.24];
  for (let i = 0; i < 4; i++) {
    ang = curve[i];
    magG.push(box(0.032, 0.054, 0.044, 0, my, mz, ang));
    const dy = Math.cos(ang) * 0.052, dz = -Math.sin(ang) * 0.052;
    my -= dy; mz += dz;
  }
  magG.push(box(0.035, 0.013, 0.048, 0, my - 0.004, mz, ang));          // floor plate
  const magMesh = makeMesh(mergeInto(magG), mats.steelDark);
  mag.add(magMesh);
  body.add(mag);
  mag.userData.base = { y: mag.position.y, rx: 0, rz: 0 };

  // --- charging handle (separate mesh: lurches back on fire, pulls on reload) ---
  // Kept short so its rear stays in front of the camera near plane when ADS'd.
  const chG = [
    box(0.012, 0.008, 0.042, 0, 0.033, 0.118),
    box(0.028, 0.010, 0.011, 0, 0.032, 0.139),
    box(0.006, 0.012, 0.014, -0.008, 0.033, 0.135),
  ];
  const ch = makeMesh(mergeInto(chG), mats.steelDark);
  body.add(ch);
  ch.userData.baseZ = 0;

  // --- markers ---
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0, -0.528); body.add(muzzle);
  const eject = new THREE.Object3D(); eject.position.set(0.038, 0.016, 0.05); body.add(eject);
  const sight = new THREE.Object3D(); sight.position.set(0, 0.076, 0.105); body.add(sight);

  return {
    name: 'M4A1', root, body, mag, bolt: ch, muzzle, eject, sight,
    slideBaseZ: 0, boltTravel: 0.006,
  };
}

// ---------------------------------------------------------------------------
// P1911
// ---------------------------------------------------------------------------

export function buildP1911(mats) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const frameG = [], polyG = [];

  // --- frame rails / dust cover / trigger group ---
  frameG.push(box(0.025, 0.014, 0.19, 0, -0.006, -0.012));
  frameG.push(box(0.025, 0.014, 0.055, 0, -0.02, -0.082));
  frameG.push(box(0.005, 0.026, 0.005, 0, -0.028, -0.038));              // guard strut
  frameG.push(box(0.005, 0.005, 0.048, 0, -0.04, -0.014));               // guard bottom
  frameG.push(box(0.003, 0.014, 0.004, 0, -0.024, -0.010));              // trigger
  frameG.push(cylZ(0.0105, 0.0105, 0.014, 0, 0, -0.119, 12));            // barrel bushing
  frameG.push(cylZ(0.0075, 0.0075, 0.03, 0, 0, -0.102, 10));             // barrel tip
  frameG.push(box(0.006, 0.018, 0.012, 0, 0.014, 0.09, -0.35));          // hammer
  frameG.push(box(0.017, 0.007, 0.024, 0, 0.016, 0.082, -0.3));          // beavertail
  frameG.push(box(0.003, 0.004, 0.03, -0.0145, 0.002, -0.015));          // slide stop
  frameG.push(box(0.003, 0.005, 0.022, -0.0145, 0.01, 0.045));           // thumb safety
  frameG.push(cylX(0.0035, 0.005, -0.0135, -0.018, 0.012, 8));           // mag release

  // --- polymer grip furniture ---
  polyG.push(box(0.027, 0.075, 0.031, 0, -0.055, 0.045, -0.30));
  polyG.push(box(0.021, 0.048, 0.012, 0, -0.048, 0.062, -0.18));         // mainspring housing
  polyG.push(box(0.024, 0.02, 0.014, 0, -0.088, 0.066, -0.35));          // lanyard base

  body.add(makeMesh(mergeInto(frameG), mats.steelDark));
  body.add(makeMesh(mergeInto(polyG), mats.polymer));

  // --- slide (reciprocates; carries the rear sight) ---
  const slideG = [
    box(0.027, 0.03, 0.205, 0, 0.016, -0.010),
    box(0.024, 0.024, 0.018, 0, 0.013, -0.12),
    box(0.009, 0.007, 0.007, 0.0085, 0.0345, 0.075),                     // rear sight ears
    box(0.009, 0.007, 0.007, -0.0085, 0.0345, 0.075),
    box(0.004, 0.008, 0.006, 0, 0.035, -0.098),                          // front sight
    box(0.004, 0.011, 0.042, 0.0136, 0.018, -0.005),                     // ejection port
  ];
  const slide = makeMesh(mergeInto(slideG), mats.steel);
  body.add(slide);
  slide.userData.baseZ = 0;

  // --- magazine (drops out of the grip on reload) ---
  const mag = new THREE.Group();
  mag.position.set(0, -0.052, 0.042);
  mag.rotation.x = -0.30;
  const magG = [
    box(0.02, 0.072, 0.027, 0, -0.012, 0),
    box(0.023, 0.01, 0.031, 0, -0.052, 0),                               // base pad
  ];
  mag.add(makeMesh(mergeInto(magG), mats.steelDark));
  body.add(mag);
  mag.userData.base = { y: mag.position.y, rx: mag.rotation.x, rz: 0 };

  // --- markers ---
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0, -0.134); body.add(muzzle);
  const eject = new THREE.Object3D(); eject.position.set(0.018, 0.024, 0.005); body.add(eject);
  const sight = new THREE.Object3D(); sight.position.set(0, 0.0345, 0.075); body.add(sight);

  return {
    name: 'P1911', root, body, mag, bolt: slide, muzzle, eject, sight,
    slideBaseZ: 0, boltTravel: 0.021,
  };
}
