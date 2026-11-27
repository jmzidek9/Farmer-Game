// Harvest Haven asset library: loads the Blender models (assets/models.glb) + heightmap, bakes every plain
// c_rrggbb material into one vertex-coloured geometry per model, and hands out meshes / instanced groups /
// UI thumbnails that all share a handful of soft toon materials.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { setHeights } from './terrain.js';

export const lib = {};
export let heights = null;   // raw heights.json ({n, step, off, h}) — world.js builds the water depth texture from it

export const uniforms = {
  uParallax: { value: 1 },   // settings slider: 0 = flat .. 2 = deep
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

// realistic ground textures baked in Blender (tools/make_ground_textures.py): 1 m seamless tiles.
// *_albedo: colour with crevice shadow; *_data: normal x/y in red/green, roughness in blue; *_height: for parallax.
const texLoader = new THREE.TextureLoader();
function groundTexture(name, color) {
  const t = texLoader.load(window.HH_PACK?.tex?.[name] || `assets/textures/${name}.jpg`);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}
export const groundTex = Object.fromEntries(['grass', 'soil', 'sand'].flatMap(n => [
  [n + 'A', groundTexture(n + '_albedo', true)], [n + 'D', groundTexture(n + '_data', false)], [n + 'H', groundTexture(n + '_height', false)]]));
// GLSL: sample a tile twice (second copy turned, scaled, shifted) and blend by noise so the repeat doesn't show.
// tileData returns the normal already turned back into the first copy's (= world) frame.
export const TILE_GLSL = `
  uniform float uParallax;
  const mat2 TILE_R = mat2(.8, .6, -.6, .8);
  vec4 tileAlbedo(sampler2D t, vec2 uv, float k){ return mix(texture2D(t, uv), texture2D(t, TILE_R * uv * .73 + vec2(.31, .57)), k); }
  vec3 tileData(sampler2D t, vec2 uv, float k){
    vec3 a = texture2D(t, uv).rgb, b = texture2D(t, TILE_R * uv * .73 + vec2(.31, .57)).rgb;
    vec2 na = a.rg * 2. - 1., nb = (b.rg * 2. - 1.) * TILE_R;
    return vec3(mix(na, nb, k), mix(a.b, b.b, k));
  }
  float tileHeight(sampler2D t, vec2 uv, float k){ return mix(texture2D(t, uv).r, texture2D(t, TILE_R * uv * .73 + vec2(.31, .57)).r, k); }
  // parallax occlusion: march the view ray down into the height map, return the shifted world position (xz).
  // q: world xz, sc: texture scale (uv = q * sc), V: surface->eye (world, ground is roughly level),
  // depth: metres from the top of the texture to the bottom, fade: 0 = off .. 1 = full
  vec2 pomQ(sampler2D ht, vec2 q, float sc, float k, vec3 V, float depth, float fade){
    if (fade <= 0. || uParallax <= 0.) return q;
    float vy = max(V.y, .22);
    float steps = mix(24., 8., vy);
    vec2 dir = -V.xz / vy * depth * fade * uParallax;   // total shift for the full depth
    float layer = 1. / steps, cur = 0.;
    vec2 off = vec2(0.);
    float d = 1. - tileHeight(ht, q * sc, k);
    for (int i = 0; i < 24; i++) {
      if (float(i) >= steps || cur >= d) break;
      off += dir * layer; cur += layer;
      d = 1. - tileHeight(ht, (q + off) * sc, k);
    }
    vec2 prev = off - dir * layer;                 // refine between the last two steps
    float after = d - cur, before = (1. - tileHeight(ht, (q + prev) * sc, k)) - (cur - layer);
    return q + mix(off, prev, clamp(after / (after - before + 1e-5), 0., 1.));
  }`;

// ---------------------------------------------------------------- model detail materials
// Every model part is tagged with what it is made of (vertex attribute mcat, see classify()) and painted with that
// material's baked detail texture (tools/make_material_textures.py): projected along the model's own axes
// (triplanar), tinted by the part's colour, with the texture's normals, roughness and parallax occlusion.
export const MAT_LAYERS = ['wood', 'bark', 'leaf', 'stone', 'thatch', 'fabric', 'metal', 'organic', 'plaster', 'cliff'];
export const MAT = Object.fromEntries(MAT_LAYERS.map((n, i) => [n, i]));
const MAT_TILE = [0.8, 0.6, 0.45, 1.0, 0.7, 0.35, 0.5, 0.25, 1.0, 5.0];          // metres per texture tile
const MAT_RANGE = [0.01, 0.028, 0.09, 0.032, 0.06, 0.009, 0.01, 0.012, 0.016, 0.19];   // height map range (tile units, from the bake)
const MAT_DEPTH = MAT_RANGE.map((r, i) => r * MAT_TILE[i]);                         // parallax depth, metres
const MAT_N = MAT_LAYERS.length, MAT_RES = 512;
export const matTex = {
  A: new THREE.DataArrayTexture(new Uint8Array(MAT_RES * MAT_RES * 4 * MAT_N), MAT_RES, MAT_RES, MAT_N),   // rgb: colour detail (x0.5), a: height
  D: new THREE.DataArrayTexture(new Uint8Array(MAT_RES * MAT_RES * 4 * MAT_N), MAT_RES, MAT_RES, MAT_N),   // rg: normal, b: roughness
};
for (const t of Object.values(matTex)) {
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 8;
}
uniforms.uDetailDist = { value: 60 };   // metres: model texture detail fades out by here (view distance setting)
async function loadMatTextures() {
  const img = (src, retry = 2) => new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => (retry ? img(src, retry - 1).then(ok, bad) : bad(new Error('texture ' + src))); i.src = src; });   // a dropped request gets another try
  const cv = document.createElement('canvas'); cv.width = cv.height = MAT_RES;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const read = async name => { cx.clearRect(0, 0, MAT_RES, MAT_RES); cx.drawImage(await img(window.HH_PACK?.tex?.[name] || `assets/textures/${name}.jpg`), 0, 0, MAT_RES, MAT_RES); return cx.getImageData(0, 0, MAT_RES, MAT_RES).data; };
  const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const LUT = Float32Array.from({ length: 256 }, (_, v) => lin(v));
  await Promise.all(MAT_LAYERS.map(async (name, L) => {
    const [a, d, h] = await Promise.all(['albedo', 'data', 'height'].map(k => read(`mat_${name}_${k}`)));
    const N = MAT_RES * MAT_RES, o = L * N * 4, A = matTex.A.image.data, Dd = matTex.D.image.data;
    const mean = [0, 0, 0];
    for (let k = 0; k < N; k++) for (let c = 0; c < 3; c++) mean[c] += LUT[a[k * 4 + c]];
    for (let c = 0; c < 3; c++) mean[c] /= N;
    for (let k = 0; k < N; k++) {   // colour detail relative to the tile's average, in linear light: 128 = unchanged
      for (let c = 0; c < 3; c++) A[o + k * 4 + c] = Math.min(255, LUT[a[k * 4 + c]] / mean[c] * 128);
      A[o + k * 4 + 3] = h[k * 4];
      Dd[o + k * 4] = d[k * 4]; Dd[o + k * 4 + 1] = d[k * 4 + 1]; Dd[o + k * 4 + 2] = d[k * 4 + 2]; Dd[o + k * 4 + 3] = 255;
    }
  }));
  matTex.A.needsUpdate = matTex.D.needsUpdate = true;
}
const MAT_GLSL_V = /* glsl */`
  varying vec3 vDP, vDN, vDV, vDR0, vDR1, vDR2; varying float vDCat, vDDist;
  #ifdef DETAIL_ATTR
    attribute float mcat;
  #endif`;
const MAT_GLSL_V_MAIN = /* glsl */`
  {
    #ifdef USE_INSTANCING
      mat4 dM = modelMatrix * instanceMatrix;
    #else
      mat4 dM = modelMatrix;
    #endif
    float dS = max(length(dM[0].xyz), 1e-4);
    mat3 dR = mat3(dM) / dS;
    vDP = position * dS; vDN = objectNormal;
    vDR0 = dR[0]; vDR1 = dR[1]; vDR2 = dR[2];
    vec3 dW = (dM * vec4(position, 1.)).xyz;
    vDV = transpose(dR) * (cameraPosition - dW);
    vDDist = length(cameraPosition - dW);
    #ifdef DETAIL_ATTR
      vDCat = mcat;
    #else
      vDCat = float(DETAIL_CAT);
    #endif
  }`;
// the detail sampler, shared by the models and the ground (mountain cliffs): triplanar along the given frame,
// parallax occlusion on the dominant projection. p: position (metres), n: unit normal, V: eye vector, all in one
// frame. Returns rgb = colour multiplier, a = crevice AO; tilt = normal tilt in that frame; rough = -1 if none.
export const MAT_FUNCS = /* glsl */`
  precision highp sampler2DArray;
  uniform sampler2DArray tMatA, tMatD; uniform float uMatTile[${MAT_N}], uMatDepth[${MAT_N}]; uniform float uDetailDist;   // (uParallax is declared by the including shader)
  vec4 dTA(vec2 uv, float L){ return texture(tMatA, vec3(uv, L)); }
  vec4 dTD(vec2 uv, float L){ return texture(tMatD, vec3(uv, L)); }
  float mh3(vec3 p){ p = fract(p * .3183099 + .1); p *= 17.; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float mnoise(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3. - 2. * f);
    return mix(mix(mix(mh3(i), mh3(i + vec3(1, 0, 0)), f.x), mix(mh3(i + vec3(0, 1, 0)), mh3(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(mh3(i + vec3(0, 0, 1)), mh3(i + vec3(1, 0, 1)), f.x), mix(mh3(i + vec3(0, 1, 1)), mh3(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
  vec4 triDetail(vec3 p, vec3 n, vec3 Vv, float dist, int Li, float strength, out vec3 tilt, out float rough){
    tilt = vec3(0.); rough = -1.;
    float fade = (1. - smoothstep(uDetailDist * .7, uDetailDist, dist)) * strength;
    if (fade <= 0.) return vec4(1.);
    float L = float(Li), sc = 1. / uMatTile[Li];
    vec3 w = pow(abs(n), vec3(4.)); w /= dot(w, vec3(1.));
    vec2 uvX = p.zy * sc, uvY = p.xz * sc, uvZ = p.xy * sc;
    bool big = Li == 9;   // cliff rock: break the repeat (bands wander up and down, a second scale blends in by patches)
    float k2 = 0.;
    if (big) {
      float wv = (mnoise(vec3(p.xz * .045, 3.)) - .5) * 2.2 + (mnoise(vec3(p.xz * .13, 7.)) - .5) * .6;
      uvX.y += wv; uvZ.y += wv;
      k2 = smoothstep(.35, .65, mnoise(p * .035 + 11.));
    }
    float pf = fade * (1. - smoothstep(6., 16., dist)) * uParallax;
    if (pf > 0.01) {
      vec3 V = normalize(Vv);
      vec2 vp; float vn; int ax;
      if (w.x > w.y && w.x > w.z) { vp = V.zy; vn = abs(V.x); ax = 0; }
      else if (w.y > w.z) { vp = V.xz; vn = abs(V.y); ax = 1; }
      else { vp = V.xy; vn = abs(V.z); ax = 2; }
      vec2 dir = -vp / max(vn, .25) * uMatDepth[Li] * sc * pf;
      vec2 uv0 = ax == 0 ? uvX : ax == 1 ? uvY : uvZ;
      float steps = mix(14., 5., vn), layer = 1. / steps, cur = 0.;
      vec2 off = vec2(0.); float d = 1. - dTA(uv0, L).a;
      for (int i = 0; i < 14; i++) { if (float(i) >= steps || cur >= d) break; off += dir * layer; cur += layer; d = 1. - dTA(uv0 + off, L).a; }
      vec2 prev = off - dir * layer;
      float after = d - cur, before = (1. - dTA(uv0 + prev, L).a) - (cur - layer);
      off = mix(off, prev, clamp(after / (after - before + 1e-5), 0., 1.));
      if (ax == 0) uvX += off; else if (ax == 1) uvY += off; else uvZ += off;
    }
    vec4 aX = dTA(uvX, L), aY = dTA(uvY, L), aZ = dTA(uvZ, L);
    vec4 tX = dTD(uvX, L), tY = dTD(uvY, L), tZ = dTD(uvZ, L);
    if (k2 > .01) {
      const vec2 O2 = vec2(.37, .61); const float S2 = .57;
      aX = mix(aX, dTA(uvX * S2 + O2, L), k2); aY = mix(aY, dTA(uvY * S2 + O2, L), k2); aZ = mix(aZ, dTA(uvZ * S2 + O2, L), k2);
      tX = mix(tX, dTD(uvX * S2 + O2, L), k2); tY = mix(tY, dTD(uvY * S2 + O2, L), k2); tZ = mix(tZ, dTD(uvZ * S2 + O2, L), k2);
    }
    vec4 a = aX * w.x + aY * w.y + aZ * w.z;
    vec2 nX = tX.rg * 2. - 1., nY = tY.rg * 2. - 1., nZ = tZ.rg * 2. - 1.;
    tilt = (vec3(0., nX.y, nX.x) * w.x + vec3(nY.x, 0., nY.y) * w.y + vec3(nZ.x, nZ.y, 0.) * w.z) * fade;
    rough = mix(-1., tX.b * w.x + tY.b * w.y + tZ.b * w.z, fade);
    vec3 cm = a.rgb * 2.;
    if (big) cm *= mix(vec3(.82, .84, .86), vec3(1.12, 1.08, 1.02), mnoise(p * .02 + 5.));   // broad light and dark patches of rock
    return vec4(mix(vec3(1.), cm, fade), mix(1., mix(.72, 1., smoothstep(.0, .55, a.a)), fade));
  }`;
export const matUniforms = () => ({ tMatA: { value: matTex.A }, tMatD: { value: matTex.D }, uMatTile: { value: MAT_TILE }, uMatDepth: { value: MAT_DEPTH },
  uDetailDist: uniforms.uDetailDist, uParallax: uniforms.uParallax });
const MAT_GLSL_F = /* glsl */`
  uniform float uParallax;
  ${MAT_FUNCS}
  varying vec3 vDP, vDN, vDV, vDR0, vDR1, vDR2; varying float vDCat, vDDist;
  vec3 dCol = vec3(1.); vec3 dNrm = vec3(0.); float dRough = -1., dAO = 1.;`;
const MAT_GLSL_F_MAIN = /* glsl */`
  {
    vec4 dd = triDetail(vDP, normalize(vDN) * (gl_FrontFacing ? 1. : -1.), vDV, vDDist, int(vDCat + .5), 1., dNrm, dRough);
    dCol = dd.rgb; dAO = dd.a; dNrm *= 1.4;
  }`;function detailize(sh, { attr = true, cat = 0, rough = true } = {}) {
  Object.assign(sh.uniforms, matUniforms());
  sh.defines = { ...(sh.defines || {}), ...(attr ? { DETAIL_ATTR: '' } : { DETAIL_CAT: cat }) };
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', `#include <common>\n${MAT_GLSL_V}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${MAT_GLSL_V_MAIN}`);
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>\n${MAT_GLSL_F}`)
    .replace('#include <color_fragment>', `#include <color_fragment>\n${MAT_GLSL_F_MAIN}\n diffuseColor.rgb *= dCol * dAO;`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      if (dot(dNrm, dNrm) > 0.) {
        vec3 on = normalize(normalize(vDN) * faceDirection + dNrm * faceDirection);
        normal = normalize((viewMatrix * vec4(mat3(vDR0, vDR1, vDR2) * on, 0.)).xyz);
      }`);
  if (rough) sh.fragmentShader = sh.fragmentShader.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n if (dRough >= 0.) roughnessFactor = mix(roughnessFactor, dRough, .7);');
}
// give any lit material the detail texture of one material (wildlife, coral, bushes built in code)
export function withDetail(mat, cat, key) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => { prev?.call(mat, sh, r); detailize(sh, { attr: false, cat }); };
  const pk = mat.customProgramCacheKey?.bind(mat);
  mat.customProgramCacheKey = () => (pk ? pk() : '') + '|detail-' + key + '-' + cat;
  return mat;
}

const foliageDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
foliageDepth.onBeforeCompile = sh => inject(sh, { wind: true, depth: true });
foliageDepth.customProgramCacheKey = () => 'hh-foliage-depth';

const emit = (hex) => new THREE.MeshBasicMaterial({ color: hex, side: THREE.DoubleSide });
// physically lit model material with the baked detail textures (cat: material layer when the geometry has no mcat)
function lit(params, key, opt = {}, cat = null) {
  const m = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.82, metalness: 0, ...params });
  m.onBeforeCompile = sh => { inject(sh, opt); detailize(sh, cat == null ? {} : { attr: false, cat }); };
  m.customProgramCacheKey = () => key + (cat == null ? '' : '-' + cat);
  return m;
}
export const mats = {
  static: lit({ vertexColors: true }, 'hh-static', { ao: true }),
  foliage: lit({ vertexColors: true }, 'hh-foliage', { ao: true, wind: true }),
  glass: new THREE.MeshPhongMaterial({ color: 0xbde6ff, transparent: true, opacity: 0.3, shininess: 90, specular: 0xffffff, depthWrite: false, side: THREE.DoubleSide }),
  net: toon({ color: 0x7fbf6a, transparent: true, opacity: 0.45, depthWrite: false }),
  emit: { warm: emit(0xffa040), eye: emit(0x66f0ff), fire: emit(0xff5010), gold: emit(0xffc040) },
  sail: lit({ color: 0xf2e6cf }, 'hh-sail', {}, MAT.fabric),
  cloud: toon({ color: 0xffffff, fog: false, side: THREE.FrontSide }),
  shirt: lit({ color: 0x3a86c8 }, 'hh-shirt', { ao: true }, MAT.fabric),
  metal: lit({ color: 0x9aa3ab, metalness: 0.75, roughness: 0.38 }, 'hh-metal', { ao: true }, MAT.metal),
  tint: lit({ color: 0xffffff }, 'hh-tint', { ao: true }, MAT.organic),
};
// leaf cards (tree crowns, bushes): the sprig atlas baked by tools/make_material_textures.py, cut out by its
// alpha, swaying in the wind; lit as one soft volume (see leafNormals) rather than as flat cards
const leafTex = texLoader.load(window.HH_PACK?.tex?.mat_leafcard_albedo || 'assets/textures/mat_leafcard_albedo.png');
leafTex.colorSpace = THREE.SRGBColorSpace; leafTex.anisotropy = 8;
mats.leafcard = new THREE.MeshStandardMaterial({ map: leafTex, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.7, metalness: 0 });
mats.leafcard.onBeforeCompile = sh => {
  inject(sh, { wind: true, ao: false });
  sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
    reflectedLight.indirectDiffuse += diffuseColor.rgb * .18;   // light through the leaves`);
};
mats.leafcard.customProgramCacheKey = () => 'hh-leafcard';
const leafDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: leafTex, alphaTest: 0.42, side: THREE.DoubleSide });
leafDepth.onBeforeCompile = sh => inject(sh, { wind: true, depth: true });
leafDepth.customProgramCacheKey = () => 'hh-leafcard-depth';
// card normals point out from the crown's middle, so the crown shades like a leafy ball, lit side to shaded side
function leafNormals(g) {
  g.computeBoundingBox();
  const c = g.boundingBox.getCenter(new THREE.Vector3()), p = g.attributes.position, n = new Float32Array(p.count * 3), v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.set(p.getX(i) - c.x, (p.getY(i) - c.y) * 1.3, p.getZ(i) - c.z).normalize().multiplyScalar(0.8); v.y += 0.35; v.normalize();
    n.set([v.x, v.y, v.z], i * 3);
  }
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
}
// what a model part is made of, from the model's name and the part's colour (glTF colours are linear)
const _hsl = {}, _c = new THREE.Color();
function classify(model, color) {
  _c.copy(color).convertLinearToSRGB().getHSL(_hsl);
  const { h, s, l } = _hsl, green = h > 0.17 && h < 0.47 && s > 0.15;
  if (/^(rock|ruin|stone|boulder)/.test(model)) return green ? MAT.leaf : MAT.stone;
  if (/^(donkey|dk_|player|pl_|trader$|crab|gull)/.test(model)) return s < 0.12 && l < 0.3 ? MAT.metal : MAT.organic;
  if (/^(tree_|palm|jungle|bush|fern|sapling|flower|grass|stump|log)/.test(model)) return green ? MAT.leaf : (h < 0.17 && s < 0.6 && l < 0.6) ? MAT.bark : MAT.organic;
  if (/^(crop_|produce|item_|seed|g_)/.test(model)) return green ? MAT.leaf : MAT.organic;
  if (green && s > 0.2) return MAT.leaf;
  if (s < 0.1) return l > 0.72 ? MAT.plaster : MAT.stone;
  if (h >= 0.03 && h < 0.12 && l < 0.6) return MAT.wood;
  if (h >= 0.07 && h < 0.18 && l >= 0.55) return MAT.thatch;
  return MAT.fabric;   // painted or dyed
}
// tilled soil beds: the baked soil texture projected from above, physically lit; watered beds (instance colour
// below 1) go darker and glossy instead of only darker
mats.soil = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
mats.soil.onBeforeCompile = sh => {
  sh.uniforms.uParallax = uniforms.uParallax;
  sh.uniforms.tSoilA = { value: groundTex.soilA }; sh.uniforms.tSoilD = { value: groundTex.soilD }; sh.uniforms.tSoilH = { value: groundTex.soilH };
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', `#include <common>
      varying vec3 vSW; varying vec3 vSN; varying vec3 vSZ; varying float vSWet, vSFz;`)
    .replace('#include <project_vertex>', `#include <project_vertex>
      #ifdef USE_INSTANCING
        mat4 sM = modelMatrix * instanceMatrix;
      #else
        mat4 sM = modelMatrix;
      #endif
      vSW = (sM * vec4(transformed, 1.)).xyz; vSN = normalize(mat3(sM) * objectNormal);
      vSZ = normalize(mat3(sM) * vec3(0., 0., 1.)); vSFz = position.z;   // furrows run along the model's x, 0.45 m apart in z
      vSWet = 0.;
      #ifdef USE_INSTANCING_COLOR
        vSWet = clamp((1. - instanceColor.r) / .38, 0., 1.);
      #endif`);
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>
      varying vec3 vSW; varying vec3 vSN; varying vec3 vSZ; varying float vSWet, vSFz; uniform sampler2D tSoilA, tSoilD, tSoilH;
      float sh1(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float sn1(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
        return mix(mix(sh1(i), sh1(i+vec2(1,0)), f.x), mix(sh1(i+vec2(0,1)), sh1(i+vec2(1,1)), f.x), f.y); }
      ${TILE_GLSL}`)
    .replace('#include <color_fragment>', `#include <color_fragment>
      float sk = smoothstep(.35, .65, sn1(vSW.xz * .31 + 5.));
      float up0 = smoothstep(.2, .7, vSN.y);
      vec3 sV = normalize(cameraPosition - vSW);
      vec2 sq = pomQ(tSoilH, vSW.xz, .8, sk, sV, .03, up0 * (1. - smoothstep(5., 14., length(cameraPosition - vSW)))) * .8;
      vec3 sTexC = tileAlbedo(tSoilA, sq, sk).rgb;
      vec3 sDat = tileData(tSoilD, sq, sk);
      float up = smoothstep(.2, .7, vSN.y);
      // model colour (ridge / crest / base, already darkened when wet) tints the texture
      diffuseColor.rgb = sTexC * diffuseColor.rgb / vec3(.105, .052, .022) * .55;
      float sRough = mix(.95, max(sDat.z, .8), up);
      // furrow profile: crest = 1, trough = -1; troughs sit in shadow and hold water when the bed is watered
      #ifdef SOIL_FLAT
        float fz = 0., fs = 0.;
      #else
        float fph = 6.2832 * (vSFz - .225) / .45, fz = cos(fph), fs = -sin(fph) * .42;
      #endif
      diffuseColor.rgb *= mix(.62, 1.1, fz * .5 + .5);
      float puddle = vSWet * smoothstep(-.35, -.75, fz) * smoothstep(.55, .3, sn1(vSW.xz * 2.3));
      diffuseColor.rgb *= 1. - puddle * .35;
      sRough = mix(sRough, .03, puddle);`)
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
      roughnessFactor = mix(sRough, .22, vSWet);`)
    .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
      float sSpec = mix(.25, 1., max(vSWet, puddle));
      material.specularColor *= sSpec; material.specularF90 = sSpec;`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      {
        vec2 tn = sDat.xy * 1.2 * up * (1. - vSWet * .4) * (1. - puddle);
        vec3 wn = normalize(normalize(vSN) * sqrt(max(1. - dot(tn, tn), .05)) + vec3(tn.x, 0., tn.y) + vSZ * fs * up * (1. - puddle));
        normal = normalize((viewMatrix * vec4(wn, 0.)).xyz);
      }`);
};
mats.soil.customProgramCacheKey = () => 'hh-soil';
mats.soilFlat = mats.soil.clone();   // the strips between beds across the furrows: no ridges
mats.soilFlat.defines = { SOIL_FLAT: '' };
mats.soilFlat.onBeforeCompile = mats.soil.onBeforeCompile;
mats.soilFlat.customProgramCacheKey = () => 'hh-soil-flat';
const isSoil = n => n.startsWith('soil_');
const soilMat = n => (/_(side|corner)$/.test(n) ? mats.soilFlat : mats.soil);
// soil lumps are flat-shaded low poly in the .glb; smooth their normals (by position, across colour seams) so ridges read as soft earth
function smoothNormals(g) {
  const p = g.attributes.position, nrm = g.attributes.normal, key = i => `${Math.round(p.getX(i) * 500)},${Math.round(p.getY(i) * 500)},${Math.round(p.getZ(i) * 500)}`;
  const acc = new Map();
  for (let i = 0; i < p.count; i++) { const k = key(i), a = acc.get(k) || [0, 0, 0]; a[0] += nrm.getX(i); a[1] += nrm.getY(i); a[2] += nrm.getZ(i); acc.set(k, a); }
  for (let i = 0; i < p.count; i++) { const a = acc.get(key(i)), l = Math.hypot(...a) || 1; nrm.setXYZ(i, a[0] / l, a[1] / l, a[2] / l); }
  nrm.needsUpdate = true;
}

const TRANSPARENT = new Set(['glass', 'net']);
const isSpecial = n => n.startsWith('emit_') || ['glass', 'net', 'shirt', 'metal', 'tint', 'sail', 'cloud', 'leafcard'].includes(n);
const specialMat = n => (n.startsWith('emit_') ? mats.emit[n.slice(5)] || mats.emit.warm : mats[n]);

// ---------------------------------------------------------------- loading
export async function loadAssets(onProgress = () => {}) {
  const [, , hj, gltf] = await Promise.all([
    loadMatTextures().then(() => null),
    new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(window.HH_PACK?.mountain || 'assets/mountain.glb').then(g => {   // tools/make_mountain.py
      g.scene.updateMatrixWorld(true);
      g.scene.traverse(o => { if (o.isMesh && !lib.mountain) { const geo = o.geometry; for (const k of ['position', 'normal', 'color']) if (geo.attributes[k]) geo.setAttribute(k, toFloat(geo.attributes[k])); geo.applyMatrix4(o.matrixWorld);
        if (o.matrixWorld.determinant() < 0 && geo.index) { const ix = geo.index.array; for (let k = 0; k < ix.length; k += 3) { const t = ix[k + 1]; ix[k + 1] = ix[k + 2]; ix[k + 2] = t; } }   // a mirrored node matrix turns the triangles inside out
        lib.mountain = { geo }; } });
    }).catch(e => console.warn('[assets] no mountain.glb', e)),
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
      for (const k of ['position', 'normal', 'uv']) if (g.attributes[k]) g.setAttribute(k, toFloat(g.attributes[k]));   // meshopt stores them quantized
      g.applyMatrix4(o.matrixWorld);   // every model is exported at the origin; a meshopt node matrix also carries the dequantization scale
      for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && !(k === 'uv' && name === 'leafcard')) g.deleteAttribute(k);
      if (!g.attributes.normal) g.computeVertexNormals();
      g.morphAttributes = {};
      if (isSpecial(name)) {
        if (!specials.has(name)) specials.set(name, []);
        specials.get(name).push(g);
      } else {
        const c = o.material.color, n = g.attributes.position.count, col = new Float32Array(n * 3);
        for (let k = 0; k < n; k++) { col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b; }   // glTF colours are already linear
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        g.setAttribute('mcat', new THREE.BufferAttribute(new Float32Array(n).fill(classify(root.name, c)), 1));
        plain.push(g);
      }
    });
    const box = new THREE.Box3();
    const geo = merge(plain);
    const sp = [...specials].map(([name, gs]) => ({ name, geo: merge(gs), mat: specialMat(name) }));
    for (const g of [geo, ...sp.map(s => s.geo)]) if (g) { g.computeBoundingBox(); g.computeBoundingSphere(); box.union(g.boundingBox); }
    if (box.isEmpty()) box.set(new THREE.Vector3(), new THREE.Vector3());
    if (geo && isSoil(root.name)) smoothNormals(geo);
    let mgeo = geo;
    if (geo && !isSoil(root.name)) { mgeo = toCreasedNormals(geo, 0.9); mgeo.boundingBox = geo.boundingBox; mgeo.boundingSphere = geo.boundingSphere; }   // round things shade round, hard edges stay hard
    for (const s of sp) if (s.name === 'leafcard') leafNormals(s.geo);
    lib[root.name] = { geo: mgeo, specials: sp, size: box.getSize(new THREE.Vector3()), top: box.max.y, box, soil: isSoil(root.name) && soilMat(root.name) };
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
  if (!m) { m = s.mat.clone(); m.color.set(hex); m.onBeforeCompile = s.mat.onBeforeCompile; m.customProgramCacheKey = s.mat.customProgramCacheKey; tintCache.set(key, m); }
  return m;
}
const castsShadow = (name, opts) => opts?.castShadow !== false && !TRANSPARENT.has(name);

export function makeMesh(name, opts = {}) {
  const g = new THREE.Group();
  g.name = name;
  const e = lib[name];
  if (!e) { console.warn('[assets] unknown model', name); return g; }
  if (e.geo) {
    const m = new THREE.Mesh(e.geo, e.soil ? e.soil : opts.foliage ? mats.foliage : mats.static);
    m.castShadow = opts.castShadow !== false; m.receiveShadow = true;
    if (opts.foliage) m.customDepthMaterial = foliageDepth;
    g.add(m);
  }
  for (const s of e.specials) {
    const m = new THREE.Mesh(s.geo, partMat(s, opts));
    m.castShadow = castsShadow(s.name, opts); m.receiveShadow = !TRANSPARENT.has(s.name);
    m.userData.special = s.name;
    if (s.name === 'leafcard') m.customDepthMaterial = leafDepth;
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
  if (e?.geo) parts.push({ geo: e.geo, mat: e.soil ? e.soil : opts.foliage ? mats.foliage : mats.static, cast: opts.castShadow !== false, recv: true, foliage: !!opts.foliage });
  for (const s of e?.specials || []) parts.push({ geo: s.geo, mat: partMat(s, opts), cast: castsShadow(s.name, opts), recv: !TRANSPARENT.has(s.name), depth: s.name === 'leafcard' ? leafDepth : null });
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
      if (p.depth) im.customDepthMaterial = p.depth;
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
