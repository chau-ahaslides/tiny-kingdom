/* Marshmallow Challenge room: one Durable Object per code. It owns the physics (Rapier), the clock and the
   players, so a phone's touch goes phone -> room -> everyone with no host browser in the loop.
   The big screen is a viewer with the start / again buttons. Solo practice is a room with one player. */
import RAPIER from '@dimforge/rapier3d';
import { PH, createSim, spawnStick, spawnMarsh, spawnGlue, grab, move, release, removeBody, untape, step, snapshot, measure, isBusy } from './physics.js';

const PALETTE = ['#E4573D', '#2E9E6B', '#3B7DD8', '#B04BB3', '#E08A1E', '#1FA3A3', '#7A5CD6', '#C63A6B'];
const TICK = 1 / 60;

export class MarshRoom {
  constructor(state, env) {
    this.host = null;
    this.players = new Map();          // id -> { ws, name, color } (kept on disconnect: a reload gets the same builder back)
    this.mins = 18;
    this.newGame();
  }
  newGame() {
    this.stopLoops();
    this.sim = createSim(RAPIER);
    this.phase = 'lobby'; this.rem = 0; this.log = []; this.result = null; this.sentSeq = -1; this.netN = 0;
  }
  /* ---- sockets ---- */
  async fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 400 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    if (url.searchParams.get('role') === 'host') this.setupHost(server);
    else this.setupPlayer(server, (url.searchParams.get('name') || 'Builder').slice(0, 14), url.searchParams.get('token') || '');
    return new Response(null, { status: 101, webSocket: client });
  }
  send(ws, o) { if (!ws) return; try { ws.send(typeof o === 'string' ? o : JSON.stringify(o)); } catch (e) {} }
  broadcast(o) { const raw = JSON.stringify(o); this.send(this.host, raw); for (const p of this.players.values()) this.send(p.ws, raw); }
  setupHost(ws) {
    if (this.host) { try { this.host.close(); } catch (e) {} }
    this.host = ws;
    this.send(ws, this.meta());
    if (this.phase !== 'lobby') this.send(ws, { t: 'p', ...snapshot(this.sim) });
    ws.addEventListener('message', ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } this.onHost(m); });
    ws.addEventListener('close', () => { if (this.host === ws) this.host = null; });
    ws.addEventListener('error', () => { if (this.host === ws) this.host = null; });
  }
  setupPlayer(ws, name, token) {
    const id = 'p' + (token ? token.replace(/[^a-z0-9]/gi, '').slice(0, 12) : Math.random().toString(36).slice(2, 10));
    const had = this.players.get(id);
    if (had && had.ws && had.ws !== ws) { try { had.ws.close(); } catch (e) {} }
    const rec = had || { id, name, color: PALETTE[this.players.size % PALETTE.length] };
    rec.ws = ws; rec.name = name || rec.name;
    this.players.set(id, rec);
    this.logLine(had ? `${rec.name} is back` : `${rec.name} joined`);
    this.send(ws, { t: 'welcome', id, name: rec.name, color: rec.color, rejoined: had ? 1 : 0 });
    this.syncMeta();
    if (this.phase !== 'lobby') this.send(ws, { t: 'p', ...snapshot(this.sim) });
    ws.addEventListener('message', ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } this.onPlayer(id, m); });
    const gone = () => {
      if (rec.ws !== ws) return;                                  // an old socket dying after a rejoin
      rec.ws = null;
      for (const k of [...this.sim.hands.keys()]) if (k.split(':')[0] === id) release(this.sim, k, false);
      this.logLine(`${rec.name} left`); this.syncMeta();
    };
    ws.addEventListener('close', gone); ws.addEventListener('error', gone);
  }
  /* ---- game state everyone sees ---- */
  online() { const out = {}; for (const p of this.players.values()) if (p.ws) out[p.id] = { id: p.id, name: p.name, color: p.color }; return out; }
  status() {
    const S = this.sim;
    if (!S.bodies.size) return { note: 'Empty table', cls: '' };
    if (S.hands.size) return { note: `Hands on — ${[...new Set([...S.hands.keys()].map(k => (this.players.get(k.split(':')[0]) || {}).name).filter(Boolean))].join(', ')}`, cls: '' };
    const m = measure(S); return { note: m.note, cls: m.ok ? 'good' : S.bodies.has('marsh') ? 'bad' : '' };
  }
  meta() { return { t: 'meta', phase: this.phase, players: this.online(), log: this.log, rem: this.rem, mins: this.mins, tape: this.sim.tape, bag: this.sim.bag, marshInBag: this.sim.marshInBag, result: this.result, status: this.status() }; }
  syncMeta() { this.broadcast(this.meta()); }
  logLine(s) { this.log.unshift(s); this.log = this.log.slice(0, 6); }
  /* ---- messages ---- */
  onHost(m) {
    if (m.t === 'start') { if (this.phase !== 'lobby') return; this.mins = [3, 5, 10, 18].includes(+m.mins) ? +m.mins : this.mins; this.begin(); }
    else if (m.t === 'mins') { this.mins = [3, 5, 10, 18].includes(+m.mins) ? +m.mins : this.mins; this.syncMeta(); }
    else if (m.t === 'reset') { this.newGame(); this.logLine('New round — same room'); this.syncMeta(); }
  }
  onPlayer(pid, msg) {
    const S = this.sim, who = this.players.get(pid);
    const reply = (text) => this.send(who && who.ws, { t: 'toast', msg: text });
    if (!who || this.phase !== 'build') return;
    let r = { ok: true };
    if (msg.t === 'spawn') { const L = msg.len < PH.STICK_LEN * 0.75 ? PH.STICK_LEN / 2 : PH.STICK_LEN; r = spawnStick(S, L); if (r.ok) this.logLine(`${who.name} took a ${L < 20 ? 'half ' : ''}stick from the bag`); }
    else if (msg.t === 'marsh') { r = spawnMarsh(S); if (r.ok) this.logLine(`${who.name} took out the marshmallow`); }
    else if (msg.t === 'glue') { r = spawnGlue(S); if (r.ok) this.logLine(`${who.name} tore off a bit of tape`); }
    else if (msg.t === 'grab') { if (!Array.isArray(msg.local) || msg.local.length !== 3) return; r = grab(S, pid + ':' + msg.h, String(msg.piece), msg.local.map(Number)); }
    else if (msg.t === 'move') { if (Array.isArray(msg.p) && msg.p.length === 3) move(S, pid + ':' + msg.h, msg.p.map(Number)); return; }
    else if (msg.t === 'release') { const x = release(S, pid + ':' + msg.h); if (x.taped) { this.logLine(`${who.name} glued ${x.taped} piece${x.taped > 1 ? 's' : ''}`); reply(`Stuck to ${x.taped} piece${x.taped > 1 ? 's' : ''}`); } }
    else if (msg.t === 'remove') { r = removeBody(S, String(msg.piece)); if (r.ok) this.logLine(`${who.name} put a piece back in the bag`); }
    else if (msg.t === 'untape') { r = untape(S, String(msg.piece)); if (r.ok) this.logLine(`${who.name} peeled off a glue ball`); }
    else return;
    if (!r.ok) return reply(r.msg || 'Not possible right now.');
    this.syncMeta();
  }
  /* ---- the round ---- */
  begin() {
    this.phase = 'build'; this.rem = this.mins * 60; this.result = null;
    this.logLine('The clock is running');
    this.syncMeta();
    this.stepT = setInterval(() => this.tick(), 1000 / 60);
    this.netT = setInterval(() => this.net(), 50);
    this.clockT = setInterval(() => this.clock(), 1000);
  }
  tick() { try { step(this.sim, TICK); } catch (e) { console.error('physics', e); } }
  net() {
    const S = this.sim;
    if (S.events.length) { const n = S.events.length; S.events = []; this.logLine(`✂️ Glue tore — ${n} joint${n > 1 ? 's' : ''} came apart`); this.syncMeta(); }
    // 20 frames a second while anything moves; a sleeping table only needs a heartbeat
    const busy = isBusy(S) || S.seq !== this.sentSeq;
    this.netN++;
    if (busy || this.netN % 5 === 0) { this.broadcast({ t: 'p', ...snapshot(S) }); this.sentSeq = S.seq; }
  }
  clock() {
    if (this.phase === 'build') {
      this.rem--; this.broadcast({ t: 'time', rem: this.rem, status: this.status() });
      if (this.rem <= 0) { this.phase = 'settle'; for (const k of [...this.sim.hands.keys()]) release(this.sim, k, false); this.logLine('👐 Time! Hands off…'); this.syncMeta(); }
    } else if (this.phase === 'settle') {
      this.rem--;
      if (this.rem <= -3) {
        const m = measure(this.sim); this.result = { ok: m.ok, height: m.ok ? m.height : 0, note: m.note };
        this.phase = 'done'; this.stopLoops(); this.broadcast({ t: 'p', ...snapshot(this.sim) }); this.syncMeta();
      }
    }
  }
  stopLoops() { for (const k of ['stepT', 'netT', 'clockT']) if (this[k]) { clearInterval(this[k]); this[k] = null; } }
}
