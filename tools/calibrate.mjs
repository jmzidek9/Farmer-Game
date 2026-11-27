// node tools/calibrate.mjs — fits PACE (price level + climb) and the ship repair prices in src/data.js so the speedrun
// bot's wait between unlocks follows a gently rising curve. Only two numbers are fitted for the crops, so prices stay
// a smooth curve; single crops wobble with harvest timing and storms, the trend is what's fitted.
// The bot spends on upgrades (sprinklers, tools, land) as it goes, so the curve already includes their speed-up.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CROP_LIST, SHIP_PARTS, PACE, unlockCosts } from '../src/data.js';

const SEEDS = [1, 2, 3, 4, 5, 6], ROUNDS = +(process.env.ROUNDS || 5);
const crops = CROP_LIST.slice(1).map(c => c.id), ships = SHIP_PARTS.map((_, k) => 'ship' + (k + 1));
// target wait in bot minutes: ~8 for the first unlock (it includes buying the first tools), then 3 + 0.62 per crop
// (~4 min early, ~21 min before the last crop), then 15 / 20 / 25 for the ship. Normal players take ~1.5x.
const target = k => (k === 0 ? 8 : 3 + 0.62 * (k + 1));
const shipTarget = [15, 20, 25];
let { level, climb } = PACE, tier = [...PACE.tier], ship = SHIP_PARTS.map(p => p[2]);

const run = (seed, costs) => new Promise((ok, no) => execFile(process.execPath, [fileURLToPath(new URL('./speedrun.mjs', import.meta.url)), String(seed)],
  { env: { ...process.env, JSON: '1', COSTS: JSON.stringify(costs) }, maxBuffer: 1 << 24 },
  (e, out) => (e ? no(e) : ok(JSON.parse(out.split('\n').find(l => l.startsWith('RESULT ')).slice(7))))));
const nice = v => { const p = 10 ** Math.max(1, Math.floor(Math.log10(v)) - 1); return Math.round(v / p) * p; };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

for (let r = 0; r <= ROUNDS; r++) {
  const costs = { ...unlockCosts(level, climb, tier), ...Object.fromEntries(ships.map((id, k) => [id, ship[k]])) };
  const runs = await Promise.all(SEEDS.map(sd => run(sd, costs)));
  const gap = id => mean(runs.map(u => { const k = u.findIndex(x => x[0] === id); return k < 0 ? 999 : u[k][1] - (k ? u[k - 1][1] : 0); }));
  const g = crops.map(gap), gs = ships.map(gap);
  // fit log(target/gap) = a + b*k by least squares: a moves the price level, b how fast it climbs
  const res = g.map((v, k) => Math.log(target(k) / v)), ks = res.map((_, k) => k);
  const km = mean(ks), rm = mean(res);
  const b = ks.reduce((acc, k) => acc + (k - km) * (res[k] - rm), 0) / ks.reduce((acc, k) => acc + (k - km) ** 2, 0), a = rm - b * km;
  const trend = g.map((_, k) => mean(g.slice(Math.max(0, k - 1), k + 2)));   // 3-crop average shows the trend
  console.log(`round ${r}: level ${level.toFixed(3)} climb ${climb.toFixed(4)} tiers ${tier.map(v => v.toFixed(2)).join(',')} | trend ` + [0, 5, 11, 17, 23, 27].map(k => `${crops[k]} ${trend[k].toFixed(0)}/${target(k).toFixed(0)}`).join('  ') +
    ` | ship ${gs.map(v => v.toFixed(0)).join('/')} | total ${mean(runs.map(u => u.at(-1)[1])).toFixed(0)} min`);
  if (r === ROUNDS) break;
  level *= Math.exp(a * 0.8); climb += b * 0.8;
  // then each tier's leftover error moves that tier's prices (tier 1 is the anchor)
  const tierOf = k => CROP_LIST[k + 1].tier - 1;
  for (let t = 1; t < 5; t++) {
    const ix = res.map((_, k) => k).filter(k => tierOf(k) === t);
    tier[t] *= Math.exp(0.6 * mean(ix.map(k => res[k] - (a + b * k))));
  }
  ship = ship.map((c, k) => nice(c * Math.min(1.6, Math.max(0.6, shipTarget[k] / gs[k])) ** 0.8));
}
console.log(`\nexport const PACE = { level: ${level.toFixed(3)}, climb: ${climb.toFixed(4)}, tier: [${tier.map(v => v.toFixed(2)).join(', ')}] };\nship: ${ship.join(', ')}`);
