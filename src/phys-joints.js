/* Joints for the shared physics room: tape, glue, a hinge. phys-world.js calls in here; this file owns
   the joints themselves and the two grab options that building things with them needs.

   A joint ties two bodies together at a world point, keeping the pose they have when it is made:

     { t: 'joint', a, b, at: [x, y, z], kind: 'pin' | 'weld', stiffness, bend, breakAt }

     pin    one stiff spring at the point: the bodies hinge about it.
     weld   the same, plus a softer spring `arm` along body b, so the joint resists bending (tape, not
            a hinge). `bend` scales it: 0 is a pin, 1 is as stiff as the pin itself.
     hinge  a real revolute joint about `axis` (z by default, which is the one a 2D world turns in):
            a door, a wheel, a flipper, a see-saw.
     slider a prismatic joint along `axis`: a lift, a drawer, a piston.

   A hinge or a slider can be held between `limits` — [min, max], radians for a hinge and world units
   for a slider — and driven by a `motor`, which is either a speed to hold ({ speed, force }) or a
   place to reach and keep ({ target, stiffness, damping, force }). `{ t: 'motor', id, ... }` changes
   one while the world runs, and `motor: false` lets it go slack. That covers the things a game would
   otherwise fake by teleporting a body every frame: doors that swing, platforms that travel, wheels
   that drive, catapults that release.

   Joints are springs rather than rigid constraints on purpose: a spring's stretch is how hard the
   joint is loaded, so `breakAt` (a stretch, in world units) is all it takes for an overloaded or yanked
   joint to come apart. When one does, the world reports { t: 'broke', id, a, b }.

   Grab options:
     ghost  the carried body, and everything jointed to it, passes through other dynamic bodies while
            held (fixed ones still stop it), so you can carry a piece into a structure without
            knocking it down.
     hold   the carried body keeps its angle rather than swinging from the grabbed point; `turn`
            then sets that angle. */

const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
const num = (x, dflt, lo, hi) => (Number.isFinite(+x) ? Math.max(lo, Math.min(hi, +x)) : dflt);
const round = (n, p = 3) => +n.toFixed(p);

export const JOINT_LIMITS = { joints: 800, stiffness: 1e6 };

// Collision groups: fixed bodies are in FIXED, everything else in DYNAMIC, and a ghost is in GHOST,
// which only FIXED will meet. Membership is the high 16 bits, the filter the low 16.
const FIXED = 1, DYNAMIC = 2, GHOST = 4;
const groups = (member, filter) => (member << 16) | filter;
export const collisionGroups = (type) => groups(type === 'fixed' ? FIXED : DYNAMIC, 0xffff);

function rotate(q, v) {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y, iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x, iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return v3(ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y, iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z, iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x);
}
const conj = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
const toWorld = (body, l) => { const p = body.translation(), r = rotate(body.rotation(), l); return v3(p.x + r.x, p.y + r.y, p.z + r.z); };
const toLocal = (body, w) => { const p = body.translation(); return rotate(conj(body.rotation()), v3(w.x - p.x, w.y - p.y, w.z - p.z)); };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const r3 = (v) => [round(v.x) + 0, round(v.y) + 0, round(v.z) + 0];   // + 0: no -0 on the wire

function spring(sim, A, B, world, k, d) {
  const la = toLocal(A.body, world), lb = toLocal(B.body, world);
  const j = sim.world.createImpulseJoint(sim.R.JointData.spring(0, k, d, la, lb), A.body, B.body, true);
  j.setContactsEnabled(false);
  return { j, la, lb };
}
const drop = (sim, s) => { if (s) try { sim.world.removeImpulseJoint(s.j, true); } catch (e) {} };

/** Make a joint. Returns { ok, id, joint } where joint is what clients are told. */
export function addJoint(sim, m) {
  sim.joints ||= new Map();
  sim.nextJoint ||= 1;
  if (sim.joints.size >= JOINT_LIMITS.joints) return { ok: false, msg: `too many joints (the limit is ${JOINT_LIMITS.joints})` };
  const A = sim.bodies.get(m.a), B = sim.bodies.get(m.b);
  if (!A || !B) return { ok: false, msg: `no body "${A ? m.b : m.a}"` };
  if (A === B) return { ok: false, msg: 'a body cannot be jointed to itself' };
  if (A.def.type !== 'dynamic' && B.def.type !== 'dynamic') return { ok: false, msg: 'at least one side of a joint must be dynamic' };
  const id = typeof m.jid === 'string' && /^[\w.:-]{1,48}$/.test(m.jid) ? m.jid : `j${sim.nextJoint++}`;
  if (sim.joints.has(id)) return { ok: false, msg: `there is already a joint called "${id}"` };
  const at = Array.isArray(m.at) ? v3(+m.at[0] || 0, +m.at[1] || 0, +m.at[2] || 0) : A.body.translation();
  const kind = ['pin', 'weld', 'hinge', 'slider'].includes(m.kind) ? m.kind : 'weld';
  if (kind === 'hinge' || kind === 'slider') return addAxisJoint(sim, { ...m, id, kind, A, B, at });
  // stiffness is per unit of the lighter body's mass, so a default joint holds whatever it joins
  const mass = Math.max(0.01, Math.min(...[A, B].filter((r) => r.def.type === 'dynamic').map((r) => r.body.mass())));
  const k = num(m.stiffness, 4e3, 1, JOINT_LIMITS.stiffness) * mass;
  const d = 2 * Math.sqrt(k * mass) * num(m.damping, 1, 0, 20);
  const breakAt = m.breakAt == null ? null : num(m.breakAt, null, 1e-3, 1e3);
  const main = spring(sim, A, B, at, k, d);
  let bendS = null;
  if (kind === 'weld') {
    const bend = num(m.bend, 0.25, 0, 1);
    if (bend > 0) {
      // a second point along b, away from the joint: the further it is, the more leverage it has
      const pb = B.def.type === 'dynamic' ? B.body.translation() : A.body.translation();
      let dx = pb.x - at.x, dy = pb.y - at.y, dz = pb.z - at.z;
      const l = Math.hypot(dx, dy, dz);
      const arm = num(m.arm, 0.5, 0.01, 100);
      if (l < 1e-4) { dx = 1; dy = 0; dz = 0; } else { dx /= l; dy /= l; dz /= l; }
      bendS = spring(sim, A, B, v3(at.x + dx * arm, at.y + dy * arm, at.z + dz * arm), k * bend, d * Math.sqrt(bend));
    }
  }
  const rec = { id, a: A.id, b: B.id, kind, main, bend: bendS, breakAt };
  sim.joints.set(id, rec);
  A.body.wakeUp(); B.body.wakeUp();
  if (isGhost(sim, A.id) || isGhost(sim, B.id)) for (const r of connected(sim, A.id)) ghost(r, true);
  sim.seq++;
  return { ok: true, id, joint: describeJoint(rec) };
}

/* A hinge or a slider: a real constraint rather than a spring, so it holds exactly and can carry a
   limit and a motor. Rapier wants the anchor in each body's own frame and an axis; the world point
   and a world axis are what a game has, so they are converted here. */
/** How many hinges or sliders hold each body: flatten() leaves those bodies alone (phys-world.js). */
function onAxis(sim, id, delta) {
  sim.onAxis ||= new Map();
  const n = (sim.onAxis.get(id) || 0) + delta;
  if (n > 0) sim.onAxis.set(id, n); else sim.onAxis.delete(id);
}

function addAxisJoint(sim, { id, kind, A, B, at, axis, limits, motor }) {
  const R = sim.R;
  const ax = Array.isArray(axis) ? v3(+axis[0] || 0, +axis[1] || 0, +axis[2] || 0) : v3(0, 0, 1);
  const len = Math.hypot(ax.x, ax.y, ax.z);
  if (!len) return { ok: false, msg: 'a hinge or slider needs an axis with a length' };
  const unit = v3(ax.x / len, ax.y / len, ax.z / len);
  const la = toLocal(A.body, at), lb = toLocal(B.body, at);
  // the axis is given in world terms; each body needs it in its own
  const aa = rotate(conj(A.body.rotation()), unit), ab = rotate(conj(B.body.rotation()), unit);
  const data = kind === 'hinge'
    ? R.JointData.revolute(la, lb, aa)
    : R.JointData.prismatic(la, lb, aa);
  const j = sim.world.createImpulseJoint(data, A.body, B.body, true);
  // a door and its post meet exactly where the hinge is: left to collide they grind and never swing
  j.setContactsEnabled(false);
  const rec = { id, a: A.id, b: B.id, kind, main: { j, la, lb }, bend: null, breakAt: null, axis: [unit.x, unit.y, unit.z] };
  sim.joints.set(id, rec);
  const set = setAxis(sim, rec, { limits, motor });
  if (!set.ok) { drop(sim, rec.main); sim.joints.delete(id); return set; }
  onAxis(sim, A.id, 1); onAxis(sim, B.id, 1);
  // In a plane world a body carries a translation lock, and Rapier 0.20 solves a joint on a locked
  // body badly — it drifts and then explodes. The lock comes off here, before the first solve ever
  // sees this joint; flatten() keeps the body in its plane by velocity instead (phys-world.js).
  if (sim.spec.plane) for (const rec of [A, B]) {
    if (rec.def.type !== 'dynamic' || rec.def.lock) continue;
    rec.body.setEnabledTranslations(true, true, true, true);
    rec.unlocked = true;
  }
  /* A hinge is normally made between bodies that already touch — a door and its post. Any contact
     recorded before the joint existed outlives setContactsEnabled(false), and wedges the two solid:
     the door never swings. Turning each collider off and on again drops those stale pairs. */
  for (const rec of [A, B]) { rec.collider.setEnabled(false); rec.collider.setEnabled(true); }
  A.body.wakeUp(); B.body.wakeUp();
  sim.seq++;
  return { ok: true, id, joint: describeJoint(rec) };
}

/** Limits and motor on a hinge or slider; used when it is made and by the `motor` command. */
function setAxis(sim, rec, { limits, motor }) {
  const j = rec.main.j;
  if (limits !== undefined) {
    if (limits === false || limits === null) rec.limits = null;
    else if (Array.isArray(limits) && limits.length === 2 && limits.every((n) => Number.isFinite(+n)) && +limits[0] <= +limits[1]) {
      j.setLimits(+limits[0], +limits[1]);
      rec.limits = [+limits[0], +limits[1]];
    } else return { ok: false, msg: 'limits are [min, max], min first (radians for a hinge, distance for a slider)' };
  }
  if (motor !== undefined) {
    if (motor === false || motor === null) {
      // a velocity motor asked for zero is a brake, not a release: the force has to go to zero
      j.configureMotorVelocity(0, 0);
      j.setMotorMaxForce?.(0);
      rec.motor = null;
    } else if (motor && typeof motor === 'object') {
      const force = num(motor.force, 1e3, 0, JOINT_LIMITS.stiffness);
      j.setMotorMaxForce?.(force);
      if (motor.target != null) {
        j.configureMotorPosition(+motor.target, num(motor.stiffness, 1e3, 0, JOINT_LIMITS.stiffness), num(motor.damping, 50, 0, JOINT_LIMITS.stiffness));
        rec.motor = { target: +motor.target, force };
      } else {
        j.configureMotorVelocity(num(motor.speed, 0, -1e3, 1e3), force);
        rec.motor = { speed: num(motor.speed, 0, -1e3, 1e3), force };
      }
    } else return { ok: false, msg: 'motor is { speed, force } to drive, { target, stiffness, damping } to hold, or false' };
  }
  for (const bid of [rec.a, rec.b]) sim.bodies.get(bid)?.body.wakeUp();
  return { ok: true };
}

/** `{ t: 'motor', id, motor, limits }` — change a hinge or slider while the world runs. */
export function setMotor(sim, m) {
  const rec = sim.joints?.get(m.id);
  if (!rec) return { ok: false, msg: `no joint "${m.id}"` };
  if (rec.kind !== 'hinge' && rec.kind !== 'slider') return { ok: false, msg: `"${m.id}" is a ${rec.kind}: only a hinge or a slider has a motor` };
  const r = setAxis(sim, rec, { limits: m.limits, motor: m.motor });
  return r.ok ? { ok: true, id: rec.id, joint: describeJoint(rec) } : r;
}

export function removeJoint(sim, id, why = null) {
  const rec = sim.joints?.get(id);
  if (!rec) return { ok: false, msg: `no joint "${id}"` };
  drop(sim, rec.main); drop(sim, rec.bend);
  if (rec.kind === 'hinge' || rec.kind === 'slider') { onAxis(sim, rec.a, -1); onAxis(sim, rec.b, -1); }
  sim.joints.delete(id);
  for (const bid of [rec.a, rec.b]) sim.bodies.get(bid)?.body.wakeUp();
  if (why) sim.events.push({ t: 'broke', id, a: rec.a, b: rec.b, why });
  sim.seq++;
  return { ok: true, id };
}

/** A body is going away: its joints go first (Rapier drops them anyway, but we must forget them). */
export function forgetBody(sim, bodyId) {
  for (const j of [...(sim.joints?.values() || [])]) if (j.a === bodyId || j.b === bodyId) removeJoint(sim, j.id, 'removed');
}

/** After each step: joints stretched past breakAt come apart. */
export function checkJoints(sim) {
  if (!sim.joints?.size) return;
  for (const j of [...sim.joints.values()]) {
    if (j.breakAt == null || j.kind === 'hinge' || j.kind === 'slider') continue;   // a real constraint does not stretch
    const A = sim.bodies.get(j.a), B = sim.bodies.get(j.b);
    if (!A || !B) { removeJoint(sim, j.id, 'removed'); continue; }
    if (dist(toWorld(A.body, j.main.la), toWorld(B.body, j.main.lb)) > j.breakAt) removeJoint(sim, j.id, 'stretched');
  }
}

export function describeJoint(j) {
  return {
    id: j.id, a: j.a, b: j.b, kind: j.kind, la: r3(j.main.la), lb: r3(j.main.lb),
    ...(j.axis ? { axis: j.axis } : {}), ...(j.limits ? { limits: j.limits } : {}), ...(j.motor ? { motor: j.motor } : {}),
  };
}
export const describeJoints = (sim) => [...(sim.joints?.values() || [])].map(describeJoint);

/** Every body joined to this one, through any chain of joints, itself included. */
export function connected(sim, id) {
  const seen = new Set([id]), q = [id];
  while (q.length) {
    const c = q.pop();
    for (const j of sim.joints?.values() || []) {
      const o = j.a === c ? j.b : j.b === c ? j.a : null;
      if (o && !seen.has(o)) { seen.add(o); q.push(o); }
    }
  }
  return [...seen].map((i) => sim.bodies.get(i)).filter((r) => r && r.def.type === 'dynamic');
}

const isGhost = (sim, id) => { for (const h of sim.hands.values()) if (h.ghost && h.id === id) return true; return false; };
function ghost(rec, on) { rec.collider.setCollisionGroups(on ? groups(GHOST, FIXED) : collisionGroups(rec.def.type)); }

/** Grab options, applied once the hand exists. */
export function onGrab(sim, hand, rec, opts = {}) {
  hand.ghost = !!opts.ghost;
  hand.hold = !!opts.hold;
  if (hand.ghost) for (const r of connected(sim, rec.id)) ghost(r, true);
  if (hand.hold) {
    rec.body.setAngvel(v3(), true);
    rec.body.lockRotations(true, true);
  }
}

/** Undo them when the hand lets go. */
export function onRelease(sim, hand) {
  const rec = sim.bodies.get(hand.id);
  if (!rec) return;
  if (hand.hold) {
    if (!rec.def.lock) rec.body.lockRotations(false, true);          // a plane's flatten() keeps it flat (phys-world.js)
  }
  if (hand.ghost) {
    const stillHeld = new Set([...sim.hands.values()].filter((h) => h !== hand && h.ghost).flatMap((h) => connected(sim, h.id).map((r) => r.id)));
    for (const r of connected(sim, rec.id)) if (!stillHeld.has(r.id)) ghost(r, false);
  }
}

/** Turn a held body to an angle about z (2D) or about `axis`, pivoting on the grabbed point. */
export function turn(sim, hand, angle, axis = [0, 0, 1]) {
  if (!hand) return { ok: false, msg: 'nothing in that hand' };
  const rec = sim.bodies.get(hand.id);
  if (!rec) return { ok: false, msg: 'that body is gone' };
  const a = num(angle, 0, -1e3, 1e3);
  const ax = v3(+axis[0] || 0, +axis[1] || 0, +axis[2] || 0);
  const l = Math.hypot(ax.x, ax.y, ax.z) || 1;
  const s = Math.sin(a / 2) / l;
  const q = { x: ax.x * s, y: ax.y * s, z: ax.z * s, w: Math.cos(a / 2) };
  const pivot = toWorld(rec.body, hand.local);
  const off = rotate(q, hand.local);
  rec.body.setRotation(q, true);
  rec.body.setTranslation(v3(pivot.x - off.x, pivot.y - off.y, pivot.z - off.z), true);
  rec.body.setAngvel(v3(), true);
  return { ok: true };
}
