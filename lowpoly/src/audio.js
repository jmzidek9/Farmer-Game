// Procedural audio (Web Audio API only): island music, ambience, and every sound effect.
// Music has four moods (day, sunset, night, storm) that crossfade; effects are panned by where they happen.
import { tileX, tileZ, riverX, RIVER_Z0 } from './terrain.js';

const N = n => 440 * Math.pow(2, (n - 69) / 12);          // midi -> Hz
const rnd = (a, b) => a + Math.random() * (b - a);

export function createAudio(game) {
  let ctx = null, master, music, musicIn, fade, sfx, amb, verb, noiseBuf;
  const amb_ = {};
  let seq = null, mood = 'day', playing = 'day', forced = null;

  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 1.6; master.connect(ctx.destination);
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.25;
    comp.connect(master);
    music = ctx.createGain(); sfx = ctx.createGain(); amb = ctx.createGain();
    musicIn = ctx.createGain(); fade = ctx.createGain(); musicIn.connect(fade).connect(music);
    // reverb: a short pre-delay and a darkened tail so it sounds like warm air, not a tin can
    verb = ctx.createConvolver(); verb.buffer = impulse(3.2);
    const pre = ctx.createDelay(0.1); pre.delayTime.value = 0.025;
    const damp = ctx.createBiquadFilter(); damp.type = 'lowpass'; damp.frequency.value = 4200;
    const vg = ctx.createGain(); vg.gain.value = 0.34;
    pre.connect(damp).connect(verb).connect(vg).connect(comp);
    for (const g of [music, sfx, amb]) g.connect(comp);
    music.connect(pre); sfx.connect(pre);
    const ambVerb = ctx.createGain(); ambVerb.gain.value = 0.4; amb.connect(ambVerb).connect(pre);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    volumes();
    startAmbience();
    startMusic();
  }
  function impulse(sec) {
    const len = ctx.sampleRate * sec, b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) { lp += ((Math.random() * 2 - 1) - lp) * (0.55 - 0.4 * i / len); d[i] = lp * Math.pow(1 - i / len, 2.6); }
    }
    return b;
  }
  function volumes() {
    if (!ctx) return;
    const s = game.settings;
    music.gain.value = 0.6 * (s.music ?? 0.6);
    sfx.gain.value = 0.9 * (s.sfx ?? 0.8);
    amb.gain.value = 0.75 * (s.sfx ?? 0.8);
  }

  // ---------------------------------------------------------------- building blocks
  const out = (dest, pan) => {
    if (!pan) return dest;
    const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan)); p.connect(dest); return p;
  };
  function tone(f, { type = 'sine', t = 0, dur = 0.2, gain = 0.2, attack = 0.005, lpf = 6000, to = null, dest = sfx, detune = 0, pan = 0 } = {}) {
    const st = ctx.currentTime + t;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, st); o.detune.value = detune;
    if (to) o.frequency.exponentialRampToValueAtTime(to, st + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, st); g.gain.exponentialRampToValueAtTime(gain, st + attack); g.gain.exponentialRampToValueAtTime(0.0001, st + dur);
    const fl = ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = lpf;
    o.connect(fl).connect(g).connect(out(dest, pan));
    o.start(st); o.stop(st + dur + 0.05);
  }
  function noise({ t = 0, dur = 0.3, gain = 0.2, lpf = 4000, hpf = 0, attack = 0.005, bp = 0, q = 1, dest = sfx, sweep = null, pan = 0 } = {}) {
    const st = ctx.currentTime + t;
    const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    let node = src;
    const add = (type, f) => { const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; node.connect(fl); node = fl; return fl; };
    if (hpf) add('highpass', hpf);
    if (bp) add('bandpass', bp);
    const lp = add('lowpass', lpf);
    if (sweep) lp.frequency.exponentialRampToValueAtTime(sweep, st + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, st); g.gain.exponentialRampToValueAtTime(gain, st + attack); g.gain.exponentialRampToValueAtTime(0.0001, st + dur);
    node.connect(g).connect(out(dest, pan));
    src.start(st, Math.random()); src.stop(st + dur + 0.05);
  }
  // instruments
  function pluck(f, t, gain = 0.1, dur = 0.9, dest = musicIn, pan = 0) {
    tone(f, { type: 'triangle', t, dur, gain, attack: 0.004, lpf: 2600, dest, pan });
    tone(f * 2, { type: 'sine', t, dur: dur * 0.4, gain: gain * 0.35, attack: 0.002, lpf: 4000, dest, pan });
  }
  function marimba(f, t, gain = 0.08, dest = musicIn, pan = 0) {
    tone(f, { type: 'sine', t, dur: 0.8, gain, attack: 0.003, dest, pan });
    tone(f * 3.9, { type: 'sine', t, dur: 0.12, gain: gain * 0.4, attack: 0.002, dest, pan });
  }
  function celesta(f, t, gain = 0.05, pan = 0) {
    tone(f, { type: 'sine', t, dur: 1.8, gain, attack: 0.004, dest: musicIn, pan });
    tone(f * 2, { type: 'sine', t, dur: 0.9, gain: gain * 0.3, attack: 0.003, dest: musicIn, pan });
    tone(f * 4.02, { type: 'sine', t, dur: 0.25, gain: gain * 0.15, attack: 0.002, dest: musicIn, pan });
  }
  // a soft sustained chord: two detuned voices per note, slow swell in and out
  function pad(notes, t, dur, gain = 0.03, lpf = 1400, type = 'triangle') {
    const st = ctx.currentTime + t;
    const fl = ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = lpf; fl.Q.value = 0.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, st); g.gain.linearRampToValueAtTime(gain, st + Math.min(1.2, dur * 0.4));
    g.gain.setValueAtTime(gain, st + dur * 0.7); g.gain.linearRampToValueAtTime(0.0001, st + dur + 0.8);
    fl.connect(g).connect(musicIn);
    notes.forEach((n, i) => [-7, 7].forEach(dt => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = N(n); o.detune.value = dt + i * 2;
      const p = ctx.createStereoPanner(); p.pan.value = dt < 0 ? -0.35 : 0.35;
      o.connect(p).connect(fl); o.start(st); o.stop(st + dur + 0.9);
    }));
  }
  const kick = (t, g = 0.18) => tone(120, { t, dur: 0.22, gain: g, to: 42, attack: 0.002, lpf: 800, dest: musicIn });
  const rim = (t, g = 0.03) => { tone(1700, { t, dur: 0.04, gain: g, type: 'triangle', dest: musicIn, pan: 0.2 }); noise({ t, dur: 0.03, gain: g * 0.8, bp: 2500, q: 3, dest: musicIn, pan: 0.2 }); };
  const shaker = (t, g = 0.015, pan = -0.3) => noise({ t, dur: 0.06, gain: g, hpf: 6000, lpf: 12000, dest: musicIn, pan });
  const tom = (t, f = 90, g = 0.14) => { tone(f, { t, dur: 0.4, gain: g, to: f * 0.6, attack: 0.003, lpf: 900, dest: musicIn }); noise({ t, dur: 0.08, gain: g * 0.4, lpf: 1500, dest: musicIn }); };

  // ---------------------------------------------------------------- music
  const DAY = [[60, 64, 67], [59, 62, 67], [57, 60, 64], [53, 57, 60], [60, 64, 67], [52, 55, 59], [53, 57, 60], [55, 59, 62]];   // C G/B Am F C Em F G
  const NIGHT = [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [48, 52, 55, 59], [57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 64], [48, 52, 55, 59]];   // Fmaj7 Em7 Dm7 Cmaj7 Am7 Fmaj7 G6 Cmaj7
  const STORM = [[57, 60, 64], [53, 57, 60], [50, 53, 57], [52, 56, 59]];   // Am F Dm E
  const MELODIES = [
    [76, 0, 74, 72, 0, 69, 72, 0, 74, 0, 76, 79, 0, 76, 74, 0],
    [72, 0, 0, 74, 76, 0, 74, 72, 69, 0, 67, 0, 69, 72, 0, 0],
    [79, 0, 76, 0, 74, 76, 0, 72, 0, 74, 0, 69, 72, 0, 0, 0],
    [0, 0, 72, 74, 0, 76, 0, 0, 79, 76, 0, 74, 0, 72, 0, 0],
  ];
  const BPM = { day: 92, sunset: 80, night: 64, storm: 104 };
  function startMusic(k0 = 0) {
    if (seq) clearTimeout(seq.id);
    let next = ctx.currentTime + 0.3, k = k0, phrase = 0, switching = false;
    fade.gain.value = 1;
    seq = { id: 0 };
    const run = () => {
      // crossfade: fade the old mood out, swap, fade the new one in
      if (mood !== playing && !switching) {
        switching = true;
        fade.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.6);
        setTimeout(() => { playing = mood; k = 0; next = ctx.currentTime + 0.1; fade.gain.setTargetAtTime(1, ctx.currentTime, 1.2); switching = false; }, 2200);
      }
      const step = 60 / BPM[playing] / 2;
      while (next < ctx.currentTime + 0.25) {
        const t = Math.max(0, next - ctx.currentTime), s8 = k % 8, bar = Math.floor(k / 8), section = Math.floor(k / 64) % 4;
        if (!switching) play8(playing, t, k, s8, bar, section, step, () => phrase, v => (phrase = v));
        k++; next += step;
      }
      seq.id = setTimeout(run, 40);
    };
    run();
  }
  function play8(m, t, k, s8, bar, section, step, getP, setP) {
    if (m === 'day' || m === 'sunset') {
      const ch = DAY[bar % 8];
      if (k % 32 === 0) setP((getP() + 1 + Math.floor(Math.random() * 2)) % MELODIES.length);
      if (s8 === 0) { pad(ch, t, step * 8, m === 'day' ? 0.022 : 0.03, m === 'day' ? 1500 : 1100); tone(N(ch[0] - 24), { type: 'sine', t, dur: step * 3.5, gain: 0.15, lpf: 400, dest: musicIn }); }
      if (s8 === 4) tone(N(ch[0] - 24 + (bar % 2 ? 7 : 0)), { type: 'sine', t, dur: step * 3, gain: 0.12, lpf: 400, dest: musicIn });
      if (m === 'day') {
        if (s8 === 0 || s8 === 3 || s8 === 4 || s8 === 6) ch.forEach((n, x) => pluck(N(n), t + x * 0.016, s8 === 0 ? 0.05 : 0.035, 0.8, musicIn, 0.3));   // island strum
        if (section !== 0) { if (s8 === 0 || s8 === 4) kick(t, s8 ? 0.11 : 0.15); if (s8 === 2 || s8 === 6) rim(t); }
        if (section !== 3) shaker(t, s8 % 2 ? 0.016 : 0.009);
        const mel = MELODIES[getP()][k % 16];
        if (mel && (section === 1 || section === 2 || (section === 3 && k % 3 === 0))) marimba(N(mel + (section === 2 && k % 32 >= 16 ? 12 : 0)), t, 0.065, musicIn, -0.25);
      } else {   // sunset: rippling arpeggio, sparse melody
        const arp = [0, 1, 2, 1, 2, 3, 2, 1][s8], n = (ch[arp % 3] || ch[0]) + (arp === 3 ? 12 : 12);
        pluck(N(n), t, 0.035, 1.1, musicIn, s8 % 2 ? 0.4 : -0.4);
        const mel = MELODIES[getP()][k % 16];
        if (mel && section % 2 === 1 && k % 2 === 0) marimba(N(mel), t, 0.05, musicIn, -0.2);
      }
    } else if (m === 'night') {
      const ch = NIGHT[bar % 8];
      if (s8 === 0) { pad(ch, t, step * 8, 0.028, 900); tone(N(ch[0] - 24), { type: 'sine', t, dur: step * 7, gain: 0.11, lpf: 300, dest: musicIn }); }
      if (s8 % 2 === 0 && Math.random() < 0.5) celesta(N(ch[Math.floor(Math.random() * ch.length)] + 12), t, 0.04, rnd(-0.6, 0.6));
      if (s8 === 6 && bar % 2 === 1 && Math.random() < 0.6) celesta(N(ch[3] + 24), t, 0.025, rnd(-0.8, 0.8));
    } else {   // storm
      const ch = STORM[bar % 4];
      tone(N(ch[0] - 24), { type: 'sawtooth', t, dur: step * 0.9, gain: s8 % 2 ? 0.035 : 0.055, lpf: 500, attack: 0.01, dest: musicIn });
      if (s8 === 0) { pad(ch.map(n => n - 12), t, step * 8, 0.03, 1300, 'sawtooth'); kick(t, 0.16); }
      if (s8 === 3 || s8 === 6) tom(t, s8 === 3 ? 110 : 82);
      if (s8 === 4 && bar % 2) noise({ t, dur: 0.5, gain: 0.03, hpf: 4000, lpf: 9000, attack: 0.3, dest: musicIn });
    }
  }

  // ---------------------------------------------------------------- ambience
  function loopNoise(name, { lpf = 1000, hpf = 0, bp = 0, q = 1, pan = 0 }) {
    const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    let node = src;
    const add = (type, f) => { const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; node.connect(fl); node = fl; return fl; };
    if (hpf) add('highpass', hpf);
    if (bp) add('bandpass', bp);
    const lp = add('lowpass', lpf);
    const g = ctx.createGain(); g.gain.value = 0;
    node.connect(g).connect(out(amb, pan));
    src.start(0, Math.random() * 2);
    amb_[name] = { g, lp };
  }
  function startAmbience() {
    loopNoise('waves', { lpf: 700 });
    loopNoise('wind', { bp: 500, q: 0.8, lpf: 2000 });
    loopNoise('leaves', { bp: 2600, q: 0.6, lpf: 7000, pan: 0.2 });
    loopNoise('rain', { hpf: 1500, lpf: 9000 });
    loopNoise('brook', { bp: 1700, q: 1.6, lpf: 4000, pan: -0.15 });
  }
  const crickets = Array.from({ length: 5 }, () => ({ f: rnd(3700, 4900), pan: rnd(-0.9, 0.9), t: rnd(0, 2), gap: rnd(0.5, 1.4) }));
  let birdT = 0, waveT = 0, surfT = 2, gullT = 6, frogT = 3, owlT = 30, dropT = 0;
  function waterNear(p) {
    const dr = p.z > RIVER_Z0 - 8 ? Math.abs(p.x - riverX(Math.max(p.z, RIVER_Z0))) : 99;
    return Math.min(dr, Math.hypot(p.x + 14, p.z - 6));
  }
  function ambience(dt) {
    const w = game.state?.weather || {}, active = w.phase === 'active', warn = w.phase === 'warn';
    const p = game.player?.pos || { x: 0, z: 80 };
    const r = Math.hypot(p.x, p.z);
    const coast = Math.min(1, Math.max(0.12, (r - 40) / 45));
    waveT += dt;
    const swell = 0.5 + 0.5 * Math.sin(waveT * 0.7) * Math.sin(waveT * 0.23 + 1);
    const set = (n, v, f) => { const a = amb_[n]; if (!a) return; a.g.gain.setTargetAtTime(v, ctx.currentTime, 0.5); if (f) a.lp.frequency.setTargetAtTime(f, ctx.currentTime, 0.5); };
    const day = game.world?.dayTime ? game.world.dayTime() : 0.4;
    const isDay = day > 0.24 && day < 0.76, sunset = (day > 0.68 && day < 0.8) || (day > 0.2 && day < 0.3);
    const rainy = active && ['lightning', 'acid', 'storm'].includes(w.kind) ? 1 : 0;
    const windy = active && w.kind === 'storm' ? 1 : warn ? 0.5 : active ? 0.35 : 0.1;
    set('waves', 0.2 * coast * (0.55 + swell * 0.6), 380 + swell * 650);
    set('wind', 0.12 * windy, 300 + windy * 1400);
    set('leaves', (isDay ? 0.028 : 0.014) * (0.6 + swell) * (1 - coast * 0.5) + windy * 0.04, 2000 + swell * 1500);
    set('rain', 0.12 * rainy);
    const wn = waterNear(p);
    set('brook', 0.06 * Math.max(0, 1 - wn / 18) * (0.8 + 0.2 * Math.sin(waveT * 3.1)), 1400 + 500 * Math.sin(waveT * 1.7));
    mood = forced || (active && w.kind !== 'drought' ? 'storm' : !isDay ? 'night' : sunset ? 'sunset' : 'day');

    // breaking waves: a swell that rises, crashes and hisses back, somewhere along the shore
    surfT -= dt;
    if (surfT < 0 && coast > 0.25) { surfT = rnd(4.5, 9); const pan = rnd(-0.7, 0.7); noise({ dur: 3.2, gain: 0.12 * coast, lpf: 1300, attack: 1.1, sweep: 280, dest: amb, pan }); noise({ t: 1.0, dur: 1.8, gain: 0.05 * coast, hpf: 2500, lpf: 8000, attack: 0.1, dest: amb, pan }); }
    birdT -= dt; gullT -= dt; frogT -= dt; owlT -= dt; dropT -= dt;
    if (isDay && !rainy && birdT < 0) { birdT = rnd(2, 7); bird(rnd(-0.8, 0.8)); }
    if (isDay && !rainy && coast > 0.6 && gullT < 0) { gullT = rnd(8, 18); gull(rnd(-0.8, 0.8)); }
    if (!isDay && !rainy) for (const c of crickets) {   // a chorus: each cricket chirps in its own rhythm
      c.t -= dt;
      if (c.t < 0) { c.t = c.gap * rnd(0.8, 1.2); for (let i = 0; i < 3; i++) tone(c.f, { t: i * 0.055, dur: 0.035, gain: 0.009, dest: amb, pan: c.pan }); }
    }
    if (!isDay && wn < 25 && frogT < 0) { frogT = rnd(1.5, 5); frog(rnd(-0.6, 0.6)); }
    if (!isDay && !rainy && owlT < 0) { owlT = rnd(25, 60); owl(rnd(-0.9, 0.9)); }
    if (rainy && dropT < 0) { dropT = 0.04; tone(rnd(2500, 5000), { dur: 0.02, gain: 0.006, dest: amb, pan: rnd(-1, 1) }); }
  }
  function bird(pan) {
    const base = rnd(1800, 3400), n = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) tone(base * (1 + Math.random() * 0.3), { t: i * 0.11, dur: 0.09, gain: 0.022, to: base * rnd(1.3, 1.7), attack: 0.01, dest: amb, pan });
  }
  function gull(pan) { for (let i = 0; i < 2; i++) tone(rnd(1300, 1500), { t: i * 0.32, dur: 0.3, gain: 0.018, to: 850, type: 'sawtooth', lpf: 2400, attack: 0.03, dest: amb, pan }); }
  function frog(pan) { const f = rnd(150, 220); for (let i = 0; i < 5; i++) tone(f, { t: i * 0.035, dur: 0.03, gain: 0.03, type: 'square', lpf: 700, dest: amb, pan }); }
  function owl(pan) { tone(380, { dur: 0.35, gain: 0.03, to: 360, attack: 0.06, lpf: 900, dest: amb, pan }); tone(330, { t: 0.5, dur: 0.6, gain: 0.03, to: 310, attack: 0.08, lpf: 900, dest: amb, pan }); }

  // ---------------------------------------------------------------- effects library
  const v = () => rnd(0.88, 1.12);   // a little variation so repeats don't sound copy-pasted
  const S = {
    till: () => { noise({ dur: 0.18, gain: 0.32, lpf: 900 * v(), sweep: 200 }); tone(90, { dur: 0.15, gain: 0.22, to: 50 }); noise({ t: 0.05, dur: 0.12, gain: 0.05, hpf: 2500 }); },
    plant: () => { noise({ dur: 0.2, gain: 0.07, hpf: 3000, lpf: 9000 }); noise({ dur: 0.1, gain: 0.05, lpf: 500 }); tone(660 * v(), { t: 0.06, dur: 0.12, gain: 0.04 }); },
    water: () => { noise({ dur: 0.55, gain: 0.22, bp: 1200, q: 0.7, lpf: 5000, sweep: 700 }); for (let i = 0; i < 5; i++) tone(rnd(500, 1500), { t: 0.08 + i * 0.07, dur: 0.06, gain: 0.025, to: rnd(900, 1800) }); },
    refill: () => { for (let i = 0; i < 6; i++) tone(300 + i * 70, { t: i * 0.06, dur: 0.09, gain: 0.045, to: 500 + i * 90 }); noise({ dur: 0.6, gain: 0.08, bp: 700, sweep: 1400 }); },
    harvest: () => { noise({ dur: 0.16, gain: 0.07, hpf: 2800 }); tone(320 * v(), { dur: 0.09, gain: 0.1, to: 900, attack: 0.002 }); tone(N(76 + [0, 2, 4, 7][Math.floor(Math.random() * 4)]), { t: 0.03, dur: 0.35, gain: 0.05, type: 'triangle' }); },
    golden: () => { [0, 4, 7, 12, 16].forEach((n, i) => tone(N(84 + n), { t: i * 0.06, dur: 0.6, gain: 0.07, type: 'triangle', pan: (i - 2) * 0.3 })); noise({ dur: 0.8, gain: 0.04, hpf: 7000, attack: 0.05 }); },
    coins: () => { [0, 0.05, 0.11, 0.16].forEach((t, i) => tone(rnd(2200, 3400), { t, dur: 0.12, gain: 0.035, type: 'triangle', pan: rnd(-0.3, 0.3) })); tone(N(88), { t: 0.02, dur: 0.1, gain: 0.06, type: 'square', lpf: 5000 }); tone(N(95), { t: 0.09, dur: 0.3, gain: 0.06, type: 'square', lpf: 5000 }); },
    buy: () => { tone(N(79), { dur: 0.08, gain: 0.07, type: 'triangle' }); tone(N(84), { t: 0.06, dur: 0.2, gain: 0.07, type: 'triangle' }); tone(N(91), { t: 0.12, dur: 0.25, gain: 0.03 }); },
    chop: () => { noise({ dur: 0.08, gain: 0.38, bp: 900 * v(), q: 2 }); tone(180 * v(), { dur: 0.12, gain: 0.2, to: 110, type: 'triangle' }); noise({ t: 0.03, dur: 0.15, gain: 0.04, hpf: 3000 }); },
    clink: () => { tone(1800 * v(), { dur: 0.3, gain: 0.08, type: 'triangle' }); tone(2650 * v(), { dur: 0.2, gain: 0.05 }); noise({ dur: 0.05, gain: 0.2, hpf: 2000 }); noise({ t: 0.03, dur: 0.25, gain: 0.04, bp: 1500, q: 0.8 }); },
    fell: () => { noise({ dur: 1.0, gain: 0.15, bp: 300, q: 3, sweep: 120 }); for (let i = 0; i < 4; i++) noise({ t: 0.2 + i * 0.12, dur: 0.1, gain: 0.05, bp: 1200, q: 4 }); noise({ t: 0.75, dur: 0.6, gain: 0.45, lpf: 300 }); tone(60, { t: 0.75, dur: 0.5, gain: 0.35, to: 32 }); noise({ t: 0.8, dur: 0.8, gain: 0.06, hpf: 3000 }); },
    build: () => { tone(70, { dur: 0.3, gain: 0.35, to: 45 }); noise({ dur: 0.25, gain: 0.2, lpf: 600 }); [0, 7, 12].forEach((n, i) => tone(N(72 + n), { t: 0.18 + i * 0.07, dur: 0.45, gain: 0.05, type: 'triangle' })); },
    levelup: () => { [0, 4, 7, 12, 7, 12, 16, 19].forEach((n, i) => pluck(N(72 + n), i * 0.09, 0.11, 0.9, sfx, (i % 2 ? 0.3 : -0.3))); tone(N(48), { dur: 1.6, gain: 0.08, attack: 0.3, type: 'triangle', lpf: 900 }); noise({ t: 0.5, dur: 1.2, gain: 0.03, hpf: 7000, attack: 0.3 }); },
    achievement: () => [0, 7, 12, 16].forEach((n, i) => marimba(N(76 + n), i * 0.12, 0.12, sfx, (i - 1.5) * 0.3)),
    quest: () => { [0, 4, 7].forEach((n, i) => pluck(N(67 + n), i * 0.1, 0.12, 0.7, sfx)); S.coins(); },
    trader: () => { tone(N(55), { dur: 1.6, gain: 0.12, type: 'sawtooth', attack: 0.25, lpf: 700 }); tone(N(62), { t: 0.55, dur: 1.4, gain: 0.1, type: 'sawtooth', attack: 0.25, lpf: 700 }); noise({ dur: 2.5, gain: 0.05, lpf: 600, attack: 0.8 }); },
    crow: () => { for (let i = 0; i < 2; i++) noise({ t: i * 0.28, dur: 0.2, gain: 0.12, bp: 1100 * v(), q: 6 }); },
    scare: () => { for (let i = 0; i < 6; i++) noise({ t: i * 0.05, dur: 0.05, gain: 0.08, bp: 600, q: 2 }); S.crow(); },
    thunder: (near = 0.6) => {   // crack, then a rolling rumble in uneven waves
      noise({ dur: 0.12, gain: 0.5 * near, hpf: 1500 });
      noise({ t: 0.02, dur: 0.6, gain: 0.25 * near, hpf: 400, lpf: 3000, sweep: 600 });
      for (let i = 0; i < 4; i++) noise({ t: 0.1 + i * rnd(0.4, 0.8), dur: rnd(1.2, 2.4), gain: rnd(0.25, 0.5) * near, lpf: 200, attack: 0.15, sweep: 55, pan: rnd(-0.5, 0.5) });
      tone(38, { t: 0.1, dur: 2.5, gain: 0.25 * near, attack: 0.2 });
    },
    burn: () => { noise({ dur: 1.2, gain: 0.1, hpf: 1500, lpf: 6000, attack: 0.1 }); for (let i = 0; i < 6; i++) noise({ t: rnd(0, 1), dur: 0.02, gain: 0.06, hpf: 3000 }); },
    extinguish: () => noise({ dur: 0.9, gain: 0.2, hpf: 2500, lpf: 9000, sweep: 3000 }),
    damage: () => { noise({ dur: 0.3, gain: 0.15, lpf: 500 }); tone(220, { dur: 0.3, gain: 0.06, to: 110, type: 'triangle' }); },
    step: surf => {
      const k = v();
      if (surf === 'water') { noise({ dur: 0.25, gain: 0.09, bp: 1000 * k, q: 0.8, sweep: 400 }); tone(rnd(400, 900), { t: 0.05, dur: 0.06, gain: 0.015, to: rnd(900, 1500) }); return; }
      if (surf === 'wood') { tone(170 * k, { dur: 0.09, gain: 0.07, to: 120, type: 'triangle' }); noise({ dur: 0.05, gain: 0.05, bp: 900 * k, q: 3 }); return; }
      if (surf === 'stone') { noise({ dur: 0.04, gain: 0.05, bp: 3200 * k, q: 4 }); noise({ dur: 0.06, gain: 0.03, lpf: 600 }); return; }
      if (surf === 'sand') { noise({ dur: 0.13, gain: 0.055, bp: 2300 * k, q: 0.8 }); noise({ dur: 0.06, gain: 0.025, lpf: 400 }); return; }
      if (surf === 'soil') { noise({ dur: 0.1, gain: 0.06, lpf: 750 * k }); noise({ dur: 0.05, gain: 0.015, hpf: 2500 }); return; }
      noise({ dur: 0.1, gain: 0.04, hpf: 1400 * k, lpf: 6000 }); noise({ dur: 0.05, gain: 0.03, lpf: 380 });   // grass
    },
    pet: () => {   // contented little 'hee-haw', then a twinkle
      tone(520, { dur: 0.22, gain: 0.07, type: 'sawtooth', to: 760, attack: 0.03, lpf: 1600 });
      tone(700, { t: 0.24, dur: 0.32, gain: 0.07, type: 'sawtooth', to: 380, attack: 0.03, lpf: 1300 });
      [0, 4, 7].forEach((n, i) => tone(N(84 + n), { t: 0.5 + i * 0.07, dur: 0.35, gain: 0.04, type: 'triangle' }));
    },
    click: () => tone(1200, { dur: 0.05, gain: 0.05, type: 'triangle' }),
    open: () => { tone(500, { dur: 0.12, gain: 0.05, to: 800 }); noise({ dur: 0.1, gain: 0.03, hpf: 3000 }); },
    close: () => tone(700, { dur: 0.1, gain: 0.04, to: 450 }),
    fail: () => { tone(220, { dur: 0.12, gain: 0.06, type: 'triangle' }); tone(196, { t: 0.1, dur: 0.15, gain: 0.06, type: 'triangle' }); },
    bot: () => { tone(900, { dur: 0.06, gain: 0.04, type: 'square', lpf: 3000 }); tone(1350, { t: 0.08, dur: 0.06, gain: 0.04, type: 'square', lpf: 3000 }); },
    market: () => S.coins(),
    swing: () => noise({ dur: 0.18, gain: 0.06, bp: 1500 * v(), q: 1, sweep: 600 }),
    warn: () => { tone(N(57), { dur: 1.8, gain: 0.08, type: 'sawtooth', attack: 0.4, lpf: 900 }); tone(N(60), { t: 0.2, dur: 1.6, gain: 0.06, type: 'sawtooth', attack: 0.4, lpf: 900 }); tone(N(45), { dur: 2.2, gain: 0.06, attack: 0.6, lpf: 400 }); },
    calm: () => [0, 4, 7, 12].forEach((n, i) => marimba(N(72 + n), i * 0.15, 0.06, sfx, (i - 1.5) * 0.25)),
    crash: () => { noise({ dur: 2.5, gain: 0.7, lpf: 400, attack: 0.02, sweep: 80 }); noise({ dur: 1.2, gain: 0.4, hpf: 800, lpf: 5000 }); tone(45, { dur: 1.6, gain: 0.5, to: 30 }); for (let i = 0; i < 8; i++) noise({ t: rnd(0.1, 1.2), dur: 0.08, gain: 0.12, bp: rnd(600, 1800), q: 5 }); },
    wave: () => noise({ dur: 3.0, gain: 0.25, lpf: 900, attack: 1.0, sweep: 300 }),
  };

  // fx far from the listener are quieter and come from their side
  function where(i, j) {
    const p = game.player?.pos;
    if (!p || i == null) return { vol: 1, pan: 0 };
    const dx = tileX(i) - p.x, dz = tileZ(j) - p.z, d = Math.hypot(dx, dz);
    const yaw = game.player.yaw || 0, rx = -Math.cos(yaw), rz = Math.sin(yaw);   // the player's right
    return { vol: Math.max(0, 1 - d / 40), pan: d > 1.5 ? ((dx * rx + dz * rz) / d) * 0.7 : 0 };
  }
  function play(name, opt) {
    if (!ctx || !S[name]) return;
    const vol = opt?.vol ?? 1, pan = opt?.pan ?? 0;
    if (vol <= 0.02) return;
    if (vol < 1 || pan) {
      const g = ctx.createGain(); g.gain.value = vol; g.connect(out(sfx, pan));
      const prev = sfx; sfx = g; try { S[name](opt.arg); } finally { sfx = prev; }
    } else S[name](opt?.arg);
  }

  function onFx(list) {
    for (const f of list) {
      const w = where(f.i, f.j);
      const mine = !f.pid || f.pid === game.pid;
      switch (f.k) {
        case 'till': play('till', w); break;
        case 'plant': play('plant', w); break;
        case 'water': play('water', w); break;
        case 'refill': if (mine) play('refill'); break;
        case 'harvest': play(f.gold ? 'golden' : 'harvest', w); break;
        case 'hit': play(f.o === 'rock' ? 'clink' : 'chop', w); break;
        case 'fell': play('fell', w); break;
        case 'build': play('build', w); break;
        case 'coins': if (mine) play('coins'); break;
        case 'buy': if (mine) play('buy'); break;
        case 'levelup': play('levelup'); break;
        case 'achievement': play('achievement'); break;
        case 'quest': play('quest'); break;
        case 'trader': play('trader'); break;
        case 'crow': play('crow', w); break;
        case 'scare': play('scare', w); break;
        case 'strike': play('thunder', { arg: 1 }); break;
        case 'burnt': play('burn', w); break;
        case 'extinguish': play('extinguish', w); break;
        case 'damage': case 'eaten': play('damage', w); break;
        case 'bot': play('bot', w); break;
        case 'market': play('market', { vol: 0.5 }); break;
        case 'collect': play('coins'); break;
        case 'shipPart': play('achievement'); break;
        case 'pet': play('pet'); break;
        case 'donkeyCmd': if (mine) play('click'); break;
        case 'weather': play(f.phase === 'warn' ? 'warn' : f.phase === 'calm' ? 'calm' : 'wave'); break;
      }
    }
  }

  game.on?.('step', e => play('step', { arg: e?.surface, vol: e?.sprint ? 1 : 0.85 }));
  game.on?.('use', e => { if (e?.tool && ['hoe', 'axe', 'pickaxe', 'sickle'].includes(e.tool)) play('swing'); });
  game.on?.('thunder', e => play('thunder', { arg: e?.near ?? 0.6 }));
  game.on?.('ui-open', () => play('open'));
  game.on?.('ui-close', () => play('close'));
  game.on?.('fail', () => play('fail'));
  game.on?.('click', () => play('click'));

  return {
    init, play, onFx, volumes,
    update(dt) { if (ctx) ambience(dt); },
    get ready() { return !!ctx; },
    get mood() { return playing; },
    // the trailer: pin the music to one mood, restart it at a given eighth note, and tap the mix for recording
    forceMood(m) { forced = m; if (m) { mood = playing = m; } },
    restartMusic(k0 = 0) { if (ctx) startMusic(k0); },
    capture() { const d = ctx.createMediaStreamDestination(); master.connect(d); return d.stream; },
  };
}
