// Harvest Haven wildlife: crabs scuttling along the beach, seagulls wheeling over the shore, sea turtles in the
// turquoise shallows, dolphins leaping offshore. Each species is one InstancedMesh (one draw call) built from simple
// shapes with baked vertex colours; legs, wings, flippers and tails move in the vertex shader, driven per instance
// by an animation phase + amount the CPU advances each frame.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { withDetail, MAT } from './assets.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mulberry = seed => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

// ------------------------------------------------------------------------------------------- geometry kit
// every part: position, normal, color, aAnim (vec4: pivot x/z or side, phase offset, weight) so parts merge
function part(geo, color, anim = [0, 0, 0, 0], shade) {
  geo = geo.index ? geo.toNonIndexed() : geo;
  geo.deleteAttribute('uv');
  const n = geo.attributes.position.count, c = new Float32Array(n * 3), a = new Float32Array(n * 4), base = new THREE.Color(color);
  const tmp = new THREE.Color();
  for (let i = 0; i < n; i++) {
    tmp.copy(base);
    if (shade) shade(tmp, geo.attributes.position, geo.attributes.normal, i);
    c.set([tmp.r, tmp.g, tmp.b], i * 3);
    const an = typeof anim === 'function' ? anim(geo.attributes.position, i) : anim;
    a.set(an, i * 4);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  geo.setAttribute('aAnim', new THREE.BufferAttribute(a, 4));
  return geo;
}
const _up = new THREE.Vector3(0, 1, 0);
function cylBetween(a, b, r0, r1 = r0, seg = 5) {   // a tapered rod from point a to b
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A), len = d.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1);
  g.translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(_up, d.normalize()));
  g.translate(A.x, A.y, A.z);
  return g;
}
const ell = (rx, ry, rz, at, ws = 12, hs = 8) => new THREE.SphereGeometry(1, ws, hs).scale(rx, ry, rz).translate(...at);
// darker on top, lighter underneath (countershading)
const belly = (light, k = 1) => (c, p, n, i) => c.lerp(new THREE.Color(light), clamp((-n.getY(i) * 0.5 + 0.5) * k, 0, 1) ** 2);

// shared material maker: standard lighting, vertex colours x instance colour, a custom vertex animation
function animMat(glsl, { side = THREE.FrontSide, rough = 0.6 } = {}) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: rough, metalness: 0, side });
  m.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aAnim; attribute vec2 iAnim;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + glsl);
  };
  m.customProgramCacheKey = () => glsl;
  return withDetail(m, MAT.organic, 'wild');   // skin, shell and feather detail like every other model
}
function instanced(geo, mat, count) {
  const im = new THREE.InstancedMesh(geo, mat, count);
  im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  im.iAnim = new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2);
  im.iAnim.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iAnim', im.iAnim);
  im.frustumCulled = false; im.castShadow = true; im.receiveShadow = true;
  return im;
}

// ------------------------------------------------------------------------------------------- crab
function crabGeo() {
  const shell = '#c4471f', parts = [];
  parts.push(part(ell(0.13, 0.05, 0.1, [0, 0.07, 0], 14, 8), shell, undefined, (c, p, n, i) => {
    c.lerp(new THREE.Color('#e9a06a'), clamp(-n.getY(i), 0, 1) ** 1.5);                    // pale underside
    const x = p.getX(i), z = p.getZ(i);
    c.multiplyScalar(0.85 + 0.25 * Math.sin(x * 60) * Math.sin(z * 50));                 // mottled carapace
  }));
  for (const s of [-1, 1]) {
    // eyes on stalks
    parts.push(part(cylBetween([s * 0.035, 0.09, 0.08], [s * 0.04, 0.125, 0.09], 0.006), '#d9663a'));
    parts.push(part(ell(0.012, 0.012, 0.012, [s * 0.04, 0.13, 0.09], 8, 6), '#111111'));
    // claws: arm + big pincer, held up in front
    parts.push(part(cylBetween([s * 0.09, 0.07, 0.06], [s * 0.15, 0.09, 0.13], 0.016, 0.014), shell));
    parts.push(part(ell(0.04, 0.03, 0.055, [s * 0.15, 0.095, 0.17], 10, 8), '#d4552a', undefined, belly('#f2c19a', 0.8)));
    parts.push(part(cylBetween([s * 0.15, 0.1, 0.2], [s * 0.13, 0.1, 0.245], 0.012, 0.004), '#3a1a10'));
    parts.push(part(cylBetween([s * 0.165, 0.085, 0.2], [s * 0.155, 0.085, 0.24], 0.01, 0.004), '#3a1a10'));
    // four walking legs a side, each two segments, pivoting at the hip
    for (let k = 0; k < 4; k++) {
      const z = 0.045 - k * 0.035, hip = [s * 0.11, 0.065, z], knee = [s * 0.2, 0.1, z * 1.35], foot = [s * 0.26, 0.0, z * 1.7];
      const an = [hip[0], hip[2], (k + (s > 0 ? 0.5 : 0)) * Math.PI * 0.5, 1];
      parts.push(part(cylBetween(hip, knee, 0.011, 0.009), shell, an));
      parts.push(part(cylBetween(knee, foot, 0.009, 0.003), '#d66a3c', an));
    }
  }
  return mergeGeometries(parts);
}
// legs swing about their hip and lift as they step
const CRAB_GLSL = `
  if (aAnim.w > 0.) {
    float ph = iAnim.x + aAnim.z, amt = iAnim.y;
    float ang = sin(ph) * .45 * amt;
    vec2 d = transformed.xz - aAnim.xy; float ca = cos(ang), sa = sin(ang);
    transformed.xz = aAnim.xy + vec2(d.x * ca - d.y * sa, d.x * sa + d.y * ca);
    transformed.y += max(0., cos(ph)) * .035 * amt * smoothstep(.0, .1, abs(d.x));
  }`;

// ------------------------------------------------------------------------------------------- seagull
function gullGeo() {
  const parts = [];
  parts.push(part(ell(0.07, 0.07, 0.22, [0, 0, 0]), '#f4f4f2', undefined, belly('#ffffff')));
  parts.push(part(ell(0.055, 0.055, 0.06, [0, 0.04, 0.2]), '#f8f8f6'));
  parts.push(part(new THREE.ConeGeometry(0.014, 0.07, 6).rotateX(Math.PI / 2).translate(0, 0.035, 0.28), '#f0b429'));
  parts.push(part(ell(0.007, 0.007, 0.007, [0.04, 0.055, 0.235], 6, 4), '#111111'));
  parts.push(part(ell(0.007, 0.007, 0.007, [-0.04, 0.055, 0.235], 6, 4), '#111111'));
  parts.push(part(new THREE.ConeGeometry(0.06, 0.16, 4).rotateX(-Math.PI / 2).scale(1.4, 0.25, 1).translate(0, 0, -0.27), '#e9e9e7'));
  for (const s of [-1, 1]) {   // wings: grey with black tips, flapping from the shoulder
    const w = new THREE.BoxGeometry(0.62, 0.012, 0.16, 6, 1, 1).translate(s * 0.34, 0.02, -0.01);
    const p = w.attributes.position;
    for (let i = 0; i < p.count; i++) { const x = Math.abs(p.getX(i)); p.setZ(i, p.getZ(i) * (1 - x * 0.7) - x * x * 0.12); }   // tapered, swept back
    w.computeVertexNormals();
    parts.push(part(w, '#b7bec6', (pp, i) => [s, 0, 0, clamp(Math.abs(pp.getX(i)) / 0.65, 0, 1)], (c, pp, n, i) => {
      if (Math.abs(pp.getX(i)) > 0.55) c.set('#1e1e1e');
    }));
  }
  return mergeGeometries(parts);
}
const GULL_GLSL = `
  if (aAnim.w > 0.) {
    float ang = sin(iAnim.x) * .7 * iAnim.y + (1. - iAnim.y) * .12;     // flapping, or wings held slightly up when gliding
    float x = transformed.x; float s = aAnim.x;
    transformed.x = x * cos(ang);
    transformed.y += abs(x) * sin(ang) * (1. + aAnim.w * .4);
  }`;

// ------------------------------------------------------------------------------------------- sea turtle
function turtleGeo() {
  const parts = [];
  const shellShade = (c, p, n, i) => {
    const x = p.getX(i), z = p.getZ(i);
    const cell = Math.abs(Math.sin(x * 22 + Math.sin(z * 17) * 1.5) * Math.sin(z * 19 + Math.cos(x * 15)));
    c.lerp(new THREE.Color('#c9a25a'), cell > 0.75 ? 0.55 : 0);                       // scute pattern
    c.lerp(new THREE.Color('#e8d7a8'), clamp(-n.getY(i), 0, 1));                      // pale plastron underneath
  };
  parts.push(part(ell(0.33, 0.13, 0.42, [0, 0.02, 0], 18, 10), '#5b5b2e', undefined, shellShade));
  parts.push(part(ell(0.085, 0.075, 0.11, [0, 0.03, 0.46]), '#7f8a55', undefined, belly('#d9d2a0')));
  parts.push(part(ell(0.012, 0.012, 0.012, [0.055, 0.06, 0.51], 6, 4), '#111111'));
  parts.push(part(ell(0.012, 0.012, 0.012, [-0.055, 0.06, 0.51], 6, 4), '#111111'));
  for (const s of [-1, 1]) {   // front flippers long, rear short; each sweeps about where it joins the shell
    const fr = ell(0.24, 0.025, 0.07, [s * 0.42, 0, 0.18], 10, 6).rotateY(-s * 0.35);
    parts.push(part(fr, '#7f8a55', [s * 0.26, 0.22, s > 0 ? 0 : Math.PI, 1], belly('#d9d2a0')));
    const rr = ell(0.11, 0.02, 0.06, [s * 0.28, 0, -0.36], 8, 6).rotateY(s * 0.5);
    parts.push(part(rr, '#7f8a55', [s * 0.2, -0.32, s > 0 ? 1.5 : 1.5 + Math.PI, 0.5], belly('#d9d2a0')));
  }
  return mergeGeometries(parts);
}
const TURTLE_GLSL = `
  if (aAnim.w > 0.) {
    float ang = sin(iAnim.x + aAnim.z) * .5 * aAnim.w;
    vec2 d = transformed.xz - aAnim.xy; float ca = cos(ang), sa = sin(ang);
    transformed.xz = aAnim.xy + vec2(d.x * ca - d.y * sa, d.x * sa + d.y * ca);
    transformed.y += sin(iAnim.x + aAnim.z + 1.2) * .06 * aAnim.w * abs(d.x) * 3.;
  }`;

// ------------------------------------------------------------------------------------------- dolphin
function dolphinGeo() {
  const parts = [];
  const prof = [];
  for (let k = 0; k <= 24; k++) {   // spindle body, nose at +z: thick behind the head, slim tail stock
    const t = k / 24, r = 0.27 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.8) * (t > 0.92 ? 0.6 : 1);
    prof.push(new THREE.Vector2(Math.max(r, 0.004), (t - 0.55) * 2.2));
  }
  const body = new THREE.LatheGeometry(prof, 16).rotateX(Math.PI / 2).scale(1, 0.9, 1);
  const tailW = (p, i) => [0, 0, 0, clamp((-p.getZ(i) - 0.35) / 0.85, 0, 1)];
  parts.push(part(body, '#5d7486', tailW, belly('#dfe6ea', 1.4)));
  parts.push(part(new THREE.ConeGeometry(0.06, 0.28, 8).rotateX(-Math.PI / 2).translate(0, -0.02, -1.3).scale(1, 0.7, 1), '#5d7486', [0, 0, 0, 0]));
  // beak
  parts.push(part(new THREE.CylinderGeometry(0.03, 0.05, 0.16, 8).rotateX(Math.PI / 2).translate(0, -0.03, 1.22), '#6f8594'));
  // dorsal fin
  const fin = new THREE.Shape(); fin.moveTo(0, 0); fin.quadraticCurveTo(0.05, 0.22, -0.18, 0.3); fin.quadraticCurveTo(-0.12, 0.1, -0.26, 0); fin.lineTo(0, 0);
  parts.push(part(new THREE.ExtrudeGeometry(fin, { depth: 0.03, bevelEnabled: false }).rotateY(-Math.PI / 2).translate(0.015, 0.2, 0.05), '#4f6575', tailW));
  // flukes and pectoral fins
  for (const s of [-1, 1]) {
    const fl = new THREE.Shape(); fl.moveTo(0, 0); fl.quadraticCurveTo(0.12, -0.05, 0.3, -0.2); fl.quadraticCurveTo(0.12, -0.12, 0, -0.14); fl.lineTo(0, 0);
    parts.push(part(new THREE.ExtrudeGeometry(fl, { depth: 0.02, bevelEnabled: false }).rotateX(Math.PI / 2).scale(s, 1, 1).translate(0, 0, -1.08), '#4f6575', [0, 0, 0, 1]));
    parts.push(part(ell(0.16, 0.015, 0.06, [s * 0.22, -0.1, 0.45]).rotateY(-s * 0.5), '#5d7486', [0, 0, 0, 0]));
  }
  return mergeGeometries(parts);
}
const DOLPHIN_GLSL = `
  if (aAnim.w > 0.) transformed.y += sin(iAnim.x) * .18 * aAnim.w * aAnim.w * iAnim.y;`;

// ------------------------------------------------------------------------------------------- the creatures
export function createWildlife({ scene, heightAt, game }) {
  const R = mulberry(9001);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(0, 0, 0, 'YXZ'), V = new THREE.Vector3(), S = new THREE.Vector3(1, 1, 1);
  const find = (n, lo, hi, test = () => true, span = 400) => {
    const out = [];
    for (let k = 0; k < n * 200 && out.length < n; k++) {
      const x = (R() - 0.5) * span, z = (R() - 0.5) * span, h = heightAt(x, z);
      if (h > lo && h < hi && test(x, z, h)) out.push({ x, z, h });
    }
    return out;
  };

  // crabs: wander the wet sand, scuttle sideways, bolt when you get close
  const crabSpots = find(26, 0.05, 0.75, (x, z) => !(Math.abs(x) < 44 && z > -3 && z < 84));
  const crabs = instanced(crabGeo(), animMat(CRAB_GLSL, { rough: 0.45 }), crabSpots.length);
  const crabCols = ['#ffffff', '#ffffff', '#ffd2b0', '#ffb08a', '#f6e1c2'];   // tints: red, orange, pale ghost crab
  const crabState = crabSpots.map((p, i) => {
    crabs.setColorAt(i, new THREE.Color(crabCols[i % crabCols.length]));
    return { x: p.x, z: p.z, hx: p.x, hz: p.z, yaw: R() * TAU, tx: p.x, tz: p.z, wait: R() * 3, ph: R() * 10, amt: 0, s: 0.8 + R() * 0.5 };
  });
  scene.add(crabs);

  // seagulls: circle over stretches of the shore, flapping then gliding, banking into the turn
  const gullMat = animMat(GULL_GLSL, { side: THREE.DoubleSide, rough: 0.8 });
  gullMat.emissive.set('#5d6670');   // sunlight bouncing off the sea lights their undersides: white, not a dark silhouette
  const gulls = instanced(gullGeo(), gullMat, 12);
  gulls.castShadow = true;
  const shore = find(6, 0.0, 0.6);
  const gullState = Array.from({ length: 12 }, (_, i) => {
    const c = shore[i % shore.length] || { x: 0, z: 90 };
    return { cx: c.x, cz: c.z, r: 7 + R() * 9, y: 8 + R() * 6, a: R() * TAU, sp: (0.25 + R() * 0.15) * (R() < 0.5 ? -1 : 1), ph: R() * 10, flap: 1, timer: R() * 4 };
  });
  scene.add(gulls);

  // sea turtles: cruise the turquoise shallows, turning away from the beach and the deep
  const turtleSpots = find(6, -3.4, -1.3);
  const turtles = instanced(turtleGeo(), animMat(TURTLE_GLSL, { rough: 0.5 }), turtleSpots.length);
  turtles.castShadow = false;
  const turtleState = turtleSpots.map(p => ({ x: p.x, z: p.z, yaw: R() * TAU, turn: 0, ph: R() * 10, bob: R() * 10 }));
  scene.add(turtles);

  // dolphins: small pods offshore; each one leaps on its own clock, otherwise swims hidden in the deep blue
  // pods only where their whole swimming loop (25 m round, plus spread) is open deep water
  const deepLoop = (x, z) => { for (let k = 0; k < 16; k++) { const a = k / 16 * TAU; if (heightAt(x + Math.cos(a) * 31, z + Math.sin(a) * 31) > -4) return false; } return heightAt(x, z) < -4; };
  const pods = [];
  for (let k = 0; k < 48 && pods.length < 3; k++) {
    const a = k / 48 * TAU * 3 + 0.4, r = 120 + (k % 4) * 15, x = Math.cos(a) * r, z = Math.sin(a) * r + 20;
    if (deepLoop(x, z) && pods.every(p => Math.hypot(p.x - x, p.z - z) > 70)) pods.push({ x, z, a: R() * TAU });
  }
  const dolphins = instanced(dolphinGeo(), animMat(DOLPHIN_GLSL, { rough: 0.3 }), pods.length * 3);
  const dolState = pods.flatMap((pod, k) => [0, 1, 2].map(j => ({ pod, ox: (j - 1) * 3, oz: (j % 2) * -2.5, t: -R() * 6, dur: 1.5 + R() * 0.3, h: 1.3 + R() * 0.8, sp: 0 })));
  scene.add(dolphins);
  // splashes where they enter and leave the water: rings of foam that spread and fade
  const splashMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending });
  const splashes = new THREE.InstancedMesh(new THREE.RingGeometry(0.5, 1, 20).rotateX(-Math.PI / 2), splashMat, dolState.length * 2);
  splashes.instanceMatrix.setUsage(THREE.DynamicDrawUsage); splashes.frustumCulled = false; splashes.renderOrder = 2;
  splashes.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(dolState.length * 6).fill(1), 3);
  scene.add(splashes);

  const put = (im, i, x, y, z, yaw, pitch = 0, roll = 0, s = 1) => {
    M.compose(V.set(x, y, z), Q.setFromEuler(E.set(pitch, yaw, roll, 'YXZ')), S.setScalar(s));
    im.setMatrixAt(i, M);
  };

  function update(dt, t, level) {
    dt = Math.min(dt, 0.1);
    const pp = game?.player?.pos;
    // ---- crabs
    crabState.forEach((c, i) => {
      let want = false;
      const fleeing = pp && Math.hypot(pp.x - c.x, pp.z - c.z) < 3.2;
      if (fleeing) {   // run sideways, away from you
        const ax = c.x - pp.x, az = c.z - pp.z, l = Math.hypot(ax, az) || 1;
        c.tx = c.x + ax / l * 3; c.tz = c.z + az / l * 3; c.wait = 0;
      }
      if (c.wait > 0) c.wait -= dt;
      else {
        const dx = c.tx - c.x, dz = c.tz - c.z, d = Math.hypot(dx, dz);
        if (d < 0.08) {   // pick the next spot: a short hop along the sand near home
          c.wait = 0.5 + R() * 3;
          for (let k = 0; k < 8; k++) {
            const a = R() * TAU, r = 0.5 + R() * 2.5, x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
            if (Math.hypot(x - c.hx, z - c.hz) < 7 && heightAt(x, z) > level - 0.05 && heightAt(x, z) < 1) { c.tx = x; c.tz = z; break; }
          }
        } else {
          want = true;
          const sp = (fleeing ? 1.6 : 0.45) * c.s, step = Math.min(d, sp * dt);
          c.x += dx / d * step; c.z += dz / d * step;
          // crabs walk sideways: face 90 degrees off the direction of travel
          const face = Math.atan2(dx, dz) + Math.PI / 2 * (angDiff(c.yaw, Math.atan2(dx, dz) + Math.PI / 2) < Math.PI / 2 && angDiff(c.yaw, Math.atan2(dx, dz) + Math.PI / 2) > -Math.PI / 2 ? 1 : -1);
          c.yaw += angDiff(c.yaw, face) * Math.min(1, dt * 6);
          c.ph += dt * (fleeing ? 26 : 14);
        }
      }
      c.amt += ((want ? 1 : 0) - c.amt) * Math.min(1, dt * 8);
      const y = Math.max(heightAt(c.x, c.z), -5);
      put(crabs, i, c.x, y, c.z, c.yaw, 0, 0, c.s);
      crabs.iAnim.setXY(i, c.ph, c.amt);
    });
    crabs.instanceMatrix.needsUpdate = true; crabs.iAnim.needsUpdate = true;

    // ---- gulls
    gullState.forEach((g, i) => {
      g.timer -= dt;
      if (g.timer <= 0) { g.flap = g.flap > 0.5 ? 0 : 1; g.timer = g.flap ? 1.5 + R() * 2 : 2 + R() * 3; }
      g.a += g.sp * dt;
      const x = g.cx + Math.cos(g.a) * g.r, z = g.cz + Math.sin(g.a) * g.r, y = g.y + Math.sin(t * 0.4 + i) * 0.8;
      const yaw = Math.atan2(-Math.sin(g.a) * Math.sign(g.sp), Math.cos(g.a) * Math.sign(g.sp));
      g.ph += dt * 9 * (0.4 + g.flap * 0.6);
      put(gulls, i, x, y, z, yaw, 0.05, -Math.sign(g.sp) * 0.35, 1);
      gulls.iAnim.setXY(i, g.ph, g.flap);
    });
    gulls.instanceMatrix.needsUpdate = true; gulls.iAnim.needsUpdate = true;

    // ---- turtles
    turtleState.forEach((u, i) => {
      const ahead = heightAt(u.x + Math.sin(u.yaw) * 3, u.z + Math.cos(u.yaw) * 3);
      if (ahead > level - 1.0 || ahead < level - 4.2) u.turn = 0.6;        // too shallow or too deep ahead: turn
      else u.turn += ((Math.sin(t * 0.13 + i * 3) * 0.25) - u.turn) * dt;
      u.yaw += u.turn * dt;
      u.x += Math.sin(u.yaw) * 0.6 * dt; u.z += Math.cos(u.yaw) * 0.6 * dt;
      u.ph += dt * 2.2;
      const floor = heightAt(u.x, u.z), y = Math.max(floor + 0.35, level - 0.32 + Math.sin(t * 0.5 + u.bob) * 0.12);   // cruising just under the surface
      put(turtles, i, u.x, y, u.z, u.yaw, Math.sin(u.ph) * 0.05, u.turn * -0.3, 1.1);
      turtles.iAnim.setXY(i, u.ph, 1);
    });
    turtles.instanceMatrix.needsUpdate = true; turtles.iAnim.needsUpdate = true;

    // ---- dolphins
    dolState.forEach((d, i) => {
      const pod = d.pod;
      if (i % 3 === 0) { pod.a += dt * 0.04; }
      const head = pod.a + Math.PI / 2;
      const px = pod.x + Math.cos(pod.a) * 25, pz = pod.z + Math.sin(pod.a) * 25;
      d.t += dt;
      if (d.t > d.dur + 2.5 + (i % 3)) { d.t = -R() * 1.2; d.h = 1.2 + R() * 0.9; }
      const u = clamp(d.t / d.dur, 0, 1), jumping = d.t > 0 && d.t < d.dur;
      const fx = Math.cos(head), fz = Math.sin(head), sideX = -fz, sideZ = fx;
      const along = (u - 0.5) * 5;
      const x = px + sideX * d.ox + fx * (d.oz + along), z = pz + sideZ * d.ox + fz * (d.oz + along);
      const y = jumping ? level - 0.6 + Math.sin(u * Math.PI) * (d.h + 0.6) : level - 3;
      const pitch = jumping ? -Math.atan2(Math.cos(u * Math.PI) * Math.PI * (d.h + 0.6), 5) : 0;
      put(dolphins, i, x, y, z, Math.atan2(fx, fz), pitch, 0, 1);
      dolphins.iAnim.setXY(i, t * 8 + i, jumping ? 1 : 0.4);
      // splash at take-off and landing
      for (let s = 0; s < 2; s++) {
        const age = s === 0 ? d.t : d.t - d.dur, sx = px + sideX * d.ox + fx * (d.oz + (s ? 2.5 : -2.5)), sz = pz + sideZ * d.ox + fz * (d.oz + (s ? 2.5 : -2.5));
        const on = age > 0 && age < 1.2, k = on ? age / 1.2 : 1;
        M.compose(V.set(sx, level + 0.05, sz), Q.identity(), S.setScalar(on ? 0.4 + k * 1.6 : 0.0001));
        splashes.setMatrixAt(i * 2 + s, M);
        splashes.setColorAt(i * 2 + s, new THREE.Color().setScalar(on ? 1 - k : 0));
      }
    });
    dolphins.instanceMatrix.needsUpdate = true; dolphins.iAnim.needsUpdate = true;
    splashes.instanceMatrix.needsUpdate = true; splashes.instanceColor.needsUpdate = true;
  }
  return { update };
}
