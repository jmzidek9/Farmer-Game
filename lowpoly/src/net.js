// Multiplayer over WebRTC (PeerJS). The world owner hosts; a friend joins with a 5-letter code.
// Host-authoritative: guests send actions, the host resolves + applies + broadcasts them.
const PREFIX = 'harvesthaven-v1-';
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createNet(game) {
  let peer = null, hostConn = null, code = null, posT = 0;
  const conns = new Map();            // host: pid -> DataConnection

  const ready = () => typeof window.Peer === 'function';
  const send = (c, m) => { try { if (c?.open) c.send(m); } catch (e) { console.warn('[net] send', e); } };
  const toGuests = (m, except) => { for (const [pid, c] of conns) if (pid !== except) send(c, m); };

  function close() {
    for (const c of conns.values()) try { c.close(); } catch {}
    conns.clear();
    try { hostConn?.close(); } catch {}
    try { peer?.destroy(); } catch {}
    peer = null; hostConn = null; code = null;
    game.remotes.clear();
  }

  // ---------------------------------------------------------------- host
  function host() {
    return new Promise((resolve, reject) => {
      if (!ready()) return reject(new Error('Multiplayer needs an internet connection (PeerJS did not load).'));
      if (peer && code) return resolve(code);
      code = Array.from({ length: 5 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
      peer = new window.Peer(PREFIX + code);
      peer.on('open', () => { game.role = 'host'; resolve(code); game.emit('net', { hosting: code }); });
      peer.on('error', e => {
        if (e.type === 'unavailable-id') { peer.destroy(); peer = null; code = null; host().then(resolve, reject); }
        else { game.emit('fail', { msg: 'Multiplayer error: ' + (e.type || e.message) }); reject(e); }
      });
      peer.on('connection', conn => {
        let pid = null;
        conn.on('data', m => {
          if (m.t === 'hello') {
            pid = String(m.id || 'g' + Math.floor(Math.random() * 1e9)).slice(0, 40);
            game.hostApply({ type: 'join', pid, name: String(m.name || 'Friend').slice(0, 24) }, null);   // others hear about it
            conns.set(pid, conn);                             // the newcomer gets the whole world in 'welcome' instead
            const p = game.state.players[pid];
            if (m.outfit && p) p.outfit = m.outfit;
            send(conn, { t: 'welcome', pid, host: game.pid, clock: Date.now(), state: JSON.stringify(game.state) });
            game.remotes.set(pid, { x: 0, y: 2, z: 76, yaw: 0, pitch: 0, name: p?.name || 'Friend', outfit: p?.outfit, held: null, anim: null });
            game.emit('net', { joined: p?.name || 'A friend' });
          } else if (m.t === 'act' && pid) {
            m.a.pid = pid;                                    // guests can only act as themselves
            game.hostApply(m.a, pid);
          } else if (m.t === 'chat' && pid) {
            const c = { t: 'chat', name: game.state.players[pid]?.name || 'Friend', text: String(m.text || '').slice(0, 200), emote: !!m.emote };
            game.emit('chat', c); toGuests(c);
          } else if (m.t === 'pos' && pid) {
            const r = game.remotes.get(pid);
            if (r) Object.assign(r, m.p);
            toGuests({ t: 'pos', pid, p: m.p }, pid);
          }
        });
        conn.on('close', () => {
          if (!pid) return;
          conns.delete(pid);
          const name = game.remotes.get(pid)?.name;
          game.remotes.delete(pid);
          toGuests({ t: 'bye', pid });
          game.emit('net', { left: name || 'Your friend' });
        });
      });
    });
  }

  // ---------------------------------------------------------------- guest
  function join(joinCode, name) {
    return new Promise((resolve, reject) => {
      if (!ready()) return reject(new Error('Multiplayer needs an internet connection (PeerJS did not load).'));
      close();
      const c = String(joinCode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (c.length !== 5) return reject(new Error('Codes are 5 letters and numbers.'));
      let id = localStorage.getItem('hh-guest-id');
      if (!id) { id = 'g' + Math.random().toString(36).slice(2, 10); localStorage.setItem('hh-guest-id', id); }
      peer = new window.Peer();
      const timer = setTimeout(() => reject(new Error('No world with that code answered. Check the code and that your friend’s game is open.')), 15000);
      peer.on('error', e => {
        clearTimeout(timer);
        reject(new Error(e.type === 'peer-unavailable' ? 'No world with that code is open right now.' : 'Could not connect: ' + (e.type || e.message)));
      });
      peer.on('open', () => {
        hostConn = peer.connect(PREFIX + c, { reliable: true });
        hostConn.on('open', () => send(hostConn, { t: 'hello', id, name: name || game.settings.name, outfit: localStorage.getItem('hh-outfit') }));
        hostConn.on('data', m => {
          if (m.t === 'welcome') {
            clearTimeout(timer);
            game.clockOffset = m.clock - Date.now();
            game.role = 'guest';
            game.hostPid = m.host;
            game.remotes.set(m.host, { x: 0, y: 2, z: 76, yaw: 0, pitch: 0, name: 'Host', outfit: null, held: null, anim: null });
            resolve({ pid: m.pid, state: m.state });
          } else if (m.t === 'act') game.guestApply(m.a);
          else if (m.t === 'fail') game.emit('fail', { msg: m.msg });
          else if (m.t === 'chat') game.emit('chat', m);
          else if (m.t === 'pos') { const r = game.remotes.get(m.pid) || {}; Object.assign(r, m.p); game.remotes.set(m.pid, r); }
          else if (m.t === 'bye') game.remotes.delete(m.pid);
        });
        hostConn.on('close', () => { if (game.role === 'guest') game.emit('net', { lost: true }); });
      });
    });
  }

  return {
    host, join, close,
    get code() { return code; },
    get count() { return conns.size; },
    sendAction(a) { send(hostConn, { t: 'act', a }); },
    chat(text, emote) {
      text = String(text).slice(0, 200);
      if (game.role === 'guest') return send(hostConn, { t: 'chat', text, emote });
      const c = { t: 'chat', name: game.state.players[game.pid]?.name || 'Host', text, emote: !!emote };
      game.emit('chat', c); toGuests(c);
    },
    broadcast(a) { if (conns.size) toGuests({ t: 'act', a }); },
    fail(pid, msg) { if (msg) send(conns.get(pid), { t: 'fail', msg }); },
    update(dt) {
      if (game.role === 'solo' || !game.player) return;
      posT -= dt;
      if (posT > 0) return;
      posT = 0.1;
      const P = game.player, me = game.state?.players[game.pid];
      const p = { x: P.pos.x, y: P.pos.y, z: P.pos.z, yaw: P.yaw, pitch: P.pitch, name: me?.name, outfit: me?.outfit, held: me?.inv[me.sel]?.id || null, anim: P.anim || null };
      if (game.role === 'host') toGuests({ t: 'pos', pid: game.pid, p });
      else send(hostConn, { t: 'pos', p });
    },
  };
}
