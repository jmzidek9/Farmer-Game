// Every number in the plan lives here. Times in seconds, prices in coins.
export const TILE = 2, GRID = 40, ORIGIN = -40, ORIGIN_Z = 0, PLOT = 5, PLOTS = GRID / PLOT;   // grid x from ORIGIN, z from ORIGIN_Z (south rows reach the beach)
export const TILL_COST = 10;                    // coins to turn one grass tile into field soil
export const RIVER = [34, 35, 36];              // tile columns the river runs through
export const BRIDGE_COL = 6;                    // plots at or past column 7 need the bridge
export const START_PLOTS = [[3, 5], [4, 5], [3, 6], [4, 6]];   // where the grass meets the south beach
export const PIER = { x: -94, z: 12 };          // west beach, trader's pier end
export const DAY_LEN = 20 * 60;                 // one day/night cycle
export const MAX_OFFLINE = 8 * 3600;            // automation catch-up cap
// the final goal: repair the wreck in three steps and sail home (15, 20 and 25 min of late-game income for the speedrun bot)
export const SHIP_PARTS = [['Patch the hull', 'Fresh planks and pitch to make the wreck float again.', 2000000],
  ['Raise a new mast', 'A tall new mast and rigging.', 2800000],
  ['Hoist new sails', 'New canvas, and the ship is ready to sail home. Beats the game.', 3400000]];
export const SHIP_COST = SHIP_PARTS.reduce((a, p) => a + p[2], 0);

const RATE = [0, 6, 10, 15, 22, 35];
export const TIER_LEVEL = [0, 1, 5, 10, 15, 20];
// [id, name, tier, grow seconds, seed cost, sell price]
const CROP_ROWS = [
  ['wheat', 'Wheat', 1, 30, 2, 5], ['carrot', 'Carrot', 1, 45, 3, 8], ['potato', 'Potato', 1, 60, 3, 11],
  ['lettuce', 'Lettuce', 1, 60, 4, 13], ['radish', 'Radish', 1, 90, 5, 19], ['onion', 'Onion', 1, 120, 6, 25],
  ['corn', 'Corn', 2, 180, 15, 45], ['tomato', 'Tomato', 2, 240, 20, 60], ['beans', 'Beans', 2, 300, 25, 75],
  ['peppers', 'Peppers', 2, 360, 30, 90], ['cucumber', 'Cucumber', 2, 420, 35, 105], ['sugarcane', 'Sugarcane', 2, 480, 40, 120],
  ['pumpkin', 'Pumpkin', 3, 600, 75, 225], ['strawberry', 'Strawberry', 3, 720, 90, 270], ['watermelon', 'Watermelon', 3, 840, 105, 315],
  ['pineapple', 'Pineapple', 3, 900, 110, 335], ['rice', 'Rice', 3, 1080, 135, 405], ['cotton', 'Cotton', 3, 1200, 150, 450],
  // fruit trees: a cheap sapling, then fruit every cycle with no replanting; each one earns more than the last
  ['banana', 'Banana tree', 4, 1200, 300, 500], ['coconut', 'Coconut palm', 4, 1500, 400, 700], ['orange', 'Orange tree', 4, 1800, 500, 900],
  ['mango', 'Mango tree', 4, 1800, 550, 1000], ['apple', 'Apple tree', 4, 2100, 650, 1250], ['papaya', 'Papaya tree', 4, 2400, 800, 1500],
  ['cacao', 'Cacao', 5, 1200, 350, 2100], ['coffee', 'Coffee', 5, 1350, 400, 2400], ['vanilla', 'Vanilla', 5, 1500, 450, 2650],
  ['dragonfruit', 'Dragon fruit', 5, 1500, 450, 2700], ['starfruit', 'Starfruit', 5, 1650, 480, 2850], ['goldpineapple', 'Golden pineapple', 5, 1800, 520, 3150],
];
// Prices inflate as you go: from corn on, seed and sell prices both scale up (2x by the end of tier 2, ~4x for
// fruit trees, 6x for golden pineapple), so later seeds cost far more but every crop keeps its sell/seed ratio and
// stays worth planting. Unlock and ship prices follow the bigger income, so pacing holds. 'xp' keeps the old
// profit so levelling speed doesn't inflate too.
const INFL = k => (k < 6 ? 1 : 1 + 5 * Math.pow((k - 6) / (CROP_ROWS.length - 7), 1.3));
const seedNice = v => (v < 100 ? Math.round(v) : Math.round(v / 10 ** (Math.floor(Math.log10(v)) - 1)) * 10 ** (Math.floor(Math.log10(v)) - 1));
let lastSeed = 0;   // every seed costs at least 12% more than the one before (rare crops cost more than saplings)
export const CROPS = Object.fromEntries(CROP_ROWS.map(([id, name, tier, grow, seed0, sell0], k) => {
  const f = INFL(k), sell = seedNice(sell0 * f), seed = lastSeed = seedNice(Math.max(seed0 * f, lastSeed * 1.12));
  return [id, { id, name, tier, grow, seed, sell, xp: tier === 4 ? sell0 : sell0 - seed0, tree: tier === 4, rate: RATE[tier] }];
}));
// One-time coin price to unlock each crop after wheat, in order. It is what farming the previous crop earns in a
// target time: profit/min per tile x field size x 45% efficiency (walking, watering, replanting) x minutes, where the
// field grows ~4 tiles per unlock through tier 1, then fast once sprinklers and land arrive (40 -> 220 tiles, measured
// with tools/speedrun.mjs), and the target time grows steadily through the game. The upgrades you buy along the way
// (sprinklers, bigger tools, land) are what keep the longer waits from becoming a grind.
const nice = v => { const p = 10 ** Math.max(1, Math.floor(Math.log10(v)) - 1); return Math.round(v / p) * p; };
const FIELD = k => (k < 7 ? 9 + 4 * (k - 1) : Math.min(40 + 12 * (k - 7), 220));
// PACE: overall price level and how fast the wait between unlocks climbs, fitted by tools/calibrate.mjs so the
// speedrun bot waits ~4 min early on, rising steadily to ~21 min before the last crop (normal players ~1.5x).
export const PACE = { level: 0.667, climb: 0.0621, tier: [1.00, 0.83, 0.72, 0.84, 1.04] };
export function unlockCosts(level = PACE.level, climb = PACE.climb, tier = PACE.tier) {
  const out = {};
  let bestRate = 0, pc = 0;   // fruit trees are planted a few at a time, so their unlocks are paid for by the best field crop
  CROP_ROWS.forEach(([id], k) => {
    if (!k) return (out[id] = 0);
    const prev = CROPS[CROP_ROWS[k - 1][0]];
    if (!prev.tree) bestRate = Math.max(bestRate, (prev.sell - prev.seed) / (prev.grow / 60));
    const rate = prev.tree ? bestRate : (prev.sell - prev.seed) / (prev.grow / 60);
    const raw = rate * FIELD(k) * 0.45 * (3 + 0.62 * k) * level * Math.exp(climb * k) * tier[CROPS[id].tier - 1];
    // never cheaper than the last, never more than 1.5x it (a big jump means farming one crop far too long)
    out[id] = pc = nice(pc ? Math.min(Math.max(raw, pc * 1.08), pc * 1.5) : raw);
  });
  return out;
}
const UC = unlockCosts();
CROP_ROWS.forEach(([id], k) => { CROPS[id].unlockCost = UC[id]; if (k) CROPS[id].prev = CROP_ROWS[k - 1][0]; });
export const CROP_LIST = CROP_ROWS.map(r => CROPS[r[0]]);
export const GOLDEN_CHANCE = 0.04;              // rare (tier 5) crops only, worth 10x

// ---------------------------------------------------------------- items
// kind: tool | seed | crop | gold | good | res | boost | place
export const ITEMS = {};
const add = (id, o) => (ITEMS[id] = { id, stack: 99, sell: 0, ...o });
for (const t of ['hoe', 'bucket', 'sickle', 'axe', 'pickaxe'])
  add(t, { kind: 'tool', name: t[0].toUpperCase() + t.slice(1), model: 'tool_' + t, stack: 1 });
for (const c of CROP_LIST) {
  add('seed_' + c.id, { kind: 'seed', crop: c.id, name: c.tree ? c.name.replace(/ (tree|palm)$/, '') + ' sapling' : c.name + ' seeds',
    model: c.tree ? 'sapling' : 'seed_packet', sell: Math.floor(c.seed / 2) });
  add(c.id, { kind: 'crop', name: c.tree ? c.name.replace(/ (tree|palm)$/, '') : c.name, model: 'produce_' + c.id, sell: c.sell, tier: c.tier });
  if (c.tier === 5) add('g_' + c.id, { kind: 'gold', name: c.id === 'goldpineapple' ? 'Radiant golden pineapple' : 'Golden ' + c.name.toLowerCase(), model: 'produce_' + c.id, sell: c.sell * 10, tier: 5 });
}
add('wood', { kind: 'res', name: 'Wood', model: 'item_wood', sell: 2 });
add('stone', { kind: 'res', name: 'Stone', model: 'item_stone', sell: 3 });
add('fertilizer', { kind: 'boost', name: 'Fertilizer', model: 'tool_fertilizer', boost: 1.25 });
add('superfert', { kind: 'boost', name: 'Super fertilizer', model: 'tool_fertilizer', boost: 1.5 });
add('goldfert', { kind: 'boost', name: 'Golden fertilizer', model: 'tool_fertilizer', gold: 2 });

export const RECIPES = {
  bakery: [{ out: 'bread', in: { wheat: 10 }, time: 45 }],
  juicer: [{ out: 'juice', in: { orange: 2 }, time: 90 }, { out: 'juice', in: { mango: 2 }, time: 90 }, { out: 'juice', in: { apple: 2 }, time: 90 }],
  sugar_mill: [{ out: 'sugar', in: { sugarcane: 3 }, time: 60 }],
  loom: [{ out: 'cloth', in: { cotton: 3 }, time: 90 }],
  chocolate_maker: [{ out: 'chocolate', in: { cacao: 2, sugar: 1 }, time: 120 }],
  coffee_roaster: [{ out: 'roastcoffee', in: { coffee: 2 }, time: 120 }],
};
const GOODS = { bread: ['Bread', 130], juice: ['Fruit juice', 2400], sugar: ['Sugar', 800], cloth: ['Cloth', 3000], chocolate: ['Chocolate', 11000], roastcoffee: ['Roasted coffee', 10500] };
// goods scale with what their ingredients now sell for, so factories stay worth running
const inflOf = id => (CROPS[id] ? CROPS[id].sell / CROP_ROWS.find(r => r[0] === id)[5] : ITEMS[id]?.infl || 1);
for (const [id, [name, sell]] of Object.entries(GOODS)) {
  const r = Object.values(RECIPES).flat().find(x => x.out === id);
  const ins = Object.entries(r.in), f = ins.reduce((a, [i, q]) => a + inflOf(i) * q, 0) / ins.reduce((a, [, q]) => a + q, 0);
  add(id, { kind: 'good', name, model: 'good_' + id, sell: seedNice(sell * f), infl: f });
}

// ---------------------------------------------------------------- buildings
// size [w,h] in tiles. overlay: sits over field tiles. tilemod: changes the tile itself.
export const BUILDINGS = {
  farmhouse: { name: 'Farmhouse', size: [3, 3], model: 'farmhouse_1', unique: true },   // unique: bought once, placed by you
  barn: { name: 'Barn', size: [3, 3], model: 'barn', unique: true, store: 'barn' },
  silo: { name: 'Silo', size: [2, 2], model: 'silo', unique: true, store: 'silo' },
  market_stall: { name: 'Market stall', size: [2, 1], model: 'market_stall', fixed: true },
  shop_stall: { name: 'Shop', size: [2, 1], model: 'shop_stall', fixed: true },
  bridge: { name: 'Bridge', size: [3, 1], model: 'bridge', fixed: true },
  well: { name: 'Well', size: [1, 1], model: 'well', water: true },
  sprinkler: { name: 'Sprinkler', size: [1, 1], model: 'sprinkler', range: 1 },
  sprinkler_big: { name: 'Big sprinkler', size: [1, 1], model: 'sprinkler_big', range: 2 },
  scarecrow: { name: 'Scarecrow', size: [1, 1], model: 'scarecrow', guard: 2 },
  auto_planter: { name: 'Auto-planter', size: [1, 1], model: 'auto_planter', range: 1 },
  harvester_bot: { name: 'Harvester bot', size: [1, 1], model: 'bot_dock', range: 2 },
  conveyor: { name: 'Conveyor', size: [1, 1], model: 'conveyor' },
  auto_market: { name: 'Auto-market', size: [2, 2], model: 'auto_market' },
  rain_barrel: { name: 'Rain barrel', size: [1, 1], model: 'rain_barrel', water: true },
  crop_cover: { name: 'Crop cover', size: [3, 3], model: 'crop_cover', overlay: true, shield: ['acid'] },
  windbreak: { name: 'Windbreak hedge', size: [1, 1], model: 'windbreak', guard: 2, shield: ['storm'] },
  lightning_rod: { name: 'Lightning rod', size: [1, 1], model: 'lightning_rod', guard: 3, shield: ['lightning'] },
  raised_bed: { name: 'Raised bed', size: [1, 1], model: 'raised_bed', tilemod: 'raised' },
  fertile_soil: { name: 'Fertile soil', size: [1, 1], model: 'soil_fertile', tilemod: 'fert' },
  sea_wall: { name: 'Sea wall', size: [1, 1], model: 'sea_wall', guard: 4, shield: ['flood'] },
  greenhouse: { name: 'Greenhouse', size: [5, 5], model: 'greenhouse', overlay: true, shield: ['acid', 'storm', 'lightning', 'flood', 'drought'] },
  bakery: { name: 'Bakery', size: [2, 2], model: 'bakery', factory: true },
  juicer: { name: 'Juicer', size: [2, 2], model: 'juicer', factory: true },
  sugar_mill: { name: 'Sugar mill', size: [2, 2], model: 'sugar_mill', factory: true },
  loom: { name: 'Loom', size: [2, 2], model: 'loom', factory: true },
  chocolate_maker: { name: 'Chocolate maker', size: [2, 2], model: 'chocolate_maker', factory: true },
  coffee_roaster: { name: 'Coffee roaster', size: [2, 2], model: 'coffee_roaster', factory: true },
  fence: { name: 'Fence', size: [1, 1], model: 'fence' },
  path: { name: 'Path', size: [1, 1], model: 'path', walk: true },
  flowers: { name: 'Flowers', size: [1, 1], model: 'flowers', walk: true },
  statue: { name: 'Statue', size: [1, 1], model: 'statue', guard: 1, bonus: 0.02 },
};
for (const [id, b] of Object.entries(BUILDINGS)) if (!b.fixed) add('bp_' + id, { kind: 'place', name: b.name, model: b.model, building: id, stack: 20 });
export const STORE_CAP = [50, 100, 200, 500];
export const DONKEY_SLOTS = [9, 18, 45];
export const BACKPACK = [18, 27, 36];           // total slots incl. 9-slot hotbar

// ---------------------------------------------------------------- tools
export const TOOL_LV = {
  hoe: ['Broken hoe', 'Hoe', 'Iron hoe', 'Golden hoe'],
  bucket: ['Leaky bucket', 'Bucket', 'Bigger bucket'],
  sickle: ['Sickle', 'Iron sickle', 'Golden sickle'],
  axe: ['Axe', 'Iron axe'], pickaxe: ['Pickaxe', 'Iron pickaxe'], pouch: ['Seed pouch', 'Big seed pouch'],
};
export const BUCKET_CAP = [3, 8, 15];
export const HITS = [3, 1];                     // axe/pickaxe hits by level

// ---------------------------------------------------------------- shop
// effect: {tool:[name,lv]} {item} {fh:lv} {store:[name,lv]} {donkey:lv} {pack:lv} {credits:n} {bridge}
const S = (id, cat, name, desc, cost, unlock, effect, gems = 0) => ({ id, cat, name, desc, cost, gems, unlock, effect });
export const SHOP = [
  S('fertile_soil', 'Land & fields', 'Fertile soil', 'Tile grows 10% faster', 200, { lv: 8 }, { item: 'bp_fertile_soil' }),
  S('bridge', 'Land & fields', 'Bridge', 'Opens the land across the river', 5000, { fh: 3 }, { bridge: 1 }),
  S('bucket0', 'Tools', 'Leaky bucket', 'Waters soil so crops grow twice as fast, and puts out fires', 15, { lv: 1 }, { item: 'bucket' }),
  S('sickle0', 'Tools', 'Sickle', 'Harvests a row of 3 ripe crops at once', 10, { lv: 1 }, { item: 'sickle' }),
  S('axe0', 'Tools', 'Axe', 'Chops trees, bushes and stumps', 25, { lv: 1 }, { item: 'axe' }),
  S('pickaxe0', 'Tools', 'Pickaxe', 'Breaks rocks and digs out stumps', 25, { lv: 1 }, { item: 'pickaxe' }),
  S('hoe1', 'Tools', 'Repaired hoe', 'Fixes the broken starting hoe', 50, { lv: 2 }, { tool: ['hoe', 1] }),
  S('bucket1', 'Tools', 'Repaired bucket', 'Holds 8 waterings', 50, { lv: 2 }, { tool: ['bucket', 1] }),
  S('bucket2', 'Tools', 'Bigger bucket', 'Waters 3×3 and holds 15', 400, { lv: 5 }, { tool: ['bucket', 2] }),
  S('axe1', 'Tools', 'Iron axe', 'Clears trees and stumps in 1 hit', 800, { lv: 6 }, { tool: ['axe', 1] }),
  S('pickaxe1', 'Tools', 'Iron pickaxe', 'Clears rocks and stumps in 1 hit', 800, { lv: 6 }, { tool: ['pickaxe', 1] }),
  S('hoe2', 'Tools', 'Iron hoe', 'Tills a 1×3 row', 500, { lv: 7 }, { tool: ['hoe', 2] }),
  S('sickle1', 'Tools', 'Iron sickle', 'Harvests 3×3 at once', 600, { lv: 7 }, { tool: ['sickle', 1] }),
  S('pouch1', 'Tools', 'Seed pouch upgrade', 'Plants 3×3', 3000, { lv: 12 }, { tool: ['pouch', 1] }),
  S('hoe3', 'Tools', 'Golden hoe', 'Tills 3×3', 5000, { lv: 18 }, { tool: ['hoe', 3] }),
  S('sickle2', 'Tools', 'Golden sickle', 'Harvests 5×5 at once', 6000, { lv: 18 }, { tool: ['sickle', 2] }),
  S('pack1', 'Tools', 'Backpack upgrade', '+9 inventory slots', 1000, { lv: 4 }, { pack: 1 }),
  S('pack2', 'Tools', 'Big backpack', '+9 more inventory slots', 5000, { lv: 12 }, { pack: 2 }),
  S('fertilizer', 'Boosts', 'Fertilizer', 'Crop grows 25% faster', 20, { lv: 3 }, { item: 'fertilizer' }),
  S('superfert', 'Boosts', 'Super fertilizer', 'Crop grows 50% faster', 100, { lv: 10 }, { item: 'superfert' }),
  S('goldfert', 'Boosts', 'Golden fertilizer', 'Doubles the golden harvest chance', 0, { lv: 20 }, { item: 'goldfert' }, 5),
  S('well', 'Automation', 'Well', 'Refills buckets instantly', 200, { lv: 4 }, { item: 'bp_well' }),
  S('sprinkler', 'Automation', 'Sprinkler', 'Auto-waters a 3×3', 300, { lv: 10 }, { item: 'bp_sprinkler' }),
  S('scarecrow', 'Automation', 'Scarecrow', 'Keeps crows off a 5×5', 150, { lv: 10 }, { item: 'bp_scarecrow' }),
  S('auto_planter', 'Automation', 'Auto-planter', 'Replants the last seed on a 3×3', 1500, { lv: 12 }, { item: 'bp_auto_planter' }),
  S('sprinkler_big', 'Automation', 'Big sprinkler', 'Auto-waters a 5×5', 2000, { lv: 14 }, { item: 'bp_sprinkler_big' }),
  S('harvester_bot', 'Automation', 'Harvester bot', 'Collects ripe crops in a 5×5', 5000, { lv: 15 }, { item: 'bp_harvester_bot' }),
  S('conveyor', 'Automation', 'Conveyor', 'Carries a bot’s harvest to the silo', 50, { lv: 16 }, { item: 'bp_conveyor' }),
  S('bot1', 'Automation', 'Bot upgrade', 'Bots work 2× faster', 3000, { lv: 17 }, { botLv: 1 }),
  S('bot2', 'Automation', 'Bot range upgrade', 'Bots cover 7×7', 8000, { lv: 17 }, { botLv: 2 }),
  S('auto_market', 'Automation', 'Auto-market', 'Sells the silo at your set price while you’re away', 20000, { lv: 20 }, { item: 'bp_auto_market' }),
  S('rain_barrel', 'Disaster protection', 'Rain barrel', 'Stores water for droughts', 150, { lv: 3 }, { item: 'bp_rain_barrel' }),
  S('crop_cover', 'Disaster protection', 'Crop cover', 'Shields a 3×3 from acid rain', 250, { lv: 6 }, { item: 'bp_crop_cover' }),
  S('windbreak', 'Disaster protection', 'Windbreak hedge', 'Shields nearby crops from storm wind', 100, { lv: 6 }, { item: 'bp_windbreak' }),
  S('lightning_rod', 'Disaster protection', 'Lightning rod', 'Protects a 7×7 from lightning', 1000, { lv: 8 }, { item: 'bp_lightning_rod' }),
  S('raised_bed', 'Disaster protection', 'Raised bed', 'Tile can’t flood', 300, { lv: 9 }, { item: 'bp_raised_bed' }),
  S('sea_wall', 'Disaster protection', 'Sea wall', 'Stops high tide nearby', 2000, { lv: 12 }, { item: 'bp_sea_wall' }),
  S('greenhouse', 'Disaster protection', 'Greenhouse', 'Protects a 5×5 from all weather', 10000, { lv: 18 }, { item: 'bp_greenhouse' }),
  S('farmhouse', 'Buildings & storage', 'Farmhouse', 'Your home on the island. Upgrade it to build more', 250, { lv: 2 }, { item: 'bp_farmhouse' }),
  S('silo', 'Buildings & storage', 'Silo', 'Stores 50 crops', 300, { lv: 3 }, { item: 'bp_silo' }),
  S('barn', 'Buildings & storage', 'Barn', 'Stores 50 goods, wood, stone and seeds', 400, { lv: 4 }, { item: 'bp_barn' }),
  S('fh2', 'Buildings & storage', 'Farmhouse level 2', 'Raises the build cap', 500, { lv: 1 }, { fh: 2 }),
  S('fh3', 'Buildings & storage', 'Farmhouse level 3', 'Raises the build cap', 2500, { fh: 2 }, { fh: 3 }),
  S('fh4', 'Buildings & storage', 'Farmhouse level 4', 'Raises the build cap', 10000, { fh: 3 }, { fh: 4 }),
  S('fh5', 'Buildings & storage', 'Farmhouse level 5', 'Raises the build cap', 40000, { fh: 4 }, { fh: 5 }),
  S('barn1', 'Buildings & storage', 'Barn upgrade', 'Item storage 50 → 100', 300, { fh: 2 }, { store: ['barn', 1] }),
  S('barn2', 'Buildings & storage', 'Barn upgrade II', 'Item storage 100 → 200', 1500, { fh: 3 }, { store: ['barn', 2] }),
  S('barn3', 'Buildings & storage', 'Barn upgrade III', 'Item storage 200 → 500', 6000, { fh: 4 }, { store: ['barn', 3] }),
  S('silo1', 'Buildings & storage', 'Silo upgrade', 'Crop storage 50 → 100', 300, { fh: 2 }, { store: ['silo', 1] }),
  S('silo2', 'Buildings & storage', 'Silo upgrade II', 'Crop storage 100 → 200', 1500, { fh: 3 }, { store: ['silo', 2] }),
  S('silo3', 'Buildings & storage', 'Silo upgrade III', 'Crop storage 200 → 500', 6000, { fh: 4 }, { store: ['silo', 3] }),
  S('bakery', 'Buildings & storage', 'Bakery', 'Wheat → bread', 3000, { lv: 20 }, { item: 'bp_bakery' }),
  S('juicer', 'Buildings & storage', 'Juicer', 'Fruit → juice', 5000, { lv: 20 }, { item: 'bp_juicer' }),
  S('sugar_mill', 'Buildings & storage', 'Sugar mill', 'Sugarcane → sugar', 6000, { lv: 21 }, { item: 'bp_sugar_mill' }),
  S('loom', 'Buildings & storage', 'Loom', 'Cotton → cloth', 8000, { lv: 21 }, { item: 'bp_loom' }),
  S('chocolate_maker', 'Buildings & storage', 'Chocolate maker', 'Cacao + sugar → chocolate', 15000, { lv: 22 }, { item: 'bp_chocolate_maker' }),
  S('coffee_roaster', 'Buildings & storage', 'Coffee roaster', 'Coffee → roasted coffee', 15000, { lv: 22 }, { item: 'bp_coffee_roaster' }),
  S('saddle', 'Donkey', 'Saddle bags', 'Donkey carries 2× more', 500, { lv: 4 }, { donkey: 1 }),
  S('cart', 'Donkey', 'Cart', 'Donkey carries 5× more', 3000, { lv: 12 }, { donkey: 2 }),
  S('fence', 'Decorations', 'Fence', 'Looks', 5, { lv: 1 }, { item: 'bp_fence' }),
  S('path', 'Decorations', 'Path', 'Looks', 2, { lv: 1 }, { item: 'bp_path' }),
  S('flowers', 'Decorations', 'Flowers', 'Looks', 10, { lv: 1 }, { item: 'bp_flowers' }),
  S('statue', 'Decorations', 'Statue', '+2% yield on nearby tiles', 1000, { lv: 5 }, { item: 'bp_statue' }),
  // the ending: pay to make the wrecked ship seaworthy and sail home (you can keep farming afterwards)
  ...SHIP_PARTS.map(([name, desc, cost], k) => S('ship' + (k + 1), 'The ship', name, desc, cost, {}, { ship: k + 1 })),
];
for (const c of CROP_LIST)
  SHOP.push(S('seed_' + c.id, 'Seeds', ITEMS['seed_' + c.id].name, `Grows in ${fmtTime(c.grow)} · sells for ${c.sell}`, c.seed, {}, { item: 'seed_' + c.id }));
for (const c of CROP_LIST) if (c.unlockCost)
  SHOP.push(S('unlock_' + c.id, 'Seeds', `Unlock ${ITEMS['seed_' + c.id].name.toLowerCase()}`, `New crop: grows in ${fmtTime(c.grow)}, sells for ${c.sell}`, c.unlockCost, {}, { crop: c.id }));
export const SHOP_CATS = ['Seeds', 'The ship', 'Land & fields', 'Tools', 'Boosts', 'Automation', 'Disaster protection', 'Buildings & storage', 'Donkey', 'Decorations', 'Style'];
export const OUTFITS = [['#3a86c8', 'Lagoon', 0], ['#e8536b', 'Hibiscus', 10], ['#f2b33d', 'Mango', 10], ['#3f7d4a', 'Palm', 10], ['#f2ede2', 'Sail', 15], ['#4a2c6b', 'Night', 20]];
export const PLOT_BASE = 100;

// ---------------------------------------------------------------- levels
export const xpFor = lv => Math.round(30 * Math.pow(lv, 1.7));   // xp to go from lv to lv+1
export const xpForHarvest = (crop, item) => Math.max(1, Math.round(crop.xp * 0.6)) * (item.kind === 'gold' ? 3 : 1);
export const GEMS_PER_LEVEL = 3;

// ---------------------------------------------------------------- disasters
export const DISASTERS = {
  lightning: { name: 'Lightning storm', warn: 'Thunder is rolling in. Put out fires with your bucket.', minLv: 6 },
  acid: { name: 'Acid rain', warn: 'Green clouds are gathering. Cover your crops.', minLv: 6 },
  storm: { name: 'Tropical storm', warn: 'The wind is picking up. Crops without a windbreak will flatten.', minLv: 4 },
  drought: { name: 'Heatwave', warn: 'A heatwave is coming. Unwatered soil will dry out.', minLv: 3 },
  flood: { name: 'High tide', warn: 'The tide is rising. Low fields near the beach will flood.', minLv: 9 },
};
export const DISASTER_GAP = [8 * 60, 14 * 60];   // seconds between disasters
export const WARN_TIME = 40, DISASTER_TIME = 75;
export const TIDE_HIGH = 0.95;

// ---------------------------------------------------------------- quests (the trader)
export const STORY_QUESTS = [
  { need: { carrot: 10 }, reward: { tool: ['hoe', 1], xp: 20 }, text: 'Bring 10 carrots and I’ll fix that hoe for you.' },
  { need: { corn: 20 }, reward: { item: 'bp_sprinkler', n: 2, xp: 120 }, text: '20 corn buys you a pair of sprinklers.' },
  { need: { pumpkin: 5 }, reward: { plot: 1, xp: 300 }, text: '5 pumpkins and I’ll sign over a new field area.' },
  { need: { orange: 6 }, reward: { gems: 10, coins: 3000, xp: 600 }, text: 'Oranges for the crew — 6 of them.' },
];
export const TRADER_EVERY = 6 * 60;             // a new quest arrives with each boat

export function fmtTime(s) {
  s = Math.max(0, Math.ceil(s));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm' + (s % 60 ? ' ' + (s % 60) + 's' : '');
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}
export const fmtNum = n => Math.floor(n).toLocaleString('en-US');
