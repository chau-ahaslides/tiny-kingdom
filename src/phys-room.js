/* A physics room any game can rent: one Durable Object per code, running the same server-side Rapier
   the Marshmallow Challenge runs on, but with the world described by the game rather than baked in.

   The point is that nobody's browser owns the simulation. The room steps it and broadcasts the
   result, so twenty phones and a big screen all see one world, a phone can shove something without
   asking the big screen, and a reload changes nothing.

     wss://play.ahaslides.io/phys/<CODE>?role=host          the screen that sets the world up
     wss://play.ahaslides.io/phys/<CODE>?role=player&name=  a phone (any number)

   The first host sends { t: 'world', spec } and the room builds it; later hosts get the world as it
   is. Everyone may send commands (add, impulse, grab/drag/release …, see phys-world.js); the room
   answers with snapshots at SNAP_HZ and with events (a hit, something falling out of the world).
   public/js/aha-physics.js is the client; the protocol is small enough to speak by hand. */
import RAPIER from '@dimforge/rapier3d';
import { normalise, createWorld, apply, snapshot, describe, step, isBusy, LIMITS } from './phys-world.js';
import { allowed, refusal, permissions, normaliseControl, READS } from './phys-control.js';

const TICK_MS = 1000 / 60;
const SNAP_HZ = 20;                       // snapshots per second; clients interpolate between them
const KEYFRAME_MS = 2000;                 // a full snapshot this often, so a late joiner and a dropped
const IDLE_MS = 15 * 60 * 1000;           // packet both recover
const MAX_SPEC = 256 * 1024;

export class PhysRoom {
  constructor(state, env) {
    this.state = state;
    this.sockets = new Set();             // every connection: { ws, role, id, name, budget }
    this.sim = null;
    this.specRaw = null;
    this.loop = null;
    this.lastSnap = 0;
    this.lastKey = 0;
    this.lastActive = Date.now();
    this.nextPlayer = 1;
    this.hostKey = null;                  // minted with the world; the only thing that makes a host
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get('Upgrade') !== 'websocket') {
      // a plain GET is a health check: what is in this room right now
      return Response.json(this.sim
        ? { running: !!this.loop, sockets: this.sockets.size, ...describe(this.sim) }
        : { running: false, sockets: this.sockets.size, world: null });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const role = url.searchParams.get('role') === 'host' ? 'host' : 'player';
    const name = (url.searchParams.get('name') || '').slice(0, 24);
    const id = role === 'host' ? `host${this.nextPlayer++}` : (url.searchParams.get('id') || `p${this.nextPlayer++}`).replace(/[^\w.:-]/g, '').slice(0, 32);
    // ?role=host is a claim anyone can make; the key the room minted is the evidence. A room with no
    // world yet has no key, so whoever builds the world becomes its host.
    const key = url.searchParams.get('key') || '';
    const conn = { ws: server, role, id, name, budget: LIMITS.commandsPerSecond, second: Math.floor(Date.now() / 1000),
                   host: !this.hostKey || (!!key && key === this.hostKey) };
    this.sockets.add(conn);
    this.lastActive = Date.now();

    this.send(conn, {
      t: 'hello', you: id, role, world: this.sim ? describe(this.sim) : null,
      ...permissions(this.sim?.spec?.control, conn.host),
      ...(conn.host && this.hostKey ? { hostKey: this.hostKey } : {}),
    });
    if (this.sim) this.send(conn, { t: 'snap', full: 1, ...snapshot(this.sim) });

    server.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      this.onMessage(conn, m);
    });
    const gone = () => {
      if (!this.sockets.delete(conn)) return;
      if (this.sim) { apply(this.sim, { t: 'release', hand: id }); this.broadcast({ t: 'left', id }); }
      if (!this.sockets.size) this.stop();
    };
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);
    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(conn, m) {
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'ping') return this.send(conn, { t: 'pong', ms: m.ms });
    const now = Math.floor(Date.now() / 1000);
    if (conn.second !== now) { conn.second = now; conn.budget = LIMITS.commandsPerSecond; }
    if (conn.budget-- <= 0) return;                                    // a runaway loop cannot flood the room
    this.lastActive = Date.now();

    if (m.t === 'world') {
      if (this.sim && !conn.host) return this.send(conn, { t: 'err', of: 'world', rid: m.rid, msg: refusal(this.sim.spec.control, 'world') });
      if (JSON.stringify(m.spec || {}).length > MAX_SPEC) return this.send(conn, { t: 'err', of: 'world', rid: m.rid, msg: 'world spec too large' });
      const { spec, errors } = normalise(m.spec);
      if (errors.length) return this.send(conn, { t: 'err', of: 'world', rid: m.rid, msg: errors[0], errors });
      if (this.sim && !m.reset) return this.send(conn, { t: 'world', world: describe(this.sim), note: 'this room already has a world; send reset: true to replace it' });
      this.build(spec, m.spec);
      conn.host = true;
      if (!this.hostKey) this.hostKey = crypto.randomUUID().replace(/-/g, '');
      this.send(conn, { t: 'hostKey', hostKey: this.hostKey, ...permissions(spec.control, true) });
      for (const c of this.sockets) if (c !== conn) this.send(c, { t: 'can', ...permissions(spec.control, c.host) });
      this.broadcast({ t: 'world', world: describe(this.sim) });
      this.broadcast({ t: 'snap', full: 1, ...snapshot(this.sim) });
      this.run();
      return;
    }
    if (!this.sim) return this.send(conn, { t: 'err', of: m.t, msg: 'this room has no world yet: send { t: "world", spec }' });

    if (m.t === 'control') {                                           // the host narrows or opens the world
      if (!conn.host) return this.send(conn, { t: 'err', of: 'control', rid: m.rid, msg: refusal(this.sim.spec.control, 'control') });
      const errors = [];
      const next = normaliseControl(m.control, errors);
      if (errors.length) return this.send(conn, { t: 'err', of: 'control', rid: m.rid, msg: errors[0], errors });
      this.sim.spec.control = next;
      for (const c of this.sockets) this.send(c, { t: 'can', ...permissions(next, c.host) });
      return;
    }
    // Who may do what: open by default, so a phone acts without asking. A world that says otherwise
    // gets a refusal naming the policy, rather than a command that silently does nothing.
    if (!allowed(this.sim.spec.control, m.t, conn.host)) {
      return this.send(conn, { t: 'err', of: m.t, rid: m.rid, msg: refusal(this.sim.spec.control, m.t) });
    }

    // a hand belongs to the connection that owns it, so one phone cannot drop another's grip
    if (m.t === 'grab' || m.t === 'drag' || m.t === 'release' || m.t === 'turn') m = { ...m, hand: conn.id };
    const r = apply(this.sim, m);
    // a read that found nothing still answers: "nothing under your finger" is a fact, not a failure
    if (!r.ok && !READS.includes(m.t)) return this.send(conn, { t: 'err', of: m.t, rid: m.rid, msg: r.msg });
    if (m.t === 'add') this.broadcast({ t: 'added', id: r.id, by: conn.id });
    if (m.t === 'remove') this.broadcast({ t: 'removed', id: m.id, by: conn.id });
    if (m.t === 'joint') this.broadcast({ t: 'joined', joint: r.joint, by: conn.id });
    if (m.t === 'unjoint') this.broadcast({ t: 'unjoined', id: m.id, by: conn.id });
    if (m.rid) this.send(conn, { ...r, t: 'ok', rid: m.rid });   // the whole answer: a query has more than an id
    this.run();                                                        // any command wakes the loop
  }

  build(spec, raw) {
    this.sim = createWorld(RAPIER, spec);
    this.specRaw = raw;
    this.lastKey = 0;
  }

  /* The loop runs only while something is moving or someone is holding something: a settled world
     costs nothing, and the next command starts it again. */
  run() {
    if (this.loop || !this.sim) return;
    let last = Date.now();
    this.loop = setInterval(() => {
      const now = Date.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      step(this.sim, dt);

      if (this.sim.events.length) {
        for (const e of this.sim.events.splice(0, 64)) this.broadcast({ ...e, t: 'event', kind: e.t });
      }
      if (now - this.lastSnap >= 1000 / SNAP_HZ) {
        const full = now - this.lastKey >= KEYFRAME_MS;
        this.lastSnap = now;
        if (full) this.lastKey = now;
        this.broadcast({ t: 'snap', ...(full ? { full: 1 } : {}), ...snapshot(this.sim, { all: full }) });
      }
      if (!this.sockets.size || now - this.lastActive > IDLE_MS) return this.stop();
      if (!isBusy(this.sim)) {                                         // everything asleep: idle until the next command
        this.broadcast({ t: 'snap', full: 1, still: 1, ...snapshot(this.sim) });
        this.stop(false);
      }
    }, TICK_MS);
  }

  stop(clear = true) {
    if (this.loop) { clearInterval(this.loop); this.loop = null; }
    if (clear && !this.sockets.size) { this.sim = null; this.specRaw = null; }
  }

  send(conn, o) { try { conn.ws.send(JSON.stringify(o)); } catch {} }
  broadcast(o) {
    const raw = JSON.stringify(o);
    for (const c of this.sockets) { try { c.ws.send(raw); } catch {} }
  }
}
