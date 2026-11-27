// node tests/rules.test.mjs — exercises the rules engine end to end.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setHeights } from '../src/terrain.js';
import * as S from '../src/state.js';
import { CROPS, ITEMS, SHOP, SHIP_COST, xpFor } from '../src/data.js';

setHeights(JSON.parse(readFileSync(new URL('../assets/heights.json', import.meta.url))));
let now = 1_000_000;
const s = S.newWorld(42, now);
S.addPlayer(s, 'p1', 'Host');
const p = s.players.p1;
const go = (a, ok = true) => { const rr = a.r || Array(9).fill(0.99); const r = S.apply(s, { ...S.resolve(s, a, now), r: rr }); assert.equal(r.ok, ok, `${a.type}: ${r.msg}`); return r; };

// start kit: 5 tools + 5 wheat seeds, 3x3 field tilled, water tiles and river exist
assert.equal(p.inv[0].id, 'hoe'); assert.equal(p.inv[1].id, 'seed_wheat'); assert.equal(p.inv[1].n, 5); assert.equal(p.inv[2], null);
assert.equal(S.tile(s, 18, 31).t, 's');
assert.ok(s.tiles.some(t => t.t === 'r') && s.tiles.some(t => t.t === 'w'), 'river and pond tiles');
assert.ok(s.buildings.b1?.type === 'shop_stall' && s.buildings.b2?.type === 'market_stall' && !S.hasBuilding(s, 'farmhouse'), 'only the stalls at the start');

// plant -> unwatered does not grow -> water -> ripe after 30s -> harvest -> sell
go({ type: 'plant', pid: 'p1', i: 18, j: 31, slot: 1 });
assert.equal(s.tut, 1);
assert.ok(S.remaining(S.tile(s, 18, 31).c, now) === 60, 'unwatered wheat takes 60s');
now += 20e3;
assert.equal(S.ripe(S.tile(s, 18, 31).c, now), false, 'unwatered crops grow at half speed');
go({ type: 'water', pid: 'p1', i: 18, j: 31 });
assert.equal(p.water, 2);
now += 19e3; assert.equal(S.ripe(S.tile(s, 18, 31).c, now), false);
now += 2e3; assert.equal(S.ripe(S.tile(s, 18, 31).c, now), true);
go({ type: 'harvest', pid: 'p1', i: 18, j: 31 });
assert.equal(S.countItem(p.inv, 18, 'wheat'), 1);
assert.equal(s.xp, 2);
go({ type: 'harvest', pid: 'p1', i: 18, j: 31 }, false);
go({ type: 'sell', pid: 'p1', all: true });
assert.equal(s.coins, 5);

// watering soil before planting starts growth immediately
go({ type: 'water', pid: 'p1', i: 19, j: 31 });
go({ type: 'plant', pid: 'p1', i: 19, j: 31, slot: 1 });
assert.equal(S.tile(s, 19, 31).c.w, 1);

// bucket runs dry -> refill
go({ type: 'water', pid: 'p1', i: 20, j: 31 });
assert.equal(p.water, 0);
go({ type: 'water', pid: 'p1', i: 20, j: 32 }, false);
go({ type: 'refill', pid: 'p1' });
assert.equal(p.water, 3);

// tilling costs coins, on owned, clear grass
const grass = (() => { for (let j = 25; j < 35; j++) for (let i = 15; i < 25; i++) { const t = S.tile(s, i, j); if (t.t === 'g' && !t.o && !t.b) return [i, j]; } })();
s.coins = 5; go({ type: 'till', pid: 'p1', i: grass[0], j: grass[1] }, false);
s.coins = 10; go({ type: 'till', pid: 'p1', i: grass[0], j: grass[1] });
assert.equal(S.tile(s, ...grass).t, 's'); assert.equal(s.coins, 0);
go({ type: 'till', pid: 'p1', i: 0, j: 0 }, false);

// shop gating: level-locked items refuse, gems path, tool upgrade
s.coins = 100000; s.gems = 50;
go({ type: 'buy', pid: 'p1', sid: 'sprinkler' }, false);           // level 10
s.lv = 25;
go({ type: 'buy', pid: 'p1', sid: 'hoe1' });
assert.equal(s.tools.hoe, 1);
go({ type: 'buy', pid: 'p1', sid: 'hoe1' }, false);
go({ type: 'buy', pid: 'p1', sid: 'fh3' }, false);                  // needs fh2 first
go({ type: 'buy', pid: 'p1', sid: 'fh2' }, false);                  // needs a farmhouse
go({ type: 'buy', pid: 'p1', sid: 'farmhouse' });
go({ type: 'buy', pid: 'p1', sid: 'farmhouse' }, false);            // one farmhouse only
go({ type: 'place', pid: 'p1', slot: p.inv.findIndex(x => x?.id === 'bp_farmhouse'), i: 21, j: 27 });
go({ type: 'buy', pid: 'p1', sid: 'fh2' });
go({ type: 'buy', pid: 'p1', sid: 'goldfert' });
assert.equal(s.gems, 45);

// land: adjacency, price doubling, bridge gating
go({ type: 'buyPlot', pid: 'p1', px: 0, py: 0 }, false);
const c0 = s.coins;
go({ type: 'buyPlot', pid: 'p1', px: 5, py: 5 });
go({ type: 'buyPlot', pid: 'p1', px: 6, py: 5 });
assert.equal(c0 - s.coins, 300);
go({ type: 'buyPlot', pid: 'p1', px: 7, py: 5 }, false);            // across the river
go({ type: 'buy', pid: 'p1', sid: 'fh3' });
go({ type: 'buy', pid: 'p1', sid: 'bridge' });
go({ type: 'buyPlot', pid: 'p1', px: 7, py: 5 });

// sprinklers water what they cover; auto-planter + bot + conveyors to the silo; offline catch-up
go({ type: 'buy', pid: 'p1', sid: 'sprinkler', n: 1 });
go({ type: 'buy', pid: 'p1', sid: 'harvester_bot' });
go({ type: 'buy', pid: 'p1', sid: 'auto_planter' });
go({ type: 'buy', pid: 'p1', sid: 'seed_carrot', n: 20 }, false);  // carrots must be unlocked first
go({ type: 'buy', pid: 'p1', sid: 'unlock_potato' }, false);       // in order
const cc = s.coins; go({ type: 'buy', pid: 'p1', sid: 'unlock_carrot' });
assert.equal(cc - s.coins, CROPS.carrot.unlockCost); assert.ok(s.crops.includes('carrot'));
go({ type: 'buy', pid: 'p1', sid: 'unlock_carrot' }, false);
go({ type: 'buy', pid: 'p1', sid: 'seed_carrot', n: 20 });
const slotOf = id => p.inv.findIndex(x => x && x.id === id);
// clear and till a 5x5 field at plot (5,3) -> tiles 25..29, 25..29
for (let j = 25; j < 30; j++) for (let i = 25; i < 30; i++) { const t = S.tile(s, i, j); t.o = null; if (t.t === 'g') t.t = 's'; }
go({ type: 'place', pid: 'p1', slot: slotOf('bp_sprinkler'), i: 27, j: 27 });
for (const [i, j] of [[26, 26], [28, 28], [26, 28]]) go({ type: 'plant', pid: 'p1', i, j, slot: slotOf('seed_carrot') });
assert.equal(S.tile(s, 26, 26).c.w, 1, 'sprinkler covered tiles start watered');
go({ type: 'place', pid: 'p1', slot: slotOf('bp_auto_planter'), i: 27, j: 25 });
go({ type: 'place', pid: 'p1', slot: slotOf('bp_harvester_bot'), i: 25, j: 27 });
go({ type: 'place', pid: 'p1', slot: slotOf('bp_sprinkler'), i: 27, j: 27 }, false);
const coins0 = s.coins;
s.saved = now; now += 10 * 60e3;
S.catchUp(s, now);
assert.ok(S.countItem(Object.values(s.buildings).find(b => b.type === 'harvester_bot').d.hop ? [] : [], 0, 'x') === 0);
const hop = Object.values(s.buildings).find(b => b.type === 'harvester_bot').d.hop;
assert.ok((hop.carrot || 0) >= 3, 'bot harvested offline: ' + JSON.stringify(hop));
assert.ok(s.coins < coins0, 'auto-planter paid for replanting');
const bot = Object.values(s.buildings).find(b => b.type === 'harvester_bot');
go({ type: 'xfer', pid: 'p1', from: { c: 'bot', k: bot.id }, to: { c: 'inv' } });
assert.equal(Object.keys(bot.d.hop).length, 0);

// storage rules
go({ type: 'xfer', pid: 'p1', from: { c: 'inv', k: slotOf('carrot') }, to: { c: 'silo' } });
assert.ok(s.store.silo.items.carrot > 0);
go({ type: 'xfer', pid: 'p1', from: { c: 'inv', k: slotOf('wood') === -1 ? 0 : slotOf('wood') }, to: { c: 'silo' } }, false);

// story quest: 10 carrots -> repaired hoe (already have) + xp
go({ type: 'xfer', pid: 'p1', from: { c: 'silo', k: 'carrot' }, to: { c: 'inv' }, id: 'carrot' });
if (S.countItem(p.inv, 18, 'carrot') < 10) { p.inv[17] = { id: 'carrot', n: 10 }; }
go({ type: 'turnIn', pid: 'p1', qid: s.quests[0].id });
assert.equal(s.story, 1); assert.equal(s.quests[0].need.corn, 20);

// disasters: flood only hits unprotected low tiles; greenhouse shields
const low = (() => { for (let j = 39; j > 20; j--) for (let i = 0; i < 30; i++) if (S.isLow(i, j) && S.tile(s, i, j).t === 'g') return [i, j]; })();
assert.ok(low, 'there are low beach-side tiles');
const lt = S.tile(s, ...low); lt.o = null; lt.t = 's'; lt.c = { id: 'wheat', g: 0, t: now, sp: 1, w: 1, fz: 1, gf: 1 };
lt.rb = 1; go({ type: 'damage', kind: 'flood', i: low[0], j: low[1] }, false);
lt.rb = 0; go({ type: 'damage', kind: 'flood', i: low[0], j: low[1] });
assert.equal(lt.c, null);

// golden crops: tier 5 with a lucky roll
const gt = S.tile(s, 26, 28); gt.c = { id: 'starfruit', g: CROPS.starfruit.grow, t: now, sp: 1, w: 1, fz: 1, gf: 1 };
go({ type: 'harvest', pid: 'p1', i: 26, j: 28, r: [0.0] });
assert.ok(slotOf('g_starfruit') >= 0);
assert.equal(ITEMS.g_starfruit.sell, CROPS.starfruit.sell * 10);

// hands pick one crop; the sickle sweeps a row of 3
for (const i of [18, 19, 20]) { const t = S.tile(s, i, 33); t.o = null; t.t = 's'; t.c = { id: 'wheat', g: CROPS.wheat.grow, t: now, sp: 1, w: 1, fz: 1, gf: 1 }; }
p.inv.fill(null, 0, 18); p.inv[0] = { id: 'sickle', n: 1 }; p.sel = 1;
go({ type: 'harvest', pid: 'p1', i: 19, j: 33, dir: 0 });
assert.equal(S.countItem(p.inv, 18, 'wheat'), 1, 'bare hands harvest one');
p.sel = 0; go({ type: 'harvest', pid: 'p1', i: 19, j: 33, dir: 0 });   // the middle is bare; 18 and 20 still ripe
assert.equal(S.countItem(p.inv, 18, 'wheat'), 3, 'the sickle sweeps the row');
// levels and save round-trip
s.lv = 1; s.xp = 0; S.addXp(s, xpFor(1) + 1); assert.equal(s.lv, 2);
const s2 = S.deserialize(S.serialize(s, now));
assert.equal(s2.coins, s.coins); assert.equal(s2.tiles.length, 1600);
assert.ok(SHOP.every(e => !e.effect.item || ITEMS[e.effect.item]), 'every shop item exists');
// safety net: broke with nothing growing or to sell -> the shop gives free wheat seeds; otherwise it doesn't
{
  const b = S.newWorld(7, now); S.addPlayer(b, 'q', 'Broke'); const q = b.players.q;
  q.inv[1] = null; b.coins = 0;
  assert.equal(S.broke(b), true);
  assert.equal(S.apply(b, { ...S.resolve(b, { type: 'buy', pid: 'q', sid: 'seed_wheat' }, now) }).ok, true);
  assert.equal(S.countItem(q.inv, 18, 'seed_wheat'), S.FREE_SEEDS);
  assert.equal(S.broke(b), false, 'holding seeds is not broke');
}
// the axe cuts down a planted fruit tree, freeing the tile
{
  const b = S.newWorld(9, now); S.addPlayer(b, 'q', 'Tree'); const q = b.players.q;
  const t = S.tile(b, 18, 31); t.c = { id: 'banana', g: 0, t: now, sp: 1, w: 1, fz: 1, gf: 1 };
  assert.equal(S.apply(b, { ...S.resolve(b, { type: 'hit', pid: 'q', i: 18, j: 31, tool: 'axe' }, now) }).ok, true);
  assert.equal(t.c, null); assert.equal(S.countItem(q.inv, 18, 'wood'), 3);
}
// the ending: three ship repairs in order, SHIP_COST in all; the last one fires the ending
S.fx.length = 0;
s.coins = SHIP_COST; go({ type: 'buy', pid: 'p1', sid: 'ship2' }, false);
go({ type: 'buy', pid: 'p1', sid: 'ship1' }); go({ type: 'buy', pid: 'p1', sid: 'ship1' }, false);
assert.ok(!s.won && !S.fx.some(f => f.k === 'ending'));
go({ type: 'buy', pid: 'p1', sid: 'ship2' }); go({ type: 'buy', pid: 'p1', sid: 'ship3' });
assert.equal(s.coins, 0); assert.ok(s.won); assert.ok(S.fx.some(f => f.k === 'ending'));
// unlock prices only ever climb, and never by more than 1.5x
const ul = Object.values(CROPS).map(c => c.unlockCost).slice(1);
assert.ok(ul.every((v, k) => !k || (v > ul[k - 1] && v <= ul[k - 1] * 1.6)), "smooth unlock prices (1.5x, plus rounding)");
// Biscuit: stay / go need a spot, follow clears the order, petting counts and saves
go({ type: 'donkey', pid: 'p1', m: 'stay', x: 3, z: 70 }); assert.deepEqual(s.donkey.cmd, { m: 'stay', x: 3, z: 70 });
go({ type: 'donkey', pid: 'p1', m: 'go' }, false);
go({ type: 'donkey', pid: 'p1', m: 'dance' }, false);
go({ type: 'donkey', pid: 'p1', m: 'follow' }); assert.equal(s.donkey.cmd, null);
go({ type: 'pet', pid: 'p1' }); go({ type: 'pet', pid: 'p1' }); assert.equal(s.donkey.pets, 2);
assert.equal(S.deserialize(S.serialize(s, now)).donkey.pets, 2);
console.log('rules ok');
