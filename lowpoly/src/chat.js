// Chat + commands. Press = (or /) in play to open it. Talks to friends in multiplayer, gives Biscuit orders,
// and has cheat commands that only work in single-player.
import { CROPS, CROP_LIST, ITEMS, DAY_LEN, DISASTERS, DISASTER_TIME, DISASTER_GAP } from './data.js';
import * as S from './state.js';
import { heightAt } from './terrain.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const TIMES = { dawn: 0.26, sunrise: 0.26, morning: 0.33, noon: 0.5, day: 0.5, afternoon: 0.6, sunset: 0.74, dusk: 0.74, evening: 0.78, night: 0.85, midnight: 0 };
const PLACES = { farm: [2, 76], home: [2, 76], summit: [1, -108], mountain: [-17, -52], beach: [10, 92], river: [28, 20] };

// [command, args, what it does, group]. Group 'cheat' only runs in single-player.
const CMDS = [
  ['help', '', 'List every command', 'chat'],
  ['me', '<action>', 'Say what you are doing: /me waves', 'chat'],
  ['clear', '', 'Clear the chat', 'chat'],
  ['players', '', 'Who is on the island', 'chat'],
  ['donkey follow', '', 'Biscuit follows you', 'donkey'],
  ['donkey stay', '', 'Biscuit waits where he is', 'donkey'],
  ['donkey come', '', 'Biscuit walks to you and waits', 'donkey'],
  ['donkey go', '', 'Click a spot to send Biscuit there', 'donkey'],
  ['pet', '', 'Pet Biscuit (stand next to him)', 'donkey'],
  ['coords', '', 'Where you are standing', 'info'],
  ['time', '', 'The time of day on the island', 'info'],
  ['stats', '', 'Level, coins and harvests', 'info'],
  ['coins', '<amount>', 'Add coins (negative takes them away)', 'cheat'],
  ['gems', '<amount>', 'Add gems', 'cheat'],
  ['xp', '<amount>', 'Add experience', 'cheat'],
  ['level', '<n>', 'Jump to a level', 'cheat'],
  ['give', '<item> [amount]', 'Put items in your backpack: /give carrot 20', 'cheat'],
  ['settime', '<dawn|noon|dusk|night|0-24>', 'Change the time of day', 'cheat'],
  ['weather', '<clear|storm|lightning|acid|drought|flood>', 'Start or stop weather', 'cheat'],
  ['grow', '', 'Ripen every crop now', 'cheat'],
  ['unlock', '', 'Unlock every seed', 'cheat'],
  ['tp', '<farm|summit|beach|river|trader|donkey|x z>', 'Teleport', 'cheat'],
];
const GROUPS = [['chat', 'Chat'], ['donkey', 'Biscuit'], ['info', 'Info'], ['cheat', 'Cheats · single-player']];

export function createChat(game) {
  const root = document.getElementById('ui') || document.body;
  root.insertAdjacentHTML('beforeend', `
    <div class="chat" id="chat" aria-live="polite">
      <div class="chat-log" id="chat-log"></div>
      <div class="chat-bar" id="chat-bar" hidden>
        <input id="chat-in" type="text" maxlength="200" autocomplete="off" spellcheck="false" placeholder="Say something, or type / for commands" aria-label="Chat message">
        <span class="chat-keys small muted"><kbd>Enter</kbd> send · <kbd>Tab</kbd> complete · <kbd>Esc</kbd> close</span>
      </div>
      <div class="chat-menu" id="chat-menu" hidden></div>
    </div>`);
  const log = document.getElementById('chat-log'), bar = document.getElementById('chat-bar');
  const input = document.getElementById('chat-in'), menu = document.getElementById('chat-menu');
  const history = [];
  let hi = -1;

  const chat = { open: false, add, say: text => send(text), cmds: CMDS };
  const me = () => game.state?.players?.[game.pid];
  const solo = () => game.role === 'solo';

  // ---------------------------------------------------------------- the log
  function add(html, kind = 'msg') {
    const el = document.createElement('div');
    el.className = 'chat-line c-' + kind;
    el.innerHTML = html;
    log.append(el);
    while (log.children.length > 80) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
    setTimeout(() => el.classList.add('old'), 12000);   // fades unless the chat is open
  }
  const sys = (t, kind = 'sys') => add(esc(t), kind);
  const said = (name, text, emote) => add(emote ? `<i>* ${esc(name)} ${esc(text)}</i>` : `<b>${esc(name)}</b> ${esc(text)}`, emote ? 'emote' : 'msg');
  game.on('chat', m => said(m.name, m.text, m.emote));
  game.on('net', m => {
    if (m.joined) sys(`${m.joined} joined the island`);
    if (m.left) sys(`${m.left} left the island`);
    if (m.hosting) sys(`Your island is open. Friends join with code ${m.hosting}`);
  });

  // ---------------------------------------------------------------- the menu (every command, click to use)
  function renderMenu() {
    menu.innerHTML = GROUPS.map(([g, label]) => {
      const off = g === 'cheat' && !solo();
      return `<section class="cm-g${off ? ' off' : ''}"><h4>${label}${off ? ' <span class="small muted">(off in multiplayer)</span>' : ''}</h4>
        ${CMDS.filter(c => c[3] === g).map(c => `<button type="button" class="cm-b" data-cmd="/${c[0]}${c[1] ? ' ' : ''}" ${off ? 'disabled' : ''} title="${esc(c[2])}"><code>/${c[0]}</code>${c[1] ? `<span class="muted"> ${esc(c[1])}</span>` : ''}<small>${esc(c[2])}</small></button>`).join('')}
      </section>`;
    }).join('');
  }
  menu.addEventListener('mousedown', e => e.preventDefault());   // keep focus in the input
  menu.addEventListener('click', e => {
    const b = e.target.closest('[data-cmd]');
    if (!b) return;
    const c = b.dataset.cmd;
    if (c.endsWith(' ')) { input.value = c; input.focus(); }   // needs an argument: let them type it
    else { run(c.trim()); close(); }
  });

  // ---------------------------------------------------------------- open / close
  function openChat(prefill = '') {
    if (chat.open || game.mode !== 'play' || game.ui?.isOpen?.() || game.player?.enabled === false) return;
    chat.open = true;
    renderMenu();
    bar.hidden = false; menu.hidden = false;
    document.getElementById('chat').classList.add('on');
    game.player?.unlock?.();
    input.value = prefill; hi = -1;
    setTimeout(() => input.focus(), 0);
  }
  function close() {
    if (!chat.open) return;
    chat.open = false;
    bar.hidden = true; menu.hidden = true;
    document.getElementById('chat').classList.remove('on');
    input.blur();
    game.player?.lock?.();
  }
  chat.openChat = openChat; chat.close = close;

  window.addEventListener('keydown', e => {
    if (chat.open || e.repeat) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === '=' || e.code === 'Equal' && !e.shiftKey) { e.preventDefault(); openChat(); }
    else if (e.key === '/' || e.code === 'Slash') { e.preventDefault(); openChat('/'); }
  });
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter') { e.preventDefault(); const t = input.value.trim(); if (t) { history.unshift(t); history.length = Math.min(history.length, 30); run(t); } close(); }
    else if (e.key === 'ArrowUp' && history.length) { e.preventDefault(); hi = Math.min(history.length - 1, hi + 1); input.value = history[hi]; }
    else if (e.key === 'ArrowDown') { e.preventDefault(); hi = Math.max(-1, hi - 1); input.value = hi < 0 ? '' : history[hi]; }
    else if (e.key === 'Tab') {
      e.preventDefault();
      const v = input.value.toLowerCase();
      if (!v.startsWith('/')) return;
      const hits = CMDS.map(c => '/' + c[0]).filter(c => c.startsWith(v));
      if (hits.length === 1) input.value = hits[0] + ' ';
      else if (hits.length > 1) { let p = hits[0]; for (const h of hits) while (!h.startsWith(p)) p = p.slice(0, -1); input.value = p; sys(hits.join('   ')); }
    }
  });
  input.addEventListener('keyup', e => e.stopPropagation());

  // ---------------------------------------------------------------- sending
  function send(text, emote = false) {
    const name = me()?.name || game.settings.name || 'Castaway';
    if (game.role === 'solo') said(name, text, emote);
    else game.net.chat(text, emote);
  }

  // ---------------------------------------------------------------- commands
  function run(text) {
    if (!text.startsWith('/')) return send(text);
    const [cmd0, ...args] = text.slice(1).trim().split(/\s+/);
    const cmd = (cmd0 || '').toLowerCase();
    const def = CMDS.find(c => c[0].split(' ')[0] === cmd);
    if (!def) return sys(`No command /${cmd}. Type /help to see them all.`, 'err');
    if (def[3] === 'cheat' && !solo()) return sys('Cheats only work in single-player.', 'err');
    try { (C[cmd] || (() => {}))(args); }
    catch (e) { console.error(e); sys('That did not work: ' + e.message, 'err'); }
  }
  const s = () => game.state;
  const changed = () => { S.dirty.all = true; S.dirty.ui = true; s().rev++; };
  const cheat = msg => sys('Cheat: ' + msg, 'cheat');
  const num = (v, what) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`give a number for ${what}`); return n; };
  const donkeyDist = () => { const p = game.player?.pos, d = game.donkey; return p && d ? Math.hypot(p.x - d.x, p.z - d.z) : Infinity; };
  const findItem = q => {
    const k = q.toLowerCase().replace(/[\s-]+/g, '_');
    if (ITEMS[k]) return k;
    const byName = Object.entries(ITEMS).find(([, it]) => it.name.toLowerCase().replace(/[\s-]+/g, '_') === k);
    if (byName) return byName[0];
    const part = Object.entries(ITEMS).find(([id, it]) => id.includes(k) || it.name.toLowerCase().includes(q.toLowerCase()));
    return part?.[0] || null;
  };

  const C = {
    help(a) {
      for (const [g, label] of GROUPS) {
        if (g === 'cheat' && !solo()) { sys('Cheats: off in multiplayer'); continue; }
        add(`<b>${label}</b> ${CMDS.filter(c => c[3] === g).map(c => `<code>/${esc(c[0])}</code>`).join(' ')}`, 'sys');
      }
      sys('Click a command in the menu to use it, or press Tab to finish typing one.');
    },
    me(a) { if (a.length) send(a.join(' '), true); },
    clear() { log.innerHTML = ''; },
    players() {
      const names = Object.entries(s().players).map(([pid, p]) => p.name + (pid === game.pid ? ' (you)' : ''));
      sys(`On the island: ${names.join(', ')}`);
    },
    donkey(a) {
      const m = (a[0] || '').toLowerCase(), D = game.donkey, P = game.player?.pos;
      if (m === 'follow') game.do({ type: 'donkey', m: 'follow' });
      else if (m === 'stay') game.do({ type: 'donkey', m: 'stay', x: D.x, z: D.z });
      else if (m === 'come') { if (P) game.do({ type: 'donkey', m: 'go', x: P.x, z: P.z }); }
      else if (m === 'go') game.player?.pickDonkeySpot?.();
      else {
        const c = s().donkey.cmd;
        sys(`Biscuit is ${!c ? 'following you' : c.m === 'stay' ? 'waiting' : 'heading somewhere'} (${Math.round(donkeyDist())} m away). Try /donkey follow, stay, come or go.`);
      }
    },
    pet() {
      if (donkeyDist() > 6) return sys('Biscuit is too far away to pet. Walk up to him first.', 'err');
      game.do({ type: 'pet' });
    },
    coords() { const p = game.player.pos; sys(`You are at x ${p.x.toFixed(1)}, z ${p.z.toFixed(1)} (height ${p.y.toFixed(1)} m)`); },
    time() {
      const t = game.world.dayTime() * 24, h = Math.floor(t), m = Math.floor((t - h) * 60);
      sys(`It is ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} on the island. A full day lasts ${Math.round(DAY_LEN / 60)} minutes.`);
    },
    stats() {
      const st = s();
      sys(`Level ${st.lv} · ${st.coins.toLocaleString()} coins · ${st.gems} gems · ${st.stats.harvests} harvests · ${st.crops.length} of ${CROP_LIST.length} seeds unlocked · Biscuit petted ${st.donkey.pets || 0} time${st.donkey.pets === 1 ? '' : 's'}`);
    },
    // ---- cheats (single-player only; run() checks)
    coins(a) { const n = Math.round(num(a[0], 'coins')); s().coins = Math.max(0, s().coins + n); changed(); cheat(`${n >= 0 ? '+' : ''}${n.toLocaleString()} coins`); },
    gems(a) { const n = Math.round(num(a[0], 'gems')); s().gems = Math.max(0, s().gems + n); changed(); cheat(`${n >= 0 ? '+' : ''}${n} gems`); },
    xp(a) { const n = Math.round(num(a[0], 'xp')); if (n > 0) S.addXp(s(), n); changed(); cheat(`+${n} xp (level ${s().lv})`); },
    level(a) { const n = Math.max(1, Math.min(99, Math.round(num(a[0], 'the level')))); s().lv = n; s().xp = 0; changed(); cheat(`level ${n}`); },
    give(a) {
      const amtLast = a.length > 1 && Number.isFinite(Number(a.at(-1)));
      const n = amtLast ? Math.max(1, Math.round(Number(a.at(-1)))) : 1;
      const q = (amtLast ? a.slice(0, -1) : a).join(' ');
      if (!q) throw new Error('say which item, e.g. /give carrot 20');
      const id = findItem(q);
      if (!id) return sys(`No item called "${q}".`, 'err');
      const left = S.addItem(s(), me().inv, S.invSize(s()), id, n);
      changed();
      cheat(`${n - left} × ${ITEMS[id].name}${left ? ` (${left} didn’t fit)` : ''}`);
    },
    settime(a) {
      const v = (a[0] || '').toLowerCase();
      let t = TIMES[v];
      if (t == null) { const h = Number(v.replace(':', '.')); if (!Number.isFinite(h) || h < 0 || h > 24) throw new Error('use dawn, noon, dusk, night or an hour 0-24'); t = h / 24; }
      const now = game.now();
      s().created = now - (((t - 0.235) % 1 + 1) % 1) * DAY_LEN * 1000;   // world.dayTime() counts from 'created'
      cheat(`time set to ${v}`);
    },
    weather(a) {
      const k = (a[0] || '').toLowerCase(), now = game.now();
      if (k === 'clear' || k === 'calm' || k === 'off') game.hostApply({ type: 'weather', w: { kind: null, phase: 'calm', t0: now, t1: 0, next: now + DISASTER_GAP[1] * 1000 }, quiet: true });
      else if (DISASTERS[k]) game.hostApply({ type: 'weather', w: { kind: k, phase: 'active', t0: now, t1: now + DISASTER_TIME * 1000 }, quiet: true });
      else throw new Error('use clear, ' + Object.keys(DISASTERS).join(', '));
      cheat(k === 'clear' || k === 'calm' || k === 'off' ? 'weather cleared' : DISASTERS[k].name);
    },
    grow() {
      const now = game.now();
      let n = 0;
      for (const t of s().tiles) if (t.c && S.progress(t.c, now) < 1) { t.c.g = CROPS[t.c.id].grow; t.c.t = now; n++; }
      changed(); cheat(`${n} crops ripened`);
    },
    unlock() { s().crops = CROP_LIST.map(c => c.id); changed(); cheat('every seed unlocked'); },
    tp(a) {
      const w = (a[0] || '').toLowerCase();
      let xz = PLACES[w];
      if (w === 'trader') xz = [game.trader.x + 2, game.trader.z + 2];
      if (w === 'donkey') xz = [game.donkey.x + 1.5, game.donkey.z + 1.5];
      if (!xz && a.length >= 2) xz = [num(a[0], 'x'), num(a[1], 'z')];
      if (!xz) throw new Error('use farm, summit, beach, river, trader, donkey or x z');
      if (heightAt(xz[0], xz[1]) < -0.5) return sys('That spot is in the sea.', 'err');
      game.player.spawn(xz[0], xz[1], game.player.yaw);
      cheat(`teleported to ${w in PLACES || w === 'trader' || w === 'donkey' ? w : xz.map(v => v.toFixed(0)).join(', ')}`);
    },
  };

  sys('Press = to chat. Type /help for commands.');
  return chat;
}
