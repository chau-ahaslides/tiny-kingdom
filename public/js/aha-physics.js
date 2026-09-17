/* AhaPhysics — a physics world that lives on the server, not in a browser.
 *
 *   import { AhaPhysics } from 'https://play.ahaslides.io/js/aha-physics.js';
 *
 *   // the big screen sets the world up and gets a code
 *   const world = await AhaPhysics.host({
 *     gravity: [0, -9.81, 0],
 *     bodies: [
 *       { id: 'ground', type: 'fixed', shape: { cuboid: [10, 0.1, 10] } },
 *       { id: 'crate', shape: { cuboid: [0.5, 0.5, 0.5] }, pos: [0, 5, 0] },
 *     ],
 *   });
 *   world.code;                                   // "SPH3" — phones join with this
 *   world.impulse('crate', [0, 6, 0]);
 *   requestAnimationFrame(function frame(now) {
 *     for (const b of world.step(now)) draw(b);   // b.x, b.y, b.z, b.qx…, or b.angle in 2D
 *     requestAnimationFrame(frame);
 *   });
 *
 *   // a phone joins the same world and shoves things about
 *   const me = await AhaPhysics.join({ code });
 *   me.grab('crate'); me.drag([x, 2, z]); me.release();
 *
 *   // tape two bodies together where they touch; it tears if stretched past breakAt
 *   world.joint('a', 'b', [x, y], { kind: 'weld', breakAt: 0.2 });
 *   world.joints;                                 // Map id -> { a, b, la, lb }; jointPoint(j) is where it is
 *
 * The server owns the simulation (Rapier, the same engine the Marshmallow Challenge runs on), so
 * every screen sees one world, a phone needs no permission from the big screen, and a reload picks
 * the world up exactly where it is. Snapshots arrive 20 times a second; step() interpolates between
 * them, so drawing stays smooth at any frame rate.
 *
 * 2D: pass `plane: 'xy'` and every body is locked to z = 0 and to spinning about z. Positions may be
 * given as [x, y], and each body gets `.angle` in radians, so a 2D game never sees a quaternion.
 */
const VERSION = '1.0.0';
const RELAY = 'https://play.ahaslides.io';
const BUFFER_MS = 120;                         // render this far behind the server, to interpolate into

const hasDOM = typeof location !== 'undefined' && typeof WebSocket !== 'undefined';

function defaultOrigin() {
  if (!hasDOM) return RELAY;
  const o = location.origin, h = location.hostname;
  if (o === RELAY || /\.workers\.dev$/i.test(h) || h === 'localhost' || h === '127.0.0.1') return o;
  return RELAY;
}

/** A body as the game reads it: world position, orientation, and 2D shorthands. */
class Body {
  constructor(id) {
    this.id = id;
    this.x = 0; this.y = 0; this.z = 0;
    this.qx = 0; this.qy = 0; this.qz = 0; this.qw = 1;
    this.angle = 0;                            // rotation about z, which is all a 2D world has
    this.sleeping = false;
    this.tag = null; this.type = 'dynamic'; this.shape = null;
    this.from = null; this.to = null;          // the two snapshots step() interpolates between
  }
  set(t) {
    this.x = t[0]; this.y = t[1]; this.z = t[2];
    this.qx = t[3]; this.qy = t[4]; this.qz = t[5]; this.qw = t[6];
    this.angle = Math.atan2(2 * (t[6] * t[5] + t[3] * t[4]), 1 - 2 * (t[4] * t[4] + t[5] * t[5]));
  }
}

class World {
  constructor(ws, { plane = null, onOpen = null } = {}) {
    this.ws = ws;
    this.plane = plane;
    this.bodies = new Map();
    this.code = null;
    this.joinUrl = null;
    this.you = null;
    this.role = null;
    this.spec = null;
    this.closed = false;
    this.latest = null;                        // { at, bodies: Map<id, [x,y,z,qx,qy,qz,qw]> }
    this.previous = null;
    this.joints = new Map();                   // id -> { id, a, b, kind, la, lb }: anchors in each body's frame
    this.isHost = false;
    this.hostKey = null;
    this.permitted = [];                       // the commands this connection may send
    this.handlers = { hello: [], can: [], snap: [], event: [], hit: [], fell: [], broke: [], err: [], close: [], world: [], added: [], removed: [], joined: [] };
    this._rid = 0;
    this._waiting = new Map();
  }

  /** on('hit', ({a, b, speed}) => …) — also 'fell', 'event', 'snap', 'added', 'removed', 'err', 'close'. */
  on(what, fn) { (this.handlers[what] ||= []).push(fn); return this; }
  _emit(what, arg) { for (const fn of this.handlers[what] || []) { try { fn(arg); } catch (e) { console.error(e); } } }

  send(m) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }

  /** Send a command and wait for the server to confirm it (used by add()). */
  ask(m) {
    const rid = ++this._rid;
    return new Promise((resolve, reject) => {
      this._waiting.set(rid, { resolve, reject });
      this.send({ ...m, rid });
      setTimeout(() => { if (this._waiting.delete(rid)) reject(new Error(`no answer to "${m.t}"`)); }, 5000);
    });
  }

  /* ---- commands ---- */
  /** Add a body while the world runs; resolves with its id. */
  add(body) { return this.ask({ t: 'add', body: this._body(body) }).then((r) => r.id); }
  remove(id) { this.send({ t: 'remove', id }); }
  impulse(id, v, at = null) { this.send({ t: 'impulse', id, v: this._vec(v), ...(at ? { at: this._vec(at) } : {}) }); }
  torque(id, v) { this.send({ t: 'torque', id, v: this._vec(v) }); }
  velocity(id, lin, ang = null) { this.send({ t: 'velocity', id, lin: this._vec(lin), ...(ang ? { ang: this._vec(ang) } : {}) }); }
  place(id, pos, rot = null) { this.send({ t: 'place', id, pos: this._vec(pos), ...(rot ? { rot } : {}) }); }
  gravity(v) { this.send({ t: 'gravity', v: this._vec(v) }); }

  /**
   * Pick a body up — this connection's one hand — then drag it and let go.
   * opts.ghost: it (and whatever is jointed to it) passes through other bodies while held.
   * opts.hold: it keeps its angle instead of swinging; turn(angle) sets the angle.
   */
  grab(id, at = null, strength = 1, { ghost = false, hold = false } = {}) {
    this.send({ t: 'grab', id, ...(at ? { at: this._vec(at) } : {}), strength, ...(ghost ? { ghost } : {}), ...(hold ? { hold } : {}) });
  }
  /** Turn what this hand holds to an angle (radians; about z, or about `axis` in 3D). */
  turn(angle, axis = null) { this.send({ t: 'turn', angle, ...(axis ? { axis: this._vec(axis) } : {}) }); }

  /**
   * Join two bodies where they are now, at world point `at`. Resolves with the joint id.
   * opts: kind 'weld' (resists bending, the default) | 'pin' (a hinge), stiffness, bend, arm, breakAt.
   */
  joint(a, b, at, opts = {}) { return this.ask({ t: 'joint', a, b, at: this._vec(at), ...opts }).then((r) => r.id); }
  unjoint(id) { this.send({ t: 'unjoint', id }); }
  /**
   * Drive or release a hinge or slider: { speed, force } to drive it, { target, stiffness, damping }
   * to send it somewhere and hold it there, false to let go. { limits: [min, max] } changes how far
   * it may travel, and may be passed on its own.
   */
  motor(id, opts) {
    if (opts === false || opts === null) return this.send({ t: 'motor', id, motor: false });
    const { limits, ...motor } = opts || {};
    this.send({ t: 'motor', id, ...(limits !== undefined ? { limits } : {}), ...(Object.keys(motor).length ? { motor } : {}) });
  }
  /** Where a joint is right now, from its first body's interpolated pose. */
  jointPoint(j) {
    const b = this.bodies.get(j.a) || this.bodies.get(j.b);
    if (!b) return null;
    const l = b.id === j.a ? j.la : j.lb;
    const [x, y, z] = rotateVec([b.qx, b.qy, b.qz, b.qw], l);
    return { x: b.x + x, y: b.y + y, z: b.z + z };
  }
  drag(pos) { this.send({ t: 'drag', pos: this._vec(pos) }); }
  release() { this.send({ t: 'release' }); }

  /** Replace the world with a new spec (everything in it is thrown away). Host only. */
  reset(spec) { this.send({ t: 'world', spec: this._spec(spec), reset: true }); }

  /* ---- asking the world questions (each resolves with the room's answer) ---- */
  /** What is at this point? `{ ok, id, tag, at, inside, distance }` — a tap becomes a body id. */
  pick(at, radius) { return this.ask({ t: 'pick', at: this._vec(at), ...(radius != null ? { radius } : {}) }); }
  /** The first body a line meets: `{ ok, id, tag, at, normal, distance }`. */
  ray(from, dir, max) { return this.ask({ t: 'ray', from: this._vec(from), dir: this._vec(dir), ...(max != null ? { max } : {}) }); }
  /** Everything within a radius, nearest first: `{ ok, hits: [{ id, tag, distance }] }`. */
  area(at, radius) { return this.ask({ t: 'area', at: this._vec(at), ...(radius != null ? { radius } : {}) }); }

  /* ---- who may do what (the world's `control`; open unless it says otherwise) ---- */
  /** May this connection send this command? Use it to grey a button out rather than guess. */
  may(command) { return this.permitted.includes(command); }
  /** Narrow or open the world while it runs: 'open', 'host', or { players: [...] }. Host only. */
  control(policy) { this.send({ t: 'control', control: policy }); }

  _can(m) {
    if (Array.isArray(m.may)) this.permitted = m.may;
    if (typeof m.host === 'boolean') this.isHost = m.host;
    if (m.hostKey) {
      this.hostKey = m.hostKey;
      // so a big screen that reloads comes back as the host rather than as a spectator
      try { sessionStorage.setItem(`aha-phys-key:${this.code}`, m.hostKey); } catch {}
    }
  }

  close() { this.closed = true; try { this.ws.close(); } catch {} }

  /**
   * Call once per animation frame with the timestamp; returns the bodies, interpolated to a moment
   * BUFFER_MS in the past so motion between snapshots is smooth rather than steppy.
   */
  step(now = (typeof performance !== 'undefined' ? performance.now() : Date.now())) {
    const to = this.latest, from = this.previous;
    if (to && from && to.at > from.at) {
      const target = now - BUFFER_MS;
      const k = Math.max(0, Math.min(1, (target - from.at) / (to.at - from.at)));
      for (const [id, b] of this.bodies) {
        const a = from.bodies.get(id), c = to.bodies.get(id);
        if (!c) continue;
        if (!a || c[7]) { b.set(c); continue; }                         // new, or asleep: no need to blend
        b.set([
          a[0] + (c[0] - a[0]) * k, a[1] + (c[1] - a[1]) * k, a[2] + (c[2] - a[2]) * k,
          ...slerp(a, c, k),
        ]);
        b.sleeping = !!c[7];
      }
    }
    return [...this.bodies.values()];
  }

  /* ---- plumbing ---- */
  _vec(v) {
    if (!Array.isArray(v)) return [v?.x || 0, v?.y || 0, v?.z || 0];
    if (v.length === 2) return this.plane === 'xz' ? [v[0], 0, v[1]] : [v[0], v[1], 0];
    return [v[0] || 0, v[1] || 0, v[2] || 0];
  }
  _body(b) { return { ...b, ...(b.pos ? { pos: this._vec(b.pos) } : {}) }; }
  _spec(spec) {
    const out = { ...spec };
    if (out.gravity) out.gravity = this._vec(out.gravity);
    if (Array.isArray(out.bodies)) out.bodies = out.bodies.map((b) => this._body(b));
    return out;
  }

  _message(m) {
    switch (m.t) {
      case 'hello':
        this.you = m.you; this.role = m.role;
        this._can(m);
        if (m.world) this._world(m.world);
        this._emit('hello', m);
        break;
      case 'hostKey': this._can(m); this._emit('can', m); break;       // this connection built the world
      case 'can': this._can(m); this._emit('can', m); break;           // the host changed the policy
      case 'world': this._world(m.world); this._emit('world', m.world); break;
      case 'snap': {
        const at = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const bodies = new Map(m.full || !this.latest ? [] : this.latest.bodies);
        for (const row of m.b) bodies.set(row[0], row.slice(1));
        this.previous = this.latest || { at: at - 50, bodies: new Map(bodies) };
        this.latest = { at, bodies };
        for (const [id, t] of bodies) {
          let b = this.bodies.get(id);
          if (!b) { b = new Body(id); this.bodies.set(id, b); }
          b.set(t);                                        // step() smooths this; without it you still get the truth
          b.sleeping = !!t[7];
        }
        if (m.full) for (const id of [...this.bodies.keys()]) if (!bodies.has(id)) this.bodies.delete(id);
        this.hands = m.h || [];
        this._emit('snap', this);
        break;
      }
      case 'event':
        // something the world did: kind is 'hit' (two bodies met) or 'fell' (one left the world)
        if (m.kind === 'fell') this._gone(m.id);
        if (m.kind === 'broke') this.joints.delete(m.id);
        this._emit('event', m);
        if (m.kind) this._emit(m.kind, m);
        break;
      case 'added': this._emit('added', m); break;
      case 'removed': this._gone(m.id); this._emit('removed', m); break;
      case 'joined': if (m.joint) this.joints.set(m.joint.id, m.joint); this._emit('joined', m.joint); break;
      case 'unjoined': this.joints.delete(m.id); this._emit('broke', { id: m.id, why: 'unjoined' }); break;
      case 'ok': { const w = this._waiting.get(m.rid); if (w) { this._waiting.delete(m.rid); w.resolve(m); } break; }
      case 'err': {
        const w = m.rid && this._waiting.get(m.rid);
        if (w) { this._waiting.delete(m.rid); w.reject(new Error(m.msg)); }
        this._emit('err', m);
        break;
      }
    }
  }

  _gone(id) {
    this.bodies.delete(id);
    for (const [jid, j] of this.joints) if (j.a === id || j.b === id) this.joints.delete(jid);
  }

  _world(w) {
    this.spec = w;
    this.plane = w.plane || this.plane;
    this.joints = new Map((w.joints || []).map((j) => [j.id, j]));
    for (const def of w.bodies || []) {
      const b = this.bodies.get(def.id) || new Body(def.id);
      b.tag = def.tag; b.type = def.type; b.shape = def.shape;
      this.bodies.set(def.id, b);
    }
  }
}

function rotateVec([qx, qy, qz, qw], [x, y, z]) {
  const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
  return [ix * qw + iw * -qx + iy * -qz - iz * -qy, iy * qw + iw * -qy + iz * -qx - ix * -qz, iz * qw + iw * -qz + ix * -qy - iy * -qx];
}

function slerp(a, b, k) {
  let [x0, y0, z0, w0] = [a[3], a[4], a[5], a[6]];
  const [x1, y1, z1, w1] = [b[3], b[4], b[5], b[6]];
  let d = x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1;
  if (d < 0) { x0 = -x0; y0 = -y0; z0 = -z0; w0 = -w0; d = -d; }
  if (d > 0.9995) return [x0 + (x1 - x0) * k, y0 + (y1 - y0) * k, z0 + (z1 - z0) * k, w0 + (w1 - w0) * k];
  const th = Math.acos(d), s = Math.sin(th);
  const ka = Math.sin((1 - k) * th) / s, kb = Math.sin(k * th) / s;
  return [x0 * ka + x1 * kb, y0 * ka + y1 * kb, z0 * ka + z1 * kb, w0 * ka + w1 * kb];
}

async function connect({ code, role, name, origin, id, key }) {
  const base = origin || defaultOrigin();
  // a host key from an earlier connection in this tab reclaims authority after a reload
  let hostKey = key || '';
  if (!hostKey && role === 'host') { try { hostKey = sessionStorage.getItem(`aha-phys-key:${code}`) || ''; } catch {} }
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/phys/${code}?role=${role}` +
    (name ? `&name=${encodeURIComponent(name)}` : '') + (id ? `&id=${encodeURIComponent(id)}` : '') +
    (hostKey ? `&key=${encodeURIComponent(hostKey)}` : ''));
  const world = new World(ws);
  world.code = code;                                   // _can() stores the key under it
  // hello and the first snapshot follow the handshake immediately, so listen before waiting for open
  ws.addEventListener('message', (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } world._message(m); });
  ws.addEventListener('close', () => { world.closed = true; world._emit('close', null); });
  // resolve on the room's hello, not merely on the socket opening: by then the caller knows who it
  // is and what is already in the world
  await new Promise((resolve, reject) => {
    const done = () => { world.handlers.hello = []; resolve(); };
    world.on('hello', done);
    ws.addEventListener('error', () => reject(new Error(`cannot reach the physics room at ${base}`)), { once: true });
    ws.addEventListener('close', () => reject(new Error('the physics room closed the connection')), { once: true });
    setTimeout(() => reject(new Error(`no answer from the physics room at ${base}`)), 8000);
  });
  world.code = code;
  return world;
}

/** Mint a room, describe the world, and start it. Resolves once the server has built it. */
async function host(spec = {}, opts = {}) {
  const base = opts.origin || defaultOrigin();
  let code = opts.code;
  let joinUrl = null;
  if (!code) {
    // the page phones open: a path when this page is the relay's own, its https URL otherwise, and
    // nothing at all from a sandboxed or http page (the room still mints; there is just no join link)
    let page = opts.page || '';
    if (!page && hasDOM) {
      if (location.origin === base) page = location.pathname;
      else if (location.protocol === 'https:') page = location.origin + location.pathname;
    }
    const res = await fetch(`${base}/api/room`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page: page || undefined }),
    });
    if (!res.ok) throw new Error(`could not mint a room: ${res.status}`);
    const r = await res.json();
    code = r.code; joinUrl = page ? r.joinUrl : null;
  }
  const world = await connect({ code, role: 'host', origin: base, id: opts.id, key: opts.key });
  world.joinUrl = joinUrl;
  const built = new Promise((resolve, reject) => {
    world.on('world', resolve);
    world.on('err', (e) => { if (e.of === 'world') reject(new Error(e.msg)); });
    setTimeout(() => reject(new Error('the room did not build the world')), 8000);
  });
  world.plane = spec.plane || null;
  world.send({ t: 'world', spec: world._spec(spec), reset: !!opts.reset });
  await built;
  return world;
}

/** Join a world someone else set up. */
function join({ code, name, origin, id, key } = {}) {
  const c = code || (hasDOM && (new URLSearchParams(location.search).get('join') || (location.hash.match(/join=([A-Za-z0-9-]+)/) || [])[1]));
  if (!c) throw new Error('join({ code }) needs the room code (or ?join=CODE in the URL)');
  return connect({ code: String(c).toUpperCase(), role: 'player', name, origin, id, key });
}

export const AhaPhysics = { VERSION, host, join, connect, Body, World };
export default AhaPhysics;
