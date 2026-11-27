// Harvest Haven — view: the farm grid, buildings and every living thing on the island, plus effects.
// Reads game.state (read-only) and consumes state.js `dirty`. Every model comes from assets/models.glb via
// assets.js; procedural geometry here is effects only (particles, rope line, cursors, bolt, pick proxies).
import * as THREE from 'three';
import { makeMesh, makeInstanced, lib, uniforms } from './assets.js';
import { GRID, PLOT, PLOTS, TILE, ORIGIN, ORIGIN_Z, CROPS, ITEMS, BUILDINGS, RECIPES, fmtNum } from './data.js';
import { dirty, stageOf, sizeOf, centerOf } from './state.js';
import { heightAt, tileX, tileZ, tileAt, riverX, RIVER_Z0 } from './terrain.js';

const N = GRID * GRID, PI = Math.PI, TAU = PI * 2;
const SOIL_TOP = 0.13, RAISED = 0.3;                 // soil_tile top / soil lift on a raised_bed
const WET = 0.62;
const FOLIAGE = /^(crop_|tree_|palm_|jungle_|bush_|grass_|fern|flower_)/;
const OBS_TREE = { palm: ['palm_a', 'palm_b', 'palm_c'], jungle: ['jungle_a', 'jungle_b', 'jungle_a'] };
const ROCKS = ['rock_s', 'rock_m', 'rock_l'];
const DONKEY = ['donkey_body', 'donkey_body_bags', 'donkey_body_cart'];
const TRADER_AT = { x: -52, z: 77 };   // just inland of the pier's land end (PIER.z - 14)

// scratch objects (never allocate in the frame loop)
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _e = new THREE.Euler(), _c = new THREE.Color(), _v = new THREE.Vector3(), _w = new THREE.Vector3();
const _cam = new THREE.Vector3(), _fwd = new THREE.Vector3(), _fp = new THREE.Vector3();
const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);
const WHITE = new THREE.Color(1, 1, 1), WETC = new THREE.Color(WET, WET, WET);

const hash = (k, n) => { const x = Math.sin(k * 127.1 + n * 311.7) * 43758.5453; return x - Math.floor(x); };
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const damp = (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt));
const dampAngle = (a, b, l, dt) => { let d = (b - a) % TAU; if (d > PI) d -= TAU; if (d < -PI) d += TAU; return a + d * (1 - Math.exp(-l * dt)); };
const easeOutBack = t => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
function compose(x, y, z, yaw, sx, sy = sx, sz = sx, pitch = 0, roll = 0) {
  _e.set(pitch, yaw, roll, 'YXZ'); _q.setFromEuler(_e); _p.set(x, y, z); _s.set(sx, sy, sz);
  return _m.compose(_p, _q, _s);
}
const col = hex => new THREE.Color(hex);
const hdr = (hex, k) => new THREE.Color(hex).multiplyScalar(k);

export function createView(game) {
  const world = game.world, camera = world.camera;
  const root = new THREE.Group(); root.name = 'view';
  world.addToScene(root);
  const S = () => game.state;

  // ------------------------------------------------------------ model helpers
  const warned = new Set();
  const has = name => { if (lib[name]) return true; if (!warned.has(name)) { warned.add(name); console.warn('[view] missing model', name); } return false; };
  const topOf = name => lib[name]?.top ?? lib[name]?.size?.y ?? 1;
  const optsFor = name => (FOLIAGE.test(name) ? { foliage: true } : undefined);

  // pooled one-off meshes (pops, flights, falls, crows, signs, highlights)
  const pool = new Map();
  function getTemp(name, opts) {
    if (!has(name)) return null;
    const a = pool.get(name);
    const g = (a && a.pop()) || makeMesh(name, opts || optsFor(name));
    g.userData.tname = name;
    g.position.set(0, 0, 0); g.rotation.set(0, 0, 0); g.scale.set(1, 1, 1); g.visible = true;
    root.add(g);
    return g;
  }
  function putTemp(g) {
    if (!g) return;
    root.remove(g);
    const n = g.userData.tname;
    if (!pool.has(n)) pool.set(n, []);
    pool.get(n).push(g);
  }

  // ------------------------------------------------------------ instanced managers (slot allocation)
  class Inst {
    constructor(name) {
      this.name = name; this.opts = optsFor(name);
      this.cap = 0; this.hi = 0; this.free = []; this.m = null; this.c = null; this.g = null; this.dirty = false;
      this.grow(64);
    }
    grow(cap) {
      const m = new Float32Array(cap * 16), c = new Float32Array(cap * 3).fill(1);
      if (this.m) { m.set(this.m); c.set(this.c); }
      this.m = m; this.c = c; this.cap = cap;
      if (this.g) { root.remove(this.g); this.g.traverse(o => o.isInstancedMesh && o.dispose()); }
      this.g = makeInstanced(this.name, cap, this.opts);
      root.add(this.g);
      for (let k = 0; k < this.hi; k++) this.write(k);
      this.g.count(this.hi);
      this.dirty = true;
    }
    write(k) { _w.fromArray(this.c, k * 3); this.g.setAt(k, _mw.fromArray(this.m, k * 16), _cw.setRGB(_w.x, _w.y, _w.z)); }
    add(matrix, color) {
      let k;
      if (this.free.length) k = this.free.pop();
      else { k = this.hi++; if (k >= this.cap) this.grow(this.cap * 2); this.g.count(this.hi); }
      (color || WHITE).toArray(this.c, k * 3);
      this.set(k, matrix);
      return k;
    }
    set(k, matrix, color) {
      matrix.toArray(this.m, k * 16);
      if (color) color.toArray(this.c, k * 3);
      this.write(k); this.dirty = true;
    }
    remove(k) { HIDE.toArray(this.m, k * 16); this.write(k); this.free.push(k); this.dirty = true; }
    reset() { this.hi = 0; this.free.length = 0; this.g.count(0); this.dirty = true; }
    flush() {
      if (!this.dirty) return;
      this.dirty = false;
      const ch = this.g.children;
      for (let n = 0; n < ch.length; n++) {
        const o = ch[n];
        if (!o.isInstancedMesh) continue;
        o.instanceMatrix.needsUpdate = true;
        if (o.instanceColor) o.instanceColor.needsUpdate = true;
        o.boundingSphere = null; o.boundingBox = null;        // recomputed lazily for culling
      }
    }
  }
  const _mw = new THREE.Matrix4(), _cw = new THREE.Color();
  const insts = new Map(), instList = [];
  function inst(name) {
    let I = insts.get(name);
    if (!I) { if (!has(name)) return null; I = new Inst(name); insts.set(name, I); instList.push(I); }
    return I;
  }

  // ------------------------------------------------------------ pick proxies
  const pickables = new THREE.Group(); pickables.name = 'pickables';   // not in the scene; matrices kept by hand
  const proxyGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const proxyMat = new THREE.MeshBasicMaterial({ visible: false });
  function proxy(pick, w, h, d) {
    const m = new THREE.Mesh(proxyGeo, proxyMat);
    m.scale.set(Math.max(0.3, w), Math.max(0.2, h), Math.max(0.3, d));
    m.userData.pick = pick;
    pickables.add(m);
    return m;
  }
  function placeProxy(m, x, y, z, yaw = 0) { m.position.set(x, y, z); m.rotation.y = yaw; m.updateMatrixWorld(); }
  const dropProxy = m => m && pickables.remove(m);

  // ------------------------------------------------------------ particles: one pooled Points system
  const PMAX = 4000;
  const pPos = new Float32Array(PMAX * 3), pCol = new Float32Array(PMAX * 3), pA = new Float32Array(PMAX), pSz = new Float32Array(PMAX);
  const pV = new Float32Array(PMAX * 3), pLife = new Float32Array(PMAX), pMax = new Float32Array(PMAX), pG = new Float32Array(PMAX);
  const pDrag = new Float32Array(PMAX), pS0 = new Float32Array(PMAX), pS1 = new Float32Array(PMAX), pA0 = new Float32Array(PMAX), pWind = new Float32Array(PMAX);
  let pN = 0;
  const pGeo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage);
  const aCol = new THREE.BufferAttribute(pCol, 3).setUsage(THREE.DynamicDrawUsage);
  const aAl = new THREE.BufferAttribute(pA, 1).setUsage(THREE.DynamicDrawUsage);
  const aSz = new THREE.BufferAttribute(pSz, 1).setUsage(THREE.DynamicDrawUsage);
  pGeo.setAttribute('position', aPos); pGeo.setAttribute('aColor', aCol); pGeo.setAttribute('aAlpha', aAl); pGeo.setAttribute('aSize', aSz);
  pGeo.setDrawRange(0, 0);
  const pMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 600 } }]),
    vertexShader: /* glsl */`
      attribute vec3 aColor; attribute float aAlpha; attribute float aSize;
      uniform float uScale; varying vec3 vC; varying float vA;
      #include <fog_pars_vertex>
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uScale / max(0.05, -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
        vC = aColor; vA = aAlpha;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vC; varying float vA;
      #include <fog_pars_fragment>
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.45, r) * vA;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vC, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
    transparent: true, depthWrite: false, fog: true,
  });
  const points = new THREE.Points(pGeo, pMat);
  points.frustumCulled = false; points.renderOrder = 5;
  root.add(points);

  function emit(x, y, z, vx, vy, vz, c, k, s0, s1, life, g, drag, a0, wind) {
    if (pN >= PMAX) return;
    const i = pN++, i3 = i * 3;
    pPos[i3] = x; pPos[i3 + 1] = y; pPos[i3 + 2] = z;
    pV[i3] = vx; pV[i3 + 1] = vy; pV[i3 + 2] = vz;
    pCol[i3] = c.r * k; pCol[i3 + 1] = c.g * k; pCol[i3 + 2] = c.b * k;
    pLife[i] = pMax[i] = life; pG[i] = g; pDrag[i] = drag; pS0[i] = s0; pS1[i] = s1; pA0[i] = a0; pWind[i] = wind;
    pSz[i] = s0; pA[i] = 0;
  }
  function pMove(f, t) {
    const f3 = f * 3, t3 = t * 3;
    for (let n = 0; n < 3; n++) { pPos[t3 + n] = pPos[f3 + n]; pV[t3 + n] = pV[f3 + n]; pCol[t3 + n] = pCol[f3 + n]; }
    pLife[t] = pLife[f]; pMax[t] = pMax[f]; pG[t] = pG[f]; pDrag[t] = pDrag[f]; pS0[t] = pS0[f]; pS1[t] = pS1[f];
    pA0[t] = pA0[f]; pWind[t] = pWind[f]; pSz[t] = pSz[f]; pA[t] = pA[f];
  }
  function stepParticles(dt) {
    const wind = uniforms?.uWind?.value ?? 0.3, wd = uniforms?.uWindDir?.value;
    const wx = (wd ? wd.x : 1) * wind * 1.6, wz = (wd ? wd.y : 0) * wind * 1.6;
    for (let i = 0; i < pN;) {
      const life = (pLife[i] -= dt);
      if (life <= 0) { pN--; if (i !== pN) pMove(pN, i); continue; }
      const i3 = i * 3, dr = Math.exp(-pDrag[i] * dt), wf = pWind[i] * dt;
      pV[i3] = pV[i3] * dr + wx * wf; pV[i3 + 1] = pV[i3 + 1] * dr - pG[i] * dt; pV[i3 + 2] = pV[i3 + 2] * dr + wz * wf;
      pPos[i3] += pV[i3] * dt; pPos[i3 + 1] += pV[i3 + 1] * dt; pPos[i3 + 2] += pV[i3 + 2] * dt;
      const t = 1 - life / pMax[i];
      pSz[i] = pS0[i] + (pS1[i] - pS0[i]) * t;
      pA[i] = pA0[i] * Math.min(1, t * 8) * Math.min(1, (1 - t) * 2.5);
      i++;
    }
    pGeo.setDrawRange(0, pN);
    for (const a of PATTR) { a.clearUpdateRanges(); a.addUpdateRange(0, pN * a.itemSize); a.needsUpdate = true; }
    const h = world.renderer?.domElement?.height || innerHeight;
    pMat.uniforms.uScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  }
  const PATTR = [aPos, aCol, aAl, aSz];

  // particle kinds: c colours, s size range, e end-size factor, l life, up/out speeds, g gravity, d drag, a alpha, w wind, k brightness
  const K = {
    dirt: { c: [col('#6b4a2f'), col('#8f6842')], s: [0.1, 0.2], e: 0.5, l: [0.5, 0.9], up: [1.6, 3.2], out: [0.6, 1.8], g: 9, d: 1.2, a: 1, w: 0 },
    dust: { c: [col('#d8c7a0'), col('#c4b28a')], s: [0.35, 0.6], e: 2.4, l: [0.8, 1.3], up: [0.2, 0.8], out: [0.8, 2.0], g: -0.15, d: 2.4, a: 0.45, w: 0.4 },
    splash: { c: [col('#9fd8f0'), col('#e8f8ff')], s: [0.07, 0.14], e: 0.6, l: [0.45, 0.7], up: [2.0, 3.6], out: [0.5, 1.6], g: 9.8, d: 0.6, a: 0.9, w: 0 },
    seed: { c: [col('#e9d39a'), col('#b98b4f')], s: [0.05, 0.08], e: 1, l: [0.5, 0.7], up: [-0.5, 0.4], out: [0.2, 0.7], g: 6, d: 0.5, a: 1, w: 0 },
    sparkle: { c: [hdr('#ffe08a', 2.6), hdr('#fff3c4', 2.2)], s: [0.1, 0.18], e: 0, l: [0.6, 1.1], up: [0.6, 1.8], out: [0.3, 1.0], g: -0.4, d: 1.5, a: 1, w: 0 },
    green: { c: [hdr('#9ff07a', 2.2), hdr('#d8ff9a', 1.8)], s: [0.08, 0.15], e: 0, l: [0.6, 1.0], up: [0.6, 1.6], out: [0.2, 0.8], g: -0.6, d: 1.5, a: 1, w: 0 },
    coin: { c: [hdr('#f2c94c', 1.8), hdr('#ffe28a', 1.6)], s: [0.13, 0.18], e: 0.8, l: [0.7, 1.0], up: [3.0, 4.6], out: [0.8, 1.8], g: 9.8, d: 0.4, a: 1, w: 0 },
    wood: { c: [col('#a0703f'), col('#d9b07a')], s: [0.07, 0.13], e: 0.8, l: [0.5, 0.8], up: [1.8, 3.2], out: [1.0, 2.4], g: 10, d: 0.6, a: 1, w: 0 },
    stone: { c: [col('#8f8f8f'), col('#c2c2c2')], s: [0.07, 0.13], e: 0.8, l: [0.5, 0.8], up: [1.8, 3.2], out: [1.0, 2.4], g: 10, d: 0.6, a: 1, w: 0 },
    leaf: { c: [col('#4f9a3a'), col('#7cc152')], s: [0.1, 0.16], e: 0.8, l: [1.2, 1.9], up: [0.8, 2.0], out: [0.6, 1.6], g: 1.2, d: 2.2, a: 1, w: 1 },
    smoke: { c: [col('#a8a8a8'), col('#c8c8c8')], s: [0.45, 0.7], e: 2.8, l: [1.8, 2.6], up: [0.6, 1.1], out: [0.05, 0.25], g: -0.25, d: 0.6, a: 0.32, w: 0.8 },
    dark: { c: [col('#2a2a2a'), col('#3b3634')], s: [0.5, 0.8], e: 3.0, l: [2.0, 2.8], up: [0.7, 1.2], out: [0.05, 0.25], g: -0.3, d: 0.6, a: 0.5, w: 0.8 },
    steam: { c: [col('#f4f4f4'), col('#ffffff')], s: [0.35, 0.55], e: 2.6, l: [1.0, 1.6], up: [1.0, 1.6], out: [0.1, 0.4], g: -0.3, d: 1.0, a: 0.4, w: 0.6 },
    ember: { c: [hdr('#ff9a3a', 3.0), hdr('#ffcf6a', 2.4)], s: [0.04, 0.08], e: 0.3, l: [0.6, 1.1], up: [1.4, 2.6], out: [0.1, 0.5], g: -0.6, d: 0.8, a: 1, w: 0.5 },
    feather: { c: [col('#22222a'), col('#3a3a44')], s: [0.08, 0.12], e: 1, l: [1.2, 1.8], up: [0.6, 1.6], out: [0.6, 1.4], g: 1.0, d: 2.5, a: 1, w: 1 },
    heart: { c: [hdr('#ff6b8b', 2.2), hdr('#ffa3b8', 1.8)], s: [0.12, 0.2], e: 0.2, l: [0.9, 1.4], up: [0.9, 1.6], out: [0.2, 0.6], g: -0.5, d: 1.8, a: 1, w: 0 },
    acid: { c: [hdr('#9be84a', 1.6), col('#d6ff7a')], s: [0.08, 0.14], e: 0.2, l: [0.5, 0.9], up: [0.6, 1.4], out: [0.2, 0.7], g: -0.5, d: 1.5, a: 0.9, w: 0.3 },
  };
  function burst(kind, x, y, z, n, spread = 0.3) {
    const k = K[kind];
    for (let q = 0; q < n; q++) {
      const a = Math.random() * TAU, out = rnd(k.out[0], k.out[1]), s0 = rnd(k.s[0], k.s[1]);
      emit(x + (Math.random() - 0.5) * spread * 2, y + Math.random() * 0.1, z + (Math.random() - 0.5) * spread * 2,
        Math.cos(a) * out, rnd(k.up[0], k.up[1]), Math.sin(a) * out,
        k.c[(Math.random() * k.c.length) | 0], rnd(0.85, 1.15), s0, s0 * k.e, rnd(k.l[0], k.l[1]), k.g, k.d, k.a, k.w);
    }
  }
  const SPRAY = col('#cdeefc');

  // ------------------------------------------------------------ floating text sprites
  const texts = [];
  function makeLabelSprite(w, h) {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    sp.renderOrder = 999;
    return { sp, cv, ctx: cv.getContext('2d'), tex };
  }
  function drawLabel(L, str, color, px) {
    const { ctx, cv } = L;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.font = `600 ${px}px Fredoka, Nunito, system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.lineWidth = px * 0.2; ctx.strokeStyle = 'rgba(40,28,20,0.85)';
    ctx.strokeText(str, cv.width / 2, cv.height / 2);
    ctx.fillStyle = color; ctx.fillText(str, cv.width / 2, cv.height / 2);
    L.tex.needsUpdate = true;
  }
  function floatText(str, color, x, y, z) {
    let T = texts.find(t => !t.on);
    if (!T && texts.length < 24) { T = makeLabelSprite(512, 96); texts.push(T); root.add(T.sp); }
    if (!T) T = texts.reduce((a, b) => (a.t > b.t ? a : b));
    drawLabel(T, str, color, 56);
    T.on = true; T.t = 0; T.x = x; T.y = y + rnd(0, 0.25); T.z = z; T.sp.visible = true;
  }
  function stepTexts(dt) {
    for (let n = 0; n < texts.length; n++) {
      const T = texts[n];
      if (!T.on) continue;
      T.t += dt;
      const f = T.t / 1.5;
      if (f >= 1) { T.on = false; T.sp.visible = false; continue; }
      const pop = f < 0.15 ? easeOutBack(f / 0.15) : 1;
      T.sp.position.set(T.x, T.y + (1 - Math.pow(1 - f, 2)) * 1.3, T.z);
      T.sp.scale.set(2.2 * pop, 0.41 * pop, 1);
      T.sp.material.opacity = f > 0.6 ? 1 - (f - 0.6) / 0.4 : 1;
    }
  }

  // ------------------------------------------------------------ tiles
  const R = Array.from({ length: N }, () => ({ slots: [], obs: null, crop: null, stage: -1, wet: 0, proxy: null, pick: null, fire: null, obsName: null, obsPrev: null }));
  const cropTiles = new Set();
  function put(rec, name, x, y, z, yaw, s, color) {
    const I = inst(name);
    if (!I) return null;
    const r = { I, slot: I.add(compose(x, y, z, yaw, s), color), name, x, y, z, yaw, s, sy: s };
    rec.slots.push(r);
    return r;
  }
  function releaseTile(rec, k) {
    for (const r of rec.slots) r.I.remove(r.slot);
    rec.slots.length = 0; rec.obs = null; rec.crop = null;
    if (rec.fire) { removeFire(rec.fire); rec.fire = null; }
    cropTiles.delete(k);
  }
  const tileTop = (t, h) => (t && t.t === 's' && !t.b ? h + (t.rb ? RAISED : 0) + SOIL_TOP : h);
  function tilePos(i, j) {                                    // -> _fp at the tile's surface
    const x = tileX(i), z = tileZ(j), t = S().tiles[j * GRID + i];
    return _fp.set(x, tileTop(t, heightAt(x, z)), z);
  }
  function obsModel(o) {
    if (o.k === 'palm' || o.k === 'jungle') return OBS_TREE[o.k][o.v % 3];
    if (o.k === 'rock') return ROCKS[o.v % 3];
    if (o.k === 'stump') return o.from === 'palm' ? 'stump_palm' : 'stump_tree';
    return 'bush_a';
  }

  // fillers between neighbouring soil tiles, owned by the tile to the west / north of the gap
  const J = Array.from({ length: N }, () => ({ slots: [] }));
  const plainSoil = t => t && t.t === 's' && !t.b && !t.rb;
  function rebuildJoins(k) {
    if (k < 0 || k >= N) return;
    const rec = J[k];
    for (const r of rec.slots) r.I.remove(r.slot);
    rec.slots.length = 0;
    const tiles = S().tiles, i = k % GRID, j = (k / GRID) | 0, t = tiles[k];
    if (!plainSoil(t)) return;
    const top = (ii, jj) => heightAt(tileX(ii), tileZ(jj)) + 0.002;
    const join = (ks, kind, x, z, y) => {
      const ts = ks.map(q => tiles[q]);
      y = Math.max(y, heightAt(x, z));                     // never sink below the ground between the two tiles
      put(rec, (ts.every(q => q.f) ? 'soil_fjoin_' : 'soil_join_') + kind, x, y, z, PI / 2, 1, ts.every(q => q.wet) ? WETC : WHITE);
    };
    const e = i + 1 < GRID && plainSoil(tiles[k + 1]), so = j + 1 < GRID && plainSoil(tiles[k + GRID]);
    if (e) join([k, k + 1], 'side', tileX(i) + TILE / 2, tileZ(j), (top(i, j) + top(i + 1, j)) / 2);
    if (so) join([k, k + GRID], 'row', tileX(i), tileZ(j) + TILE / 2, (top(i, j) + top(i, j + 1)) / 2);
    if (e && so && plainSoil(tiles[k + GRID + 1]))
      join([k, k + 1, k + GRID, k + GRID + 1], 'corner', tileX(i) + TILE / 2, tileZ(j) + TILE / 2,
        (top(i, j) + top(i + 1, j) + top(i, j + 1) + top(i + 1, j + 1)) / 4);
  }
  function rebuildTile(k, quiet) {
    const s = S(), t = s.tiles[k], rec = R[k];
    if (!t) return;
    const i0 = k % GRID;
    rebuildJoins(k); if (i0 > 0) rebuildJoins(k - 1);
    if (k >= GRID) { rebuildJoins(k - GRID); if (i0 > 0) rebuildJoins(k - GRID - 1); }
    releaseTile(rec, k);
    game.world.setSoil?.(k, t.t === 's' && !t.b);
    const i = k % GRID, j = (k / GRID) | 0, x = tileX(i), z = tileZ(j), h = heightAt(x, z);
    let top = h;
    if (t.t === 's' && !t.b) {
      if (t.rb) { put(rec, 'raised_bed', x, h, z, 0, 1); top = h + RAISED; }
      put(rec, t.f ? 'soil_fertile' : 'soil_tile', x, top, z, PI / 2, 1, t.wet ? WETC : WHITE);   // every tile the same way: rows run north-south, away from the beach
      top += SOIL_TOP;
      if (t.wet && !rec.wet && !quiet) sprinklerBurstNear(i, j);
    }
    rec.wet = t.wet;
    if (t.c) {
      const C = CROPS[t.c.id], st = stageOf(t.c, game.now());
      const name = (C.tree ? 'tree_' : 'crop_') + t.c.id + '_' + st;
      const jx = C.tree ? 0 : (hash(k, 4) - 0.5) * 0.2, jz = C.tree ? 0 : (hash(k, 5) - 0.5) * 0.2;
      rec.crop = put(rec, name, x + jx, top, z + jz, hash(k, 1) * TAU, (C.tree ? 0.95 : 0.9) + hash(k, 2) * 0.15);
      rec.stage = st;
      cropTiles.add(k);
    } else rec.stage = -1;
    const on = t.o ? obsModel(t.o) : null;
    if (on !== rec.obsName) { rec.obsPrev = rec.obsName; rec.obsName = on; }
    if (t.o) {
      rec.obs = put(rec, on, x + (hash(k, 6) - 0.5) * 0.3, h - 0.02, z + (hash(k, 7) - 0.5) * 0.3, hash(k, 8) * TAU, 0.85 + hash(k, 9) * 0.3);
      if (!rec.proxy) { rec.pick = { kind: 'obstacle', i, j }; rec.proxy = proxy(rec.pick, 1, 1, 1); }
      else if (!rec.proxy.parent) pickables.add(rec.proxy);
      const tree = t.o.k === 'palm' || t.o.k === 'jungle', sz = lib[on]?.size;
      if (tree) rec.proxy.scale.set(1.1, 3.6, 1.1);
      else rec.proxy.scale.set(clamp(sz?.x ?? 1, 0.6, 1.9), clamp(sz?.y ?? 0.8, 0.4, 2.2), clamp(sz?.z ?? 1, 0.6, 1.9));
      placeProxy(rec.proxy, x, h - 0.05, z, 0);
    } else {
      if (rec.proxy) pickables.remove(rec.proxy);
      if (t.t === 'g' && !t.b && h > 0.95) {   // no tufts on the beach rows
        const n = 3 + ((hash(k, 10) * 4) | 0);
        for (let q = 0; q < n; q++) {
          const gx = x + (hash(k, 11 + q * 4) - 0.5) * 1.8, gz = z + (hash(k, 12 + q * 4) - 0.5) * 1.8;
          put(rec, hash(k, 40 + q) < 0.08 ? 'flower_' + 'abc'[q % 3] : 'grass_tuft', gx, heightAt(gx, gz) - 0.02, gz, hash(k, 13 + q * 4) * TAU, 0.7 + hash(k, 14 + q * 4) * 0.6);
        }
      }
    }
    if (t.fire) rec.fire = addFire(x, top, z, 0.8);
  }

  // re-check time-based crop stages (no dirty marks for growth)
  const ripeNear = [];
  function checkStages() {
    const s = S(), now = game.now();
    ripeNear.length = 0;
    for (const k of cropTiles) {
      const t = s.tiles[k], rec = R[k];
      if (!t.c) continue;
      const st = stageOf(t.c, now);
      if (st !== rec.stage) {
        rebuildTile(k, true);
        addTileAnim(k, 'grow', 0.4);
        const near = rec.crop && _cam.distanceToSquared(_v.set(rec.crop.x, rec.crop.y, rec.crop.z)) < 900;
        if (near) burst(st === 3 ? 'sparkle' : 'green', rec.crop.x, rec.crop.y + 0.3, rec.crop.z, st === 3 ? 8 : 4, 0.4);
      }
      if (st === 3 && rec.crop && ripeNear.length < 64 && _cam.distanceToSquared(_v.set(rec.crop.x, rec.crop.y, rec.crop.z)) < 400) ripeNear.push(k);
    }
  }

  // tile instance animations: plant pop, growth bounce, obstacle shake, regrow pop
  const tileAnims = [];
  function addTileAnim(k, type, dur) { tileAnims.push({ k, type, t: 0, dur }); }
  function stepTileAnims(dt) {
    for (let n = tileAnims.length - 1; n >= 0; n--) {
      const A = tileAnims[n], rec = R[A.k];
      A.t += dt;
      const f = Math.min(1, A.t / A.dur), r = A.type === 'shake' || A.type === 'opop' ? rec.obs : rec.crop;
      if (r) {
        let sx = 1, sy = 1, pitch = 0, roll = 0;
        if (A.type === 'pop' || A.type === 'opop') sx = sy = Math.max(0.01, easeOutBack(f));
        else if (A.type === 'grow') { sx = 1 + Math.sin(f * PI) * 0.12; sy = 1 + Math.sin(f * PI) * 0.22; }
        else if (A.type === 'shake') { const a = (1 - f) * 0.13; pitch = Math.sin(A.t * 47) * a; roll = Math.cos(A.t * 39) * a; }
        r.I.set(r.slot, compose(r.x, r.y, r.z, r.yaw, r.s * sx, r.s * sy, r.s * sx, pitch, roll));
        if (hl.src === r && hl.obj) hl.obj.matrix.copy(_m);
      }
      if (f >= 1) { tileAnims[n] = tileAnims[tileAnims.length - 1]; tileAnims.pop(); }
    }
  }

  // ------------------------------------------------------------ fires + pooled flicker lights (max 4)
  const fireList = [], lights = [];
  for (let n = 0; n < 4; n++) {
    const L = new THREE.PointLight(0xff8a3a, 0, 10, 2);
    L.castShadow = false; root.add(L); lights.push(L);
  }
  function addFire(x, y, z, s) {
    const g = getTemp('fire');
    if (g) { g.position.set(x, y, z); g.scale.setScalar(s); }
    const F = { g, x, y, z, s, ph: Math.random() * 10, light: -1, emberT: 0 };
    fireList.push(F);
    return F;
  }
  function removeFire(F) {
    putTemp(F.g);
    const n = fireList.indexOf(F);
    if (n >= 0) { fireList[n] = fireList[fireList.length - 1]; fireList.pop(); }
  }
  let lightT = 0;
  function stepFires(dt, time) {
    lightT -= dt;
    if (lightT <= 0) {                                         // give the 4 lights to the fires nearest the camera
      lightT = 0.3;
      for (const F of fireList) F.light = -1;
      for (let n = 0; n < 4; n++) {
        let best = null, bd = Infinity;
        for (const F of fireList) {
          if (F.light >= 0) continue;
          const d = (F.x - _cam.x) ** 2 + (F.z - _cam.z) ** 2;
          if (d < bd) { bd = d; best = F; }
        }
        if (best) best.light = n;
        else lights[n].intensity = 0;
      }
    }
    for (const F of fireList) {
      const fl = 0.85 + 0.1 * Math.sin(time * 13 + F.ph) + 0.06 * Math.sin(time * 31 + F.ph * 2);
      if (F.g) { F.g.scale.set(F.s * (0.95 + 0.05 * Math.sin(time * 9 + F.ph)), F.s * fl * 1.05, F.s); F.g.rotation.y += dt * 0.8; }
      if (F.light >= 0) { const L = lights[F.light]; L.position.set(F.x, F.y + 0.9 * F.s, F.z); L.intensity = 18 * F.s * fl; }
      F.emberT -= dt;
      if (F.emberT <= 0) {
        F.emberT = 0.12;
        burst('ember', F.x, F.y + 0.5 * F.s, F.z, 2, 0.25 * F.s);
        if (Math.random() < 0.5) burst('dark', F.x, F.y + 1.0 * F.s, F.z, 1, 0.2);
      }
    }
  }

  // ------------------------------------------------------------ buildings
  const B = new Map(), BL = [];
  const modelFor = type => (type === 'farmhouse' ? 'farmhouse_' + clamp(S().fh || 1, 1, 5) : BUILDINGS[type]?.model);
  function placeY(type, i, j, rot) {
    const [w, h] = sizeOf(type, rot);
    if (type === 'bridge') {
      const z = tileZ(j) + (h - 1) * TILE / 2;
      return (heightAt(tileX(i) - TILE, z) + heightAt(tileX(i + w - 1) + TILE, z)) / 2;
    }
    let y = Infinity;
    for (let dj = 0; dj < h; dj++) for (let di = 0; di < w; di++) y = Math.min(y, heightAt(tileX(i + di), tileZ(j + dj)));
    return y;
  }
  const yawFor = (type, rot) => rot * PI / 2 + (type === 'bridge' ? PI / 2 : 0);

  function removeEntry(e) {
    root.remove(e.g);
    dropProxy(e.proxy);
    if (e.head) e.head.I.remove(e.head.slot);
    if (e.fire) removeFire(e.fire);
    if (e.rover) { root.remove(e.rover.g); for (const q of e.rover.q) q.done = true; }
    B.delete(e.id);
    const n = BL.indexOf(e);
    if (n >= 0) { BL[n] = BL[BL.length - 1]; BL.pop(); }
  }
  function rebuildBuilding(id, quiet) {
    const b = S().buildings[id], e = B.get(id);
    if (!b) {
      if (e) { if (!quiet) burst('dust', e.x, e.y + 0.2, e.z, 14 + e.w * 6, e.w * 0.6); removeEntry(e); }
      return;
    }
    const model = modelFor(b.type);
    const sig = `${b.type}|${b.i}|${b.j}|${b.rot}|${model}`;
    if (e && e.sig === sig) return;
    const upgraded = e && e.type === b.type;
    if (e) removeEntry(e);
    const [cx, cz] = centerOf(b), y = placeY(b.type, b.i, b.j, b.rot), yaw = yawFor(b.type, b.rot);
    const [w, hh] = sizeOf(b.type, b.rot);
    const g = has(model) ? makeMesh(model) : new THREE.Group();
    g.position.set(cx, y, cz); g.rotation.y = yaw; g.userData.bid = id;
    root.add(g);
    const sz = lib[model]?.size, top = topOf(model), flat = BUILDINGS[b.type].walk;
    const n = {
      id, type: b.type, sig, g, x: cx, y, z: cz, yaw, top, w: Math.max(w, hh), pop: quiet ? 1 : 0, pulse: -1,
      proxy: proxy({ kind: 'building', id }, sz ? sz.x : w * TILE * 0.9, flat ? 0.3 : top, sz ? sz.z : hh * TILE * 0.9),
      head: null, spin: Math.random() * TAU, spray: 0, burst: 0, soilNear: false, soilT: 0, smokeT: 0, puffT: 0, fire: null, rover: null,
    };
    placeProxy(n.proxy, cx, y, cz, yaw);
    if (b.type.startsWith('sprinkler')) {
      const I = inst(model + '_head');
      if (I) n.head = { I, slot: I.add(compose(cx, y + topOf(model), cz, n.spin, 1)) };
    }
    if (b.type === 'harvester_bot' && has('harvester_bot')) {
      const rg = makeMesh('harvester_bot');
      root.add(rg);
      n.rover = { g: rg, x: cx, z: cz, y: y + 0.1, yaw, mode: 0, q: [], t: 0, cur: null, ph: Math.random() * 10 };
      rg.position.set(cx, y + 0.1, cz); rg.rotation.y = yaw;
    }
    B.set(id, n); BL.push(n);
    if (!quiet) {
      burst('dust', cx, y + 0.1, cz, 10 + n.w * 6, n.w * 0.7);
      if (upgraded) burst('sparkle', cx, y + top * 0.6, cz, 30, n.w * 0.8);
    }
  }
  function sprinklerBurstNear(i, j) {
    for (const e of BL) {
      if (!e.head) continue;
      const b = S().buildings[e.id], r = BUILDINGS[e.type].range;
      if (b && Math.abs(b.i - i) <= r && Math.abs(b.j - j) <= r) e.burst = 1.6;
    }
  }
  function factoryRunning(b, now) {
    const job = b.d?.job;
    if (!job) return false;
    const rc = RECIPES[b.type]?.[job.r];
    return !!rc && Math.floor((now - job.start) / (rc.time * 1000)) < job.n;
  }

  function stepBuildings(dt, now, time) {
    const s = S();
    for (let n = 0; n < BL.length; n++) {
      const e = BL[n], b = s.buildings[e.id];
      if (!b) continue;
      const off = b.off > now, working = !off && !b.fire;
      const near = (e.x - _cam.x) ** 2 + (e.z - _cam.z) ** 2 < 3600;
      if (b.fire && !e.fire) e.fire = addFire(e.x, e.y + Math.min(e.top * 0.55, 3), e.z, 0.9 + 0.35 * (e.w - 1));
      else if (!b.fire && e.fire) { removeFire(e.fire); e.fire = null; }
      if (e.pop < 1) {
        e.pop = Math.min(1, e.pop + dt / 0.4);
        const k = Math.max(0.01, easeOutBack(e.pop));
        e.g.scale.set(k, k, k);
      }
      if (e.pulse >= 0) {
        e.pulse += dt;
        const f = e.pulse / 0.6, k = 1 + Math.sin(Math.min(1, f) * PI) * 0.07;
        e.g.scale.set(k, k, k);
        if (f >= 1) { e.pulse = -1; e.g.scale.set(1, 1, 1); }
      }
      if (e.head) {
        if (working) e.spin += dt * (e.burst > 0 ? 7 : 3.2);
        e.burst = Math.max(0, e.burst - dt);
        e.head.I.set(e.head.slot, compose(e.x, e.y + topOf(BUILDINGS[e.type].model), e.z, e.spin, 1));
        e.soilT -= dt;
        if (e.soilT <= 0) {
          e.soilT = 2;
          const r = BUILDINGS[e.type].range;
          e.soilNear = false;
          for (let j = b.j - r; j <= b.j + r && !e.soilNear; j++)
            for (let i = b.i - r; i <= b.i + r; i++) if (i >= 0 && j >= 0 && i < GRID && j < GRID && s.tiles[j * GRID + i].t === 's') { e.soilNear = true; break; }
        }
        if (working && near && e.soilNear) {
          e.spray += dt * (e.burst > 0 ? 70 : 26);
          const r = BUILDINGS[e.type].range, hy = e.y + topOf(BUILDINGS[e.type].model) + 0.06, arm = e.type === 'sprinkler_big' ? 0.52 : 0.35;
          const vh = (r * TILE + 0.6) / 0.6;
          while (e.spray >= 1) {
            e.spray -= 1;
            const side = Math.random() < 0.5 ? 1 : -1, a = e.spin + rnd(-0.15, 0.15);
            const cx = Math.cos(a) * side, cz = -Math.sin(a) * side;   // head bar runs along local X
            const v = vh * rnd(0.55, 1.05);
            emit(e.x + cx * arm, hy, e.z + cz * arm, cx * v - cz * 1.2 * side, rnd(2.2, 3.0), cz * v + cx * 1.2 * side,
              SPRAY, rnd(0.9, 1.2), rnd(0.04, 0.07), 0.03, rnd(0.55, 0.75), 9.8, 0.4, 0.75, 0.2);
          }
        }
      }
      if (off && near) {
        e.smokeT -= dt;
        if (e.smokeT <= 0) { e.smokeT = 0.22; burst('dark', e.x, e.y + e.top * 0.85, e.z, 1, e.w * 0.4); }
      }
      if (BUILDINGS[e.type].factory && near && working && factoryRunning(b, now)) {
        e.puffT -= dt;
        if (e.puffT <= 0) { e.puffT = 0.45; burst(e.type === 'juicer' ? 'steam' : 'smoke', e.x + rnd(-0.3, 0.3), e.y + e.top * 0.95, e.z + rnd(-0.3, 0.3), 1, 0.2); }
      }
      if (e.rover) stepRover(e, dt, time);
    }
  }

  // harvester rover: drive to the tile, pause (harvest pop), return to the dock
  function stepRover(e, dt, time) {
    const r = e.rover;
    let tx = e.x, tz = e.z;
    if (r.mode === 0 && r.q.length) { r.cur = r.q.shift(); r.mode = 1; }
    if (r.mode === 1 || r.mode === 2) { tx = tileX(r.cur.i); tz = tileZ(r.cur.j) - 0.9; }
    const dx = tx - r.x, dz = tz - r.z, d = Math.hypot(dx, dz);
    if (r.mode === 1 || r.mode === 3) {
      if (d < 0.12) {
        if (r.mode === 1) { r.mode = 2; r.t = 0.9; harvestPop(r.cur.k, r.cur.id, r.cur.gold, e); }
        else { r.mode = 0; r.yaw = dampAngle(r.yaw, e.yaw, 4, dt); }
      } else {
        const step = Math.min(d, dt * 4.2);
        r.x += dx / d * step; r.z += dz / d * step;
        r.yaw = dampAngle(r.yaw, Math.atan2(dx, dz), 10, dt);
        if (Math.random() < dt * 8) burst('dust', r.x, heightAt(r.x, r.z) + 0.05, r.z, 1, 0.3);
      }
    } else if (r.mode === 2) {
      r.t -= dt;
      if (r.t <= 0) r.mode = r.q.length ? 0 : 3;
    } else r.yaw = dampAngle(r.yaw, e.yaw, 4, dt);
    const onDock = (r.x - e.x) ** 2 + (r.z - e.z) ** 2 < 0.8;
    const gy = onDock ? e.y + 0.1 : heightAt(r.x, r.z);
    r.y = damp(r.y, gy, 12, dt);
    const moving = r.mode === 1 || r.mode === 3;
    r.g.position.set(r.x, r.y + (moving ? Math.abs(Math.sin(time * 18 + r.ph)) * 0.025 : 0), r.z);
    r.g.rotation.set(moving ? 0.03 : 0, r.yaw, 0);
  }

  // ------------------------------------------------------------ plots: rope line + for-sale signs
  const ropeMat = new THREE.MeshToonMaterial({ vertexColors: true, side: THREE.DoubleSide });
  let rope = null, plotKey = '';
  const signs = [];
  const ownedP = (s, px, py) => px >= 0 && py >= 0 && px < PLOTS && py < PLOTS && !!s.plots[py * PLOTS + px];
  function rebuildPlots() {
    const s = S();
    const pos = [], cols = [];
    const cRope = col('#c8a46a'), cPost = col('#6b4a2f');
    const gy = (x, z) => Math.max(heightAt(x, z), world.waterLevel ? world.waterLevel() : 0);
    const quad = (a, b, c, d, cc) => {
      for (const p of [a, b, c, a, c, d]) { pos.push(p.x, p.y, p.z); cols.push(cc.r, cc.g, cc.b); }
    };
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const post = (x, z) => {
      const y = gy(x, z) - 0.05, hw = 0.045;
      quad(V(x - hw, y, z), V(x + hw, y, z), V(x + hw, y + 0.66, z), V(x - hw, y + 0.66, z), cPost);
      quad(V(x, y, z - hw), V(x, y, z + hw), V(x, y + 0.66, z + hw), V(x, y + 0.66, z - hw), cPost);
    };
    const edge = (x0, z0, x1, z1) => {
      const spans = 4, L = Math.hypot(x1 - x0, z1 - z0), ux = (x1 - x0) / L, uz = (z1 - z0) / L, hw = 0.022;
      for (let sp = 0; sp < spans; sp++) {
        post(x0 + (x1 - x0) * sp / spans, z0 + (z1 - z0) * sp / spans);
        let prev = null;
        for (let q = 0; q <= 6; q++) {
          const f = (sp + q / 6) / spans, x = x0 + (x1 - x0) * f, z = z0 + (z1 - z0) * f;
          const sag = Math.sin((q / 6) * PI) * 0.1, p = V(x, gy(x, z) + 0.55 - sag, z);
          if (prev) {
            quad(V(prev.x, prev.y - hw, prev.z), V(p.x, p.y - hw, p.z), V(p.x, p.y + hw, p.z), V(prev.x, prev.y + hw, prev.z), cRope);
            quad(V(prev.x - uz * hw, prev.y, prev.z + ux * hw), V(p.x - uz * hw, p.y, p.z + ux * hw), V(p.x + uz * hw, p.y, p.z - ux * hw), V(prev.x + uz * hw, prev.y, prev.z - ux * hw), cRope);
          }
          prev = p;
        }
      }
      post(x1, z1);
    };
    const P = PLOT * TILE;
    for (let py = 0; py < PLOTS; py++) for (let px = 0; px < PLOTS; px++) {
      if (!ownedP(s, px, py)) continue;
      const x0 = ORIGIN + px * P, z0 = ORIGIN_Z + py * P, x1 = x0 + P, z1 = z0 + P;
      if (!ownedP(s, px, py - 1)) edge(x0, z0, x1, z0);
      if (!ownedP(s, px, py + 1)) edge(x0, z1, x1, z1);
      if (!ownedP(s, px - 1, py)) edge(x0, z0, x0, z1);
      if (!ownedP(s, px + 1, py)) edge(x1, z0, x1, z1);
    }
    if (rope) { root.remove(rope); rope.geometry.dispose(); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    geo.computeVertexNormals();
    rope = new THREE.Mesh(geo, ropeMat); rope.castShadow = true; rope.receiveShadow = true; rope.name = 'plot-rope';
    root.add(rope);

    for (const sg of signs) { putTemp(sg.g); dropProxy(sg.proxy); }
    signs.length = 0;
    for (let py = 0; py < PLOTS; py++) for (let px = 0; px < PLOTS; px++) {
      if (ownedP(s, px, py)) continue;
      // sign on the edge facing owned land, 0.9 m inside the plot, front (+Z) toward the owned side
      for (const [dx, dy, yaw] of [[0, 1, 0], [-1, 0, -PI / 2], [1, 0, PI / 2], [0, -1, PI]]) {
        if (!ownedP(s, px + dx, py + dy)) continue;
        const cx = ORIGIN + px * P + P / 2, cz = ORIGIN_Z + py * P + P / 2;
        const x = cx + dx * (P / 2 - 0.9), z = cz + dy * (P / 2 - 0.9);
        const [ti, tj] = tileAt(x, z), t = s.tiles[tj * GRID + ti];
        if (!t || t.t === 'w' || t.t === 'r') continue;
        const g = getTemp('sign_forsale');
        if (!g) break;
        const y = heightAt(x, z) - 0.03;
        g.position.set(x, y, z); g.rotation.y = yaw;
        const pr = proxy({ kind: 'sign', px, py }, 1.1, 1.6, 0.5);
        placeProxy(pr, x, y, z, yaw);
        signs.push({ g, proxy: pr, px, py, ph: Math.random() * 10 });
        break;
      }
    }
  }

  // ------------------------------------------------------------ sync from dirty
  function rebuildAll() {
    for (let n = BL.length - 1; n >= 0; n--) removeEntry(BL[n]);
    for (let k = 0; k < N; k++) {
      const rec = R[k];
      rec.slots.length = 0; rec.obs = rec.crop = null; rec.stage = -1; rec.wet = 0; rec.obsName = rec.obsPrev = null;
      if (rec.fire) { removeFire(rec.fire); rec.fire = null; }
      if (rec.proxy) pickables.remove(rec.proxy);
    }
    cropTiles.clear(); tileAnims.length = 0;
    for (const r of J) r.slots.length = 0;
    for (const I of instList) I.reset();
    const s = S();
    for (let k = 0; k < N; k++) rebuildTile(k, true);
    for (const id of Object.keys(s.buildings)) rebuildBuilding(id, true);
    plotKey = s.plots.join('');
    rebuildPlots();
    donkey.init = false;
    setHighlight(null);
  }
  function sync() {
    const s = S();
    if (!s) return;
    if (dirty.all) {
      dirty.all = false; dirty.tiles.clear(); dirty.b.clear();
      rebuildAll();
      return;
    }
    if (dirty.tiles.size) {
      for (const k of dirty.tiles) rebuildTile(k, false);
      dirty.tiles.clear();
      const key = s.plots.join('');
      if (key !== plotKey) { plotKey = key; rebuildPlots(); }
    }
    if (dirty.b.size) {
      for (const id of dirty.b) rebuildBuilding(id, false);
      dirty.b.clear();
    }
  }

  // ------------------------------------------------------------ crows
  const crows = new Map(), crowList = [];
  let frameNo = 0;
  function spawnCrow(c) {
    const g = getTemp('crow');
    const a = Math.random() * TAU, tx = tileX(c.i) + 0.55, tz = tileZ(c.j) + 0.2;
    const A = {
      id: c.id, i: c.i, j: c.j, g, mode: 0, t: 0, seen: 0, scared: false,
      sx: tx + Math.cos(a) * 30, sy: heightAt(tx, tz) + 16, sz: tz + Math.sin(a) * 30, tx, tz, x: tx, y: 0, z: tz,
      yaw: 0, hop: rnd(0.5, 1.2), peck: 0, vx: 0, vy: 0, vz: 0,
      proxy: proxy({ kind: 'crow', id: c.id }, 0.7, 0.6, 0.7),
    };
    crows.set(c.id, A); crowList.push(A);
    return A;
  }
  function leaveCrow(A, scared) {
    if (A.mode === 2) { A.scared = A.scared || scared; return; }
    A.mode = 2; A.t = 0; A.scared = scared;
    let ax = A.x - _cam.x, az = A.z - _cam.z;
    if (!scared) { const a = Math.random() * TAU; ax = Math.cos(a); az = Math.sin(a); }
    const l = Math.hypot(ax, az) || 1;
    const sp = scared ? 11 : 6;
    A.vx = ax / l * sp; A.vz = az / l * sp; A.vy = scared ? 6 : 3;
    dropProxy(A.proxy);
  }
  function stepCrows(dt, time) {
    frameNo++;
    for (const c of S().crows) { (crows.get(c.id) || spawnCrow(c)).seen = frameNo; }
    for (let n = crowList.length - 1; n >= 0; n--) {
      const A = crowList[n];
      if (A.seen !== frameNo && A.mode !== 2) leaveCrow(A, false);
      A.t += dt;
      const ground = heightAt(A.tx, A.tz) + 0.02;
      let roll = 0, pitch = 0;
      if (A.mode === 0) {                                       // fly in on an arc
        const f = Math.min(1, A.t / 2.8), e = 1 - Math.pow(1 - f, 2);
        const px = A.x, pz = A.z;
        A.x = A.sx + (A.tx - A.sx) * e; A.z = A.sz + (A.tz - A.sz) * e;
        A.y = A.sy + (ground - A.sy) * e + Math.sin(f * PI) * 2.5;
        if (f < 0.98) A.yaw = Math.atan2(A.x - px, A.z - pz);
        roll = Math.sin(time * 26) * 0.35 * (1 - f * 0.5); pitch = -0.15;
        if (f >= 1) { A.mode = 1; A.t = 0; burst('dust', A.x, ground, A.z, 3, 0.2); }
      } else if (A.mode === 1) {                                // hop and peck
        A.hop -= dt;
        if (A.hop <= 0) {
          A.hop = rnd(0.6, 1.6);
          if (Math.random() < 0.55) { A.peck = 0.5; }
          else { A.yaw += rnd(-1.4, 1.4); A.hx = clamp(A.x + Math.sin(A.yaw) * 0.25 - A.tx, -0.45, 0.45); A.hz = clamp(A.z + Math.cos(A.yaw) * 0.25 - A.tz, -0.45, 0.45); A.ht = 0.25; }
        }
        if (A.ht > 0) {
          A.ht -= dt;
          A.x = damp(A.x, A.tx + A.hx, 14, dt); A.z = damp(A.z, A.tz + A.hz, 14, dt);
          A.y = heightAt(A.x, A.z) + SOIL_TOP + Math.sin(Math.max(0, A.ht) / 0.25 * PI) * 0.16;
        } else A.y = heightAt(A.x, A.z) + SOIL_TOP;
        if (A.peck > 0) { A.peck -= dt; pitch = Math.max(0, Math.sin((0.5 - A.peck) * 25)) * 0.6; }
        placeProxy(A.proxy, A.x, A.y, A.z, 0);
      } else {                                                   // fly away
        A.vy += dt * 3;
        A.x += A.vx * dt; A.y += A.vy * dt; A.z += A.vz * dt;
        A.yaw = dampAngle(A.yaw, Math.atan2(A.vx, A.vz), 10, dt);
        roll = Math.sin(time * 30) * 0.4; pitch = -0.3;
        if (A.t > 3.5) {
          putTemp(A.g); crows.delete(A.id);
          crowList[n] = crowList[crowList.length - 1]; crowList.pop();
          continue;
        }
      }
      if (A.g) { A.g.position.set(A.x, A.y, A.z); A.g.rotation.set(pitch, A.yaw, roll, 'YXZ'); }
    }
  }

  // ------------------------------------------------------------ donkey (follows the host's player)
  const donkey = { g: null, lv: -1, x: 0, z: 0, y: 0, yaw: 0, v: 0, ph: 0, init: false, proxy: proxy({ kind: 'donkey' }, 1.0, 1.9, 2.0) };
  game.donkey = game.donkey || { x: 0, z: 0, yaw: 0, moving: false };
  const feetY = (x, y, z) => { const g = heightAt(x, z); return y == null ? g : Math.max(g, y - 1.65); };
  function leader() {
    if (game.role !== 'guest') { const p = game.player?.pos; return p ? _v.set(p.x, feetY(p.x, p.y, p.z), p.z) : null; }
    let h = null;
    if (game.remotes) for (const [pid, r] of game.remotes) { if (r.host || pid === game.hostPid || pid === game.net?.hostId) { h = r; break; } if (!h) h = r; }
    return h ? _v.set(h.x, feetY(h.x, h.y, h.z), h.z) : null;
  }
  function stepDonkey(dt) {
    const s = S(), lv = clamp(s.donkey?.lv || 0, 0, 2);
    if (lv !== donkey.lv) {
      if (donkey.g) { putTemp(donkey.g); if (donkey.init) burst('sparkle', donkey.x, donkey.y + 1, donkey.z, 20, 0.6); }
      donkey.g = getTemp(DONKEY[lv]); donkey.lv = lv;
      if (donkey.g && !donkey.g.userData.parts) {   // head, legs and tail hang off the body at their joints
        const P = donkey.g.userData.parts = { legs: [] };
        const add = (name, x, y, z) => { const m = makeMesh(name); m.position.set(x, y, z); donkey.g.add(m); return m; };
        P.head = add('donkey_head', 0, 1.12, 0.55);
        P.tail = add('donkey_tail', 0, 1.16, -0.8);
        for (const [x, z] of [[-0.2, 0.38], [0.2, 0.38], [-0.2, -0.46], [0.2, -0.46]]) P.legs.push(add('donkey_leg', x, 0.84, z));
      }
    }
    const cmd = s.donkey?.cmd;   // null: follow · {m:'stay'|'go', x, z}: walk there and wait
    const L = cmd ? _v.set(cmd.x, heightAt(cmd.x, cmd.z), cmd.z) : leader();
    if (!L) return;
    let dx = L.x - donkey.x, dz = L.z - donkey.z, d = Math.hypot(dx, dz);
    if (!donkey.init || (!cmd && d > 45)) {
      donkey.x = L.x - 2.2; donkey.z = L.z + 2.2; donkey.init = true;
      dx = L.x - donkey.x; dz = L.z - donkey.z; d = Math.hypot(dx, dz);
    }
    const want = d - (cmd ? 0.3 : 3);
    donkey.v = damp(donkey.v, want > 0.25 ? clamp(want * 2.2, 0, 7.8) : 0, 5, dt);
    if (d > 0.01 && donkey.v > 0.01) {
      const nx = donkey.x + dx / d * donkey.v * dt, nz = donkey.z + dz / d * donkey.v * dt;
      if (heightAt(nx, nz) > -0.3) { donkey.x = nx; donkey.z = nz; } else donkey.v *= 0.5;
      if (want > 0.1) donkey.yaw = dampAngle(donkey.yaw, Math.atan2(dx, dz), 6, dt);
    }
    const moving = donkey.v > 0.2;
    donkey.ph += dt * (moving ? 2.4 + donkey.v * 1.3 : 0);
    const ground = heightAt(donkey.x, donkey.z), amt = Math.min(1, donkey.v / 2);
    donkey.y = ground + Math.abs(Math.sin(donkey.ph)) * 0.06 * amt;
    if (donkey.g) {
      donkey.g.position.set(donkey.x, donkey.y, donkey.z);
      donkey.g.rotation.set(Math.sin(donkey.ph * 2) * 0.025 * amt, donkey.yaw, Math.sin(donkey.ph) * 0.03 * amt, 'YXZ');
      const P = donkey.g.userData.parts;
      if (P) {
        donkey.t = (donkey.t || 0) + dt;
        const T = donkey.t, sw = Math.sin(donkey.ph) * 0.5 * amt;
        P.legs.forEach((l, k) => { l.rotation.x = (k === 0 || k === 3 ? sw : -sw); });   // diagonal pairs, a walk
        // idle: every ~11 s it lowers its head to graze for a few seconds
        const graze = amt < 0.05 ? Math.max(0, Math.sin(T * 0.57) * 1.6 - 0.6) : 0;
        donkey.graze = damp(donkey.graze || 0, Math.min(1, graze), 3, dt);
        P.head.rotation.x = donkey.graze * 0.85 + Math.sin(donkey.ph * 2) * 0.07 * amt + Math.sin(T * 1.3) * 0.03 * (1 - donkey.graze);
        P.head.rotation.y = Math.sin(T * 0.4) * 0.15 * (1 - amt) * (1 - donkey.graze);
        donkey.petT = Math.max(0, (donkey.petT || 0) - dt);
        const pet = Math.min(1, donkey.petT * 1.5);
        if (pet > 0) { donkey.graze = 0; P.head.rotation.x = -0.35 * pet + Math.sin(T * 9) * 0.08 * pet; P.head.rotation.y = Math.sin(T * 4) * 0.2 * pet; }
        P.tail.rotation.z = Math.sin(T * (2.2 + pet * 12)) * (0.3 + pet * 0.25) + Math.sin(T * 5.1) * 0.08;
        P.tail.rotation.x = -0.15 - amt * 0.25;
      }
    }
    placeProxy(donkey.proxy, donkey.x, ground, donkey.z, donkey.yaw);
    const D = game.donkey;
    D.x = donkey.x; D.z = donkey.z; D.yaw = donkey.yaw; D.moving = moving;
  }

  // ------------------------------------------------------------ remote players
  const remotes = new Map();
  // a friend's character: body + two legs + two arms, animated from their position updates;
  // the right hand holds whatever they have selected and swings when they use it
  function buildAvatar(outfit) {
    const g = new THREE.Group(), tint = { tint: { shirt: outfit } };
    if (!has('player_body')) { if (has('player')) g.add(makeMesh('player', tint)); return { g }; }
    const body = makeMesh('player_body', tint);
    g.add(body);
    const joint = (parent, name, x, y, opts) => { const m = makeMesh(name, opts); m.position.set(x, y, 0); parent.add(m); return m; };
    const leg = x => { const thigh = joint(g, 'player_thigh', x, 0.92); return { thigh, shin: joint(thigh, 'player_shin', 0, -0.4) }; };
    const arm = x => { const upper = joint(g, 'player_upperarm', x, 1.38, tint); return { upper, fore: joint(upper, 'player_forearm', 0, -0.3) }; };
    const A = { g, body, legL: leg(0.1), legR: leg(-0.1), armL: arm(0.215), armR: arm(-0.215), hold: new THREE.Group(), heldId: null };
    A.hold.position.set(0, -0.25, -0.005);
    A.armR.fore.add(A.hold);
    return A;
  }
  function heldModel(id) {
    const I = ITEMS[id];
    if (!I) return null;
    if (I.kind === 'tool') return { name: 'tool_' + id, s: 0.85, grip: 0.12 };
    if (I.kind === 'seed') return { name: CROPS[I.crop]?.tree ? 'sapling' : 'seed_packet', s: 0.7, grip: 0.1 };
    if (I.kind === 'place') return { name: 'tool_blueprint', s: 0.6, grip: 0 };
    if (I.kind === 'boost') return { name: 'tool_fertilizer', s: 0.6, grip: 0.15 };
    return I.model ? { name: I.model, s: 0.8, grip: 0.05 } : null;
  }
  function setHeld(A, id) {
    if (!A.hold || A.heldId === id) return;
    A.heldId = id;
    A.hold.clear();
    const h = id && heldModel(id);
    if (!h || !has(h.name)) return;
    const m = makeMesh(h.name, { castShadow: true });
    m.scale.setScalar(h.s);
    m.position.y = -h.grip * h.s;
    A.hold.add(m);
  }
  function stepRemotes(dt) {
    const src = game.remotes;
    if (src) for (const [pid, r] of src) {
      let A = remotes.get(pid);
      const outfit = r.outfit || '#3a86c8';
      if (A && A.outfit !== outfit) {
        root.remove(A.av.g); A.av = buildAvatar(outfit); root.add(A.av.g); A.outfit = outfit;
        burst('sparkle', A.x, A.y + 1, A.z, 16, 0.4);
      }
      if (!A) {
        A = { av: buildAvatar(outfit), outfit, name: null, label: makeLabelSprite(512, 96),
          x: r.x, z: r.z, y: feetY(r.x, r.y, r.z), yaw: r.yaw || 0, ph: 0, seen: 0, t: 0, anim: null, animT: 1 };
        root.add(A.av.g); root.add(A.label.sp);
        remotes.set(pid, A);
      }
      const av = A.av;
      if (A.name !== (r.name || 'Friend')) { A.name = r.name || 'Friend'; drawLabel(A.label, A.name, '#F3E3C3', 50); }
      A.seen = frameNo;
      const px = A.x, pz = A.z;
      A.x = damp(A.x, r.x, 12, dt); A.z = damp(A.z, r.z, 12, dt);
      A.y = damp(A.y, feetY(r.x, r.y, r.z), 12, dt);
      A.yaw = dampAngle(A.yaw, r.yaw || 0, 12, dt);       // player yaw is facing (sin, cos), same as the model's +Z
      const sp = Math.hypot(A.x - px, A.z - pz) / Math.max(dt, 1e-4);
      A.ph += dt * Math.min(sp, 8) * 2.2;
      A.t += dt;
      const amt = Math.min(1, sp / 3);
      av.g.position.set(A.x, A.y + Math.abs(Math.sin(A.ph)) * 0.04 * amt, A.z);
      av.g.rotation.set(0, A.yaw, Math.sin(A.ph) * 0.03 * amt);
      if (av.legL) {
        setHeld(av, r.held || null);
        if (r.anim && r.anim !== A.anim) A.animT = 0;            // they just used something
        A.anim = r.anim || null;
        A.animT = Math.min(1, A.animT + dt / 0.45);
        const use = A.animT < 1 ? Math.sin(A.animT * PI) : 0, still = 1 - amt;
        // walk: thighs swing, knees bend on the back swing; arms swing against the legs with soft elbows
        const ph = A.ph, sw = Math.sin(ph) * 0.6 * amt;
        av.legL.thigh.rotation.x = sw;  av.legL.shin.rotation.x = Math.max(0, -Math.sin(ph + 0.9)) * 0.9 * amt + 0.03;
        av.legR.thigh.rotation.x = -sw; av.legR.shin.rotation.x = Math.max(0, Math.sin(ph + 0.9)) * 0.9 * amt + 0.03;
        const idle = Math.sin(A.t * 1.4) * 0.03 * still;
        av.armL.upper.rotation.set(-sw * 0.75 + idle, 0, 0.16);           // a little away from the body
        av.armL.fore.rotation.x = -0.2 - 0.25 * amt;
        const holding = av.hold.children.length > 0;
        let ux, fx;
        if (holding) { ux = -0.3 - sw * 0.25 - use * 1.1; fx = -0.95 + use * 0.5; }
        else { ux = sw * 0.75 + idle - use * 1.2; fx = -0.2 - 0.25 * amt - use * 0.4; }
        av.armR.upper.rotation.set(ux, 0, -0.16);
        av.armR.fore.rotation.x = fx;
        // the tool stands up and forward from the hand in the carry pose (arm at -1.25); it chops forward with the arm
        av.hold.rotation.x = 1.85 + use * 0.4;
        av.body.position.y = Math.sin(A.t * 2.2) * 0.004 * still;          // breathing when still
      }
      A.label.sp.position.set(A.x, A.y + 2.15, A.z);
      A.label.sp.scale.set(1.6, 0.3, 1);
      const d2 = (A.x - _cam.x) ** 2 + (A.z - _cam.z) ** 2;
      A.label.sp.material.opacity = d2 > 2500 ? Math.max(0, 1 - (Math.sqrt(d2) - 50) / 30) : 1;
    }
    for (const [pid, A] of remotes) {
      if (A.seen === frameNo) continue;
      root.remove(A.av.g); root.remove(A.label.sp);
      A.label.tex.dispose(); A.label.sp.material.dispose();
      remotes.delete(pid);
    }
  }

  // ------------------------------------------------------------ trader NPC + quest board at the pier's land end
  const trader = { g: null, board: null, yaw: PI, ph: 0 };
  if (!game.trader) game.trader = { ...TRADER_AT };
  {
    const T = game.trader, y = heightAt(T.x, T.z);
    trader.g = getTemp('trader');
    if (trader.g) { trader.g.position.set(T.x, y, T.z); trader.g.rotation.y = trader.yaw; }
    trader.proxy = proxy({ kind: 'trader' }, 0.9, 2.1, 0.9);
    placeProxy(trader.proxy, T.x, y, T.z, trader.yaw);
    const bx = T.x + 3.0, bz = T.z + 0.6, by = heightAt(bx, bz) - 0.03;
    trader.board = getTemp('quest_board');
    if (trader.board) { trader.board.position.set(bx, by, bz); trader.board.rotation.y = PI - 0.25; }
    trader.bproxy = proxy({ kind: 'board' }, 2.3, 2.5, 0.7);
    placeProxy(trader.bproxy, bx, by, bz, PI - 0.25);
  }
  function stepTrader(dt, time) {
    if (!trader.g) return;
    const T = game.trader, dx = _cam.x - T.x, dz = _cam.z - T.z;
    const target = dx * dx + dz * dz < 81 ? Math.atan2(dx, dz) : PI;
    trader.yaw = dampAngle(trader.yaw, target, 3, dt);
    trader.g.rotation.y = trader.yaw;
    const br = 1 + Math.sin(time * 1.6) * 0.012;
    trader.g.scale.set(1, br, 1);
  }

  // ------------------------------------------------------------ one-off animations: harvest pops, produce flights, falls, bolt
  const anims = [];
  function harvestPop(k, id, gold, dock) {
    const i = k % GRID, j = (k / GRID) | 0, I = ITEMS[id];
    const base = I && CROPS[id.replace(/^g_/, '')];
    if (!base) return;
    tilePos(i, j);
    const x = _fp.x, y = _fp.y, z = _fp.z;
    if (!base.tree) {
      const g = getTemp('crop_' + base.id + '_3');
      if (g) {
        g.position.set(x, y, z); g.rotation.y = hash(k, 1) * TAU;
        anims.push({ type: 'pop', g, t: 0, dur: 0.34, s: 0.95 });
      }
    }
    const py = y + (base.tree ? 2.2 : 0.45);
    burst('leaf', x, py, z, 6, 0.3);
    burst(gold ? 'sparkle' : 'green', x, py, z, gold ? 24 : 6, 0.3);
    const pg = getTemp(I.model);
    if (pg) {
      pg.position.set(x, py, z);
      anims.push({ type: 'fly', g: pg, t: 0, dur: dock ? 0.9 : 0.6, x0: x, y0: py, z0: z, dock: dock || null, cam: !dock && _cam.distanceToSquared(_v.set(x, py, z)) < 144 });
    }
    floatText(`+1 ${I.name}`, gold ? '#F2C94C' : '#F3E3C3', x, py + 0.4, z);
  }
  function fallTree(k, from) {
    const rec = R[k];
    const name = rec.obsName && /^(palm|jungle)_/.test(rec.obsName) ? rec.obsName : rec.obsPrev && /^(palm|jungle)_/.test(rec.obsPrev) ? rec.obsPrev : (from === 'palm' ? 'palm_a' : 'jungle_a');
    const i = k % GRID, j = (k / GRID) | 0, x = tileX(i), z = tileZ(j), y = heightAt(x, z);
    const g = getTemp(name, { foliage: true });
    if (!g) return;
    g.position.set(x, y, z);
    let ax = x - _cam.x, az = z - _cam.z;                      // falls away from the viewer
    const l = Math.hypot(ax, az) || 1; ax /= l; az /= l;
    const axis = new THREE.Vector3(az, 0, -ax);                 // horizontal axis perpendicular to the fall
    anims.push({ type: 'fall', g, t: 0, axis, yaw: hash(k, 8) * TAU, s: 0.85 + hash(k, 9) * 0.3, x, y, z, ax, az, hit: false });
  }
  const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
  function stepAnims(dt) {
    for (let n = anims.length - 1; n >= 0; n--) {
      const A = anims[n];
      A.t += dt;
      let done = false;
      if (A.type === 'pop') {
        const f = A.t / A.dur;
        const k = f < 0.35 ? 1 + 0.3 * (f / 0.35) : 1.3 * Math.pow(Math.max(0, 1 - (f - 0.35) / 0.65), 2);
        A.g.scale.setScalar(A.s * Math.max(0.001, k));
        done = f >= 1;
      } else if (A.type === 'fly') {
        const f = Math.min(1, A.t / A.dur);
        let tx, ty, tz;
        if (A.dock) { tx = A.dock.x; ty = A.dock.y + 0.6; tz = A.dock.z; }
        else if (A.cam) { camera.getWorldDirection(_fwd); tx = _cam.x + _fwd.x * 0.6; ty = _cam.y - 0.35 + _fwd.y * 0.6; tz = _cam.z + _fwd.z * 0.6; }
        else { tx = A.x0; ty = A.y0 + 1.6; tz = A.z0; }
        const e = f * f * (3 - 2 * f);
        A.g.position.set(A.x0 + (tx - A.x0) * e, A.y0 + (ty - A.y0) * e + Math.sin(f * PI) * 0.9, A.z0 + (tz - A.z0) * e);
        A.g.rotation.y += dt * 9;
        A.g.scale.setScalar(Math.max(0.01, (1 - f * 0.65) * (f < 0.12 ? easeOutBack(f / 0.12) : 1) * (!A.cam && !A.dock && f > 0.7 ? (1 - f) / 0.3 : 1)));
        done = f >= 1;
      } else if (A.type === 'fall') {
        const T = 1.15;
        let ang;
        if (A.t < T) ang = (PI / 2 - 0.08) * Math.pow(A.t / T, 2.2);
        else {
          if (!A.hit) {
            A.hit = true;
            const hx = A.x + A.ax * 3.2, hz = A.z + A.az * 3.2, hy = heightAt(hx, hz);
            burst('dust', hx, hy + 0.1, hz, 22, 1.4); burst('leaf', hx, hy + 0.6, hz, 26, 1.2); burst('wood', A.x, A.y + 0.3, A.z, 8, 0.3);
          }
          const b = A.t - T;
          ang = PI / 2 - 0.08 - Math.abs(Math.sin(b * 9)) * 0.09 * Math.exp(-b * 5);
        }
        _qa.setFromAxisAngle(A.axis, ang); _qb.setFromAxisAngle(_v.set(0, 1, 0), A.yaw);
        A.g.quaternion.multiplyQuaternions(_qa, _qb);
        const sink = Math.max(0, A.t - T - 0.8);
        A.g.scale.setScalar(A.s * Math.max(0.001, 1 - sink / 0.7));
        A.g.position.y = A.y - sink * 0.6;
        done = A.t > T + 1.5;
      } else if (A.type === 'bolt') {
        const f = A.t / 0.35;
        boltMat.opacity = f < 1 ? (0.6 + 0.4 * Math.sin(A.t * 90)) * (1 - f * 0.6) : 0;
        done = f >= 1;
        if (done) bolt.visible = false;
      }
      if (done) { if (A.g) putTemp(A.g); anims[n] = anims[anims.length - 1]; anims.pop(); }
    }
  }
  // lightning bolt for targeted strikes (one reusable jagged ribbon)
  const BSEG = 14;
  const boltPos = new Float32Array(BSEG * 12 * 3);
  const boltGeo = new THREE.BufferGeometry();
  boltGeo.setAttribute('position', new THREE.BufferAttribute(boltPos, 3).setUsage(THREE.DynamicDrawUsage));
  const boltMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 5, 7), transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false });
  const bolt = new THREE.Mesh(boltGeo, boltMat);
  bolt.frustumCulled = false; bolt.visible = false; bolt.renderOrder = 6;
  root.add(bolt);
  function strikeBolt(x, y, z) {
    let px = x + rnd(-4, 4), py = y + 45, pz = z + rnd(-4, 4), o = 0;
    for (let n = 0; n < BSEG; n++) {
      const f = (n + 1) / BSEG, j = n === BSEG - 1 ? 0 : 1.6 * (1 - f * 0.5);
      const nx = (n === BSEG - 1) ? x : px + (x - px) / (BSEG - n) + rnd(-j, j), nz = (n === BSEG - 1) ? z : pz + (z - pz) / (BSEG - n) + rnd(-j, j);
      const ny = y + 45 * (1 - f), w = 0.12 * (1 - f * 0.5);
      for (const [ux, uz] of [[w, 0], [0, w]]) {
        const v = [px - ux, py, pz - uz, nx - ux, ny, nz - uz, nx + ux, ny, nz + uz, px - ux, py, pz - uz, nx + ux, ny, nz + uz, px + ux, py, pz + uz];
        boltPos.set(v, o); o += 18;
      }
      px = nx; py = ny; pz = nz;
    }
    boltGeo.attributes.position.needsUpdate = true;
    bolt.visible = true;
    for (let n = anims.length - 1; n >= 0; n--) if (anims[n].type === 'bolt') { anims[n] = anims[anims.length - 1]; anims.pop(); }
    anims.push({ type: 'bolt', t: 0 });
    world.flash?.(1);
  }

  // ------------------------------------------------------------ fx events
  function playerPos(pid) {                                     // -> _fp near that player's hands
    if (!pid || pid === game.pid) { camera.getWorldDirection(_fwd); return _fp.set(_cam.x + _fwd.x * 1.1, _cam.y - 0.45, _cam.z + _fwd.z * 1.1); }
    const A = remotes.get(pid);
    return A ? _fp.set(A.x, A.y + 1.2, A.z) : null;
  }
  const botTiles = new Map();
  function onFx(list) {
    if (!S() || !list?.length) return;
    botTiles.clear();
    for (const f of list) if (f.k === 'bot') botTiles.set(f.j * GRID + f.i, null);
    for (const f of list) if (f.k === 'harvest' && botTiles.has(f.j * GRID + f.i)) botTiles.set(f.j * GRID + f.i, f);
    for (const f of list) {
      const hasTile = f.i != null && f.j != null, k = hasTile ? f.j * GRID + f.i : -1;
      if (hasTile) tilePos(f.i, f.j);
      const x = _fp.x, y = _fp.y, z = _fp.z;
      const e = f.bid ? B.get(f.bid) : null;
      switch (f.k) {
        case 'till': burst('dirt', x, y, z, 16, 0.6); burst('dust', x, y, z, 4, 0.6); addTileAnim(k, 'grow', 0.3); break;
        case 'plant': burst('seed', x, y + 0.9, z, 10, 0.3); burst('dirt', x, y, z, 4, 0.3); addTileAnim(k, 'pop', 0.45); if (f.auto) burst('green', x, y + 0.3, z, 4, 0.4); break;
        case 'water': burst('splash', x, y + 0.05, z, 18, 0.6); break;
        case 'harvest': if (!botTiles.has(k)) harvestPop(k, f.id, f.gold, null); break;
        case 'bot': {
          const hv = botTiles.get(k);
          if (e?.rover && hv && e.rover.q.length < 6) e.rover.q.push({ i: f.i, j: f.j, k, id: hv.id, gold: hv.gold });
          else if (hv) harvestPop(k, hv.id, hv.gold, e);
          break;
        }
        case 'fertilize': burst('green', x, y + 0.2, z, 22, 0.5); addTileAnim(k, 'grow', 0.4); break;
        case 'sparkle': burst('sparkle', x, y + 0.3, z, 30, 0.5); addTileAnim(k, 'grow', 0.5); break;
        case 'hit': {
          const top = R[k].obsName && /^(palm|jungle)/.test(R[k].obsName) ? 1.4 : 0.4;
          burst(f.o === 'rock' ? 'stone' : 'wood', x, y + top * 0.6, z, 12, 0.3);
          if (f.o === 'palm' || f.o === 'jungle' || f.o === 'bush') burst('leaf', x, y + (f.o === 'bush' ? 0.6 : 3.5), z, 10, 1.0);
          if (f.o === 'rock') burst('dust', x, y + 0.2, z, 5, 0.5);
          addTileAnim(k, 'shake', 0.45);
          break;
        }
        case 'fell': fallTree(k, f.from); break;
        case 'regrow': burst('green', x, y + 0.5, z, 20, 0.6); burst('leaf', x, y + 1.5, z, 10, 0.8); addTileAnim(k, 'opop', 0.7); break;
        case 'extinguish':
          if (e) { burst('steam', e.x, e.y + e.top * 0.5, e.z, 20, e.w * 0.5); burst('splash', e.x, e.y + 0.5, e.z, 16, e.w * 0.5); }
          else if (hasTile) { burst('steam', x, y + 0.3, z, 14, 0.5); burst('splash', x, y, z, 12, 0.5); }
          break;
        case 'strike': {
          const sx = e ? e.x : x, sy = e ? e.y + e.top : y, sz = e ? e.z : z;
          if (e || hasTile) { strikeBolt(sx, sy, sz); burst('ember', sx, sy, sz, 26, 0.4); burst('dark', sx, sy, sz, 6, 0.4); }
          break;
        }
        case 'burnt':
          if (e) burst('dark', e.x, e.y + e.top * 0.6, e.z, 16, e.w * 0.6);
          else if (hasTile) { burst('dark', x, y + 0.2, z, 10, 0.5); burst('dust', x, y, z, 6, 0.5); }
          break;
        case 'eaten': burst('leaf', x, y + 0.3, z, 12, 0.4); burst('feather', x, y + 0.3, z, 4, 0.3); break;
        case 'scare': {
          for (const A of crowList) if (A.i === f.i && A.j === f.j) leaveCrow(A, true);
          burst('feather', x + 0.5, y + 0.3, z, 10, 0.3);
          break;
        }
        case 'damage':
          if (f.kind === 'acid') burst('acid', x, y + 0.3, z, 18, 0.5);
          else if (f.kind === 'flood') burst('splash', x, y, z, 20, 0.7);
          else { burst('leaf', x, y + 0.4, z, 16, 0.5); burst('dust', x, y, z, 4, 0.5); }
          break;
        case 'build': if (hasTile && !BUILDINGS[f.type]?.tilemod === false) burst('dust', x, y, z, 8, 0.6); else if (hasTile) burst('dust', x, y, z, 10, 0.7); break;
        case 'plot': {
          const P = PLOT * TILE, cx = ORIGIN + f.px * P + P / 2, cz = ORIGIN_Z + f.py * P + P / 2;
          for (let q = 0; q < 12; q++) { const qx = cx + rnd(-4.5, 4.5), qz = cz + rnd(-4.5, 4.5); burst('sparkle', qx, heightAt(qx, qz) + 0.3, qz, 4, 0.5); }
          break;
        }
        case 'coins': {
          const p = playerPos(f.pid);
          if (p) { burst('coin', p.x, p.y, p.z, Math.min(30, 6 + Math.round(Math.log2(1 + f.n) * 2)), 0.15); floatText('+' + fmtNum(f.n), '#F2B33D', p.x, p.y + 0.5, p.z); }
          break;
        }
        case 'market':
          if (e) { e.pulse = 0; burst('coin', e.x, e.y + e.top, e.z, 18, 0.5); floatText('+' + fmtNum(f.n), '#F2B33D', e.x, e.y + e.top + 0.3, e.z); }
          break;
        case 'collect':
          if (e) { burst('sparkle', e.x, e.y + e.top * 0.6, e.z, 16, e.w * 0.5); floatText(`+${f.n} ${ITEMS[f.id]?.name || ''}`, '#F3E3C3', e.x, e.y + e.top, e.z); }
          break;
        case 'factory': if (e) burst('smoke', e.x, e.y + e.top, e.z, 6, 0.3); break;
        case 'refill': { const p = playerPos(f.pid); if (p) burst('splash', p.x, p.y - 0.3, p.z, 14, 0.25); break; }
        case 'outfit': case 'levelup': {
          const p = playerPos(f.pid);
          if (p) burst('sparkle', p.x, p.y - 0.3, p.z, f.k === 'levelup' ? 50 : 24, 0.8);
          break;
        }
        case 'pet': donkey.petT = 1.6; burst('heart', donkey.x, donkey.y + 1.9, donkey.z, 16, 0.35); break;
        case 'donkeyCmd': burst('dust', donkey.x, donkey.y + 0.1, donkey.z, 6, 0.5); break;
        case 'quest': if (trader.g) burst('sparkle', game.trader.x, heightAt(game.trader.x, game.trader.z) + 1.6, game.trader.z, 30, 0.6); break;
        default: break;
      }
    }
  }

  // ------------------------------------------------------------ picking
  const _hits = [];
  const WATER = { kind: 'water' };
  function pick(raycaster) {
    const s = S();
    if (!s) return null;
    const reach = Math.min(raycaster.far, 8);
    _hits.length = 0;
    raycaster.intersectObjects(pickables.children, false, _hits);
    let best = null, bd = reach;
    for (const h of _hits) if (h.distance <= bd && h.object.userData.pick) { best = h.object.userData.pick; bd = h.distance; break; }
    // fresh water: march the ray to the first ground/water contact (pond 'w' and river 'r' tiles)
    const o = raycaster.ray.origin, d = raycaster.ray.direction, wl = world.waterLevel ? world.waterLevel() : 0;
    for (let t = 0.25; t <= bd; t += 0.2) {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t, g = heightAt(x, z);
      if (y > Math.max(g, wl) + 0.02) continue;
      const [i, j] = tileAt(x, z);
      const tt = i >= 0 && j >= 0 && i < GRID && j < GRID ? s.tiles[j * GRID + i] : null;
      if (tt ? (tt.t === 'w' || tt.t === 'r') : (g < wl + 0.3 && z > RIVER_Z0 - 9 && Math.abs(x - riverX(Math.max(z, RIVER_Z0))) < 9)) return WATER;
      break;
    }
    return best;
  }

  // ------------------------------------------------------------ highlight (outline)
  const hl = { obj: null, temp: null, src: null };
  function setHighlight(obj) {
    if (obj === hl.obj) return;
    hl.obj = obj;
    world.setOutline?.(obj ? [obj] : []);
  }
  function tempHighlight(r) {
    if (hl.src === r && hl.temp) return hl.temp;
    if (hl.temp) putTemp(hl.temp);
    hl.temp = getTemp(r.name);
    hl.src = r;
    if (hl.temp) {
      hl.temp.matrixAutoUpdate = false;
      hl.temp.matrix.copy(compose(r.x, r.y, r.z, r.yaw, r.s));
      hl.temp.matrixWorldNeedsUpdate = true;
    }
    return hl.temp;
  }
  function highlight(tg) {
    let obj = null, keepTemp = false;
    if (tg) {
      const k = tg.i != null && tg.j != null ? tg.j * GRID + tg.i : -1;
      switch (tg.kind) {
        case 'building': obj = B.get(tg.id)?.g || null; break;
        case 'crow': for (const A of crowList) if (A.id === tg.id) obj = A.g; break;
        case 'donkey': obj = donkey.g; break;
        case 'trader': obj = trader.g; break;
        case 'board': obj = trader.board; break;
        case 'sign': for (const sg of signs) if (sg.px === tg.px && sg.py === tg.py) obj = sg.g; break;
        default: {
          const r = k >= 0 ? (tg.kind === 'obstacle' ? R[k].obs : R[k].crop) : null;
          if (r) { obj = tempHighlight(r); keepTemp = true; }
        }
      }
    }
    if (!keepTemp && hl.temp) { const t = hl.temp; hl.temp = null; hl.src = null; t.matrixAutoUpdate = true; putTemp(t); }
    setHighlight(obj);
  }

  // ------------------------------------------------------------ build ghost
  const ghostMat = new THREE.MeshLambertMaterial({ color: 0x5fe08a, emissive: 0x1d6a3a, transparent: true, opacity: 0.5, depthWrite: false });
  const ghostCache = new Map(), G = { type: null, g: null, ok: null };
  const GOOD = col('#5fe08a'), GOODE = col('#1d6a3a'), BAD = col('#e8536b'), BADE = col('#6a1d2a');
  function ghost(type, i, j, rot = 0, ok = true) {
    if (!type || !BUILDINGS[type]) { if (G.g) G.g.visible = false; return; }
    if (type !== G.type) {
      if (G.g) root.remove(G.g);
      let g = ghostCache.get(type);
      const model = modelFor(type);
      if (!g && has(model)) {
        g = makeMesh(model);
        g.traverse(o => { if (o.isMesh) { o.material = ghostMat; o.castShadow = false; o.receiveShadow = false; o.renderOrder = 4; } });
        ghostCache.set(type, g);
      }
      G.g = g || null; G.type = type;
      if (G.g) root.add(G.g);
    }
    if (!G.g) return;
    if (ok !== G.ok) { G.ok = ok; ghostMat.color.copy(ok ? GOOD : BAD); ghostMat.emissive.copy(ok ? GOODE : BADE); }
    G.g.visible = true;
    const [cx, cz] = centerOf({ type, i, j, rot });
    const tm = BUILDINGS[type].tilemod;
    G.g.position.set(cx, tm ? heightAt(cx, cz) + (tm === 'fert' ? 0.01 : 0) : placeY(type, i, j, rot), cz);
    G.g.rotation.y = yawFor(type, rot);
  }

  // ------------------------------------------------------------ tile cursor: soft rounded quads on the terrain
  const curMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: col('#2FB7B0') }, uTime: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uTime; varying vec2 vUv;
      void main() {
        vec2 q = abs(vUv - 0.5) * 2.0;
        float d = length(max(q - vec2(0.62), 0.0)) - 0.3;          // rounded box, radius 0.3
        float fill = smoothstep(0.02, -0.12, d) * 0.16;
        float ring = smoothstep(0.09, 0.0, abs(d + 0.06)) * 0.85;
        float pulse = 0.82 + 0.18 * sin(uTime * 4.0);
        gl_FragColor = vec4(uColor * (1.0 + ring * 0.4), (fill + ring) * pulse);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  const cursors = [], curCells = new Int32Array(50);
  let curN = 0, curOk = null;
  function tileCursor(cells, ok = true) {
    const n = Math.min(cells?.length || 0, 25);
    let same = n === curN;
    for (let q = 0; same && q < n; q++) same = cells[q][0] === curCells[q * 2] && cells[q][1] === curCells[q * 2 + 1];
    if (ok !== curOk) { curOk = ok; curMat.uniforms.uColor.value.set(ok ? '#2FB7B0' : '#E8536B'); }
    if (same) return;
    const s = S();
    for (let q = 0; q < n; q++) {
      const i = cells[q][0], j = cells[q][1];
      curCells[q * 2] = i; curCells[q * 2 + 1] = j;
      let C = cursors[q];
      if (!C) {
        C = new THREE.Mesh(new THREE.PlaneGeometry(1.92, 1.92, 4, 4).rotateX(-PI / 2), curMat);
        C.renderOrder = 3; C.frustumCulled = false; cursors.push(C); root.add(C);
      }
      const x = tileX(i), z = tileZ(j), t = s && i >= 0 && j >= 0 && i < GRID && j < GRID ? s.tiles[j * GRID + i] : null;
      const flat = t && t.t === 's' && !t.b;
      const hc = heightAt(x, z), flatY = hc + (t?.rb ? RAISED : 0) + SOIL_TOP + 0.02;
      const P = C.geometry.attributes.position;
      for (let v = 0; v < P.count; v++) P.setY(v, flat ? flatY : heightAt(x + P.getX(v), z + P.getZ(v)) + 0.11);   // clears the ground detail bumps (<= 9 cm)
      P.needsUpdate = true;
      C.position.set(x, 0, z); C.visible = true;
    }
    for (let q = n; q < cursors.length; q++) cursors[q].visible = false;
    curN = n;
  }

  // ------------------------------------------------------------ per frame
  let stageT = 0, ripeT = 0, time = 0;
  function update(dt, now) {
    if (!S()) return;
    dt = Math.min(dt, 0.1);
    time += dt;
    camera.getWorldPosition(_cam);
    stageT -= dt;
    if (stageT <= 0) { stageT = 0.5; checkStages(); }
    ripeT -= dt;
    if (ripeT <= 0 && ripeNear.length) {
      ripeT = 0.35;
      const k = ripeNear[(Math.random() * ripeNear.length) | 0], r = R[k].crop;
      if (r) burst('sparkle', r.x + rnd(-0.3, 0.3), r.y + 0.6, r.z + rnd(-0.3, 0.3), 1, 0.1);
    }
    stepBuildings(dt, now, time);
    stepFires(dt, time);
    stepTileAnims(dt);
    stepCrows(dt, time);
    stepDonkey(dt);
    stepRemotes(dt);
    stepTrader(dt, time);
    for (const sg of signs) if (sg.g) sg.g.rotation.z = Math.sin(time * 1.3 + sg.ph) * 0.015;
    stepAnims(dt);
    stepParticles(dt);
    stepTexts(dt);
    curMat.uniforms.uTime.value = time;
    if (G.g?.visible) ghostMat.opacity = 0.42 + 0.1 * Math.sin(time * 5);
    for (let n = 0; n < instList.length; n++) instList[n].flush();
  }

  return { sync, update, onFx, pickables, pick, highlight, ghost, tileCursor, root };
}
