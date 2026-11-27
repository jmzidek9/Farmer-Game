// Harvest Haven — boot, game loop, saving, and the solo/host/guest action pipeline.
import * as THREE from 'three';
import { loadAssets } from './assets.js';
import { createWorld } from './world.js';
import { createView } from './view.js';
import { createPlayer } from './player.js';
import { createUI } from './ui.js';
import { createAudio } from './audio.js';
import { createNet } from './net.js';
import { createChat } from './chat.js';
import { playIntro, playEnding } from './cinematic.js';
import * as S from './state.js';
import { heightAt } from './terrain.js';

const SAVE_KEY = 'hh-save-2',   // v2: farm grid moved to the south beach; v1 saves stay under 'hh-save', unused
      SETTINGS_KEY = 'hh-settings';
const DEFAULTS = { quality: 'high', sens: 1, music: 0.6, sfx: 0.8, name: 'Castaway', parallax: 1, sat: 1, viewDist: 1, shadows: 'high', ao: true, dof: true, reflections: true };

const listeners = {};
const game = {
  state: null, pid: 'p1', hostPid: 'p1', role: 'solo', mode: 'boot', clockOffset: 0,
  settings: { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') },
  remotes: new Map(), donkey: { x: 0, z: 70, yaw: 0, moving: false }, trader: { x: -80, z: 14 },
  cinematic: null,
  now: () => Date.now() + game.clockOffset,
  on(evt, fn) { (listeners[evt] ||= []).push(fn); },
  emit(evt, data) { for (const fn of listeners[evt] || []) try { fn(data); } catch (e) { console.error(e); } },
};
window.game = game;   // handy for debugging in the console

// ---------------------------------------------------------------- the action pipeline
game.do = a => {
  if (!game.state || game.mode !== 'play') return;
  a.pid = a.pid || game.pid;
  if (game.role === 'guest') {
    // selection is cosmetic and local-first so the hotbar feels instant
    if (a.type === 'sel') S.apply(game.state, a);
    game.net.sendAction(a);
    return;
  }
  game.hostApply(a, null);
};
game.hostApply = (a, fromPid) => {
  S.resolve(game.state, a, game.now());
  const r = S.apply(game.state, a);
  if (!r.ok) {
    if (fromPid) game.net.fail(fromPid, r.msg);
    else if (r.msg && !a.quiet) game.emit('fail', { msg: r.msg });
    return r;
  }
  game.net.broadcast(a);
  return r;
};
game.guestApply = a => {
  if (!game.state) return;
  if (a.type === 'sel' && a.pid === game.pid) return;        // already applied locally
  S.apply(game.state, a);
};
const hostEmit = a => { a.quiet = true; game.hostApply(a, null); };

// ---------------------------------------------------------------- saving
game.save = () => {
  if (!game.state || game.role === 'guest' || game.mode !== 'play') return;
  const me = game.state.players[game.pid];
  if (me && game.player) me.pos = [game.player.pos.x, game.player.pos.z, game.player.yaw];
  try {
    localStorage.setItem(SAVE_KEY, S.serialize(game.state, game.now()));
    game.emit('saved');
  } catch (e) { game.emit('fail', { msg: 'Could not save: ' + e.message }); }
};
game.hasSave = () => !!localStorage.getItem(SAVE_KEY);
game.exportSave = () => {
  game.save();
  const blob = new Blob([localStorage.getItem(SAVE_KEY) || ''], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `harvest-haven-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
game.importSave = async file => {
  try {
    const text = await file.text();
    const s = JSON.parse(text);
    if (!Array.isArray(s.tiles) || s.tiles.length !== 1600 || !s.players) throw new Error('This file is not a Harvest Haven save.');
    if ((s.v || 1) < 2) throw new Error('This save is from an older island layout and can’t be loaded. Start a new world.');
    localStorage.setItem(SAVE_KEY, text);
    if (game.mode === 'play') game.quitToTitle(false);
    await game.continueGame();
  } catch (e) { game.emit('fail', { msg: e.message }); }
};
game.saveSettings = () => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(game.settings));
  game.audio?.volumes();
};
game.setQuality = q => { game.settings.quality = q; game.world.setQuality(q); game.saveSettings(); };

// ---------------------------------------------------------------- starting and stopping
function enterWorld(state) {
  game.state = state;
  game.world.setShipRepaired?.(!!state.won);
  S.dirty.all = true; S.dirty.ui = true;
  S.fx.length = 0;
  game.view.sync();
}
game.enterWorld = state => enterWorld(state);
function spawnMe() {
  const me = game.state.players[game.pid];
  if (me?.pos) game.player.spawn(me.pos[0], me.pos[1], me.pos[2]);
  else game.player.spawn(0, 79, Math.PI);           // facing north, toward the farm
}
function play() {
  game.mode = 'play';
  game.ui.title(false);
  game.player.enabled = true;
  game.player.lock?.();
  S.dirty.ui = true;
}
game.newGame = async () => {
  game.audio.init();
  game.net.close(); game.role = 'solo'; game.pid = 'p1'; game.hostPid = 'p1'; game.clockOffset = 0;
  const s = S.newWorld(Math.floor(Math.random() * 1e9), game.now());
  S.addPlayer(s, game.pid, game.settings.name);
  enterWorld(s);
  game.ui.title(false);
  game.mode = 'intro';
  game.player.enabled = false;
  await playIntro(game);
  spawnMe();
  play();
  game.save();
};
game.continueGame = async () => {
  game.audio.init();
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return game.newGame();
  game.net.close(); game.role = 'solo'; game.pid = 'p1'; game.hostPid = 'p1'; game.clockOffset = 0;
  const s = S.deserialize(raw);
  S.addPlayer(s, game.pid, game.settings.name);
  const away = game.now() - (s.saved || game.now());
  S.catchUp(s, game.now());
  enterWorld(s);
  spawnMe();
  play();
  if (away > 60e3) game.ui.banner('Welcome back', `You were away ${Math.round(away / 60000)} minutes — your crops kept growing.`);
};
game.host = async () => {
  if (game.role === 'guest') return null;
  const code = await game.net.host();
  S.dirty.ui = true;
  return code;
};
game.join = async code => {
  game.audio.init();
  try {
    const { pid, state } = await game.net.join(code, game.settings.name);
    game.pid = pid;
    enterWorld(S.deserialize(state));
    const h = game.remotes.get(game.hostPid);
    const me = game.state.players[pid];
    if (me?.pos) game.player.spawn(me.pos[0], me.pos[1], me.pos[2]);
    else { const hp = game.state.players[game.hostPid]?.pos; game.player.spawn(hp ? hp[0] + 2 : 4, hp ? hp[1] + 2 : 76, Math.PI); }
    play();
    game.ui.banner('You washed up together', 'Same island, same farm, one shared wallet.');
    return true;
  } catch (e) {
    game.role = 'solo';
    game.emit('fail', { msg: e.message });
    return false;
  }
};
// the ending: plays once when the ship is repaired, then back to the farm
game.ending = async () => {
  if (game.mode !== 'play') return;
  game.ui.close?.();
  game.mode = 'intro';
  game.player.enabled = false;
  game.player.unlock?.();
  await playEnding(game);
  game.world.setShipRepaired(true);
  play();
  game.save();
};
game.quitToTitle = (save = true) => {
  if (save) game.save();
  game.net.close();
  game.role = 'solo'; game.pid = 'p1'; game.clockOffset = 0;
  game.mode = 'title';
  game.player.enabled = false;
  game.player.unlock?.();
  game.ui.close?.();
  game.ui.title(true);
};

game.on('settings', () => game.audio?.volumes());
game.on('net', e => {
  if (e?.joined) game.ui.toast(`${e.joined} joined your island`, 'good');
  if (e?.left) game.ui.toast(`${e.left} left`, 'info');
  if (e?.lost) { game.ui.toast('The connection to your friend’s world was lost', 'warn'); game.quitToTitle(false); }
});

// ---------------------------------------------------------------- title flyover
let fly = 0;
const TITLE_TIME = 0.3;
function titleCamera(dt) {
  fly += dt * 0.035;
  const cam = game.world.camera;
  const r = 118, x = Math.cos(fly) * r, z = Math.sin(fly) * r + 10;
  cam.position.set(x, Math.max(heightAt(x, z), 0) + 26 + Math.sin(fly * 2.3) * 4, z);
  cam.lookAt(0, 4, 8);
  game.world.cine.letterbox = 0;
  game.world.cine.time = TITLE_TIME;   // the title always shows a warm morning
}

// ---------------------------------------------------------------- loop
let last = performance.now(), saveT = 0, tickErr = 0, lastFrame = 0;
function frame(t) {
  requestAnimationFrame(frame);
  lastFrame = performance.now();
  const dt = Math.min(0.05, (t - last) / 1000);
  last = t;
  const now = game.now();
  try {
    if (game.mode === 'title') titleCamera(dt);
    else if (game.world.cine.time === TITLE_TIME) game.world.cine.time = null;
    if (game.cinematic) game.cinematic(dt);
    if (game.mode === 'play') {
      if (game.role !== 'guest') S.tick(game.state, now, hostEmit);
      game.player.update(dt);
      saveT += dt;
      if (saveT > 10) { saveT = 0; game.save(); }
    }
    if (game.state) {
      game.view.sync();
      game.view.update(dt, now);
      if (S.fx.length) {
        const list = S.fx.splice(0);
        if (list.some(f => f.k === 'ending')) game.ending();
        game.view.onFx(list);
        game.audio.onFx(list);
        game.ui.onFx(list);
      }
    }
    game.ui.update(dt);
    game.world.update(dt, now);
    game.world.render();
    game.audio.update(dt);
    game.net.update(dt);
  } catch (e) {
    if (tickErr++ < 5) console.error(e);
  }
}

// While the tab is hidden or covered the browser stops requestAnimationFrame. In a shared world keep the essentials going
// on a timer (browsers run it about once a second in the background): the host keeps the island ticking and
// saving, and everyone keeps sending their position so friends don't see a frozen player.
let bgLast = 0;
setInterval(() => {
  const t = performance.now();
  if (t - lastFrame < 500 || game.mode !== 'play' || game.role === 'solo' || !game.state) { bgLast = 0; return; }
  const dt = bgLast ? Math.min(5, (t - bgLast) / 1000) : 1;
  bgLast = t;
  try {
    if (game.role !== 'guest') {
      S.tick(game.state, game.now(), hostEmit);
      saveT += dt;
      if (saveT > 10) { saveT = 0; game.save(); }
    }
    S.fx.length = 0;                       // nobody is watching the effects
    game.net.update(dt);
  } catch (e) {
    if (tickErr++ < 5) console.error(e);
  }
}, 250);

// ---------------------------------------------------------------- boot
async function boot() {
  game.ui = createUI(game);
  game.ui.loading(0, 'Washing ashore…');
  await loadAssets(p => game.ui.loading(p * 0.9, 'Building the island…'));
  game.world = createWorld(document.getElementById('game'), game);
  game.audio = createAudio(game);
  game.net = createNet(game);
  game.chat = createChat(game);
  // a preview world behind the title screen
  const preview = game.hasSave() ? S.deserialize(localStorage.getItem(SAVE_KEY)) : S.newWorld(7, game.now());
  if (!Object.keys(preview.players).length) S.addPlayer(preview, 'p1', game.settings.name);
  game.state = preview;
  game.view = createView(game);
  game.player = createPlayer(game);
  game.player.enabled = false;
  enterWorld(preview);
  game.world.setQuality(game.settings.quality);
  game.ui.loading(0.95, 'Warming up…');
  await game.world.warmup();
  game.ui.loading(1, 'Ready');
  game.mode = 'title';
  game.ui.title(true);
  if (new URLSearchParams(location.search).has('trailer')) import('./trailer.js').then(m => m.recordTrailer(game)).then(r => console.log('trailer saved', r));   // dev: films the trailer
  addEventListener('resize', () => game.world.resize());
  addEventListener('beforeunload', () => game.save());
  addEventListener('pointerdown', () => game.audio.init(), { once: true });
  addEventListener('keydown', () => game.audio.init(), { once: true });
  requestAnimationFrame(frame);
}
boot().catch(e => {
  console.error(e);
  const el = document.createElement('pre');
  el.textContent = 'Harvest Haven could not start:\n' + (e.stack || e.message);
  Object.assign(el.style, { position: 'fixed', inset: '20px', color: '#F3E3C3', background: 'rgba(40,28,20,.9)', padding: '20px', borderRadius: '12px', zIndex: 99, whiteSpace: 'pre-wrap' });
  document.body.appendChild(el);
});
