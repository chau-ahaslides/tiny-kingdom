/* A physics world any game can describe in JSON, on Rapier 3D. The room (phys-room.js) owns one of
   these and steps it; this file is the sim itself, so it also runs in Node for the tests.

   Units are metres, kilograms and seconds, y up — the same units Rapier uses. A 2D game asks for
   `plane: 'xy'`, which locks every dynamic body to z = 0 and to spinning about z only, so the 3D
   engine behaves exactly like a 2D one and the game ignores z.

   A body is { id, type, shape, pos, rot, ... }:
     shape: { ball: r } | { cuboid: [hx, hy, hz] } | { capsule: [halfHeight, r] } | { cylinder: [halfHeight, r] }
            (half-extents, as Rapier takes them: a 2 x 1 x 2 m crate is { cuboid: [1, 0.5, 1] })
     type:  'dynamic' (falls, the default) | 'fixed' (never moves) | 'kinematic' (the game moves it) */

export const LIMITS = { bodies: 400, shapeSize: 1000, speed: 1000, commandsPerSecond: 120 };

const v3 = (a = [0, 0, 0]) => ({ x: +a[0] || 0, y: +a[1] || 0, z: +a[2] || 0 });
const quat = (a) => (Array.isArray(a) && a.length === 4 ? { x: +a[0] || 0, y: +a[1] || 0, z: +a[2] || 0, w: Number.isFinite(+a[3]) ? +a[3] : 1 } : { x: 0, y: 0, z: 0, w: 1 });
const num = (x, dflt, lo, hi) => (Number.isFinite(+x) ? Math.max(lo, Math.min(hi, +x)) : dflt);
const round = (n, p = 3) => +n.toFixed(p);

/** Reject or clamp a spec a game sent us, so a typo cannot melt the room. Pure: no Rapier needed. */
export function normalise(spec = {}) {
  const errors = [];
  const bodies = [];
  const seen = new Set();
  for (const [i, raw] of (Array.isArray(spec.bodies) ? spec.bodies : []).entries()) {
    const b = normaliseBody(raw, `bodies[${i}]`, errors);
    if (!b) continue;
    if (b.id && seen.has(b.id)) { errors.push(`bodies[${i}]: duplicate id "${b.id}"`); continue; }   // unnamed bodies are numbered when they are built
    if (b.id) seen.add(b.id);
    bodies.push(b);
  }
  if (bodies.length > LIMITS.bodies) errors.push(`too many bodies (${bodies.length}, the limit is ${LIMITS.bodies})`);
  const plane = spec.plane === 'xy' || spec.plane === 'xz' ? spec.plane : null;
  return {
    spec: {
      gravity: spec.gravity ? [v3(spec.gravity).x, v3(spec.gravity).y, v3(spec.gravity).z] : [0, -9.81, 0],
      timestep: num(spec.timestep, 1 / 60, 1 / 240, 1 / 20),
      substeps: Math.round(num(spec.substeps, 1, 1, 4)),
      plane,
      floor: spec.floor === false ? false : num(spec.floor, -50, -10000, 10000),   // bodies below this are dropped
      events: !!spec.events,
      eventForce: num(spec.eventForce, 1, 0, 1e6),
      sleep: spec.sleep !== false,
      bodies,
    },
    errors,
  };
}

function normaliseBody(raw, where, errors) {
  if (!raw || typeof raw !== 'object') { errors.push(`${where}: not an object`); return null; }
  const id = typeof raw.id === 'string' && /^[\w.:-]{1,48}$/.test(raw.id) ? raw.id : null;
  if (raw.id != null && !id) { errors.push(`${where}: bad id (letters, digits, . : - _ and 48 characters)`); return null; }
  const shape = normaliseShape(raw.shape, where, errors);
  if (!shape) return null;
  const type = ['dynamic', 'fixed', 'kinematic'].includes(raw.type) ? raw.type : 'dynamic';
  return {
    id,
    type,
    shape,
    pos: [v3(raw.pos).x, v3(raw.pos).y, v3(raw.pos).z],
    rot: raw.rot ? [quat(raw.rot).x, quat(raw.rot).y, quat(raw.rot).z, quat(raw.rot).w] : null,
    density: num(raw.density, 1, 0.001, 1e5),
    friction: num(raw.friction, 0.5, 0, 10),
    restitution: num(raw.restitution, 0, 0, 1),
    linearDamping: num(raw.linearDamping, 0.05, 0, 100),
    angularDamping: num(raw.angularDamping, 0.1, 0, 100),
    ccd: !!raw.ccd,                                     // for small fast things that would tunnel
    sensor: !!raw.sensor,                               // reports touches, stops nothing
    lock: raw.lock === true ? true : null,              // no rotation at all
    tag: typeof raw.tag === 'string' ? raw.tag.slice(0, 32) : null,  // the game's own label, echoed back
  };
}

function normaliseShape(shape, where, errors) {
  if (!shape || typeof shape !== 'object') { errors.push(`${where}: shape is required ({ ball: r } | { cuboid: [hx, hy, hz] } | { capsule: [h, r] } | { cylinder: [h, r] })`); return null; }
  const S = LIMITS.shapeSize;
  const pos = (n) => Number.isFinite(+n) && +n > 0 && +n <= S;
  if (shape.ball != null) {
    if (!pos(shape.ball)) { errors.push(`${where}: ball radius must be > 0 and <= ${S}`); return null; }
    return { ball: +shape.ball };
  }
  for (const kind of ['cuboid', 'capsule', 'cylinder']) {
    if (shape[kind] == null) continue;
    const a = shape[kind];
    const n = kind === 'cuboid' ? 3 : 2;
    if (!Array.isArray(a) || a.length !== n || !a.every(pos)) { errors.push(`${where}: ${kind} takes ${n} positive numbers`); return null; }
    return { [kind]: a.map(Number) };
  }
  errors.push(`${where}: unknown shape ${Object.keys(shape).join(', ')}`);
  return null;
}

/* ---------------------------------------------------------------- the sim ---- */

export function createWorld(R, spec) {
  const world = new R.World(v3(spec.gravity));
  world.timestep = spec.timestep;
  const sim = { R, world, spec, bodies: new Map(), hands: new Map(), events: [], nextId: 1, seq: 0, t: 0, queue: null };
  if (spec.events) sim.queue = new R.EventQueue(true);
  for (const b of spec.bodies) addBody(sim, b);
  return sim;
}

export function addBody(sim, def) {
  if (sim.bodies.size >= LIMITS.bodies) return { ok: false, msg: `the world is full (${LIMITS.bodies} bodies)` };
  const { R, world, spec } = sim;
  const id = def.id || `b${sim.nextId++}`;
  if (sim.bodies.has(id)) return { ok: false, msg: `there is already a body called "${id}"` };
  const desc = def.type === 'fixed' ? R.RigidBodyDesc.fixed()
    : def.type === 'kinematic' ? R.RigidBodyDesc.kinematicPositionBased()
    : R.RigidBodyDesc.dynamic();
  desc.setTranslation(...def.pos)
    .setLinearDamping(def.linearDamping)
    .setAngularDamping(def.angularDamping)
    .setCanSleep(spec.sleep);
  if (def.rot) desc.setRotation(quat(def.rot));
  if (def.ccd) desc.setCcdEnabled(true);
  const body = world.createRigidBody(desc);
  if (def.lock) body.lockRotations(true, true);
  else if (spec.plane === 'xy') { body.setEnabledTranslations(true, true, false, true); body.setEnabledRotations(false, false, true, true); }
  else if (spec.plane === 'xz') { body.setEnabledTranslations(true, false, true, true); body.setEnabledRotations(false, true, false, true); }

  const s = def.shape;
  const cd = s.ball != null ? R.ColliderDesc.ball(s.ball)
    : s.cuboid ? R.ColliderDesc.cuboid(...s.cuboid)
    : s.capsule ? R.ColliderDesc.capsule(s.capsule[0], s.capsule[1])
    : R.ColliderDesc.cylinder(s.cylinder[0], s.cylinder[1]);
  cd.setDensity(def.density).setFriction(def.friction).setRestitution(def.restitution);
  if (def.sensor) cd.setSensor(true);
  if (sim.spec.events) cd.setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
  const collider = sim.world.createCollider(cd, body);
  sim.bodies.set(id, { id, body, collider, def, tag: def.tag });
  sim.seq++;
  return { ok: true, id };
}

export function removeBody(sim, id) {
  const rec = sim.bodies.get(id);
  if (!rec) return { ok: false, msg: `no body "${id}"` };
  for (const [hid, h] of sim.hands) if (h.id === id) release(sim, hid);
  sim.world.removeRigidBody(rec.body);
  sim.bodies.delete(id);
  sim.seq++;
  return { ok: true };
}

const cap = (v, m) => { const l = Math.hypot(v.x, v.y, v.z); return l > m ? { x: v.x * m / l, y: v.y * m / l, z: v.z * m / l } : v; };

/** One command from a client. Returns { ok } or { ok: false, msg }. */
export function apply(sim, m) {
  const rec = m.id ? sim.bodies.get(m.id) : null;
  switch (m.t) {
    case 'add': {
      const errors = [];
      const def = normaliseBody(m.body, 'body', errors);
      if (!def) return { ok: false, msg: errors[0] };
      return addBody(sim, def);
    }
    case 'remove': return removeBody(sim, m.id);
    case 'impulse':
      if (!rec) return { ok: false, msg: `no body "${m.id}"` };
      rec.body.wakeUp();
      rec.body.applyImpulse(cap(v3(m.v), LIMITS.speed), true);
      if (m.at) rec.body.applyImpulseAtPoint(cap(v3(m.v), LIMITS.speed), v3(m.at), true);
      return { ok: true };
    case 'torque':
      if (!rec) return { ok: false, msg: `no body "${m.id}"` };
      rec.body.wakeUp(); rec.body.applyTorqueImpulse(cap(v3(m.v), LIMITS.speed), true);
      return { ok: true };
    case 'velocity':
      if (!rec) return { ok: false, msg: `no body "${m.id}"` };
      rec.body.wakeUp();
      if (m.lin) rec.body.setLinvel(cap(v3(m.lin), LIMITS.speed), true);
      if (m.ang) rec.body.setAngvel(cap(v3(m.ang), LIMITS.speed), true);
      return { ok: true };
    case 'place': {                                  // teleport, or steer a kinematic body
      if (!rec) return { ok: false, msg: `no body "${m.id}"` };
      const p = v3(m.pos);
      if (rec.def.type === 'kinematic') rec.body.setNextKinematicTranslation(p);
      else { rec.body.setTranslation(p, true); rec.body.setLinvel(v3(), true); rec.body.setAngvel(v3(), true); }
      if (m.rot) { const q = quat(m.rot); rec.def.type === 'kinematic' ? rec.body.setNextKinematicRotation(q) : rec.body.setRotation(q, true); }
      return { ok: true };
    }
    case 'gravity':
      sim.world.gravity = v3(m.v);
      sim.spec.gravity = [sim.world.gravity.x, sim.world.gravity.y, sim.world.gravity.z];
      wakeAll(sim);
      return { ok: true };
    case 'grab': return grab(sim, m.hand, m.id, m.at, m.strength);
    case 'drag': return drag(sim, m.hand, m.pos);
    case 'release': return release(sim, m.hand);
    default: return { ok: false, msg: `unknown command "${m.t}"` };
  }
}

export function wakeAll(sim) { for (const r of sim.bodies.values()) r.body.wakeUp(); }

/* ---- hands: a kinematic point chases the pointer, a stiff spring ties the body to it. This is how a
   phone drags something around a shared world without owning the physics, and the spring is what makes
   it feel like holding rather than teleporting. ---- */
const HAND = { k: 3e3, d: 90, track: 22, speed: 40 };

export function grab(sim, hand, id, at, strength) {
  const hid = String(hand || 'h').slice(0, 32);
  const rec = sim.bodies.get(id);
  if (!rec) return { ok: false, msg: `no body "${id}"` };
  if (rec.def.type !== 'dynamic') return { ok: false, msg: `"${id}" is ${rec.def.type}, so nothing can pick it up` };
  release(sim, hid);
  const local = at ? v3(at) : { x: 0, y: 0, z: 0 };
  const p = rec.body.translation(), q = rec.body.rotation();
  const world = rotateBy(q, local, p);
  const finger = sim.world.createRigidBody(sim.R.RigidBodyDesc.kinematicPositionBased().setTranslation(world.x, world.y, world.z));
  const k = num(strength, 1, 0.05, 20) * HAND.k * Math.max(0.2, rec.body.mass());
  const j = sim.world.createImpulseJoint(sim.R.JointData.spring(0, k, HAND.d * Math.max(0.2, rec.body.mass()), v3(), local), finger, rec.body, true);
  rec.body.wakeUp();
  sim.hands.set(hid, { id, local, finger, j, target: world });
  return { ok: true, hand: hid };
}

export function drag(sim, hand, pos) {
  const h = sim.hands.get(String(hand || 'h').slice(0, 32));
  if (!h) return { ok: false, msg: 'nothing in that hand' };
  h.target = v3(pos);
  const rec = sim.bodies.get(h.id);
  if (rec) rec.body.wakeUp();
  return { ok: true };
}

export function release(sim, hand) {
  const hid = String(hand || 'h').slice(0, 32);
  const h = sim.hands.get(hid);
  if (!h) return { ok: true };
  sim.hands.delete(hid);
  try { sim.world.removeImpulseJoint(h.j, true); } catch (e) {}
  try { sim.world.removeRigidBody(h.finger); } catch (e) {}
  return { ok: true, id: h.id };
}

function rotateBy(q, v, offset) {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y, iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x, iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return {
    x: offset.x + ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: offset.y + iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: offset.z + iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}

/** One tick. dt is real time; the world steps at its own timestep, at most `substeps` times. */
export function step(sim, dt = 1 / 60) {
  const n = Math.max(1, Math.min(sim.spec.substeps, Math.round(dt / sim.spec.timestep)));
  for (let i = 0; i < n; i++) {
    // how hard a hit was is the speed going in, so it is read before the solver cancels it
    if (sim.queue) for (const rec of sim.bodies.values()) rec.vel = rec.body.linvel();
    for (const h of sim.hands.values()) {                       // the finger chases the pointer, speed-capped
      const p = h.finger.translation();
      let d = { x: (h.target.x - p.x) * Math.min(1, HAND.track * sim.spec.timestep), y: (h.target.y - p.y) * Math.min(1, HAND.track * sim.spec.timestep), z: (h.target.z - p.z) * Math.min(1, HAND.track * sim.spec.timestep) };
      d = cap(d, HAND.speed * sim.spec.timestep);
      h.finger.setNextKinematicTranslation({ x: p.x + d.x, y: p.y + d.y, z: p.z + d.z });
    }
    sim.world.step(sim.queue || undefined);
    sim.t += sim.spec.timestep;
    if (sim.queue) drainEvents(sim);
  }
  if (sim.spec.floor !== false) {
    for (const rec of [...sim.bodies.values()]) {
      if (rec.def.type !== 'dynamic') continue;
      if (rec.body.translation().y < sim.spec.floor) { sim.events.push({ t: 'fell', id: rec.id, tag: rec.tag }); removeBody(sim, rec.id); }
    }
  }
  return sim;
}

function drainEvents(sim) {
  const byHandle = new Map();
  for (const rec of sim.bodies.values()) byHandle.set(rec.collider.handle, rec);
  sim.queue.drainCollisionEvents((h1, h2, started) => {
    if (!started) return;
    const a = byHandle.get(h1), b = byHandle.get(h2);
    if (!a || !b) return;
    const va = a.vel || a.body.linvel(), vb = b.vel || b.body.linvel();
    const speed = Math.hypot(va.x - vb.x, va.y - vb.y, va.z - vb.z);
    if (speed < sim.spec.eventForce) return;
    if (sim.events.length < 64) sim.events.push({ t: 'hit', a: a.id, b: b.id, tagA: a.tag, tagB: b.tag, speed: round(speed, 2) });
  });
}

/** What the clients draw: every body (or only the moving ones), plus where each hand is. */
export function snapshot(sim, { all = true } = {}) {
  const b = [];
  for (const rec of sim.bodies.values()) {
    const sleeping = rec.body.isSleeping() || rec.def.type === 'fixed';
    if (!all && sleeping) continue;
    const p = rec.body.translation(), q = rec.body.rotation();
    b.push([rec.id, round(p.x), round(p.y), round(p.z), round(q.x, 4), round(q.y, 4), round(q.z, 4), round(q.w, 4), sleeping ? 1 : 0]);
  }
  const h = [...sim.hands.entries()].map(([hid, x]) => {
    const p = x.finger.translation();
    return [hid, x.id, round(p.x), round(p.y), round(p.z)];
  });
  return { b, h, seq: sim.seq, time: round(sim.t, 2) };   // `time`, not `t`: `t` is the message type
}

/** Is anything still moving? A world where everything sleeps costs nothing until someone touches it. */
export function isBusy(sim) {
  if (sim.hands.size) return true;
  // fixed and kinematic bodies never report sleep, and never move on their own either
  for (const rec of sim.bodies.values()) if (rec.def.type === 'dynamic' && !rec.body.isSleeping()) return true;
  return false;
}

/** The public facts about a world, for a client that has just connected. */
export function describe(sim) {
  return {
    gravity: sim.spec.gravity, plane: sim.spec.plane, timestep: sim.spec.timestep,
    bodies: [...sim.bodies.values()].map((r) => ({ id: r.id, type: r.def.type, shape: r.def.shape, tag: r.tag })),
  };
}
