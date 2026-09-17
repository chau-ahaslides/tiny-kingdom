/* A physics world any game can describe in JSON, on Rapier 3D. The room (phys-room.js) owns one of
   these and steps it; this file is the sim itself, so it also runs in Node for the tests.

   Units are metres, kilograms and seconds, y up — the same units Rapier uses. A 2D game asks for
   `plane: 'xy'`, which locks every dynamic body to z = 0 and to spinning about z only, so the 3D
   engine behaves exactly like a 2D one and the game ignores z.

   A body is { id, type, shape, pos, rot, ... }:
     shape: { ball: r } | { cuboid: [hx, hy, hz] } | { capsule: [halfHeight, r] } | { cylinder: [halfHeight, r] }
            (half-extents, as Rapier takes them: a 2 x 1 x 2 m crate is { cuboid: [1, 0.5, 1] })
     type:  'dynamic' (falls, the default) | 'fixed' (never moves) | 'kinematic' (the game moves it) */

import { createHand, trackHand, dropHand, pointOn } from './hand.js';
import { addJoint, removeJoint, setMotor, forgetBody, checkJoints, describeJoints, collisionGroups, onGrab, onRelease, turn } from './phys-joints.js';
import { normaliseControl } from './phys-control.js';
import { pick, ray, area, collisionEvent } from './phys-query.js';

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
      iterations: Math.round(num(spec.iterations, 4, 1, 16)),   // solver iterations: more holds stacks and joints stiffer
      plane,
      floor: spec.floor === false ? false : num(spec.floor, -50, -10000, 10000),   // bodies below this are dropped
      control: normaliseControl(spec.control, errors),   // who may send what (phys-control.js)
      settle: normaliseSettle(spec.settle),              // when a world counts as done moving
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
    // a body that drifts on purpose, or is fast enough to need ccd, keeps the world awake: it would
    // otherwise be frozen mid-glide by the settle rule
    restless: raw.restless != null ? !!raw.restless : !!raw.ccd,
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
  world.numSolverIterations = spec.iterations;
  const sim = { R, world, spec, bodies: new Map(), hands: new Map(), events: [], nextId: 1, seq: 0, t: 0, queue: null };
  if (spec.events) sim.queue = new R.EventQueue(true);
  for (const b of spec.bodies) addBody(sim, b);
  primeQueries(sim);
  return sim;
}

/**
 * Rapier builds the structures behind pick/ray/area during step(), so a world that has never stepped
 * answers no questions — and a game asking "what is here?" straight after building one is the normal
 * case. A zero-length step builds them and advances no time.
 *
 * One side effect to know about: this records contacts between bodies that already overlap, and a
 * joint made later with its contacts disabled — a hinge between a door and its post, say — cannot
 * shake off a contact that predates it. addAxisJoint() drops those pairs when it makes such a joint.
 */
function primeQueries(sim) {
  const dt = sim.world.timestep;
  sim.world.timestep = 0;
  sim.world.step();
  sim.world.timestep = dt;
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
  // a plane locks the translation out of it, but NOT the two rotations out of it: Rapier 0.20 loses all
  // contact friction on a body with both kinds of lock, so a 2D world's pieces skated across the floor
  // forever. step() straightens those rotations after every substep instead (flatten()).
  else if (spec.plane === 'xy') body.setEnabledTranslations(true, true, false, true);
  else if (spec.plane === 'xz') body.setEnabledTranslations(true, false, true, true);

  const s = def.shape;
  const cd = s.ball != null ? R.ColliderDesc.ball(s.ball)
    : s.cuboid ? R.ColliderDesc.cuboid(...s.cuboid)
    : s.capsule ? R.ColliderDesc.capsule(s.capsule[0], s.capsule[1])
    : R.ColliderDesc.cylinder(s.cylinder[0], s.cylinder[1]);
  cd.setDensity(def.density).setFriction(def.friction).setRestitution(def.restitution);
  if (def.sensor) cd.setSensor(true);
  if (def.sensor && !sim.spec.events) cd.setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);   // a zone always reports
  cd.setCollisionGroups(collisionGroups(def.type));          // so a carried ghost can pass through (phys-joints.js)
  if (sim.spec.events) cd.setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
  const collider = sim.world.createCollider(cd, body);
  sim.bodies.set(id, { id, body, collider, def, tag: def.tag });
  sim.seq++;
  sim.queriesStale = true;                     // pick/ray/area see it after the next step
  return { ok: true, id };
}

/* Call a world settled once it has stopped doing anything visible. Rapier's own sleep never comes for a
   structure held together by spring joints (tape, glue): the springs keep it trembling at a few mm/s,
   invisibly, forever — and body.sleep() is undone by the joints on the next step — so the room would step
   it forever. So when nobody is holding anything and every body has been nearly still for SETTLE.seconds,
   the world is settled: isBusy() says no, the room stops stepping it, and the next command unsettles it. */
const SETTLE = { speed: 0.35, spin: 0.35, seconds: 1.5 };

/**
 * `settle` in a spec: false to never settle, or { speed, spin, seconds } to change when a world
 * counts as done. The defaults suit things that fall and stop. A world where something drifts
 * slowly on purpose — a puck gliding, a balloon — would otherwise be called settled while it is
 * still visibly moving, and freeze: such a world lowers `speed`, or turns settling off.
 */
export function normaliseSettle(settle) {
  if (settle === false) return false;
  if (!settle || typeof settle !== 'object') return { ...SETTLE };
  return {
    speed: num(settle.speed, SETTLE.speed, 0, 1000),
    spin: num(settle.spin, SETTLE.spin, 0, 1000),
    seconds: num(settle.seconds, SETTLE.seconds, 0.1, 600),
  };
}
export function settle(sim, dt) {
  const rule = sim.spec.settle;
  if (rule === false) { sim.calm = 0; sim.settled = false; return; }     // this world never settles
  let calm = !sim.hands.size, awake = 0;
  if (calm) {
    for (const rec of sim.bodies.values()) {
      if (rec.def.type === 'kinematic' && rec.moving) { sim.driven = true; calm = false; break; }   // being steered
      if (rec.def.type !== 'dynamic' || rec.body.isSleeping()) continue;
      if (rec.def.restless) { calm = false; break; }    // a body that says it is never done (ccd, or `restless`)
      awake++;
      const v = rec.body.linvel(), w = rec.body.angvel();
      if (Math.hypot(v.x, v.y, v.z) > rule.speed || Math.hypot(w.x, w.y, w.z) > rule.spin) { calm = false; break; }
    }
  }
  if (calm) sim.driven = false;
  sim.calm = calm && awake ? (sim.calm || 0) + dt : 0;
  sim.settled = sim.calm >= rule.seconds;
}

/* Keep every dynamic body flat on its plane: no spin about the two axes in the plane, and an orientation
   that is a pure turn about the plane's normal. Done by hand after each substep because the engine's own
   rotation lock costs friction (see addBody). Only past a whisker, so a settled body is left alone. */
export function flatten(sim) {
  const n = sim.spec.plane === 'xy' ? 'z' : sim.spec.plane === 'xz' ? 'y' : null;
  if (!n) return;
  const [a, b] = n === 'z' ? ['x', 'y'] : ['x', 'z'];
  const [t1, t2, t3] = sim.spec.plane === 'xy' ? [true, true, false] : [true, false, true];
  for (const rec of sim.bodies.values()) {
    if (rec.def.type !== 'dynamic' || rec.def.lock || rec.body.isSleeping()) continue;
    /* A body on a hinge or a slider is a different case. Rapier 0.20 mishandles a joint on a body
       with a disabled translation: the constraint drifts and then explodes (spin in the hundreds).
       Same family as the friction bug — a locked degree of freedom and a constraint do not mix. So
       such a body keeps all three translations, and stays in the plane the honest way: its velocity
       out of the plane is zeroed here, and the joint holds its rotation better than this ever could. */
    if (sim.onAxis?.get(rec.id)) {
      const v = rec.body.linvel();
      if (Math.abs(v[n]) > 1e-6) { v[n] = 0; rec.body.setLinvel(v, false); }
      const p = rec.body.translation();
      if (Math.abs(p[n]) > 1e-4) { p[n] = 0; rec.body.setTranslation(p, false); }
      continue;
    }
    if (rec.unlocked) { rec.body.setEnabledTranslations(t1, t2, t3, true); rec.unlocked = false; }   // its last joint went
    const w = rec.body.angvel();
    if (Math.abs(w[a]) > 1e-4 || Math.abs(w[b]) > 1e-4) { w[a] = 0; w[b] = 0; rec.body.setAngvel(w, false); }
    const q = rec.body.rotation();
    if (Math.abs(q[a]) > 1e-5 || Math.abs(q[b]) > 1e-5) {
      const l = Math.hypot(q[n], q.w) || 1;
      rec.body.setRotation({ x: 0, y: 0, z: 0, w: q.w / l, [n]: q[n] / l }, false);
    }
  }
}

export function removeBody(sim, id) {
  const rec = sim.bodies.get(id);
  if (!rec) return { ok: false, msg: `no body "${id}"` };
  for (const [hid, h] of sim.hands) if (h.id === id) release(sim, hid);
  forgetBody(sim, id);
  sim.world.removeRigidBody(rec.body);
  sim.bodies.delete(id);
  sim.seq++;
  return { ok: true };
}

const cap = (v, m) => { const l = Math.hypot(v.x, v.y, v.z); return l > m ? { x: v.x * m / l, y: v.y * m / l, z: v.z * m / l } : v; };

/** One command from a client. Returns { ok } or { ok: false, msg }. */
export function apply(sim, m) {
  const rec = m.id ? sim.bodies.get(m.id) : null;
  if (m.t !== 'pick' && m.t !== 'ray' && m.t !== 'area') { sim.calm = 0; sim.settled = false; }   // anything but a question stirs the world
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
      if (rec.def.type === 'kinematic') { rec.body.setNextKinematicTranslation(p); rec.moving = true; }
      else { rec.body.setTranslation(p, true); rec.body.setLinvel(v3(), true); rec.body.setAngvel(v3(), true); }
      if (m.rot) { const q = quat(m.rot); rec.def.type === 'kinematic' ? rec.body.setNextKinematicRotation(q) : rec.body.setRotation(q, true); }
      return { ok: true };
    }
    case 'gravity':
      sim.world.gravity = v3(m.v);
      sim.spec.gravity = [sim.world.gravity.x, sim.world.gravity.y, sim.world.gravity.z];
      wakeAll(sim);
      return { ok: true };
    case 'grab': return grab(sim, m.hand, m.id, m.at, m.strength, m);
    case 'turn': return turn(sim, sim.hands.get(String(m.hand || 'h').slice(0, 32)), m.angle, m.axis);
    case 'joint': return addJoint(sim, m);
    case 'unjoint': return removeJoint(sim, m.id);
    case 'motor': return setMotor(sim, m);          // drive or hold a hinge or slider (phys-joints.js)
    // reads: they answer the asking connection and leave a settled world settled (phys-query.js)
    case 'pick': case 'ray': case 'area': {
      if (sim.queriesStale) { primeQueries(sim); sim.queriesStale = false; }
      return m.t === 'pick' ? pick(sim, m) : m.t === 'ray' ? ray(sim, m) : area(sim, m);
    }
    case 'drag': return drag(sim, m.hand, m.pos);
    case 'release': return release(sim, m.hand);
    default: return { ok: false, msg: `unknown command "${m.t}"` };
  }
}

export function wakeAll(sim) { for (const r of sim.bodies.values()) r.body.wakeUp(); }

/* ---- hands: see hand.js, which the Marshmallow Challenge and this room both grip with. The only
   difference here is that stiffness scales with the body's mass, because this world's bodies can be
   any size, where Marshmallow's are all spaghetti. ---- */
const HAND = { k: 3e3, d: 90, track: 22, speed: 40 };

export function grab(sim, hand, id, at, strength, opts = {}) {
  const hid = String(hand || 'h').slice(0, 32);
  const rec = sim.bodies.get(id);
  if (!rec) return { ok: false, msg: `no body "${id}"` };
  if (rec.def.type !== 'dynamic') return { ok: false, msg: `"${id}" is ${rec.def.type}, so nothing can pick it up` };
  release(sim, hid);
  const mass = Math.max(0.2, rec.body.mass());
  const h = createHand(sim.R, sim.world, rec.body, at ? v3(at) : v3(), {
    k: num(strength, 1, 0.05, 20) * HAND.k * mass,
    d: HAND.d * mass,
  });
  const held = { ...h, id };
  sim.hands.set(hid, held);
  onGrab(sim, held, rec, opts);
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
  dropHand(sim.world, h);
  onRelease(sim, h);
  return { ok: true, id: h.id };
}

/** One tick. dt is real time; the world steps at its own timestep, at most `substeps` times. */
export function step(sim, dt = 1 / 60) {
  const n = Math.max(1, Math.min(sim.spec.substeps, Math.round(dt / sim.spec.timestep)));
  for (let i = 0; i < n; i++) {
    // how hard a hit was is the speed going in, so it is read before the solver cancels it
    if (sim.queue) for (const rec of sim.bodies.values()) rec.vel = rec.body.linvel();
    for (const h of sim.hands.values()) trackHand(h, sim.spec.timestep, HAND);
    sim.world.step(sim.queue || undefined);
    flatten(sim);
    sim.t += sim.spec.timestep;
    if (sim.queue) drainEvents(sim);
    checkJoints(sim);
  }
  settle(sim, n * sim.spec.timestep);
  // `moving` means "steered since the last step": a kinematic body driven every frame keeps the
  // world awake, one placed once does not
  for (const rec of sim.bodies.values()) if (rec.moving) rec.moving = false;
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
    const a = byHandle.get(h1), b = byHandle.get(h2);
    if (!a || !b) return;
    const e = collisionEvent(sim, a, b, started, sim.spec.eventForce);
    if (e && sim.events.length < 64) sim.events.push(e);
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
  // a world whose only moving thing is a kinematic body the game is steering has nothing awake to
  // speak for it, and stopping the loop would strand that body mid-travel
  if (sim.driven) return true;
  if (sim.settled) return false;                                   // trembling on its springs, but done (settle())
  // fixed and kinematic bodies never report sleep, and never move on their own either
  for (const rec of sim.bodies.values()) if (rec.def.type === 'dynamic' && !rec.body.isSleeping()) return true;
  return false;
}

/** The public facts about a world, for a client that has just connected. */
export function describe(sim) {
  return {
    gravity: sim.spec.gravity, plane: sim.spec.plane, timestep: sim.spec.timestep, control: sim.spec.control,
    bodies: [...sim.bodies.values()].map((r) => ({ id: r.id, type: r.def.type, shape: r.def.shape, tag: r.tag })),
    joints: describeJoints(sim),
  };
}
