// Shared world constants — the golden-hour sun must agree between the Sky
// addon, the shadow-casting DirectionalLight and the mountain slope tinting.
import * as THREE from 'three';

export const SUN_ELEVATION = 14;   // degrees — long raking shadows
export const SUN_AZIMUTH = 245;    // degrees — sun to the WSW, shadows fall ENE across the yard

export function sunDirection() {
  const phi = THREE.MathUtils.degToRad(90 - SUN_ELEVATION);
  const theta = THREE.MathUtils.degToRad(SUN_AZIMUTH);
  return new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
}

// fog tuned to the warm horizon haze of the sky
export const FOG_COLOR = 0xd8b489;
export const FOG_DENSITY = 0.0021;
