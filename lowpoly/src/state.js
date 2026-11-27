// Harvest Haven rules engine. Pure JS (no three.js, no DOM) so host, guest and node tests share it.
// Every change to the world is an action applied by apply(). The host resolves actions (timestamps +
// random rolls), applies them, and broadcasts them; guests apply the same resolved actions.
import {
  TILE, GRID, PLOT, PLOTS, RIVER, BRIDGE_COL, START_PLOTS, TILL_COST, CROPS, ITEMS, BUILDINGS, RECIPES, SHOP, STORE_CAP,
  DONKEY_SLOTS, BACKPACK, BUCKET_CAP, HITS, TIER_LEVEL, GOLDEN_CHANCE, xpFor, xpForHarvest, GEMS_PER_LEVEL,
  DISASTERS, DISASTER_GAP, WARN_TIME, DISASTER_TIME, TIDE_HIGH, STORY_QUESTS, TRADER_EVERY, PLOT_BASE, OUTFITS,
  MAX_OFFLINE, CROP_LIST, SHIP_PARTS,
} from './data.js';
import { heightAt, tileX, tileZ } from './terrain.js';

// ---------------------------------------------------------------- change tracking for the renderer/UI
export const dirty = { tiles: new Set(), b: new Set(), all: true, ui: true };
export const fx = [];          // one-shot effects for the view/audio: {k, i, j, ...}
const mT = k => dirty.tiles.add(k);
const mB = id => { dirty.b.add(id); dirty.ui = true; };

export const idx = (i, j) => j * GRID + i;
export const inGrid = (i, j) => i >= 0 && j >= 0 && i < GRID && j < GRID;
export const tile = (s, i, j) => (inGrid(i, j) ? s.tiles[idx(i, j)] : null);
export const plotOf = (i, j) => [Math.floor(i / PLOT), Math.floor(j / PLOT)];
export const owned = (s, i, j) => { const [px, py] = plotOf(i, j); return !!s.plots[py * PLOTS + px]; };
export const invSize = s => BACKPACK[s.pack];
export const donkeySize = s => DONKEY_SLOTS[s.donkey.lv];
export const storeCap = (s, name) => STORE_CAP[s.store[name].lv];
export const storeCount = (s, name) => Object.values(s.store[name].items).reduce((a, b) => a + b, 0);
export const storeAccepts = (name, id) => (name === 'silo') === ['crop', 'gold'].includes(ITEMS[id]?.kind);
export const plotPrice = s => PLOT_BASE * Math.pow(2, s.plotsBought);
export const buildCap = s => [0, 15, 35, 60, 100, 160][s.fh];
export const buildCount = s => Object.values(s.buildings).filter(b => !BUILDINGS[b.type].fixed && !BUILDINGS[b.type].unique).length;
export const hasBuilding = (s, type) => Object.values(s.buildings).some(b => b.type === type);
const holdsItem = (s, id) => Object.values(s.players).some(p => p.inv.some(x => x?.id === id)) || s.donkey.inv.some(x => x?.id === id);

function mulberry(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- world creation
export function newWorld(seed = 1, now = Date.now()) {
  const s = {
    v: 2, seed, created: now, saved: now, rev: 0,
    coins: 0, gems: 0, xp: 0, lv: 1, credits: 0, fh: 1, bridge: 0, pack: 0, botLv: 0,
    tools: { hoe: 0, bucket: 0, sickle: 0, axe: 0, pickaxe: 0, pouch: 0 },
    store: { silo: { lv: 0, items: {} }, barn: { lv: 0, items: {} } },
    donkey: { lv: 0, inv: Array(45).fill(null) },
    plots: Array(PLOTS * PLOTS).fill(0), plotsBought: 0, freePlots: 0,
    tiles: [], buildings: {}, nextId: 1, players: {},
    quests: [{ ...STORY_QUESTS[0], id: 1, story: true }], story: 0, qn: 2,
    trader: { next: now + 90e3, at: 0 },
    weather: { kind: null, phase: 'calm', t0: 0, t1: 0, next: now + DISASTER_GAP[0] * 1000 },
    crows: [], stats: { harvests: 0, golden: 0, planted: 0, sold: 0, quests: 0 }, ach: [], outfits: ['#3a86c8'], crops: ['wheat'], tut: 0,
  };
  for (const [px, py] of START_PLOTS) s.plots[py * PLOTS + px] = 1;
  for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
    const h = heightAt(tileX(i), tileZ(j));
    s.tiles.push({ t: RIVER.includes(i) ? 'r' : h < 0.3 ? 'w' : 'g', c: null, o: null, b: null, ov: null, f: 0, rb: 0, wet: 0, fire: 0, last: null });
  }
  const fixed = [['shop_stall', 16, 37], ['market_stall', 22, 37]];   // on the beach in front of the starting plot
  for (const [type, i, j] of fixed) addBuilding(s, type, i, j, 2);   // rot 2: counters face the farm
  for (let j = 31; j <= 33; j++) for (let i = 18; i <= 20; i++) tile(s, i, j).t = 's';
  const R = mulberry(seed * 7919 + 13);
  for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
    const t = tile(s, i, j);
    const nearStart = i >= 6 && i <= 30 && j >= 26;   // keep the start fields and the beach row clear
    if (t.t !== 'g' || t.b || nearStart) { R(); R(); R(); continue; }
    const p = owned(s, i, j) ? 0.04 : 0.32, r = R(), k = R(), v = Math.floor(R() * 3);
    if (r < p) t.o = { k: k < 0.3 ? 'palm' : k < 0.58 ? 'jungle' : k < 0.85 ? 'rock' : 'bush', v, hp: 0 };
  }
  return s;
}

export function addPlayer(s, pid, name) {
  if (s.players[pid]) { s.players[pid].name = name || s.players[pid].name; return s.players[pid]; }
  const inv = Array(36).fill(null);
  inv[0] = { id: 'hoe', n: 1 };                       // you wash up with a hoe and five seeds — everything else is bought
  inv[1] = { id: 'seed_wheat', n: 5 };
  s.players[pid] = { name: name || 'Castaway', inv, sel: 0, outfit: '#3a86c8', water: BUCKET_CAP[s.tools.bucket], pos: null };
  dirty.ui = true;
  return s.players[pid];
}

function addBuilding(s, type, i, j, rot, d = {}) {
  const id = 'b' + s.nextId++;
  const b = { id, type, i, j, rot, d, fire: 0, off: 0 };
  s.buildings[id] = b;
  for (const [ti, tj] of footprint(b)) {
    const t = tile(s, ti, tj);
    if (BUILDINGS[type].overlay) t.ov = id; else t.b = id;
    mT(idx(ti, tj));
  }
  mB(id);
  return b;
}

export function footprint(b) {
  const [w, h] = sizeOf(b.type, b.rot);
  const out = [];
  for (let dj = 0; dj < h; dj++) for (let di = 0; di < w; di++) out.push([b.i + di, b.j + dj]);
  return out;
}
export const sizeOf = (type, rot) => { const [w, h] = BUILDINGS[type].size; return rot % 2 ? [h, w] : [w, h]; };
export const centerOf = b => { const [w, h] = sizeOf(b.type, b.rot); return [tileX(b.i) + (w - 1) * TILE / 2, tileZ(b.j) + (h - 1) * TILE / 2]; };

export function canPlace(s, type, i, j, rot) {
  const B = BUILDINGS[type];
  if (!B) return 'Unknown building';
  if (B.tilemod) {
    const t = tile(s, i, j);
    if (!t || t.t !== 's' || t.b) return 'Place it on a tilled field tile';
    if (B.tilemod === 'raised' && t.rb) return 'Already raised';
    if (B.tilemod === 'fert' && t.f) return 'Already fertile';
    return null;
  }
  if (B.unique && hasBuilding(s, type)) return `You already have a ${B.name.toLowerCase()}`;
  if (!B.fixed && !B.unique && buildCount(s) >= buildCap(s)) return `Farmhouse level ${s.fh} allows ${buildCap(s)} buildings — upgrade it to build more`;
  const [w, h] = sizeOf(type, rot);
  for (let dj = 0; dj < h; dj++) for (let di = 0; di < w; di++) {
    const t = tile(s, i + di, j + dj);
    if (!t) return 'Outside your land';
    if (!owned(s, i + di, j + dj)) return 'You don’t own this land yet';
    if (t.t !== 'g' && t.t !== 's') return 'Can’t build on water';
    if (t.o) return 'Clear the trees and rocks first';
    if (B.overlay ? (t.ov || t.b) : (t.b || t.c)) return 'Something is already here';
  }
  return null;
}

// ---------------------------------------------------------------- growth
export function setSpeed(c, now, sp) { c.g += ((now - c.t) / 1000) * c.sp; c.t = now; c.sp = sp; }
export function progress(c, now) {
  const C = CROPS[c.id];
  return Math.min(1, (c.g + ((now - c.t) / 1000) * c.sp) / C.grow);
}
export function remaining(c, now) {
  if (!c.sp) return Infinity;
  return Math.max(0, (CROPS[c.id].grow - (c.g + ((now - c.t) / 1000) * c.sp)) / c.sp);
}
export function stageOf(c, now) {
  const p = progress(c, now);
  if (CROPS[c.id].tree && c.adult) return p >= 1 ? 3 : 2;
  return p >= 1 ? 3 : p >= 0.6 ? 2 : p >= 0.25 ? 1 : 0;
}
export const ripe = (c, now) => !!c && progress(c, now) >= 1;
// crops grow on their own; watered crops grow twice as fast
function speedFor(s, i, j, c) {
  const t = tile(s, i, j);
  let bonus = 0;
  for (const b of Object.values(s.buildings)) if (b.type === 'statue' && near(b, i, j, 1)) bonus += BUILDINGS.statue.bonus;
  return (c.w ? 1 : 0.5) * c.fz * (t.f ? 1.1 : 1) * (1 + bonus);
}
function near(b, i, j, r) {
  const [w, h] = sizeOf(b.type, b.rot);
  const dx = i < b.i ? b.i - i : i > b.i + w - 1 ? i - (b.i + w - 1) : 0;
  const dy = j < b.j ? b.j - j : j > b.j + h - 1 ? j - (b.j + h - 1) : 0;
  return Math.max(dx, dy) <= r;
}
const working = (b, now) => !(b.off > now) && !b.fire;
export function sprinklerCovered(s, i, j, now = Date.now()) {
  for (const b of Object.values(s.buildings))
    if (BUILDINGS[b.type].range && b.type.startsWith('sprinkler') && working(b, now) && near(b, i, j, BUILDINGS[b.type].range)) return true;
  return false;
}
export function guarded(s, i, j, type) {
  for (const b of Object.values(s.buildings)) if (b.type === type && near(b, i, j, BUILDINGS[type].guard)) return true;
  return false;
}
export function shielded(s, i, j, kind, now = Date.now()) {
  const t = tile(s, i, j);
  if (!t) return false;
  if (t.ov && BUILDINGS[s.buildings[t.ov]?.type]?.shield?.includes(kind)) return true;
  if (kind === 'flood' && t.rb) return true;
  if (kind === 'drought' && sprinklerCovered(s, i, j, now)) return true;
  for (const b of Object.values(s.buildings)) {
    const B = BUILDINGS[b.type];
    if (B.guard && B.shield?.includes(kind) && !B.overlay && near(b, i, j, B.guard)) return true;
  }
  return false;
}
export const tileHeight = (i, j) => heightAt(tileX(i), tileZ(j));
export const isLow = (i, j) => tileHeight(i, j) < TIDE_HIGH - 0.05;

// ---------------------------------------------------------------- inventory helpers
export function addItem(s, arr, size, id, n) {
  const max = ITEMS[id].stack;
  for (let k = 0; k < size && n > 0; k++) {
    const st = arr[k];
    if (st && st.id === id && st.n < max) { const m = Math.min(n, max - st.n); st.n += m; n -= m; }
  }
  for (let k = 0; k < size && n > 0; k++) if (!arr[k]) { const m = Math.min(n, max); arr[k] = { id, n: m }; n -= m; }
  dirty.ui = true;
  return n;   // leftover
}
export function roomFor(arr, size, id) {
  const max = ITEMS[id].stack;
  let room = 0;
  for (let k = 0; k < size; k++) room += !arr[k] ? max : arr[k].id === id ? max - arr[k].n : 0;
  return room;
}
export const countItem = (arr, size, id) => arr.slice(0, size).reduce((a, st) => a + (st && st.id === id ? st.n : 0), 0);
function takeItem(arr, size, id, n) {
  for (let k = size - 1; k >= 0 && n > 0; k--) {
    const st = arr[k];
    if (st && st.id === id) { const m = Math.min(n, st.n); st.n -= m; n -= m; if (!st.n) arr[k] = null; }
  }
  dirty.ui = true;
}
function useSlot(p, slot, n = 1) {
  const st = p.inv[slot];
  st.n -= n;
  if (st.n <= 0) p.inv[slot] = null;
  dirty.ui = true;
}

export function addXp(s, n) {
  s.xp += n;
  while (s.xp >= xpFor(s.lv)) {
    s.xp -= xpFor(s.lv); s.lv++; s.gems += GEMS_PER_LEVEL;
    fx.push({ k: 'levelup', lv: s.lv });
    if (s.lv === 10) achieve(s, 'lv10', 'Reached level 10', 10);
  }
  dirty.ui = true;
}
function achieve(s, id, name, gems) {
  if (s.ach.includes(id)) return;
  s.ach.push(id); s.gems += gems;
  fx.push({ k: 'achievement', name, gems });
}
function tut(s, step) { if (s.tut === step) { s.tut++; dirty.ui = true; } }

// target areas: dir 0 = row along i (facing ±x), 1 = row along j (facing ±z)
export function area(i, j, shape, dir) {
  if (shape === 'row') return dir ? [[i, j - 1], [i, j], [i, j + 1]] : [[i - 1, j], [i, j], [i + 1, j]];
  const R = shape === '3x3' ? 1 : shape === '5x5' ? 2 : 0;
  if (R) { const o = []; for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) o.push([i + di, j + dj]); return o; }
  return [[i, j]];
}
export const hoeShape = s => (s.tools.hoe === 3 ? '3x3' : s.tools.hoe === 2 ? 'row' : 'one');
// bare hands pick one crop; the sickle sweeps a row of 3, the iron one 3x3, the golden one 5x5
export const sickleShape = (s, held) => (!held ? 'one' : ['row', '3x3', '5x5'][s.tools.sickle] || 'row');
export const bucketShape = s => (s.tools.bucket === 2 ? '3x3' : 'one');
export const pouchShape = s => (s.tools.pouch === 1 ? '3x3' : 'one');

// safety net: completely broke (can't afford a seed, nothing growing, nothing to sell or plant) — the shop hands
// over a few wheat seeds so a save can never get stuck
export const FREE_SEEDS = 5;
export function broke(s) {
  if (s.coins >= CROPS.wheat.seed || s.tiles.some(t => t.c)) return false;
  const useful = x => x && ['seed', 'crop', 'gold', 'good', 'res'].includes(ITEMS[x.id]?.kind);
  if (Object.values(s.players).some(p => p.inv.some(useful)) || s.donkey.inv.some(useful)) return false;
  return !Object.keys(s.store.silo.items).length && !Object.keys(s.store.barn.items).length;
}
export function shopState(s, e) {
  if (e.id === 'seed_wheat' && broke(s)) return { ok: true, free: true };
  const u = e.unlock || {};
  if (u.lv && s.lv < u.lv) return { ok: false, why: `Level ${u.lv}` };
  if (u.fh && s.fh < u.fh) return { ok: false, why: `Farmhouse ${u.fh}` };
  const ef = e.effect;
  if (ef.tool && s.tools[ef.tool[0]] >= ef.tool[1]) return { ok: false, why: 'Owned', owned: true };
  if (ef.crop && s.crops.includes(ef.crop)) return { ok: false, why: 'Unlocked', owned: true };
  if (ef.crop && !s.crops.includes(CROPS[ef.crop].prev)) return { ok: false, why: `Unlock ${CROPS[CROPS[ef.crop].prev].name.toLowerCase()} first` };
  const sc = ef.item && ITEMS[ef.item]?.crop;
  if (sc && ITEMS[ef.item].kind === 'seed' && !s.crops.includes(sc)) return { ok: false, why: 'Unlock it first' };
  const ub = ef.item && ITEMS[ef.item]?.building;
  if (ub && BUILDINGS[ub].unique && (hasBuilding(s, ub) || holdsItem(s, ef.item))) return { ok: false, why: 'Owned', owned: true };
  if (ef.fh && s.fh >= ef.fh) return { ok: false, why: 'Owned', owned: true };
  if (ef.fh && !hasBuilding(s, 'farmhouse')) return { ok: false, why: 'Build the farmhouse first' };
  if (ef.store && !hasBuilding(s, ef.store[0])) return { ok: false, why: `Build the ${ef.store[0]} first` };
  if (ef.fh && s.fh !== ef.fh - 1) return { ok: false, why: `Farmhouse ${ef.fh - 1}` };
  if (ef.store && s.store[ef.store[0]].lv >= ef.store[1]) return { ok: false, why: 'Owned', owned: true };
  if (ef.store && s.store[ef.store[0]].lv !== ef.store[1] - 1) return { ok: false, why: 'Upgrade the previous level' };
  if (ef.pack && s.pack >= ef.pack) return { ok: false, why: 'Owned', owned: true };
  if (ef.pack && s.pack !== ef.pack - 1) return { ok: false, why: 'Buy the first backpack' };
  if (ef.donkey && s.donkey.lv >= ef.donkey) return { ok: false, why: 'Owned', owned: true };
  if (ef.donkey && s.donkey.lv !== ef.donkey - 1) return { ok: false, why: 'Buy saddle bags first' };
  if (ef.botLv && s.botLv >= ef.botLv) return { ok: false, why: 'Owned', owned: true };
  if (ef.botLv && s.botLv !== ef.botLv - 1) return { ok: false, why: 'Buy the first bot upgrade' };
  if (ef.bridge && s.bridge) return { ok: false, why: 'Built', owned: true };
  if (ef.ship && (s.ship || 0) >= ef.ship) return { ok: false, why: 'Done', owned: true };
  if (ef.ship && (s.ship || 0) !== ef.ship - 1) return { ok: false, why: 'Finish the step before' };
  if (s.coins < e.cost || s.gems < e.gems) return { ok: false, why: e.gems ? `${e.gems} gems` : 'Not enough coins', poor: true };
  return { ok: true };
}
export function plotState(s, px, py) {
  if (px < 0 || py < 0 || px >= PLOTS || py >= PLOTS) return { ok: false, why: 'Outside the farm' };
  if (s.plots[py * PLOTS + px]) return { ok: false, why: 'Already yours', owned: true };
  const adj = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => s.plots[(py + dy) * PLOTS + px + dx] && px + dx >= 0 && px + dx < PLOTS && py + dy >= 0 && py + dy < PLOTS);
  if (!adj) return { ok: false, why: 'Buy the land next to yours first' };
  if (px > BRIDGE_COL && !s.bridge) return { ok: false, why: 'Build the bridge to reach this land' };
  if (s.freePlots) return { ok: true, free: true, price: 0 };
  if (s.lv < TIER_LEVEL[2]) return { ok: false, why: `Land expansion unlocks at level ${TIER_LEVEL[2]}` };
  if (s.coins < plotPrice(s)) return { ok: false, why: 'Not enough coins', price: plotPrice(s) };
  return { ok: true, price: plotPrice(s) };
}

// ---------------------------------------------------------------- the reducer
const FAIL = msg => ({ ok: false, msg });
const OK = { ok: true };

export function apply(s, a) {
  const r = (A[a.type] || (() => FAIL('Unknown action ' + a.type)))(s, a, a.now ?? Date.now());
  if (r.ok) { s.rev++; dirty.ui = true; }
  return r;
}

function harvestTile(s, i, j, now, roll, into) {
  const t = tile(s, i, j);
  if (!t?.c || !ripe(t.c, now)) return null;
  const C = CROPS[t.c.id];
  const gold = C.tier === 5 && roll < GOLDEN_CHANCE * (t.c.gf || 1);
  const id = (gold ? 'g_' : '') + C.id;
  if (into && into(id) === false) return 'full';
  addXp(s, xpForHarvest(C, ITEMS[id]));
  s.stats.harvests++;
  if (s.stats.harvests === 1) achieve(s, 'first', 'First harvest', 5);
  if (s.stats.harvests === 100) achieve(s, 'h100', '100 harvests', 10);
  if (gold) { s.stats.golden++; achieve(s, 'golden', 'First golden crop', 10); }
  if (C.tree) { t.c.g = 0; t.c.t = now; t.c.adult = 1; }
  else {
    t.last = C.id; t.c = null; t.wet = 0;
    replant(s, i, j, now);
  }
  mT(idx(i, j));
  fx.push({ k: 'harvest', i, j, id, gold });
  return id;
}
function replant(s, i, j, now) {
  const t = tile(s, i, j);
  if (!t.last || t.c || t.b) return;
  if (!Object.values(s.buildings).some(b => b.type === 'auto_planter' && working(b, now) && near(b, i, j, 1))) return;
  const C = CROPS[t.last];
  if (s.coins < C.seed) return;
  s.coins -= C.seed;
  t.c = newCrop(s, i, j, C.id, now);
  fx.push({ k: 'plant', i, j, auto: true });
}
function newCrop(s, i, j, id, now) {
  const t = tile(s, i, j);
  const w = t.wet || sprinklerCovered(s, i, j, now) ? 1 : 0;
  const c = { id, g: 0, t: now, sp: 0, w, fz: 1, gf: 1 };
  c.sp = speedFor(s, i, j, c);
  s.stats.planted++;
  return c;
}

const A = {
  join(s, a) { addPlayer(s, a.pid, a.name); return OK; },
  // Biscuit: follow (cmd null), stay or go to a spot (then wait there)
  donkey(s, a) {
    if (!['follow', 'stay', 'go'].includes(a.m)) return FAIL('Biscuit doesn’t know that one');
    const x = +a.x, z = +a.z;
    if (a.m !== 'follow' && !(Number.isFinite(x) && Number.isFinite(z))) return FAIL('Pick a spot for Biscuit');
    s.donkey.cmd = a.m === 'follow' ? null : { m: a.m, x, z };
    fx.push({ k: 'donkeyCmd', m: a.m, pid: a.pid });
    return OK;
  },
  pet(s, a) { s.donkey.pets = (s.donkey.pets || 0) + 1; fx.push({ k: 'pet', pid: a.pid }); return OK; },
  sel(s, a) { const p = s.players[a.pid]; if (!p) return FAIL('No player'); p.sel = a.slot; dirty.ui = true; return OK; },

  till(s, a, now) {
    let n = 0, why = null;
    for (const [i, j] of area(a.i, a.j, hoeShape(s), a.dir)) {
      const t = tile(s, i, j);
      if (!t || t.t !== 'g' || t.o || t.b) continue;
      if (!owned(s, i, j)) { why = why || 'Buy this land first'; continue; }
      if (s.coins < TILL_COST) { why = `Tilling a field tile costs ${TILL_COST} coins`; break; }
      t.t = 's'; s.coins -= TILL_COST; n++; mT(idx(i, j));
      fx.push({ k: 'till', i, j });
      if (s.tut === 4) tut(s, 4);
    }
    return n ? OK : FAIL(why || 'Nothing to till here');
  },

  plant(s, a, now) {
    const p = s.players[a.pid], st = p?.inv[a.slot];
    if (!st || ITEMS[st.id].kind !== 'seed') return FAIL('Hold seeds to plant');
    const C = CROPS[ITEMS[st.id].crop];
    let n = 0;
    for (const [i, j] of area(a.i, a.j, C.tree ? 'one' : pouchShape(s), a.dir)) {
      const t = tile(s, i, j);
      if (!p.inv[a.slot] || !t || t.t !== 's' || t.c || t.b) continue;
      t.c = newCrop(s, i, j, C.id, now);
      useSlot(p, a.slot); n++; mT(idx(i, j));
      fx.push({ k: 'plant', i, j, pid: a.pid });
    }
    if (n) tut(s, 0);
    return n ? OK : FAIL('Plant on empty tilled soil');
  },

  water(s, a, now) {
    const p = s.players[a.pid];
    if (!p) return FAIL('No player');
    if (p.water <= 0) return FAIL('Your bucket is empty — refill it at the pond, river, a well or a rain barrel');
    let n = 0;
    const bt = a.bid && s.buildings[a.bid];
    if (bt?.fire) { bt.fire = 0; mB(bt.id); n++; fx.push({ k: 'extinguish', bid: bt.id }); }
    else for (const [i, j] of area(a.i, a.j, bucketShape(s), a.dir)) {
      const t = tile(s, i, j);
      if (!t) continue;
      if (t.fire) { t.fire = 0; n++; mT(idx(i, j)); fx.push({ k: 'extinguish', i, j }); continue; }
      if (t.t !== 's') continue;
      if (!t.wet) { t.wet = 1; n++; }
      if (t.c && !t.c.w) { t.c.w = 1; setSpeed(t.c, now, speedFor(s, i, j, t.c)); n++; }
      mT(idx(i, j));
      fx.push({ k: 'water', i, j });
    }
    if (!n) return FAIL('Nothing here needs water');
    p.water--;
    return OK;
  },

  refill(s, a) {
    const p = s.players[a.pid];
    p.water = BUCKET_CAP[s.tools.bucket];
    fx.push({ k: 'refill', pid: a.pid });
    dirty.ui = true;
    return OK;
  },

  harvest(s, a, now) {
    const p = s.players[a.pid];
    if (!p) return FAIL('No player');
    let n = 0, full = false;
    const into = id => (addItem(s, p.inv, invSize(s), id, 1) ? (full = true, false) : true);
    area(a.i, a.j, sickleShape(s, p.inv[p.sel]?.id === 'sickle'), a.dir).forEach(([i, j], k) => {
      if (full) return;
      if (harvestTile(s, i, j, now, a.r?.[k] ?? 1, into) && !full) n++;
    });
    if (n) tut(s, 1);
    return n ? OK : FAIL(full ? 'Your backpack is full — sell or store something' : 'Nothing is ripe here yet');
  },

  hit(s, a, now) {
    const t = tile(s, a.i, a.j), p = s.players[a.pid];
    if (!t?.o && t?.c && CROPS[t.c.id].tree && p && a.tool === 'axe') {   // cut down a planted fruit tree to free the tile
      t.c = null; t.wet = 0; t.last = null;
      addItem(s, p.inv, invSize(s), 'wood', 3);
      fx.push({ k: 'fell', i: a.i, j: a.j, from: 'jungle' });
      mT(idx(a.i, a.j));
      return OK;
    }
    if (!t?.o || !p) return FAIL('Nothing to clear here');
    const o = t.o, k = o.k;
    const need = k === 'rock' ? 'pickaxe' : k === 'stump' ? (a.tool === 'pickaxe' ? 'pickaxe' : 'axe') : 'axe';
    if (a.tool !== need) return FAIL(k === 'rock' ? 'Use the pickaxe on rocks' : 'Use the axe on trees');
    o.hp++;
    fx.push({ k: 'hit', i: a.i, j: a.j, o: k });
    const hits = k === 'bush' ? 1 : HITS[s.tools[need]] + (k === 'stump' ? 0 : 0);
    if (o.hp < hits) { mT(idx(a.i, a.j)); return OK; }
    const give = (id, n) => { const left = addItem(s, p.inv, invSize(s), id, n); if (left) fx.push({ k: 'msg', pid: a.pid, msg: 'Backpack full' }); };
    if (k === 'palm' || k === 'jungle') { t.o = { k: 'stump', from: k, v: o.v, hp: 0, at: now }; give('wood', 3); fx.push({ k: 'fell', i: a.i, j: a.j, from: k }); }
    else if (k === 'stump') { t.o = null; give('wood', 1); }
    else if (k === 'rock') { t.o = null; give('stone', 3 + o.v); }
    else { t.o = null; give('wood', 1); }
    mT(idx(a.i, a.j));
    return OK;
  },

  regrow(s, a) {
    const t = tile(s, a.i, a.j);
    if (t?.o?.k !== 'stump') return FAIL('');
    t.o = { k: t.o.from, v: t.o.v, hp: 0 };
    mT(idx(a.i, a.j));
    fx.push({ k: 'regrow', i: a.i, j: a.j });
    return OK;
  },

  fertilize(s, a, now) {
    const p = s.players[a.pid], st = p?.inv[a.slot], t = tile(s, a.i, a.j);
    if (!st || ITEMS[st.id].kind !== 'boost') return FAIL('Hold fertilizer');
    if (!t?.c || ripe(t.c, now)) return FAIL('Use it on a growing crop');
    const I = ITEMS[st.id];
    if (I.gold) { if (CROPS[t.c.id].tier !== 5) return FAIL('Golden fertilizer works on rare crops'); if (t.c.gf > 1) return FAIL('Already fertilized'); t.c.gf = I.gold; }
    else { if (t.c.fz >= I.boost) return FAIL('Already fertilized'); t.c.fz = I.boost; setSpeed(t.c, now, speedFor(s, a.i, a.j, t.c)); }
    useSlot(p, a.slot);
    mT(idx(a.i, a.j));
    fx.push({ k: 'fertilize', i: a.i, j: a.j });
    return OK;
  },

  speedup(s, a, now) {
    const t = tile(s, a.i, a.j);
    if (!t?.c || ripe(t.c, now)) return FAIL('Nothing to speed up');
    const rem = t.c.sp ? remaining(t.c, now) : CROPS[t.c.id].grow;
    const cost = Math.max(1, Math.ceil(rem / 600));
    if (s.gems < cost) return FAIL(`Needs ${cost} gems`);
    s.gems -= cost;
    t.c.g = CROPS[t.c.id].grow; t.c.t = now; t.c.w = 1; t.c.sp = t.c.sp || 1;
    mT(idx(a.i, a.j));
    fx.push({ k: 'sparkle', i: a.i, j: a.j });
    return OK;
  },

  place(s, a, now) {
    const p = s.players[a.pid], st = p?.inv[a.slot];
    if (!st || ITEMS[st.id].kind !== 'place') return FAIL('Hold a blueprint');
    const type = ITEMS[st.id].building, B = BUILDINGS[type];
    const why = canPlace(s, type, a.i, a.j, a.rot || 0);
    if (why) return FAIL(why);
    if (B.tilemod) {
      const t = tile(s, a.i, a.j);
      if (B.tilemod === 'raised') t.rb = 1; else t.f = 1;
      if (t.c) setSpeed(t.c, now, speedFor(s, a.i, a.j, t.c));
      mT(idx(a.i, a.j));
    } else {
      const d = type === 'harvester_bot' ? { hop: {}, t: now } : B.factory ? { job: null } : type === 'auto_market' ? { mult: 1, t: now } : {};
      const b = addBuilding(s, type, a.i, a.j, a.rot || 0, d);
      if (B.range && type.startsWith('sprinkler')) wetRange(s, b, now);
    }
    useSlot(p, a.slot);
    fx.push({ k: 'build', i: a.i, j: a.j, type });
    return OK;
  },

  pickup(s, a) {
    const b = s.buildings[a.bid], p = s.players[a.pid];
    if (!b || BUILDINGS[b.type].fixed) return FAIL('This can’t be moved');
    if (b.d.job || Object.keys(b.d.hop || {}).length) return FAIL('Empty it first');
    if (addItem(s, p.inv, invSize(s), 'bp_' + b.type, 1)) return FAIL('Your backpack is full');
    removeBuilding(s, b);
    return OK;
  },

  move(s, a, now) {
    const b = s.buildings[a.bid];
    if (!b || BUILDINGS[b.type].fixed) return FAIL('This can’t be moved');
    const old = { i: b.i, j: b.j, rot: b.rot };
    removeBuilding(s, b, true);
    const why = canPlace(s, b.type, a.i, a.j, a.rot || 0);
    const at = why ? old : { i: a.i, j: a.j, rot: a.rot || 0 };
    const nb = addBuilding(s, b.type, at.i, at.j, at.rot, b.d);
    delete s.buildings[nb.id]; nb.id = b.id; s.buildings[b.id] = nb; nb.fire = b.fire; nb.off = b.off;
    for (const [ti, tj] of footprint(nb)) { const t = tile(s, ti, tj); if (BUILDINGS[nb.type].overlay) t.ov = nb.id; else t.b = nb.id; }
    s.nextId--;
    mB(b.id);
    return why ? FAIL(why) : OK;
  },

  buy(s, a, now) {
    const e = SHOP.find(x => x.id === a.sid), p = s.players[a.pid];
    if (!e) return FAIL('Not for sale');
    const n = Math.max(1, Math.min(99, a.n || 1));
    const st = shopState(s, e);
    if (st.free) {
      if (roomFor(p.inv, invSize(s), e.effect.item) < FREE_SEEDS) return FAIL('Your backpack is full');
      addItem(s, p.inv, invSize(s), e.effect.item, FREE_SEEDS);
      fx.push({ k: 'msg', pid: a.pid, msg: `Down on your luck? The shopkeeper hands you ${FREE_SEEDS} wheat seeds.` });
      return OK;
    }
    if (!st.ok && !st.poor) return FAIL(st.why);
    if (s.coins < e.cost * n || s.gems < e.gems * n) return FAIL(e.gems ? 'Not enough gems' : 'Not enough coins');
    const ef = e.effect;
    if (ef.item && roomFor(p.inv, invSize(s), ef.item) < n) return FAIL('Your backpack is full');
    s.coins -= e.cost * n; s.gems -= e.gems * n;
    if (ef.crop) s.crops.push(ef.crop);
    if (ef.credits) s.credits += n;
    if (ef.item) addItem(s, p.inv, invSize(s), ef.item, n);
    if (ef.tool) s.tools[ef.tool[0]] = ef.tool[1];
    if (ef.tool?.[0] === 'bucket') for (const q of Object.values(s.players)) q.water = BUCKET_CAP[s.tools.bucket];
    if (ef.fh) { s.fh = ef.fh; for (const b of Object.values(s.buildings)) if (b.type === 'farmhouse') mB(b.id); }
    if (ef.store) s.store[ef.store[0]].lv = ef.store[1];
    if (ef.pack) s.pack = ef.pack;
    if (ef.donkey) s.donkey.lv = ef.donkey;
    if (ef.botLv) s.botLv = ef.botLv;
    if (ef.bridge) { s.bridge = 1; addBuilding(s, 'bridge', 34, 20, 0); }
    if (ef.ship) { s.ship = ef.ship; if (ef.ship === SHIP_PARTS.length) { s.won = now; fx.push({ k: 'ending' }); } else fx.push({ k: 'shipPart', n: ef.ship }); }
    if (s.tut === 3) tut(s, 3);
    fx.push({ k: 'buy', pid: a.pid, sid: e.id });
    return OK;
  },

  buyPlot(s, a) {
    const st = plotState(s, a.px, a.py);
    if (!st.ok) return FAIL(st.why);
    if (st.free) s.freePlots--; else { s.coins -= st.price; s.plotsBought++; }
    s.plots[a.py * PLOTS + a.px] = 1;
    for (let j = 0; j < PLOT; j++) for (let i = 0; i < PLOT; i++) mT(idx(a.px * PLOT + i, a.py * PLOT + j));
    fx.push({ k: 'plot', px: a.px, py: a.py });
    return OK;
  },

  sell(s, a) {
    const p = s.players[a.pid];
    let coins = 0;
    const sellable = st => st && ['crop', 'gold', 'good', 'res'].includes(ITEMS[st.id].kind);
    const slots = a.all ? p.inv.map((_, k) => k).slice(0, invSize(s)) : [a.slot];
    for (const k of slots) {
      const st = p.inv[k];
      if (!st || (a.all ? !sellable(st) : !ITEMS[st.id].sell)) continue;
      const n = a.all ? st.n : Math.min(st.n, a.n || st.n);
      coins += ITEMS[st.id].sell * n; s.stats.sold += n;
      useSlot(p, k, n);
    }
    if (!coins) return FAIL('Nothing to sell');
    s.coins += coins;
    tut(s, 2);
    fx.push({ k: 'coins', n: coins, pid: a.pid });
    return OK;
  },

  sellStore(s, a) {
    const st = s.store[a.store], n = st?.items[a.id];
    if (!n) return FAIL('Nothing to sell');
    s.coins += ITEMS[a.id].sell * n; delete st.items[a.id];
    fx.push({ k: 'coins', n: ITEMS[a.id].sell * n, pid: a.pid });
    return OK;
  },

  // drag & drop between containers. from/to: {c:'inv'|'donkey'|'silo'|'barn'|'bot', k}
  xfer(s, a) {
    const p = s.players[a.pid];
    const slots = c => (c === 'inv' ? [p.inv, invSize(s)] : c === 'donkey' ? [s.donkey.inv, donkeySize(s)] : null);
    const dict = (c, k) => (c === 'silo' || c === 'barn' ? s.store[c].items : c === 'bot' ? s.buildings[k]?.d.hop : null);
    const { from, to } = a;
    const fs = slots(from.c), ts = slots(to.c);
    if (fs && ts) {
      const A1 = fs[0], B1 = ts[0];
      if (from.k >= fs[1] || to.k >= ts[1] || !A1[from.k]) return FAIL('');
      const x = A1[from.k], y = B1[to.k];
      if (A1 === B1 && from.k === to.k) return OK;
      if (y && y.id === x.id) {
        const m = Math.min(x.n, ITEMS[x.id].stack - y.n); y.n += m; x.n -= m; if (!x.n) A1[from.k] = null;
      } else { A1[from.k] = y || null; B1[to.k] = x; }
      dirty.ui = true;
      return OK;
    }
    if (fs) {   // slots -> store
      const x = fs[0][from.k];
      if (!x) return FAIL('');
      if (to.c === 'bot') return FAIL('');
      if (!storeAccepts(to.c, x.id)) return FAIL(to.c === 'silo' ? 'The silo holds crops' : 'The barn holds goods, wood, stone and seeds — crops go in the silo');
      const room = storeCap(s, to.c) - storeCount(s, to.c);
      const m = Math.min(room, x.n);
      if (m <= 0) return FAIL(`The ${to.c} is full — upgrade it at the shop`);
      const d = s.store[to.c].items; d[x.id] = (d[x.id] || 0) + m;
      x.n -= m; if (!x.n) fs[0][from.k] = null;
      dirty.ui = true;
      return OK;
    }
    const d = dict(from.c, from.k);
    if (!d || !ts) return FAIL('');
    const ids = from.c === 'bot' ? Object.keys(d) : [a.id];
    let moved = 0;
    for (const id of ids) {
      const have = d[id] || 0;
      const m = Math.min(have, from.c === 'bot' ? have : ITEMS[id].stack, roomFor(ts[0], ts[1], id));
      if (m <= 0) continue;
      addItem(s, ts[0], ts[1], id, m);
      d[id] -= m; if (!d[id]) delete d[id];
      moved += m;
    }
    if (from.c === 'bot') mB(from.k);
    dirty.ui = true;
    return moved ? OK : FAIL('No room in your backpack');
  },

  turnIn(s, a) {
    const p = s.players[a.pid], q = s.quests.find(x => x.id === a.qid);
    if (!q) return FAIL('That order is gone');
    for (const [id, n] of Object.entries(q.need)) if (countItem(p.inv, invSize(s), id) < n) return FAIL(`You need ${n} ${ITEMS[id].name.toLowerCase()}`);
    const rw = q.reward;
    if (rw.item && roomFor(p.inv, invSize(s), rw.item) < (rw.n || 1)) return FAIL('Make room in your backpack first');
    for (const [id, n] of Object.entries(q.need)) takeItem(p.inv, invSize(s), id, n);
    if (rw.coins) s.coins += rw.coins;
    if (rw.gems) s.gems += rw.gems;
    if (rw.item) addItem(s, p.inv, invSize(s), rw.item, rw.n || 1);
    if (rw.tool && s.tools[rw.tool[0]] < rw.tool[1]) s.tools[rw.tool[0]] = rw.tool[1];
    if (rw.plot) s.freePlots += rw.plot;
    if (rw.xp) addXp(s, rw.xp);
    s.quests = s.quests.filter(x => x !== q);
    s.stats.quests++;
    if (q.story) { s.story++; if (STORY_QUESTS[s.story]) s.quests.unshift({ ...STORY_QUESTS[s.story], id: s.qn++, story: true }); }
    fx.push({ k: 'quest', pid: a.pid, reward: rw });
    return OK;
  },

  traderArrive(s, a, now) {
    s.trader.at = now; s.trader.next = now + TRADER_EVERY * 1000;
    if (a.quest && s.quests.length < 3) s.quests.push({ ...a.quest, id: s.qn++ });
    fx.push({ k: 'trader' });
    return OK;
  },

  facStart(s, a, now) {
    const b = s.buildings[a.bid], p = s.players[a.pid];
    if (!b || !BUILDINGS[b.type].factory) return FAIL('');
    if (b.d.job) return FAIL('Collect what’s done first');
    const rc = RECIPES[b.type][a.r], n = Math.max(1, Math.min(20, a.n || 1));
    for (const [id, k] of Object.entries(rc.in)) if (countItem(p.inv, invSize(s), id) < k * n) return FAIL(`Needs ${k * n} ${ITEMS[id].name.toLowerCase()}`);
    for (const [id, k] of Object.entries(rc.in)) takeItem(p.inv, invSize(s), id, k * n);
    b.d.job = { r: a.r, n, start: now };
    mB(b.id);
    fx.push({ k: 'factory', bid: b.id });
    return OK;
  },

  facCollect(s, a, now) {
    const b = s.buildings[a.bid], p = s.players[a.pid], job = b?.d.job;
    if (!job) return FAIL('Nothing is cooking');
    const rc = RECIPES[b.type][job.r];
    const done = Math.min(job.n, Math.floor((now - job.start) / (rc.time * 1000)));
    if (!done) return FAIL('Not ready yet');
    const left = addItem(s, p.inv, invSize(s), rc.out, done);
    const got = done - left;
    if (!got) return FAIL('Your backpack is full');
    job.n -= got; job.start += got * rc.time * 1000;
    if (!job.n) b.d.job = null;
    mB(b.id);
    fx.push({ k: 'collect', bid: b.id, id: rc.out, n: got });
    return OK;
  },

  marketSet(s, a) { const b = s.buildings[a.bid]; if (!b) return FAIL(''); b.d.mult = Math.min(1.4, Math.max(0.8, a.mult)); mB(b.id); return OK; },

  outfit(s, a) {
    const o = OUTFITS[a.idx], p = s.players[a.pid];
    if (!o) return FAIL('');
    if (!s.outfits.includes(o[0])) { if (s.gems < o[2]) return FAIL(`Needs ${o[2]} gems`); s.gems -= o[2]; s.outfits.push(o[0]); }
    p.outfit = o[0];
    fx.push({ k: 'outfit', pid: a.pid });
    return OK;
  },

  scare(s, a) {
    const c = s.crows.find(x => x.id === a.crow);
    if (!c) return FAIL('');
    s.crows = s.crows.filter(x => x !== c);
    fx.push({ k: 'scare', i: c.i, j: c.j });
    return OK;
  },

  // ---- host-generated
  autowater(s, a, now) {
    for (const k of a.tiles) {
      const t = s.tiles[k];
      if (t.t !== 's') continue;
      t.wet = 1;
      if (t.c && !t.c.w) { t.c.w = 1; setSpeed(t.c, now, speedFor(s, k % GRID, Math.floor(k / GRID), t.c)); }
      mT(k);
    }
    return OK;
  },
  botHarvest(s, a, now) {
    const b = s.buildings[a.bid];
    if (!b) return FAIL('');
    b.d.t = now;
    const hop = b.d.hop, cnt = Object.values(hop).reduce((x, y) => x + y, 0);
    let target = null;
    const conn = connectedToSilo(s, b);
    const id = harvestTile(s, a.i, a.j, now, a.r?.[0] ?? 1, id => {
      if (conn && storeCount(s, 'silo') < storeCap(s, 'silo')) { target = 'silo'; s.store.silo.items[id] = (s.store.silo.items[id] || 0) + 1; return true; }
      if (cnt < 20) { target = 'hop'; hop[id] = (hop[id] || 0) + 1; return true; }
      return false;
    });
    mB(b.id);
    if (id) fx.push({ k: 'bot', bid: b.id, i: a.i, j: a.j, to: target });
    return OK;
  },
  marketSell(s, a) {
    const b = s.buildings[a.bid], items = s.store.silo.items;
    let coins = 0;
    for (const [id, n] of Object.entries(a.items)) {
      const m = Math.min(n, items[id] || 0);
      if (!m) continue;
      coins += Math.round(ITEMS[id].sell * (b?.d.mult || 1)) * m;
      items[id] -= m; if (!items[id]) delete items[id];
    }
    if (!coins) return FAIL('');
    s.coins += coins;
    if (b) { b.d.t = a.now; fx.push({ k: 'market', bid: b.id, n: coins }); }
    return OK;
  },
  crowSpawn(s, a) { s.crows.push({ id: a.id, i: a.i, j: a.j, t: a.now }); fx.push({ k: 'crow', i: a.i, j: a.j }); return OK; },
  crowEat(s, a) {
    const c = s.crows.find(x => x.id === a.id);
    if (!c) return FAIL('');
    s.crows = s.crows.filter(x => x !== c);
    const t = tile(s, c.i, c.j);
    if (t?.c && !guarded(s, c.i, c.j, 'scarecrow')) {
      if (CROPS[t.c.id].tree) { t.c.g = 0; t.c.t = a.now; } else { t.c = null; t.wet = 0; }
      mT(idx(c.i, c.j));
      fx.push({ k: 'eaten', i: c.i, j: c.j });
    }
    return OK;
  },
  weather(s, a) {
    Object.assign(s.weather, a.w);
    fx.push({ k: 'weather', phase: s.weather.phase, kind: s.weather.kind });
    return OK;
  },
  strike(s, a, now) {
    if (a.bid) { const b = s.buildings[a.bid]; if (!b) return FAIL(''); if (b.type !== 'lightning_rod') { b.fire = now; mB(b.id); } fx.push({ k: 'strike', bid: b.id, rod: b.type === 'lightning_rod' }); return OK; }
    const t = tile(s, a.i, a.j);
    if (!t) return FAIL('');
    if (t.c) { t.fire = now; mT(idx(a.i, a.j)); }
    fx.push({ k: 'strike', i: a.i, j: a.j });
    return OK;
  },
  burnout(s, a, now) {
    if (a.bid) { const b = s.buildings[a.bid]; if (!b?.fire) return FAIL(''); b.fire = 0; b.off = now + 120e3; mB(b.id); fx.push({ k: 'burnt', bid: b.id }); return OK; }
    const t = tile(s, a.i, a.j);
    if (!t?.fire) return FAIL('');
    t.fire = 0;
    if (t.c) { t.c = null; t.wet = 0; }
    mT(idx(a.i, a.j));
    fx.push({ k: 'burnt', i: a.i, j: a.j });
    return OK;
  },
  damage(s, a, now) {   // acid / storm / flood hit on one crop tile
    const t = tile(s, a.i, a.j);
    if (!t?.c || shielded(s, a.i, a.j, a.kind, now)) return FAIL('');
    if (a.kind === 'storm') { const C = CROPS[t.c.id]; const g = progress(t.c, now) * C.grow; t.c.g = g * 0.5; t.c.t = now; }
    else if (CROPS[t.c.id].tree) { t.c.g = 0; t.c.t = now; }
    else { t.c = null; t.wet = 0; }
    mT(idx(a.i, a.j));
    fx.push({ k: 'damage', kind: a.kind, i: a.i, j: a.j });
    return OK;
  },
  dry(s, a, now) {
    s.tiles.forEach((t, k) => {
      const i = k % GRID, j = Math.floor(k / GRID);
      if (t.t !== 's' || shielded(s, i, j, 'drought', now)) return;
      if (t.wet) { t.wet = 0; mT(k); }
      if (t.c && t.c.w && !ripe(t.c, now) && !CROPS[t.c.id].tree) { t.c.w = 0; setSpeed(t.c, now, speedFor(s, i, j, t.c)); mT(k); }
    });
    return OK;
  },
};

function removeBuilding(s, b, keep) {
  for (const [ti, tj] of footprint(b)) {
    const t = tile(s, ti, tj);
    if (t.b === b.id) t.b = null;
    if (t.ov === b.id) t.ov = null;
    mT(idx(ti, tj));
  }
  delete s.buildings[b.id];
  if (!keep) fx.push({ k: 'removed', bid: b.id });
  mB(b.id);
}
function wetRange(s, b, now) {
  const r = BUILDINGS[b.type].range;
  const tiles = [];
  for (let j = b.j - r; j <= b.j + r; j++) for (let i = b.i - r; i <= b.i + r; i++) if (tile(s, i, j)?.t === 's') tiles.push(idx(i, j));
  A.autowater(s, { tiles }, now);
}

// conveyors chain from a bot's dock to the silo (4-neighbour flood fill over conveyor tiles)
export function connectedToSilo(s, bot) {
  const isType = (i, j, type) => { const t = tile(s, i, j); return t?.b && s.buildings[t.b]?.type === type; };
  const seen = new Set(), q = [[bot.i, bot.j]];
  while (q.length) {
    const [i, j] = q.shift();
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj, key = idx(ni, nj);
      if (!inGrid(ni, nj) || seen.has(key)) continue;
      seen.add(key);
      if (isType(ni, nj, 'silo')) return true;
      if (isType(ni, nj, 'conveyor')) q.push([ni, nj]);
    }
  }
  return false;
}

// ---------------------------------------------------------------- host-side resolution + systems
export function resolve(s, a, now = Date.now()) {
  a.now = now;
  a.r = Array.from({ length: 25 }, Math.random);
  return a;
}

function makeQuest(s) {
  const pool = CROP_LIST.filter(c => s.crops.includes(c.id));
  const pick = () => pool[Math.floor(Math.random() * pool.length)];
  const need = {};
  const n = Math.random() < 0.4 ? 2 : 1;
  for (let k = 0; k < n; k++) { const c = pick(); need[c.id] = (need[c.id] || 0) + Math.max(2, Math.round((4 + Math.random() * 10) / Math.sqrt(c.tier))); }
  const value = Object.entries(need).reduce((v, [id, q]) => v + ITEMS[id].sell * q, 0);
  const xpv = Object.entries(need).reduce((v, [id, q]) => v + CROPS[id].xp * q, 0);   // xp on the uninflated profit
  const reward = { coins: Math.round(value * 1.6), xp: Math.max(5, Math.round(xpv * 0.6)) };
  if (Math.random() < 0.3) reward.gems = 1 + Math.floor(Math.random() * 3);
  const names = Object.keys(need).map(id => `${need[id]} ${ITEMS[id].name.toLowerCase()}`).join(' and ');
  return { need, reward, text: `I’m buying ${names}.` };
}

const T = { crow: 0, hit: 0, sys: 0 };
// emit(action) must resolve + apply (+ broadcast). off = offline catch-up (no crows/weather).
export function tick(s, now, emit, off = false) {
  const every = (key, ms) => (now - (T[key] || 0) >= ms ? ((T[key] = now), true) : false);
  if (off || every('sys', 1000)) {
    const wet = [];
    for (const b of Object.values(s.buildings)) {
      const B = BUILDINGS[b.type];
      if (b.type.startsWith('sprinkler') && working(b, now))
        for (let j = b.j - B.range; j <= b.j + B.range; j++) for (let i = b.i - B.range; i <= b.i + B.range; i++) {
          const t = tile(s, i, j);
          if (t?.t === 's' && (!t.wet || (t.c && !t.c.w))) wet.push(idx(i, j));
        }
      if (b.type === 'harvester_bot' && working(b, now)) {
        const iv = s.botLv >= 1 ? 2000 : 4000, R = s.botLv >= 2 ? 3 : 2;
        let times = off ? Math.min(40, Math.floor((now - b.d.t) / iv)) : now - b.d.t >= iv ? 1 : 0;
        for (let j = b.j - R; j <= b.j + R && times > 0; j++) for (let i = b.i - R; i <= b.i + R && times > 0; i++) {
          const t = tile(s, i, j);
          if (t?.c && ripe(t.c, now)) { emit({ type: 'botHarvest', bid: b.id, i, j }); times--; }
        }
        if (times > 0 && !off) b.d.t = now;
      }
      if (b.type === 'auto_market' && working(b, now) && now - (b.d.t || 0) >= 10e3) {
        const per = Math.max(1, Math.round(9 * (1.4 - b.d.mult) / 0.6));
        let left = per * (off ? Math.min(60, Math.floor((now - (b.d.t || now)) / 10e3)) : 1);
        const items = {};
        for (const [id, n] of Object.entries(s.store.silo.items)) { if (left <= 0) break; const m = Math.min(n, left); items[id] = m; left -= m; }
        if (Object.keys(items).length) emit({ type: 'marketSell', bid: b.id, items }); else b.d.t = now;
      }
      if (b.fire && now - b.fire > 12e3) emit({ type: 'burnout', bid: b.id });
    }
    if (wet.length) emit({ type: 'autowater', tiles: wet });
    s.tiles.forEach((t, k) => {
      if (t.o?.k === 'stump' && now - t.o.at > 900e3) emit({ type: 'regrow', i: k % GRID, j: Math.floor(k / GRID) });
      if (t.fire && now - t.fire > 12e3) emit({ type: 'burnout', i: k % GRID, j: Math.floor(k / GRID) });
    });
    if (now >= s.trader.next) emit({ type: 'traderArrive', quest: s.quests.length < 3 ? makeQuest(s) : null });
  }
  if (off) return;

  // crows
  for (const c of s.crows) if (now - c.t > 12e3) emit({ type: 'crowEat', id: c.id });
  if (!T.crowNext) T.crowNext = now + 60e3;
  if (now >= T.crowNext) {
    T.crowNext = now + (45 + Math.random() * 45) * 1000;
    if (s.crows.length < 2) {
      const opts = [];
      s.tiles.forEach((t, k) => { const i = k % GRID, j = Math.floor(k / GRID); if (t.c && ripe(t.c, now) && !guarded(s, i, j, 'scarecrow')) opts.push([i, j]); });
      if (opts.length) { const [i, j] = opts[Math.floor(Math.random() * opts.length)]; emit({ type: 'crowSpawn', id: 'c' + Math.floor(Math.random() * 1e9), i, j }); }
    }
  }

  // weather
  const w = s.weather;
  if (w.phase === 'calm' && now >= w.next) {
    const kinds = Object.entries(DISASTERS).filter(([, d]) => s.lv >= d.minLv).map(([k]) => k);
    if (!kinds.length) emit({ type: 'weather', w: { next: now + DISASTER_GAP[0] * 1000 } });
    else emit({ type: 'weather', w: { kind: kinds[Math.floor(Math.random() * kinds.length)], phase: 'warn', t0: now, t1: now + WARN_TIME * 1000 } });
  } else if (w.phase === 'warn' && now >= w.t1) {
    emit({ type: 'weather', w: { phase: 'active', t0: now, t1: now + DISASTER_TIME * 1000 } });
    if (w.kind === 'drought') emit({ type: 'dry' });
  } else if (w.phase === 'active') {
    if (now >= w.t1) {
      const gap = DISASTER_GAP[0] + Math.random() * (DISASTER_GAP[1] - DISASTER_GAP[0]);
      emit({ type: 'weather', w: { kind: null, phase: 'calm', t0: now, t1: 0, next: now + gap * 1000 } });
    } else if (w.kind !== 'drought' && every('hit', { lightning: 4000, acid: 2500, storm: 2000, flood: 1500 }[w.kind])) {
      const crops = [];
      s.tiles.forEach((t, k) => {
        const i = k % GRID, j = Math.floor(k / GRID);
        if (t.c && (w.kind !== 'flood' || isLow(i, j))) crops.push([i, j]);
      });
      if (w.kind === 'lightning') {
        const blds = Object.values(s.buildings).filter(b => !BUILDINGS[b.type].fixed || b.type === 'barn');
        const roll = Math.random();
        if (roll < 0.25 && blds.length) {
          const b = blds[Math.floor(Math.random() * blds.length)];
          const rod = Object.values(s.buildings).find(r => r.type === 'lightning_rod' && near(r, b.i, b.j, 3));
          emit({ type: 'strike', bid: (rod || b).id });
        } else if (crops.length) {
          const [i, j] = crops[Math.floor(Math.random() * crops.length)];
          const rod = Object.values(s.buildings).find(r => r.type === 'lightning_rod' && near(r, i, j, 3));
          if (rod) emit({ type: 'strike', bid: rod.id });
          else if (!shielded(s, i, j, 'lightning', now)) emit({ type: 'strike', i, j });
        }
      } else if (crops.length) {
        const [i, j] = crops[Math.floor(Math.random() * crops.length)];
        emit({ type: 'damage', kind: w.kind, i, j });
      }
    }
  }
}

// offline catch-up: run the automation for the time nobody was playing
export function catchUp(s, now) {
  const from = Math.max(s.saved || now, now - MAX_OFFLINE * 1000);
  const local = a => apply(s, resolve(s, a, a.now ?? t));
  let t = from;
  for (; t < now; t += 10e3) tick(s, t, local, true);
  tick(s, now, local, true);
  // weather/crows that were mid-flight when the game closed are dropped, not replayed
  if (s.weather.phase !== 'calm') Object.assign(s.weather, { kind: null, phase: 'calm', next: now + DISASTER_GAP[0] * 1000 });
  s.crows = [];
}

export function serialize(s, now = Date.now()) {
  s.saved = now;
  return JSON.stringify(s);
}
export function deserialize(json) {
  const s = typeof json === 'string' ? JSON.parse(json) : json;
  if (!s.crops) s.crops = CROP_LIST.filter(c => s.lv >= TIER_LEVEL[c.tier]).map(c => c.id);   // saves from before crop unlocks
  dirty.all = true; dirty.ui = true;
  return s;
}
export const levelProgress = s => s.xp / xpFor(s.lv);
