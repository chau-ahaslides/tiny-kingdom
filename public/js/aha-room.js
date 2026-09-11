/* aha-room — scan-to-play rooms for the tiny-kingdom pages.
   A host-authoritative session, a replicated state document, presence, and a transport you can swap.
   The design note lives at /sdk. Nothing here knows what game it is running.

   Big screen:   const room = await AhaRoom.host();  room.mountLobby('#card');  room.state.set({ phase: 'ask' });
   Phone:        const me = AhaRoom.join({ askName });  me.on('state', (doc, mine) => render(doc, mine));
   Solo / tests: const hub = AhaRoom.memory();  AhaRoom.host({ transport: hub });  AhaRoom.join({ transport: hub, name: 'A' });

   Works in Node for tests (memory transport only): nothing touches the DOM until a DOM method is called. */

export const VERSION = '0.1.0';

const hasDOM = typeof window !== 'undefined' && typeof document !== 'undefined';
const DOC_MAX = 16 * 1024;           // the document travels in one message on any transport
const NAMES_MAX = 40;                // presence names replicated to phones
const RESERVED = /^_/;               // message types and document keys the SDK owns

export class RoomConflict extends Error {
  constructor({ code, heldBy, since } = {}) {
    super('room ' + code + ' is held by ' + (heldBy || 'another page'));
    this.name = 'RoomConflict'; this.code = code; this.heldBy = heldBy; this.since = since;
  }
}

class Emitter {
  constructor() { this._h = new Map(); }
  on(ev, fn) { if (!this._h.has(ev)) this._h.set(ev, new Set()); this._h.get(ev).add(fn); return () => this.off(ev, fn); }
  off(ev, fn) { const s = this._h.get(ev); if (s) s.delete(fn); }
  emit(ev, ...a) { const s = this._h.get(ev); if (!s) return; for (const fn of [...s]) { try { fn(...a); } catch (e) { console.error('[aha-room] listener for ' + ev, e); } } }
}

const clean = s => String(s == null ? '' : s).replace(/[<>&]/g, '').trim().slice(0, 24);
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const merge = (into, patch) => { for (const k of Object.keys(patch)) { if (patch[k] === null) delete into[k]; else into[k] = patch[k]; } return into; };
const unref = id => { if (id && typeof id.unref === 'function') id.unref(); return id; };
const store = {
  get(k) { try { return hasDOM ? localStorage.getItem(k) : null; } catch (e) { return null; } },
  set(k, v) { try { if (hasDOM) localStorage.setItem(k, v); } catch (e) {} },
};

/* ------------------------------------------------------------------ transports
   A transport moves objects and knows who is on the other end. Endpoint interface:
     caps, createRoom({page, code}), connect(role, {room, identity}), send(obj, to), close(), report(obj),
     backlog (bytes queued), roomCode(), identity()
   events: 'message' (obj), 'peer' ({type: join|leave|roster, ...}), 'welcome' ({id, name, rejoined}), 'status' (string)
   A transport factory (the memory hub) exposes endpoint(role) instead. */

export class RelayTransport extends Emitter {
  constructor(opts = {}) {
    super();
    this.origin = opts.origin || (hasDOM ? location.origin : '');
    this.embed = !!opts.embed;
    const q = hasDOM ? new URLSearchParams(location.search) : new URLSearchParams();
    this._q = q;
    this.caps = { unicast: true, providesIdentity: this.embed, providesRoom: this.embed, providesRoster: this.embed, maxBytes: 1 << 20, maxRate: 60, fastLanes: true };
    this.ws = null; this.closed = false; this.retries = 0; this.role = ''; this.room = ''; this.ident = {};
    if (this.embed && hasDOM) {
      window.addEventListener('message', ev => {
        const m = ev.data; if (!m || m.aha === undefined) return;
        if (m.aha === 'identity') { this.ident = { id: m.id, name: clean(m.name), token: String(m.token || m.id || '') }; if (m.room) this.room = String(m.room); this.emit('identity'); }
        else if (m.aha === 'roster' && Array.isArray(m.players)) this.emit('peer', { type: 'roster', players: m.players.map(p => ({ id: String(p.id), name: clean(p.name) })) });
        else if (m.aha === 'slide') this.emit('status', m.active ? 'ok' : 'inactive');
      });
      try { window.parent.postMessage({ aha: 'ready', version: VERSION }, '*'); } catch (e) {}
    }
  }
  roomCode() { return this.room || (this.embed ? (this._q.get('room') || '').toUpperCase() : ''); }
  identity() {
    if (this.ident.token) return this.ident;
    return { name: clean(this._q.get('name')), token: this._q.get('token') || '' };
  }
  async createRoom({ page, code }) {
    const res = await fetch(this.origin + '/api/room', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(code ? { page, code } : { page }) });
    let out = {}; try { out = await res.json(); } catch (e) {}
    if (res.status === 409 && out.conflict) throw new RoomConflict(out.conflict);
    if (!res.ok || !out.code) throw new Error('could not open a room (' + res.status + ')');
    return { code: out.code, joinUrl: out.joinUrl || this.origin + '/j/' + out.code };
  }
  connect(role, { room, identity }) {
    this.role = role; this.room = room; this.ident = identity || this.ident; this.closed = false;
    if (hasDOM && !this._vis) {
      this._vis = true;
      document.addEventListener('visibilitychange', () => { if (!document.hidden && !this.closed && this.ws && this.ws.readyState > 1) this._open(); });
    }
    this._open();
  }
  _open() {
    const proto = this.origin.startsWith('https') ? 'wss://' : 'ws://';
    let url = proto + this.origin.replace(/^https?:\/\//, '') + '/ws/' + encodeURIComponent(this.room) + '?role=' + this.role;
    if (this.role === 'player') url += '&name=' + encodeURIComponent(this.ident.name || '') + '&token=' + encodeURIComponent(this.ident.token || '');
    const ws = new WebSocket(url); this.ws = ws;
    ws.onopen = () => { this.retries = 0; this.emit('status', 'ok'); };
    ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m && typeof m === 'object') this._route(m); };
    ws.onclose = () => {
      if (ws !== this.ws || this.closed) return;
      this.retries++;
      this.emit('status', 'reconnecting');
      setTimeout(() => { if (ws === this.ws && !this.closed) this._open(); }, this.role === 'host' ? 1200 : Math.min(5000, 800 * this.retries));
    };
  }
  _route(m) {
    if (this.role === 'host') {
      if (m.t === 'join') return this.emit('peer', { type: 'join', id: String(m.id), name: clean(m.name), rejoin: !!m.rejoin, replay: !!m.replay, online: m.replay ? !!m.online : true });
      if (m.t === 'leave') return this.emit('peer', { type: 'leave', id: String(m.id) });
      return this.emit('message', m);
    }
    if (m.t === 'welcome') return this.emit('welcome', { id: String(m.id), name: clean(m.name), rejoined: !!m.rejoined });
    if (m.t === 'nohost') return this.emit('status', 'waiting-for-host');
    if (m.t === 'hostgone') return this.emit('status', 'host-left');
    this.emit('message', m);
  }
  send(obj, to) {
    const ws = this.ws; if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(to ? Object.assign({ to }, obj) : obj)); return true; } catch (e) { return false; }
  }
  get backlog() { return this.ws ? this.ws.bufferedAmount : 0; }
  close() { this.closed = true; const ws = this.ws; this.ws = null; if (ws) try { ws.close(); } catch (e) {} }
  report(obj) { if (this.embed && hasDOM) try { window.parent.postMessage(Object.assign({ aha: 'report' }, obj), '*'); } catch (e) {} }
}

/* Everything in one page: the solo mode of every game, and the tests. Behaves like the relay, including
   players who arrive before the host, plus hooks to lose messages and drop phones. */
class MemoryEndpoint extends Emitter {
  constructor(hub, role) { super(); this.hub = hub; this.role = role; this.id = ''; this.ident = {}; this.caps = { unicast: true, providesIdentity: role === 'player', providesRoom: true, providesRoster: false, maxBytes: 1 << 20, maxRate: 1000, fastLanes: true }; this.backlog = 0; this.open = false; }
  roomCode() { return this.hub.code; }
  identity() { return this.ident; }
  async createRoom() { return { code: this.hub.code, joinUrl: null }; }
  connect(role, { identity }) { this.ident = Object.assign({}, this.ident, identity || {}); this.open = true; this.hub._connect(this); }
  send(obj, to) { if (!this.open) return false; this.hub._send(this, obj, to); return true; }
  close() { this.open = false; this.hub._close(this); }
  report(obj) { this.hub.reports.push(obj); }
}
export class MemoryHub {
  constructor() { this.code = 'LOCAL'; this.host = null; this.players = new Map(); this.roster = new Map(); this.pending = 0; this._latency = 0; this._lose = 0; this.reports = []; this.ends = new Map(); }
  endpoint(role) { return new MemoryEndpoint(this, role); }
  latency(ms) { this._latency = ms; }
  lose(n) { this._lose = n; }                        // drop the next n host→player deliveries
  _deliver(fn) { this.pending++; setTimeout(() => { this.pending--; fn(); }, this._latency); }
  async settle() {                                   // quiet for two turns: deliveries and the host's flush timer both count
    const nap = () => new Promise(r => setTimeout(r, this._latency + 2));
    for (;;) { await nap(); if (this.pending) continue; await nap(); if (!this.pending) return; }
  }
  _connect(ep) {
    if (ep.role === 'host') {
      if (this.host && this.host !== ep) { const old = this.host; old.open = false; }
      this.host = ep;
      this._deliver(() => { ep.emit('status', 'ok'); for (const [id, name] of this.roster) ep.emit('peer', { type: 'join', id, name, rejoin: false, replay: true, online: this.players.has(id) }); });
      return;
    }
    const token = ep.ident.token || rid();
    ep.ident.token = token;
    const id = 'p' + token.replace(/[^a-z0-9]/gi, '').slice(0, 12);
    const rejoined = this.roster.has(id);
    ep.id = id;
    const old = this.players.get(id); if (old && old !== ep) old.open = false;
    this.players.set(id, ep);
    if (ep.ident.name || !this.roster.has(id)) this.roster.set(id, clean(ep.ident.name) || 'Player');
    const name = this.roster.get(id);
    this._deliver(() => { ep.emit('status', 'ok'); ep.emit('welcome', { id, name, rejoined }); if (!this.host) ep.emit('status', 'waiting-for-host'); });
    if (this.host) { const h = this.host; this._deliver(() => h.emit('peer', { type: 'join', id, name, rejoin: rejoined, replay: false, online: true })); }
  }
  _send(from, obj, to) {
    const m = JSON.parse(JSON.stringify(obj));
    if (from.role === 'host') {
      if (this._lose > 0) { this._lose--; return; }
      const targets = to ? [this.players.get(to)].filter(Boolean) : [...this.players.values()];
      for (const p of targets) if (p.open) this._deliver(() => { if (p.open) p.emit('message', m); });
      return;
    }
    m.id = from.id;
    const h = this.host; if (h) this._deliver(() => { if (h.open) h.emit('message', m); });
  }
  _close(ep) {
    if (ep.role === 'host') { if (this.host === ep) { this.host = null; for (const p of this.players.values()) this._deliver(() => p.emit('status', 'host-left')); } return; }
    if (this.players.get(ep.id) !== ep) return;
    this.players.delete(ep.id);
    const h = this.host; if (h) this._deliver(() => h.emit('peer', { type: 'leave', id: ep.id }));
  }
  drop(me) { const ep = me._t; ep.open = false; this._close(ep); this._deliver(() => ep.emit('status', 'reconnecting')); }
  rejoin(me) { const ep = me._t; ep.open = true; this._connect(ep); }
}

function defaultTransport() {
  if (!hasDOM) throw new Error('aha-room: no transport given and no DOM; pass { transport }');
  const embed = new URLSearchParams(location.search).get('embed') === '1';
  return new RelayTransport({ embed });
}
const endpointOf = (t, role) => (t && typeof t.endpoint === 'function') ? t.endpoint(role) : t;

/* ------------------------------------------------------------------ shared: timers, ticks, frames on the phone */
function every(ms, fn) {
  const id = unref(setInterval(() => { if (hasDOM && document.hidden) return; fn(); }, ms));
  return () => clearInterval(id);
}
const raf = fn => (hasDOM && window.requestAnimationFrame) ? requestAnimationFrame(fn) : setTimeout(() => fn(Date.now()), 16);

/* ------------------------------------------------------------------ the big screen */
export class Room extends Emitter {
  constructor(t, { code, joinUrl, page }) {
    super();
    this._t = t; this.code = code; this.joinUrl = joinUrl; this.page = page;
    this.players = new Map(); this._seat = 0;
    this._doc = {}; this._v = 0; this._pending = null;
    this._mine = new Map(); this._pendingMine = new Map();
    this._presenceDirty = true; this._flushT = 0; this._lastFrame = null; this._closed = false;
    this.status = 'connecting';
    this.state = {
      set: patch => this._set(patch),
      setFor: (id, patch) => this._setFor(id, patch),
      get: () => this._doc,
      getFor: id => this._mineOf(id),
    };
    t.on('peer', p => this._peer(p));
    t.on('message', m => this._msg(m));
    t.on('status', s => { this.status = s; this.emit('status', s); });
  }
  static async open(opts = {}) {
    const t = endpointOf(opts.transport || defaultTransport(), 'host');
    const page = opts.page || (hasDOM ? location.pathname : '/');
    let code = null, joinUrl = null;
    if (t.caps.providesRoom) { code = t.roomCode() || null; }
    else { const r = await t.createRoom({ page, code: opts.code ? String(opts.code).toUpperCase() : undefined }); code = r.code; joinUrl = r.joinUrl; }
    const room = new Room(t, { code, joinUrl, page });
    t.connect('host', { room: code });
    return room;
  }
  /* presence */
  _peer(p) {
    if (p.type === 'roster') {
      for (const r of p.players) if (!this.players.has(r.id)) this.players.set(r.id, { id: r.id, name: r.name, online: false, seat: this._seat++, since: Date.now() });
      this._presenceDirty = true; this._schedule(); return;
    }
    if (p.type === 'join') {
      let pl = this.players.get(p.id);
      const fresh = !pl;
      if (fresh) { pl = { id: p.id, name: p.name || 'Player', online: p.online, seat: this._seat++, since: Date.now() }; this.players.set(p.id, pl); }
      else { if (p.name) pl.name = p.name; pl.online = p.online; }
      this._presenceDirty = true; this._schedule();
      if (!p.replay) this.emit('join', { id: p.id, name: pl.name, rejoin: p.rejoin || !fresh });
      if (pl.online) this._snap(p.id);
      return;
    }
    if (p.type === 'leave') {
      const pl = this.players.get(p.id); if (!pl || !pl.online) return;
      pl.online = false; this._presenceDirty = true; this._schedule();
      this.emit('leave', { id: p.id });
    }
  }
  count() { let online = 0; for (const p of this.players.values()) if (p.online) online++; return { total: this.players.size, online }; }
  _presence() {
    const list = [...this.players.values()].sort((a, b) => a.seat - b.seat);
    const c = this.count();
    return { list, slice: { total: c.total, online: c.online, names: list.slice(0, NAMES_MAX).map(p => p.name) } };
  }
  /* document */
  _set(patch) { if (!patch || typeof patch !== 'object') return; merge(this._doc, patch); this._pending = Object.assign(this._pending || {}, patch); this._schedule(); }   // pending keeps nulls: they are deletions on the wire
  _mineOf(id) { let m = this._mine.get(id); if (!m) { m = { v: 0, doc: {} }; this._mine.set(id, m); } return m.doc; }
  _setFor(id, patch) { if (!patch || typeof patch !== 'object') return; merge(this._mineOf(id), patch); this._pendingMine.set(id, Object.assign(this._pendingMine.get(id) || {}, patch)); this._schedule(); }
  _schedule() { if (this._flushT || this._closed) return; this._flushT = setTimeout(() => { this._flushT = 0; this._flush(); }, 0); }
  _flush() {
    let list = null;
    if (this._presenceDirty) {
      this._presenceDirty = false;
      const pr = this._presence(); list = pr.list;
      if (JSON.stringify(pr.slice) !== JSON.stringify(this._doc._players)) { this._doc._players = pr.slice; this._pending = Object.assign(this._pending || {}, { _players: pr.slice }); }
    }
    if (this._pending) {
      const p = this._pending; this._pending = null; this._v++;
      const msg = { t: '_patch', v: this._v, p };
      if (JSON.stringify(this._doc).length > DOC_MAX) console.warn('[aha-room] the state document is over ' + DOC_MAX + ' bytes; move fast-changing data to tick() or frame()');
      this._t.send(msg);
    }
    for (const [id, p] of this._pendingMine) { const m = this._mine.get(id); m.v++; this._t.send({ t: '_mine', mv: m.v, p }, id); }
    this._pendingMine.clear();
    if (list) this.emit('players', list);
  }
  _snap(id) {
    const m = this._mine.get(id);
    this._t.send({ t: '_snap', v: this._v, doc: this._doc, mv: m ? m.v : 0, mine: m ? m.doc : {}, now: Date.now() }, id);
    if (this._lastFrame) this._t.send({ t: '_frame', d: this._lastFrame }, id);
  }
  _msg(m) {
    if (typeof m.t !== 'string') return;
    if (m.t === '_resync') return this._snap(m.id);
    if (m.t === '_ping') return this._t.send({ t: '_pong', t0: m.t0, now: Date.now() }, m.id);
    if (RESERVED.test(m.t)) return;
    this.emit('msg', m);
  }
  /* plain messages, time, helpers */
  send(m) { if (m && typeof m.t === 'string' && !RESERVED.test(m.t)) this._t.send(m); }
  sendTo(id, m) { if (m && typeof m.t === 'string' && !RESERVED.test(m.t)) this._t.send(m, id); }
  now() { return Date.now(); }
  every(ms, fn) { return every(ms, fn); }
  report(obj) { this._t.report(obj); }
  close() { this._closed = true; this._t.close(); }
  tick(name, hz, fn) {
    if (!this._t.caps.fastLanes) throw new Error('aha-room: tick() is not available on this transport');
    const period = Math.max(16, 1000 / hz);
    const id = unref(setInterval(() => { if (this._t.backlog > 64 * 1024) return; const d = fn(); if (d !== undefined) this._t.send({ t: '_tick', n: name, d, at: Date.now() }); }, period));
    return { stop: () => clearInterval(id) };
  }
  frame(canvas, opts) {
    if (!this._t.caps.fastLanes) throw new Error('aha-room: frame() is not available on this transport');
    return new Frames(this, canvas, opts);
  }
  async qr() {
    if (!this.joinUrl) return null;
    await ensureQr();
    const q = window.qrcode(0, 'M'); q.addData(this.joinUrl); q.make();
    return q.createDataURL(4, 2);
  }
  mountLobby(sel) {
    if (!hasDOM) return () => {};
    const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    if (!el) return () => {};
    if (!this.code || !this.joinUrl) { el.hidden = true; return () => {}; }
    el.hidden = false;
    el.innerHTML = '<img class="aha-qr" alt="QR code to join"><b class="aha-code"></b><div class="aha-url"></div><div class="aha-who"></div>';
    el.querySelector('.aha-code').textContent = this.code;
    el.querySelector('.aha-url').textContent = this.joinUrl.replace(/^https?:\/\//, '');
    this.qr().then(d => { const img = el.querySelector('.aha-qr'); if (img && d) img.src = d; });
    const who = el.querySelector('.aha-who');
    const render = list => {
      const names = list.filter(p => p.online).map(p => p.name);
      who.textContent = names.length ? names.length + (names.length === 1 ? ' here: ' : ' here: ') + names.slice(0, 10).join(', ') + (names.length > 10 ? '…' : '') : 'nobody yet — scan to join';
    };
    render(this._presence().list);
    const off = this.on('players', render);
    return () => { off(); el.innerHTML = ''; };
  }
}

/* The sheet as a picture, sent only when it changed, at a rate the host controls. */
class Frames {
  constructor(room, canvas, opts = {}) {
    this.room = room; this.canvas = canvas;
    this.opts = Object.assign({ long: 640, quality: 0.55, format: 'webp', every: 700, perPlayer: 30, max: 2500 }, opts);
    this.dirtyAt = 0; this.sentAt = 0; this.paused = false; this.bytes = 0; this.sent = 0; this._times = [];
    this._c = hasDOM ? document.createElement('canvas') : null;
    this._timer = unref(setInterval(() => this._check(), 100));
  }
  interval() { const o = this.opts; return Math.min(o.max, Math.max(o.every, o.every + o.perPlayer * this.room.count().online)); }
  touch() { this.dirtyAt = Date.now(); }
  now() { this._send(); }
  rate(o) { Object.assign(this.opts, o); }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  stop() { clearInterval(this._timer); }
  get stats() { const t = Date.now(); this._times = this._times.filter(x => t - x < 60000); return { lastSentMsAgo: this.sentAt ? t - this.sentAt : null, bytes: this.bytes, framesPerMinute: this._times.length, phones: this.room.count().online, interval: this.interval() }; }
  _check() { if (this.paused || this.dirtyAt <= this.sentAt) return; if (Date.now() - this.sentAt >= this.interval()) this._send(); }
  _send() {
    const src = this.canvas; if (!this._c || !src || !src.width || !src.height) return;
    const o = this.opts, W = src.width, H = src.height;
    const fw = W >= H ? o.long : Math.max(1, Math.round(o.long * W / H)), fh = W >= H ? Math.max(1, Math.round(o.long * H / W)) : o.long;
    if (this._c.width !== fw || this._c.height !== fh) { this._c.width = fw; this._c.height = fh; }
    this._c.getContext('2d').drawImage(src, 0, 0, fw, fh);
    let d = '';
    try { d = this._c.toDataURL('image/' + o.format, o.quality); } catch (e) { return; }
    if (o.format !== 'jpeg' && !d.startsWith('data:image/' + o.format)) { try { d = this._c.toDataURL('image/jpeg', o.quality); } catch (e) { return; } }
    this.sentAt = Date.now(); this.bytes = d.length; this.sent++; this._times.push(this.sentAt);
    this.room._lastFrame = d;
    if (this.room.count().online) this.room._t.send({ t: '_frame', d });
  }
}

let qrLoading = null;
function ensureQr() {
  if (!hasDOM) return Promise.reject(new Error('no DOM'));
  if (window.qrcode) return Promise.resolve();
  if (!qrLoading) qrLoading = new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/vendor/qr.js'; s.onload = () => res(); s.onerror = () => rej(new Error('qr.js failed to load')); document.head.appendChild(s); });
  return qrLoading;
}

/* ------------------------------------------------------------------ the phone */
export class Me extends Emitter {
  constructor(opts = {}) {
    super();
    this._t = endpointOf(opts.transport || defaultTransport(), 'player');
    this.id = ''; this.name = ''; this.code = ''; this.status = 'connecting';
    this._doc = {}; this._v = 0; this._mine = {}; this._mv = 0; this._offset = 0; this._resyncAt = 0; this._closed = false;
    this._ticks = new Map(); this._frameNext = null; this._frameBusy = false; this._hold = null;
    this.state = { get: () => this._doc, mine: () => this._mine };
    this._t.on('welcome', w => { this.id = w.id; this.name = w.name; this.emit('welcome', w); if (!this._pingStop) this._pingStop = every(5000, () => this._t.send({ t: '_ping', t0: Date.now() })); });
    this._t.on('status', s => { this.status = s; this.emit('status', s); });
    this._t.on('message', m => this._msg(m));
    this._start(opts);
  }
  async _start(opts) {
    const t = this._t;
    const q = hasDOM ? new URLSearchParams(location.search) : new URLSearchParams();
    this.code = String(opts.code || (t.caps.providesRoom && t.roomCode()) || q.get('join') || '').toUpperCase();
    if (!this.code) { this.status = 'no-room'; this.emit('status', 'no-room'); return; }
    let identity;
    if (t.caps.providesIdentity) {
      identity = Object.assign({}, t.identity());
      if (opts.name) identity.name = clean(opts.name);
      if (!identity.token) identity.token = rid();
    } else {
      const tokKey = 'aha-room:tok:' + this.code, nameKey = 'aha-room:name:' + this.code;
      let token = store.get(tokKey); if (!token) { token = rid(); store.set(tokKey, token); }
      let name = clean(opts.name) || store.get(nameKey) || '';
      if (!name && typeof opts.askName === 'function') { try { name = clean(await opts.askName()); } catch (e) {} }
      if (!name) name = 'Player ' + (2 + Math.random() * 97 | 0);
      store.set(nameKey, name);
      identity = { name, token };
    }
    if (this._closed) return;
    t.connect('player', { room: this.code, identity });
  }
  _msg(m) {
    if (typeof m.t !== 'string') return;
    if (m.t === '_snap') {
      this._doc = m.doc && typeof m.doc === 'object' ? m.doc : {}; this._v = m.v | 0;
      this._mine = m.mine && typeof m.mine === 'object' ? m.mine : {}; this._mv = m.mv | 0;
      if (typeof m.now === 'number' && !this._offset) this._offset = m.now - Date.now();
      if (this.status !== 'ok') { this.status = 'ok'; this.emit('status', 'ok'); }
      this.emit('state', this._doc, this._mine); this.emit('players', this._doc._players || null);
      return;
    }
    if (m.t === '_patch') {
      if (m.v !== this._v + 1) { if (m.v > this._v + 1 || this._v === 0) this._resync(); return; }
      this._v = m.v; merge(this._doc, m.p || {});
      this.emit('state', this._doc, this._mine);
      if (m.p && m.p._players) this.emit('players', m.p._players);
      return;
    }
    if (m.t === '_mine') {
      if (m.mv !== this._mv + 1) { if (m.mv > this._mv + 1) this._resync(); return; }
      this._mv = m.mv; merge(this._mine, m.p || {});
      this.emit('state', this._doc, this._mine);
      return;
    }
    if (m.t === '_pong') { const rtt = Date.now() - m.t0; this._offset = (m.now + rtt / 2) - Date.now(); return; }
    if (m.t === '_frame') { if (typeof m.d === 'string' && m.d.startsWith('data:image/')) { this._frameNext = m.d; this._decode(); } return; }
    if (m.t === '_tick') { const tk = this._ticks.get(m.n); if (tk) tk._push(m); return; }
    if (RESERVED.test(m.t)) return;
    this.emit('msg', m);
  }
  _resync() { const t = Date.now(); if (t - this._resyncAt < 1000) return; this._resyncAt = t; this._t.send({ t: '_resync', v: this._v }); }
  /* frames */
  frames(opts = {}) { this._hold = opts.hold || null; return { apply: () => this._decode() }; }
  _decode() {
    if (!hasDOM || !this._frameNext || this._frameBusy) return;
    if (this._hold && this._hold()) { if (!this._holdT) this._holdT = setTimeout(() => { this._holdT = 0; this._decode(); }, 100); return; }
    this._frameBusy = true;
    const d = this._frameNext; this._frameNext = null;
    const img = new Image();
    img.onload = () => { this._frameBusy = false; this.emit('frame', img); this._decode(); };
    img.onerror = () => { this._frameBusy = false; this._decode(); };
    img.src = d;
  }
  /* ticks */
  tick(name, opts = {}) {
    let tk = this._ticks.get(name);
    if (!tk) { tk = new Tick(name, opts); this._ticks.set(name, tk); }
    return tk;
  }
  /* input */
  input(name, opts = {}) {
    if (RESERVED.test(name)) throw new Error('aha-room: input name may not start with _');
    const every_ = opts.every || 50, q = opts.quantise || 1;
    let buf = [], meta = null, t0 = 0, timer = 0;
    const flush = () => { if (!buf.length || !meta) return; this._t.send(Object.assign({ t: name }, meta, { pts: buf, q })); buf = []; };
    return {
      start: (m = {}) => { flush(); meta = m; t0 = Date.now(); buf = []; if (!timer) timer = unref(setInterval(flush, every_)); },
      push: sample => { if (!meta) return; buf.push(sample.map(v => typeof v === 'number' ? Math.round(v * q) : v).concat(Date.now() - t0)); },
      flush,
      stop: () => { flush(); meta = null; if (timer) { clearInterval(timer); timer = 0; } },
    };
  }
  /* plain messages, time */
  send(m) { if (m && typeof m.t === 'string' && !RESERVED.test(m.t)) this._t.send(m); }
  now() { return Date.now() + this._offset; }
  every(ms, fn) { return every(ms, fn); }
  close() { this._closed = true; if (this._pingStop) this._pingStop(); for (const tk of this._ticks.values()) tk.stop(); this._t.close(); }
}

/* Samples at a fixed rate from the host, played back one interval behind so there is always a next sample to blend toward. */
class Tick extends Emitter {
  constructor(name, opts) { super(); this.name = name; this.interp = opts.interpolate || null; this.a = null; this.b = null; this.period = 100; this._loop = false; this.stopped = false; }
  _push(m) {
    const s = { at: Date.now(), d: m.d };
    if (this.b) this.period = Math.max(16, Math.min(1000, 0.8 * this.period + 0.2 * (s.at - this.b.at)));
    this.a = this.b; this.b = s;
    this.emit('sample', m.d);
    if (!this._loop) { this._loop = true; raf(() => this._frame()); }
  }
  _frame() {
    if (this.stopped) { this._loop = false; return; }
    if (!this.b) { this._loop = false; return; }
    const renderAt = Date.now() - this.period;
    let out = this.b.d;
    if (this.a && this.interp) { const t = Math.max(0, Math.min(1, (renderAt - this.a.at) / Math.max(1, this.b.at - this.a.at))); out = blend(this.a.d, this.b.d, t, this.interp); }
    this.emit('frame', out);
    if (Date.now() - this.b.at > 2000) { this._loop = false; return; }   // the stream stopped: stop drawing it
    raf(() => this._frame());
  }
  stop() { this.stopped = true; }
}
function blend(A, B, t, interp) {
  if (Array.isArray(interp)) return blendRows(A, B, t, interp);
  if (interp && typeof interp === 'object' && B && typeof B === 'object') {
    const out = Object.assign({}, B);
    for (const k of Object.keys(interp)) if (Array.isArray(B[k]) && Array.isArray(A && A[k])) out[k] = blendRows(A[k], B[k], t, interp[k]);
    return out;
  }
  return B;
}
function blendRows(A, B, t, idx) {
  if (!Array.isArray(A) || !Array.isArray(B)) return B;
  const byId = new Map(); for (const r of A) if (Array.isArray(r)) byId.set(r[0], r);
  return B.map(r => {
    if (!Array.isArray(r)) return r;
    const a = byId.get(r[0]); if (!a) return r;
    const o = r.slice();
    for (const i of idx) if (typeof r[i] === 'number' && typeof a[i] === 'number') o[i] = a[i] + (r[i] - a[i]) * t;
    return o;
  });
}

/* ------------------------------------------------------------------ entry points */
export const AhaRoom = {
  VERSION,
  host: opts => Room.open(opts),
  join: opts => new Me(opts),
  memory: () => new MemoryHub(),
  relay: opts => new RelayTransport(opts),
  RoomConflict,
};
export default AhaRoom;
if (hasDOM) window.AhaRoom = AhaRoom;
