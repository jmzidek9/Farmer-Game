// Height lookups on the Blender-made island heightmap (assets/heights.json).
import { TILE, ORIGIN, ORIGIN_Z } from './data.js';
let HM = null;
export const setHeights = h => (HM = h);
export function heightAt(x, z) {
  const { n, step, off, h } = HM;
  const fx = Math.min(Math.max((x - off) / step, 0), n - 1.001), fz = Math.min(Math.max((z - off) / step, 0), n - 1.001);
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
  const a = h[j * n + i], b = h[j * n + i + 1], c = h[(j + 1) * n + i], d = h[(j + 1) * n + i + 1];
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
export const tileX = i => ORIGIN + i * TILE + TILE / 2;
export const tileZ = j => ORIGIN_Z + j * TILE + TILE / 2;
export const tileAt = (x, z) => [Math.floor((x - ORIGIN) / TILE), Math.floor((z - ORIGIN_Z) / TILE)];
// mountain-trail mask 0..1 (nearest height sample)
export function pathAt(x, z) {
  const { n, step, off, p } = HM;
  if (!p) return 0;
  const i = Math.round((x - off) / step), j = Math.round((z - off) / step);
  return i < 0 || j < 0 || i >= n || j >= n ? 0 : p[j * n + i];
}
// river centre line (same formula as river_x in tools/make_island.py); it runs from z = RIVER_Z0 to the sea
export const RIVER_Z0 = -52;
export function riverX(z) {
  const k = z >= 0 ? 0 : z <= -20 ? 1 : (t => t * t * (3 - 2 * t))(-z / 20);
  const s = z >= -14 ? 0 : z <= -50 ? 1 : (t => t * t * (3 - 2 * t))((-14 - z) / 36);   // swings east to the falls
  return 31 + 0.5 * Math.sin(z * 0.15) * (1 - k) + k * (3 * Math.sin(z * 0.17 + 1.1) + 21 * s);
}
