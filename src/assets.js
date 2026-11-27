// Harvest Haven asset library: loads the Blender models (assets/models.glb) + heightmap, bakes every plain
// c_rrggbb material into one vertex-coloured geometry per model, and hands out meshes / instanced groups /
// UI thumbnails that all share a handful of soft toon materials.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { setHeights } from './terrain.js';

export const lib = {};
export let heights = null;   // raw heights.json ({n, step, off, h}) — world.js builds the water depth texture from it

export const uniforms = {
  uTime: { value: 0 },
  uWind: { value: 0.35 },
  uWindDir: { value: new THREE.Vector2(0.8, 0.6).normalize() },
};

// ---------------------------------------------------------------- soft 4-step toon ramp
const ramp = new THREE.DataTexture(new Uint8Array([62, 118, 202, 255]), 4, 1, THREE.RedFormat);
ramp.minFilter = ramp.magFilter = THREE.LinearFilter;   // linear = soft band edges
ramp.generateMipmaps = false;
ramp.needsUpdate = true;

// world-space wind sway. Needs hhM (world matrix), hhS (scale), hhH (vertex height above the model base, metres)
const WIND = /* glsl */ `
  vec3 hhO = hhM[3].xyz;
  float hhPh = dot(hhO.xz, vec2(0.37, 0.23));
  float hhG = sin(uTime * 1.3 + hhPh) * 0.6 + sin(uTime * 2.9 + hhPh * 1.7) * 0.4;
  float hhA = uWind * (0.09 * hhH + 0.004 * hhH * hhH);
  vec2 hhOff = uWindDir * (hhA * (0.35 + 0.65 * hhG));
  hhOff += vec2(-uWindDir.y, uWindDir.x) * hhA * 0.22 * sin(uTime * 4.1 + hhPh * 3.0 + position.x * 2.0);
  vec3 hhW = vec3(hhOff.x, -0.12 * length(hhOff) * min(hhH, 2.0) * 0.3, hhOff.y);
  transformed += (transpose(mat3(hhM)) * hhW) / (hhS * hhS);
`;
const PRE = /* glsl */ `
  #ifdef USE_INSTANCING
    mat4 hhM = modelMatrix * instanceMatrix;
  #else
    mat4 hhM = modelMatrix;
  #endif
  float hhS = max(length(hhM[1].xyz), 1e-4);
  float hhH = max(position.y, 0.0) * hhS;
`;

function inject(shader, { wind = false, ao = true, depth = false } = {}) {
  shader.uniforms.uTime = uniforms.uTime;
  shader.uniforms.uWind = uniforms.uWind;
  shader.uniforms.uWindDir = uniforms.uWindDir;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\nuniform float uTime;\nuniform float uWind;\nuniform vec2 uWindDir;\n${depth ? '' : 'varying float vHhAO;'}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${PRE}\n${depth ? '' : 'vHhAO = position.y * hhS;'}\n${wind ? WIND : ''}`);
  if (!depth && ao) {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vHhAO;')
      // cheap contact AO: darken the first half metre above the model's base
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix(0.58, 1.0, smoothstep(-0.02, 0.55, vHhAO));');
  }
}

function toon(params, key, opt) {
  const m = new THREE.MeshToonMaterial({ gradientMap: ramp, side: THREE.DoubleSide, ...params });
  if (key) {
    m.onBeforeCompile = sh => inject(sh, opt);
    m.customProgramCacheKey = () => key;   // the closures share source text, so key them explicitly
  }
  return m;
}

const foliageDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
foliageDepth.onBeforeCompile = sh => inject(sh, { wind: true, depth: true });
foliageDepth.customProgramCacheKey = () => 'hh-foliage-depth';

const emit = (hex) => new THREE.MeshBasicMaterial({ color: hex, side: THREE.DoubleSide });
export const mats = {
  static: toon({ vertexColors: true }, 'hh-static', { ao: true }),
  foliage: toon({ vertexColors: true }, 'hh-foliage', { ao: true, wind: true }),
  glass: new THREE.MeshPhongMaterial({ color: 0xbde6ff, transparent: true, opacity: 0.3, shininess: 90, specular: 0xffffff, depthWrite: false, side: THREE.DoubleSide }),
  net: toon({ color: 0x7fbf6a, transparent: true, opacity: 0.45, depthWrite: false }),
  emit: { warm: emit(0xffa040), eye: emit(0x66f0ff), fire: emit(0xff5010), gold: emit(0xffc040) },
  sail: toon({ color: 0xf2e6cf }),
  cloud: toon({ color: 0xffffff, fog: false, side: THREE.FrontSide }),
  shirt: toon({ color: 0x3a86c8 }, 'hh-static', { ao: true }),
  metal: toon({ color: 0x9aa3ab }, 'hh-static', { ao: true }),
  tint: toon({ color: 0xffffff }, 'hh-static', { ao: true }),
};
const TRANSPARENT = new Set(['glass', 'net']);
const isSpecial = n => n.startsWith('emit_') || ['glass', 'net', 'shirt', 'metal', 'tint', 'sail', 'cloud'].includes(n);
const specialMat = n => (n.startsWith('emit_') ? mats.emit[n.slice(5)] || mats.emit.warm : mats[n]);

// ---------------------------------------------------------------- loading
export async function loadAssets(onProgress = () => {}) {
  const [hj, gltf] = await Promise.all([
    fetch(window.HH_PACK?.heights || 'assets/heights.json').then(r => {   // HH_PACK: assets inlined by tools/build.py
      if (!r.ok) throw new Error('Could not load assets/heights.json (' + r.status + ')');
      return r.json();
    }),
    new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(window.HH_PACK?.glb || 'assets/models.glb', e => { if (e.total) onProgress(0.9 * e.loaded / e.total, 'Loading models'); }),
  ]);
  heights = hj;
  setHeights(hj);
  onProgress(0.92, 'Preparing the island');

  // pick the special material colours up from the Blender file
  gltf.scene.traverse(o => {
    if (!o.isMesh) return;
    const m = o.material, n = m.name || '';
    if (n.startsWith('emit_') && mats.emit[n.slice(5)]) {
      const c = m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0 ? m.emissive : m.color;
      const e = mats.emit[n.slice(5)];
      e.color.copy(c).multiplyScalar(m.emissiveIntensity || 1);
      e.userData.base = e.color.clone();
    } else if (['glass', 'net', 'sail', 'shirt', 'metal'].includes(n)) {
      mats[n].color.copy(m.color);
      if (TRANSPARENT.has(n)) mats[n].opacity = Math.max(0.2, m.opacity);
    }
  });
  for (const e of Object.values(mats.emit)) e.userData.base ||= e.color.clone();

  gltf.scene.updateMatrixWorld(true);
  for (const root of gltf.scene.children) {
    const plain = [], specials = new Map();
    root.traverse(o => {
      if (!o.isMesh) return;
      const name = o.material.name || '';
      const g = o.geometry.clone();
      for (const k of ['position', 'normal']) if (g.attributes[k]) g.setAttribute(k, toFloat(g.attributes[k]));   // meshopt stores them quantized
      g.applyMatrix4(o.matrixWorld);   // every model is exported at the origin; a meshopt node matrix also carries the dequantization scale
      for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
      if (!g.attributes.normal) g.computeVertexNormals();
      g.morphAttributes = {};
      if (isSpecial(name)) {
        if (!specials.has(name)) specials.set(name, []);
        specials.get(name).push(g);
      } else {
        const c = o.material.color, n = g.attributes.position.count, col = new Float32Array(n * 3);
        for (let k = 0; k < n; k++) { col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b; }   // glTF colours are already linear
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        plain.push(g);
      }
    });
    const box = new THREE.Box3();
    const geo = merge(plain);
    const sp = [...specials].map(([name, gs]) => ({ name, geo: merge(gs), mat: specialMat(name) }));
    for (const g of [geo, ...sp.map(s => s.geo)]) if (g) { g.computeBoundingBox(); g.computeBoundingSphere(); box.union(g.boundingBox); }
    if (box.isEmpty()) box.set(new THREE.Vector3(), new THREE.Vector3());
    lib[root.name] = { geo, specials: sp, size: box.getSize(new THREE.Vector3()), top: box.max.y, box };
  }
  onProgress(1, 'Ready');
  return lib;
}

// quantized (normalized int) attribute -> plain floats, so transforms and merging work in metres
function toFloat(a) {
  if (a.array instanceof Float32Array && !a.isInterleavedBufferAttribute) return a;
  const n = a.count, k = a.itemSize, out = new Float32Array(n * k);
  for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) out[i * k + c] = a.getComponent(i, c);
  return new THREE.BufferAttribute(out, k);
}

function merge(list) {
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const indexed = list.every(g => g.index);
  const parts = indexed ? list : list.map(g => (g.index ? g.toNonIndexed() : g));
  return mergeGeometries(parts, false);
}

// ---------------------------------------------------------------- meshes
const tintCache = new Map();
function partMat(s, opts) {
  const hex = opts?.tint?.[s.name];
  if (!hex) return s.mat;
  const key = s.name + '|' + hex;
  let m = tintCache.get(key);
  if (!m) { m = s.mat.clone(); m.color.set(hex); tintCache.set(key, m); }
  return m;
}
const castsShadow = (name, opts) => opts?.castShadow !== false && !TRANSPARENT.has(name);

export function makeMesh(name, opts = {}) {
  const g = new THREE.Group();
  g.name = name;
  const e = lib[name];
  if (!e) { console.warn('[assets] unknown model', name); return g; }
  if (e.geo) {
    const m = new THREE.Mesh(e.geo, opts.foliage ? mats.foliage : mats.static);
    m.castShadow = opts.castShadow !== false; m.receiveShadow = true;
    if (opts.foliage) m.customDepthMaterial = foliageDepth;
    g.add(m);
  }
  for (const s of e.specials) {
    const m = new THREE.Mesh(s.geo, partMat(s, opts));
    m.castShadow = castsShadow(s.name, opts); m.receiveShadow = !TRANSPARENT.has(s.name);
    m.userData.special = s.name;
    g.add(m);
  }
  return g;
}

const WHITE = new THREE.Color(1, 1, 1);
export function makeInstanced(name, capacity = 16, opts = {}) {
  const g = new THREE.Group();
  g.name = name + '#inst';
  const e = lib[name];
  if (!e) console.warn('[assets] unknown model', name);
  const parts = [];
  if (e?.geo) parts.push({ geo: e.geo, mat: opts.foliage ? mats.foliage : mats.static, cast: opts.castShadow !== false, recv: true, foliage: !!opts.foliage });
  for (const s of e?.specials || []) parts.push({ geo: s.geo, mat: partMat(s, opts), cast: castsShadow(s.name, opts), recv: !TRANSPARENT.has(s.name) });
  let n = 0;
  g.meshes = [];
  g.capacity = 0;

  const build = cap => {
    const old = g.meshes;
    g.meshes = parts.map((p, k) => {
      const im = new THREE.InstancedMesh(p.geo, p.mat, cap);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      im.castShadow = p.cast; im.receiveShadow = p.recv;
      if (p.foliage) im.customDepthMaterial = foliageDepth;
      if (old[k]) {
        im.instanceMatrix.array.set(old[k].instanceMatrix.array);
        im.instanceColor.array.set(old[k].instanceColor.array);
        g.remove(old[k]);
        old[k].dispose();
      }
      im.count = n;
      g.add(im);
      return im;
    });
    g.capacity = cap;
  };
  build(Math.max(1, capacity));

  g.setAt = (k, matrix, color) => {
    if (k >= g.capacity) build(Math.max(k + 1, g.capacity * 2));
    for (const im of g.meshes) {
      im.setMatrixAt(k, matrix);
      im.setColorAt(k, color || WHITE);
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor.needsUpdate = true;
      im.boundingSphere = null;   // recomputed lazily at the next cull test
    }
    if (k >= n) g.count(k + 1);
  };
  g.count = c => {
    if (c > g.capacity) build(Math.max(c, g.capacity * 2));
    n = c;
    for (const im of g.meshes) { im.count = c; im.boundingSphere = null; }
    return g;
  };
  g.getCount = () => n;
  return g;
}

// ---------------------------------------------------------------- thumbnails (96x96 PNG, transparent background)
const THUMB = 96;
const thumbCache = new Map();
let tr = null, tscene = null, tcam = null, goldMat = null;
const tBox = new THREE.Box3(), tSphere = new THREE.Sphere(), tDir = new THREE.Vector3(1, 0.72, 1.3).normalize();

export async function thumbnail(name, opts) {
  opts = opts || {};
  const key = name + JSON.stringify(opts);
  if (thumbCache.has(key)) return thumbCache.get(key);
  if (!tr) {
    tr = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    tr.setPixelRatio(1);
    tr.setSize(THUMB, THUMB, false);
    tr.setClearColor(0x000000, 0);
    tr.toneMapping = THREE.ACESFilmicToneMapping;
    tr.toneMappingExposure = 1.15;
    tscene = new THREE.Scene();
    tscene.add(new THREE.HemisphereLight(0xfff2e0, 0x6a5a48, 1.7));
    const key = new THREE.DirectionalLight(0xfff0dc, 2.4); key.position.set(3, 5, 4);
    const rim = new THREE.DirectionalLight(0x9fd8ff, 1.3); rim.position.set(-4, 2.5, -3);
    tscene.add(key, rim);
    tcam = new THREE.PerspectiveCamera(26, 1, 0.01, 200);
    goldMat = new THREE.MeshToonMaterial({ color: 0xf2c94c, emissive: 0x6a4300, gradientMap: ramp, side: THREE.DoubleSide });
  }
  const obj = makeMesh(name, { tint: opts.tint });
  if (opts.gold) obj.traverse(o => { if (o.isMesh && !o.userData.special?.startsWith('emit_')) o.material = goldMat; });
  tBox.setFromObject(obj);
  if (tBox.isEmpty()) tBox.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
  tBox.getBoundingSphere(tSphere);
  const dist = tSphere.radius / Math.sin(THREE.MathUtils.degToRad(tcam.fov / 2)) * 1.04;
  tcam.position.copy(tDir).multiplyScalar(dist).add(tSphere.center);
  tcam.near = dist / 50; tcam.far = dist * 4;
  tcam.updateProjectionMatrix();
  tcam.lookAt(tSphere.center);
  tscene.add(obj);
  tr.render(tscene, tcam);
  const url = tr.domElement.toDataURL('image/png');
  tscene.remove(obj);
  thumbCache.set(key, url);
  return url;
}
