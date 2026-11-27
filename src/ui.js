// Harvest Haven UI: HUD, hotbar, panels, title, loading, toasts and banners. DOM only — icons are
// 3D thumbnails of the Blender models (assets.thumbnail); no three.js here.
import {
  ITEMS, CROPS, SHOP, SHOP_CATS, SHIP_COST, SHIP_PARTS, OUTFITS, RECIPES, BUILDINGS, DISASTERS, TOOL_LV, BUCKET_CAP,
  GEMS_PER_LEVEL, TIER_LEVEL, PLOT, PLOTS, fmtTime, fmtNum, xpFor,
} from './data.js';
import {
  dirty, invSize, donkeySize, storeCap, storeCount, plotState, shopState, countItem,
  connectedToSilo, levelProgress, tile,
} from './state.js';
import { thumbnail } from './assets.js';

// ---------------------------------------------------------------- constants
const SELLABLE = ['crop', 'gold', 'good', 'res'];                 // what "Sell all" sells (state.js A.sell)
const SLOT_PANELS = new Set(['inventory', 'donkey', 'storage', 'bot']);
const E_CLOSES = new Set(['inventory', 'donkey', 'storage', 'bot', 'shop', 'sell', 'factory', 'market', 'quests', 'plot']);
const STATIC = new Set(['settings', 'pause']);                      // never re-rendered by state changes
const LIVE = new Set(['factory', 'multiplayer']);                   // re-rendered once a second
const METAL = { broken: '#8a6a52', normal: '#9aa3ab', iron: '#c9d2d8', golden: '#f2c94c' };
const TOOL_METAL = {
  hoe: ['broken', 'normal', 'iron', 'golden'], bucket: ['broken', 'normal', 'iron'], sickle: ['normal', 'iron', 'golden'],
  axe: ['normal', 'iron'], pickaxe: ['normal', 'iron'], pouch: ['normal', 'golden'],
};
// seed packet recolour per crop (material `tint`)
const CROP_TINT = {
  wheat: '#e3c15a', carrot: '#f08a2c', potato: '#b88a5a', lettuce: '#8cc84b', radish: '#d9466a', onion: '#c99a6b',
  corn: '#f2cf3d', tomato: '#e2452f', beans: '#5aa344', peppers: '#d8342c', cucumber: '#3f8f3a', sugarcane: '#a9c86a',
  pumpkin: '#ef8a24', strawberry: '#e0344b', watermelon: '#3f9a4a', pineapple: '#e9b739', rice: '#e9e1c3', cotton: '#f1eee8',
  cacao: '#7b4a2c', coffee: '#6b3b22', vanilla: '#efe2b0', dragonfruit: '#e2468f', starfruit: '#f2d23d', goldpineapple: '#f2c94c',
};
const TOOL_HELP = {
  hoe: 'Turns grass inside your land into field soil', bucket: 'Waters soil and puts out fires',
  sickle: 'Harvests several ripe crops at once', axe: 'Chops trees and stumps', pickaxe: 'Breaks rocks and stumps',
};
// player.target.action -> [key, verb, crosshair shape]
const ACTIONS = {
  till: ['Click', 'Till', 'tile'], plant: ['Click', 'Plant', 'tile'], fertilize: ['Click', 'Fertilize', 'tile'],
  water: ['Click', 'Water', 'drop'], refill: ['Click', 'Fill bucket', 'drop'],
  harvest: ['Click', 'Harvest', 'reap'], scare: ['Click', 'Shoo it away', 'reap'],
  hit: ['Click', 'Clear', 'hit'], speedup: ['Click', 'Speed up', 'tile'],
  place: ['Click', 'Build', 'build'], pickup: ['Click', 'Pick up', 'build'], move: ['Click', 'Put down', 'build'],
  open: ['E', 'Open', 'ring'], use: ['E', 'Use', 'ring'], talk: ['E', 'Talk', 'ring'], buy: ['E', 'See the land', 'ring'],
  sell: ['E', 'Sell', 'ring'], shop: ['E', 'Shop', 'ring'], interact: ['E', 'Use', 'ring'],
};
const TUT = [
  ['Plant your seeds', p => `Select the seeds${keyOf(p, st => ITEMS[st.id].kind === 'seed')} and click the dark soil just past the beach.`],
  ['Harvest the wheat', () => 'Wheat ripens in about a minute. Pick an empty hotbar slot and click the ripe wheat to pick it by hand.'],
  ['Sell your harvest', () => 'Walk to the market stall in front of the farmhouse and press E.'],
  ['Visit the shop', () => 'Press E at the shop beside the market stall. A bucket makes crops grow twice as fast.'],
  ['Till a new field tile', p => `Use the hoe${keyOf(p, st => st.id === 'hoe')} on grass inside your land to make a new field tile (10 coins).`],
];
function keyOf(p, test) {
  for (let k = 0; k < 9; k++) if (p.inv[k] && test(p.inv[k])) return ` (key ${k + 1})`;
  return '';
}

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const slug = s => s.toLowerCase().replace(/[^a-z]+/g, '-');
const lowerFirst = s => s[0].toLowerCase() + s.slice(1);
const plural = (n, one, many = one + 's') => `${fmtNum(n)} ${n === 1 ? one : many}`;
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const X_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
const MAKES_SVG = '<svg class="makes" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ---------------------------------------------------------------- DOM skeleton
const SKELETON = `
<div id="lb" class="lb" aria-hidden="true"><div class="lb-bar lb-top"></div><div class="lb-bar lb-bot"></div></div>
<div id="cine-title" class="cine-title" aria-live="polite"></div>
<div id="hud" class="hud" hidden>
  <div class="hud-tl">
    <div class="wallet glass" role="group" aria-label="Shared wallet">
      <span class="cur" id="h-coinwrap"><span class="cur-ico" id="h-coinico"></span><b id="h-coins">0</b><span class="sr"> coins</span></span>
      <span class="cur"><span class="cur-ico" id="h-gemico"></span><b id="h-gems">0</b><span class="sr"> gems</span></span>
    </div>
    <div class="level glass" role="group" aria-label="Level">
      <span class="lv" id="h-lv">1</span>
      <div class="lv-meta"><div class="meter xp"><i id="h-xp"></i></div><span id="h-xpt" class="small"></span></div>
    </div>
    <section class="tut glass" id="h-tut" aria-label="Getting started" hidden></section>
  </div>
  <div class="hud-tr">
    <div class="clock glass"><span class="sun" id="h-sun"></span><b id="h-time"></b><span id="h-part" class="small"></span></div>
    <button class="host glass" id="h-host" hidden></button>
  </div>
  <div class="weather glass" id="h-weather" role="status" hidden>
    <span class="w-pip" aria-hidden="true"></span>
    <div class="w-text"><b id="h-wname"></b><span id="h-wtext"></span></div>
    <b class="w-cd" id="h-wcd"></b>
  </div>
  <div id="crosshair" class="ch ch-dot" aria-hidden="true"></div>
  <div id="tip" class="tip" hidden></div>
  <div class="hotbar-wrap">
    <div id="h-held" class="held" aria-live="polite"></div>
    <div id="hotbar" class="hotbar glass" role="list" aria-label="Hotbar"></div>
  </div>
  <div id="resume" class="resume" hidden>Click to look around</div>
</div>
<div id="toasts" class="toasts" role="status" aria-live="polite"></div>
<div id="banner" class="banner" aria-live="polite"></div>
<div id="title" class="title" hidden>
  <div class="t-col">
    <svg class="t-sprout" viewBox="0 0 64 64" aria-hidden="true"><path d="M32 58V30" stroke="currentColor" stroke-width="5" stroke-linecap="round" fill="none"/><path d="M32 34C32 20 22 12 8 12c0 14 10 22 24 22z" fill="#7cc444"/><path d="M32 30c0-12 9-19 22-19 0 12-9 19-22 19z" fill="#5fae6b"/></svg>
    <h1 class="wordmark" id="wordmark">Harvest<br>Haven</h1>
    <p class="t-tag">Five seeds. One island. Build the farm of your dreams, alone or with a friend.</p>
    <nav class="t-menu" id="t-menu" aria-label="Main menu">
      <button type="button" class="t-main" data-t="continue" id="t-continue">Continue your island</button>
      <button type="button" class="t-main" data-t="new">New world</button>
      <button type="button" data-t="join">Join a friend</button>
      <button type="button" data-t="settings">Settings</button>
    </nav>
    <div class="t-sub" id="t-sub" hidden></div>
  </div>
  <p class="t-foot">WASD to move, <kbd>Space</kbd> to jump, mouse to look, <kbd>E</kbd> to use</p>
</div>
<div id="scrim" class="scrim" hidden></div>
<div id="panel" class="panel" role="dialog" aria-modal="true" aria-labelledby="p-title" hidden></div>
<div id="drag-ghost" class="drag-ghost" aria-hidden="true" hidden></div>
<input type="file" id="import-file" accept=".json,application/json" hidden>
`;

// ================================================================ createUI
export function createUI(game) {
  // settings: defaults <- localStorage 'hh-settings' (main.js may already have merged them; harmless)
  game.settings = Object.assign({ quality: 'high', sens: 1, music: 0.6, sfx: 0.8, name: 'Castaway', parallax: 1, sat: 1 }, game.settings || {});
  try { Object.assign(game.settings, JSON.parse(lsGet('hh-settings') || '{}')); } catch { /* bad json */ }

  let root = document.getElementById('ui');
  if (!root) { root = document.createElement('div'); root.id = 'ui'; document.body.append(root); }
  root.insertAdjacentHTML('beforeend', SKELETON);
  const $ = id => document.getElementById(id);
  const E = {
    lb: $('lb'), cineTitle: $('cine-title'), hud: $('hud'), coins: $('h-coins'), coinWrap: $('h-coinwrap'),
    coinIco: $('h-coinico'), gemIco: $('h-gemico'), gems: $('h-gems'), lv: $('h-lv'), xp: $('h-xp'), xpt: $('h-xpt'),
    tut: $('h-tut'), sun: $('h-sun'), time: $('h-time'), part: $('h-part'), host: $('h-host'),
    weather: $('h-weather'), wname: $('h-wname'), wtext: $('h-wtext'), wcd: $('h-wcd'), ch: $('crosshair'), tip: $('tip'),
    held: $('h-held'), hotbar: $('hotbar'), resume: $('resume'), toasts: $('toasts'), banner: $('banner'),
    title: $('title'), wordmark: $('wordmark'), tMenu: $('t-menu'), tSub: $('t-sub'), tContinue: $('t-continue'),
    scrim: $('scrim'), panel: $('panel'), ghost: $('drag-ghost'), file: $('import-file'),
  };

  const me = () => game.state?.players?.[game.pid];
  let current = null, ctx = {}, titleShown = false;
  let picked = null, drag = null, justDragged = false, hover = null, pendingRender = false;
  let shopCat = SHOP_CATS[0], confirmQuit = false, hosting = false, hostCode = '', lastSaved = 0;
  const qty = {};
  let coinsShown = null, coinsTarget = 0, lastTut = -1, tutDoneAt = 0, prevPhase = 'calm';
  let tickT = 0, liveT = 0, lastLb = -1, lastCine = '', lastTarget = '', heldKey = '', heldTimer = 0;
  let wasLocked = false;

  // ---------------------------------------------------------------- icons (3D thumbnails, cached)
  const icons = new Map();
  let iconSeq = 0;
  function icon(name, opts, cls = 'ico', alt = '') {
    const key = name + (opts ? JSON.stringify(opts) : '');
    let rec = icons.get(key);
    if (!rec || (rec.failed && performance.now() - rec.failed > 3000)) {
      rec = rec || { id: 'k' + iconSeq++, url: '' };
      rec.failed = 0;
      icons.set(key, rec);
      Promise.resolve().then(() => thumbnail(name, opts)).then(url => {
        if (!url) throw new Error('no thumbnail');
        rec.url = url;
        for (const img of document.querySelectorAll(`img[data-ik="${rec.id}"]`)) img.src = url;
      }).catch(() => { rec.failed = performance.now(); });
    }
    return `<img class="${cls}" data-ik="${rec.id}" alt="${esc(alt)}" draggable="false"${rec.url ? ` src="${rec.url}"` : ''}>`;
  }
  const toolMetal = (t, lv) => ({ tint: { metal: METAL[TOOL_METAL[t][Math.min(lv, TOOL_METAL[t].length - 1)]] } });
  function itemIcon(id, cls) {
    const I = ITEMS[id];
    if (!I) return '';
    if (I.kind === 'tool') return icon(I.model, toolMetal(id, game.state?.tools?.[id] || 0), cls);
    if (I.kind === 'seed') return CROPS[I.crop].tree ? icon('sapling', null, cls) : icon('seed_packet', { tint: { tint: CROP_TINT[I.crop] || '#c9a46a' } }, cls);
    if (I.kind === 'gold') return icon(I.model, { gold: true }, cls);
    return icon(I.model, null, cls);
  }
  const coinIco = () => icon('item_coin', null, 'ico-s');
  const gemIco = () => icon('item_gem', null, 'ico-s');
  function itemName(id) {
    const I = ITEMS[id];
    if (!I) return id;
    if (I.kind === 'tool') return TOOL_LV[id]?.[game.state?.tools?.[id] || 0] || I.name;
    return I.name;
  }
  function itemDesc(id) {
    const I = ITEMS[id];
    if (I.kind === 'tool') return TOOL_HELP[id] || '';
    if (I.kind === 'seed') { const C = CROPS[I.crop]; return `Grows in ${fmtTime(C.grow)} and sells for ${fmtNum(C.sell)}${C.tree ? ' every harvest. Trees keep fruiting' : ''}.`; }
    if (I.kind === 'place') return `${SHOP.find(e => e.effect.item === id)?.desc || BUILDINGS[I.building].name}. Hold it and click to build.`;
    if (I.kind === 'boost') return `${SHOP.find(e => e.effect.item === id)?.desc || ''}. Use it on a growing crop.`;
    if (I.kind === 'gold') return `A rare golden harvest. Sells for ${fmtNum(I.sell)}.`;
    return I.sell ? `Sells for ${fmtNum(I.sell)} each.` : '';
  }
  function shopIcon(e) {
    const ef = e.effect;
    if (ef.item) return itemIcon(ef.item);
    if (ef.crop) return itemIcon('seed_' + ef.crop);
    if (ef.credits) return icon('soil_tile');
    if (ef.tool) return icon(ef.tool[0] === 'pouch' ? 'tool_seeds' : 'tool_' + ef.tool[0], toolMetal(ef.tool[0], ef.tool[1]));
    if (ef.fh) return icon('farmhouse_' + ef.fh);
    if (ef.store) return icon(ef.store[0]);
    if (ef.pack) return icon('tool_basket');
    if (ef.donkey) return icon(ef.donkey === 1 ? 'donkey_bags' : 'donkey_cart');
    if (ef.botLv) return icon('harvester_bot');
    if (ef.bridge) return icon('bridge');
    if (ef.ship) return icon('intro_ship');
    return '';
  }

  // ---------------------------------------------------------------- hotbar
  const hot = [];
  for (let k = 0; k < 9; k++) {
    const el = document.createElement('div');
    el.className = 'hs';
    el.setAttribute('role', 'listitem');
    el.innerHTML = `<span class="hs-key" aria-hidden="true">${k + 1}</span><span class="hs-ico"></span><span class="hs-n"></span><span class="hs-water"></span>`;
    E.hotbar.append(el);
    hot.push({ el, ico: el.children[1], n: el.children[2], water: el.children[3], key: null, cnt: -1, wkey: '' });
  }

  // ---------------------------------------------------------------- HUD
  let hudIcons = false;
  function renderHud() {
    const s = game.state, p = me();
    if (!s || !p) return;
    if (!hudIcons) { hudIcons = true; E.coinIco.innerHTML = icon('item_coin', null, 'ico-m'); E.gemIco.innerHTML = icon('item_gem', null, 'ico-m'); }
    coinsTarget = s.coins;
    if (coinsShown === null || reduced.matches) { coinsShown = s.coins; E.coins.textContent = fmtNum(s.coins); }
    E.gems.textContent = fmtNum(s.gems);
    E.lv.textContent = s.lv;
    E.xp.style.transform = `scaleX(${clamp01(levelProgress(s))})`;
    E.xpt.textContent = `${fmtNum(s.xp)} / ${fmtNum(xpFor(s.lv))} xp`;

    // hotbar
    const cap = BUCKET_CAP[s.tools.bucket];
    for (let k = 0; k < 9; k++) {
      const h = hot[k], st = p.inv[k];
      const key = st ? st.id + ':' + (ITEMS[st.id].kind === 'tool' ? s.tools[st.id] : '') : '';
      if (key !== h.key) { h.key = key; h.ico.innerHTML = st ? itemIcon(st.id) : ''; }
      const n = st && st.n > 1 ? st.n : 0;
      if (n !== h.cnt) { h.cnt = n; h.n.textContent = n ? n : ''; }
      h.el.classList.toggle('sel', k === p.sel);
      h.el.setAttribute('aria-label', st ? `${k + 1}: ${itemName(st.id)}${n ? `, ${n}` : ''}${k === p.sel ? ', selected' : ''}` : `${k + 1}: empty${k === p.sel ? ', selected' : ''}`);
      const wkey = st?.id === 'bucket' ? p.water + '/' + cap : '';
      if (wkey !== h.wkey) {
        h.wkey = wkey;
        if (!wkey) h.water.innerHTML = '';
        else if (cap <= 8) h.water.innerHTML = Array.from({ length: cap }, (_, i) => `<i class="${i < p.water ? 'on' : ''}"></i>`).join('');
        else h.water.innerHTML = `<span class="wbar"><i style="transform:scaleX(${p.water / cap})"></i></span>`;
        h.water.setAttribute('aria-label', `${p.water} of ${cap} waterings left`);
      }
    }
    const sel = p.inv[p.sel];
    const hk = p.sel + ':' + (sel ? sel.id + ':' + (ITEMS[sel.id].kind === 'tool' ? s.tools[sel.id] : '') : '');
    if (hk !== heldKey) {
      heldKey = hk;
      E.held.textContent = sel ? itemName(sel.id) : 'Empty hands';
      E.held.classList.add('show');
      heldTimer = 2.2;
    }

    // tutorial
    if (s.tut !== lastTut) {
      const was = lastTut;
      lastTut = s.tut;
      if (s.tut >= TUT.length) {
        if (was >= 0 && was < TUT.length) {
          tutDoneAt = performance.now();
          E.tut.hidden = false;
          E.tut.innerHTML = `<b class="tut-title">The farm is yours</b><p>Grow, sell and expand. Your goal: repair the wrecked ship in ${SHIP_PARTS.length} steps (${fmtNum(SHIP_COST)} coins in all) and sail home — shop → The ship. The trader on the pier has orders too.</p>`;
          E.tut.classList.add('done');
        } else E.tut.hidden = true;
      } else {
        E.tut.hidden = false;
        E.tut.classList.remove('done');
        if (was >= 0 && was < s.tut) { E.tut.classList.remove('bump'); void E.tut.offsetWidth; E.tut.classList.add('bump'); }
      }
    }
    if (s.tut < TUT.length) {
      const [t, hint] = TUT[s.tut];
      const pips = TUT.map((_, i) => `<li class="${i < s.tut ? 'did' : i === s.tut ? 'now' : ''}"></li>`).join('');
      const html = `<div class="tut-top"><span class="small">Step ${s.tut + 1} of ${TUT.length}</span><ol class="pips" aria-hidden="true">${pips}</ol></div><b class="tut-title">${esc(t)}</b><p>${esc(hint(p))}</p>`;
      if (E.tut._h !== html) { E.tut._h = html; E.tut.innerHTML = html; }
    } else if (!tutDoneAt) {   // after the tutorial the card becomes the goal tracker
      E.tut.hidden = !!s.won;
      E.tut.classList.add('done');
      const k = Math.min(s.ship || 0, SHIP_PARTS.length - 1), [pname, , cost] = SHIP_PARTS[k];
      const pct = Math.min(100, s.coins / cost * 100);
      const html = `<div class="tut-top"><span class="small">Repair the ship · step ${k + 1} of ${SHIP_PARTS.length}</span><span class="small">${pct >= 100 ? 'Ready!' : Math.floor(pct) + '%'}</span></div><b class="tut-title">${esc(pname)}</b><div class="goal-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${cost}" aria-valuenow="${Math.floor(s.coins)}"><i style="width:${pct.toFixed(1)}%"></i></div><p>${fmtNum(s.coins)} / ${fmtNum(cost)} coins${pct >= 100 ? ' — buy it at the shop (The ship)' : ''}</p>`;
      if (E.tut._h !== html) { E.tut._h = html; E.tut.innerHTML = html; }
    }

    // host code
    const code = game.role === 'host' ? (game.net?.code || hostCode) : '';
    E.host.hidden = !code;
    if (code) E.host.innerHTML = `<span class="small">Friends join with</span> <b>${esc(code)}</b>`;
  }
  E.host.addEventListener('click', () => copyCode(game.net?.code || hostCode));

  function tickTimers() {
    const s = game.state;
    if (!s) return;
    const now = game.now();
    // clock
    const d = game.world?.dayTime?.() ?? 0.5;
    const mins = Math.floor(d * 24 * 60) % 1440, h = Math.floor(mins / 60), m = mins % 60;
    E.time.textContent = `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
    const night = d < 0.23 || d > 0.78;
    E.sun.classList.toggle('night', night);
    E.part.textContent = night ? 'Night' : d < 0.45 ? 'Morning' : d < 0.66 ? 'Afternoon' : 'Evening';
    // weather
    const w = s.weather, D = w.kind && DISASTERS[w.kind];
    if (D && (w.phase === 'warn' || w.phase === 'active')) {
      E.weather.hidden = false;
      E.weather.classList.toggle('active', w.phase === 'active');
      E.wname.textContent = D.name;
      E.wtext.textContent = w.phase === 'warn' ? D.warn : 'Protect your crops until it passes.';
      E.wcd.textContent = (w.phase === 'warn' ? 'in ' : '') + fmtTime((w.t1 - now) / 1000) + (w.phase === 'active' ? ' left' : '');
    } else E.weather.hidden = true;
    // tutorial completion card fades away
    if (tutDoneAt && performance.now() - tutDoneAt > 9000) { tutDoneAt = 0; dirty.ui = true; }
    // panel countdowns + progress bars
    if (current) {
      for (const el of E.panel.querySelectorAll('[data-cd]')) el.textContent = fmtTime((+el.dataset.cd - now) / 1000);
      for (const el of E.panel.querySelectorAll('[data-pa]')) el.style.transform = `scaleX(${clamp01((now - +el.dataset.pa) / +el.dataset.pd)})`;
    }
  }

  // ---------------------------------------------------------------- crosshair + tooltip
  function setTarget(info) {
    if (current || titleShown) return;            // hidden behind panels; re-shown on the next call after close
    const key = info ? `${info.action}|${info.label}|${info.detail}|${info.kind}` : '';
    if (key === lastTarget) return;
    lastTarget = key;
    const A = info && ACTIONS[info.action];
    E.ch.className = 'ch ch-' + (info ? (A ? A[2] : 'ring') : 'dot');
    if (!info || (!info.label && !info.detail)) { E.tip.hidden = true; return; }
    const verb = A ? A[1] : info.action ? String(info.action)[0].toUpperCase() + String(info.action).slice(1) : '';
    E.tip.innerHTML = `${info.label ? `<b>${esc(info.label)}</b>` : ''}${info.detail ? `<span>${esc(info.detail)}</span>` : ''}${verb ? `<span class="tip-act"><kbd>${A ? A[0] : 'Click'}</kbd>${esc(verb)}</span>` : ''}`;
    E.tip.hidden = false;
  }

  // ---------------------------------------------------------------- toasts + banners
  const toastMap = new Map();
  function toast(msg, kind = 'info', iconHtml = '') {
    if (!msg) return;
    const key = kind + '|' + msg;
    let t = toastMap.get(key);
    if (t) {
      t.count++;
      t.el.querySelector('.t-count').textContent = '×' + t.count;
      clearTimeout(t.timer);
    } else {
      const el = document.createElement('div');
      el.className = 'toast t-' + kind;
      el.innerHTML = `${iconHtml || '<span class="t-pip" aria-hidden="true"></span>'}<span class="t-msg">${esc(msg)}</span><span class="t-count"></span>`;
      E.toasts.prepend(el);
      t = { el, count: 1, timer: 0 };
      toastMap.set(key, t);
      while (E.toasts.children.length > 4) {
        const last = E.toasts.lastElementChild;
        for (const [k, v] of toastMap) if (v.el === last) { clearTimeout(v.timer); toastMap.delete(k); }
        last.remove();
      }
    }
    t.timer = setTimeout(() => {
      toastMap.delete(key);
      t.el.classList.add('out');
      setTimeout(() => t.el.remove(), 260);
    }, kind === 'warn' ? 4200 : 3400);
  }

  const bq = [];
  let bBusy = false;
  function banner(text, sub) {
    bq.push([text, sub]);
    if (!bBusy) nextBanner();
  }
  function nextBanner() {
    const b = bq.shift();
    if (!b) { bBusy = false; return; }
    bBusy = true;
    E.banner.innerHTML = `<div class="b-in"><strong>${esc(b[0])}</strong>${b[1] ? `<span>${esc(b[1])}</span>` : ''}</div>`;
    E.banner.classList.remove('show');
    void E.banner.offsetWidth;
    E.banner.classList.add('show');
    setTimeout(() => { E.banner.classList.remove('show'); setTimeout(nextBanner, 320); }, bq.length ? 2200 : 3000);
  }

  function rewardBits(rw) {
    const out = [];
    if (rw.coins) out.push(`${fmtNum(rw.coins)} coins`);
    if (rw.gems) out.push(plural(rw.gems, 'gem'));
    if (rw.item) out.push(`${rw.n || 1} × ${ITEMS[rw.item].name.toLowerCase()}`);
    if (rw.tool) out.push(`a ${lowerFirst(TOOL_LV[rw.tool[0]][rw.tool[1]])}`);
    if (rw.plot) out.push(rw.plot > 1 ? `${rw.plot} free plots of land` : 'a free plot of land');
    if (rw.xp) out.push(`${fmtNum(rw.xp)} xp`);
    return out;
  }
  function levelSub(lv) {
    const names = SHOP.filter(e => e.unlock?.lv === lv).map(e => e.name);
    if (lv === TIER_LEVEL[2]) names.unshift('Land for sale');
    let sub = `+${GEMS_PER_LEVEL} gems`;
    if (names.length) sub += `. New: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`;
    return sub;
  }
  function onFx(list) {
    for (const f of list) {
      switch (f.k) {
        case 'coins':
        case 'market':
          if (f.n) floatCoins(f.n);
          break;
        case 'levelup': banner(`Level ${f.lv}`, levelSub(f.lv)); break;
        case 'achievement': toast(`${f.name}. +${f.gems} gems`, 'good', gemIco()); break;
        case 'quest': banner(f.pid && f.pid !== game.pid ? 'Your friend delivered an order' : 'Order delivered', rewardBits(f.reward || {}).join(', ')); break;
        case 'shipPart': banner(`Ship repair ${f.n} of ${SHIP_PARTS.length} done`, `Next: ${SHIP_PARTS[f.n][0].toLowerCase()} — ${fmtNum(SHIP_PARTS[f.n][2])} coins`); break;
        case 'trader': banner('The trader’s boat has docked', 'New orders are waiting at the pier'); break;
        case 'weather': {
          const D = f.kind && DISASTERS[f.kind];
          if (f.phase === 'warn' && D) banner(D.name, D.warn);
          else if (f.phase === 'active' && D) toast(`${D.name} has started`, 'warn');
          else if (f.phase === 'calm' && prevPhase === 'active') toast('The weather has cleared', 'good');
          prevPhase = f.phase;
          break;
        }
        case 'msg': if (!f.pid || f.pid === game.pid) toast(f.msg, 'warn'); break;
        case 'buy':
          if (f.pid === game.pid) { const e = SHOP.find(x => x.id === f.sid); if (e) toast(`Bought ${lowerFirst(e.name)}`, 'good', shopIcon(e).replace('class="ico"', 'class="ico-s"')); }
          break;
        case 'outfit': if (f.pid === game.pid) toast('New look on', 'good'); break;
        case 'collect': toast(`Collected ${f.n} × ${ITEMS[f.id]?.name.toLowerCase()}`, 'good', itemIcon(f.id, 'ico-s')); break;
      }
    }
  }
  function floatCoins(n) {
    E.coinWrap.classList.remove('pulse');
    void E.coinWrap.offsetWidth;
    E.coinWrap.classList.add('pulse');
    if (reduced.matches) return;
    const el = document.createElement('span');
    el.className = 'coin-float';
    el.textContent = '+' + fmtNum(n);
    E.coinWrap.append(el);
    setTimeout(() => el.remove(), 1100);
  }

  // ---------------------------------------------------------------- panels: shared bits
  const priceHtml = (coins, gems) => (gems ? `<span class="price gem">${gemIco()}<b>${fmtNum(gems)}</b><span class="sr"> gems</span></span>` : `<span class="price">${coinIco()}<b>${fmtNum(coins)}</b><span class="sr"> coins</span></span>`);
  const walletHtml = () => `<div class="p-wallet" aria-label="Wallet">${priceHtml(game.state.coins, 0)}${priceHtml(0, game.state.gems)}</div>`;
  const meter = (frac, cls = '') => `<div class="meter ${cls}"><i style="transform:scaleX(${clamp01(frac)})"></i></div>`;
  function stepper(k, n, max, label) {
    return `<div class="step" role="group" aria-label="${esc(label)}">
      <button type="button" class="step-b" data-act="qty" data-k="${k}" data-d="-1" data-max="${max}" data-f="q-${k}" aria-label="One fewer" ${n <= 1 ? 'disabled' : ''}>–</button>
      <output aria-live="polite">${n}</output>
      <button type="button" class="step-b" data-act="qty" data-k="${k}" data-d="1" data-max="${max}" data-f="q+${k}" aria-label="One more" ${n >= max ? 'disabled' : ''}>+</button>
    </div>`;
  }
  const gone = msg => ({ title: 'Not here any more', size: 'sm', body: `<p>${esc(msg)}</p><div class="row end"><button class="btn primary" data-act="close" data-f="ok">Close</button></div>` });

  // ---------------------------------------------------------------- slots (inventory, donkey, storage, bot)
  const isSlots = c => c === 'inv' || c === 'donkey';
  function stackAt(src) {
    const s = game.state;
    if (src.c === 'inv') return me()?.inv[src.k];
    if (src.c === 'donkey') return s.donkey.inv[src.k];
    if (src.c === 'silo' || src.c === 'barn') { const n = s.store[src.c].items[src.k]; return n ? { id: src.k, n } : null; }
    return null;
  }
  function parseSlot(str) {
    const [c, k] = str.split(':');
    return { c, k: isSlots(c) ? +k : k };
  }
  function slotHtml(c, k, st, extra = '') {
    const isPicked = picked && picked.c === c && picked.k === k;
    const cls = `slot${extra}${isPicked ? ' picked' : ''}${st ? '' : ' empty'}`;
    if (!st) return `<button type="button" class="${cls}" data-slot="${c}:${k}" data-f="s${c}${k}" aria-label="Empty slot"></button>`;
    return `<button type="button" class="${cls}" data-slot="${c}:${k}" data-f="s${c}${k}" aria-label="${esc(itemName(st.id))}${st.n > 1 ? `, ${st.n}` : ''}${isPicked ? ', picked up' : ''}">${itemIcon(st.id)}${st.n > 1 ? `<span class="n">${st.n}</span>` : ''}</button>`;
  }
  const xfer = (from, to, id) => game.do(id ? { type: 'xfer', from, to, id } : { type: 'xfer', from, to });
  function fit(arr, size, id, a, b) {
    for (let k = a; k < b; k++) if (arr[k]?.id === id && arr[k].n < ITEMS[id].stack) return k;
    for (let k = a; k < b; k++) if (!arr[k]) return k;
    return -1;
  }
  function sideKind() {
    if (current === 'donkey') return 'donkey';
    if (current === 'storage') return ctx.store;
    if (current === 'bot') return 'bot';
    return null;
  }
  // move src ({c,k}) onto whatever element is under the pointer / was clicked
  function moveTo(src, el) {
    const s = game.state, p = me();
    const t = el?.closest?.('[data-slot],[data-drop]');
    if (!t || !p) return;
    let dc, dk;
    if (t.dataset.slot) ({ c: dc, k: dk } = parseSlot(t.dataset.slot));
    else dc = t.dataset.drop;
    const st = stackAt(src);
    if (!st) return;
    if (isSlots(src.c)) {
      if (isSlots(dc)) {
        if (dk === undefined) {   // dropped on a container's background: first slot that fits
          if (dc === src.c) return;
          const arr = dc === 'inv' ? p.inv : s.donkey.inv, size = dc === 'inv' ? invSize(s) : donkeySize(s);
          dk = fit(arr, size, st.id, 0, size);
          if (dk < 0) return toast(dc === 'inv' ? 'Your backpack is full' : 'The donkey’s bags are full', 'warn');
        }
        if (dc === src.c && dk === src.k) return;
        xfer({ c: src.c, k: src.k }, { c: dc, k: dk });
      } else if (dc === 'silo' || dc === 'barn') xfer({ c: src.c, k: src.k }, { c: dc, k: 0 });
      else if (dc === 'bot') toast('The hopper only takes harvests from the bot', 'warn');
    } else if (src.c === 'silo' || src.c === 'barn') {
      if (isSlots(dc)) xfer({ c: src.c, k: 0 }, { c: dc, k: typeof dk === 'number' ? dk : 0 }, src.k);
    }
  }
  function quickMove(src) {
    const s = game.state, p = me(), st = stackAt(src);
    if (!st) return;
    const side = sideKind();
    if (src.c === 'inv') {
      if (side === 'donkey') {
        const t = fit(s.donkey.inv, donkeySize(s), st.id, 0, donkeySize(s));
        if (t < 0) return toast('The donkey’s bags are full', 'warn');
        xfer({ c: 'inv', k: src.k }, { c: 'donkey', k: t });
      } else if (side === 'silo' || side === 'barn') xfer({ c: 'inv', k: src.k }, { c: side, k: 0 });
      else {
        const [a, b] = src.k < 9 ? [9, invSize(s)] : [0, 9];
        const t = fit(p.inv, invSize(s), st.id, a, b);
        if (t < 0) return toast(src.k < 9 ? 'Your backpack is full' : 'Your hotbar is full', 'warn');
        xfer({ c: 'inv', k: src.k }, { c: 'inv', k: t });
      }
    } else if (src.c === 'donkey') {
      const t = fit(p.inv, invSize(s), st.id, 0, invSize(s));
      if (t < 0) return toast('Your backpack is full', 'warn');
      xfer({ c: 'donkey', k: src.k }, { c: 'inv', k: t });
    } else xfer({ c: src.c, k: 0 }, { c: 'inv', k: 0 }, src.k);
  }
  const DETAIL_HINT = 'Drag items to move them, or click one and then click where it goes. Shift-click sends it straight across.';
  function invLayout(side) {
    const s = game.state, p = me(), size = invSize(s);
    let pack = '', bar = '';
    for (let k = 9; k < size; k++) pack += slotHtml('inv', k, p.inv[k]);
    for (let k = 0; k < 9; k++) bar += slotHtml('inv', k, p.inv[k], k === p.sel ? ' sel' : '');
    return `<div class="inv${side ? ' with-side' : ''}">
      <section class="inv-main" data-drop="inv" aria-label="Your backpack">
        <h3 class="h3">Backpack <span class="muted small">${size - 9} slots</span></h3>
        <div class="grid">${pack}</div>
        <h3 class="h3">Hotbar</h3>
        <div class="grid">${bar}</div>
        <p class="inv-detail" id="inv-detail">${DETAIL_HINT}</p>
      </section>${side || ''}
    </div>`;
  }
  function donkeySide() {
    const s = game.state, p = me(), lv = s.donkey.lv, size = donkeySize(s);
    let g = '', used = 0;
    for (let k = 0; k < size; k++) { g += slotHtml('donkey', k, s.donkey.inv[k]); if (s.donkey.inv[k]) used++; }
    const loadable = p.inv.slice(0, invSize(s)).some(st => st && SELLABLE.includes(ITEMS[st.id].kind));
    const next = SHOP.find(e => e.effect.donkey === lv + 1);
    const gear = ['Bare back', 'Saddle bags', 'Saddle bags and a cart'][lv];
    const up = next
      ? `<p class="dk-next">${icon(next.effect.donkey === 1 ? 'donkey_bags' : 'donkey_cart', null, 'ico-s')}<span>Next: <b>${esc(next.name.toLowerCase())}</b>, so Biscuit carries ${next.effect.donkey === 1 ? 'twice' : 'five times'} as much. ${priceHtml(next.cost, 0)} at the shop from level ${next.unlock.lv}.</span></p>`
      : `<p class="dk-next done">Fully kitted out.</p>`;
    return `<section class="inv-side dk" data-drop="donkey" aria-label="Donkey">
      <div class="dk-hero">
        <div class="dk-portrait">${icon(['donkey', 'donkey_bags', 'donkey_cart'][lv], null, 'ico-l')}</div>
        <div class="dk-id"><h3 class="h3">Biscuit</h3><p class="muted small">Your donkey. Swam ashore with you and ${!s.donkey.cmd ? 'is following you around.' : s.donkey.cmd.m === 'stay' ? 'is waiting where you left him.' : 'is off where you sent him.'}</p><span class="chip">${gear}</span>${s.donkey.pets ? ` <span class="chip">♥ petted ${s.donkey.pets}×</span>` : ''}</div>
      </div>
      <div class="dk-acts dk-orders" role="group" aria-label="Tell Biscuit">
        <button type="button" class="btn sm${!s.donkey.cmd ? ' on' : ''}" data-act="dkFollow">Follow me</button>
        <button type="button" class="btn sm${s.donkey.cmd?.m === 'stay' ? ' on' : ''}" data-act="dkStay">Stay here</button>
        <button type="button" class="btn sm${s.donkey.cmd?.m === 'go' ? ' on' : ''}" data-act="dkGo">Send somewhere…</button>
        <button type="button" class="btn sm pet" data-act="dkPet">♥ Pet</button>
      </div>
      <div class="cap">${meter(used / size, used >= size ? 'full' : used / size > 0.8 ? 'warn' : '')}<span class="small">${used} / ${size} slots</span></div>
      <div class="dk-acts">
        <button type="button" class="btn sm" data-act="dkLoad" data-f="dkLoad" ${loadable && used < size ? '' : 'disabled'}>Load crops</button>
        <button type="button" class="btn sm" data-act="dkUnload" data-f="dkUnload" ${used ? '' : 'disabled'}>Unload all</button>
      </div>
      <div class="grid side-grid dk-grid" data-scroll="side">${g}</div>
      ${up}
    </section>`;
  }
  function storeSide(name) {
    const s = game.state, cap = storeCap(s, name), cnt = storeCount(s, name);
    const items = Object.entries(s.store[name].items).sort((a, b) => ITEMS[a[0]].name.localeCompare(ITEMS[b[0]].name));
    const rows = items.map(([id, n]) => `<li class="srow${picked?.c === name && picked.k === id ? ' picked' : ''}" data-slot="${name}:${id}">
        ${itemIcon(id)}<span class="s-name">${esc(ITEMS[id].name)}</span><b class="s-n">${fmtNum(n)}</b>
        <button type="button" class="btn sm" data-act="take" data-id="${id}" data-f="take-${id}" aria-label="Take ${esc(ITEMS[id].name)}">Take</button>
        <button type="button" class="btn sm ghost" data-act="sellStore" data-id="${id}" data-f="ss-${id}" ${ITEMS[id].sell ? '' : 'disabled'} aria-label="Sell ${fmtNum(n)} ${esc(ITEMS[id].name)} for ${fmtNum(ITEMS[id].sell * n)} coins">Sell ${coinIco()}${fmtNum(ITEMS[id].sell * n)}</button>
      </li>`).join('');
    const Name = name === 'silo' ? 'Silo' : 'Barn';
    return `<section class="inv-side" data-drop="${name}" aria-label="${Name}">
      <div class="side-head">${icon(name, null, 'ico-l')}<div><h3 class="h3">${Name}</h3><p class="muted small">${name === 'silo' ? 'Holds crops.' : 'Holds everything that isn’t a crop.'}</p></div></div>
      <div class="cap">${meter(cnt / cap, cnt >= cap ? 'full' : cnt / cap > 0.85 ? 'warn' : '')}<span class="small">${fmtNum(cnt)} / ${fmtNum(cap)}</span></div>
      <ul class="srows" data-scroll="side">${rows || `<li class="empty-note">Empty. Drag ${name === 'silo' ? 'crops' : 'items'} here from your backpack.</li>`}</ul>
    </section>`;
  }
  function botSide(b) {
    const s = game.state, now = game.now(), hop = b.d.hop || {};
    const cnt = Object.values(hop).reduce((a, n) => a + n, 0), conn = connectedToSilo(s, b);
    let status;
    if (b.fire) status = `<p class="note warn">It’s on fire. Throw water on it with your bucket.</p>`;
    else if (b.off > now) status = `<p class="note warn">Out of action after the fire. Back in <span data-cd="${b.off}">${fmtTime((b.off - now) / 1000)}</span>.</p>`;
    else status = conn
      ? `<p class="note good">Connected to the silo. Harvests go straight into storage until it’s full.</p>`
      : `<p class="note">Not connected to the silo. Lay conveyors from the dock to the silo, or empty the hopper here.</p>`;
    const rows = Object.entries(hop).map(([id, n]) => `<li class="srow">${itemIcon(id)}<span class="s-name">${esc(ITEMS[id].name)}</span><b class="s-n">${n}</b></li>`).join('');
    return `<section class="inv-side" data-drop="bot" aria-label="Harvester bot">
      <div class="side-head">${icon('harvester_bot', null, 'ico-l')}<div><h3 class="h3">Harvester bot</h3><p class="muted small">Picks ripe crops in a ${s.botLv >= 2 ? '7×7' : '5×5'} area, one every ${s.botLv >= 1 ? 2 : 4} seconds.</p></div></div>
      ${status}
      <div class="cap">${meter(cnt / 20, cnt >= 20 ? 'full' : '')}<span class="small">Hopper ${cnt} / 20</span></div>
      <ul class="srows" data-scroll="side">${rows || '<li class="empty-note">The hopper is empty.</li>'}</ul>
      <button type="button" class="btn primary wide" data-act="collectBot" data-f="collectBot" ${cnt ? '' : 'disabled'}>Collect all</button>
    </section>`;
  }

  // ---------------------------------------------------------------- panels
  const PANELS = {
    inventory: () => ({ title: 'Backpack', size: 'md', body: invLayout('') }),
    donkey: () => ({ title: 'Donkey', size: 'lg', body: invLayout(donkeySide()) }),
    storage: () => {
      const name = ctx.store === 'barn' ? 'barn' : 'silo';
      ctx.store = name;
      return { title: name === 'silo' ? 'Silo' : 'Barn', size: 'lg', head: walletHtml(), body: invLayout(storeSide(name)) };
    },
    bot: () => {
      const b = game.state.buildings[ctx.bid];
      if (!b) return gone('This harvester bot has been moved or put away.');
      return { title: 'Harvester bot', size: 'lg', body: invLayout(botSide(b)) };
    },

    shop() {
      const s = game.state;
      const tabs = SHOP_CATS.map(c => `<button type="button" role="tab" class="tab${c === shopCat ? ' on' : ''}" id="tab-${slug(c)}" aria-selected="${c === shopCat}" tabindex="${c === shopCat ? 0 : -1}" data-act="tab" data-cat="${esc(c)}" data-f="tab-${slug(c)}"><span class="tab-ico" aria-hidden="true">${c === 'Style' ? icon('fp_arm') : shopIcon(SHOP.find(e => e.cat === c) || {})}</span>${esc(c)}</button>`).join('');
      let cards;
      if (shopCat === 'Style') {
        const p = me();
        cards = OUTFITS.map(([hex, name, gems], i) => {
          const owns = s.outfits.includes(hex), wearing = p.outfit === hex;
          const label = wearing ? 'Wearing' : owns ? 'Wear' : 'Buy';
          return `<article class="card${wearing ? ' owned' : ''}">
            <div class="card-ico">${icon('player', { tint: { shirt: hex } })}<span class="swatch" style="background:${hex}"></span></div>
            <div class="card-main"><h4>${esc(name)} shirt</h4><p class="muted">${wearing ? 'You’re wearing this.' : owns ? 'Yours to wear any time.' : 'A new look for your castaway.'}</p></div>
            <div class="card-foot">${owns ? '<span class="chip good">Owned</span>' : gems ? priceHtml(0, gems) : '<span class="chip">Free</span>'}
              <button type="button" class="btn primary" data-act="outfit" data-idx="${i}" data-f="outfit-${i}" ${wearing || (!owns && s.gems < gems) ? 'disabled' : ''}>${label}</button></div>
          </article>`;
        }).join('');
      } else cards = SHOP.filter(e => e.cat === shopCat && shopVisible(s, e)).map(e => shopCard(s, e)).join('');
      const note = shopCat === 'Land & fields'
        ? `<p class="note">More land: walk to a for-sale sign at the edge of your farm and press E.</p>` : '';
      return {
        title: 'Shop', size: 'lg', head: walletHtml(),
        body: `<div class="shop"><div class="tabs" role="tablist" aria-orientation="vertical" aria-label="Shop sections">${tabs}</div>
          <div class="shop-list" role="tabpanel" aria-labelledby="tab-${slug(shopCat)}" data-scroll="shop">${note}<div class="cards">${cards}</div></div></div>`,
      };
    },

    sell() {
      const s = game.state, p = me(), size = invSize(s), groups = new Map();
      for (let k = 0; k < size; k++) {
        const st = p.inv[k];
        if (!st) continue;
        const I = ITEMS[st.id];
        if (!I.sell || I.kind === 'tool' || I.kind === 'place') continue;
        const g = groups.get(st.id) || { id: st.id, n: 0 };
        g.n += st.n;
        groups.set(st.id, g);
      }
      const all = [...groups.values()].sort((a, b) => ITEMS[b.id].sell * b.n - ITEMS[a.id].sell * a.n);
      const main = all.filter(g => SELLABLE.includes(ITEMS[g.id].kind)), extra = all.filter(g => !SELLABLE.includes(ITEMS[g.id].kind));
      const total = main.reduce((a, g) => a + ITEMS[g.id].sell * g.n, 0);
      const row = g => {
        const I = ITEMS[g.id], v = I.sell * g.n;
        return `<li class="srow"><span class="s-ico">${itemIcon(g.id)}<span class="s-qty">×${fmtNum(g.n)}</span></span>
          <span class="s-name">${esc(I.name)}<span class="muted small">${coinIco()}${fmtNum(I.sell)} each</span></span>
          <button type="button" class="btn sm sell" data-act="sellId" data-id="${g.id}" data-f="sell-${g.id}" aria-label="Sell ${fmtNum(g.n)} ${esc(I.name)} for ${fmtNum(v)} coins">Sell ${priceHtml(v, 0)}</button></li>`;
      };
      const empty = `<div class="empty-state">${icon('market_stall', null, 'ico-l')}<p><b>No crops to sell yet.</b><br>Harvest your field, then come back here to turn crops into coins.</p></div>`;
      const body = `${main.length ? `<ul class="srows">${main.map(row).join('')}</ul>` : empty}
           ${extra.length ? `<h3 class="h3 sell-sub">Seeds and supplies <span class="muted small">not included in Sell all</span></h3><ul class="srows">${extra.map(row).join('')}</ul>` : ''}
           ${main.length ? `<div class="sell-foot"><span>Sells all crops, goods, wood and stone</span>
             <button type="button" class="btn primary big" data-act="sellAll" data-f="sellAll">Sell all ${priceHtml(total, 0)}</button></div>` : ''}`;
      return { title: 'Market stall', size: 'md', head: walletHtml(), body };
    },

    factory() {
      const s = game.state, b = s.buildings[ctx.bid];
      if (!b || !RECIPES[b.type]) return gone('This building has been moved or put away.');
      const now = game.now(), p = me(), size = invSize(s), rs = RECIPES[b.type];
      let warn = '';
      if (b.fire) warn = `<p class="note warn">It’s on fire. Throw water on it with your bucket.</p>`;
      else if (b.off > now) warn = `<p class="note warn">Being repaired after the fire. Back in <span data-cd="${b.off}">${fmtTime((b.off - now) / 1000)}</span>.</p>`;
      const job = b.d.job;
      let body;
      if (job) {
        const rc = rs[job.r], per = rc.time * 1000, done = Math.min(job.n, Math.max(0, Math.floor((now - job.start) / per)));
        const end = job.start + job.n * per, out = ITEMS[rc.out].name.toLowerCase();
        body = `<div class="job">
          <div class="recipe-line">${ins(rc, job.n, p, size, false)}${MAKES_SVG}<span class="out">${itemIcon(rc.out)}<b>${job.n} × ${esc(ITEMS[rc.out].name)}</b></span></div>
          <div class="meter big"><i data-pa="${job.start}" data-pd="${job.n * per}" style="transform:scaleX(${clamp01((now - job.start) / (job.n * per))})"></i></div>
          <p>${done} of ${job.n} ready${done < job.n ? `. All done in <span data-cd="${end}">${fmtTime((end - now) / 1000)}</span>.` : '.'}</p>
          <div class="row end"><button type="button" class="btn primary" data-act="facCollect" data-f="collect" ${done ? '' : 'disabled'}>${done ? `Collect ${done} ${esc(out)}` : 'Nothing ready yet'}</button></div>
        </div>`;
      } else {
        body = `<ul class="recipes">${rs.map((rc, r) => {
          const can = Math.min(20, ...Object.entries(rc.in).map(([id, k]) => Math.floor(countItem(p.inv, size, id) / k)));
          const key = `f-${b.type}-${r}`;
          const n = Math.max(1, Math.min(qty[key] || 1, Math.max(1, can)));
          const short = can < n;
          return `<li class="recipe">
            <div class="recipe-line">${ins(rc, n, p, size, true)}${MAKES_SVG}<span class="out">${itemIcon(rc.out)}<b>${n} × ${esc(ITEMS[rc.out].name)}</b><span class="muted small">${fmtNum(ITEMS[rc.out].sell)} each</span></span></div>
            <div class="recipe-foot"><span class="muted small">Takes ${fmtTime(rc.time * n)}</span>${stepper(key, n, Math.max(1, can), 'Batches')}
              <button type="button" class="btn primary" data-act="facStart" data-r="${r}" data-n="${n}" data-f="start-${r}" ${short || b.fire || b.off > now ? 'disabled' : ''}>Start</button></div>
          </li>`;
        }).join('')}</ul>`;
      }
      return { title: BUILDINGS[b.type].name, size: 'md', body: warn + body };
    },

    market() {
      const s = game.state, b = s.buildings[ctx.bid];
      if (!b) return gone('This auto-market has been moved or put away.');
      const pct = Math.round((b.d.mult || 1) * 100), items = s.store.silo.items;
      const base = Object.entries(items).reduce((a, [id, n]) => a + ITEMS[id].sell * n, 0);
      const cnt = storeCount(s, 'silo');
      return {
        title: 'Auto-market', size: 'sm', head: walletHtml(),
        body: `<div class="market">
          <p>Sells crops from the silo every 10 seconds, even while you’re away.</p>
          <label class="field-label" for="mk">Selling price <output id="mk-out">${pct}%</output></label>
          <input type="range" id="mk" min="80" max="140" step="5" value="${pct}" data-f="mk" data-base="${base}" aria-describedby="mk-help">
          <div class="range-ends small muted" aria-hidden="true"><span>Sells faster</span><span>Earns more</span></div>
          <p id="mk-help" class="muted">${marketHelp(pct, cnt, base)}</p>
        </div>`,
      };
    },

    quests() {
      const s = game.state, p = me(), size = invSize(s), now = game.now(), tr = s.trader;
      const docked = tr.at && now - tr.at < 180e3;
      const cards = s.quests.map(q => {
        const needs = Object.entries(q.need).map(([id, n]) => {
          const have = countItem(p.inv, size, id);
          return `<li class="${have >= n ? 'ok' : 'short'}">${itemIcon(id)}<span>${esc(ITEMS[id].name)}</span><b>${Math.min(have, n)} / ${n}</b></li>`;
        }).join('');
        const ready = Object.entries(q.need).every(([id, n]) => countItem(p.inv, size, id) >= n);
        const rw = q.reward, chips = [];
        if (rw.coins) chips.push(priceHtml(rw.coins, 0));
        if (rw.gems) chips.push(priceHtml(0, rw.gems));
        if (rw.item) chips.push(`<span class="price">${itemIcon(rw.item, 'ico-s')}<b>${rw.n || 1} × ${esc(ITEMS[rw.item].name)}</b></span>`);
        if (rw.tool) chips.push(`<span class="price">${icon('tool_' + rw.tool[0], toolMetal(rw.tool[0], rw.tool[1]), 'ico-s')}<b>${esc(TOOL_LV[rw.tool[0]][rw.tool[1]])}</b></span>`);
        if (rw.plot) chips.push(`<span class="price">${icon('sign_forsale', null, 'ico-s')}<b>A free plot of land</b></span>`);
        if (rw.xp) chips.push(`<span class="price xp"><b>${fmtNum(rw.xp)} xp</b></span>`);
        return `<article class="order${q.story ? ' story' : ''}">
          <p class="quote">“${esc(q.text)}”</p>
          <div class="order-cols"><div><h4 class="small muted">Wants</h4><ul class="needs">${needs}</ul></div>
            <div><h4 class="small muted">Gives</h4><div class="rewards">${chips.join('')}</div></div></div>
          <div class="row end"><button type="button" class="btn primary" data-act="turnIn" data-qid="${q.id}" data-f="q-${q.id}" ${ready ? '' : 'disabled'}>${ready ? 'Deliver' : 'Not enough yet'}</button></div>
        </article>`;
      }).join('');
      return {
        title: 'The trader', size: 'md',
        head: `<p class="p-sub">${docked ? 'The boat is docked at the pier.' : `Next boat in <span data-cd="${tr.next}">${fmtTime((tr.next - now) / 1000)}</span>`}</p>`,
        body: `<div class="trader-head">${icon('trader', null, 'ico-l')}<p>Bring what an order asks for in your backpack and I’ll make it worth your while. A new order comes with each boat.</p></div>
          ${cards || '<p class="empty-note">No orders right now. The next boat brings a new one.</p>'}`,
      };
    },

    plot() {
      const s = game.state, { px, py } = ctx, st = plotState(s, px, py);
      let trees = 0, water = 0;
      for (let j = py * PLOT; j < py * PLOT + PLOT; j++) for (let i = px * PLOT; i < px * PLOT + PLOT; i++) {
        const t = tile(s, i, j);
        if (t?.o) trees++;
        if (t && (t.t === 'w' || t.t === 'r')) water++;
      }
      const facts = [`${PLOT}×${PLOT} tiles`];
      if (trees) facts.push(`${trees} ${trees === 1 ? 'tree or rock' : 'trees and rocks'} to clear`);
      if (water) facts.push(`${water} tiles of water`);
      const price = st.free ? '<span class="chip good">Free from the trader</span>' : st.price != null ? priceHtml(st.price, 0) : '';
      return {
        title: 'Land for sale', size: 'sm',
        body: `<div class="plot">${icon('sign_forsale', null, 'ico-l')}<div><p>${esc(facts.join(', '))}.</p>${price}</div></div>
          ${st.ok ? '' : `<p class="note ${st.owned ? 'good' : 'warn'}">${esc(st.why)}</p>`}
          <div class="row end"><button type="button" class="btn ghost" data-act="close" data-f="no">Not now</button>
          <button type="button" class="btn primary" data-act="buyPlot" data-f="yes" ${st.ok ? 'data-autofocus' : 'disabled'}>${st.free ? 'Claim this land' : 'Buy this land'}</button></div>`,
      };
    },

    pause() {
      const guest = game.role === 'guest';
      if (confirmQuit) return {
        title: guest ? 'Leave this island?' : 'Quit to the title screen?', size: 'sm',
        body: `<p>${guest ? 'You can join again with the same code while your friend is playing.' : 'Your island is saved first, so nothing is lost.'}</p>
          <div class="row end"><button type="button" class="btn ghost" data-act="quitNo" data-f="quitNo">Keep playing</button>
          <button type="button" class="btn danger" data-act="quitYes" data-f="quitYes" data-autofocus>${guest ? 'Leave' : 'Quit'}</button></div>`,
      };
      const ago = lastSaved ? Math.round((performance.now() - lastSaved) / 1000) : -1;
      return {
        title: 'Paused', size: 'sm',
        body: `<nav class="menu" aria-label="Pause menu">
          <button type="button" class="btn primary" data-act="close" data-f="resume" data-autofocus>Resume</button>
          ${guest ? '' : '<button type="button" class="btn" data-act="invite" data-f="invite">Invite a friend</button>'}
          <button type="button" class="btn" data-act="settings" data-f="settings">Settings</button>
          ${guest ? '' : '<button type="button" class="btn" data-act="export" data-f="export">Export save</button><button type="button" class="btn" data-act="import" data-f="import">Import save</button>'}
          <button type="button" class="btn ghost" data-act="quit" data-f="quit">${guest ? 'Leave the island' : 'Quit to title'}</button>
        </nav>
        <p class="muted small center">${guest ? 'Your friend’s computer keeps this island saved.' : ago >= 0 ? `Saved automatically ${ago < 5 ? 'just now' : fmtTime(ago) + ' ago'}.` : 'Your island saves automatically.'}</p>`,
      };
    },

    settings() {
      const st = game.settings;
      const pct = v => Math.round(v * 100) + '%';
      return {
        title: 'Settings', size: 'md',
        body: `<form class="settings" onsubmit="return false">
          <fieldset class="seg"><legend class="field-label">Graphics</legend>
            <div class="seg-row">
              <label><input type="radio" name="quality" value="high" ${st.quality !== 'low' ? 'checked' : ''} data-f="qh"><span>High</span></label>
              <label><input type="radio" name="quality" value="low" ${st.quality === 'low' ? 'checked' : ''} data-f="ql"><span>Low</span></label>
            </div>
            <p class="muted small">Low turns off god rays and softens shadows for slower computers.</p>
          </fieldset>
          <label class="field-label" for="set-parallax">Ground depth (parallax) <output id="o-parallax">${pct(st.parallax ?? 1)}</output></label>
          <input type="range" id="set-parallax" min="0" max="2" step="0.05" value="${st.parallax ?? 1}" data-f="parallax">
          <label class="field-label" for="set-sat">Colour saturation <output id="o-sat">${pct(st.sat ?? 1)}</output></label>
          <input type="range" id="set-sat" min="0" max="2" step="0.05" value="${st.sat ?? 1}" data-f="sat">
          <label class="field-label" for="set-sens">Mouse sensitivity <output id="o-sens">${(+st.sens).toFixed(1)}×</output></label>
          <input type="range" id="set-sens" min="0.2" max="3" step="0.1" value="${st.sens}" data-f="sens">
          <label class="field-label" for="set-music">Music <output id="o-music">${pct(st.music)}</output></label>
          <input type="range" id="set-music" min="0" max="1" step="0.05" value="${st.music}" data-f="music">
          <label class="field-label" for="set-sfx">Sound effects <output id="o-sfx">${pct(st.sfx)}</output></label>
          <input type="range" id="set-sfx" min="0" max="1" step="0.05" value="${st.sfx}" data-f="sfx">
          <label class="field-label" for="set-name">Your name</label>
          <input type="text" id="set-name" maxlength="16" autocomplete="nickname" spellcheck="false" value="${esc(st.name)}" data-f="name">
          <p class="muted small">Friends see this above your head.</p>
        </form>
        <h3 class="h3">Controls</h3>
        <dl class="keys">
          <dt><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></dt><dd>Walk</dd>
          <dt><kbd>Shift</kbd></dt><dd>Sprint</dd>
          <dt><kbd>Click</kbd></dt><dd>Use what you’re holding. Hold to keep going</dd>
          <dt><kbd>1</kbd>–<kbd>9</kbd> or wheel</dt><dd>Pick a hotbar slot</dd>
          <dt><kbd>E</kbd></dt><dd>Talk, open, or check your backpack</dd>
          <dt><kbd>B</kbd></dt><dd>Build mode: pick up and move buildings</dd>
          <dt><kbd>R</kbd> / <kbd>X</kbd></dt><dd>Rotate / put back in your backpack</dd>
          <dt><kbd>Esc</kbd></dt><dd>Pause</dd>
        </dl>`,
      };
    },

    multiplayer() {
      const s = game.state, role = game.role, code = game.net?.code || hostCode;
      const people = s ? Object.entries(s.players).map(([id, p]) => `<li><span class="swatch" style="background:${esc(p.outfit)}"></span>${esc(p.name)}${id === game.pid ? ' <span class="muted">(you)</span>' : ''}</li>`).join('') : '';
      let body;
      if (role === 'host') {
        body = `<p>Your island is open. Your friend picks <b>Join a friend</b> on their title screen and types this code.</p>
          <div class="code-box"><output class="code" id="mp-code">${esc(code || 'Opening…')}</output>
          <button type="button" class="btn primary" data-act="copy" data-f="copy" ${code ? '' : 'disabled'}>Copy code</button></div>
          <h3 class="h3">On the island</h3><ul class="people">${people}</ul>`;
      } else if (role === 'guest') {
        body = `<p>You’re playing on your friend’s island. Everything you earn goes into the shared wallet.</p>
          <h3 class="h3">On the island</h3><ul class="people">${people}</ul>
          <div class="row end"><button type="button" class="btn ghost" data-act="quit" data-f="leave">Leave the island</button></div>`;
      } else {
        body = `<p>Open your island and a friend can farm it with you in real time. You share one wallet, one shop and every field.</p>
          <div class="row"><button type="button" class="btn primary" data-act="host" data-f="host" ${hosting ? 'disabled' : ''}>${hosting ? 'Opening your island…' : 'Open my island to a friend'}</button></div>
          <h3 class="h3">Join a friend instead</h3>
          <div class="join-row"><label class="sr" for="mp-join">Friend’s code</label>
            <input type="text" id="mp-join" placeholder="Friend’s code" autocomplete="off" spellcheck="false" data-f="mpjoin">
            <button type="button" class="btn" data-act="join" data-f="joinbtn">Join</button></div>
          <p class="muted small">Your island is saved before you leave it.</p>`;
      }
      return { title: 'Play with a friend', size: 'sm', body };
    },
  };

  function ins(rc, n, p, size, showHave) {
    return Object.entries(rc.in).map(([id, k]) => {
      const have = countItem(p.inv, size, id), need = k * n;
      return `<span class="in ${!showHave || have >= need ? 'ok' : 'short'}">${itemIcon(id)}<b>${showHave ? `${Math.min(have, need)}/${need}` : need}</b><span class="sr"> ${esc(ITEMS[id].name)}</span></span>`;
    }).join('<span class="plus" aria-hidden="true">+</span>');
  }
  function marketHelp(pct, cnt, base) {
    const per = Math.max(1, Math.round(9 * (1.4 - pct / 100) / 0.6));
    return `At ${pct}% it sells up to ${per} crops every 10 seconds. The silo holds ${plural(cnt, 'crop')}${cnt ? `, worth about ${fmtNum(Math.round(base * pct / 100))} coins at this price` : ''}.`;
  }
  // seeds: show the crops you have unlocked, plus only the next one to unlock
  function shopVisible(s, e) {
    const ef = e.effect, sc = ef.item && ITEMS[ef.item].kind === 'seed' && ITEMS[ef.item].crop;
    if (sc) return s.crops.includes(sc);
    if (ef.crop) return !s.crops.includes(ef.crop);   // the next unlock, and every crop after it (locked, no price)
    return true;
  }
  function shopCard(s, e) {
    const st = shopState(s, e), ef = e.effect;
    if (ef.crop && !s.crops.includes(CROPS[ef.crop].prev)) {   // a future crop: what it is, not what it costs
      return `<article class="card locked future">
      <div class="card-ico">${shopIcon(e)}</div>
      <div class="card-main"><h4>${esc(ITEMS['seed_' + ef.crop].name)}</h4><p class="muted">Unlocks after ${esc(CROPS[CROPS[ef.crop].prev].name.toLowerCase())}.</p></div>
      <div class="card-foot"><span class="chip lock">Locked</span></div>
    </article>`;
    }
    const stack = !!(ef.credits || (ef.item && ITEMS[ef.item].stack > 1));
    const locked = !st.ok && !st.poor;
    const n = stack ? qty['b-' + e.id] || 1 : 1;
    const afford = st.free || (s.coins >= e.cost * n && s.gems >= e.gems * n);
    const can = !locked && afford;
    let foot;
    if (st.owned) foot = `<span class="chip good">${esc(st.why)}</span>`;
    else if (locked) foot = `<span class="chip lock">${esc(st.why)}</span>${priceHtml(e.cost * n, e.gems * n)}`;
    else foot = `${stack ? stepper('b-' + e.id, n, 99, 'Quantity') : ''}
        <button type="button" class="btn buy${afford ? ' primary' : ' short'}" data-act="buy" data-sid="${e.id}" data-n="${n}" data-f="buy-${e.id}" ${can ? '' : 'disabled'}>${st.free ? 'Take 5 free' : (afford ? 'Buy' : 'Need') + ' ' + priceHtml(e.cost * n, e.gems * n)}</button>`;
    return `<article class="card${ef.crop ? ' next' : ''}${st.owned ? ' owned' : ''}${locked && !st.owned ? ' locked' : ''}">
      <div class="card-ico">${shopIcon(e)}</div>
      <div class="card-main"><h4>${esc(e.name)}</h4><p class="muted">${esc(e.desc)}</p></div>
      <div class="card-foot">${foot}</div>
    </article>`;
  }

  // ---------------------------------------------------------------- open / close / render
  function open(name, c = {}) {
    if (!PANELS[name]) return;
    if (name !== 'settings' && name !== 'multiplayer' && name !== 'pause' && (!game.state || !me())) return;
    const was = current;
    current = name; ctx = c || {}; picked = null; confirmQuit = false;
    if (!was) {
      game.player?.unlock?.();
      game.emit?.('ui-open', { panel: name });
      E.tip.hidden = true;
      lastTarget = '#';
    }
    renderPanel(true);
  }
  function hidePanel() {
    if (drag) cancelDrag();
    current = null; ctx = {}; picked = null; hover = null; confirmQuit = false;
    E.panel.hidden = true; E.scrim.hidden = true;
    E.panel.innerHTML = '';
  }
  function close() {
    if (!current) return;
    const back = ctx.back;
    if (back === 'pause' && !titleShown) {   // settings / invite opened from pause return to it
      current = 'pause'; ctx = {}; picked = null; confirmQuit = false;
      renderPanel(true);
      return;
    }
    hidePanel();
    game.emit?.('ui-close');
    if (!titleShown) game.player?.lock?.();
    else showTSub(null);
  }
  function closeQuiet() {   // leaving play (quit, import): no pointer relock
    if (!current) return;
    hidePanel();
    game.emit?.('ui-close');
  }

  function renderPanel(first) {
    if (!current) return;
    if (drag) { pendingRender = true; return; }
    const r = PANELS[current]();
    const af = document.activeElement;
    const fk = !first && E.panel.contains(af) ? af.dataset?.f : null;
    const scroll = {};
    if (!first) for (const el of E.panel.querySelectorAll('[data-scroll]')) scroll[el.dataset.scroll] = el.scrollTop;
    const bodyTop = !first ? E.panel.querySelector('.p-body')?.scrollTop || 0 : 0;
    const texts = {};
    for (const el of E.panel.querySelectorAll('input[type=text][data-f]')) texts[el.dataset.f] = [el.value, el === af ? [el.selectionStart, el.selectionEnd] : null];

    E.panel.className = `panel p-${r.size || 'md'} panel-${current}${first && !reduced.matches ? ' enter' : ''}`;
    E.panel.innerHTML = `<header class="p-head"><h2 id="p-title">${esc(r.title)}</h2>${r.head || ''}
        <button type="button" class="x" data-act="close" data-f="close" aria-label="${current === 'pause' ? 'Resume' : 'Close'}">${X_SVG}</button></header>
      <div class="p-body">${r.body}</div>`;
    E.panel.hidden = false; E.scrim.hidden = false;

    for (const [f, [v, sel]] of Object.entries(texts)) {
      const el = E.panel.querySelector(`input[data-f="${f}"]`);
      if (!el) continue;
      el.value = v;
      if (sel) { el.focus({ preventScroll: true }); el.setSelectionRange(sel[0], sel[1]); }
    }
    for (const el of E.panel.querySelectorAll('[data-scroll]')) if (scroll[el.dataset.scroll]) el.scrollTop = scroll[el.dataset.scroll];
    if (bodyTop) E.panel.querySelector('.p-body').scrollTop = bodyTop;

    if (first) {
      const target = E.panel.querySelector('[data-autofocus]:not([disabled])') || E.panel.querySelector('.tab.on')
        || E.panel.querySelector('.p-body button:not([disabled]), .p-body input, .p-body [tabindex="0"]') || E.panel.querySelector('.x');
      target?.focus({ preventScroll: true });
    } else if (fk && !E.panel.contains(document.activeElement)) {
      const el = E.panel.querySelector(`[data-f="${CSS.escape(fk)}"]`);
      (el && !el.disabled ? el : E.panel.querySelector('.x'))?.focus({ preventScroll: true });
    }
    if (hover) showDetail(hover);
  }

  function showDetail(src) {
    const d = document.getElementById('inv-detail');
    if (!d) return;
    const st = src && stackAt(src);
    if (!st) { d.textContent = DETAIL_HINT; return; }
    const I = ITEMS[st.id];
    d.innerHTML = `<b>${esc(itemName(st.id))}${st.n > 1 ? ` × ${fmtNum(st.n)}` : ''}</b> <span>${esc(itemDesc(st.id))}</span>${I.sell && st.n > 1 ? ` <span class="muted">Stack worth ${fmtNum(I.sell * st.n)}.</span>` : ''}`;
  }

  // ---------------------------------------------------------------- panel events
  function act(a, el, e) {
    const s = game.state;
    switch (a) {
      case 'close': close(); break;
      case 'tab': shopCat = el.dataset.cat; renderPanel(); E.panel.querySelector('.tab.on')?.focus(); E.panel.querySelector('.shop-list').scrollTop = 0; break;
      case 'qty': {
        const k = el.dataset.k, max = +el.dataset.max, cur = qty[k] || 1;
        qty[k] = Math.max(1, Math.min(max, cur + (+el.dataset.d) * (e.shiftKey ? 10 : 1)));
        renderPanel();
        break;
      }
      case 'buy': game.do({ type: 'buy', sid: el.dataset.sid, n: +el.dataset.n || 1 }); break;
      case 'outfit': game.do({ type: 'outfit', idx: +el.dataset.idx }); break;
      case 'sellId': {
        const p = me(), id = el.dataset.id;
        for (let k = 0; k < invSize(s); k++) if (p.inv[k]?.id === id) game.do({ type: 'sell', slot: k, n: p.inv[k].n });
        break;
      }
      case 'sellAll': game.do({ type: 'sell', all: true }); break;
      case 'sellStore': game.do({ type: 'sellStore', store: ctx.store, id: el.dataset.id }); break;
      case 'take': xfer({ c: ctx.store, k: 0 }, { c: 'inv', k: 0 }, el.dataset.id); break;
      case 'dkFollow': game.do({ type: 'donkey', m: 'follow' }); toast('Biscuit will follow you'); renderPanel(); break;
      case 'dkStay': game.do({ type: 'donkey', m: 'stay', x: game.donkey.x, z: game.donkey.z }); toast('Biscuit will wait here'); renderPanel(); break;
      case 'dkGo': close(); game.player?.pickDonkeySpot?.(); break;
      case 'dkPet': game.do({ type: 'pet' }); renderPanel(); break;
      case 'dkLoad': case 'dkUnload': {
        const s = game.state, p = me(), load = el.dataset.act === 'dkLoad';
        const [from, n] = load ? [p.inv, invSize(s)] : [s.donkey.inv, donkeySize(s)];
        for (let k = 0; k < n; k++) {
          const st = from[k];
          if (!st || (load && !SELLABLE.includes(ITEMS[st.id].kind))) continue;
          const t = load ? fit(s.donkey.inv, donkeySize(s), st.id, 0, donkeySize(s)) : fit(p.inv, invSize(s), st.id, 0, invSize(s));
          if (t < 0) { toast(load ? 'The donkey’s bags are full' : 'Your backpack is full', 'warn'); break; }
          xfer(load ? { c: 'inv', k } : { c: 'donkey', k }, load ? { c: 'donkey', k: t } : { c: 'inv', k: t });
        }
        break;
      }
      case 'collectBot': xfer({ c: 'bot', k: ctx.bid }, { c: 'inv', k: 0 }); break;
      case 'facStart': game.do({ type: 'facStart', bid: ctx.bid, r: +el.dataset.r, n: +el.dataset.n || 1 }); break;
      case 'facCollect': game.do({ type: 'facCollect', bid: ctx.bid }); break;
      case 'buyPlot': game.do({ type: 'buyPlot', px: ctx.px, py: ctx.py }); close(); break;
      case 'turnIn': game.do({ type: 'turnIn', qid: +el.dataset.qid }); break;
      case 'invite': open('multiplayer', { back: 'pause' }); break;
      case 'settings': open('settings', { back: current === 'pause' ? 'pause' : ctx.back }); break;
      case 'export': game.exportSave?.(); break;
      case 'import': E.file.click(); break;
      case 'quit': confirmQuit = true; if (current !== 'pause') { current = 'pause'; ctx = {}; } renderPanel(true); break;
      case 'quitNo': confirmQuit = false; renderPanel(true); break;
      case 'quitYes':
        if (game.role !== 'guest') game.save?.();
        closeQuiet();
        game.quitToTitle?.();
        break;
      case 'host':
        hosting = true; renderPanel();
        Promise.resolve(game.host?.()).then(code => {
          if (typeof code === 'string') hostCode = code;
          hosting = false;
          renderHud();
          if (current === 'multiplayer') renderPanel();
        }).catch(() => {
          hosting = false;
          toast('Couldn’t open your island. Check your internet connection and try again.', 'warn');
          if (current === 'multiplayer') renderPanel();
        });
        break;
      case 'copy': copyCode(game.net?.code || hostCode); break;
      case 'join': {
        const code = E.panel.querySelector('#mp-join')?.value.trim();
        if (!code) { toast('Type the code your friend sees on their screen', 'warn'); E.panel.querySelector('#mp-join')?.focus(); break; }
        game.save?.();
        closeQuiet();
        game.join?.(code);
        break;
      }
    }
  }
  function copyCode(code) {
    if (!code) return;
    (navigator.clipboard?.writeText(code) || Promise.reject()).then(() => toast('Code copied', 'good'), () => {
      const out = document.getElementById('mp-code');
      if (out) getSelection().selectAllChildren(out);
      toast(`Your code is ${code}`, 'info');
    });
  }

  E.panel.addEventListener('click', e => {
    if (justDragged) return;
    const a = e.target.closest('[data-act]');
    if (a && !a.disabled) return act(a.dataset.act, a, e);
    const slot = e.target.closest('[data-slot]');
    if (slot) {
      const src = parseSlot(slot.dataset.slot);
      if (e.shiftKey && stackAt(src)) { picked = null; quickMove(src); return; }
      if (picked) {
        const from = picked;
        picked = null;
        if (from.c === src.c && from.k === src.k) return renderPanel();
        moveTo(from, slot);
        renderPanel();
      } else if (stackAt(src) && (isSlots(src.c) || src.c === 'silo' || src.c === 'barn')) { picked = src; renderPanel(); }
      return;
    }
    if (picked && e.target.closest('[data-drop]')) { const from = picked; picked = null; moveTo(from, e.target); renderPanel(); }
  });
  E.scrim.addEventListener('click', () => close());
  E.panel.addEventListener('pointerover', e => {
    const slot = e.target.closest?.('[data-slot]');
    const src = slot ? parseSlot(slot.dataset.slot) : null;
    if (src?.c === hover?.c && src?.k === hover?.k) return;
    hover = src;
    showDetail(src);
  });
  E.panel.addEventListener('focusin', e => {
    const slot = e.target.closest?.('[data-slot]');
    if (!slot) return;
    hover = parseSlot(slot.dataset.slot);
    showDetail(hover);
  });
  E.panel.addEventListener('input', e => {
    const t = e.target, st = game.settings;
    if (t.id === 'mk') {
      const pct = +t.value;
      E.panel.querySelector('#mk-out').textContent = pct + '%';
      E.panel.querySelector('#mk-help').textContent = marketHelp(pct, storeCount(game.state, 'silo'), +t.dataset.base);
    } else if (t.id === 'set-sens') { st.sens = +t.value; E.panel.querySelector('#o-sens').textContent = st.sens.toFixed(1) + '×'; saveSettings(); }
    else if (t.id === 'set-music') { st.music = +t.value; E.panel.querySelector('#o-music').textContent = Math.round(st.music * 100) + '%'; saveSettings(); }
    else if (t.id === 'set-sfx') { st.sfx = +t.value; E.panel.querySelector('#o-sfx').textContent = Math.round(st.sfx * 100) + '%'; saveSettings(); }
    else if (t.id === 'set-parallax') { st.parallax = +t.value; E.panel.querySelector('#o-parallax').textContent = Math.round(st.parallax * 100) + '%'; saveSettings(); }
    else if (t.id === 'set-sat') { st.sat = +t.value; E.panel.querySelector('#o-sat').textContent = Math.round(st.sat * 100) + '%'; saveSettings(); }
  });
  E.panel.addEventListener('change', e => {
    const t = e.target, st = game.settings;
    if (t.id === 'mk') game.do({ type: 'marketSet', bid: ctx.bid, mult: +t.value / 100 });
    else if (t.name === 'quality') { st.quality = t.value; game.setQuality?.(t.value); saveSettings(); }
    else if (t.id === 'set-name') {
      const name = t.value.trim().slice(0, 16) || 'Castaway';
      t.value = name;
      st.name = name;
      saveSettings();
      if (game.state && me() && me().name !== name) game.do({ type: 'join', name });
    }
  });
  E.panel.addEventListener('keydown', e => {   // vertical tab list: arrow keys move between sections
    if (!e.target.classList.contains('tab') || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const i = SHOP_CATS.indexOf(shopCat), n = SHOP_CATS.length;
    shopCat = SHOP_CATS[e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n];
    renderPanel();
    E.panel.querySelector('.tab.on')?.focus();
    E.panel.querySelector('.shop-list').scrollTop = 0;
  });
  E.file.addEventListener('change', () => {
    const f = E.file.files?.[0];
    E.file.value = '';
    if (!f) return;
    closeQuiet();
    game.importSave?.(f);
  });
  function saveSettings() {
    lsSet('hh-settings', JSON.stringify(game.settings));
    game.emit?.('settings', game.settings);
  }

  // ---------------------------------------------------------------- drag and drop (pointer events)
  E.panel.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const el = e.target.closest('[data-slot]');
    if (!el) return;
    const inner = e.target.closest('button');
    if (inner && inner !== el) return;            // Take / Sell buttons inside a storage row
    const src = parseSlot(el.dataset.slot);
    const st = stackAt(src);
    if (!st) return;
    drag = { src, id: st.id, el, x: e.clientX, y: e.clientY, on: false, over: null };
  });
  window.addEventListener('pointermove', e => {
    if (!drag) return;
    if (!drag.on) {
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < 6) return;
      drag.on = true;
      picked = null;
      for (const el of E.panel.querySelectorAll('.picked')) el.classList.remove('picked');
      E.ghost.innerHTML = itemIcon(drag.id);
      E.ghost.hidden = false;
      drag.el.classList.add('dragging');
      document.body.classList.add('is-dragging');
    }
    E.ghost.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-slot],[data-drop]') || null;
    if (over !== drag.over) { drag.over?.classList.remove('drop-hover'); over?.classList.add('drop-hover'); drag.over = over; }
  });
  window.addEventListener('pointerup', e => {
    if (!drag) return;
    const d = drag;
    endDrag();
    if (d.on) {
      justDragged = true;
      setTimeout(() => { justDragged = false; }, 0);
      moveTo(d.src, document.elementFromPoint(e.clientX, e.clientY));
    }
    if (pendingRender) { pendingRender = false; renderPanel(); }
  });
  window.addEventListener('pointercancel', () => cancelDrag());
  function endDrag() {
    if (!drag) return;
    drag.over?.classList.remove('drop-hover');
    drag.el.classList.remove('dragging');
    document.body.classList.remove('is-dragging');
    E.ghost.hidden = true;
    drag = null;
  }
  function cancelDrag() {
    endDrag();
    if (pendingRender) { pendingRender = false; renderPanel(); }
  }

  // ---------------------------------------------------------------- keyboard
  const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  window.addEventListener('keydown', e => {
    const typing = e.target instanceof HTMLInputElement && (e.target.type === 'text' || e.target.type === 'search');
    if (current) {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopImmediatePropagation();
        if (drag) cancelDrag();
        else if (picked) { picked = null; renderPanel(); }
        else if (confirmQuit) { confirmQuit = false; renderPanel(true); }
        else close();
        return;
      }
      if (!typing && e.code === 'KeyE' && E_CLOSES.has(current)) { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
      if (!typing && SLOT_PANELS.has(current) && /^Digit[1-9]$/.test(e.code) && hover && isSlots(hover.c) && stackAt(hover)) {
        e.preventDefault(); e.stopImmediatePropagation();
        const k = +e.code.slice(5) - 1;
        if (!(hover.c === 'inv' && hover.k === k)) xfer({ c: hover.c, k: hover.k }, { c: 'inv', k });
        return;
      }
      if (e.key === 'Tab') {
        const f = [...E.panel.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
        if (!f.length) return;
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && (i === f.length - 1 || i < 0)) { e.preventDefault(); f[0].focus(); }
      }
      return;
    }
    if (titleShown && e.key === 'Escape' && !E.tSub.hidden) { e.preventDefault(); e.stopImmediatePropagation(); showTSub(null); }
  }, true);

  // losing pointer lock in play (Esc, alt-tab) pauses the game
  document.addEventListener('pointerlockchange', () => {
    const locked = !!document.pointerLockElement;
    const lost = wasLocked && !locked;
    wasLocked = locked;
    if (!lost || current || titleShown || !game.state || !me() || game.chat?.open) return;
    if ((game.world?.cine?.letterbox || 0) > 0.02 || game.player?.enabled === false) return;
    open('pause');
  });

  // ---------------------------------------------------------------- title screen
  function hasSave() { return game.hasSave ? game.hasSave() : false; }
  function showTSub(kind) {
    if (!kind) {
      E.tSub.hidden = true; E.tSub.innerHTML = ''; E.tMenu.hidden = false;
      (E.tContinue.hidden ? E.tMenu.querySelector('[data-t="new"]') : E.tContinue).focus({ preventScroll: true });
      return;
    }
    E.tMenu.hidden = true; E.tSub.hidden = false;
    if (kind === 'confirm') {
      E.tSub.innerHTML = `<p>Start a new island? It replaces the one you have saved.</p>
        <button type="button" class="t-btn danger" data-t="newYes">Start over</button>
        <button type="button" class="t-btn" data-t="back">Keep my island</button>`;
      E.tSub.querySelector('[data-t="back"]').focus();
    } else {
      E.tSub.innerHTML = `<label for="t-code">Friend’s code</label>
        <input type="text" id="t-code" autocomplete="off" spellcheck="false" aria-describedby="t-err">
        <button type="button" class="t-btn primary" data-t="joinGo">Join</button>
        <button type="button" class="t-btn" data-t="back">Back</button>
        <p class="t-err" id="t-err" role="alert"></p>`;
      const inp = E.tSub.querySelector('#t-code');
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') E.tSub.querySelector('[data-t="joinGo"]').click(); });
      inp.focus();
    }
  }
  E.title.addEventListener('click', e => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    switch (b.dataset.t) {
      case 'continue': title(false); game.continueGame?.(); break;
      case 'new': if (hasSave()) showTSub('confirm'); else { title(false); game.newGame?.(); } break;
      case 'newYes': title(false); game.newGame?.(); break;
      case 'join': showTSub('join'); break;
      case 'joinGo': {
        const code = E.tSub.querySelector('#t-code').value.trim();
        if (!code) { E.tSub.querySelector('#t-err').textContent = 'Type the code your friend sees on their screen.'; E.tSub.querySelector('#t-code').focus(); break; }
        title(false);
        game.join?.(code);
        break;
      }
      case 'settings': open('settings', { back: 'title' }); break;
      case 'back': showTSub(null); break;
    }
  });

  function title(show) {
    titleShown = !!show;
    if (titleShown) {
      if (current) hidePanel();
      coinsShown = null; lastTut = -1; heldKey = ''; tutDoneAt = 0; prevPhase = 'calm';
      E.tContinue.hidden = !hasSave();
      E.title.hidden = false;
      root.classList.add('t-on');
      E.wordmark.classList.remove('rise'); void E.wordmark.offsetWidth; E.wordmark.classList.add('rise');
      showTSub(null);
    } else {
      E.title.hidden = true;
      root.classList.remove('t-on');
      if (current === 'settings') hidePanel();
    }
    lastLb = -1;
  }

  // ---------------------------------------------------------------- loading
  let loadEl = document.getElementById('loading');
  if (!loadEl) {
    loadEl = document.createElement('div');
    loadEl.id = 'loading';
    loadEl.className = 'loading';
    loadEl.innerHTML = '<div class="load-inner"><p class="load-mark">Harvest Haven</p><div class="load-track" role="progressbar" aria-label="Loading" aria-valuemin="0" aria-valuemax="100"><i id="load-bar"></i></div><p class="load-label" id="load-label">Loading</p></div>';
    document.body.append(loadEl);
  }
  function loading(p, label) {
    const v = clamp01(+p || 0);
    loadEl.hidden = false;
    loadEl.classList.toggle('done', v >= 1);
    const bar = loadEl.querySelector('#load-bar'), lab = loadEl.querySelector('#load-label');
    if (bar) bar.style.transform = `scaleX(${v})`;
    loadEl.querySelector('[role=progressbar]')?.setAttribute('aria-valuenow', Math.round(v * 100));
    if (label && lab) lab.textContent = label;
    if (v >= 1) setTimeout(() => { if (loadEl.classList.contains('done')) loadEl.hidden = true; }, 700);
  }

  // ---------------------------------------------------------------- game hooks
  game.on?.('fail', d => { if (d?.msg) toast(d.msg, 'warn'); });
  game.on?.('saved', () => { lastSaved = performance.now(); });

  // ---------------------------------------------------------------- per frame
  function update(dt) {
    const s = game.state;
    if (dirty.ui) {
      dirty.ui = false;
      renderHud();
      if (current && !STATIC.has(current)) renderPanel();
    }
    tickT += dt;
    if (tickT >= 0.25) { tickT = 0; tickTimers(); }
    liveT += dt;
    if (liveT >= 1) { liveT = 0; if (current && LIVE.has(current)) renderPanel(); }

    // coin counter ticks up toward the real value
    if (coinsShown !== null && coinsShown !== coinsTarget) {
      const diff = coinsTarget - coinsShown;
      coinsShown = Math.abs(diff) < 1 ? coinsTarget : coinsShown + diff * Math.min(1, dt * 7);
      E.coins.textContent = fmtNum(Math.round(coinsShown));
    }
    if (heldTimer > 0 && (heldTimer -= dt) <= 0) E.held.classList.remove('show');

    // cinematic bars + title card (world.cine), HUD visibility
    const cine = game.world?.cine;
    const lb = titleShown ? 0 : cine?.letterbox || 0;
    if (Math.abs(lb - lastLb) > 0.002) { lastLb = lb; E.lb.style.setProperty('--lb', lb.toFixed(3)); }
    const ct = (!titleShown && cine?.title) || '';
    if (ct !== lastCine) { lastCine = ct; E.cineTitle.textContent = ct; E.cineTitle.classList.toggle('show', !!ct); }
    const inPlay = !!(s && me()) && !titleShown;
    const cinematic = lb > 0.02 && !titleShown;
    if (E.hud.hidden === inPlay) E.hud.hidden = !inPlay;
    E.hud.classList.toggle('cinematic', cinematic);
    const showCh = inPlay && !current && !cinematic;
    E.ch.style.visibility = showCh ? '' : 'hidden';
    if (!showCh && !E.tip.hidden) { E.tip.hidden = true; lastTarget = '#'; }
    const resume = showCh && !document.pointerLockElement && game.player?.enabled !== false;
    if (E.resume.hidden === resume) E.resume.hidden = !resume;
  }

  const ui = {
    update, open, close,
    isOpen: () => !!current, close,
    toast, setTarget, title, loading, banner, onFx,
  };
  return ui;
}
