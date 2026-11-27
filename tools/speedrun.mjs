// node tools/speedrun.mjs [seed] — a greedy speedrunner bot plays the real rules engine (src/state.js) on a virtual
// clock, paying walking time with real map distances. Prints a milestone timeline and pacing stats.
// Normal players take roughly 2–2.5x the bot's time (they don't route perfectly, explore, decorate, read).
import { readFileSync, writeFileSync } from 'node:fs';
import { setHeights, tileX, tileZ } from '../src/terrain.js';
import * as S from '../src/state.js';
import { CROPS, CROP_LIST, ITEMS, SHOP, BUILDINGS, BUCKET_CAP, PLOTS, PLOT, GRID, xpFor, PIER, SHIP_COST } from '../src/data.js';

setHeights(JSON.parse(readFileSync(new URL('../assets/heights.json', import.meta.url))));
const SEED = +(process.argv[2] || 1);
// COSTS='{"carrot":90,…,"ship1":300000}' tries other prices without editing data.js (tools/calibrate.mjs uses it)
if (process.env.COSTS) for (const [id, v] of Object.entries(JSON.parse(process.env.COSTS))) {
  const e = SHOP.find(x => x.id === (id.startsWith('ship') ? id : 'unlock_' + id));
  if (e) e.cost = v;
  if (CROPS[id]) CROPS[id].unlockCost = v;
}
let rs = SEED * 9301 + 49297; Math.random = () => ((rs = (rs * 233280 + 49297) % 2147483647) / 2147483647);   // reproducible

const T0 = 1e12;
let now = T0;
const s = S.newWorld(SEED, now);
S.addPlayer(s, 'p', 'Runner');
const p = s.players.p;
const emit = a => S.apply(s, S.resolve(s, a, now));
const act = a => emit({ pid: 'p', ...a });

// ---------------------------------------------------------------- time model
const RUN = 7.5, CLICK = 0.4, STEP = 0.27;     // sprint m/s, seconds per click, seconds per tile walked between clicks
const pos = { x: tileX(19), z: tileZ(32) };
const stats = { walk: 0, work: 0, wait: 0 };
function advance(sec, kind) {
  stats[kind] += sec;
  const end = now + sec * 1000;
  while (now < end) { now = Math.min(end, now + 1000); S.tick(s, now, emit); S.fx.length = 0; }
}
function walkTo(x, z) { const d = Math.hypot(x - pos.x, z - pos.z); pos.x = x; pos.z = z; advance(d / RUN, 'walk'); }
const at = (i, j) => walkTo(tileX(i), tileZ(j));
const MARKET = [tileX(22), tileZ(36)], SHOPP = [tileX(16), tileZ(36)], TRADER = [PIER.x + 12, PIER.z];

// ---------------------------------------------------------------- helpers
const slotOf = id => p.inv.findIndex(x => x?.id === id);
const have = id => S.countItem(p.inv, S.invSize(s), id);
const tileAt = (i, j) => S.tile(s, i, j);
const log = [];
const t = () => ((now - T0) / 60000).toFixed(1);
const mark = msg => log.push(`${t().padStart(6)} min  lv${String(s.lv).padStart(2)}  ${String(Math.floor(s.coins)).padStart(8)}c  ${msg}`);
function buy(sid, n = 1) {
  const e = SHOP.find(x => x.id === sid);
  if (!e || !S.shopState(s, e).ok && !S.shopState(s, e).poor) return false;
  walkTo(...SHOPP);
  advance(CLICK * 2, 'work');
  const r = act({ type: 'buy', sid, n });
  if (r.ok && !sid.startsWith('seed_')) mark('bought ' + e.name);
  return r.ok;
}
function place(bp, cand) {
  const k = slotOf(bp);
  if (k < 0) return false;
  for (const [i, j] of cand) {
    if (S.canPlace(s, ITEMS[bp].building, i, j, 0)) continue;
    at(i, j); advance(CLICK, 'work');
    if (act({ type: 'place', slot: k, i, j, rot: 0 }).ok) return [i, j];
  }
  return false;
}

// field: owned tiles, nearest the market first. Sprinkler centres sit on a 3-tile lattice.
const lattice = (i, j) => i % 3 === 1 && j % 3 === 1;
function ownedTiles() {
  const out = [];
  for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) if (S.owned(s, i, j)) out.push([i, j]);
  return out.sort((a, b) => Math.hypot(tileX(a[0]) - MARKET[0], tileZ(a[1]) - MARKET[1]) - Math.hypot(tileX(b[0]) - MARKET[0], tileZ(b[1]) - MARKET[1]));
}
// field sweeps go row by row, snaking, the way a player walks a field
const soil = () => ownedTiles().filter(([i, j]) => tileAt(i, j).t === 's' && !tileAt(i, j).b)
  .sort((a, b) => b[1] - a[1] || (a[1] % 2 ? b[0] - a[0] : a[0] - b[0]));
let waterSpots = [];   // wells / rain barrels we placed
function waterTrip() {
  // nearest fresh water: wells, else the river bank / pond edge
  let best = null, bd = 1e9;
  const cands = [...waterSpots.map(([i, j]) => [tileX(i), tileZ(j)])];
  for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) { const tt = tileAt(i, j); if (tt.t === 'w' || tt.t === 'r') cands.push([tileX(i), tileZ(j)]); }
  for (const [x, z] of cands) { const d = Math.hypot(x - pos.x, z - pos.z); if (d < bd) { bd = d; best = [x, z]; } }
  walkTo(best[0], best[1] - 0); advance(CLICK, 'work');
  act({ type: 'refill' });
}

// ---------------------------------------------------------------- crop choice: coins per tile-minute, counting work
function cropValue(c, field) {
  const overhead = (CLICK + STEP) * 3 / Math.max(1, sickleN()) + 25 / Math.max(field, 1);   // plant+water+harvest clicks, market trip shared
  const grow = c.grow / (S.sprinklerCovered ? 1 : 1);
  return c.tree ? c.sell / (grow + overhead) - c.seed / 3600 : (c.sell - c.seed) / (grow + overhead);   // per second; saplings paid back over ~1 h
}
const treeTiles = () => soil().filter(([i, j]) => tileAt(i, j).c && CROPS[tileAt(i, j).c.id].tree).length;
const sickleN = () => (have('sickle') ? [3, 9, 25][s.tools.sickle] : 1);
const bestFieldValue = field => Math.max(...s.crops.filter(id => !CROPS[id].tree).map(id => cropValue(CROPS[id], field)));
function bestCrop(field, skip = new Set()) {
  let best = skip.has('wheat') ? null : CROPS.wheat, bv = -1;
  for (const id of s.crops) {
    const c = CROPS[id];
    if (skip.has(id)) continue;
    if (c.tree && treeTiles() >= field * 0.35) continue;   // orchards on up to a third of the field
    if (c.tree && c.sell / c.grow * 1.6 <= bestFieldValue(field)) continue;   // the orchard rule below would just cut it down
    const v = cropValue(c, field);
    if (v > bv && (s.coins >= c.seed * 3 || have('seed_' + id))) { bv = v; best = c; }
  }
  return best;
}

// ---------------------------------------------------------------- the run
const ms = new Set();
const once = (k, msg) => { if (!ms.has(k)) { ms.add(k); mark(msg); } };
let lastLv = 1, lastCrops = 1, sellTrips = 0, earned = 0, lastEarned = 0, lastUnlockAt = T0;
const unlocks = [];
const BOAT = +(process.env.BOAT || SHIP_COST);
const STOP = process.env.STOP;
const nextCropNow = () => CROP_LIST.find(c => !s.crops.includes(c.id));   // stop after unlocking this crop id
const LIMIT = +(process.env.LIMIT || 12) * 3600e3;

// DUMP=300:assets/trailer_farm.json saves the world at that minute (the trailer films a lived-in farm)
const [dumpMin, dumpPath] = (process.env.DUMP || '').split(':');
while (now - T0 < LIMIT) {
  if (dumpPath && now - T0 >= +dumpMin * 60000) { writeFileSync(dumpPath, S.serialize(s, now)); console.log('dumped', dumpPath); break; }
  // 1. harvest everything ripe
  for (const [i, j] of soil()) {
    const c = tileAt(i, j).c;
    if (!c || !S.ripe(c, now)) continue;
    const k = slotOf('sickle'); if (k >= 0) p.sel = k; else p.sel = 8;
    at(i, j); advance(CLICK, 'work');
    const r = act({ type: 'harvest', i, j, dir: 0 });
    if (!r.ok && /full/.test(r.msg || '')) break;
  }
  // 2. story quest turn-in
  const q = s.quests.find(x => x.story);
  if (q && Object.entries(q.need).every(([id, n]) => have(id) >= n)) {
    walkTo(...TRADER); advance(CLICK * 3, 'work');
    if (act({ type: 'turnIn', qid: q.id }).ok) mark('story quest done: ' + Object.keys(q.need).join(','));
  }
  // 3. sell (keep story-quest crops)
  const keep = q && s.coins >= 20 ? q.need : {};   // too broke to replant: sell the quest crops too
  if (p.inv.some(x => x && ['crop', 'gold', 'res'].includes(ITEMS[x.id].kind) && !keep[x.id])) {
    walkTo(...MARKET); advance(CLICK, 'work');
    const c0 = s.coins;
    for (let k = 0; k < S.invSize(s); k++) { const x = p.inv[k]; if (x && ['crop', 'gold', 'res'].includes(ITEMS[x.id].kind) && !(keep[x.id] && x.n <= keep[x.id] + 0)) act({ type: 'sell', slot: k }); }
    earned += s.coins - c0;
    sellTrips++;
  }
  if (BOAT === SHIP_COST && !nextCropNow()) while (!s.won && S.shopState(s, SHOP.find(e => e.id === 'ship' + ((s.ship || 0) + 1))).ok) { buy('ship' + ((s.ship || 0) + 1)); unlocks.push(['ship' + s.ship, (now - T0) / 60000]); }
  if (BOAT && (s.won || (BOAT !== SHIP_COST && s.coins >= BOAT))) { mark(`BOAT REPAIRED — game beaten (${((now - T0) / 60000 - (unlocks.filter(u => !u[0].startsWith("ship")).at(-1)?.[1] || 0)).toFixed(0)} min after the last crop)`); break; }
  if (STOP && s.crops.includes(STOP)) break;

  // 4. shopping, in a speedrunner's priority order
  const field = soil().length;
  const nextCrop = CROP_LIST.find(c => !s.crops.includes(c.id));
  const saving = !nextCrop && BOAT;   // every crop unlocked: save everything for the boat
  const want = [];
  if (saving) { /* nothing */ } else {
  if (!have('sickle')) want.push('sickle0');
  if (!have('bucket')) want.push('bucket0');
  want.push('bucket1', 'hoe1');
  if (s.lv >= 2 && !S.hasBuilding(s, 'farmhouse') && !have('bp_farmhouse')) want.push('farmhouse');
  want.push('bucket2', 'sickle1', 'hoe2', 'pack1');
  if (s.lv >= 4 && waterSpots.length < 1) want.push('well');
  if (s.lv >= 10 && Object.values(s.buildings).filter(b => b.type === 'sprinkler').length + have('bp_sprinkler') < Math.floor(field / 9)) want.push('sprinkler');
  want.push('fh2', 'pouch1', 'sickle2', 'hoe3', 'fh3', 'bridge', 'fh4');
  for (const sid of want) {
    const e = SHOP.find(x => x.id === sid);
    if (!e) continue;
    const st = S.shopState(s, e);
    // like a player, split the money: essentials at once, other upgrades only while still saving toward the next crop
    const reserve = ['sickle0', 'bucket0', 'bucket1'].includes(sid) || !nextCrop ? 30 : nextCrop.unlockCost;
    if (st.ok && s.coins - e.cost >= reserve && !(sid === 'hoe1' && s.story === 0)) buy(sid);   // the carrot quest repairs the hoe for free
  }
  }
  // unlock the next crop once it pays: keep a seed budget for a full replant
  if (nextCrop && s.coins >= nextCrop.unlockCost + (nextCrop.tree ? 0 : nextCrop.seed * Math.min(field, 20)) + 20 && buy('unlock_' + nextCrop.id)) {
    mark(`UNLOCK ${nextCrop.name} (cost ${nextCrop.unlockCost}, field ${field}, earning ${Math.round((earned - lastEarned) / ((now - lastUnlockAt) / 60000))}/min since last)`);
    unlocks.push([nextCrop.id, (now - T0) / 60000]); lastEarned = earned; lastUnlockAt = now;
  }
  // place blueprints
  if (have('bp_farmhouse')) { const spot = place('bp_farmhouse', ownedTiles().filter(([i, j]) => j < 28).reverse()); if (spot) mark('farmhouse placed'); }
  if (have('bp_well')) { const spot = place('bp_well', ownedTiles().filter(([i, j]) => tileAt(i, j).t === 'g' && !tileAt(i, j).o)); if (spot) { waterSpots.push(spot); mark('well placed'); } }
  if (have('bp_sprinkler')) place('bp_sprinkler', ownedTiles().filter(([i, j]) => lattice(i, j) && !tileAt(i, j).c));
  // land: buy the cheapest adjacent plot when it's affordable
  if (!saving && (s.lv >= 5 || s.freePlots)) {
    for (let py = PLOTS - 1; py >= 0; py--) for (let px = 0; px < PLOTS; px++) {
      const st = S.plotState(s, px, py);
      if (st.ok && (st.free || s.coins > st.price * 3 + (nextCrop ? nextCrop.unlockCost * 0.6 : 0))) { walkTo(tileX(px * PLOT + 2), tileZ(py * PLOT + 2)); advance(CLICK * 2, 'work'); if (act({ type: 'buyPlot', px, py }).ok) mark(`plot ${px},${py}` + (st.free ? ' (free)' : ` for ${st.price}`)); }
    }
  }
  // till more field when the crop pays for the tiles (cap by what the bot can manage)
  const manage = 9 + 6 * s.tools.sickle + 6 * s.tools.bucket + 12 * s.tools.pouch + Object.values(s.buildings).filter(b => b.type.startsWith('sprinkler')).length * 8 + 4 * s.crops.length;
  if (field < manage) {
    let n = Math.min(manage - field, Math.floor((s.coins - 40) / 10));
    for (const [i, j] of ownedTiles()) {
      if (n <= 0) break;
      const tt = tileAt(i, j);
      if (tt.t !== 'g' || tt.b || (lattice(i, j) && s.lv >= 9)) continue;
      if (tt.o) {   // clear it
        const tool = tt.o.k === 'rock' ? 'pickaxe' : 'axe';
        if (!have(tool)) { if (s.coins > 60) buy(tool + '0'); else continue; }
        at(i, j);
        for (let h = 0; h < 4 && tt.o; h++) { advance(CLICK, 'work'); act({ type: 'hit', i, j, tool }); }
        if (tt.o?.k === 'stump') for (let h = 0; h < 4 && tt.o; h++) { advance(CLICK, 'work'); act({ type: 'hit', i, j, tool: 'axe' }); }
        if (tt.o) continue;
      }
      at(i, j); advance(CLICK, 'work');
      if (act({ type: 'till', i, j, dir: 0 }).ok) n -= s.tools.hoe === 2 ? 3 : 1;
    }
  }

  // 5. plant every empty soil tile with the best crop we can afford
  let empties = soil().filter(([i, j]) => !tileAt(i, j).c);
  // story quest trees: plant the orange trees it asks for once (they keep fruiting)
  if (q?.need.orange && s.crops.includes('orange') && !ms.has('oranges') && empties.length >= 6 && s.coins >= CROPS.orange.seed * 6) {
    if (buy('seed_orange', 6)) {
      const k = slotOf('seed_orange');
      for (const [i, j] of empties.slice(0, 6)) { at(i, j); advance(CLICK, 'work'); act({ type: 'plant', slot: k, i, j }); }
      once('oranges', 'planted 6 orange trees for the quest');
      empties = empties.slice(6);
    }
  }
  // orchards make way once a field crop earns far more than the trees do
  const bestField = bestFieldValue(soil().length);
  for (const [i, j] of soil()) {
    const c = tileAt(i, j).c;
    if (!c || !CROPS[c.id].tree || CROPS[c.id].sell / CROPS[c.id].grow * 1.6 > bestField) continue;
    if (!have('axe')) { if (!buy('axe0')) break; }
    at(i, j); advance(CLICK, 'work');
    act({ type: 'hit', i, j, tool: 'axe' });
  }
  // fill the field: best crop we can afford first, then cheaper ones for the tiles left over (never leave soil idle)
  const tried = new Set();
  for (let pass = 0; pass < 6; pass++) {
    const left = soil().filter(([i, j]) => !tileAt(i, j).c);
    if (!left.length) break;
    const c = bestCrop(soil().length, tried);
    if (!c) break;
    tried.add(c.id);
    const need = left.length - have('seed_' + c.id);
    if (need > 0 && s.coins >= c.seed) buy('seed_' + c.id, Math.min(99, need, Math.floor(s.coins / c.seed)));
    else if (need > 0 && c.id === 'wheat') buy('seed_wheat');   // broke: the free-seed safety net
    const k = slotOf('seed_' + c.id);
    for (const [i, j] of left) {
      if (k < 0 || !p.inv[k]) break;
      at(i, j); advance(CLICK, 'work');
      act({ type: 'plant', slot: k, i, j, dir: 0 });
    }
  }
  // 6. water what isn't watered
  if (have('bucket')) {
    for (const [i, j] of soil()) {
      const tt = tileAt(i, j);
      if (!tt.c || tt.c.w || S.ripe(tt.c, now)) continue;
      if (p.water <= 0) waterTrip();
      at(i, j); advance(CLICK, 'work');
      act({ type: 'water', i, j, dir: 0 });
    }
  }
  // 7. wait for the next crop
  let next = Infinity;
  for (const [i, j] of soil()) { const c = tileAt(i, j).c; if (c) next = Math.min(next, S.remaining(c, now)); }
  if (next === Infinity) next = 5;
  advance(Math.max(1, Math.min(next, 120)), 'wait');

  if (s.lv !== lastLv) { lastLv = s.lv; if (s.lv % 2 === 0 || s.lv < 6) mark('level ' + s.lv); }
  if (s.tut >= 5) once('tut', 'tutorial finished');
}

const tot = stats.walk + stats.work + stats.wait;
if (process.env.JSON) { console.log('RESULT ' + JSON.stringify(unlocks)); process.exit(0); }
console.log(log.join('\n'));
console.log(`\nend: ${t()} min, lv ${s.lv}, coins ${Math.floor(s.coins)}, crops ${s.crops.length}/${CROP_LIST.length}, field ${soil().length} tiles, plots ${s.plots.filter(Boolean).length}, fh ${s.fh}`);
console.log(`time: walking ${(100 * stats.walk / tot).toFixed(0)}%, working ${(100 * stats.work / tot).toFixed(0)}%, waiting ${(100 * stats.wait / tot).toFixed(0)}%   sell trips ${sellTrips}`);
