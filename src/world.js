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
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { mergeVertices, mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeMesh, makeInstanced, lib, mats, uniforms, heights, groundTex, TILE_GLSL, withDetail, MAT, matTex, MAT_FUNCS, matUniforms } from './assets.js';
import { heightAt, pathAt } from './terrain.js';
import { createWildlife } from './wildlife.js';
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
  day: ['#0f6cf0', '#86cef7', '#fff3de', '#b2dcff', '#7f8a5a'],   // deep tropical blue overhead, clear cyan horizon
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
  sun.shadow.intensity = 0.66;   // shade under trees keeps a third of the sunlight (sky bounce), never black
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(hemi, sun, sun.target);

  // ---------------------------------------------------------------- reflected sky for physically lit surfaces
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envU = { uZen: { value: new THREE.Color() }, uHor: { value: new THREE.Color() }, uGround: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color() } };
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.ShaderMaterial({
    uniforms: envU, side: THREE.BackSide, depthWrite: false,
    vertexShader: 'varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
    fragmentShader: `uniform vec3 uZen, uHor, uGround, uSunDir, uSunCol; varying vec3 vD;
      void main(){ vec3 d = normalize(vD);
        vec3 c = d.y > 0. ? mix(uHor, uZen, pow(d.y, .6)) : mix(uHor, uGround * .6, smoothstep(0., -.3, d.y));
        c += uSunCol * pow(max(dot(d, uSunDir), 0.), 64.) * 6.;
        gl_FragColor = vec4(c, 1.); }`,
  })));
  let envRT = null, envT = 0;

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
        vec3 col = mix(uHorizon, uZenith, pow(smoothstep(-0.03, 0.5, h), 0.55));   // the deep blue comes down low, a pale band only at the horizon
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
        uniform sampler2D uSoil; uniform vec3 uSoilInfo;
        float soilAt(vec2 q){ vec2 uv = (q - uSoilInfo.xy) / uSoilInfo.z;
          if (any(lessThan(uv, vec2(0.))) || any(greaterThan(uv, vec2(1.)))) return 0.;
          return smoothstep(.44, .56, texture2D(uSoil, uv).r); }   // crisp: switches right at the tile edge
        float soilBlend(vec2 q){   // soft, ragged: the grass thins out into dug earth around a plot (colour only)
          vec2 w = vec2(gn(q * 1.3), gn(q * 1.3 + 5.2)) - .5;
          vec2 uv = (q + w * .8 - uSoilInfo.xy) / uSoilInfo.z;
          if (any(lessThan(uv, vec2(0.))) || any(greaterThan(uv, vec2(1.)))) return 0.;
          return smoothstep(.14, .56, texture2D(uSoil, uv).r + (gn(q * 4.1) - .5) * .3); }
        float gEdge(vec2 q){ return .82 + (gf(q * .045) - .5) * .14 + (gf(q * .35 + 3.3) - .5) * .16 + (gn(q * 1.7) - .5) * .05; }`;
  const patchU = { uPatchC: { value: new THREE.Vector2() }, uPatchR: { value: 0 } };
  const wetU = { value: 0 };   // 0 dry .. 1 soaked: rain darkens the ground and makes it shine
  const PATCH = 64, PATCH_SEG = 256;
  const waterLU = { value: 0 }, caustU = { value: 1 };   // water level + sunlight for the seabed caustics
  // which farm tiles are soil: the ground under a soil bed sinks and turns to dirt, so no grass pokes up between beds
  const soilData = new Uint8Array(GRID * GRID);
  const soilTex = new THREE.DataTexture(soilData, GRID, GRID, THREE.RedFormat);
  soilTex.minFilter = soilTex.magFilter = THREE.LinearFilter;
  soilTex.needsUpdate = true;
  const soilU = { uSoil: { value: soilTex }, uSoilInfo: { value: new THREE.Vector3(ORIGIN, ORIGIN_Z, GRID * TILE) } };
  world.setSoil = (k, on) => { const v = on ? 255 : 0; if (soilData[k] !== v) { soilData[k] = v; soilTex.needsUpdate = true; } };
  const MTN = new THREE.Vector3(...(heights.meta?.summit || [0, 0]), lib.mountain ? heights.meta?.mountainR || 0 : 0);   // the mountain asset's footprint
  function groundMat(detail, mountain = false) {
    const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, vertexColors: mountain });   // lit physically so the texture normals and wet sheen read
    mat.defines = { ...(detail ? { GROUND_DETAIL: '' } : {}), ...(mountain ? { MOUNTAIN: '' } : {}) };
    mat.customProgramCacheKey = () => 'ground' + (detail ? '-d' : '') + (mountain ? '-m' : '');
    mat.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, matUniforms(), { uMtn: { value: MTN } }, patchU, { uParallax: uniforms.uParallax, uH: { value: htex }, uCTime: uniforms.uTime, uWaterL: waterLU, uCaust: caustU, uWet: wetU, ...soilU },
        Object.fromEntries(Object.entries(groundTex).map(([k, t]) => ['t' + k, { value: t }])));
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
          uniform vec2 uPatchC; uniform float uPatchR; uniform float uCTime, uWaterL, uCaust, uWet;
          uniform sampler2D tgrassA, tgrassD, tgrassH, tsoilA, tsoilD, tsoilH, tsandA, tsandD, tsandH; uniform vec3 uMtn;
          ${NOISE}
          ${TILE_GLSL}
          ${MAT_FUNCS}
          vec3 gCliffN = vec3(0.);`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          #if !defined(GROUND_DETAIL) && !defined(MOUNTAIN)
            if (max(abs(vGW.x - uPatchC.x), abs(vGW.z - uPatchC.y)) < uPatchR - .3) discard;   // the detail mesh is drawn here
          #endif
          #ifndef MOUNTAIN
            if (uMtn.z > 0. && length(vGW.xz - uMtn.xy) < uMtn.z) discard;   // the mountain asset is drawn here
          #endif`)
        .replace('#include <color_fragment>', `#include <color_fragment>
        float gBump = 0., gRough = 1., gWetF = 0.; vec2 gTexN = vec2(0.);
        {
          vec2 q = vGW.xz; float h = vBaseH, slope = 1. - clamp(vGN.y, 0., 1.);
          float big = gf(q * .045), mid = gf(q * .21), fine = gn(q * 2.7);
          // the grass line: follows height, wavy at two scales, with a ragged fringe
          float edge = gEdge(q);
          float near = 1. - clamp(abs(h - edge) / .14, 0., 1.);       // 1 right at the grass line
          // grass: meadows, sun-dried patches, clumps that catch the light
          float clump = gf(q * 1.15) * .65 + gn(q * 5.3) * .35;
          vec3 grass = mix(vec3(.3, .56, .17), vec3(.5, .74, .24), smoothstep(.25, .75, big));   // sunny yellow-green meadow
          grass = mix(grass, vec3(.62, .68, .32), smoothstep(.6, .8, gf(q * .02 + 11.)) * .6);
          grass = mix(grass, vec3(.58, .64, .3), near * .45);           // drier where it meets the sand
          grass *= .78 + clump * .3 + fine * .08;
          // baked textures (1 m tiles): the procedural colour above now only tints them at large scale
          float tk = smoothstep(.35, .65, gn(q * .31 + 17.));
          // parallax occlusion on whichever surface this is (soil / grass / sand), close to the camera only
          vec3 pV = normalize(cameraPosition - vGW);
          float pFade = (1. - smoothstep(7., 16., length(cameraPosition - vGW))) * (1. - smoothstep(.25, .45, slope));
          float pTg = smoothstep(edge - .02, edge + .02, h);
          vec2 qp = soilAt(q) > .5 ? pomQ(tsoilH, q, .8, tk, pV, .03, pFade)
                  : pTg > .5 ? pomQ(tgrassH, q, .5, tk, pV, .06, pFade)
                  : pomQ(tsandH, q, .7, tk, pV, .005, pFade);
          vec3 gTex = pow(tileAlbedo(tgrassA, qp * .5, tk).rgb, vec3(1. / 2.2));
          vec3 gDat = tileData(tgrassD, qp * .5, tk);
          grass = gTex * clamp(grass / vec3(.36, .55, .21), .55, 1.6);
          vec3 sTex = pow(tileAlbedo(tsandA, qp * .7, tk).rgb, vec3(1. / 2.2));
          vec3 sDat = tileData(tsandD, qp * .7, tk);
          vec3 eTex = pow(tileAlbedo(tsoilA, qp * .8, tk).rgb, vec3(1. / 2.2));
          vec3 eDat = tileData(tsoilD, qp * .8, tk);
          // sand: grain, wind ripples, dunes, pebble and shell speckles, a wet band at the waterline
          vec2 wd = vec2(.83, .55);
          float warp = gf(q * .3) * 5.;
          float rip = sin(dot(q, wd) * 4.2 + warp) * .5 + .5;
          rip = rip * rip * (1. - smoothstep(.45, .2, h)) * (1. - near * .7);
          float dune = gf(q * .09 + 5.);
          vec3 sand = mix(vec3(.97, .87, .64), vec3(1., .94, .78), mid * .6 + dune * .4) * (.95 + fine * .07);   // warm cream, as in the art
          sand *= .93 + rip * .11;
          vec2 cell = floor(q * 6.), cf = fract(q * 6.) - .5 + (vec2(gh(cell + 3.), gh(cell + 5.)) - .5) * .5;
          float speck = step(.94, gh(cell)) * smoothstep(.16, .08, length(cf));
          sand = mix(sand, mix(vec3(.6, .53, .44), vec3(.99, .96, .9), gh(cell + 1.)), speck * .55 * (1. - near));
          sand = mix(sand, vec3(.8, .71, .5), near * .45);              // sandy soil under the first grass
          sand = mix(sand, vec3(.74, .62, .43), smoothstep(.3, .06, h) * .65);   // a thin wet band at the waterline only
          sand *= mix(vec3(1.), sTex / vec3(.85, .77, .59), 1.8) * .93;   // grain contrast up, bright sand toned down so it doesn't blow out
          float toGrass = smoothstep(edge - .02, edge + .02, h);
          vec3 seabed = mix(vec3(.80, .72, .52), vec3(.70, .66, .50), mid) * mix(vec3(1.), sTex / vec3(.85, .77, .59), 1.8) * .9;   // same sand texture as the beach
          {   // reef: dark rock patches studded with colourful coral, seagrass meadows, all under the clear shallows
            float under = smoothstep(-.25, -.9, h);
            float reef = smoothstep(.5, .62, gf(q * .09 + 40.)) * under * smoothstep(-7.5, -1.6, h);
            float weed = smoothstep(.6, .72, gf(q * .07 + 71.)) * under * (1. - reef);
            seabed = mix(seabed, vec3(.24, .42, .2) * (.8 + fine * .4), weed * .7);
            seabed = mix(seabed, vec3(.38, .36, .3) * (.8 + mid * .4), reef * .75);
            vec2 cq = q * .8 + vec2(gn(q * .6), gn(q * .6 + 9.)) * 1.2;   // warped cells: no grid
            vec2 cc = floor(cq), cf = fract(cq) - .5 - (vec2(gh(cc + 11.), gh(cc + 13.)) - .5) * .45;
            float pick = gh(cc + 17.), blob = smoothstep(.36, .2, length(cf * vec2(1., .7 + gh(cc + 19.) * .6)) * (.8 + gn(q * 4.) * .7));
            vec3 coral = pick < .2 ? vec3(1., .45, .62) : pick < .4 ? vec3(1., .58, .2) : pick < .55 ? vec3(.62, .42, .9)
                       : pick < .7 ? vec3(1., .85, .3) : pick < .85 ? vec3(.25, .78, .66) : vec3(.95, .3, .3);
            seabed = mix(seabed, coral * (.75 + fine * .3), blob * reef * step(.7, gh(cc + 23.)) * .85);
          }
          vec3 rock = mix(vec3(.47, .46, .42), vec3(.62, .61, .55), gf(q * .3)) * (.9 + fine * .12);
          vec3 c = mix(sand, grass, toGrass);
          float soilM = soilAt(q), soilB = max(soilM, soilBlend(q));
          c = mix(c, eTex * .85, soilB);   // dark earth under the beds, fading out into the grass around a plot
          c = mix(seabed, c, smoothstep(.05, .3, h));
          float low = 1. - smoothstep(6., 24., h + (big - .5) * 10.);      // grass holds on steeper ground in the foothills
          float rockAmt = max(smoothstep(.42 + low * .4, .6 + low * .45, slope + (mid - .5) * .2), smoothstep(22., 30., h + mid * 6.) * smoothstep(.38, .62, slope));   // the mountain's ledges and gentler flanks stay green
          #ifdef MOUNTAIN
            rockAmt = max(rockAmt, smoothstep(.3, .48, slope + (mid - .5) * .12) * smoothstep(1.5, 3., h));   // grass only holds on the ledges (it smears down a steep face)
          #endif
          {   // cliff rock: the baked cliff texture along the world axes, with parallax (strata, joints, ledges, moss)
            float cd0 = length(cameraPosition - vGW); vec3 cTilt; float cRough;
            vec4 cd = rockAmt > .02 ? triDetail(vGW, normalize(vGN), cameraPosition - vGW, cd0 * .3, 9, 1., cTilt, cRough) : vec4(1.);
            rock *= cd.rgb * cd.a * vec3(1.05, 1.02, .98);
            gCliffN = rockAmt > .02 ? cTilt * rockAmt * 1.5 : vec3(0.);
          }
          c = mix(c, rock, rockAmt);
          #ifdef MOUNTAIN
            c *= mix(.42, 1.05, vColor.r);   // ambient occlusion baked in Blender: crevices, overhangs, the foot of each cliff
          #endif
          // the mountain trail: packed earth with worn edges and pebbles
          float trail = smoothstep(.15, .65, vPath + (gn(q * 1.9) - .5) * .35);
          vec3 dirt = mix(vec3(.52, .4, .28), vec3(.66, .54, .38), mid) * (.88 + fine * .16);
          dirt = mix(dirt, vec3(.72, .68, .6), speck * .6) * eTex / vec3(.34, .24, .16) * .62;
          vec3 sandy = mix(vec3(.86, .74, .52), vec3(.93, .83, .62), mid) * (.9 + fine * .12);   // meadow tracks: packed sand (path mask < 1)
          dirt = mix(dirt, sandy, smoothstep(.86, .72, vPath) * step(h, 6.));
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
          // texture normals + roughness, mixed the same way as the colours
          float sandW = (1. - toGrass) * (1. - soilB), grassW = toGrass * (1. - soilB);
          vec3 dat = vec3(sDat.xy * 1.4, sDat.z) * sandW + gDat * grassW + eDat * soilB;
          dat = mix(dat, eDat, trail);
          gTexN = dat.xy * (1. - rockAmt);   // texture relief all the way down into the wash zone and the seabed
          gRough = mix(.95, max(dat.z, .82), 1. - rockAmt);   // matte: grass and dry soil barely reflect the sky
          float wetSand = smoothstep(.2, .03, h) * sandW;      // the wash zone stays damp: darker and shiny
          float wet = max(wetSand, uWet * (1. - rockAmt * .5));
          c *= 1. - wet * .32;
          gRough = mix(gRough, .28, wet * .85); gWetF = wet;
          diffuseColor.rgb = pow(c, vec3(2.2));   // picked as sRGB, lit in linear
          gBump = mix(rip * .02 + dune * .06, clump * .03, toGrass) * (1. - rockAmt) * (1. - soilM) * smoothstep(.1, .35, h);
        }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = gRough;`)
        .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        material.specularColor *= mix(.25, 1., gWetF); material.specularF90 = mix(.25, 1., gWetF);   // dry ground: little sky sheen`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {   // baked texture normal: tilt the ground normal (world space) by the texture's x/z slope
          vec2 tn = gTexN * 1.15;
          vec3 wn = normalize(vGN * sqrt(max(1. - dot(tn, tn), .05)) + vec3(tn.x, 0., tn.y) + gCliffN);
          normal = normalize((viewMatrix * vec4(wn, 0.)).xyz);
        }
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
  // the coarse island mesh: every 2nd height sample (2 m), built here straight from heights.json
  const MS = 2, mn = (n - 1) / MS + 1, ipos = new Float32Array(mn * mn * 3), iidx = [];
  for (let j = 0; j < mn; j++) for (let i = 0; i < mn; i++) {
    const k = (j * mn + i) * 3;
    ipos[k] = heights.off + i * MS * heights.step; ipos[k + 1] = heights.h[j * MS * n + i * MS]; ipos[k + 2] = heights.off + j * MS * heights.step;
  }
  for (let j = 0; j < mn - 1; j++) for (let i = 0; i < mn - 1; i++) {
    const a = j * mn + i, b = a + 1, c = a + mn + 1, d = a + mn;
    if ((i + j) % 2) iidx.push(a, d, c, a, c, b); else iidx.push(a, d, b, b, d, c);
  }
  const islandGeo = new THREE.BufferGeometry();
  islandGeo.setAttribute('position', new THREE.BufferAttribute(ipos, 3));
  islandGeo.setIndex(iidx);
  const island = new THREE.Mesh(islandGeo, islandMat);
  island.geometry.computeVertexNormals();
  island.receiveShadow = true; island.castShadow = true;
  island.name = 'island';
  world.groundGroup.add(island);
  if (lib.mountain) {   // the mountain: its own sculpted asset (tools/make_mountain.py), same ground shading
    const mtn = new THREE.Mesh(lib.mountain.geo, groundMat(false, true));
    mtn.receiveShadow = mtn.castShadow = true; mtn.name = 'mountain';
    world.groundGroup.add(mtn);
  }
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
  // ocean swell: Gerstner waves (crests sharpen and lean together, troughs flatten, the surface rolls), five wave
  // trains from 42 m down to 6 m, damped in the shallows, the short ones faded out with distance so the coarser
  // far mesh doesn't shimmer. Same sums in the vertex shader, the fragment normal and world.waveAt.
  const WAVES = [[0.92, 0.39, 60, 0.55, 0.35], [0.6, 0.8, 37, 0.42, 0.5], [-0.3, 0.95, 22, 0.26, 0.6], [0.98, -0.2, 13, 0.13, 0.65], [0.45, 0.89, 8, 0.07, 0.6], [-0.7, 0.7, 5, 0.035, 0.5]];
  const GERSTNER = /* glsl */`
    const int NW = ${WAVES.length};
    const vec4 WD[NW] = vec4[NW](${WAVES.map(([x, z, L]) => { const k = Math.PI * 2 / L, l = Math.hypot(x, z); return `vec4(${(x / l).toFixed(4)}, ${(z / l).toFixed(4)}, ${k.toFixed(5)}, ${Math.sqrt(9.81 * k).toFixed(5)})`; }).join(', ')});
    const vec3 WA[NW] = vec3[NW](${WAVES.map(([, , L, A, Q]) => `vec3(${A}, ${Q}, ${L.toFixed(1)})`).join(', ')});
    // p: rest position (xz), amp: depth + storm factor, dist: to the camera. disp: offset, nrm: unit normal, crest: -1..1
    void gerstner(vec2 p, float t, float amp, float dist, out vec3 disp, out vec3 nrm, out float crest){
      disp = vec3(0.); vec3 n = vec3(0., 1., 0.); crest = 0.; float tot = 0.;
      for (int i = 0; i < NW; i++) {
        float A = WA[i].x * amp * (1. - smoothstep(WA[i].z * 3., WA[i].z * 9., dist)), Q = WA[i].y;
        float th = WD[i].z * dot(WD[i].xy, p) - WD[i].w * t, s = sin(th), c = cos(th);
        disp += vec3(WD[i].x * Q * A * c, A * s, WD[i].y * Q * A * c);
        n -= vec3(WD[i].x * WD[i].z * A * c, Q * WD[i].z * A * s, WD[i].y * WD[i].z * A * c);
        crest += s * A; tot += A;
      }
      nrm = normalize(n); crest /= max(tot, 1e-4);
    }`;
  // the water mesh: a grid packed tight round the camera (20 cm apart under your feet, ~30 m at the horizon)
  const wGeo = new THREE.PlaneGeometry(2, 2, 300, 300).rotateX(-Math.PI / 2);
  { const p = wGeo.attributes.position; for (let i = 0; i < p.count; i++) { const f = v => Math.sign(v) * 1800 * Math.abs(v) ** 2.4; p.setXYZ(i, f(p.getX(i)), 0, f(p.getZ(i))); } }
  const WSEG = 2;   // the mesh follows the camera in 2 m steps
  waterU.tRefl = { value: null }; waterU.uReflMat = { value: new THREE.Matrix4() }; waterU.uReflOn = { value: 0 };
  const water = new THREE.Mesh(wGeo, new THREE.ShaderMaterial({
    uniforms: waterU, transparent: true,
    vertexShader: /* glsl */`
      uniform float uTime, uLevel, uOff, uSpan, uRough; uniform sampler2D uH; uniform mat4 uReflMat;
      varying vec3 vW; varying float vCrest; varying vec3 vWN; varying vec4 vRefl;
      ${GERSTNER}
      float ground(vec2 p){ vec2 uv = (p - uOff) / uSpan; if (any(lessThan(uv, vec2(0.))) || any(greaterThan(uv, vec2(1.)))) return -15.; return texture2D(uH, uv).r; }
      void main(){
        vec3 p = (modelMatrix * vec4(position, 1.)).xyz;
        float depth = uLevel - ground(p.xz);
        float amp = clamp(depth / 5., 0.16, 1.) * (1. + uRough * 1.6);   // the lagoon still ripples and heaves a little
        vec3 disp, nrm; float crest;
        gerstner(p.xz, uTime, amp, distance(p.xz, cameraPosition.xz), disp, nrm, crest);
        // surf: wave rows rolling in toward the beach, rising as the water shallows
        float sph = depth * 1.5 - uTime * 1.15 + sin(p.x * .05 + p.z * .03) * 2.;
        float surf = pow(max(sin(sph), 0.), 3.) * smoothstep(3.8, 1.4, depth) * smoothstep(.15, .7, depth) * (.16 + uRough * .2);
        float sh = smoothstep(0., .6, depth);
        p.xz += disp.xz * sh; p.y = uLevel + disp.y * sh + surf;
        vW = p; vWN = normalize(mix(vec3(0., 1., 0.), nrm, sh)); vCrest = crest * clamp(depth / 2., 0., 1.) + surf * 4.;
        vRefl = uReflMat * vec4(p, 1.);
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.);
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uLight, uFogNear, uFogFar, uRough, uLevel, uOff, uSpan;
      uniform vec3 uSunDir, uSunCol, uSky, uZenith, uFogColor, uTint; uniform sampler2D uH, tRefl; uniform float uReflOn;
      varying vec3 vW; varying float vCrest; varying vec3 vWN; varying vec4 vRefl;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * f * (f * (f * 6. - 15.) + 10.);   // quintic: no creases
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y); }
      float ground(vec2 p){ vec2 uv = (p - uOff) / uSpan; if (any(lessThan(uv, vec2(0.))) || any(greaterThan(uv, vec2(1.)))) return -15.; return texture2D(uH, uv).r; }
      float riverX(float z){ float k = z >= 0. ? 0. : z <= -20. ? 1. : smoothstep(0., 1., -z / 20.);
        float s = 1. - smoothstep(-50., -14., z); return 31. + .5 * sin(z * .15) * (1. - k) + k * (3. * sin(z * .17 + 1.1) + 21. * s); }
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
        float rx = riverX(max(q.y, -52.)), along = (riverX(q.y + 1.) - riverX(q.y - 1.)) * .5;
        float inRiver = (1. - smoothstep(3.5, 7., abs(q.x - rx))) * step(-56., q.y) * (1. - smoothstep(76., 88., q.y));
        vec2 flow = normalize(vec2(along, 1.)) * inRiver * 1.4;
        // swell slope (analytic, matches the vertex waves) + ripples
        vec2 rp = ripN(q, flow, t * 1.7, detail) * mix(.3, .11, smoothstep(10., 260., dist)) * (1. + uRough * 1.8 + inRiver * .4);
        vec3 N = normalize(normalize(vWN) + vec3(-rp.x, 0., -rp.y));   // the swell's own slope (Gerstner) + ripples
        float NdV = max(dot(N, V), 0.);
        // body colour, like a tropical lagoon: glassy aqua at the beach, bright turquoise over the sandy shelf,
        // then a fairly quick drop to deep navy past the reef
        vec3 shallowC = vec3(.38, .96, .88), turqC = vec3(.0, .80, .80), midC = vec3(.0, .5, .82), deepC = vec3(.01, .15, .62);
        vec3 body = mix(shallowC, turqC, smoothstep(0., 1.3, d));
        body = mix(body, midC, smoothstep(2.2, 4.6, d));
        body = mix(body, deepC, smoothstep(4.2, 7.2, d));
        {   // dark reef patches showing through the turquoise shelf, as in the art
          float reefP = smoothstep(.56, .72, vn(q * .045 + 3.) * .65 + vn(q * .14 + 9.) * .35) * smoothstep(.8, 1.7, d) * (1. - smoothstep(3.6, 6., d));
          body = mix(body, vec3(.0, .28, .42), reefP * .62);
        }
        // crests catch more light and look paler and greener, troughs sink darker and bluer: the swell reads as shape, not a flat sheet
        float cw = clamp(vCrest * .5 + .5, 0., 1.) * smoothstep(.4, 2.5, d);
        body *= mix(vec3(.78, .84, .92), vec3(1.1, 1.14, 1.08), mix(.5, cw, smoothstep(.4, 2.5, d)));
        body *= uTint * mix(vec3(1.), uSky * 1.25, .22);   // the water takes on the sky's mood (warm at sunset, blue at night)
        // light through the crests when looking toward the sun
        vec3 sunFlat = normalize(vec3(uSunDir.x, 0.001, uSunDir.z));
        float sss = pow(max(dot(-V, sunFlat), 0.), 3.) * clamp(vCrest * .5 + .5, 0., 1.) * step(0., uSunDir.y);
        vec3 col = body * uLight + turqC * sss * .45 * uLight;
        // sky reflection, stronger at grazing angles
        vec3 Rv = reflect(-V, N);
        vec3 sky = mix(uSky, uZenith, smoothstep(0., .3, Rv.y));
        {   // clouds drifting across the reflected sky
          vec2 cuv = Rv.xz / max(Rv.y, .06) * 1.6 + vec2(t * .01, t * .006);
          float cl = vn(cuv) * .55 + vn(cuv * 2.1 + 3.) * .3 + vn(cuv * 4.3 + 7.) * .15;
          sky = mix(sky, mix(uSky, vec3(1.), .7) * max(uLight, .2), smoothstep(.55, .78, cl) * .75 * smoothstep(.0, .15, Rv.y));
        }
        if (uReflOn > 0.) {   // the island, boats and clouds mirrored in the water, broken up by the waves
          vec4 rc = vRefl; rc.xy += N.xz * vec2(1.2, 1.2) * rc.w * .06;
          vec3 mir = rc.w > .05 ? textureProj(tRefl, rc).rgb : sky;
          if (any(isnan(mir)) || any(isinf(mir))) mir = sky;   // never let a bad texel reach the bloom
          sky = mix(sky, min(mir, vec3(6.)), uReflOn * smoothstep(.0, .05, Rv.y + .05));
        }
        float F = .02 + .98 * pow(1. - NdV, 5.);
        col = mix(col, sky, clamp(F * .55, 0., 1.));   // reflection holds back: the water keeps its colour
        // whitecaps: the sharpest crests of the open swell break into foam, more in a blow
        float wcap = smoothstep(.75, .98, vCrest) * smoothstep(3., 8., d) * (.06 + uRough * .9) * smoothstep(.5, .85, vn(q * .12 + t * .04) * .6 + vn(q * .9 + t * .3) * .4) * (1. - smoothstep(40., 160., dist));
        // the sun (or moon): tight hot spot, soft glare, and glints on the ripples
        vec3 Hh = normalize(uSunDir + V);
        float ndh = max(dot(N, Hh), 0.);
        float glint = (smoothstep(.88, 1., vn(q * 5. + vec2(t * 1.7, -t * 1.3))) + smoothstep(.93, 1., vn(q * 11. - vec2(t * 2.3, t * 1.9))) * .7) * pow(ndh, 24.) * detail;
        col += uSunCol * (pow(ndh, 700.) * 5. + pow(ndh, 70.) * .3 + glint * 2.2) * step(0., uSunDir.y);
        // shoreline: thin foam lines lapping in and out, a bright rim right at the waterline
        float lap = sin(d * 11. - t * 1.6 + vn(q * .5) * 6.) * .5 + .5;
        float edge = smoothstep(.45, 0., d);
        float foam = edge * smoothstep(.55, .92, lap) * (.6 + .4 * vn(q * 2.5 + t * .2)) + smoothstep(.16, .02, d) * (.55 + .45 * vn(q * 4. - t * .3));
        foam += uRough * smoothstep(.72, .95, vn(q * .7 + vec2(t * .4, t * .25))) * .7 * (1. - edge) + wcap * (1. - edge);   // whitecaps
        {   // surf: each wave row breaks into a foam line as it reaches the shallows, then washes out as streaks
          float sph = d * 1.5 - t * 1.15 + sin(q.x * .05 + q.y * .03) * 2.;
          float crest = pow(max(sin(sph), 0.), 10.), wake = pow(max(sin(sph + .9), 0.), 3.);
          float zone = smoothstep(2.6, 1.1, d) * smoothstep(.1, .5, d);
          float br = vn(q * 1.7 + vec2(t * .3, 0.)) * .6 + vn(q * 4.5 - t * .2) * .4;
          foam += zone * (crest * smoothstep(.3, .6, br) + wake * smoothstep(.62, .85, br) * .5) * (1. - inRiver);
        }
        foam += inRiver * smoothstep(.8, .97, vn(q * 1.2 - flow * t * 1.5)) * .18 * detail;         // flecks drifting downstream
        foam = clamp(foam, 0., 1.);
        col = mix(col, vec3(.95, .98, 1.) * max(uLight, .3), foam * .7);
        // clear in the shallows (the sand and caustics show through), opaque in the deep
        float alpha = (.26 + .72 * smoothstep(.1, 3.8, d)) * smoothstep(0., .05, d);   // tinted turquoise from the first step in   // see the sand and reef down to a few metres
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

  // ---------------------------------------------------------------- the waterfall: a stream runs along the cliff-top
  // notch, pours over the lip in an arc and plunges into the river's spring pool, throwing up mist
  {
    const M = heights.meta || {}, P = M.pool || [25, -46], D = M.fallDir || [0.7, -0.72], LIP = (M.lip || [10, 24])[0];
    const S = [-D[1], D[0]], W = 4.4, at = a => [P[0] + D[0] * a, P[1] + D[1] * a];
    const path = [];   // [x, y, z] down the middle of the stream, top first
    for (let a = 22; a > LIP + 0.5; a -= 1) { const [x, z] = at(a); path.push([x, heightAt(x, z) + 0.12, z]); }
    const [lx, lz] = at(LIP + 0.5), topY = heightAt(lx, lz) + 0.12;
    for (let k = 0; k <= 24; k++) {   // the fall: leaves the lip moving forward, then drops (a ballistic arc)
      const s = k / 24, y = topY - (topY + 0.2) * s;
      const out = 5.5 * Math.sqrt(s) + 0.3 * s;
      path.push([lx - D[0] * out, y, lz - D[1] * out]);
    }
    const nv = path.length, pos = new Float32Array(nv * 2 * 3), uv = new Float32Array(nv * 2 * 2), idx = [];
    let len = 0, topLen = 0;
    path.forEach((p, k) => {
      if (k) len += Math.hypot(p[0] - path[k - 1][0], p[1] - path[k - 1][1], p[2] - path[k - 1][2]);
      if (k === nv - 25) topLen = len;
      const w = W * (k < nv - 25 ? 0.7 : 1 + (k - (nv - 25)) / 25 * 0.5);   // narrow stream, spreading as it falls
      for (let e = 0; e < 2; e++) {
        const o = (e - 0.5) * w, i = k * 2 + e;
        pos.set([p[0] + S[0] * o, p[1], p[2] + S[1] * o], i * 3);
        uv.set([e, len], i * 2);
      }
      if (k) { const a = (k - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx);
    const fallU = { uTime: uniforms.uTime, uLight: waterU.uLight, uLen: { value: len }, uTopLen: { value: topLen } };
    const fall = new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: fallU, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
      fragmentShader: /* glsl */`
        uniform float uTime, uLight, uLen, uTopLen; varying vec2 vUv;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
          return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
        void main(){
          float falling = smoothstep(uTopLen - 1., uTopLen + 1.5, vUv.y);
          float speed = mix(1.6, 7., falling);
          vec2 q = vec2(vUv.x * 9., vUv.y * .9 - uTime * speed);
          float streak = n(q) * .6 + n(q * vec2(2.3, 1.7) + 3.1) * .4;
          float foam = smoothstep(.38, .82, streak) + smoothstep(uLen - 3., uLen, vUv.y) * .8;
          vec3 col = mix(vec3(.22, .74, .86), vec3(.97, 1., 1.), clamp(foam * mix(.6, 1., falling) + falling * .2, 0., 1.)) * max(uLight, .25);
          float edge = smoothstep(0., .2, vUv.x + (n(vec2(vUv.y * 1.3 - uTime * speed * .5, 1.)) - .5) * .12) * smoothstep(1., .8, vUv.x);
          float a = edge * mix(.38, .95, clamp(foam, 0., 1.)) * (1. - smoothstep(uLen - .5, uLen, vUv.y) * .5);
          gl_FragColor = vec4(col, a);
        }`,
    }));
    fall.renderOrder = 2; fall.frustumCulled = false;
    scene.add(fall);
    // mist + spray: additive puffs rising and spreading from the plunge point
    const base = path[nv - 1], MIST = 90, mseed = new Float32Array(MIST * 3);
    for (let k = 0; k < MIST * 3; k++) mseed[k] = Math.random();
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MIST * 3), 3));
    mg.setAttribute('seed', new THREE.BufferAttribute(mseed, 3));
    const mist = new THREE.Points(mg, new THREE.ShaderMaterial({
      uniforms: { uTime: uniforms.uTime, uLight: waterU.uLight, uBase: { value: new THREE.Vector3(base[0], 0, base[2]) } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute vec3 seed; uniform float uTime; uniform vec3 uBase; varying float vA;
        void main(){
          float life = fract(uTime * (.18 + seed.z * .12) + seed.x);
          float a = seed.y * 6.2832, r = (.4 + seed.z * 1.6) * (.3 + life * 1.4);
          vec3 p = uBase + vec3(cos(a) * r, .1 + life * (2.5 + seed.x * 3.5), sin(a) * r);
          vA = sin(life * 3.1416) * .55;
          vec4 mv = modelViewMatrix * vec4(p, 1.);
          gl_PointSize = (70. + seed.y * 90.) * (1. + life) / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uLight; varying float vA;
        void main(){ float d = length(gl_PointCoord - .5); float a = smoothstep(.5, .1, d) * vA; gl_FragColor = vec4(vec3(.95, .98, 1.) * max(uLight, .25), a * .3); }`,
    }));
    mist.frustumCulled = false; mist.renderOrder = 3;
    scene.add(mist);
  }

  // ---------------------------------------------------------------- scenery outside the farm grid (instanced, deterministic)
  // map anchors (tools/make_island.py writes the waterfall + wreck spots into heights.json)
  const META = heights.meta || {};
  const SHACK = [60, 36], WRECK = META.wreck || [30, 124];
  const FALLS = { pool: META.pool || [25, -46], dir: META.fallDir || [0.7, -0.72], lip: META.lip || [10, 24] };
  const R = mulberry(20251125);
  const keepClear = (x, z) =>
    (Math.abs(x) < 43 && z > -3 && z < 84) ||                          // the farm grid (z 0..80) and its beach row
    (Math.abs(x - PIER.x) < 6 && z > PIER.z - 20 && z < PIER.z + 14) || Math.hypot(x - SHACK[0], z - SHACK[1]) < 8 ||
    Math.hypot(x - FALLS.pool[0], z - FALLS.pool[1]) < 11 ||
    Math.hypot(x - WRECK[0], z - WRECK[1]) < 12 || pathAt(x, z) > 0.02;
  const slopeAt = (x, z) => Math.abs(heightAt(x + 1, z) - heightAt(x - 1, z)) + Math.abs(heightAt(x, z + 1) - heightAt(x, z - 1));
  const groups = {};
  const place = (name, x, z, s, foliage = true, yaw = R() * Math.PI * 2, tilt = 0) => {
    const g = groups[name] ||= { list: [], foliage };
    g.list.push([x, heightAt(x, z) - 0.05, z, s, yaw, tilt]);
  };
  const nearFarm = (x, z) => Math.hypot(x - Math.max(-40, Math.min(40, x)), z - Math.max(0, Math.min(80, z)));
  for (let x = -200; x <= 200; x += 3) for (let z = -200; z <= 200; z += 3) {
    const px = x + (R() - 0.5) * 2.6, pz = z + (R() - 0.5) * 2.6;
    const h = heightAt(px, pz), r1 = R(), r2 = R();
    if (h < 0.55 || keepClear(px, pz)) continue;
    const sl = slopeAt(px, pz);
    if (sl > 1.4) { if (r1 < 0.03) place(['rock_m', 'rock_l', 'rock_s'][(r2 * 3) | 0], px, pz, 0.8 + R() * 1.2, false); continue; }
    if (h > 16) {           // the mountain's grassy ledges: palms and jungle trees, as in the reference art
      if (sl < 0.7 && r1 < 0.15) place(r2 < 0.5 ? ['palm_a', 'palm_b'][(R() * 2) | 0] : 'jungle_a', px, pz, 0.9 + R() * 0.6);
      else if (sl < 0.8 && r1 < 0.3) place(r2 < 0.5 ? 'bush_a' : 'fern', px, pz, 0.9 + R() * 0.7);
      else if (r1 < 0.19) place('rock_m', px, pz, 0.7 + R() * 0.9, false);
      continue;
    }
    if (h < 1.6) {          // beach and coastal flats: a fringe of palms
      if (r1 < 0.085) place(['palm_a', 'palm_b', 'palm_c'][(r2 * 3) | 0], px, pz, 0.8 + R() * 0.45, true, R() * 6.28, (R() - 0.5) * 0.12);
      else if (r1 < 0.1) place('rock_s', px, pz, 0.6 + R(), false);
      else if (r1 < 0.115 && h > 1.0) place('bush_a', px, pz, 0.7 + R() * 0.5);
    } else if (nearFarm(px, pz) < 40 && h < 7) {   // the open meadow round the farm: a few round trees and flowering bushes
      if (r1 < 0.022) place('jungle_a', px, pz, 0.8 + R() * 0.4);
      else if (r1 < 0.05) place('bush_a', px, pz, 0.7 + R() * 0.5);
      else if (r1 < 0.06) place('palm_a', px, pz, 0.9 + R() * 0.3);
    } else {                // inland jungle
      if (r1 < 0.03) place(r2 < 0.55 ? 'jungle_a' : 'jungle_b', px, pz, 0.85 + R() * 0.6);
      else if (r1 < 0.12) place('fern', px, pz, 0.8 + R() * 0.8);
      else if (r1 < 0.15) place('bush_a', px, pz, 0.8 + R() * 0.6);
      else if (r1 < 0.17) place(['palm_a', 'palm_b'][(r2 * 2) | 0], px, pz, 0.9 + R() * 0.4);
      else if (r1 < 0.19) place('rock_m', px, pz, 0.6 + R() * 0.8, false);
    }
  }
  // grey boulders in clusters along the waterline, some half sunk in the shallows; a big outcrop on the west beach
  for (let k = 0, n = 0; k < 6000 && n < 70; k++) {
    const cx = (R() - 0.5) * 380, cz = (R() - 0.5) * 380, h = heightAt(cx, cz);
    if (h < -0.9 || h > 0.45 || keepClear(cx, cz) || (Math.abs(cx) < 46 && cz > 60 && cz < 100 && R() < 0.7)) continue;
    n++;
    for (let m = 2 + ((R() * 3) | 0); m--;) {
      const x = cx + (R() - 0.5) * 6, z = cz + (R() - 0.5) * 6;
      place(R() < 0.5 ? 'rock_l' : 'rock_m', x, z, 1.1 + R() * 1.6, false, R() * 6.28, (R() - 0.5) * 0.3);
    }
  }
  for (const [x, z, s] of [[-124, 40, 4.2], [-119, 45, 3.0], [-128, 34, 2.6], [-121, 36, 2.2], [-116, 41, 1.6]]) place('rock_l', x, z, s, false, x + z);
  // clumps of big round-crowned trees with palms over flowering bushes: round the meadow, behind the beach,
  // at the mountain's foot and on its ledges (the cluster centres; the bushes themselves are built below)
  const bloomSpots = [];
  for (let k = 0, n = 0; k < 20000 && n < 150; k++) {
    const cx = (R() - 0.5) * 380, cz = (R() - 0.5) * 380, h = heightAt(cx, cz);
    if (h < 0.95 || keepClear(cx, cz) || slopeAt(cx, cz) > 0.8) continue;
    const nf = nearFarm(cx, cz), edgeOfMeadow = nf > 4 && nf < 34, beachBack = h < 2.4, ledge = h > 14;
    if (!(edgeOfMeadow || beachBack || ledge) || R() < 0.25) continue;
    n++;
    if (R() < 0.75) place('jungle_a', cx + (R() - 0.5) * 3, cz + (R() - 0.5) * 3, 1.5 + R() * 0.8);
    if (R() < 0.5) place(['palm_a', 'palm_b', 'palm_c'][(R() * 3) | 0], cx + (R() - 0.5) * 6, cz + (R() - 0.5) * 6, 1 + R() * 0.35);
    for (let m = 3 + ((R() * 5) | 0); m--;) {
      const x = cx + (R() - 0.5) * 8, z = cz + (R() - 0.5) * 8;
      if (heightAt(x, z) > 0.9 && !keepClear(x, z)) bloomSpots.push([x, z, 0.7 + R() * 0.7]);
    }
  }
  for (let k = 0; k < 14000; k++) {          // grass tufts + flowers on grassy ground
    const px = (R() - 0.5) * 300, pz = (R() - 0.5) * 300;
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

  // flowering bushes (hibiscus, bougainvillea): a low-poly green mound speckled with bright blossoms
  {
    const BR = mulberry(9090), leafG = [], bloomG = [];
    for (let k = 0; k < 4; k++) {
      const a = k / 4 * Math.PI * 2 + 0.4, r = k ? 0.45 : 0, s = k ? 0.55 : 0.75;
      leafG.push(new THREE.IcosahedronGeometry(s, 0).translate(Math.cos(a) * r, s * 0.8 + (k ? 0 : 0.25), Math.sin(a) * r));
    }
    for (let k = 0; k < 46; k++) {   // blossoms dotted over the crown: five-petal flowers, small, many
      const a = BR() * Math.PI * 2, e = 0.45 + BR() * 1.0, r = 0.82 + BR() * 0.12;
      const fl = new THREE.CircleGeometry(0.045 + BR() * 0.025, 5).rotateX(-Math.PI / 2 + (BR() - 0.5) * 1.2).rotateY(BR() * 6.28);
      bloomG.push(fl.translate(Math.cos(a) * Math.cos(e) * r * 1.05, 0.62 + Math.sin(e) * r * 0.8, Math.sin(a) * Math.cos(e) * r * 1.05));
    }
    const leaf = mergeGeometries(leafG), bloom = mergeGeometries(bloomG);
    const leafM = withDetail(new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true }), MAT.leaf, 'bush');
    const bloomM = withDetail(new THREE.MeshStandardMaterial({ roughness: 0.6, emissive: new THREE.Color('#2a1020'), side: THREE.DoubleSide }), MAT.organic, 'bloom');
    const L = makeInstanced('bush_a', bloomSpots.length, { foliage: true }), B = new THREE.InstancedMesh(bloom, bloomM, bloomSpots.length);   // leafy bush (leaf cards) under the blossoms
    const cols = ['#ff4f8b', '#ff7ab8', '#c45cf2', '#ffd23f', '#ffffff', '#ff8a3d', '#ff3d5e', '#9d7bff'], cc = new THREE.Color();
    const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), e4 = new THREE.Euler(), v4 = new THREE.Vector3(), s4 = new THREE.Vector3();
    bloomSpots.forEach(([x, z, s], k) => {
      m4.compose(v4.set(x, heightAt(x, z) - 0.1, z), q4.setFromEuler(e4.set(0, BR() * 6.28, 0)), s4.set(s, s * (0.8 + BR() * 0.3), s));
      B.setMatrixAt(k, m4);
      const lm = m4.clone().scale(s4.set(1.35, 1.35, 1.35));
      L.setAt(k, lm, cc.setHSL(0.27 + BR() * 0.06, 0.25, 0.82 + BR() * 0.12));
      B.setColorAt(k, cc.set(cols[(BR() * cols.length) | 0]));
    });
    B.castShadow = B.receiveShadow = true; scene.add(B, L);
  }

  // ---------------------------------------------------------------- tropical extras: coral heads in the shallows,
  // schools of reef fish, starfish and shells on the sand. Built here from simple shapes, coloured per instance.
  const tropic = (() => {
    const TR = mulberry(4242), pick = a => a[(TR() * a.length) | 0];
    const lit = withDetail(new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0 }), MAT.organic, 'reef');
    const spots = (n, lo, hi, test = () => true) => {   // n random spots with ground height in [lo, hi]
      const out = [];
      for (let k = 0; k < n * 60 && out.length < n; k++) {
        const x = (TR() - 0.5) * 400, z = (TR() - 0.5) * 400, h = heightAt(x, z);
        if (h > lo && h < hi && test(x, z)) out.push([x, h, z]);
      }
      return out;
    };
    const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), e4 = new THREE.Euler(), v4 = new THREE.Vector3(), s4 = new THREE.Vector3(), col = new THREE.Color();
    const scatter = (geo, list, colors, size, flat = false) => {
      const im = new THREE.InstancedMesh(geo, lit, list.length);
      list.forEach(([x, h, z], k) => {
        const sc = size * (0.6 + TR() * 0.8);
        e4.set(flat ? 0 : (TR() - 0.5) * 0.3, TR() * 6.28, flat ? 0 : (TR() - 0.5) * 0.3);
        m4.compose(v4.set(x, h - (flat ? -0.01 : sc * 0.15), z), q4.setFromEuler(e4), s4.set(sc, sc * (flat ? 1 : 0.7 + TR() * 0.6), sc));
        im.setMatrixAt(k, m4); im.setColorAt(k, col.set(pick(colors)).multiplyScalar(0.85 + TR() * 0.3));
      });
      im.receiveShadow = true; im.castShadow = !flat;
      scene.add(im);
      return im;
    };
    // coral: round brain coral, branching staghorn, flat plate coral
    const brain = new THREE.IcosahedronGeometry(1, 2);
    { const p = brain.attributes.position; for (let i = 0; i < p.count; i++) { const y = p.getY(i); p.setY(i, y > 0 ? y * 0.75 : y * 0.2); } brain.computeVertexNormals(); }
    const branches = [];
    for (let k = 0; k < 7; k++) {
      const c = new THREE.ConeGeometry(0.09, 1, 5).translate(0, 0.5, 0);
      c.rotateZ((k ? 0.35 + (k % 3) * 0.2 : 0)).rotateY(k * 0.9); branches.push(c);
    }
    const stag = mergeGeometries(branches);
    const plate = new THREE.CylinderGeometry(1, 0.35, 0.18, 9).translate(0, 0.4, 0);
    const reef = ['#ff6f91', '#ff9f43', '#a66cff', '#ffd23f', '#3ec1a8', '#ff5e5e', '#f78fb3'];
    const reefSpot = (x, z) => (TR() < 0.75 ? Math.abs(x) > 6 || z < 60 : true);
    scatter(brain, spots(230, -3.4, -0.7, reefSpot), reef, 0.55);
    scatter(stag, spots(180, -3.4, -0.9, reefSpot), reef, 0.7);
    scatter(plate, spots(100, -3.6, -1.0, reefSpot), ['#ffb86b', '#c39bff', '#7fd6c8'], 0.6);
    // starfish and shells on the beach
    const star = new THREE.Shape();
    for (let k = 0; k <= 10; k++) { const a = k / 10 * Math.PI * 2, r = k % 2 ? 0.42 : 1; star[k ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r); }
    const starGeo = new THREE.ExtrudeGeometry(star, { depth: 0.12, bevelEnabled: true, bevelSize: 0.08, bevelThickness: 0.06, bevelSegments: 2 }).rotateX(-Math.PI / 2);
    const shellGeo = new THREE.SphereGeometry(1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.55, 1.25);
    const sand = (x, z) => !keepClear(x, z);
    scatter(starGeo, spots(120, 0.08, 0.9, sand), ['#ff7a3d', '#ff4f6d', '#ffb347', '#e8559a'], 0.16, true);
    scatter(shellGeo, spots(160, 0.08, 1.2, sand), ['#fff3e3', '#ffd9c7', '#f6c6d8', '#efe1c4'], 0.08, true);
    // reef fish: little bodies with a tail, in schools that loop around a patch of shallow water
    const fishShape = new THREE.Shape();
    fishShape.moveTo(0.5, 0); fishShape.quadraticCurveTo(0.2, 0.22, -0.25, 0.06); fishShape.lineTo(-0.5, 0.2); fishShape.lineTo(-0.42, 0);
    fishShape.lineTo(-0.5, -0.2); fishShape.lineTo(-0.25, -0.06); fishShape.quadraticCurveTo(0.2, -0.22, 0.5, 0);
    const fishGeo = new THREE.ExtrudeGeometry(fishShape, { depth: 0.08, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.04, bevelSegments: 1 })
      .translate(0, 0, -0.04).rotateY(Math.PI / 2);   // nose along +z
    const schoolCols = [['#ffd23f', '#ffe066'], ['#2f9bff', '#59c3ff'], ['#ff8c2f', '#ffffff'], ['#ff5fa2', '#ffb3d1'], ['#3fe0c5', '#b6ffef']];
    const homes = spots(22, -3.0, -1.1);
    const PER = 12, fish = new THREE.InstancedMesh(fishGeo, lit, homes.length * PER);
    fish.castShadow = false; fish.frustumCulled = false;
    const school = homes.map(([x, h, z], i) => ({ x, z, h, r: 2 + TR() * 3, sp: (0.25 + TR() * 0.3) * (TR() < 0.5 ? -1 : 1), ph: TR() * 6.28, cols: schoolCols[i % schoolCols.length],
      off: Array.from({ length: PER }, () => [(TR() - 0.5) * 2.2, (TR() - 0.5) * 0.5, (TR() - 0.5) * 2.2, TR() * 6.28, 0.26 + TR() * 0.12]) }));
    school.forEach((S, i) => S.off.forEach((o, j) => fish.setColorAt(i * PER + j, col.set(S.cols[j % 2]))));
    scene.add(fish);
    const update = (t, level) => {
      school.forEach((S, i) => {
        const a = S.ph + t * S.sp, cx = S.x + Math.cos(a) * S.r, cz = S.z + Math.sin(a) * S.r;
        const yaw = Math.atan2(-Math.sin(a) * Math.sign(S.sp), Math.cos(a) * Math.sign(S.sp));
        const top = Math.min(level - 0.35, S.h + 1.4), y0 = Math.max(S.h + 0.35, top - 0.6);
        S.off.forEach(([ox, oy, oz, ph, sz], j) => {
          const wig = Math.sin(t * 9 + ph) * 0.25;
          v4.set(cx + ox + Math.sin(t * 0.7 + ph) * 0.3, y0 + oy, cz + oz + Math.cos(t * 0.6 + ph) * 0.3);
          if (level - S.h < 0.5) v4.y = -50;   // stranded at low tide: hide
          m4.compose(v4, q4.setFromEuler(e4.set(0, yaw + wig, 0)), s4.setScalar(sz));
          fish.setMatrixAt(i * PER + j, m4);
        });
      });
      fish.instanceMatrix.needsUpdate = true;
    };
    return { update };
  })();
  const wildlife = createWildlife({ scene, heightAt, game });

  // landmarks
  const put = (name, x, z, yaw = 0, y = null, s = 1) => {
    const m = makeMesh(name, { foliage: name.startsWith('palm') });
    m.position.set(x, y ?? heightAt(x, z), z); m.rotation.y = yaw; m.scale.setScalar(s);
    scene.add(m);
    if (name === 'lantern' || name === 'beach_shack') lampSpots.push([x, m.position.y + (name === 'lantern' ? 1.4 : 2.2), z]);
    return m;
  };
  const lampSpots = [];
  put('trader_pier', PIER.x, PIER.z, Math.PI / 2, -0.05);   // runs along z: land end north, boat berth at the south end
  put('beach_shack', SHACK[0], SHACK[1], Math.PI * 0.5, null, 1.6);   // the shop hut, a landmark from across the meadow
  world.wreck = put('shipwreck', WRECK[0], WRECK[1], 0.4, -0.35);
  // after the ending the repaired ship rides at anchor where the wreck was
  const fixedShip = new THREE.Group();
  fixedShip.add(makeMesh('intro_ship'));
  const fsMain = makeMesh('intro_mainsails'); fsMain.position.set(-0.4, 0, 0); fsMain.scale.set(0.35, 1, 1); fixedShip.add(fsMain);
  const fsFore = makeMesh('intro_foremast'); fsFore.position.set(3.2, 1.503, 0); fixedShip.add(fsFore);
  fixedShip.position.set(WRECK[0], 0, WRECK[1]); fixedShip.rotation.y = Math.atan2(0.954, -0.3);
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
  // the shop hut's yard, the pier head (barrels, crates, a sign), and lanterns along the track from the farm to the pier
  put('crate', SHACK[0] + 2.5, SHACK[1] + 3.5, 0.5); put('barrel', SHACK[0] - 2.8, SHACK[1] + 3.2, 0); put('log', SHACK[0] + 4, SHACK[1] - 4, 1.2);
  put('barrel', PIER.x - 3.2, PIER.z - 13.5, 0); put('barrel', PIER.x - 3.9, PIER.z - 12.6, 0.7); put('crate', PIER.x + 3.4, PIER.z - 14.5, 0.3);
  put('sign_forsale', PIER.x - 3, PIER.z - 16.5, Math.PI * 0.85);
  for (const [x, z] of [[-44, 70], [-49, 76], [-57, 76], [-42, 62]]) put('lantern', x, z, Math.atan2(-x, -z));

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
  const DOCK = new THREE.Vector3(PIER.x + 3.2, 0, PIER.z + 9.5), SEA = new THREE.Vector3(PIER.x + 60, 0, PIER.z + 190);
  function stepBoat(now) {
    const at = game.state?.trader?.at || 0, age = (now - at) / 1000;
    if (!at || age > 215 || age < 0) { boat.visible = false; return; }
    boat.visible = true;
    let p, yaw;
    if (age < 25) { const t = smooth(0, 1, age / 25); p = v4.lerpVectors(SEA, DOCK, t); yaw = Math.atan2(-(DOCK.z - SEA.z), DOCK.x - SEA.x); }
    else if (age < 180) { p = v4.copy(DOCK); yaw = Math.PI / 2; }
    else { const t = smooth(0, 1, (age - 180) / 35); p = v4.lerpVectors(DOCK, SEA, t); yaw = Math.atan2(-(SEA.z - DOCK.z), SEA.x - DOCK.x); }
    const tt = now / 1000;
    boat.position.set(p.x, level + Math.sin(tt * 1.3) * 0.12 - 0.15, p.z);
    boat.rotation.set(Math.sin(tt * 0.9) * 0.04, lerp(boat.rotation.y, yaw, 0.05), Math.sin(tt * 1.2) * 0.05);
  }

  // distant islands on the horizon: hazy blue silhouettes so the sea doesn't just run out into nothing
  {
    const DR = mulberry(31337), mat = new THREE.MeshStandardMaterial({ color: '#56704e', roughness: 0.95, flatShading: true });
    for (const [ang, r, w, hgt] of [[0.5, 1150, 150, 70], [1.35, 1300, 220, 95], [2.6, 1050, 120, 45], [3.5, 1250, 260, 110], [4.4, 980, 90, 38], [5.5, 1200, 180, 60]]) {
      const g = new THREE.IcosahedronGeometry(1, 4), p = g.attributes.position;
      const ph = DR() * 10;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const bump = 1 + 0.25 * Math.sin(x * 3 + ph) * Math.cos(z * 2.4 + ph) + 0.12 * Math.sin(x * 7 + z * 5);
        p.setXYZ(i, x * w, Math.max(y, -0.3) * hgt * bump, z * w * (0.55 + DR() * 0.02));
      }
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat);
      m.position.set(Math.cos(ang) * r, -6, Math.sin(ang) * r); m.rotation.y = DR() * 6.28;
      m.castShadow = m.receiveShadow = false;
      scene.add(m);
    }
  }

  // drifting clouds
  const clouds = [];
  const CR = mulberry(77);
  for (let k = 0; k < 22; k++) {
    const c = makeMesh(['cloud_a', 'cloud_b', 'cloud_c'][(CR() * 3) | 0], { castShadow: false });
    const a = CR() * Math.PI * 2, r = 120 + CR() * 380;
    c.position.set(Math.cos(a) * r, 75 + CR() * 45, Math.sin(a) * r);
    c.scale.setScalar(3 + CR() * 3.4); c.scale.y *= 0.9;
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
  // the scene, then aerial perspective from its depth: height haze (thick low over the sea, thinning with
  // altitude, glowing toward the sun) that swallows the far ocean and the distant islands, and a gentle depth of
  // field that softens the far distance
  const hazeU = {
    tColor: { value: null }, tDepth: { value: null }, uProjInv: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() },
    uCam: { value: new THREE.Vector3() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uHaze: { value: new THREE.Color() }, uSunCol: { value: new THREE.Color() },
    uDens: { value: 0.0009 }, uFall: { value: 1 / 55 }, uDof: { value: 1 }, uDofNear: { value: 150 }, uDofFar: { value: 700 }, uTexel: { value: new THREE.Vector2() },
  };
  class ScenePass extends Pass {
    constructor() {
      super();
      this.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(1, 1) });
      this.quad = new FullScreenQuad(new THREE.ShaderMaterial({
        uniforms: hazeU, depthTest: false, depthWrite: false,
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
        fragmentShader: /* glsl */`
          uniform sampler2D tColor, tDepth; uniform mat4 uProjInv, uViewInv; uniform vec3 uCam, uSunDir, uHaze, uSunCol;
          uniform float uDens, uFall, uDof, uDofNear, uDofFar; uniform vec2 uTexel; varying vec2 vUv;
          float distAt(vec2 uv, out vec3 rd){
            float d = texture2D(tDepth, uv).x;
            vec4 v = uProjInv * vec4(uv * 2. - 1., min(d, .999999) * 2. - 1., 1.); v /= v.w;
            vec3 wp = (uViewInv * vec4(v.xyz, 1.)).xyz, ray = wp - uCam;
            float dist = length(ray); rd = ray / dist;
            return d >= .999999 ? 6000. : dist;   // the sky dome: looking through all of the air
          }
          void main(){
            vec3 rd; float dist = distAt(vUv, rd);
            vec3 col = texture2D(tColor, vUv).rgb;
            float coc = uDof * smoothstep(uDofNear, uDofFar, dist) * 3.2;   // blur radius in pixels, far things only
            if (coc > .3) {
              vec3 acc = col; float wsum = 1.;
              for (int i = 0; i < 12; i++) {
                float a = float(i) * 2.39996, r = sqrt(float(i) + .5) / sqrt(12.) * coc;
                vec2 uv = vUv + vec2(cos(a), sin(a)) * r * uTexel;
                vec3 rd2; float d2 = distAt(uv, rd2);
                float w = smoothstep(uDofNear * .8, uDofNear, d2);   // never pull sharp near things into the blur
                acc += texture2D(tColor, uv).rgb * w; wsum += w;
              }
              col = acc / wsum;
            }
            float y0 = max(uCam.y, 0.), dy = rd.y * dist;
            float e0 = exp(-y0 * uFall), e1 = exp(-max(y0 + dy, 0.) * uFall);
            float od = uDens * dist * (abs(dy) > .05 ? (e0 - e1) / (dy * uFall) : e0);
            float f = 1. - exp(-od);
            vec3 hz = uHaze + uSunCol * pow(max(dot(rd, uSunDir), 0.), 6.) * .35;
            col = mix(col, hz, f);
            if (any(isnan(col)) || any(isinf(col))) col = hz;
            gl_FragColor = vec4(min(col, vec3(64.)), 1.);
          }`,
      }));
    }
    setSize(w, h) { this.rt.setSize(w, h); hazeU.uTexel.value.set(1 / w, 1 / h); }
    render(r, write) {
      r.setRenderTarget(this.rt); r.clear(); r.render(scene, camera);
      hazeU.tColor.value = this.rt.texture; hazeU.tDepth.value = this.rt.depthTexture;
      hazeU.uProjInv.value.copy(camera.projectionMatrixInverse); hazeU.uViewInv.value.copy(camera.matrixWorld); hazeU.uCam.value.copy(camera.position);
      r.setRenderTarget(this.renderToScreen ? null : write); this.quad.render(r);
    }
  }
  const renderPass = new ScenePass();
  // water reflections: the scene mirrored in the water plane at a third of the screen size (high quality only)
  const reflector = new Reflector(new THREE.PlaneGeometry(1, 1), { textureWidth: 512, textureHeight: 512, clipBias: 0.02 });
  reflector.rotation.x = -Math.PI / 2;
  const _rm = new THREE.Matrix4();
  function renderReflection() {
    reflector.position.set(camera.position.x, waterU.uLevel.value, camera.position.z);
    reflector.updateMatrixWorld();
    water.visible = false;
    reflector.onBeforeRender(renderer, scene, camera);
    water.visible = true;
    waterU.tRefl.value = reflector.getRenderTarget().texture;
    waterU.uReflMat.value.multiplyMatrices(reflector.material.uniforms.textureMatrix.value, _rm.copy(reflector.matrixWorld).invert());
  }
  // ambient occlusion: soft contact shadow where things meet the ground, in furrows, under leaves
  const ao = new GTAOPass(scene, camera, size.x, size.y);
  ao.updateGtaoMaterial({ radius: 0.7, distanceExponent: 1.4, thickness: 1.2, scale: 1.15, samples: 12 });
  ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
  ao.blendIntensity = 0.55;
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
  composer.addPass(ao);
  composer.addPass(godRays);
  composer.addPass(bloom);
  composer.addPass(outline);
  composer.addPass(vmPass);
  composer.addPass(grade);
  composer.addPass(output);

  let quality = 'high', reflOn = false, viewDist = 1;
  world.setQuality = q => {
    quality = q === 'low' ? 'low' : 'high';
    const hi = quality === 'high';
    renderer.setPixelRatio(hi ? Math.min(devicePixelRatio, 1.75) : 1);
    godRays.enabled = hi; bloom.enabled = hi;
    world.applyGraphics();
    world.resize();
  };
  // the graphics settings: view distance (draw distance, haze, shadow range, texture detail range), shadows
  // high / low, ambient occlusion, depth of field, water reflections
  world.applyGraphics = () => {
    const st = game.settings || {}, hi = quality === 'high';
    viewDist = Math.min(2, Math.max(0.5, +(st.viewDist ?? 1)));
    camera.far = Math.max(700, 1600 * viewDist); camera.updateProjectionMatrix();
    const shHigh = (st.shadows ?? (hi ? 'high' : 'low')) === 'high';
    const ms = shHigh ? 4096 : 1536;
    if (sun.shadow.mapSize.x !== ms) { sun.shadow.mapSize.set(ms, ms); sun.shadow.map?.dispose(); sun.shadow.map = null; }
    renderer.shadowMap.type = shHigh ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    const ext = 48 * Math.min(1.8, Math.max(0.6, viewDist)) * (shHigh ? 1 : 0.8);
    sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.far = 260 + ext * 2; sc.updateProjectionMatrix();
    ao.enabled = st.ao !== false && hi;
    reflOn = st.reflections !== false && hi;
    waterU.uReflOn.value = reflOn ? 0.85 : 0;
    hazeU.uDof.value = st.dof === false ? 0 : 1;
    uniforms.uDetailDist.value = 60 * viewDist;
  };
  world.renderSize = null;   // [w, h] to render at a fixed size (the trailer recorder), else the window
  world.resize = () => {
    const [w, h] = world.renderSize || [innerWidth, innerHeight];
    renderer.setSize(w, h, false);
    camera.aspect = vmCamera.aspect = w / h;
    camera.updateProjectionMatrix(); vmCamera.updateProjectionMatrix();
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(w, h);
    reflector.getRenderTarget().setSize(Math.max(256, Math.round(w / 3)), Math.max(144, Math.round(h / 3)));
    gradeU.uRes.value.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
  };
  world.setOutline = objs => { outline.selectedObjects = objs || []; };
  let flashV = 0;
  world.flash = (s = 1) => { flashV = Math.max(flashV, s); };
  // the water's height at a point: the same Gerstner sum as the water shader (vertical part)
  world.waveAt = (x, z) => {
    const t = uniforms.uTime.value, depth = waterU.uLevel.value - heightAt(x, z);
    const amp = Math.min(1, Math.max(0.16, depth / 5)) * (1 + waterU.uRough.value * 1.6);
    let y = 0;
    for (const [dx, dz, L, A] of WAVES) { const l = Math.hypot(dx, dz), k = Math.PI * 2 / L; y += A * amp * Math.sin(k * (dx * x + dz * z) / l - Math.sqrt(9.81 * k) * t); }
    return waterU.uLevel.value + y * Math.min(1, Math.max(0, depth / 0.6));
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
    // keyframes across the day: night .0 â†’ dawn .25 â†’ day .34â€“.66 â†’ dusk .75 â†’ night .83
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
    envT -= dt;
    if (envT <= 0) {   // refresh the reflected sky every couple of seconds (it changes slowly)
      envT = 2;
      envU.uZen.value.copy(zen); envU.uHor.value.copy(hor); envU.uGround.value.copy(hGround); envU.uSunDir.value.copy(world.sunDir); envU.uSunCol.value.copy(sunCol).multiplyScalar(dayF);
      envRT?.dispose();
      envRT = pmrem.fromScene(envScene, 0, 0.1, 100);
      scene.environment = envRT.texture;
    }
    scene.environmentIntensity = lerp(0.12, 0.45, dayF) * (1 - wx.dark * 0.4);
    skyU.uSunDir.value.copy(world.sunDir); skyU.uSunCol.value.copy(sunCol);
    skyU.uDay.value = dayF; skyU.uCloudy.value = wx.dark;
    scene.fog.color.copy(hor).lerp(tmpB.set('#3f93ea'), 0.3 * dayF * (1 - wx.dark));   // distant sea stays blue, as in the art
    // distance is the haze pass's job on fine days (height fog from the depth buffer); this fog only closes in
    // for storms, and the water shader shares it
    scene.fog.near = lerp(3500, 25, wx.dark) * lerp(0.7, 1, dayF);
    scene.fog.far = lerp(5000, 170, wx.dark) * lerp(0.75, 1, dayF);
    hazeU.uHaze.value.copy(scene.fog.color).lerp(tmpB.set('#ffffff'), 0.12 * dayF);
    hazeU.uSunDir.value.copy(world.sunDir); hazeU.uSunCol.value.copy(sunCol).multiplyScalar(dayF * (1 - wx.dark));
    hazeU.uDens.value = 0.0011 / viewDist * lerp(1, 7, wx.dark) * lerp(1.25, 1, dayF);
    hazeU.uDofNear.value = 150 * viewDist; hazeU.uDofFar.value = 750 * viewDist;

    // sun by day, moon by night (same light, flipped)
    const useMoon = sunUp < -0.02;
    const L = useMoon ? tmpB.set('#9fbcff') : sunCol;
    const lightDir = useMoon ? focus.copy(world.sunDir).negate() : focus.copy(world.sunDir);
    const elev = Math.max(0.12, lightDir.y);
    sun.color.copy(L);
    sun.intensity = (useMoon ? 0.95 * smooth(-0.02, -0.15, sunUp) : 3.0 * smooth(-0.02, 0.18, sunUp)) * (1 - wx.dark * 0.7);
    hemi.color.copy(hSky); hemi.groundColor.copy(hGround);
    hemi.intensity = lerp(0.55, 1.08, dayF) * (1 - wx.dark * 0.25) + flashV * 1.5;   // sky fill: shade stays bright and colourful
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
    tropic.update(uniforms.uTime.value, level);
    wildlife.update(dt, uniforms.uTime.value, level);
    flyU.uCam.value.copy(camera.position); flyU.uAmt.value = night * (1 - wx.rain) * (quality === 'high' ? 1 : 0.6);
    flies.visible = flyU.uAmt.value > 0.01;
    if (fixedShip.visible) { const tt = now / 1000; fixedShip.position.y = level + Math.sin(tt * 1.1) * 0.08 - 0.1; fixedShip.rotation.z = Math.sin(tt * 0.9) * 0.025; }

    // rain
    const cp = camera.position;
    rainMat.opacity = wx.rain * 0.42;
    wetU.value += ((wx.rain > 0.1 ? 1 : 0) - wetU.value) * Math.min(1, dt * (wx.rain > 0.1 ? 0.25 : 0.02));   // soaks in quickly, dries slowly
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
    gradeU.uSat.value = lerp(1.4, 0.78, wx.dark) * lerp(0.68, 1, dayF) * (game.settings?.sat ?? 1);   // vivid by day; settings slider scales it
    uniforms.uParallax.value = game.settings?.parallax ?? 1;   // night drains colour, like our eyes do
    gradeU.uVig.value = 0.3 + (1 - dayF) * 0.14 + wx.dark * 0.15 + world.cine.letterbox * 0.1;
    bloom.strength = lerp(0.55, 0.32, dayF);   // lights glow more in the dark
    sky.position.copy(camera.position);
  };

  world.render = () => { if (reflOn) renderReflection(); composer.render(); world.afterRender?.(); };
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
