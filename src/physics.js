/* Marshmallow Challenge physics on Rapier. Runs inside the room's Durable Object (and in Node for tests).
   Units: cm, grams, seconds. Sticks are thin boxes; tape = glue balls, joined to pieces by stiff point springs
   (soft enough to measure the load, so overloaded tape tears). A hand is a kinematic finger with a stiff spring to the grabbed point. */
export const PH = {
  STICK_LEN: 25, STICK_R: 0.3, STICK_MASS: 1.2, MARSH: 4.2, MARSH_MASS: 7,
  TAPE_COST: 5, TAPE_TOTAL: 100, STICKS: 20, SNAP: 0.8, GLUE_R: 1.3, GLUE_MASS: 1.5,
  STICK_HR: 0.15, TABLE: { w: 110, d: 80 }, DT: 1 / 120, GRAV: -981,
  PIN_K: 4e4, PIN_D: 300, BREAK: 3,          // tape pin: spring stiffness / damping, and the stretch at which it tears
  ROT_K: 1e4, ROT_D: 80, ROT_YIELD: 0.5,     // tape bend resistance: a soft pin 5 cm along the stick that re-sets once it yields
  HAND_K: 2e4, HAND_D: 250, HAND_SPEED: 160, HAND_TRACK: 22, RIP: 9, YAW_DAMP: 0.5,   // hand: kinematic finger, stiff spring to the grabbed point
};
const GROUP = { TABLE: 1, PIECE: 2, GLUE: 4 };
const groups = (member, filter) => (member << 16) | filter;
/* ---- tiny vector / quaternion helpers (plain objects, what Rapier takes and returns) ---- */
const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
const add = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const scale = (a, s) => v3(a.x * s, a.y * s, a.z * s);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a) => Math.hypot(a.x, a.y, a.z);
const dist = (a, b) => len(sub(a, b));
function rotate(q, v) {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y, iy = q.w * v.y + q.z * v.x - q.x * v.z, iz = q.w * v.z + q.x * v.y - q.y * v.x, iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return v3(ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y, iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z, iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x);
}
const conj = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
const toWorld = (body, local) => add(body.translation(), rotate(body.rotation(), local));
const toLocal = (body, world) => rotate(conj(body.rotation()), sub(world, body.translation()));
export const quatFromEulerY = (a) => ({ x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) });

export function createSim(R) {
  const world = new R.World(v3(0, PH.GRAV, 0));
  world.timestep = PH.DT;
  world.numSolverIterations = 8;
  world.createCollider(R.ColliderDesc.cuboid(PH.TABLE.w / 2 + 5, 2, PH.TABLE.d / 2 + 5).setTranslation(0, -2, 0).setFriction(0.6).setRestitution(0).setCollisionGroups(groups(GROUP.TABLE, GROUP.PIECE | GROUP.GLUE)));
  return { R, world, bodies: new Map(), hands: new Map(), events: [], nextId: 1, tape: PH.TAPE_TOTAL, bag: PH.STICKS, marshInBag: true, seq: 0 };
}
/* ---- bookkeeping ---- */
const idn = (sim) => 's' + (sim.nextId++);
const linked = (anchor, id) => anchor.links.some(l => l.id === id);
const reach = (a) => (a.kind === 'glue' ? PH.GLUE_R : PH.MARSH / 2);
export function wakeAll(sim) { for (const r of sim.bodies.values()) r.body.wakeUp(); }
export function isHeld(sim, id) { for (const h of sim.hands.values()) if (h.stick === id) return true; return false; }
function anchored(sim, id) { for (const b of sim.bodies.values()) if (b.links && linked(b, id)) return true; return false; }
/* everything welded to a body, transitively */
function weldedWith(sim, id) {
  const seen = new Set([id]); const q = [id];
  while (q.length) {
    const c = q.pop(); const rec = sim.bodies.get(c); if (!rec) continue;
    const nb = [...(rec.links ? rec.links.map(l => l.id) : []), ...[...sim.bodies.values()].filter(b => b.links && linked(b, c)).map(b => b.id)];
    for (const o of nb) if (!seen.has(o)) { seen.add(o); q.push(o); }
  }
  seen.delete(id); return [...seen].map(i => sim.bodies.get(i)).filter(Boolean);
}
function setMask(rec, filter) { rec.collider.setCollisionGroups(groups(rec.kind === 'glue' ? GROUP.GLUE : GROUP.PIECE, filter)); }
/* world-space endpoints of a stick */
export function ends(rec) { const h = rec.len / 2; return [toWorld(rec.body, v3(-h, 0, 0)), toWorld(rec.body, v3(h, 0, 0))]; }
function closestOnSeg(a, b, p) { const ab = sub(b, a); const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / Math.max(1e-6, dot(ab, ab)))); return add(a, scale(ab, t)); }
/* ---- pins: a point spring between two bodies at a world point ---- */
function pin(sim, A, B, worldPt, k, d) {
  const la = toLocal(A.body, worldPt), lb = toLocal(B.body, worldPt);
  const j = sim.world.createImpulseJoint(sim.R.JointData.spring(0, k, d, la, lb), A.body, B.body, true);
  j.setContactsEnabled(false);
  return { j, la, lb, a: A.id, b: B.id };
}
function gap(sim, c) { const A = sim.bodies.get(c.a), B = sim.bodies.get(c.b); if (!A || !B) return 0; return dist(toWorld(A.body, c.la), toWorld(B.body, c.lb)); }
function dropJoint(sim, c) { try { sim.world.removeImpulseJoint(c.j, true); } catch (e) {} }
/* ---- pieces ---- */
function addStick(sim, length, pos, quat) {
  const R = sim.R;
  const m = PH.STICK_MASS * length / PH.STICK_LEN;
  // thin rods have a near-zero inertia about their own axis, which makes joints mushy; fatten it (spaghetti does not spin freely in tape anyway)
  const Iy = m * (length * length + PH.STICK_HR * PH.STICK_HR * 4) / 12, Ix = Math.max(m * PH.STICK_HR * PH.STICK_HR * 8 / 12, Iy * 0.25);
  const body = sim.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z).setRotation(quat || { x: 0, y: 0, z: 0, w: 1 })
    .setAdditionalMassProperties(m, v3(), v3(Ix, Iy, Iy), { x: 0, y: 0, z: 0, w: 1 }).setLinearDamping(0.55).setAngularDamping(1.0).setCanSleep(true));
  const collider = sim.world.createCollider(R.ColliderDesc.cuboid(length / 2, PH.STICK_HR, PH.STICK_HR).setMass(0).setFriction(0.6).setRestitution(0).setCollisionGroups(groups(GROUP.PIECE, GROUP.TABLE | GROUP.PIECE)), body);
  const id = idn(sim); const rec = { id, kind: 'stick', len: length, body, collider }; sim.bodies.set(id, rec); sim.seq++;
  return rec;
}
export function spawnStick(sim, length = PH.STICK_LEN) {
  const cost = length / PH.STICK_LEN; // a half stick takes half a stick from the bag
  if (sim.bag < cost - 1e-6) return { ok: false, msg: sim.bag > 0 ? 'Only half a stick left — take a half.' : 'No sticks left in the bag.' };
  sim.bag = Math.round((sim.bag - cost) * 100) / 100;
  const n = sim.bodies.size; const x = ((n * 7) % 41) - 20, z = 14 + (n % 3) * 5;
  const b = addStick(sim, length, v3(x, PH.STICK_R + 0.2 + n * 0.02, z), quatFromEulerY(Math.PI / 2));
  return { ok: true, id: b.id };
}
export function spawnMarsh(sim) {
  if (!sim.marshInBag) return { ok: false, msg: 'The marshmallow is already out.' };
  sim.marshInBag = false; const R = sim.R;
  const body = sim.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(28, PH.MARSH / 2 + 0.2, 24).setLinearDamping(0.45).setAngularDamping(1.0));
  const collider = sim.world.createCollider(R.ColliderDesc.cuboid(PH.MARSH / 2, PH.MARSH / 2, PH.MARSH / 2).setMass(PH.MARSH_MASS).setFriction(0.8).setRestitution(0).setCollisionGroups(groups(GROUP.PIECE, GROUP.TABLE | GROUP.PIECE)), body);
  const id = 'marsh'; const rec = { id, kind: 'marsh', len: PH.MARSH, body, collider, links: [] }; sim.bodies.set(id, rec); sim.seq++;
  return { ok: true, id };
}
export function spawnGlue(sim) {
  if (sim.tape < PH.TAPE_COST) return { ok: false, msg: 'No tape left.' };
  sim.tape -= PH.TAPE_COST; const R = sim.R;
  const n = sim.bodies.size;
  const body = sim.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(-22 + (n % 5) * 3, PH.GLUE_R + 0.2, 28).setLinearDamping(1.5).setAngularDamping(9));
  const collider = sim.world.createCollider(R.ColliderDesc.ball(PH.GLUE_R).setMass(PH.GLUE_MASS).setFriction(0.9).setRestitution(0).setCollisionGroups(groups(GROUP.GLUE, GROUP.TABLE)), body);
  const id = idn(sim); const rec = { id, kind: 'glue', len: PH.GLUE_R, body, collider, links: [] }; sim.bodies.set(id, rec); sim.seq++;
  return { ok: true, id };
}
export function removeBody(sim, id, toBag = true) {
  const rec = sim.bodies.get(id); if (!rec) return { ok: false, msg: 'Nothing there.' };
  if (rec.kind === 'glue') return untape(sim, id);
  for (const [pid, h] of sim.hands) if (h.stick === id) release(sim, pid, false);
  if (rec.links) clearLinks(sim, rec); unlink(sim, id);
  sim.world.removeRigidBody(rec.body); sim.bodies.delete(id); wakeAll(sim);
  if (rec.kind === 'marsh') sim.marshInBag = true; else if (toBag) sim.bag = Math.round((sim.bag + rec.len / PH.STICK_LEN) * 100) / 100;
  sim.seq++; return { ok: true };
}
export function breakStick(sim, id) {
  const rec = sim.bodies.get(id); if (!rec || rec.kind !== 'stick') return { ok: false, msg: 'Tap a stick to snap it.' };
  if (rec.len < 10) return { ok: false, msg: 'Too short to snap again.' };
  const q = rec.body.rotation(), half = rec.len / 4;
  const c1 = toWorld(rec.body, v3(-half, 0, 0)), c2 = toWorld(rec.body, v3(half, 0, 0));
  removeBody(sim, id, false);
  addStick(sim, rec.len / 2, c1, q); addStick(sim, rec.len / 2, c2, q); wakeAll(sim);
  return { ok: true };
}
/* ---- hands: a kinematic finger body tracks the touch; a stiff spring ties it to the grabbed point ---- */
export function grab(sim, pid, id, local) {
  const rec = sim.bodies.get(id); if (!rec) return { ok: false };
  release(sim, pid, false);
  const lp = v3(local[0], local[1], local[2]); const world = toWorld(rec.body, lp);
  const finger = sim.world.createRigidBody(sim.R.RigidBodyDesc.kinematicPositionBased().setTranslation(world.x, world.y, world.z));
  const j = sim.world.createImpulseJoint(sim.R.JointData.spring(0, PH.HAND_K, PH.HAND_D, v3(), lp), finger, rec.body, true);
  rec.body.wakeUp(); rec.body.setLinearDamping(9); rec.body.setAngularDamping(rec.kind === 'stick' ? 5 : 9);
  // carried pieces pass through other pieces; welded partners follow the same rule. Fingers pinch tape / the marshmallow firmly (keeps orientation); a stick pivots in the fingers
  if (rec.kind !== 'glue') setMask(rec, GROUP.TABLE);
  for (const o of weldedWith(sim, rec.id)) if (o.kind !== 'glue') setMask(o, GROUP.TABLE);
  if (rec.kind !== 'stick') rec.body.lockRotations(true, true);
  sim.hands.set(pid, { stick: id, local: lp, finger, j, target: world, ripT: 0 });
  return { ok: true };
}
export function move(sim, pid, p) {
  const h = sim.hands.get(pid); if (!h) return;
  const cl = (v, m) => Math.max(-m, Math.min(m, v));
  h.target = v3(cl(p[0], PH.TABLE.w / 2 - 2), Math.max(PH.STICK_R + 0.2, Math.min(90, p[1])), cl(p[2], PH.TABLE.d / 2 - 2));
  const r = sim.bodies.get(h.stick); if (r) r.body.wakeUp();
}
export function release(sim, pid, tryTape = true) {
  const h = sim.hands.get(pid); if (!h) return { ok: true };
  sim.hands.delete(pid);
  try { sim.world.removeImpulseJoint(h.j, true); } catch (e) {} try { sim.world.removeRigidBody(h.finger); } catch (e) {}
  const rec = sim.bodies.get(h.stick); let taped = 0;
  wakeAll(sim);
  if (rec) {
    for (const o of [rec, ...weldedWith(sim, rec.id)]) if (o.kind !== 'glue') setMask(o, GROUP.TABLE | GROUP.PIECE);
    if (rec.kind !== 'stick') rec.body.lockRotations(false, true);
    rec.body.setLinearDamping(rec.kind === 'glue' ? 1.5 : 0.5); rec.body.setAngularDamping(rec.kind === 'glue' ? 9 : 1.0);
    rec.body.setLinvel(scale(rec.body.linvel(), 0.2), true); rec.body.setAngvel(scale(rec.body.angvel(), 0.2), true);
    resetRot(sim, new Set([rec.id, ...weldedWith(sim, rec.id).map(o => o.id)]));
    if (tryTape) taped = autoTape(sim, rec);
  }
  return { ok: true, taped };
}
/* ---- tape: anchors (glue balls, the marshmallow) grab sticks they touch; a stick end touching an anchor gets grabbed by it ---- */
export function tapeTargets(sim, rec) {
  const out = [];
  if (rec.links) {
    const c = rec.body.translation();
    for (const o of sim.bodies.values()) {
      if (o === rec || linked(rec, o.id) || (o.links && linked(o, rec.id))) continue;
      let q, d;
      if (o.kind === 'stick') { const [a, b] = ends(o); q = closestOnSeg(a, b, c); d = dist(q, c) - PH.STICK_R - reach(rec); if (rec.kind === 'marsh' && Math.min(dist(a, c), dist(b, c)) > PH.MARSH / 2 + PH.SNAP) continue; }
      else if (o.links) { const op = o.body.translation(); const dir = sub(c, op); const L = len(dir) || 1; q = add(op, scale(dir, Math.min(L, reach(o)) / L)); d = L - reach(o) - reach(rec); }
      else continue;
      if (d < PH.SNAP) out.push({ o, d, q });
    }
    return out;
  }
  for (const p of ends(rec)) {
    let best = null;
    for (const o of sim.bodies.values()) {
      if (!o.links || linked(o, rec.id)) continue;
      const d = dist(o.body.translation(), p) - reach(o) - PH.STICK_R;
      if (d < PH.SNAP && (!best || d < best.d)) best = { o, d, q: p };
    }
    if (best) out.push(best);
  }
  return out;
}
function autoTape(sim, rec) {
  let n = 0;
  for (const t of tapeTargets(sim, rec)) { if (rec.links) attach(sim, rec, t.o, t.q, rec); else attach(sim, t.o, rec, t.q, rec); n++; }
  return n;
}
/* pin a piece to an anchor at a world point: pieces keep their current pose */
export function attach(sim, ball, piece, worldPt, mover) {
  ball.body.wakeUp(); piece.body.wakeUp();
  // bury the contact: the moving piece is shifted so the stick end / ball actually sits inside the tape
  if (mover === ball && piece.kind === 'stick') { const bp = ball.body.translation(); const d = sub(bp, worldPt); const L = len(d) || 1; ball.body.setTranslation(add(worldPt, scale(d, Math.max(0.3, reach(ball) - 0.6) / L)), true); }
  else if (mover === piece && piece.kind === 'stick') { const bp = ball.body.translation(); const d = sub(worldPt, bp); const L = len(d) || 1; const target = add(bp, scale(d, Math.max(0, reach(ball) - 0.7) / L)); piece.body.setTranslation(add(piece.body.translation(), sub(target, worldPt)), true); worldPt = target; }
  if (mover) { mover.body.setLinvel(v3(), true); mover.body.setAngvel(v3(), true); }
  // sticks get one pin (they pivot on the tape); anchor to anchor is rigid: three pins
  const pts = [worldPt];
  if (piece.links) pts.push(add(worldPt, v3(2, 0, 0)), add(worldPt, v3(0, 0, 2)));
  const cs = pts.map(w => pin(sim, ball, piece, w, PH.PIN_K, PH.PIN_D));
  const link = { id: piece.id, cs, rot: null };
  if (piece.kind === 'stick') setRot(sim, ball, link);
  ball.links.push(link); sim.seq++;
}
/* tape resists bending a little: a soft pin 5 cm along the stick from the joint. It yields when pushed and is re-set at the new angle, like tape taking a set */
function setRot(sim, ball, link) {
  const piece = sim.bodies.get(link.id); if (!piece) return;
  if (link.rot) dropJoint(sim, link.rot);
  const jw = toWorld(piece.body, link.cs[0].lb); const axis = rotate(piece.body.rotation(), v3(1, 0, 0));
  const sgn = dot(sub(piece.body.translation(), jw), axis) >= 0 ? 1 : -1;
  link.rot = pin(sim, ball, piece, add(jw, scale(axis, 5 * sgn)), PH.ROT_K, PH.ROT_D);
}
function resetRot(sim, ids) { for (const b of sim.bodies.values()) if (b.links) for (const l of b.links) if (l.rot && (ids.has(b.id) || ids.has(l.id))) setRot(sim, b, l); }
function dropLink(sim, anchor, l) { l.cs.forEach(c => dropJoint(sim, c)); if (l.rot) dropJoint(sim, l.rot); anchor.links = anchor.links.filter(x => x !== l); }
/* peel a glue ball off: its joints go, the tape is spent */
export function untape(sim, id) {
  const ball = sim.bodies.get(id); if (!ball || ball.kind !== 'glue') return { ok: false, msg: 'Tap a glue ball to peel it off.' };
  clearLinks(sim, ball); unlink(sim, id); sim.world.removeRigidBody(ball.body); sim.bodies.delete(id); wakeAll(sim); sim.seq++; return { ok: true };
}
function clearLinks(sim, anchor) { for (const l of [...anchor.links]) dropLink(sim, anchor, l); }
function unlink(sim, pieceId) { for (const b of sim.bodies.values()) if (b.links) for (const l of [...b.links]) if (l.id === pieceId) dropLink(sim, b, l); }
/* tear the most-stretched glue link touching this piece */
function ripOne(sim, r) {
  let best = null;
  const cand = (anchor, l) => { const g = gap(sim, l.cs[0]); if (!best || g > best.g) best = { anchor, l, g }; };
  if (r.links) for (const l of r.links) cand(r, l);
  for (const b of sim.bodies.values()) if (b.links) for (const l of b.links) if (l.id === r.id) cand(b, l);
  if (!best) return false;
  dropLink(sim, best.anchor, best.l); sim.events.push('tore'); wakeAll(sim); sim.seq++; return true;
}
/* ---- stepping: one call per 1/60 s tick ---- */
export function step(sim, dt = 1 / 60) {
  for (const r of sim.bodies.values()) r.body.resetTorques(false);
  if (sim.hands.size) wakeAll(sim);
  for (const h of sim.hands.values()) {
    const r = sim.bodies.get(h.stick); if (!r) continue;
    if (r.kind === 'stick') { const av = r.body.angvel(); av.y *= PH.YAW_DAMP; r.body.setAngvel(av, true); } // no swivel when pushing along the stick
  }
  // a loose stick balanced on its tip is not a thing: nudge it over
  for (const r of sim.bodies.values()) if (r.kind === 'stick' && !isHeld(sim, r.id) && !anchored(sim, r.id)) {
    const [a, c] = ends(r); const lo = a.y < c.y ? a : c, hi = a.y < c.y ? c : a;
    if (lo.y < PH.STICK_HR + 0.6 && hi.y - lo.y > r.len * 0.3) { if (!r.nudge) { const t = Math.random() * Math.PI * 2; r.nudge = v3(Math.cos(t), 0, Math.sin(t)); } r.body.wakeUp(); r.body.addTorque(scale(r.nudge, 2500), true); }
    else r.nudge = null;
  }
  const n = Math.max(1, Math.min(4, Math.round(dt / PH.DT))); const sdt = dt / n;
  for (let i = 0; i < n; i++) {
    // the finger chases the touch: spring-ish tracking, speed-capped
    for (const h of sim.hands.values()) {
      const p = h.finger.translation(); let d = scale(sub(h.target, p), Math.min(1, PH.HAND_TRACK * sdt));
      const L = len(d), cap = PH.HAND_SPEED * sdt; if (L > cap) d = scale(d, cap / L);
      h.finger.setNextKinematicTranslation(add(p, d));
    }
    sim.world.step();
  }
  // pull a glued piece hard enough (drag it well past where it can go) and the glue gives
  for (const h of sim.hands.values()) {
    const r = sim.bodies.get(h.stick); if (!r) continue;
    const lag = dist(h.finger.translation(), toWorld(r.body, h.local));
    h.ripT = lag > PH.RIP ? h.ripT + dt : 0;
    if (h.ripT > 0.35) { h.ripT = 0; ripOne(sim, r); }
  }
  for (const b of sim.bodies.values()) if (b.links) for (const l of [...b.links]) {
    if (gap(sim, l.cs[0]) > PH.BREAK) { dropLink(sim, b, l); sim.events.push('tore'); wakeAll(sim); sim.seq++; continue; } // tape pulled apart harder than it can hold
    if (l.rot && gap(sim, l.rot) > PH.ROT_YIELD) setRot(sim, b, l);                                                    // bent past what tape resists: it takes the new set
  }
  // anything that fell off the table comes back on its own (tape on it is lost)
  for (const r of [...sim.bodies.values()]) {
    if (r.body.translation().y < -25) {
      if (r.kind === 'glue') { untape(sim, r.id); continue; } if (r.links) clearLinks(sim, r); unlink(sim, r.id);
      for (const [pid, h] of sim.hands) if (h.stick === r.id) release(sim, pid, false);
      r.body.setTranslation(v3(((sim.nextId * 7) % 41) - 20, 2, 18), true); r.body.setLinvel(v3(), true); r.body.setAngvel(v3(), true); r.body.setRotation(quatFromEulerY(Math.PI / 2), true); sim.seq++;
    }
  }
}
export function snapshot(sim) {
  const out = [];
  for (const r of sim.bodies.values()) { const p = r.body.translation(), q = r.body.rotation(); out.push([r.id, r.kind === 'marsh' ? 'm' : r.kind === 'glue' ? 'g' : 's', r.len, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), +q.x.toFixed(4), +q.y.toFixed(4), +q.z.toFixed(4), +q.w.toFixed(4), r.body.isSleeping() ? 1 : 0]); }
  const hands = [...sim.hands.entries()].map(([pid, h]) => { const r = sim.bodies.get(h.stick); const gp = h.finger.translation(); const c = r ? tapeTargets(sim, r).map(t => [+t.q.x.toFixed(1), +t.q.y.toFixed(1), +t.q.z.toFixed(1)]) : []; return [pid, h.stick, +gp.x.toFixed(1), +gp.y.toFixed(1), +gp.z.toFixed(1), c]; });
  // live height: highest point of the build; once the marshmallow is skewered on, its top
  let top = 0; for (const r of sim.bodies.values()) { if (r.kind === 'stick') for (const e of ends(r)) top = Math.max(top, e.y + PH.STICK_R); else if (r.kind === 'glue') top = Math.max(top, r.body.translation().y + PH.GLUE_R); }
  const m = sim.bodies.get('marsh'); const onMarsh = !!(m && m.links.length);
  const height = onMarsh ? m.body.translation().y + PH.MARSH / 2 : top;
  return { b: out, h: hands, top: +height.toFixed(1), onMarsh };
}
/* height of the marshmallow top if it rests on sticks (not the table), nobody is holding anything */
export function measure(sim) {
  const m = sim.bodies.get('marsh'); if (!m) return { ok: false, note: 'No marshmallow on top' };
  if (sim.hands.size) return { ok: false, note: 'Hands are still on it' };
  const top = m.body.translation().y + PH.MARSH / 2;
  if (m.body.translation().y < PH.MARSH / 2 + 1.5) return { ok: false, note: 'The marshmallow is on the table' };
  let maxStick = 0; for (const r of sim.bodies.values()) if (r.kind === 'stick') for (const e of ends(r)) maxStick = Math.max(maxStick, e.y);
  if (maxStick > top + 1) return { ok: false, note: 'The marshmallow must be on the very top', height: top };
  return { ok: true, height: top, note: 'Standing with the marshmallow on top' };
}
export function isBusy(sim) { if (sim.hands.size) return true; for (const r of sim.bodies.values()) if (!r.body.isSleeping()) return true; return false; }
