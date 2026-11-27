// Harvest Haven world: renderer, post-processing, sky + day/night, ocean, the island, scenery outside the
// farm grid, the pier + trader boat, the wreck, and weather visuals (rain, storm wind, distant lightning,
// heat haze, high tide).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeMesh, makeInstanced, lib, mats, uniforms, heights } from './assets.js';
import { heightAt, pathAt } from './terrain.js';
import { DAY_LEN, TIDE_HIGH, PIER, GRID, TILE, ORIGIN, ORIGIN_Z } from './data.js';

const C = h => new THREE.Color(h);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = x => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
function mulberry(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// sky palettes by time of day: [zenith, horizon, sun light, hemisphere sky, hemisphere ground]
const PAL = {
  night: ['#040820', '#1b3366', '#a9c4ff', '#33508c', '#121624'],   // moonlit: deep navy sky, blue horizon glow
  dawn: ['#34477f', '#f7a26a', '#ffb27a', '#8fa2cc', '#5a4636'],
  day: ['#2b7fe0', '#a6d6f6', '#fff1dc', '#b8dcff', '#8a7a5a'],
  dusk: ['#2f3570', '#ff7f50', '#ff9455', '#a487b4', '#5a3a30'],
};
const STORM = ['#3d4650', '#6b757c', '#9aa4ac', '#6d7680', '#3a3a36'];
const ACID = ['#3d4a2a', '#7b8a52', '#b8c890', '#76845a', '#3a3a26'];
const HEAT = ['#5a8fc0', '#f2d2a0', '#fff0c8', '#e8d8b8', '#9a7a50'];

export function createWorld(canvas, game) {
  // ---------------------------------------------------------------- renderer + cameras
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setSize(innerWidth, innerHeight, false);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xbfe4f0, 70, 420);
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 1600);
  camera.position.set(0, 30, 120);
  const vmScene = new THREE.Scene();
  const vmCamera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 10);
  const vmHemi = new THREE.HemisphereLight(0xfff1dc, 0x5a4a3a, 1.4);
  const vmSun = new THREE.DirectionalLight(0xfff3e0, 2.0);
  vmSun.position.set(0.6, 1, 0.4);
  vmScene.add(vmHemi, vmSun);

  const world = {
    renderer, scene, camera, vmScene, vmCamera,
    sunDir: new THREE.Vector3(0.3, 0.8, 0.3).normalize(),
    cine: { letterbox: 0, fade: 0, title: '' },
    groundGroup: new THREE.Group(),
  };
  scene.add(world.groundGroup);
  world.addToScene = obj => scene.add(obj);

  // ---------------------------------------------------------------- lights
  const hemi = new THREE.HemisphereLight(0xbfe0ff, 0x8a7a5a, 1.1);
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  sun.castShadow = true;
  const sc = sun.shadow.camera;
  sc.left = -48; sc.right = 48; sc.top = 48; sc.bottom = -48; sc.near = 1; sc.far = 320;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(hemi, sun, sun.target);

  // ---------------------------------------------------------------- sky dome (gradient + sun + moon + stars)
  const skyU = {
    uZenith: { value: C(PAL.day[0]) }, uHorizon: { value: C(PAL.day[1]) }, uSunDir: { value: new THREE.Vector3() },
    uSunCol: { value: C('#fff1dc') }, uDay: { value: 1 }, uTime: uniforms.uTime, uCloudy: { value: 0 },
  };
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1400, 48, 24), new THREE.ShaderMaterial({
    uniforms: skyU, side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: /* glsl */`varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.); gl_Position = p.xyww; }`,
    fragmentShader: /* glsl */`
      uniform vec3 uZenith, uHorizon, uSunDir, uSunCol; uniform float uDay, uTime, uCloudy; varying vec3 vDir;
      float hash(vec3 p){ p = fract(p*0.3183099+.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
      void main(){
        vec3 d = normalize(vDir);
        float h = clamp(d.y, -0.2, 1.0);
        vec3 col = mix(uHorizon, uZenith, pow(smoothstep(-0.05, 0.75, h), 0.7));
        col = mix(col, uHorizon * 0.55, smoothstep(0.0, -0.2, d.y));
        float sd = dot(d, uSunDir);
        // sun: disc + glow, warm halo near the horizon
        float disc = smoothstep(0.9993, 0.9997, sd);
        col += uSunCol * (pow(max(sd, 0.), 9.) * 0.35 + pow(max(sd, 0.), 200.) * 1.2) * (1. - uCloudy * 0.85);
        col += uSunCol * disc * 8. * step(0., uSunDir.y + 0.05) * (1. - uCloudy);
        // moon opposite the sun, stars at night
        float md = dot(d, -uSunDir);
        float night = 1. - uDay;
        float clear = night * (1. - uCloudy);
        float moon = smoothstep(0.99915, 0.9995, md);
        vec3 mp = floor(d * 900.);
        float crater = 0.82 + 0.18 * hash(mp);                     // a little mottling on the disc
        col += vec3(0.92, 0.95, 1.0) * moon * 3.2 * crater * clear;
        col += vec3(0.45, 0.58, 0.95) * (pow(max(md, 0.), 80.) * 0.5 + pow(max(md, 0.), 8.) * 0.12) * clear;   // halo
        // the milky way: a soft, grainy band across the sky
        vec3 bandN = normalize(vec3(0.35, 0.25, 0.9));
        float band = exp(-pow(dot(d, bandN) / 0.16, 2.)) * smoothstep(-0.05, 0.3, d.y);
        float grain = hash(floor(d * 260.)) * 0.6 + hash(floor(d * 70.)) * 0.4;
        col += vec3(0.42, 0.45, 0.65) * band * (0.25 + 0.55 * grain) * 0.35 * clear;
        vec3 sp = floor(d * 380.);
        float st = step(0.9978 - band * 0.004, hash(sp)) * smoothstep(0.0, 0.25, d.y);
        float tw = 0.55 + 0.45 * sin(uTime * 3. + hash(sp + 1.) * 40.);
        col += vec3(0.9, 0.95, 1.0) * st * tw * (1.2 + hash(sp + 2.) * 1.2) * clear;
        gl_FragColor = vec4(col, 1.);
      }`,
  }));
  sky.renderOrder = -10;
  scene.add(sky);

  const n = heights.n;
  const hdata = new Float32Array(n * n * 2);   // r: ground height, g: mountain-path mask
  for (let k = 0; k < n * n; k++) { hdata[k * 2] = heights.h[k]; hdata[k * 2 + 1] = heights.p?.[k] || 0; }
  const htex = new THREE.DataTexture(hdata, n, n, THREE.RGFormat, THREE.FloatType);
  htex.minFilter = htex.magFilter = THREE.LinearFilter;
  htex.needsUpdate = true;

  // ---------------------------------------------------------------- the island
  // ground colour comes from a shader (height, slope, soft noise), not the flat per-triangle Blender colours.
  // Close to the camera a fine 'detail' mesh (25 cm grid, follows the camera) raises real sand ripples, dunes,
  // grass clumps and a little turf lip out of the geometry; the coarse island is cut away underneath it.
  const NOISE = `
        float gh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float gn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
          return mix(mix(gh(i), gh(i+vec2(1,0)), f.x), mix(gh(i+vec2(0,1)), gh(i+vec2(1,1)), f.x), f.y); }
        float gf(vec2 p){ return gn(p) * .55 + gn(p * 2.03 + 7.1) * .3 + gn(p * 4.1 + 3.7) * .15; }
        vec2 grassStrokes(vec2 g, float seed){   // short painted blades lying flat: x = coverage, y = how near the tip
          vec2 id = floor(g); float best = 0., tipv = 0.;
          for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
            vec2 c = id + vec2(float(i), float(j));
            vec2 ctr = c + .5 + (vec2(gh(c + seed), gh(c + seed + 3.1)) - .5) * .8;
            float a = gh(c + seed + 5.7) * 6.2832, L = .45 + gh(c + seed + 8.3) * .3;
            vec2 dir = vec2(cos(a), sin(a)), p0 = ctr - dir * L * .5;
            float t = clamp(dot(g - p0, dir) / L, 0., 1.);
            float d = length(g - (p0 + dir * L * t)), w = .11 * (1. - t * .85);
            float b = smoothstep(w, w * .35, d);
            if (b > best) { best = b; tipv = t; }
          }
          return vec2(best, tipv);
        }
        uniform sampler2D uSoil; uniform vec3 uSoilInfo;
        float soilAt(vec2 q){ vec2 uv = (q - uSoilInfo.xy) / uSoilInfo.z;
          if (any(lessThan(uv, vec2(0.))) || any(greaterThan(uv, vec2(1.)))) return 0.;
          return smoothstep(.44, .56, texture2D(uSoil, uv).r); }   // crisp: switches right at the tile edge
        float gEdge(vec2 q){ return .82 + (gf(q * .045) - .5) * .14 + (gf(q * .35 + 3.3) - .5) * .16 + (gn(q * 1.7) - .5) * .05; }`;
  const patchU = { uPatchC: { value: new THREE.Vector2() }, uPatchR: { value: 0 } };
  const PATCH = 64, PATCH_SEG = 256;
  const waterLU = { value: 0 }, caustU = { value: 1 };   // water level + sunlight for the seabed caustics
  // which farm tiles are soil: the ground under a soil bed sinks and turns to dirt, so no grass pokes up between beds
  const soilData = new Uint8Array(GRID * GRID);
  const soilTex = new THREE.DataTexture(soilData, GRID, GRID, THREE.RedFormat);
  soilTex.minFilter = soilTex.magFilter = THREE.LinearFilter;
  soilTex.needsUpdate = true;
  const soilU = { uSoil: { value: soilTex }, uSoilInfo: { value: new THREE.Vector3(ORIGIN, ORIGIN_Z, GRID * TILE) } };
  world.setSoil = (k, on) => { const v = on ? 255 : 0; if (soilData[k] !== v) { soilData[k] = v; soilTex.needsUpdate = true; } };
  function groundMat(detail) {
    const mat = new THREE.MeshToonMaterial({ gradientMap: mats.static.gradientMap });
    if (detail) mat.defines = { GROUND_DETAIL: '' };
    mat.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, patchU, { uH: { value: htex }, uCTime: uniforms.uTime, uWaterL: waterLU, uCaust: caustU, ...soilU });
      sh.uniforms.uHInfo = { value: new THREE.Vector3(heights.off, heights.step, heights.n) };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          varying vec3 vGW; varying vec3 vGN; varying float vBaseH; varying float vPath;
          uniform vec2 uPatchC; uniform float uPatchR; uniform sampler2D uH; uniform vec3 uHInfo;
          ${NOISE}
          float baseH(vec2 p){                       // bilinear over the height grid, same samples as the island mesh
            vec2 g = clamp((p - uHInfo.x) / uHInfo.y, vec2(0.), vec2(uHInfo.z - 1.001));
            vec2 i = floor(g), f = g - i; float n = uHInfo.z;
            float a = texture2D(uH, (i + vec2(.5, .5)) / n).r, b = texture2D(uH, (i + vec2(1.5, .5)) / n).r;
            float c = texture2D(uH, (i + vec2(.5, 1.5)) / n).r, d = texture2D(uH, (i + vec2(1.5, 1.5)) / n).r;
            return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
          }
          float detailH(vec2 q, float h){            // always >= 0: ripples + dunes on sand, clumps + a turf lip on grass
            float edge = gEdge(q), toGrass = smoothstep(edge - .02, edge + .02, h);
            float warp = gf(q * .3) * 5.;
            float rip = sin(dot(q, vec2(.83, .55)) * 4.2 + warp) * .5 + .5;
            float sand = (rip * rip * .035 + gf(q * .09 + 5.) * .05) * smoothstep(.3, .55, h) * (1. - smoothstep(edge - .12, edge, h) * .6);
            float grass = .025 + gf(q * 1.15) * .04 + gn(q * 3.1) * .02;
            float fade = 1. - smoothstep(uPatchR * .62, uPatchR * .92, max(abs(q.x - uPatchC.x), abs(q.y - uPatchC.y)));
            return mix(sand, grass, toGrass) * fade * smoothstep(.1, .3, h);
          }
          float groundH(vec2 q){ float h = baseH(q), sm = soilAt(q); return h + detailH(q, h) * (1. - sm) - .14 * sm + .004; }`)
        .replace('#include <beginnormal_vertex>', `
          #ifdef GROUND_DETAIL
            vec2 wq = (modelMatrix * vec4(position, 1.)).xz;
            float th = groundH(wq), e = .1;
            vec3 objectNormal = normalize(vec3(th - groundH(wq + vec2(e, 0.)), e, th - groundH(wq + vec2(0., e))));
          #else
            vec3 objectNormal = vec3(normal);
          #endif`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          #ifdef GROUND_DETAIL
            transformed.y = th - modelMatrix[3].y;
            vBaseH = baseH(wq);
          #endif
          vGW = (modelMatrix * vec4(transformed, 1.)).xyz; vGN = normalize(mat3(modelMatrix) * objectNormal);
          #ifndef GROUND_DETAIL
            vBaseH = vGW.y;
          #endif
          vPath = texture2D(uH, ((vGW.xz - uHInfo.x) / uHInfo.y + .5) / uHInfo.z).g;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vGW; varying vec3 vGN; varying float vBaseH; varying float vPath;
          uniform vec2 uPatchC; uniform float uPatchR; uniform float uCTime, uWaterL, uCaust;
          ${NOISE}`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          #ifndef GROUND_DETAIL
            if (max(abs(vGW.x - uPatchC.x), abs(vGW.z - uPatchC.y)) < uPatchR - .3) discard;   // the detail mesh is drawn here
          #endif`)
        .replace('#include <color_fragment>', `#include <color_fragment>
        float gBump = 0.;
        {
          vec2 q = vGW.xz; float h = vBaseH, slope = 1. - clamp(vGN.y, 0., 1.);
          float big = gf(q * .045), mid = gf(q * .21), fine = gn(q * 2.7);
          // the grass line: follows height, wavy at two scales, with a ragged fringe
          float edge = gEdge(q);
          float near = 1. - clamp(abs(h - edge) / .14, 0., 1.);       // 1 right at the grass line
          // grass: meadows, sun-dried patches, clumps that catch the light
          float clump = gf(q * 1.15) * .65 + gn(q * 5.3) * .35;
          vec3 grass = mix(vec3(.25, .47, .18), vec3(.44, .65, .25), smoothstep(.25, .75, big));
          grass = mix(grass, vec3(.62, .68, .32), smoothstep(.6, .8, gf(q * .02 + 11.)) * .6);
          grass = mix(grass, vec3(.58, .64, .3), near * .45);           // drier where it meets the sand
          grass *= .78 + clump * .3 + fine * .08;
          // painted blades (two sizes), lighter tips, clover patches with a few white flowers; fades out with distance
          vec2 bl = grassStrokes(q * 7.5, 0.), bl2 = grassStrokes(q * 13. + 4.7, 9.);
          float bFade = 1. - smoothstep(9., 28., length(vGW - cameraPosition));
          float blade = max(bl.x, bl2.x * .8), tip = max(bl.y * bl.x, bl2.y * bl2.x);
          grass *= 1. + (blade - .5) * .16 * bFade;
          grass = mix(grass, grass * vec3(1.2, 1.17, .88), tip * .5 * bFade);
          float clover = smoothstep(.6, .75, gf(q * .38 + 20.)) * (.6 + gn(q * 6.) * .4);
          grass = mix(grass, grass * vec3(.82, .95, .85), clover * .5);
          vec2 cc = floor(q * 4.), cfr = fract(q * 4.) - .5 + (vec2(gh(cc + 2.), gh(cc + 4.)) - .5) * .6;
          grass = mix(grass, vec3(.97, .96, .88), smoothstep(.6, .7, clover) * step(.88, gh(cc + 7.)) * smoothstep(.07, .02, length(cfr)) * bFade);
          // sand: grain, wind ripples, dunes, pebble and shell speckles, a wet band at the waterline
          vec2 wd = vec2(.83, .55);
          float warp = gf(q * .3) * 5.;
          float rip = sin(dot(q, wd) * 4.2 + warp) * .5 + .5;
          rip = rip * rip * (1. - smoothstep(.45, .2, h)) * (1. - near * .7);
          float dune = gf(q * .09 + 5.);
          vec3 sand = mix(vec3(.92, .83, .61), vec3(.98, .91, .74), mid * .6 + dune * .4) * (.93 + fine * .08);
          sand *= .93 + rip * .11;
          vec2 cell = floor(q * 6.), cf = fract(q * 6.) - .5 + (vec2(gh(cell + 3.), gh(cell + 5.)) - .5) * .5;
          float speck = step(.94, gh(cell)) * smoothstep(.16, .08, length(cf));
          sand = mix(sand, mix(vec3(.6, .53, .44), vec3(.99, .96, .9), gh(cell + 1.)), speck * .55 * (1. - near));
          sand = mix(sand, vec3(.8, .71, .5), near * .45);              // sandy soil under the first grass
          sand = mix(sand, vec3(.74, .62, .43), smoothstep(.55, .25, h) * .8);
          float toGrass = smoothstep(edge - .02, edge + .02, h);
          vec3 seabed = mix(vec3(.80, .72, .52), vec3(.70, .66, .50), mid);
          vec3 rock = mix(vec3(.47, .46, .42), vec3(.62, .61, .55), gf(q * .3)) * (.9 + fine * .12);
          vec3 c = mix(sand, grass, toGrass);
          float soilM = soilAt(q);
          c = mix(c, vec3(.34, .23, .15) * (.9 + fine * .15), soilM);   // dark earth under (and between) the soil beds
          c = mix(seabed, c, smoothstep(.05, .3, h));
          float low = 1. - smoothstep(6., 24., h + (big - .5) * 10.);      // grass holds on steeper ground in the foothills
          float rockAmt = max(smoothstep(.42 + low * .2, .6 + low * .2, slope + (mid - .5) * .2), smoothstep(22., 30., h + mid * 6.) * smoothstep(.12, .3, slope));
          c = mix(c, rock, rockAmt);
          // the mountain trail: packed earth with worn edges and pebbles
          float trail = smoothstep(.15, .65, vPath + (gn(q * 1.9) - .5) * .35);
          vec3 dirt = mix(vec3(.52, .4, .28), vec3(.66, .54, .38), mid) * (.88 + fine * .16);
          dirt = mix(dirt, vec3(.72, .68, .6), speck * .6);
          c = mix(c, dirt, trail);
          rockAmt *= 1. - trail;
          // under the water: tinted by it, with rippling caustic light in the sun
          float uw = uWaterL - h;
          if (uw > 0.) {
            float ct = uCTime * .55; vec2 cq = q * .6;
            float c1 = sin(cq.x * 1.3 + ct + sin(cq.y * .9 - ct * .7) * 2.) * sin(cq.y * 1.1 - ct * .8 + sin(cq.x * .7 + ct * .5) * 2.);
            float c2 = sin(cq.x * .9 - ct * .6 + sin(cq.y * 1.4 + ct * .4) * 1.7) * sin(cq.y * 1.5 + ct * .7 + sin(cq.x * 1.2 - ct * .3) * 1.6);
            float ca = pow(1. - abs(c1), 10.) + pow(1. - abs(c2), 10.);
            c *= mix(vec3(1.), vec3(.78, .93, .95), smoothstep(0., 1.2, uw));
            c += vec3(.95, 1., .92) * ca * .38 * smoothstep(0., .2, uw) * exp(-uw * .6) * uCaust;
          }
          diffuseColor.rgb = pow(c, vec3(2.2));   // picked as sRGB, lit in linear
          gBump = mix(rip * .02 + dune * .06, clump * .03 + blade * bFade * .012, toGrass) * (1. - rockAmt) * (1. - soilM) * smoothstep(.1, .35, h);
        }`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {   // bump from gBump using screen-space derivatives (no textures)
          vec3 sp = -vViewPosition, sx = dFdx(sp), sy = dFdy(sp);
          vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);
          float det = dot(sx, r1);
          vec3 g = sign(det) * (dFdx(gBump) * r1 + dFdy(gBump) * r2);
          normal = normalize(abs(det) * normal - g);
        }`);
    };
    return mat;
  }
  const islandMat = groundMat(false);
  const islandGeo = lib.island.geo.clone();
  for (const k of Object.keys(islandGeo.attributes)) if (k !== 'position') islandGeo.deleteAttribute(k);
  const island = new THREE.Mesh(mergeVertices(islandGeo), islandMat);
  island.geometry.computeVertexNormals();
  island.receiveShadow = true; island.castShadow = true;
  island.name = 'island';
  world.groundGroup.add(island);
  const detail = new THREE.Mesh(new THREE.PlaneGeometry(PATCH, PATCH, PATCH_SEG, PATCH_SEG).rotateX(-Math.PI / 2), groundMat(true));
  detail.receiveShadow = true; detail.castShadow = false; detail.frustumCulled = false; detail.name = 'ground-detail';
  scene.add(detail);
  world.setGroundDetail = on => { detail.visible = on; patchU.uPatchR.value = on ? PATCH / 2 : 0; };
  world.setGroundDetail(true);
  const followDetail = () => {
    const st = PATCH / PATCH_SEG, c = camera.position;
    detail.position.set(Math.round(c.x / st) * st, 0, Math.round(c.z / st) * st);
    patchU.uPatchC.value.set(detail.position.x, detail.position.z);
  };

  // ---------------------------------------------------------------- ocean (covers the river and pond too)
  // One water surface for sea, river and pond. Vertex: gentle swell (same formula as world.waveAt), damped in the
  // shallows. Fragment: per-pixel depth from the height map, smooth layered ripples (flowing downstream in the
  // river), clear turquoise shallows over the sand, sky reflection with fresnel, sun glare and glints, light
  // through the crests, thin lapping foam lines at the shore, whitecaps in storms.
  const span = (n - 1) * heights.step;
  const waterU = {
    uTime: uniforms.uTime, uLevel: { value: 0 }, uH: { value: htex }, uOff: { value: heights.off }, uSpan: { value: span },
    uSunDir: { value: new THREE.Vector3() }, uSunCol: { value: C('#fff1dc') }, uSky: { value: C('#bfe4f0') }, uZenith: { value: C('#2b7fe0') },
    uLight: { value: 1 }, uFogColor: { value: C('#bfe4f0') }, uFogNear: { value: 70 }, uFogFar: { value: 420 },
    uRough: { value: 0 }, uTint: { value: C('#ffffff') },
  };
  const WSEG = 5;   // the mesh follows the camera in 5 m steps (dense near you, no swimming)
  const water = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600, 320, 320).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
    uniforms: waterU, transparent: true,
    vertexShader: /* glsl */`
      uniform float uTime, uLevel, uOff, uSpan, uRough; uniform sampler2D uH;
      varying vec3 vW; varying float vCrest;
      float ground(vec2 p){ vec2 uv = (p - uOff) / uSpan; if (any(lessThan(uv, vec2(0.))) || any(greaterThan(uv, vec2(1.)))) return -7.; return texture2D(uH, uv).r; }
      void main(){
        vec3 p = (modelMatrix * vec4(position, 1.)).xyz;
        float depth = uLevel - ground(p.xz);
        float amp = clamp(depth / 4., 0.08, 1.) * (0.18 + uRough * 0.35);
        float w = sin(dot(p.xz, vec2(0.11, 0.05)) + uTime * 0.9) + 0.6 * sin(dot(p.xz, vec2(-0.07, 0.13)) + uTime * 1.3) + 0.3 * sin(dot(p.xz, vec2(0.21, -0.17)) + uTime * 2.1);
        p.y = uLevel + w * amp;
        vW = p; vCrest = w / 1.9 * clamp(depth / 2., 0., 1.);
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.);
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uLight, uFogNear, uFogFar, uRough, uLevel, uOff, uSpan;
      uniform vec3 uSunDir, uSunCol, uSky, uZenith, uFogColor, uTint; uniform sampler2D uH;
      varying vec3 vW; varying float vCrest;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * f * (f * (f * 6. - 15.) + 10.);   // quintic: no creases
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y); }
      float ground(vec2 p){ vec2 uv = (p - uOff) / uSpan; if (any(lessThan(uv, vec2(0.))) || any(greaterThan(uv, vec2(1.)))) return -7.; return texture2D(uH, uv).r; }
      float riverX(float z){ float k = z >= 0. ? 0. : z <= -20. ? 1. : smoothstep(0., 1., -z / 20.);
        return 31. + .5 * sin(z * .15) * (1. - k) + k * (7. * sin(z * .06 + .4) + 2.5 * sin(z * .17 + 1.1)); }
      const mat2 R1 = mat2(.8, -.6, .6, .8);
      float rip(vec2 q, float t, float detail){
        float h = vn(q * .2 + vec2(t * .05, t * .03));
        h += vn(R1 * q * .45 - vec2(t * .09, -t * .06)) * .5;
        if (detail > 0.) {
          h += vn(R1 * R1 * q * 1.0 + vec2(-t * .13, t * .16)) * .27 * detail;
          h += vn(R1 * q * 2.3 + vec2(t * .26, t * .21)) * .13 * detail;
        }
        return h;
      }
      // ripples that drift along a flow direction; two phases cross-fade so they never stretch out
      vec2 ripN(vec2 q, vec2 flow, float t, float detail){
        float e = .12;
        vec2 g = vec2(0.);
        if (dot(flow, flow) < 1e-4) {   // still water: one pass
          float h0 = rip(q, t, detail);
          return vec2(rip(q + vec2(e, 0.), t, detail) - h0, rip(q + vec2(0., e), t, detail) - h0) / e;
        }
        for (int k = 0; k < 2; k++) {
          float ph = fract(t * .2 + float(k) * .5), wt = 1. - abs(2. * ph - 1.);
          vec2 o = q - flow * ph * 6.;
          float h0 = rip(o, t, detail);
          g += vec2(rip(o + vec2(e, 0.), t, detail) - h0, rip(o + vec2(0., e), t, detail) - h0) / e * wt;
        }
        return g;
      }
      void main(){
        float t = uTime;
        vec2 q = vW.xz;
        vec3 toCam = cameraPosition - vW;
        float dist = length(toCam);
        vec3 V = toCam / dist;
        float d = max(uLevel - ground(q), 0.);
        float detail = 1. - smoothstep(25., 140., dist);
        // river flow: downstream (+z) along the river's course
        float rx = riverX(max(q.y, -46.)), along = (riverX(q.y + 1.) - riverX(q.y - 1.)) * .5;
        float inRiver = (1. - smoothstep(3.5, 7., abs(q.x - rx))) * step(-50., q.y) * (1. - smoothstep(76., 88., q.y));
        vec2 flow = normalize(vec2(along, 1.)) * inRiver * 1.4;
        // swell slope (analytic, matches the vertex waves) + ripples
        float amp = clamp(d / 4., 0.08, 1.) * (0.18 + uRough * 0.35);
        float a1 = dot(q, vec2(0.11, 0.05)) + t * 0.9, a2 = dot(q, vec2(-0.07, 0.13)) + t * 1.3, a3 = dot(q, vec2(0.21, -0.17)) + t * 2.1;
        vec2 sw = (cos(a1) * vec2(0.11, 0.05) + 0.6 * cos(a2) * vec2(-0.07, 0.13) + 0.3 * cos(a3) * vec2(0.21, -0.17)) * amp;
        vec2 rp = ripN(q, flow, t, detail) * mix(.2, .07, smoothstep(10., 260., dist)) * (1. + uRough * 1.8 + inRiver * .4);
        vec3 N = normalize(vec3(-(sw.x + rp.x), 1., -(sw.y + rp.y)));
        float NdV = max(dot(N, V), 0.);
        // body colour: clear turquoise over sand, deepening to blue
        vec3 shallowC = vec3(.22, .84, .78), midC = vec3(.0, .5, .72), deepC = vec3(.0, .2, .5);
        vec3 body = mix(shallowC, midC, 1. - exp(-d * .8));
        body = mix(body, deepC, 1. - exp(-max(d - 1.2, 0.) * .3));
        body *= uTint * mix(vec3(1.), uSky * 1.25, .4);   // the water takes on the sky's mood (warm at sunset, blue at night)
        // light through the crests when looking toward the sun
        vec3 sunFlat = normalize(vec3(uSunDir.x, 0.001, uSunDir.z));
        float sss = pow(max(dot(-V, sunFlat), 0.), 3.) * clamp(vCrest * .5 + .5, 0., 1.) * step(0., uSunDir.y);
        vec3 col = body * uLight + shallowC * sss * .35 * uLight;
        // sky reflection, stronger at grazing angles
        vec3 Rv = reflect(-V, N);
        vec3 sky = mix(uSky, uZenith, smoothstep(0., .3, Rv.y));
        float F = .02 + .98 * pow(1. - NdV, 5.);
        col = mix(col, sky, clamp(F * .65, 0., 1.));   // reflection holds back a little: the water keeps its colour
        // the sun (or moon): tight hot spot, soft glare, and glints on the ripples
        vec3 Hh = normalize(uSunDir + V);
        float ndh = max(dot(N, Hh), 0.);
        float glint = smoothstep(.9, 1., vn(q * 5. + vec2(t * 1.7, -t * 1.3))) * pow(ndh, 30.) * detail;
        col += uSunCol * (pow(ndh, 700.) * 5. + pow(ndh, 70.) * .3 + glint * 1.6) * step(0., uSunDir.y);
        // shoreline: thin foam lines lapping in and out, a bright rim right at the waterline
        float lap = sin(d * 11. - t * 1.6 + vn(q * .5) * 6.) * .5 + .5;
        float edge = smoothstep(.45, 0., d);
        float foam = edge * smoothstep(.55, .92, lap) * (.6 + .4 * vn(q * 2.5 + t * .2)) + smoothstep(.16, .02, d) * (.55 + .45 * vn(q * 4. - t * .3));
        foam += uRough * smoothstep(.72, .95, vn(q * .7 + vec2(t * .4, t * .25))) * .7 * (1. - edge);   // whitecaps in storms
        foam += inRiver * smoothstep(.8, .97, vn(q * 1.2 - flow * t * 1.5)) * .18 * detail;         // flecks drifting downstream
        foam = clamp(foam, 0., 1.);
        col = mix(col, vec3(.95, .98, 1.) * max(uLight, .3), foam * .7);
        // clear in the shallows (the sand and caustics show through), opaque in the deep
        float alpha = (.12 + .86 * (1. - exp(-d * 1.4))) * smoothstep(0., .03, d);
        alpha = max(alpha, F * .7 * smoothstep(0., .1, d));
        alpha = max(alpha, foam * .85);
        float fogF = smoothstep(uFogNear, uFogFar, dist);
        col = mix(col, uFogColor, fogF);
        gl_FragColor = vec4(col, mix(alpha, 1., fogF * .6));
      }`,
  }));
  water.renderOrder = 1;
  scene.add(water);
  let level = 0;
  world.waterLevel = () => level;

  // ---------------------------------------------------------------- scenery outside the farm grid (instanced, deterministic)
  const R = mulberry(20251125);
  const keepClear = (x, z) =>
    (Math.abs(x) < 43 && z > -3 && z < 84) ||                          // the farm grid (z 0..80) and its beach row
    Math.hypot(x - (PIER.x + 12), z - PIER.z) < 9 || Math.hypot(x - 52, z - 70) < 8 ||
    (x < -40 && x > -86 && Math.abs(z - 12) < 3.5) ||
    Math.hypot(x - 10, z - 100) < 10 || pathAt(x, z) > 0.02;
  const slopeAt = (x, z) => Math.abs(heightAt(x + 1, z) - heightAt(x - 1, z)) + Math.abs(heightAt(x, z + 1) - heightAt(x, z - 1));
  const groups = {};
  const place = (name, x, z, s, foliage = true, yaw = R() * Math.PI * 2, tilt = 0) => {
    const g = groups[name] ||= { list: [], foliage };
    g.list.push([x, heightAt(x, z) - 0.05, z, s, yaw, tilt]);
  };
  for (let x = -150; x <= 150; x += 3) for (let z = -150; z <= 150; z += 3) {
    const px = x + (R() - 0.5) * 2.6, pz = z + (R() - 0.5) * 2.6;
    const h = heightAt(px, pz), r1 = R(), r2 = R();
    if (h < 0.55 || keepClear(px, pz)) continue;
    const sl = slopeAt(px, pz);
    if (sl > 1.4 || h > 16) { if (r1 < 0.04) place(['rock_m', 'rock_l', 'rock_s'][(r2 * 3) | 0], px, pz, 0.8 + R() * 1.2, false); continue; }
    if (h < 1.6) {          // beach and coastal flats: palms
      if (r1 < 0.075) place(['palm_a', 'palm_b', 'palm_c'][(r2 * 3) | 0], px, pz, 0.8 + R() * 0.45, true, R() * 6.28, (R() - 0.5) * 0.12);
      else if (r1 < 0.09) place('rock_s', px, pz, 0.6 + R(), false);
    } else {                // inland jungle
      if (r1 < 0.07) place(r2 < 0.55 ? 'jungle_a' : 'jungle_b', px, pz, 0.85 + R() * 0.6);
      else if (r1 < 0.12) place('fern', px, pz, 0.8 + R() * 0.8);
      else if (r1 < 0.15) place('bush_a', px, pz, 0.8 + R() * 0.6);
      else if (r1 < 0.17) place(['palm_a', 'palm_b'][(r2 * 2) | 0], px, pz, 0.9 + R() * 0.4);
      else if (r1 < 0.19) place('rock_m', px, pz, 0.6 + R() * 0.8, false);
    }
  }
  for (let k = 0; k < 9000; k++) {          // grass tufts + flowers on grassy ground
    const px = (R() - 0.5) * 240, pz = (R() - 0.5) * 240;
    const h = heightAt(px, pz);
    if (h < 0.9 || h > 12 || keepClear(px, pz) || slopeAt(px, pz) > 0.9) continue;
    if (R() < 0.12) place(['flower_a', 'flower_b', 'flower_c'][(R() * 3) | 0], px, pz, 0.8 + R() * 0.6);
    else place('grass_tuft', px, pz, 0.7 + R() * 0.9);
  }
  const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), e4 = new THREE.Euler(), v4 = new THREE.Vector3(), s4 = new THREE.Vector3();
  const tint = new THREE.Color();
  for (const [name, g] of Object.entries(groups)) {
    const inst = makeInstanced(name, g.list.length, { foliage: g.foliage, castShadow: !name.startsWith('grass') && !name.startsWith('flower') });
    g.list.forEach(([x, y, z, s, yaw, tilt], k) => {
      e4.set(tilt, yaw, tilt * 0.5);
      m4.compose(v4.set(x, y, z), q4.setFromEuler(e4), s4.set(s, s, s));
      const v = 0.88 + ((k * 7919) % 100) / 100 * 0.24;
      inst.setAt(k, m4, tint.setRGB(v, v * (0.97 + ((k * 31) % 10) / 160), v));
    });
    scene.add(inst);
  }

  // landmarks
  const put = (name, x, z, yaw = 0, y = null, s = 1) => {
    const m = makeMesh(name, { foliage: name.startsWith('palm') });
    m.position.set(x, y ?? heightAt(x, z), z); m.rotation.y = yaw; m.scale.setScalar(s);
    scene.add(m);
    if (name === 'lantern' || name === 'beach_shack') lampSpots.push([x, m.position.y + (name === 'lantern' ? 1.4 : 2.2), z]);
    return m;
  };
  const lampSpots = [];
  put('trader_pier', PIER.x, PIER.z, 0, -0.05);
  put('beach_shack', 52, 70, Math.PI * 1.2);
  world.wreck = put('shipwreck', 10, 100, 0.4, -0.35);
  // after the ending the repaired ship rides at anchor where the wreck was
  const fixedShip = new THREE.Group();
  fixedShip.add(makeMesh('intro_ship'));
  const fsMain = makeMesh('intro_mainsails'); fsMain.position.set(-0.4, 0, 0); fsMain.scale.set(0.35, 1, 1); fixedShip.add(fsMain);
  const fsFore = makeMesh('intro_foremast'); fsFore.position.set(3.2, 1.503, 0); fixedShip.add(fsFore);
  fixedShip.position.set(10, 0, 100); fixedShip.rotation.y = Math.atan2(0.954, -0.3);
  fixedShip.visible = false;
  scene.add(fixedShip);
  world.repairedShip = fixedShip;
  world.setShipRepaired = on => { world.wreck.visible = !on; fixedShip.visible = on; };
  // the mountain trail (path points from heights.json): ruins where it starts to climb, lanterns along the
  // outer edge, and a ring of old pillars round the summit lookout
  const TP = heights.path || [];
  const along = k => { const a = TP[Math.max(0, k - 1)], b = TP[Math.min(TP.length - 1, k + 1)]; return Math.atan2(b[0] - a[0], b[1] - a[1]); };   // yaw that faces +Z along the trail
  const climb = TP.findIndex(p => p[2] > 6);
  if (climb > 0) {
    const [x, z] = TP[climb], yaw = along(climb);
    put('ruin_arch', x, z, yaw);
    put('ruin_pillar', x + Math.cos(yaw) * 4.2 + Math.sin(yaw) * 2, z - Math.sin(yaw) * 4.2 + Math.cos(yaw) * 2, 0.4);
    put('ruin_pillar', x - Math.cos(yaw) * 4 - Math.sin(yaw) * 3, z + Math.sin(yaw) * 4 - Math.cos(yaw) * 3, 1.2);
  }
  for (let k = 6; k < TP.length - 3; k += 8) {   // every ~32 m, on the downhill side of the trail
    const [x, z] = TP[k], yaw = along(k), nx = Math.cos(yaw), nz = -Math.sin(yaw);
    const side = heightAt(x + nx * 3, z + nz * 3) < heightAt(x - nx * 3, z - nz * 3) ? 1 : -1;
    put('lantern', x + nx * 2.3 * side, z + nz * 2.3 * side, yaw);
  }
  if (TP.length) {
    const [tx, tz] = TP[TP.length - 1];
    for (let k = 0; k < 6; k++) {
      const a = k / 6 * Math.PI * 2 + 0.4;
      if (k !== 2) put('ruin_pillar', tx + Math.cos(a) * 5.6, tz + Math.sin(a) * 5.6, a);
    }
    const aa = 0.4 + Math.PI * 2 / 3;   // the gap in the ring gets an arch, facing out
    put('ruin_arch', tx + Math.cos(aa) * 5.6, tz + Math.sin(aa) * 5.6, Math.atan2(Math.cos(aa), Math.sin(aa)));
    put('chest', tx, tz, 0.6);
  }
  put('crate', 56, 72.5, 0.5); put('barrel', 49, 73, 0); put('crate', 12, 95, 1.1, 0.1);
  put('log', 46, 76, 1.2);
  for (const [x, z] of [[-44, 9], [-44, 15], [-60, 15], [-76, 9], [-80, 16]]) put('lantern', x, z, Math.atan2(-x, -z));

  // lantern light at night: 4 pooled warm point lights go to the lamps nearest the camera
  const lamps = [];
  for (let n = 0; n < 4; n++) { const L = new THREE.PointLight(0xffa24d, 0, 16, 1.8); scene.add(L); lamps.push(L); }
  let lampT = 0;
  function stepLamps(dt, night, cp) {
    lampT -= dt;
    if (lampT <= 0) {
      lampT = 0.5;
      const near = lampSpots.map(p => [p, (p[0] - cp.x) ** 2 + (p[2] - cp.z) ** 2]).sort((a, b) => a[1] - b[1]);
      lamps.forEach((L, n) => { const q = near[n]; L.userData.on = !!q && q[1] < 70 * 70 ? 1 : 0; if (q) L.position.set(...q[0]); });   // always visible: a changing light count recompiles every shader
    }
    const t = performance.now() / 1000;
    lamps.forEach((L, n) => { L.intensity = (L.userData.on || 0) * night * 14 * (0.92 + 0.05 * Math.sin(t * 7 + n * 3) + 0.03 * Math.sin(t * 17 + n)); });
  }

  // fireflies: soft blinking points drifting low over the ground around the camera at night
  const FLY = 140, flySeed = new Float32Array(FLY * 3);
  for (let k = 0; k < FLY * 3; k++) flySeed[k] = Math.random();
  const flyGeo = new THREE.BufferGeometry();
  flyGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(FLY * 3), 3));
  flyGeo.setAttribute('seed', new THREE.BufferAttribute(flySeed, 3));
  const flyU = { uTime: uniforms.uTime, uCam: { value: new THREE.Vector3() }, uAmt: { value: 0 }, uH: { value: htex }, uHInfo: { value: new THREE.Vector3(heights.off, heights.step, heights.n) } };
  const flies = new THREE.Points(flyGeo, new THREE.ShaderMaterial({
    uniforms: flyU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    vertexShader: /* glsl */`
      attribute vec3 seed; uniform float uTime, uAmt; uniform vec3 uCam, uHInfo; uniform sampler2D uH; varying float vA;
      void main(){
        float R = 26.;
        vec2 home = (seed.xy - .5) * 2. * R;
        vec2 p = uCam.xz + mod(home - uCam.xz + R, 2. * R) - R;   // wraps around the camera
        p += vec2(sin(uTime * (.3 + seed.z * .4) + seed.x * 40.), cos(uTime * (.25 + seed.y * .35) + seed.z * 30.)) * 1.6;
        float g = texture2D(uH, ((p - uHInfo.x) / uHInfo.y + .5) / uHInfo.z).r;
        float y = g + .5 + seed.z * 1.6 + sin(uTime * .8 + seed.x * 20.) * .3;
        float blink = pow(max(sin(uTime * (1.2 + seed.y) + seed.z * 50.), 0.), 3.);
        vA = uAmt * blink * smoothstep(.35, .9, g) * (1. - smoothstep(R * .7, R, distance(p, uCam.xz)));
        vec4 mv = modelViewMatrix * vec4(p.x, y, p.y, 1.);
        gl_PointSize = (7. + seed.x * 5.) * (30. / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying float vA;
      void main(){ float d = length(gl_PointCoord - .5); float a = smoothstep(.5, 0., d); gl_FragColor = vec4(vec3(1., .92, .45) * (a * a * 2.2 + smoothstep(.12, 0., d) * 2.), a * vA); }`,
  }));
  flies.frustumCulled = false;
  scene.add(flies);

  // the trader's boat: sails in when a new boat is due, docks 3 minutes, sails away
  const boat = makeMesh('trader_boat');
  boat.visible = false;
  scene.add(boat);
  const DOCK = new THREE.Vector3(PIER.x - 13.5, 0, PIER.z + 3.2), SEA = new THREE.Vector3(PIER.x - 190, 0, PIER.z + 60);
  function stepBoat(now) {
    const at = game.state?.trader?.at || 0, age = (now - at) / 1000;
    if (!at || age > 215 || age < 0) { boat.visible = false; return; }
    boat.visible = true;
    let p, yaw;
    if (age < 25) { const t = smooth(0, 1, age / 25); p = v4.lerpVectors(SEA, DOCK, t); yaw = Math.atan2(-(DOCK.z - SEA.z), DOCK.x - SEA.x); }
    else if (age < 180) { p = v4.copy(DOCK); yaw = 0; }
    else { const t = smooth(0, 1, (age - 180) / 35); p = v4.lerpVectors(DOCK, SEA, t); yaw = Math.atan2(-(SEA.z - DOCK.z), SEA.x - DOCK.x); }
    const tt = now / 1000;
    boat.position.set(p.x, level + Math.sin(tt * 1.3) * 0.12 - 0.15, p.z);
    boat.rotation.set(Math.sin(tt * 0.9) * 0.04, lerp(boat.rotation.y, yaw, 0.05), Math.sin(tt * 1.2) * 0.05);
  }

  // drifting clouds
  const clouds = [];
  const CR = mulberry(77);
  for (let k = 0; k < 22; k++) {
    const c = makeMesh(['cloud_a', 'cloud_b', 'cloud_c'][(CR() * 3) | 0], { castShadow: false });
    const a = CR() * Math.PI * 2, r = 120 + CR() * 380;
    c.position.set(Math.cos(a) * r, 75 + CR() * 45, Math.sin(a) * r);
    c.scale.setScalar(1.8 + CR() * 2.6); c.scale.y *= 0.85;
    c.rotation.y = CR() * 6.28;
    c.traverse(o => { if (o.isMesh) { o.material = mats.cloud; o.castShadow = false; o.receiveShadow = false; } });
    scene.add(c);
    clouds.push(c);
  }

  // ---------------------------------------------------------------- rain + distant lightning
  const RAIN = 5000, rainPos = new Float32Array(RAIN * 6), rainSeed = new Float32Array(RAIN * 3);
  for (let k = 0; k < RAIN; k++) { rainSeed[k * 3] = Math.random() * 70 - 35; rainSeed[k * 3 + 1] = Math.random() * 30; rainSeed[k * 3 + 2] = Math.random() * 70 - 35; }
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3).setUsage(THREE.DynamicDrawUsage));
  const rainMat = new THREE.LineBasicMaterial({ color: 0xbfd4e6, transparent: true, opacity: 0, depthWrite: false, fog: false });
  const rain = new THREE.LineSegments(rainGeo, rainMat);
  rain.frustumCulled = false;
  scene.add(rain);

  const BOLT = 14;
  const boltGeo = new THREE.BufferGeometry();
  const boltPos = new Float32Array(BOLT * 6 * 3);
  boltGeo.setAttribute('position', new THREE.BufferAttribute(boltPos, 3).setUsage(THREE.DynamicDrawUsage));
  const boltMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 4, 6), transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const bolt = new THREE.Mesh(boltGeo, boltMat);
  bolt.frustumCulled = false;
  scene.add(bolt);
  let boltT = 0, boltLife = 0, nextBolt = 4;
  function distantBolt(cx, cz) {
    const a = Math.random() * Math.PI * 2, r = 90 + Math.random() * 160;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r, top = 120;
    let px = x + (Math.random() - 0.5) * 30, py = top, pz = z + (Math.random() - 0.5) * 30, o = 0;
    const ground = Math.max(heightAt(x, z), 0);
    for (let k = 0; k < BOLT; k++) {
      const t = (k + 1) / BOLT;
      const nx = lerp(px, x, 0.35) + (Math.random() - 0.5) * 10 * (1 - t), ny = lerp(top, ground, t), nz = lerp(pz, z, 0.35) + (Math.random() - 0.5) * 10 * (1 - t);
      const w = 0.9 * (1 - t * 0.6);
      const quad = [px - w, py, pz, px + w, py, pz, nx + w, ny, nz, px - w, py, pz, nx + w, ny, nz, nx - w, ny, nz];
      boltPos.set(quad, o); o += 18;
      px = nx; py = ny; pz = nz;
    }
    boltGeo.attributes.position.needsUpdate = true;
    boltLife = 0.35; boltT = 0;
    world.flash(0.55);
    const near = clamp01(1 - (r - 90) / 200) * 0.7 + 0.2;
    setTimeout(() => game.emit?.('thunder', { near }), 300 + r * 6);
  }

  // ---------------------------------------------------------------- post-processing
  const size = new THREE.Vector2(innerWidth, innerHeight);
  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  const godU = { tDiffuse: { value: null }, uSun: { value: new THREE.Vector2(0.5, 0.5) }, uStrength: { value: 0 }, uTint: { value: C('#ffe2b0') } };
  const godRays = new ShaderPass({
    uniforms: godU,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
    fragmentShader: /* glsl */`
      uniform sampler2D tDiffuse; uniform vec2 uSun; uniform float uStrength; uniform vec3 uTint; varying vec2 vUv;
      void main(){
        vec4 base = texture2D(tDiffuse, vUv);
        if (uStrength <= 0.001) { gl_FragColor = base; return; }
        vec2 d = (uSun - vUv) / 56.0;
        vec2 uv = vUv; float illum = 1.0, acc = 0.0;
        for (int i = 0; i < 56; i++) {
          uv += d;
          vec3 c = texture2D(tDiffuse, clamp(uv, 0.001, 0.999)).rgb;
          float l = max(dot(c, vec3(0.299, 0.587, 0.114)) - 1.05, 0.0);
          acc += l * illum; illum *= 0.965;
        }
        float fall = 1.0 - smoothstep(0.0, 0.9, distance(vUv, uSun));
        gl_FragColor = vec4(base.rgb + uTint * acc * 0.06 * uStrength * fall, base.a);
      }`,
  });
  const bloom = new UnrealBloomPass(size.clone().multiplyScalar(0.5), 0.32, 0.55, 0.92);
  const outline = new OutlinePass(size.clone(), scene, camera);
  Object.assign(outline, { edgeStrength: 3.2, edgeGlow: 0.25, edgeThickness: 1.4, pulsePeriod: 0 });
  outline.visibleEdgeColor.set('#fff1c4');
  outline.hiddenEdgeColor.set('#6a5530');
  class ViewmodelPass extends Pass {
    constructor() { super(); this.needsSwap = false; }
    render(r, write, read) {
      if (!game.player?.enabled) return;   // title, intro, menus-as-cutscenes: no hands or tools on screen
      const ac = r.autoClear;
      r.autoClear = false;
      r.setRenderTarget(read);
      r.clearDepth();
      r.render(vmScene, vmCamera);
      r.autoClear = ac;
    }
  }
  const vmPass = new ViewmodelPass();
  const gradeU = {
    tDiffuse: { value: null }, uTime: { value: 0 }, uFade: { value: 0 }, uFlash: { value: 0 }, uTint: { value: new THREE.Vector3(1, 1, 1) },
    uSat: { value: 1.08 }, uVig: { value: 0.32 }, uHeat: { value: 0 }, uNight: { value: 0 }, uRes: { value: size.clone() },
  };
  const grade = new ShaderPass({
    uniforms: gradeU,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
    fragmentShader: /* glsl */`
      uniform sampler2D tDiffuse; uniform float uTime, uFade, uFlash, uSat, uVig, uHeat, uNight; uniform vec3 uTint; uniform vec2 uRes; varying vec2 vUv;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main(){
        vec2 uv = vUv;
        if (uHeat > 0.0) uv.x += sin(uv.y * 90.0 + uTime * 6.0) * 0.0016 * uHeat * smoothstep(0.75, 0.35, uv.y);
        vec3 c = texture2D(tDiffuse, uv).rgb;
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(vec3(l), c, uSat) * uTint;
        // split tone: cool shadows, warm highlights (stronger at night: moonlit blue, lantern-warm lights)
        vec3 shadowT = mix(vec3(0.96, 1.0, 1.06), vec3(0.78, 0.9, 1.25), uNight);
        vec3 highT = mix(vec3(1.04, 1.0, 0.95), vec3(1.12, 1.0, 0.86), uNight);
        c *= mix(shadowT, highT, smoothstep(0.05, 0.6, l));
        vec3 cc = clamp(c, 0.0, 1.0);
        c += (cc * cc * (3.0 - 2.0 * cc) - cc) * 0.18;              // a touch of contrast (lights brighter than white stay bright)
        vec2 q = vUv - 0.5; q.x *= uRes.x / uRes.y;
        c *= 1.0 - uVig * smoothstep(0.35, 1.05, length(q));
        c += (hash(vUv * uRes + fract(uTime) * 97.0) - 0.5) * 0.025 * (0.4 + l);
        c += vec3(0.85, 0.9, 1.0) * uFlash;
        c = mix(c, vec3(0.0), uFade);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const output = new OutputPass();
  composer.addPass(renderPass);
  composer.addPass(godRays);
  composer.addPass(bloom);
  composer.addPass(outline);
  composer.addPass(vmPass);
  composer.addPass(grade);
  composer.addPass(output);

  let quality = 'high';
  world.setQuality = q => {
    quality = q === 'low' ? 'low' : 'high';
    const hi = quality === 'high';
    renderer.setPixelRatio(hi ? Math.min(devicePixelRatio, 1.75) : 1);
    godRays.enabled = hi; bloom.enabled = hi;
    const ms = hi ? 2048 : 1024;
    if (sun.shadow.mapSize.x !== ms) { sun.shadow.mapSize.set(ms, ms); sun.shadow.map?.dispose(); sun.shadow.map = null; }
    renderer.shadowMap.type = hi ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    world.resize();
  };
  world.renderSize = null;   // [w, h] to render at a fixed size (the trailer recorder), else the window
  world.resize = () => {
    const [w, h] = world.renderSize || [innerWidth, innerHeight];
    renderer.setSize(w, h, false);
    camera.aspect = vmCamera.aspect = w / h;
    camera.updateProjectionMatrix(); vmCamera.updateProjectionMatrix();
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(w, h);
    gradeU.uRes.value.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
  };
  world.setOutline = objs => { outline.selectedObjects = objs || []; };
  let flashV = 0;
  world.flash = (s = 1) => { flashV = Math.max(flashV, s); };
  // open-water wave height, matching the water vertex shader (deep water)
  world.waveAt = (x, z) => {
    const t = performance.now() / 1000, amp = 0.18 + waterU.uRough.value * 0.35;
    const w = Math.sin(x * 0.11 + z * 0.05 + t * 0.9) + 0.6 * Math.sin(-x * 0.07 + z * 0.13 + t * 1.3) + 0.3 * Math.sin(x * 0.21 - z * 0.17 + t * 2.1);
    return waterU.uLevel.value + w * amp;
  };

  // ---------------------------------------------------------------- day / night
  world.dayTime = () => {
    if (world.cine.time != null) return world.cine.time;   // the intro sets its own time of day
    const created = game.state?.created ?? 0;
    const now = game.now ? game.now() : Date.now();
    return ((((now - created) / 1000) / DAY_LEN + 0.235) % 1 + 1) % 1;   // every world starts just before sunrise (0.25)
  };
  const tmpA = new THREE.Color(), tmpB = new THREE.Color();
  const pal = [0, 0, 0, 0, 0].map(() => new THREE.Color());
  function palette(d) {
    // keyframes across the day: night .0 → dawn .25 → day .34–.66 → dusk .75 → night .83
    const keys = [[0, 'night'], [0.2, 'night'], [0.26, 'dawn'], [0.34, 'day'], [0.66, 'day'], [0.74, 'dusk'], [0.81, 'night'], [1, 'night']];
    let a = keys[0], b = keys[1];
    for (let k = 0; k < keys.length - 1; k++) if (d >= keys[k][0] && d <= keys[k + 1][0]) { a = keys[k]; b = keys[k + 1]; break; }
    const t = smooth(0, 1, (d - a[0]) / Math.max(1e-4, b[0] - a[0]));
    for (let k = 0; k < 5; k++) pal[k].copy(tmpA.set(PAL[a[1]][k])).lerp(tmpB.set(PAL[b[1]][k]), t);
  }
  const wx = { dark: 0, acid: 0, heat: 0, rain: 0, wind: 0, flood: 0 };
  function weatherTargets(now) {
    const w = game.state?.weather || {};
    const k = w.kind;
    let amt = 0;
    if (w.phase === 'warn') amt = 0.15 + 0.5 * clamp01((now - w.t0) / Math.max(1, w.t1 - w.t0));
    else if (w.phase === 'active') amt = clamp01((w.t1 - now) / 6000);   // full strength, easing out over the last 6 s
    const stormy = ['lightning', 'acid', 'storm'].includes(k);
    return {
      dark: stormy ? amt : 0, acid: k === 'acid' ? amt : 0, heat: k === 'drought' ? amt : 0,
      rain: stormy && w.phase === 'active' ? amt : 0,
      wind: k === 'storm' ? amt * 1.8 : stormy ? amt * 0.7 : 0,
      flood: k === 'flood' && (w.phase === 'active' || (w.phase === 'warn' && amt > 0.5)) ? 1 : 0,
      lightning: k === 'lightning' && w.phase === 'active',
    };
  }

  const sunScreen = new THREE.Vector3();
  const focus = new THREE.Vector3();
  world.update = (dt, now) => {
    followDetail();
    uniforms.uTime.value = performance.now() / 1000;
    const d = world.dayTime();
    const a = (d - 0.25) * Math.PI * 2;
    world.sunDir.set(Math.cos(a), Math.sin(a) * 0.96, 0.32).normalize();
    const sunUp = world.sunDir.y;
    const dayF = smooth(-0.08, 0.12, sunUp);

    const T = weatherTargets(now);
    const kk = world.cine.snap ? 1 : 1 - Math.exp(-dt * 0.8);   // cine.snap: hard weather cuts (trailer)
    for (const key of ['dark', 'acid', 'heat', 'rain', 'wind']) wx[key] += (T[key] - wx[key]) * kk;
    wx.flood += (T.flood - wx.flood) * (1 - Math.exp(-dt * 0.25));
    level = wx.flood * TIDE_HIGH;
    waterU.uLevel.value = level;

    palette(d);
    const blend = (arr, t) => { if (t > 0.001) for (let k = 0; k < 5; k++) pal[k].lerp(tmpA.set(arr[k]), t * (k === 2 ? 0.8 : 0.85)); };
    blend(STORM, wx.dark * (1 - wx.acid));
    blend(ACID, wx.acid);
    blend(HEAT, wx.heat * 0.55 * dayF);
    const [zen, hor, sunCol, hSky, hGround] = pal;

    skyU.uZenith.value.copy(zen); skyU.uHorizon.value.copy(hor);
    skyU.uSunDir.value.copy(world.sunDir); skyU.uSunCol.value.copy(sunCol);
    skyU.uDay.value = dayF; skyU.uCloudy.value = wx.dark;
    scene.fog.color.copy(hor);
    scene.fog.near = lerp(70, 25, wx.dark) * lerp(0.7, 1, dayF);
    scene.fog.far = lerp(430, 170, wx.dark) * lerp(0.75, 1, dayF);

    // sun by day, moon by night (same light, flipped)
    const useMoon = sunUp < -0.02;
    const L = useMoon ? tmpB.set('#9fbcff') : sunCol;
    const lightDir = useMoon ? focus.copy(world.sunDir).negate() : focus.copy(world.sunDir);
    const elev = Math.max(0.12, lightDir.y);
    sun.color.copy(L);
    sun.intensity = (useMoon ? 0.95 * smooth(-0.02, -0.15, sunUp) : 2.7 * smooth(-0.02, 0.18, sunUp)) * (1 - wx.dark * 0.7);
    hemi.color.copy(hSky); hemi.groundColor.copy(hGround);
    hemi.intensity = lerp(0.55, 1.15, dayF) * (1 - wx.dark * 0.25) + flashV * 1.5;
    const tgt = game.player?.pos && game.mode === 'play' ? game.player.pos : camera.position;
    const fx = Math.round(tgt.x * 2) / 2, fz = Math.round(tgt.z * 2) / 2;
    sun.target.position.set(fx, 0, fz);
    sun.position.set(fx + lightDir.x / elev * 90 * elev, 110 * elev + 20, fz + lightDir.z / elev * 90 * elev);
    sun.target.updateMatrixWorld();
    vmSun.color.copy(L); vmSun.intensity = Math.max(1.1, sun.intensity * 0.75 + 0.4);   // held items stay readable at night
    vmHemi.color.copy(hSky); vmHemi.groundColor.copy(hGround); vmHemi.intensity = Math.max(1.0, hemi.intensity * 1.1 + 0.2);

    // emissive windows/lanterns glow at night
    const nightGlow = 0.6 + 2.2 * (1 - dayF) + wx.dark * 1.2;
    for (const [key, e] of Object.entries(mats.emit)) if (e.userData.base && key === 'warm') e.color.copy(e.userData.base).multiplyScalar(nightGlow);
    mats.cloud.color.copy(tmpA.set('#ffffff').lerp(hor, lerp(0.45, 0.2, dayF))).multiplyScalar(lerp(0.5, 1, dayF) * (1 - wx.dark * 0.45));   // moonlit at night
    mats.cloud.emissive.copy(hor).multiplyScalar(lerp(0.55, 0.32, dayF) * (1 - wx.dark * 0.6));   // soft fill so the shaded side isn't grey

    // water
    if (useMoon) { waterU.uSunDir.value.copy(world.sunDir).negate(); waterU.uSunCol.value.set('#bcd2ff').multiplyScalar(0.55 * (1 - dayF) * (1 - wx.dark)); }   // a path of moonlight on the sea
    else { waterU.uSunDir.value.copy(world.sunDir); waterU.uSunCol.value.copy(sunCol).multiplyScalar(dayF * (1 - wx.dark)); }
    waterU.uSky.value.copy(hor); waterU.uZenith.value.copy(zen);
    waterLU.value = level; caustU.value = dayF * (1 - wx.dark * 0.8);
    water.position.set(Math.round(camera.position.x / WSEG) * WSEG, 0, Math.round(camera.position.z / WSEG) * WSEG); waterU.uLight.value = lerp(0.26, 1, dayF) * (1 - wx.dark * 0.35) + flashV * 0.6;
    waterU.uFogColor.value.copy(scene.fog.color); waterU.uFogNear.value = scene.fog.near; waterU.uFogFar.value = scene.fog.far;
    waterU.uRough.value = wx.wind * 0.6 + (world.cine.sea || 0);
    waterU.uTint.value.setRGB(1 - wx.acid * 0.2, 1, 1 - wx.acid * 0.35);

    // wind
    uniforms.uWind.value = 0.35 + wx.wind * 1.4 + wx.dark * 0.2;
    const wa = 0.6 + Math.sin(performance.now() / 9000) * 0.25;
    uniforms.uWindDir.value.set(Math.cos(wa), Math.sin(wa));

    // clouds drift with the wind
    for (const c of clouds) {
      c.position.x += uniforms.uWindDir.value.x * dt * (1.5 + wx.wind * 6);
      c.position.z += uniforms.uWindDir.value.y * dt * (1.5 + wx.wind * 6);
      if (Math.hypot(c.position.x, c.position.z) > 520) { c.position.x *= -0.9; c.position.z *= -0.9; }
    }
    stepBoat(now);
    const night = (1 - dayF) * (1 - wx.dark * 0.5);
    stepLamps(dt, (1 - dayF) + wx.dark * 0.6, camera.position);
    flyU.uCam.value.copy(camera.position); flyU.uAmt.value = night * (1 - wx.rain) * (quality === 'high' ? 1 : 0.6);
    flies.visible = flyU.uAmt.value > 0.01;
    if (fixedShip.visible) { const tt = now / 1000; fixedShip.position.y = level + Math.sin(tt * 1.1) * 0.08 - 0.1; fixedShip.rotation.z = Math.sin(tt * 0.9) * 0.025; }

    // rain
    const cp = camera.position;
    rainMat.opacity = wx.rain * 0.42;
    rain.visible = wx.rain > 0.02;
    if (rain.visible) {
      rainMat.color.set(wx.acid > 0.3 ? '#b6e37a' : '#c4d6e8');
      const t = performance.now() / 1000, sx = uniforms.uWindDir.value.x * (0.6 + wx.wind), sz = uniforms.uWindDir.value.y * (0.6 + wx.wind);
      for (let k = 0; k < RAIN; k++) {
        const y = 30 - ((rainSeed[k * 3 + 1] + t * 26) % 30);
        const x = cp.x + ((rainSeed[k * 3] - sx * y + 3500 - cp.x % 70) % 70 + 70) % 70 - 35;
        const z = cp.z + ((rainSeed[k * 3 + 2] - sz * y + 3500 - cp.z % 70) % 70 + 70) % 70 - 35;
        const o = k * 6, yy = cp.y - 8 + y;
        rainPos[o] = x; rainPos[o + 1] = yy; rainPos[o + 2] = z;
        rainPos[o + 3] = x + sx * 0.5; rainPos[o + 4] = yy - 0.9; rainPos[o + 5] = z + sz * 0.5;
      }
      rainGeo.attributes.position.needsUpdate = true;
    }

    // distant lightning
    if (T.lightning || game.introStorm) {
      nextBolt -= dt;
      if (nextBolt <= 0) { nextBolt = 2.5 + Math.random() * 5; distantBolt(cp.x, cp.z); }
    }
    if (boltLife > 0) {
      boltT += dt;
      boltMat.opacity = boltT < boltLife ? (0.5 + 0.5 * Math.sin(boltT * 80)) * (1 - boltT / boltLife) : 0;
      if (boltT >= boltLife) boltLife = 0;
    }

    // god rays from the sun's screen position
    sunScreen.copy(world.sunDir).multiplyScalar(1000).add(camera.position).project(camera);
    const camFwd = focus.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const facing = camFwd.dot(world.sunDir);
    const onScreen = Math.abs(sunScreen.x) < 1.4 && Math.abs(sunScreen.y) < 1.4 && facing > 0;
    godU.uSun.value.set(sunScreen.x * 0.5 + 0.5, sunScreen.y * 0.5 + 0.5);
    const want = onScreen ? smooth(-0.02, 0.15, sunUp) * (1 - wx.dark) * smooth(0.2, 0.7, facing) * lerp(1.4, 1, smooth(0.15, 0.5, sunUp)) : 0;
    godU.uStrength.value += (want - godU.uStrength.value) * Math.min(1, dt * 4);
    godU.uTint.value.copy(sunCol);

    // grade
    flashV = Math.max(0, flashV - dt * 3.2);
    gradeU.uTime.value = performance.now() / 1000;
    gradeU.uFade.value = clamp01(world.cine.fade);
    gradeU.uFlash.value = flashV;
    gradeU.uHeat.value = wx.heat * dayF;
    const tint = gradeU.uTint.value;
    tint.set(1, 1, 1);
    tint.x *= 1 + wx.heat * 0.08; tint.z *= 1 - wx.heat * 0.12;
    tint.y *= 1 + wx.acid * 0.06; tint.z *= 1 - wx.acid * 0.15;
    gradeU.uNight.value = 1 - dayF;
    gradeU.uSat.value = lerp(1.12, 0.78, wx.dark) * lerp(0.68, 1, dayF);   // night drains colour, like our eyes do
    gradeU.uVig.value = 0.3 + (1 - dayF) * 0.14 + wx.dark * 0.15 + world.cine.letterbox * 0.1;
    bloom.strength = lerp(0.55, 0.32, dayF);   // lights glow more in the dark
    sky.position.copy(camera.position);
  };

  world.render = () => { composer.render(); world.afterRender?.(); };
  // build every shader the game can need while the loading screen is up, so nothing compiles mid-game
  // (rain, fireflies, the lightning bolt, the repaired ship and other hidden objects included)
  world.warmup = async () => {
    const hidden = [];
    for (const sc of [scene, vmScene]) sc.traverse(o => { if (!o.visible) { hidden.push(o); o.visible = true; } });
    await renderer.compileAsync(scene, camera);
    await renderer.compileAsync(vmScene, vmCamera);
    composer.render();                       // post passes + shadow depth programs
    for (const o of hidden) o.visible = false;
  };
  world.setQuality('high');
  return world;
}
