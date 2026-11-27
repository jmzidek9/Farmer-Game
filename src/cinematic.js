// Opening scene, ~45 s, skippable: a brigantine at golden hour, the sky turns, the storm, the reef, the fore mast
// snaps, the title card, then waking on the beach beside the wreck. Drives world.cine (letterbox, fade, time of
// day, sea state), a temporary storm (game.introStorm + a weather override) and the camera directly.
import * as THREE from 'three';
import { makeMesh } from './assets.js';
import { heightAt } from './terrain.js';

const ease = t => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = t => Math.max(0, Math.min(1, t));
const seg = (t, a, b) => clamp01((t - a) / (b - a));
const wob = (T, f) => Math.sin(T * f) * 0.6 + Math.sin(T * f * 2.31 + 1.7) * 0.3 + Math.sin(T * f * 5.07 + 4.1) * 0.1;

const REEF = new THREE.Vector3(24, 0, 136);         // where the wreck lies
const DIR = new THREE.Vector3(-0.3, 0, -0.954).normalize();
const YAW = Math.atan2(-DIR.z, DIR.x);              // model bow is +X
const SPEED = 7.5;
const FORE = new THREE.Vector3(3.2, 1.503, 0);      // fore mast foot / main mast axis (from tools/make_models.py)
const MAIN = new THREE.Vector3(-0.4, 0, 0);

export function playIntro(game) {
  const { world, audio } = game;
  const cam = world.camera;
  const cine = world.cine;

  // ---- the ship: hull + billowing main sails + a fore mast that can snap
  const ship = new THREE.Group(), frame = new THREE.Object3D();
  ship.rotation.order = 'YZX';
  ship.add(makeMesh('intro_ship'));
  const mains = makeMesh('intro_mainsails'); mains.position.copy(MAIN); ship.add(mains);
  const fore = makeMesh('intro_foremast'); fore.position.copy(FORE); ship.add(fore);
  world.scene.add(ship, frame);

  // ---- the reef: dark rocks breaking the surface around the wreck site
  const rocks = [];
  for (const [dx, dz, s, n] of [[7, 3, 2.2, 'rock_l'], [-6, 5, 1.8, 'rock_l'], [11, 10, 1.5, 'rock_m'], [-10, -2, 2.0, 'rock_m'], [3, 12, 1.6, 'rock_l'], [-2, -9, 1.3, 'rock_m'], [14, -4, 1.2, 'rock_m'], [-14, 8, 1.7, 'rock_l']]) {
    const r = makeMesh(n);
    r.position.set(REEF.x + dx, -0.5 - s * 0.25, REEF.z + dz); r.scale.setScalar(s); r.rotation.y = dx * 0.7 + dz;
    world.scene.add(r); rocks.push(r);
  }
  if (world.wreck) world.wreck.visible = false;

  const savedWeather = { ...game.state.weather };
  const storm = on => {
    game.introStorm = on;
    Object.assign(game.state.weather, on ? { kind: 'storm', phase: 'active', t0: game.now(), t1: game.now() + 120e3 } : savedWeather);
  };

  // ---- overlay: captions, title card, skip hint
  const card = document.createElement('div');
  card.className = 'intro';
  card.innerHTML = `<p class="intro-cap" aria-live="polite"></p>
    <div class="intro-card"><h2 class="intro-title">Harvest Haven</h2><p class="intro-sub">Five seeds. One island.</p></div>
    <p class="intro-skip"><kbd>Space</kbd> to skip</p>`;
  document.body.appendChild(card);
  const capEl = card.querySelector('.intro-cap');
  let capText = '';
  const caption = txt => {
    if (txt === capText) return;
    capText = txt;
    capEl.classList.remove('show');
    if (txt) setTimeout(() => { if (capText === txt) { capEl.textContent = txt; capEl.classList.add('show'); } }, capEl.textContent ? 700 : 0);
  };
  requestAnimationFrame(() => card.classList.add('on'));

  // ---- state shared by the shots
  let T = 0, sail = 0, stormAmt = 0, hit = -1, list = 0, sink = 0, shake = 0, boom = false;
  const tmp = new THREE.Vector3(), tgt = new THREE.Vector3(), up = new THREE.Vector3();
  const fromShip = (x, y, z, out = tmp) => out.set(x, y, z).applyMatrix4(ship.matrixWorld);
  const fromFrame = (x, y, z, out = tmp) => out.set(x, y, z).applyMatrix4(frame.matrixWorld);
  const shipCam = (p, l, roll = 1) => {       // camera riding the ship: inherits its pitch and roll
    cam.position.copy(fromShip(...p, tmp));
    up.set(0, 1, 0).applyQuaternion(ship.quaternion).lerp(new THREE.Vector3(0, 1, 0), 1 - roll).normalize();
    cam.up.copy(up);
    cam.lookAt(fromShip(...l, tgt));
  };
  const frameCam = (p, l) => {                // camera following the ship's heading, steady
    cam.up.set(0, 1, 0);
    cam.position.copy(fromFrame(...p, tmp));
    cam.position.y = Math.max(cam.position.y, world.waveAt(cam.position.x, cam.position.z) + 0.6);
    cam.lookAt(fromFrame(...l, tgt));
  };
  const addShake = s => {
    cam.position.x += wob(T, 23) * s; cam.position.y += wob(T + 3, 19) * s; cam.position.z += wob(T + 7, 21) * s;
  };

  const shots = [
    [9, t => {                                   // golden hour: rising from the swell to circle the bow
      cine.letterbox = 1; cine.fade = 1 - ease(seg(t, 0, 0.3));
      cine.time = lerp(0.695, 0.712, t);
      const e = ease(t);
      frameCam([lerp(34, 16, e), lerp(0.8, 7, e), lerp(-20, -15, e)], [lerp(4, 0, e), lerp(3, 4.5, e), 0]);
      caption(t > 0.18 && t < 0.88 ? 'Forty days out from the mainland…' : '');
    }],
    [7, t => {                                   // on deck behind the wheel: the sky turns
      if (!game.introStorm) { storm(true); audio.play('thunder', { arg: 0.35 }); }
      stormAmt = lerp(0.1, 0.75, ease(t));
      cine.time = lerp(0.712, 0.79, t);
      cine.sea = stormAmt * 0.9;
      shipCam([-5.2, 4.9, lerp(1.25, 1.0, t)], [4, lerp(7, 5.5, t), lerp(-0.4, -0.9, t)], 0.85);
      caption(t > 0.15 && t < 0.85 ? '…when the sky turned.' : '');
      if (t > 0.62 && !boom) { boom = true; world.flash(0.8); audio.play('thunder', { arg: 0.9 }); }
    }],
    [6.5, t => {                                 // wide, low on the water: the ship fights the swell
      stormAmt = 1; cine.time = 0.8; cine.sea = 1.1;
      frameCam([lerp(-8, 6, t), 1.4, -27], [lerp(-2, 3, t), 4, 0]);
      addShake(0.05);
      caption('');
      if (Math.abs(t - 0.45) < 0.01) { world.flash(1); audio.play('thunder', { arg: 1 }); }
    }],
    [4.6, t => {                                 // the bow: rocks in the lightning, then impact
      stormAmt = 1;
      if (hit < 0 && t > 0.55) {
        hit = T; audio.play('crash'); world.flash(1.4); shake = 1;
      }
      if (Math.abs(t - 0.22) < 0.012) { world.flash(1.1); audio.play('thunder', { arg: 0.8 }); }
      shipCam([lerp(6.6, 7.2, t), 2.9, 2.3], [34, 0.2, 2.6], 1);
      addShake(0.03 + shake * 0.35);
    }],
    [4.4, t => {                                 // outside: the fore mast snaps and falls, then black
      stormAmt = 1;
      frameCam([lerp(21, 19, t), 3.0, lerp(-17, -15, t)], [1.5, 3.5, 0]);
      addShake(shake * 0.25);
      if (t > 0.08 && fore.userData.fall == null) { fore.userData.fall = T; audio.play('fell'); }
      cine.fade = ease(seg(t, 0.62, 0.95));
    }],
    [5, t => {                                   // title card on black; the storm passes
      cine.fade = 1;
      card.classList.toggle('titled', t > 0.06 && t < 0.86);
      if (t > 0.5 && game.introStorm) calm();
    }],
    [9, t => {                                   // waking on the beach: blink, sit up, the wreck, then the island
      const bx = 0, bz = 80, gy = heightAt(bx, bz);
      const blink = t < 0.1 ? 1 - t / 0.1 * 0.75 : t < 0.15 ? 0.25 + (t - 0.1) / 0.05 * 0.75 : t < 0.32 ? 1 - ease((t - 0.15) / 0.17) : 0;
      cine.fade = clamp01(blink);
      cine.letterbox = 1 - ease(seg(t, 0.82, 1));
      const sit = ease(seg(t, 0.25, 0.5)), turn = ease(seg(t, 0.6, 0.9));
      cam.up.set(0, 1, 0);
      cam.position.set(bx, gy + lerp(0.35, 1.65, sit), bz + lerp(-0.6, 0, sit));
      const toSea = new THREE.Vector3(REEF.x, 1, REEF.z), toSky = new THREE.Vector3(bx, gy + 40, bz + 6), toIsland = new THREE.Vector3(bx - 2, gy + 3, bz - 30);
      const look = toSky.clone().lerp(toSea, sit).lerp(toIsland, turn);
      cam.lookAt(look);
      caption(t > 0.4 && t < 0.62 ? 'Washed ashore.' : '');
    }],
  ];

  let calmed = false;
  function calm() {
    if (calmed) return;
    calmed = true;
    storm(false);
    cine.time = null; cine.sea = 0;
    world.scene.remove(ship, frame);
    for (const r of rocks) world.scene.remove(r);
    if (world.wreck) world.wreck.visible = true;
  }

  return new Promise(resolve => {
    let shot = 0, t = 0, done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', onKey);
      calm();
      cam.up.set(0, 1, 0);
      cine.fade = 0; cine.letterbox = 0;
      card.classList.remove('on', 'titled');
      caption('');
      setTimeout(() => card.remove(), 1300);
      game.cinematic = null;
      resolve();
    };
    const onKey = e => { if (e.code === 'Space' || e.code === 'Enter' || e.code === 'Escape') { e.preventDefault(); finish(); } };
    window.addEventListener('keydown', onKey);
    // the main loop calls this every frame while game.cinematic is set
    game.cinematic = dt => {
      if (done) return;
      t += dt; T += dt;
      while (shot < shots.length && t > shots[shot][0]) { t -= shots[shot][0]; shot++; }
      if (shot >= shots.length) return finish();
      shake = Math.max(0, shake - dt * 0.9);

      // sail along the course until the reef, then grind to a stop
      if (!calmed) {
        if (hit < 0) sail = T;
        const dist = SPEED * sail + (hit < 0 ? 0 : SPEED * 0.35 * (1 - Math.exp(-(T - hit) * 2.5)));
        const pos = tmp.copy(REEF).addScaledVector(DIR, dist - SPEED * 25);
        frame.position.set(pos.x, 0, pos.z); frame.rotation.set(0, YAW, 0); frame.updateMatrixWorld();
        const bow = fromFrame(6, 0, 0, new THREE.Vector3()), stern = fromFrame(-5, 0, 0, new THREE.Vector3());
        const hb = world.waveAt(bow.x, bow.z), hs = world.waveAt(stern.x, stern.z);
        const after = hit < 0 ? 0 : T - hit;
        list = hit < 0 ? 0 : lerp(0, 0.24, ease(clamp01(after / 3)));
        sink = hit < 0 ? 0 : lerp(0, 1.1, ease(clamp01(after / 4)));
        const jolt = hit < 0 ? 0 : Math.exp(-after * 3) * Math.sin(after * 14) * 0.12;
        const heave = stormAmt * 0.55 * Math.sin(T * 1.05) + (hb + hs) / 2;
        ship.position.set(pos.x, heave - sink + (hit < 0 ? 0 : 0.15 * ease(clamp01(after * 2))), pos.z);
        const pitch = Math.atan2(hb - hs, 11) + stormAmt * 0.09 * Math.sin(T * 1.2 + 0.4) + jolt + (hit < 0 ? 0 : 0.08 * ease(clamp01(after)));
        const roll = 0.025 * Math.sin(T * 0.7) + stormAmt * 0.15 * Math.sin(T * 0.83 + 0.5) - list;
        ship.rotation.set(roll, YAW, pitch);
        ship.updateMatrixWorld();
        const gust = 1 + (0.03 + stormAmt * 0.1) * Math.sin(T * (2 + stormAmt * 2.5)) * (hit < 0 ? 1 : 0.3);
        mains.scale.set(gust, 1, 1);
        if (fore.userData.fall != null) {        // topples to port, accelerating like it's falling
          const ft = T - fore.userData.fall, k = clamp01(ft * ft * 0.55);
          fore.rotation.set(-1.25 * k + Math.exp(-ft * 4) * 0.05, 0, -0.25 * k);
          fore.position.set(FORE.x + 0.4 * k, FORE.y - 0.2 * k, FORE.z);
        } else fore.scale.set(gust, 1, 1);
      }
      shots[shot][1](t / shots[shot][0]);
    };
  });
}

// Ending, ~30 s, skippable: the repaired ship rides at the reef at golden hour, raises sail and heads out to sea,
// then a card with the run's numbers. Afterwards the ship stays anchored at the reef and the farm carries on.
export function playEnding(game) {
  const { world, audio, state: s } = game;
  const cam = world.camera, cine = world.cine;
  const OUT = new THREE.Vector3(0.32, 0, 0.95).normalize(), OUTYAW = Math.atan2(-OUT.z, OUT.x);
  const ship = new THREE.Group();
  ship.rotation.order = 'YZX';
  ship.add(makeMesh('intro_ship'));
  const mains = makeMesh('intro_mainsails'); mains.position.copy(MAIN); ship.add(mains);
  const fore = makeMesh('intro_foremast'); fore.position.copy(FORE); ship.add(fore);
  world.scene.add(ship);
  const hidden = [world.wreck, world.repairedShip].filter(Boolean).map(o => [o, o.visible]);
  for (const [o] of hidden) o.visible = false;

  const days = Math.max(1, Math.round((game.now() - (s.created || game.now())) / 1000 / (20 * 60)));
  const card = document.createElement('div');
  card.className = 'intro';
  card.innerHTML = `<p class="intro-cap" aria-live="polite"></p>
    <div class="intro-card"><h2 class="intro-title">Homeward bound</h2>
      <p class="intro-sub">You beat Harvest Haven in ${days} island day${days === 1 ? '' : 's'} · level ${s.lv} · ${s.stats.harvests.toLocaleString('en-US')} harvests · ${s.crops.length} crop${s.crops.length === 1 ? '' : 's'} discovered</p>
      <p class="intro-sub">Your farm will be waiting whenever you sail back.</p></div>
    <p class="intro-skip"><kbd>Space</kbd> to skip</p>`;
  document.body.appendChild(card);
  const capEl = card.querySelector('.intro-cap');
  const caption = txt => { if (capEl.textContent !== txt) { capEl.textContent = txt; capEl.classList.toggle('show', !!txt); } };
  requestAnimationFrame(() => card.classList.add('on'));
  audio.play('levelup');

  let T = 0, go = -1;
  const place = () => {   // anchored at the reef until it sails, then out along OUT, accelerating
    const d = go < 0 ? 0 : 0.6 * (T - go) * (T - go) + 0.5 * (T - go);
    const x = REEF.x + OUT.x * Math.min(d, 400), z = REEF.z + OUT.z * Math.min(d, 400);
    const yaw = lerp(YAW, OUTYAW, ease(clamp01(go < 0 ? 0 : (T - go) / 4)));
    ship.position.set(x, world.waveAt(x, z) + 0.05 * Math.sin(T * 1.1), z);
    ship.rotation.set(0.03 * Math.sin(T * 0.8), yaw, 0.02 * Math.sin(T * 1.05));
    ship.updateMatrixWorld();
    mains.scale.set(go < 0 ? 0.35 : lerp(0.35, 1.05, ease(clamp01((T - go) / 2.5))), 1, 1);
  };
  const look = (p, l) => { cam.up.set(0, 1, 0); cam.position.set(...p); cam.lookAt(...l); };
  const shots = [
    [7, t => {                                   // from the beach: the ship, whole again
      cine.letterbox = 1; cine.fade = 1 - ease(seg(t, 0, 0.25)); cine.time = 0.69;
      const gy = heightAt(-4, 80);
      look([lerp(-6, -2, t), gy + 1.7, 80], [REEF.x, 3, REEF.z]);
      caption(t > 0.15 && t < 0.9 ? 'New planks, a new mast. She’s seaworthy again.' : '');
    }],
    [7, t => {                                   // alongside: sails fill, she turns for the open sea
      if (go < 0 && t > 0.15) { go = T; audio.play('fell'); }
      cine.time = lerp(0.69, 0.72, t);
      const p = ship.position;
      look([p.x - 18 + t * 4, 4 + t, p.z - 10], [p.x, 4, p.z]);
      caption(t > 0.2 && t < 0.9 ? 'Time to sail home.' : '');
    }],
    [8, t => {                                   // high over the beach: the ship shrinks toward the sunset
      cine.time = lerp(0.72, 0.745, t);
      const p = ship.position;
      look([2, lerp(18, 30, ease(t)), lerp(70, 64, t)], [p.x, 2, p.z]);
      caption('');
      cine.fade = ease(seg(t, 0.75, 1));
    }],
    [9, t => { cine.fade = 1; card.classList.toggle('titled', t > 0.05 && t < 0.92); }],
  ];

  return new Promise(resolve => {
    let shot = 0, t = 0, done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', onKey);
      world.scene.remove(ship);
      for (const [o, v] of hidden) o.visible = v;
      cam.up.set(0, 1, 0);
      cine.fade = 0; cine.letterbox = 0; cine.time = null;
      card.classList.remove('on', 'titled');
      caption('');
      setTimeout(() => card.remove(), 1300);
      game.cinematic = null;
      resolve();
    };
    const onKey = e => { if (e.code === 'Space' || e.code === 'Enter' || e.code === 'Escape') { e.preventDefault(); finish(); } };
    window.addEventListener('keydown', onKey);
    game.cinematic = dt => {
      if (done) return;
      t += dt; T += dt;
      while (shot < shots.length && t > shots[shot][0]) { t -= shots[shot][0]; shot++; }
      if (shot >= shots.length) return finish();
      place();
      shots[shot][1](t / shots[shot][0]);
    };
  });
}
