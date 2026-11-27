// The 20-second trailer, filmed in the game: open http://localhost:8080/?trailer (dev server: python tools/serve.py).
// Eight shots on a lived-in farm (assets/trailer_farm.json, saved by the speedrun bot), drawn into a 1280x720
// frame with 2.39:1 bars and captions, recorded with the game's own music, and saved to recordings/trailer.webm.
import * as THREE from 'three';
import { makeMesh } from './assets.js';
import { heightAt, tileX, tileZ } from './terrain.js';
import { CROPS, GRID } from './data.js';
import * as S from './state.js';

const W = 1280, H = 720, BAR = Math.round((H - W / 2.39) / 2);
const ease = t => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = t => Math.max(0, Math.min(1, t));
const seg = (t, a, b) => clamp01((t - a) / (b - a));

export async function recordTrailer(game, { save = true, stills = null, text = false } = {}) {   // text: captions + title card
  const { world, audio } = game;
  const cam = world.camera, cine = world.cine;

  // ---- the set: the bot's farm, replanted in colourful rows, everything ripe
  const s = S.deserialize(await (await fetch('assets/trailer_farm.json')).json());
  s.players = { p1: { ...Object.values(s.players)[0], name: 'Castaway' } };
  const ROWS = ['corn', 'pumpkin', 'wheat', 'strawberry', 'watermelon', 'tomato', 'sugarcane', 'pineapple', 'banana', 'cacao', 'peppers', 'cotton'];
  const crops = [];
  s.tiles.forEach((t, k) => {
    if (!t.c) return;
    const j = Math.floor(k / GRID), id = ROWS[j % ROWS.length];
    t.c = { id, g: CROPS[id].grow, t: game.now(), sp: 1, w: 1, fz: 1, gf: 1, adult: CROPS[id].tree ? 1 : 0 };
    t.wet = 1;
    crops.push([k % GRID, j, t.c]);
  });
  Object.assign(s.weather, { kind: null, phase: 'calm', next: Infinity });
  s.crows = [];
  game.enterWorld(s);
  game.mode = 'intro'; game.player.enabled = false;
  const fc = crops.reduce((a, [i, j]) => [a[0] + tileX(i) / crops.length, a[1] + tileZ(j) / crops.length], [0, 0]);
  // the longest run of crops in one row, for the dolly shot (well away from buildings)
  const rows = {};
  for (const [i, j] of crops) (rows[j] ||= []).push(i);
  const [rowJ, rowI] = Object.entries(rows).map(([j, is]) => [+j, is.sort((a, b) => a - b)]).sort((a, b) => b[1].length - a[1].length)[0];
  const rx0 = tileX(rowI[0]), rx1 = tileX(rowI[rowI.length - 1]), rz = tileZ(rowJ);
  const weather = (kind, on) => Object.assign(s.weather, on ? { kind, phase: 'active', t0: game.now(), t1: game.now() + 600e3 } : { kind: null, phase: 'calm' });
  const grow = p => { for (const [, , c] of crops) { c.g = CROPS[c.id].grow * p; c.t = game.now(); } };

  // the ship for the last shot
  const ship = new THREE.Group();
  ship.add(makeMesh('intro_ship'));
  const mains = makeMesh('intro_mainsails'); mains.position.set(-0.4, 0, 0); ship.add(mains);
  const fore = makeMesh('intro_foremast'); fore.position.set(3.2, 1.503, 0); ship.add(fore);
  ship.visible = false;
  world.scene.add(ship);
  const trail = (await (await fetch('assets/heights.json')).json()).path || [];

  // ---- the shots: [seconds, caption, fn(t 0..1)]
  const look = (p, l) => { cam.up.set(0, 1, 0); cam.position.set(...p); cam.lookAt(...l); };
  const shots = [
    [2.6, 'Shipwrecked.', t => {                       // the wreck on the reef in a lightning storm at dusk
      cine.time = 0.77; weather('lightning', true);
      if (Math.abs(t - 0.35) < 0.02) { world.flash(1.2); audio.play('thunder', { arg: 0.9 }); }
      look([lerp(34, 24, ease(t)), lerp(1.6, 2.4, t), lerp(126, 116, ease(t))], [10, 2, 100]);
    }],
    [2.6, 'One island.', t => {                        // morning: from the sea up over the beach to the island
      cine.time = 0.31; weather(null, false);
      const e = ease(t);
      look([lerp(-6, 4, e), lerp(3, 26, e), lerp(118, 92, e)], [0, lerp(6, 10, e), 10]);
    }],
    [3.0, 'Five seeds.', t => {                        // low across the rows while everything grows
      cine.time = 0.4;
      grow(lerp(0.05, 1.0, ease(seg(t, 0.05, 0.8))));
      const x = lerp(rx0 - 2, lerp(rx0, rx1, 0.55), t), y = heightAt(x, rz) + 1.3;
      look([x, y, rz + 3.2], [x + 6, y - 0.9, rz - 1.5]);
    }],
    [2.6, 'Grow your farm.', t => {                    // a high, slow orbit over the finished farm
      cine.time = 0.46; grow(1);
      const a = lerp(2.2, 2.9, t), r = 38;
      look([fc[0] + Math.cos(a) * r, 24, fc[1] + Math.sin(a) * r], [fc[0], 2, fc[1]]);
    }],
    [2.6, 'Explore.', t => {                           // up the mountain trail at golden hour
      cine.time = 0.715;
      const a = lerp(0.15, -0.25, ease(t)), r = 120;
      look([5 + Math.cos(a) * r, lerp(40, 52, t), -108 + Math.sin(a) * r * 0.9 + 40], [5, 34, -104]);
    }],
    [2.2, 'Weather the storm.', t => {                 // lightning and rain over the fields
      cine.time = 0.5; weather('lightning', true);
      if (Math.abs(t - 0.25) < 0.025) { world.flash(1.4); audio.play('thunder', { arg: 1 }); }
      const y = heightAt(rx0, rz) + 6;
      look([lerp(rx0 - 6, rx0 + 2, t), y, rz + 12], [lerp(rx0 + 8, rx0 + 14, t), y - 4, rz - 6]);
    }],
    [2.2, 'Make it home.', t => {                      // moonlit beach, fireflies, the farm's lanterns
      cine.time = 0.82; weather(null, false);
      look([lerp(80, 76, t), heightAt(78, 30) + 1.7, lerp(32, 28, t)], [140, 14, -6]);
    }],
    [2.2, '', t => {                                   // the repaired ship sails into the sunset, title
      cine.time = 0.735;
      ship.visible = true;
      const d = 6 + t * 9, x = 10 + 0.32 * d, z = 100 + 0.95 * d;
      ship.position.set(x, world.waveAt(x, z), z); ship.rotation.set(0, Math.atan2(-0.95, 0.32), 0);
      look([lerp(-2, 2, t), 5, 74], [x, 4, z]);
      cine.fade = ease(seg(t, 0.8, 1));
    }],
  ];
  const total = shots.reduce((a, s) => a + s[0], 0);

  // ---- the frame: game render + bars + captions, composited every frame
  const comp = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g2 = comp.getContext('2d');
  await document.fonts.load('700 64px Fredoka');
  const hidden = [...document.body.children].filter(e => !e.contains(world.renderer.domElement) && e.style.visibility !== 'hidden');
  hidden.forEach(e => (e.style.visibility = 'hidden'));
  const oldFov = cam.fov; cam.fov = 52; cam.updateProjectionMatrix();
  world.renderSize = [W, H]; world.resize();
  cine.snap = true;
  let caption = '', capT = 0, shotT = 0, shotLen = 1, titleA = 0;
  world.afterRender = () => {
    g2.drawImage(world.renderer.domElement, 0, 0, W, H);
    g2.fillStyle = '#000'; g2.fillRect(0, 0, W, BAR); g2.fillRect(0, H - BAR, W, BAR);
    g2.textAlign = 'center'; g2.textBaseline = 'middle';
    if (text && caption) {
      const a = Math.min(seg(shotT, 0.12, 0.45), 1 - seg(shotT, shotLen - 0.35, shotLen - 0.05));
      g2.globalAlpha = a;
      g2.font = '600 44px Fredoka';
      g2.shadowColor = 'rgba(0,0,0,.55)'; g2.shadowBlur = 18;
      g2.fillStyle = '#F3E3C3';
      g2.fillText(caption, W / 2, H - BAR - 70 + (1 - a) * 8);
      g2.globalAlpha = 1; g2.shadowBlur = 0;
    }
    if (text && titleA > 0) {
      g2.globalAlpha = titleA;
      g2.shadowColor = 'rgba(0,0,0,.6)'; g2.shadowBlur = 30;
      g2.font = '700 104px Fredoka'; g2.fillStyle = '#F7E7C6';
      g2.fillText('Harvest Haven', W / 2, H / 2 - 16);
      g2.font = '600 30px Fredoka'; g2.fillStyle = '#F2B33D';
      g2.fillText('Five seeds. One island.', W / 2, H / 2 + 62);
      g2.globalAlpha = 1; g2.shadowBlur = 0;
    }
  };

  // ---- record
  audio.init();
  audio.forceMood('day');
  audio.restartMusic(64);          // straight into the melody section of the day theme
  const stream = comp.captureStream(30);
  for (const tr of audio.capture().getAudioTracks()) stream.addTrack(tr);
  const type = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm';
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 10e6 });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  await new Promise(r => setTimeout(r, 900));   // let the music and the first frame settle

  const done = new Promise(resolve => {
    let shot = 0, t = 0, T = 0;
    rec.start(250);
    game.cinematic = dt => {
      t += dt; T += dt;
      while (shot < shots.length && t > shots[shot][0]) { t -= shots[shot][0]; shot++; }
      if (shot >= shots.length) { game.cinematic = null; resolve(); return; }
      const [len, cap, fn] = shots[shot];
      caption = cap; shotT = t; shotLen = len;
      titleA = shot === shots.length - 1 ? Math.min(seg(t, 0.25, 0.8), 1) : 0;
      cine.letterbox = 1;
      fn(t / len);
      if (stills && !stills.has(shot) && t > len * 0.6) { stills.add(shot); requestAnimationFrame(() => comp.toBlob(b => fetch(`recordings/still-${shot + 1}.jpg`, { method: 'PUT', body: b }), 'image/jpeg', 0.85)); }
    };
  });
  await done;
  await new Promise(r => setTimeout(r, 400));   // hold the fade a moment
  rec.stop();
  await new Promise(r => (rec.onstop = r));
  const blob = new Blob(chunks, { type: 'video/webm' });

  // ---- tidy up
  world.afterRender = null; world.renderSize = null; world.resize();
  cam.fov = oldFov; cam.updateProjectionMatrix();
  world.scene.remove(ship);
  hidden.forEach(e => (e.style.visibility = ''));
  Object.assign(cine, { letterbox: 0, fade: 0, time: null, snap: false });
  audio.forceMood(null);
  if (save) await fetch('recordings/trailer.webm', { method: 'PUT', body: blob });
  return { bytes: blob.size, seconds: total };
}
