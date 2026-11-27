// First-person controller: pointer-lock look, movement + collisions, targeting, tool use, build mode,
// and the held-item viewmodel (Blender models from assets.glb, procedurally animated).
import * as THREE from 'three';
import { ITEMS, CROPS, BUILDINGS, RECIPES, SHOP, TOOL_LV, BUCKET_CAP, HITS, GRID, TILE, ORIGIN, ORIGIN_Z, PLOT, TILL_COST, fmtTime, fmtNum } from './data.js';
import {
  tile, inGrid, owned, area, hoeShape, sickleShape, bucketShape, pouchShape, canPlace, ripe, remaining,
  plotState, storeCount, storeCap, buildCount, buildCap,
} from './state.js';
import { heightAt, tileX, tileZ } from './terrain.js';
import { makeMesh, lib } from './assets.js';

const JUMP_V = 5.4, GRAVITY = 16;   // ~0.9 m jump
const EYE = 1.65, WALK = 4.5, SPRINT = 7.5, REACH = 5.5, PR = 0.32, OBST_R = 0.6;
const PITCH_MAX = 1.5, BASE_FOV = 70;
// bridge deck (fixed building at tiles 34..36 x 20; model deck is 9 m long, 2.4 m wide, top at 1.75)
const DECK_Y = 1.75, DECK_X0 = tileX(35) - 4.4, DECK_X1 = tileX(35) + 4.4, DECK_Z0 = tileZ(20) - 1.05, DECK_Z1 = tileZ(20) + 1.05;
const METAL = { broken: '#7d7a74', normal: '#9aa3ab', iron: '#c9d2d8', golden: '#f2c94c' };
// seed packet colours per crop (not in data.js)
const CROP_TINT = {
  wheat: '#e3c565', carrot: '#f08a24', potato: '#b58b5a', lettuce: '#7cc444', radish: '#e0446a', onion: '#c9a0dc',
  corn: '#f2d13d', tomato: '#e8442e', beans: '#5fa83a', peppers: '#d8342a', cucumber: '#3f8f3a', sugarcane: '#a6c94a',
  pumpkin: '#f28c28', strawberry: '#e8364f', watermelon: '#3fa34d', pineapple: '#f2c13d', rice: '#efe6c8', cotton: '#f4f1ea',
  banana: '#f5d742', coconut: '#8a5a36', orange: '#f39c1f', mango: '#f2b33d', apple: '#d9342b', papaya: '#f28a3d',
  cacao: '#7a4a2a', coffee: '#6b3a24', vanilla: '#efe1b0', dragonfruit: '#e8408f', starfruit: '#f2e04a', goldpineapple: '#f2c94c',
};
const OBST_NAME = { palm: 'Palm tree', jungle: 'Jungle tree', rock: 'Rock', bush: 'Bush' };
const ACT_TEXT = {
  till: 'Till', plant: 'Plant', water: 'Water', refill: 'Refill', harvest: 'Harvest', chop: 'Chop', mine: 'Mine',
  fertilize: 'Fertilize', place: 'Place', scare: 'Shoo', grab: 'Pick up', move: 'Put down',
};
const ACT_IDX = { till: 1, plant: 2, water: 3, refill: 4, harvest: 5, chop: 6, mine: 7, fertilize: 8, place: 9, scare: 10, grab: 11, move: 12 };
const SHAPE_IDX = { one: 0, row: 1, '3x3': 2 };
const BDESC = {};
for (const e of SHOP) if (e.effect.item?.startsWith('bp_')) BDESC[e.effect.item.slice(3)] = e.desc;

// how each model sits in the fist: c = grip point in model space, r = euler, s = scale
const POSE = {
  tool_hoe: { c: [0, 0.12, 0], r: [-0.75, Math.PI * 1.18, -0.35], s: 0.5 },
  tool_axe: { c: [0, 0.06, 0], r: [-0.6, Math.PI, -0.3], s: 0.55 },
  tool_pickaxe: { c: [0, 0.06, 0], r: [-0.6, Math.PI, -0.3], s: 0.55 },
  tool_sickle: { c: [0, 0.06, 0], r: [-0.3, Math.PI, 0.1], s: 0.7 },
  tool_bucket: { c: [0, 0.47, 0.12], r: [0, -Math.PI / 2, 0], s: 0.6 },
  tool_fertilizer: { c: [0, 0.12, 0], r: [-0.15, 0.4, 0], s: 0.75 },
  tool_blueprint: { c: [0.25, 0, 0], r: [0, 0.45, 0.2], s: 0.9 },
  seed_packet: { c: [0, 0.08, 0], r: [-0.25, 0.1, -0.25], s: 0.9 },
  sapling: { c: [0, 0.05, 0], r: [0, 0.3, 0], s: 0.9 },
};
const ANIM_LEN = { hoe: 0.45, chop: 0.42, water: 0.55, plant: 0.5, harvest: 0.38, fert: 0.55, place: 0.35, refill: 0.75, scare: 0.4, poke: 0.25, grab: 0.3 };
const ANIM_OF = { till: 'hoe', plant: 'plant', water: 'water', refill: 'refill', harvest: 'harvest', chop: 'chop', mine: 'chop', fertilize: 'fert', place: 'place', move: 'place', scare: 'scare', grab: 'grab' };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sm = x => x * x * (3 - 2 * x);
const k01 = (u, a, b) => sm(clamp((u - a) / (b - a), 0, 1));

export function createPlayer(game) {
  const world = game.world, cam = world.camera;
  const canvas = world.renderer?.domElement || document.getElementById('game');
  cam.rotation.order = 'YXZ';
  const reducedMotion = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const player = {
    pos: new THREE.Vector3(0, 0, 76), yaw: Math.PI, pitch: 0,   // yaw: facing (sin yaw, cos yaw); π = north (-Z) enabled: false,
    target: null, buildMode: false,
    held: null, anim: null,            // for net/remotes: held item id, current action animation
    update, spawn, lock, unlock, pickDonkeySpot,
  };
  const vel = new THREE.Vector3();
  const keys = new Set();
  let locked = false, selfUnlock = false;
  let mouseDX = 0, mouseDY = 0, mouseHeld = false, fresh = false, cooldown = 0, lastUseKey = -1, lastWheel = 0;
  let air = 0, vy = 0, wantJump = false;   // height above the ground while jumping
  let eyeY = EYE, stepPhase = 0, lastStep = 0, moveAmt = 0, sprintAmt = 0, roll = 0, time = 0;
  let placeRot = 0, moving = null;   // moving: {bid, type, rot}
  const ui = () => game.ui, view = () => game.view;
  const uiOpen = () => !!game.ui?.isOpen?.() || !!game.chat?.open;
  const state = () => game.state;
  const me = () => game.state?.players?.[game.pid];

  // ---------------------------------------------------------------- pointer lock + input
  function lock() {
    if (!player.enabled || uiOpen() || document.pointerLockElement === canvas) return;
    try { const p = canvas.requestPointerLock(); p?.catch?.(() => {}); } catch { /* not allowed yet */ }
  }
  function unlock() {
    if (document.pointerLockElement) { selfUnlock = true; document.exitPointerLock(); }
  }
  function releaseInput() { keys.clear(); mouseHeld = false; fresh = false; }

  // ---------------------------------------------------------------- sending Biscuit somewhere: the next click picks the spot
  let picking = false;
  const _ray = new THREE.Vector3();
  function pickDonkeySpot() {
    picking = true;
    ui()?.toast?.('Click a spot to send Biscuit there (right-click or Esc cancels)');
    lock();
  }
  function aimGround(max = 80) {   // march along the view ray until it dips under the ground
    cam.getWorldDirection(_ray);
    const o = cam.position;
    for (let t = 0.5; t < max; t += 0.25) {
      const x = o.x + _ray.x * t, y = o.y + _ray.y * t, z = o.z + _ray.z * t;
      if (y <= heightAt(x, z)) return heightAt(x, z) < -0.3 ? null : [x, z];
    }
    return null;
  }
  function sendDonkey() {
    const p = aimGround();
    if (!p) { ui()?.toast?.('Biscuit can’t go there. Aim at the ground nearby', 'warn'); return; }
    picking = false;
    game.do({ type: 'donkey', m: 'go', x: p[0], z: p[1] });
    ui()?.toast?.('Off he trots');
  }

  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    if (locked) { selfUnlock = false; return; }
    const mine = selfUnlock; selfUnlock = false;
    releaseInput();
    if (!mine && player.enabled && !uiOpen()) ui()?.open('pause');
  });
  document.addEventListener('pointerlockerror', () => { selfUnlock = false; });
  document.addEventListener('mousemove', e => {
    if (!locked) return;
    // clamp the occasional giant delta browsers report right after locking
    mouseDX += clamp(e.movementX, -250, 250); mouseDY += clamp(e.movementY, -250, 250);
  });
  document.addEventListener('mousedown', e => {
    if (!player.enabled || uiOpen()) return;
    if (!locked) { if (e.target === canvas) lock(); return; }
    if (picking && e.button === 0) { sendDonkey(); return; }
    if (picking && e.button === 2) { picking = false; ui()?.toast?.('Cancelled'); return; }
    if (e.button === 0) { mouseHeld = true; fresh = true; }
  });
  document.addEventListener('mouseup', e => { if (e.button === 0) mouseHeld = false; });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('blur', releaseInput);
  window.addEventListener('wheel', e => {
    if (!player.enabled || uiOpen() || !locked || !e.deltaY) return;
    const t = performance.now();
    if (t - lastWheel < 70) return;
    lastWheel = t;
    const p = me(); if (!p) return;
    game.do({ type: 'sel', slot: (p.sel + Math.sign(e.deltaY) + 9) % 9 });
  }, { passive: true });
  window.addEventListener('keyup', e => keys.delete(e.code));
  window.addEventListener('keydown', e => {
    if (!player.enabled || uiOpen() || e.repeat) return;
    const c = e.code;
    keys.add(c);
    if (c.startsWith('Digit') && c !== 'Digit0') game.do({ type: 'sel', slot: +c.slice(5) - 1 });
    else if (c === 'Space') wantJump = true;
    else if (c === 'KeyE') interact();
    else if (c === 'KeyF' && player.target?.kind === 'donkey') game.do({ type: 'pet' });
    else if (c === 'Escape' && picking) { picking = false; ui()?.toast?.('Cancelled'); }
    else if (c === 'KeyB') toggleBuild();
    else if (c === 'KeyR') { if (moving) moving.rot = (moving.rot + 1) % 4; else placeRot = (placeRot + 1) % 4; }
    else if (c === 'KeyX' && player.buildMode) storeBuilding();
    else if (c === 'Escape' && !locked) ui()?.open('pause');
    if (c === 'Space' || c === 'Tab') e.preventDefault();
  });
  game.on?.('ui-open', () => { releaseInput(); unlock(); });

  // ---------------------------------------------------------------- spawn / ground / collision
  function spawn(x = 2, z = 76, yaw = Math.PI) {
    player.pos.set(x, groundAt(x, z), z);
    player.yaw = yaw; player.pitch = 0;
    vel.set(0, 0, 0); air = 0; vy = 0;
    eyeY = player.pos.y + EYE;
    moving = null;
    placeCamera(0, 0, 0);
  }

  function groundAt(x, z) {
    const h = heightAt(x, z);
    if (game.state?.bridge && x > DECK_X0 && x < DECK_X1 && z > DECK_Z0 && z < DECK_Z1) return h > DECK_Y ? h : DECK_Y;
    return h;
  }
  const waterLevel = () => world.waterLevel?.() ?? 0;

  function hitsBuilding(s, x, z) {
    const i0 = Math.floor((x - PR - ORIGIN) / TILE), i1 = Math.floor((x + PR - ORIGIN) / TILE);
    const j0 = Math.floor((z - PR - ORIGIN_Z) / TILE), j1 = Math.floor((z + PR - ORIGIN_Z) / TILE);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (!inGrid(i, j)) continue;
      const id = s.tiles[j * GRID + i].b;
      const b = id && s.buildings[id];
      if (!b) continue;
      const B = BUILDINGS[b.type];
      if (B.walk || B.overlay || b.type === 'bridge') continue;
      const odd = b.rot % 2 === 1;
      const w = odd ? B.size[1] : B.size[0], h = odd ? B.size[0] : B.size[1];
      const cx = tileX(b.i) + (w - 1) * TILE / 2, cz = tileZ(b.j) + (h - 1) * TILE / 2;
      let hx = w * TILE / 2 - 0.05, hz = h * TILE / 2 - 0.05;
      const L = lib[b.type === 'farmhouse' ? 'farmhouse_' + s.fh : B.model];
      if (L?.size) {   // tighten to the model so small props don't block a whole 2 m tile
        const mx = (odd ? L.size.z : L.size.x) / 2 + 0.05, mz = (odd ? L.size.x : L.size.z) / 2 + 0.05;
        if (mx < hx) hx = mx;
        if (mz < hz) hz = mz;
      }
      if (Math.abs(x - cx) < hx + PR && Math.abs(z - cz) < hz + PR) return true;
    }
    return false;
  }

  function free(s, x, z, fx, fz) {
    if (x * x + z * z > 150 * 150) return false;
    if (hitsBuilding(s, x, z) && !hitsBuilding(s, fx, fz)) return false;
    return true;
  }

  const pushed = { x: 0, z: 0 };
  function pushOutObstacles(s, x, z) {
    const ci = Math.floor((x - ORIGIN) / TILE), cj = Math.floor((z - ORIGIN_Z) / TILE), R = OBST_R + PR;
    for (let j = cj - 1; j <= cj + 1; j++) for (let i = ci - 1; i <= ci + 1; i++) {
      if (!inGrid(i, j) || !s.tiles[j * GRID + i].o) continue;
      const ox = tileX(i), oz = tileZ(j), dx = x - ox, dz = z - oz, d2 = dx * dx + dz * dz;
      if (d2 >= R * R) continue;
      const d = Math.sqrt(d2) || 0.001;
      x = ox + (dx / d) * R; z = oz + (dz / d) * R;
    }
    pushed.x = x; pushed.z = z;
  }

  function surfaceAt(s, x, z) {
    if (s.bridge && x > DECK_X0 && x < DECK_X1 && z > DECK_Z0 && z < DECK_Z1 && heightAt(x, z) < DECK_Y) return 'wood';
    const h = heightAt(x, z);
    if (h < waterLevel() + 0.12) return 'water';
    const i = Math.floor((x - ORIGIN) / TILE), j = Math.floor((z - ORIGIN_Z) / TILE);
    if (inGrid(i, j)) {
      const t = s.tiles[j * GRID + i];
      const b = t.b && s.buildings[t.b];
      if (b?.type === 'path') return 'stone';
      if (t.t === 's') return 'soil';
      return 'grass';
    }
    return h < 2.2 ? 'sand' : 'grass';
  }

  // ---------------------------------------------------------------- movement
  function move(s, dt, active) {
    let f = 0, r = 0;
    if (active) {
      f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
      r = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
      f = clamp(f + pad.f, -1, 1); r = clamp(r + pad.r, -1, 1);
    }
    const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
    let wx = sy * f - cy * r, wz = cy * f + sy * r;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) { wx /= wl; wz /= wl; }
    const sprint = active && f > 0 && (keys.has('ShiftLeft') || keys.has('ShiftRight') || pad.sprint);
    const p = player.pos;
    const wading = heightAt(p.x, p.z) < waterLevel() - 0.05 && groundAt(p.x, p.z) < waterLevel();
    const speed = (sprint ? SPRINT : WALK) * (wading ? 0.6 : 1);
    const a = 1 - Math.exp(-(wl > 0 ? 10 : 12) * dt);   // acceleration / friction
    vel.x += (wx * speed - vel.x) * a;
    vel.z += (wz * speed - vel.z) * a;

    const ox = p.x, oz = p.z;
    let nx = ox + vel.x * dt, nz = oz;
    if (!free(s, nx, nz, ox, oz)) { nx = ox; vel.x = 0; }
    nz = oz + vel.z * dt;
    if (!free(s, nx, nz, nx, oz)) { nz = oz; vel.z = 0; }
    pushOutObstacles(s, nx, nz);
    if (free(s, pushed.x, pushed.z, ox, oz)) { nx = pushed.x; nz = pushed.z; }
    p.x = nx; p.z = nz;
    if (wantJump && air === 0 && !wading) { vy = JUMP_V; game.emit('step', { surface: surfaceAt(s, nx, nz), sprint }); }
    wantJump = false;
    const landed = air > 0 || vy > 0;
    vy -= GRAVITY * dt;
    air = Math.max(0, air + vy * dt);
    if (air === 0) { if (landed) game.emit('step', { surface: surfaceAt(s, nx, nz), sprint: true }); vy = 0; }
    p.y = Math.max(groundAt(nx, nz) + air, waterLevel() - EYE + 0.4);   // deep water: swim with your head above it

    // ground following: smooth step-ups, quicker drops
    const target = p.y + EYE;
    if (air > 0) eyeY = target;
    else eyeY += (target - eyeY) * (1 - Math.exp(-(target > eyeY ? 14 : 20) * dt));
    if (Math.abs(target - eyeY) > 3) eyeY = target;

    // footsteps + bob
    const dist = Math.hypot(nx - ox, nz - oz);
    const spd = dist / Math.max(dt, 1e-4);
    moveAmt += ((spd > 0.5 ? Math.min(spd / WALK, 1.3) : 0) - moveAmt) * (1 - Math.exp(-8 * dt));
    sprintAmt += ((sprint && spd > WALK ? 1 : 0) - sprintAmt) * (1 - Math.exp(-6 * dt));
    stepPhase += dist / (sprint ? 2.0 : 1.5);
    if (Math.floor(stepPhase) !== lastStep) {
      lastStep = Math.floor(stepPhase);
      if (spd > 0.8) game.emit('step', { surface: surfaceAt(s, nx, nz), sprint });
    }
    roll += ((-r * 0.012 * moveAmt) - roll) * (1 - Math.exp(-6 * dt));
  }

  function placeCamera(bobX, bobY, bobPitch) {
    const p = player.pos;
    cam.position.set(p.x - Math.cos(player.yaw) * bobX, eyeY + bobY, p.z + Math.sin(player.yaw) * bobX);
    cam.rotation.set(player.pitch + bobPitch, player.yaw + Math.PI, roll);
  }

  // ---------------------------------------------------------------- targeting
  const ray = new THREE.Raycaster();
  const CENTER = new THREE.Vector2(0, 0);
  const T = { kind: null, i: -1, j: -1, id: null, px: 0, py: 0 };   // what we look at (scratch)
  let gi = -1, gj = -1;          // ground tile under the crosshair (for placement)
  let act = null, actOk = false, actShape = 'one', dir = 0;
  let lastCursorKey = -2, lastHiKey = '', lastGhost = '', descT = 0, descKey = '';

  const H = { st: null, it: null, kind: null, tool: null };
  function heldInfo(s, p) {
    const st = p?.inv[p.sel] || null, it = st ? ITEMS[st.id] || null : null;
    H.st = st; H.it = it; H.kind = it?.kind || null; H.tool = it?.kind === 'tool' ? st.id : null;
    return H;
  }

  function findTarget(s) {
    ray.setFromCamera(CENTER, cam);
    const o = ray.ray.origin, d = ray.ray.direction, now = game.now(), wl = waterLevel();
    let hitT = -1, ci = -1, cj = -1, cropHit = false;
    for (let t = 0.1; t <= REACH + 1e-6; t += 0.1) {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      const i = Math.floor((x - ORIGIN) / TILE), j = Math.floor((z - ORIGIN_Z) / TILE);
      if (inGrid(i, j)) {   // tall crops/trees catch the ray before the ground does
        const c = s.tiles[j * GRID + i].c;
        if (c) {
          const C = CROPS[c.id], st = ripe(c, now) ? 3 : c.adult ? 2 : Math.floor(progressish(c, now) * 3);
          const top = C.tree ? (st >= 2 ? 3.2 : 1.4) : 0.35 + 0.25 * st;
          const dx = x - tileX(i), dz = z - tileZ(j);
          if (y < heightAt(x, z) + top && dx * dx + dz * dz < (C.tree && st >= 2 ? 1.2 : 0.55)) { hitT = t; ci = i; cj = j; cropHit = true; break; }
        }
      }
      let g = groundAt(x, z);
      if (g < wl) g = wl;
      if (y <= g) { hitT = t; ci = i; cj = j; break; }
    }
    gi = hitT > 0 && inGrid(ci, cj) ? ci : -1; gj = gi >= 0 ? cj : -1;

    ray.far = hitT > 0 ? hitT + 0.3 : REACH;
    const pk = view()?.pick?.(ray);
    ray.far = Infinity;
    T.kind = null; T.i = -1; T.j = -1; T.id = null;
    // overlays (greenhouse, crop cover) only grab the ray in build mode — otherwise you work the tiles under them
    const overlay = pk?.kind === 'building' && BUILDINGS[s.buildings[pk.id]?.type]?.overlay && !player.buildMode && gi >= 0;
    if (pk && !overlay && !(cropHit && pk.kind === 'water')) {
      T.kind = pk.kind; T.id = pk.id ?? null;
      if (pk.kind === 'obstacle') { T.i = pk.i; T.j = pk.j; }
      else if (pk.kind === 'building') { const b = s.buildings[pk.id]; if (b) { T.i = b.i; T.j = b.j; } else T.kind = null; }
      else if (pk.kind === 'sign') { T.px = pk.px; T.py = pk.py; T.id = pk.px + ',' + pk.py; }
      return;
    }
    if (gi < 0) return;
    const t = s.tiles[gj * GRID + gi];
    T.i = gi; T.j = gj;
    if (t.b && s.buildings[t.b] && !cropHit && (player.buildMode || !BUILDINGS[s.buildings[t.b].type].walk)) { T.kind = 'building'; T.id = t.b; const b = s.buildings[t.b]; T.i = b.i; T.j = b.j; }
    else if (t.o) T.kind = 'obstacle';
    else T.kind = 'tile';
  }
  // stage-ish progress without importing more (progress() is fine, but keep the loop cheap)
  function progressish(c, now) { return Math.min(1, (c.g + ((now - c.t) / 1000) * c.sp) / CROPS[c.id].grow); }

  function anyCell(s, shape, test) {
    for (const [i, j] of area(T.i, T.j, shape, dir)) { const t = tile(s, i, j); if (t && test(t, i, j)) return true; }
    return false;
  }

  function decide(s, p, now) {
    const { it, kind, tool } = heldInfo(s, p);
    act = null; actOk = false; actShape = 'one';
    dir = Math.abs(Math.sin(player.yaw)) > Math.abs(Math.cos(player.yaw)) ? 0 : 1;   // 0 = facing ±x
    const K = T.kind, b = K === 'building' ? s.buildings[T.id] : null;
    const t = (K === 'tile' || K === 'obstacle') ? tile(s, T.i, T.j) : null;

    if (player.buildMode || moving) {
      if (moving) { act = 'move'; actOk = gi >= 0 && okMove(s, moving, ...anchor(moving.type, moving.rot)); return; }
      if (b) { act = BUILDINGS[b.type].fixed ? null : 'grab'; actOk = !!act; if (act) return; }
    }
    if (K === 'crow') { act = 'scare'; actOk = true; return; }
    if (kind === 'place') {
      if (gi < 0) return;
      const type = it.building, [ai, aj] = anchor(type, placeRot);
      act = 'place'; actOk = !canPlace(s, type, ai, aj, placeRot);
      return;
    }
    if (tool === 'bucket') {
      const fresh = K === 'water' || (b && BUILDINGS[b.type].water) || (t && (t.t === 'w' || t.t === 'r'));
      if (fresh) { act = 'refill'; actOk = p.water < BUCKET_CAP[s.tools.bucket]; return; }
      if (b) { if (b.fire) { act = 'water'; actOk = p.water > 0; } return; }
      if (t) { act = 'water'; actShape = bucketShape(s); actOk = p.water > 0 && anyCell(s, actShape, x => x.fire || (x.t === 's' && (!x.wet || (x.c && !x.c.w)))); }
      return;
    }
    if (!t) return;
    if (K === 'obstacle') {
      if (t.o && (tool === 'axe' || tool === 'pickaxe')) {
        const k = t.o.k, need = k === 'rock' ? 'pickaxe' : k === 'stump' ? tool : 'axe';
        act = tool === 'axe' ? 'chop' : 'mine'; actOk = tool === need;
      }
      return;
    }
    if (tool === 'axe' && t.c && CROPS[t.c.id].tree) { act = 'chop'; actOk = true; return; }   // cut down a fruit tree
    if (tool === 'hoe') { act = 'till'; actShape = hoeShape(s); actOk = s.coins >= TILL_COST && anyCell(s, actShape, (x, i, j) => x.t === 'g' && !x.o && !x.b && owned(s, i, j)); }
    else if (kind === 'seed') {
      act = 'plant'; actShape = CROPS[it.crop].tree ? 'one' : pouchShape(s);
      actOk = anyCell(s, actShape, x => x.t === 's' && !x.c && !x.b);
    } else if (kind === 'boost') {
      act = 'fertilize';
      const c = t.c;
      actOk = !!c && !ripe(c, now) && (it.gold ? CROPS[c.id].tier === 5 && !(c.gf > 1) : c.fz < it.boost);
    } else if (tool === 'sickle' || !it || ['crop', 'gold', 'good', 'res'].includes(kind)) {
      act = 'harvest'; actShape = sickleShape(s, tool === 'sickle'); actOk = anyCell(s, actShape, x => ripe(x.c, now));
    }
  }

  // footprint anchor so the ghost is centred on the looked-at tile
  function anchor(type, rot) {
    const [w, h] = BUILDINGS[type].size, odd = rot % 2 === 1;
    return [gi - Math.floor(((odd ? h : w) - 1) / 2), gj - Math.floor(((odd ? w : h) - 1) / 2)];
  }
  // canPlace for a building that is being moved: its own tiles count as empty and it doesn't add to the cap
  function okMove(s, m, i, j) {
    const B = BUILDINGS[m.type], odd = m.rot % 2 === 1;
    const w = odd ? B.size[1] : B.size[0], h = odd ? B.size[0] : B.size[1];
    for (let dj = 0; dj < h; dj++) for (let di = 0; di < w; di++) {
      const t = tile(s, i + di, j + dj);
      if (!t || !owned(s, i + di, j + dj) || (t.t !== 'g' && t.t !== 's') || t.o) return false;
      const b = t.b === m.bid ? null : t.b, ov = t.ov === m.bid ? null : t.ov;
      if (B.overlay ? (ov || b) : (b || t.c)) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- target description (for the tooltip)
  const out = { label: '', detail: '', action: null };
  function describe(s, p, now) {
    const { it, tool } = heldInfo(s, p);
    out.label = ''; out.detail = ''; out.action = act ? ACT_TEXT[act] : null;
    const K = T.kind;
    if (act === 'move') {
      const [ai, aj] = anchor(moving.type, moving.rot);
      out.label = BUILDINGS[moving.type].name;
      out.detail = gi < 0 ? 'Look at your land to put it down' : actOk ? 'Click to put it down · R rotate · X store' : canPlaceMsg(s, moving.type, ai, aj, moving.rot);
      return;
    }
    if (act === 'place' && K !== 'crow') {
      const [ai, aj] = anchor(it.building, placeRot);
      const why = canPlace(s, it.building, ai, aj, placeRot);
      out.label = it.name;
      out.detail = why || 'Click to place · R to rotate';
      return;
    }
    if (K === 'building') {
      const b = s.buildings[T.id], B = BUILDINGS[b.type];
      out.label = b.type === 'farmhouse' ? `Farmhouse · level ${s.fh}` : B.name;
      if (player.buildMode) { out.detail = B.fixed ? 'Fixed in place' : 'Click to pick up · X to store it'; return; }
      if (b.fire) { out.detail = 'On fire — splash it with the bucket'; return; }
      if (b.off > now) { out.detail = `Burnt — working again in ${fmtTime((b.off - now) / 1000)}`; return; }
      switch (b.type) {
        case 'farmhouse': out.detail = `${buildCount(s)} / ${buildCap(s)} buildings`; break;
        case 'market_stall': out.detail = 'Press E to sell'; break;
        case 'shop_stall': out.detail = 'Press E to shop'; break;
        case 'silo': case 'barn': out.detail = `${storeCount(s, b.type)} / ${storeCap(s, b.type)} stored · press E`; break;
        case 'harvester_bot': {
          const n = Object.values(b.d.hop || {}).reduce((x, y) => x + y, 0);
          out.detail = `${n} in the hopper · press E`; break;
        }
        case 'auto_market': out.detail = `Selling at ×${(b.d.mult || 1).toFixed(1)} · press E`; break;
        case 'well': case 'rain_barrel':
          out.detail = tool === 'bucket' ? 'Fresh water — click with the bucket to refill' : 'Fresh water — hold the bucket to refill'; break;
        default:
          if (B.factory) {
            const job = b.d.job;
            if (!job) out.detail = 'Idle · press E to start';
            else {
              const rc = RECIPES[b.type]?.[job.r];
              const done = rc ? Math.min(job.n, Math.floor((now - job.start) / (rc.time * 1000))) : 0;
              out.detail = rc ? `${ITEMS[rc.out].name} · ${done} / ${job.n} ready · press E` : 'Working';
            }
          } else out.detail = BDESC[b.type] || '';
      }
      return;
    }
    if (K === 'crow') { out.label = 'Crow'; out.detail = 'Click to shoo it away'; return; }
    if (K === 'donkey') { const c = state()?.donkey?.cmd; out.label = 'Biscuit'; out.detail = `${!c ? 'Following you' : c.m === 'stay' ? 'Waiting here' : 'Going where you sent him'} · E for his menu · F to pet`; return; }
    if (K === 'trader') { out.label = 'Trader'; out.detail = 'Press E to see trade orders'; return; }
    if (K === 'board') { out.label = 'Quest board'; out.detail = 'Press E to see trade orders'; return; }
    if (K === 'sign') {
      const st = plotState(s, T.px, T.py);
      out.label = 'Land for sale';
      out.detail = st.ok ? (st.free ? 'Free — press E to claim it' : `${fmtNum(st.price)} coins — press E to buy`) : st.why + (st.price ? ` (${fmtNum(st.price)} coins)` : '');
      return;
    }
    if (K === 'water') { out.label = 'Fresh water'; out.detail = tool === 'bucket' ? 'Click with the bucket to refill' : 'Hold the bucket to refill'; return; }
    if (K === 'obstacle') {
      const t = tile(s, T.i, T.j), o = t?.o;
      if (!o) return;
      const k = o.k;
      out.label = k === 'stump' ? (o.from === 'palm' ? 'Palm stump' : 'Tree stump') : OBST_NAME[k] || 'Obstacle';
      const need = k === 'rock' ? 'pickaxe' : k === 'stump' ? (tool === 'pickaxe' ? 'pickaxe' : 'axe') : 'axe';
      const left = Math.max(1, (k === 'bush' ? 1 : HITS[s.tools[need]]) - o.hp);
      const hint = k === 'rock' ? 'use the pickaxe' : k === 'stump' ? 'use the axe or pickaxe — or it grows back' : 'use the axe';
      out.detail = `${hint[0].toUpperCase() + hint.slice(1)}${left > 1 ? ` · ${left} hits` : ''}`;
      return;
    }
    if (K !== 'tile') return;
    const t = tile(s, T.i, T.j);
    if (t.fire) { out.label = 'Fire!'; out.detail = 'Click with the bucket to put it out'; return; }
    if (t.c) {
      const C = CROPS[t.c.id];
      out.label = C.name;
      if (ripe(t.c, now)) out.detail = tool === 'sickle' || !it ? 'Ripe — click to harvest' : 'Ripe — harvest with the sickle';
      else if (!t.c.sp) out.detail = 'Needs water to grow';
      else out.detail = `${fmtTime(remaining(t.c, now))} left${C.tree && t.c.adult ? ' until fruit' : ''}${t.c.fz > 1 ? ' · fertilized' : ''}`;
      if (C.tree && tool === 'axe') out.detail = 'Click to cut it down (frees the tile, gives wood)';
      return;
    }
    if (t.t === 'w' || t.t === 'r') { out.label = t.t === 'r' ? 'River' : 'Pond'; out.detail = 'Fresh water — click with the bucket to refill'; return; }
    if (t.t === 's') { out.label = t.f ? 'Fertile soil' : 'Tilled soil'; out.detail = (t.wet ? 'Watered · ' : '') + 'Plant seeds here'; return; }
    if (!owned(s, T.i, T.j)) {
      const px = Math.floor(T.i / PLOT), py = Math.floor(T.j / PLOT), st = plotState(s, px, py);
      out.label = 'Wild land';
      out.detail = st.ok ? (st.free ? 'Free plot — claim it at the sign' : `Plot for sale: ${fmtNum(st.price)} coins`) : st.why;
      return;
    }
    out.label = 'Grass';
    out.detail = `Till it with the hoe for ${TILL_COST} coins to make a field tile`;
  }
  function canPlaceMsg(s, type, i, j, rot) { return canPlace(s, type, i, j, rot) || 'Something is in the way'; }

  function publishTarget(s, p, now) {
    const K = T.kind;
    const key = K ? `${K}|${T.id}|${T.i}|${T.j}|${act}|${actOk}|${p?.sel}|${moving ? moving.rot : placeRot}` : '';
    descT -= 1;
    if (key === descKey && descT > 0) return;
    descKey = key; descT = 12;   // refresh text at most every ~12 frames for timers
    if (!K && act !== 'move') {
      if (player.target) { player.target = null; ui()?.setTarget?.(null); }
      return;
    }
    describe(s, p, now);
    const cur = player.target;
    if (cur && cur.kind === K && cur.i === T.i && cur.j === T.j && cur.id === T.id && cur.label === out.label && cur.detail === out.detail && cur.action === out.action) return;
    player.target = { kind: K, i: T.i, j: T.j, id: T.id, label: out.label, detail: out.detail, action: out.action };
    ui()?.setTarget?.(player.target);
  }

  function publishVisuals(s, p) {
    const v = view();
    if (!v) return;
    // outline on interactables
    const hk = player.enabled && T.kind && T.kind !== 'tile' ? `${T.kind}|${T.id}|${T.i}|${T.j}` : '';
    if (hk !== lastHiKey) { lastHiKey = hk; v.highlight?.(hk ? player.target || { kind: T.kind, id: T.id, i: T.i, j: T.j } : null); }
    // ghost for blueprints / moving buildings
    let g = '';
    let gType = null, ga = 0, gb = 0, gRot = 0;
    if (player.enabled && gi >= 0) {
      if (act === 'move') { gType = moving.type; gRot = moving.rot; }
      else if (act === 'place') { gType = heldInfo(s, p).it.building; gRot = placeRot; }
      if (gType) { [ga, gb] = anchor(gType, gRot); g = `${gType}|${ga}|${gb}|${gRot}|${actOk}`; }
    }
    if (g !== lastGhost) { lastGhost = g; v.ghost?.(gType, ga, gb, gRot, actOk); }
    // tile cursor for area tools
    const showCursor = player.enabled && act && T.i >= 0 && !['place', 'move', 'grab', 'scare', 'refill'].includes(act)
      && (T.kind === 'tile' || T.kind === 'obstacle') && !(act === 'harvest' && !actOk && heldInfo(s, p).tool !== 'sickle');
    const ck = showCursor ? T.i + T.j * 64 + SHAPE_IDX[actShape] * 4096 + dir * 16384 + (actOk ? 32768 : 0) + ACT_IDX[act] * 65536 : -1;
    if (ck !== lastCursorKey) {
      lastCursorKey = ck;
      v.tileCursor?.(showCursor ? area(T.i, T.j, actShape, dir).filter(([i, j]) => inGrid(i, j)) : [], actOk);
    }
  }

  function clearVisuals() {
    const v = view();
    if (lastHiKey) { lastHiKey = ''; v?.highlight?.(null); }
    if (lastGhost) { lastGhost = ''; v?.ghost?.(null); }
    if (lastCursorKey !== -1) { lastCursorKey = -1; v?.tileCursor?.([], false); }
    if (player.target) { player.target = null; ui()?.setTarget?.(null); }
    descKey = '';
  }

  // ---------------------------------------------------------------- using things
  function targetKey() { return T.kind ? (T.i + 1) * 4096 + (T.j + 1) + (T.kind === 'building' ? 1e7 : 0) : -1; }

  function useHeld(isFresh) {
    const s = state(), p = me();
    if (!s || !p || !act) return false;
    if (!isFresh && !actOk) return false;
    const { it, tool } = heldInfo(s, p);
    let a = null;
    switch (act) {
      case 'till': a = { type: 'till', i: T.i, j: T.j, dir }; break;
      case 'plant': a = { type: 'plant', i: T.i, j: T.j, slot: p.sel, dir }; break;
      case 'water': a = T.kind === 'building' ? { type: 'water', bid: T.id, i: T.i, j: T.j } : { type: 'water', i: T.i, j: T.j, dir }; break;
      case 'refill': a = { type: 'refill' }; break;
      case 'harvest': a = { type: 'harvest', i: T.i, j: T.j, dir }; break;
      case 'chop': case 'mine': a = { type: 'hit', i: T.i, j: T.j, tool }; break;
      case 'fertilize': a = { type: 'fertilize', i: T.i, j: T.j, slot: p.sel }; break;
      case 'scare': a = { type: 'scare', crow: T.id }; break;
      case 'place': {
        const [ai, aj] = anchor(it.building, placeRot);
        a = { type: 'place', i: ai, j: aj, rot: placeRot, slot: p.sel }; break;
      }
      case 'grab': {
        const b = s.buildings[T.id];
        moving = { bid: b.id, type: b.type, rot: b.rot };
        ui()?.toast?.(`Moving the ${BUILDINGS[b.type].name.toLowerCase()} — click to put it down, R to rotate, X to store`, 'info');
        break;
      }
      case 'move': {
        if (!actOk) { ui()?.toast?.(gi < 0 ? 'Look at your land to put it down' : canPlaceMsg(s, moving.type, ...anchor(moving.type, moving.rot), moving.rot), 'warn'); return true; }
        const [ai, aj] = anchor(moving.type, moving.rot);
        a = { type: 'move', bid: moving.bid, i: ai, j: aj, rot: moving.rot };
        moving = null; break;
      }
    }
    if (a) game.do(a);
    const toolName = tool || (it?.kind === 'seed' ? 'seeds' : it?.kind === 'boost' ? 'fertilizer' : it?.kind === 'place' ? 'blueprint' : 'hand');
    game.emit('use', { tool: toolName, ok: actOk, action: act });
    playAnim(act === 'harvest' && tool !== 'sickle' ? 'poke' : ANIM_OF[act], !isFresh);
    return true;
  }

  function useCooldown(s) {
    const { tool } = heldInfo(s, me());
    if (tool === 'hoe' && s.tools.hoe === 0) return 0.8;
    if (tool === 'axe' || tool === 'pickaxe') return 0.42;
    return 0.35;
  }

  function handleUse(s, dt) {
    cooldown -= dt;
    if (!mouseHeld && !fresh) return;
    if (cooldown > 0) return;
    const key = targetKey();
    const sameOk = act === 'chop' || act === 'mine';   // keep chopping the same tree while held
    if (fresh || (mouseHeld && act && act !== 'grab' && act !== 'move' && act !== 'scare' && (key !== lastUseKey || sameOk))) {
      const wasFresh = fresh;
      fresh = false;
      if (useHeld(wasFresh)) { cooldown = useCooldown(s); lastUseKey = key; }
    }
  }

  function interact() {
    const s = state();
    if (!s) return;
    const U = ui();
    if (!U) return;
    const K = T.kind;
    if (K === 'building') {
      const b = s.buildings[T.id], B = b && BUILDINGS[b.type];
      if (!B) return U.open('inventory');
      if (b.type === 'market_stall') return U.open('sell');
      if (b.type === 'shop_stall') return U.open('shop');
      if (b.type === 'silo' || b.type === 'barn') return U.open('storage', { store: b.type });
      if (B.factory) return U.open('factory', { bid: b.id });
      if (b.type === 'harvester_bot') return U.open('bot', { bid: b.id });
      if (b.type === 'auto_market') return U.open('market', { bid: b.id });
      return U.open('inventory');
    }
    if (K === 'donkey') return U.open('donkey');
    if (K === 'trader' || K === 'board') return U.open('quests');
    if (K === 'sign') return U.open('plot', { px: T.px, py: T.py });
    U.open('inventory');
  }

  function toggleBuild() {
    player.buildMode = !player.buildMode;
    moving = null;
    ui()?.toast?.(player.buildMode ? 'Build mode — click a building to move it, X stores it, B to finish' : 'Build mode off', 'info');
  }
  function storeBuilding() {
    const s = state();
    const bid = moving ? moving.bid : T.kind === 'building' ? T.id : null;
    if (!bid || !s.buildings[bid]) return;
    if (BUILDINGS[s.buildings[bid].type].fixed) { ui()?.toast?.('This can’t be moved', 'warn'); return; }
    game.do({ type: 'pickup', bid });
    moving = null;
    playAnim('grab');
  }

  // ---------------------------------------------------------------- viewmodel
  const vmScene = world.vmScene, vmCam = world.vmCamera;
  if (vmScene && !vmScene.children.some(o => o.isLight)) {   // fallback so the toon materials aren't black
    vmScene.add(new THREE.HemisphereLight(0xfff1dc, 0x5a4a3a, 1.6));
    const dl = new THREE.DirectionalLight(0xfff3e0, 2.2); dl.position.set(0.6, 1, 0.4); vmScene.add(dl);
  }
  const vmRoot = new THREE.Group(), rig = new THREE.Group(), swing = new THREE.Group(), hand = new THREE.Group(), holder = new THREE.Group(), tip = new THREE.Object3D();
  vmRoot.add(rig); rig.add(swing); swing.add(hand); hand.add(holder); hand.add(tip);
  hand.position.set(0, 0, -0.52);
  vmScene?.add(vmRoot);
  const RIG_POS = new THREE.Vector3(0.36, -0.4, 0), RIG_ROT = new THREE.Euler(0.45, 0.15, 0);
  let armMesh = null, armKey = '', itemMesh = null, itemKey = null;
  const itemCache = new Map();

  // world materials darken everything near y=0 (fake ground AO); held models sit at y≈0, so use plain clones
  const vmMats = new Map();
  const vmMat = m => { if (!vmMats.has(m)) vmMats.set(m, m.clone()); return vmMats.get(m); };
  function prepVm(g) {
    g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; o.material = vmMat(o.material); } });
    return g;
  }
  function buildArm(shirt) {
    let g;
    try { g = prepVm(makeMesh('fp_arm', { tint: { shirt } })); } catch { return null; }
    g.rotation.y = Math.PI;   // hand points forward (-Z)
    return g;
  }

  function metalFor(s, tool) {
    const n = TOOL_LV[tool]?.[s.tools[tool]] || '';
    return /Broken|Leaky/.test(n) ? METAL.broken : /Golden/.test(n) ? METAL.golden : /Iron|Bigger/.test(n) ? METAL.iron : METAL.normal;
  }

  function itemSpec(s, st) {
    if (!st) return null;
    const it = ITEMS[st.id];
    if (!it) return null;
    if (it.kind === 'tool') { const metal = metalFor(s, st.id); return { key: it.model + metal, name: it.model, opts: { tint: { metal } } }; }
    if (it.kind === 'seed') {
      if (it.model === 'sapling') return { key: 'sapling', name: 'sapling', opts: {} };
      const tint = CROP_TINT[it.crop] || '#c9a36b';
      return { key: 'seed_packet' + tint, name: 'seed_packet', opts: { tint: { tint } } };
    }
    if (it.kind === 'place') return { key: 'tool_blueprint', name: 'tool_blueprint', opts: {} };
    if (it.kind === 'boost') return { key: 'tool_fertilizer' + st.id, name: 'tool_fertilizer', opts: st.id === 'goldfert' ? { tint: { tint: '#f2c94c' } } : {} };
    return { key: it.model + (it.kind === 'gold' ? 'g' : ''), name: it.model, opts: it.kind === 'gold' ? { tint: { tint: '#f2c94c' } } : {}, generic: true };
  }

  function makeItem(spec) {
    let g;
    try { g = prepVm(makeMesh(spec.name, spec.opts)); } catch { return null; }
    let pose = POSE[spec.name];
    if (!pose) {   // produce / goods / resources: fit ~22 cm in the palm
      const box = new THREE.Box3().setFromObject(g), size = box.getSize(new THREE.Vector3());
      const m = Math.max(size.x, size.y, size.z) || 0.3;
      pose = { c: [(box.min.x + box.max.x) / 2, box.min.y + size.y * 0.3, (box.min.z + box.max.z) / 2], r: [0.15, 0.6, 0], s: 0.22 / m };
    }
    g.position.set(-pose.c[0], -pose.c[1], -pose.c[2]);
    const wrap = new THREE.Group();
    wrap.add(g);
    wrap.rotation.set(pose.r[0], pose.r[1], pose.r[2]);
    wrap.scale.setScalar(pose.s);
    return wrap;
  }

  // per-kind particle emitter offset in hand space
  const TIP = { tool_bucket: [0, -0.12, -0.12], seed_packet: [0, 0.14, -0.04], tool_fertilizer: [0, 0.22, -0.04], sapling: [0, 0.1, -0.05] };
  function refreshViewmodel(s, p) {
    const shirt = p?.outfit || '#3a86c8';
    if (shirt !== armKey) {
      armKey = shirt;
      if (armMesh) swing.remove(armMesh);
      armMesh = buildArm(shirt);
      if (armMesh) swing.add(armMesh);
    }
    const st = p?.inv[p.sel];
    const spec = itemSpec(s, st);
    const key = spec ? spec.key : '';
    if (armMesh) armMesh.visible = ITEMS[st?.id]?.kind !== 'tool';   // tools float on their own, no hand
    player.held = st?.id || null;
    if (key === itemKey) return;
    itemKey = key;
    if (itemMesh) holder.remove(itemMesh);
    itemMesh = null;
    if (spec) {
      if (!itemCache.has(key)) itemCache.set(key, makeItem(spec));
      itemMesh = itemCache.get(key);
      if (itemMesh) holder.add(itemMesh);
      const tp = TIP[spec.name] || [0, 0.05, -0.08];
      tip.position.set(tp[0], tp[1], tp[2]);
    } else tip.position.set(0, 0.05, -0.08);
    equipT = 0;
  }

  // particles (splash, seeds, sparkles) in viewmodel space
  const PN = 72;
  const pPos = new Float32Array(PN * 3).fill(-50), pCol = new Float32Array(PN * 3), pVel = new Float32Array(PN * 3), pLife = new Float32Array(PN);
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3).setUsage(THREE.DynamicDrawUsage));
  const points = new THREE.Points(pGeo, new THREE.PointsMaterial({ size: 0.014, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false }));
  points.frustumCulled = false;
  vmRoot.add(points);
  let pNext = 0, pAlive = false;
  const tmpV = new THREE.Vector3(), tmpC = new THREE.Color();
  const COL = { water: new THREE.Color('#8fdcff'), seed: new THREE.Color('#c9a36b'), fert: new THREE.Color('#c8f27a'), dirt: new THREE.Color('#7a5236') };
  function burst(n, col, spread, up, fwd) {
    vmRoot.updateMatrixWorld(true);
    tip.getWorldPosition(tmpV);
    vmRoot.worldToLocal(tmpV);
    for (let k = 0; k < n; k++) {
      const q = pNext; pNext = (pNext + 1) % PN;
      pPos[q * 3] = tmpV.x + (Math.random() - 0.5) * 0.03; pPos[q * 3 + 1] = tmpV.y; pPos[q * 3 + 2] = tmpV.z + (Math.random() - 0.5) * 0.03;
      pVel[q * 3] = (Math.random() - 0.5) * spread; pVel[q * 3 + 1] = up * (0.4 + Math.random() * 0.8); pVel[q * 3 + 2] = -fwd * (0.5 + Math.random()) + (Math.random() - 0.5) * spread;
      tmpC.copy(col).multiplyScalar(0.8 + Math.random() * 0.4);
      pCol[q * 3] = tmpC.r; pCol[q * 3 + 1] = tmpC.g; pCol[q * 3 + 2] = tmpC.b;
      pLife[q] = 0.5 + Math.random() * 0.35;
    }
    pAlive = true;
  }
  function updateParticles(dt) {
    if (!pAlive) return;
    let any = false;
    for (let q = 0; q < PN; q++) {
      if (pLife[q] <= 0) continue;
      pLife[q] -= dt;
      if (pLife[q] <= 0) { pPos[q * 3 + 1] = -50; continue; }
      any = true;
      pVel[q * 3 + 1] -= 2.6 * dt;
      pPos[q * 3] += pVel[q * 3] * dt; pPos[q * 3 + 1] += pVel[q * 3 + 1] * dt; pPos[q * 3 + 2] += pVel[q * 3 + 2] * dt;
    }
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.color.needsUpdate = true;
    pAlive = any;
  }

  // action animation state
  let anim = null, animT = 0, animLen = 1, equipT = 1, fired = false;
  let swayX = 0, swayY = 0;
  function playAnim(kind, repeating) {
    if (!kind) return;
    anim = kind; animT = 0; fired = false;
    animLen = repeating ? Math.min(ANIM_LEN[kind], 0.34) : ANIM_LEN[kind];
    player.anim = kind;
  }
  const A = { rx: 0, ry: 0, rz: 0, px: 0, py: 0, pz: 0 };
  function animPose(u) {
    A.rx = A.ry = A.rz = A.px = A.py = A.pz = 0;
    const bell = k01(u, 0, 0.3) * (1 - k01(u, 0.7, 1));
    switch (anim) {
      case 'hoe': {
        const up = k01(u, 0, 0.35) * (1 - k01(u, 0.35, 0.5)), down = k01(u, 0.35, 0.5) * (1 - k01(u, 0.62, 1));
        A.rx = 0.75 * up - 1.05 * down; A.py = 0.07 * up - 0.06 * down; A.pz = -0.1 * down;
        if (!fired && u > 0.48) { fired = true; burst(8, COL.dirt, 0.6, 0.6, 0.2); }
        break;
      }
      case 'chop': {
        const up = k01(u, 0, 0.3) * (1 - k01(u, 0.3, 0.42)), down = k01(u, 0.3, 0.42) * (1 - k01(u, 0.55, 1));
        A.rx = 0.9 * up - 0.95 * down; A.rz = 0.35 * up - 0.1 * down; A.ry = -0.15 * up + 0.2 * down; A.pz = -0.08 * down;
        break;
      }
      case 'water': {
        A.rz = -1.15 * bell; A.rx = -0.25 * bell; A.px = -0.05 * bell; A.py = 0.03 * bell;
        if (!fired && u > 0.3) { fired = true; burst(26, COL.water, 0.5, 0.2, 0.6); }
        break;
      }
      case 'refill': {
        A.py = -0.32 * bell; A.rx = 0.35 * bell; A.rz = 0.15 * bell;
        if (!fired && u > 0.5) { fired = true; burst(18, COL.water, 0.8, 1.2, 0.1); }
        break;
      }
      case 'plant': {
        A.rx = -0.35 * bell + Math.sin(u * 32) * 0.08 * bell; A.rz = 0.25 * bell;
        if (u > 0.25 && u < 0.75 && Math.random() < 0.5) burst(1, COL.seed, 0.25, -0.2, 0.3);
        break;
      }
      case 'harvest': {
        const a = k01(u, 0, 0.2), b = k01(u, 0.2, 0.45), c = 1 - k01(u, 0.55, 1);
        A.ry = (-0.5 * a + 1.3 * b) * c; A.rz = (-0.3 * a + 0.5 * b) * c; A.pz = -0.06 * b * c; A.rx = -0.2 * b * c;
        break;
      }
      case 'fert': {
        A.rx = -0.45 * bell; A.py = 0.035 * Math.sin(u * 40) * bell; A.rz = 0.2 * bell;
        if (u > 0.2 && u < 0.8 && Math.random() < 0.45) burst(1, COL.fert, 0.35, 0.3, 0.3);
        break;
      }
      case 'place': { const d = Math.sin(Math.PI * u); A.py = -0.08 * d; A.pz = -0.07 * d; A.rx = -0.3 * d; break; }
      case 'scare': { A.rz = Math.sin(u * Math.PI * 3) * 0.45 * (1 - u); A.py = 0.06 * Math.sin(Math.PI * u); break; }
      case 'grab': { const d = Math.sin(Math.PI * u); A.py = 0.05 * d; A.rx = 0.3 * d; break; }
      default: { const d = Math.sin(Math.PI * u); A.pz = -0.08 * d; A.rx = -0.15 * d; }   // poke
    }
  }

  function updateViewmodel(s, p, dt) {
    if (!vmScene) return;
    vmRoot.visible = player.enabled;
    if (!player.enabled) return;
    if (vmCam) { vmRoot.position.copy(vmCam.position); vmRoot.quaternion.copy(vmCam.quaternion); }
    refreshViewmodel(s, p);

    // look sway (lags behind the mouse), idle breathing, walk bob, sprint lower
    const k = 1 - Math.exp(-10 * dt);
    swayX += (clamp(-mouseDXFrame * 0.0009, -0.06, 0.06) - swayX) * k;
    swayY += (clamp(mouseDYFrame * 0.0009, -0.05, 0.05) - swayY) * k;
    const bobK = reducedMotion ? 0.3 : 1;
    const sp = Math.sin(Math.PI * stepPhase);
    rig.position.set(
      RIG_POS.x + sp * 0.014 * moveAmt * bobK + swayX * 0.5 + sprintAmt * 0.03,
      RIG_POS.y - Math.abs(sp) * 0.018 * moveAmt * bobK + Math.sin(time * 1.7) * 0.004 - sprintAmt * 0.06 + swayY * 0.4,
      RIG_POS.z + sprintAmt * 0.04,
    );
    rig.rotation.set(RIG_ROT.x - sprintAmt * 0.35 - swayY, RIG_ROT.y + swayX + sprintAmt * 0.2, RIG_ROT.z + sp * 0.02 * moveAmt * bobK + sprintAmt * 0.25);

    // action + equip
    if (anim) {
      animT += dt / animLen;
      if (animT >= 1) { anim = null; player.anim = null; }
    }
    if (anim) animPose(animT); else A.rx = A.ry = A.rz = A.px = A.py = A.pz = 0;
    if (equipT < 1) equipT = Math.min(1, equipT + dt / 0.28);
    const e = 1 - Math.pow(1 - equipT, 3);
    swing.rotation.set(A.rx - (1 - e) * 0.7, A.ry, A.rz);
    swing.position.set(A.px, A.py - (1 - e) * 0.35, A.pz);
    // empty hand: relaxed, palm down, back of the hand toward the camera
    holder.visible = !!itemMesh;
    if (armMesh) armMesh.rotation.z = itemMesh ? 0 : -1.75;
    updateParticles(dt);
  }

  // ---------------------------------------------------------------- frame
  // ---------------------------------------------------------------- gamepad (standard mapping)
  // L stick move, R stick look, A jump, X interact, RT use, LB/RB hotbar, Y build, B rotate, L3/LT sprint, Start pause
  const pad = { f: 0, r: 0, lx: 0, ly: 0, sprint: false, prev: [] };
  const dz = v => Math.abs(v) < 0.18 ? 0 : (v - Math.sign(v) * 0.18) / 0.82;
  function pollPad(open) {
    const gp = [...(navigator.getGamepads?.() || [])].find(g => g?.connected);
    pad.f = pad.r = pad.lx = pad.ly = 0; pad.sprint = false;
    if (!gp) return;
    const b = i => !!gp.buttons[i]?.pressed, ax = gp.axes;
    const down = i => b(i) && !pad.prev[i];
    if (down(9)) { if (open) ui()?.close?.(); else { unlock(); ui()?.open('pause'); } }
    if (!open && player.enabled) {
      pad.r = dz(ax[0] || 0); pad.f = -dz(ax[1] || 0);
      pad.lx = dz(ax[2] || 0); pad.ly = dz(ax[3] || 0);
      pad.sprint = b(10) || b(6);
      if (down(0)) wantJump = true;
      if (down(2)) interact();
      if (down(3)) toggleBuild();
      if (down(1)) { if (moving) moving.rot = (moving.rot + 1) % 4; else placeRot = (placeRot + 1) % 4; }
      const p = me();
      if (p && (down(4) || down(5))) game.do({ type: 'sel', slot: (p.sel + (down(5) ? 1 : -1) + 9) % 9 });
      if (down(7)) { if (picking) sendDonkey(); else { mouseHeld = true; fresh = true; } }
      else if (!b(7) && pad.prev[7]) mouseHeld = false;
    }
    pad.prev = gp.buttons.map(x => x.pressed);
  }

  let mouseDXFrame = 0, mouseDYFrame = 0, wasEnabled = false;
  function update(dt) {
    dt = Math.min(dt, 0.05);
    time += dt;
    const s = state(), p = me();
    mouseDXFrame = mouseDX; mouseDYFrame = mouseDY; mouseDX = mouseDY = 0;
    if (!player.enabled || !s) {
      if (wasEnabled) { clearVisuals(); releaseInput(); player.buildMode = false; moving = null; }
      wasEnabled = false;
      if (vmScene) vmRoot.visible = false;
      return;
    }
    wasEnabled = true;
    const open = uiOpen();
    pollPad(open);
    if (!open) {
      const sens = 0.0022 * (game.settings?.sens ?? 1), pk = 2.6 * (game.settings?.sens ?? 1) * dt;
      if (locked) { player.yaw -= mouseDXFrame * sens; player.pitch -= mouseDYFrame * sens; }
      player.yaw -= pad.lx * pk; player.pitch -= pad.ly * pk;
      player.pitch = clamp(player.pitch, -PITCH_MAX, PITCH_MAX);
    }
    move(s, dt, !open);

    // head bob + sprint fov
    const bobK = reducedMotion ? 0.3 : 1, sp = Math.sin(Math.PI * stepPhase);
    const amp = (0.035 + sprintAmt * 0.02) * moveAmt * bobK;
    placeCamera(sp * amp * 0.6, -Math.abs(sp) * amp, -Math.abs(sp) * amp * 0.15);
    const fov = BASE_FOV + sprintAmt * 5;
    if (Math.abs(cam.fov - fov) > 0.01 && Math.abs(cam.fov - BASE_FOV) < 6) { cam.fov = fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();

    if (moving && !s.buildings[moving.bid]) moving = null;
    if (!player.buildMode && moving) moving = null;
    if (!p) { clearVisuals(); updateViewmodel(s, p, dt); return; }
    const now = game.now();
    findTarget(s);
    decide(s, p, now);
    publishTarget(s, p, now);
    publishVisuals(s, p);
    if (!open) handleUse(s, dt); else { mouseHeld = false; fresh = false; }
    updateViewmodel(s, p, dt);
  }

  return player;
}
