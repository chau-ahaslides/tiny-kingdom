import { test } from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { PH, createSim, spawnStick, spawnMarsh, grab, move, release, step, snapshot, measure, ends, attach, removeBody, tapeTargets } from '../src/physics.js';

await RAPIER.init();
const run = (sim, secs) => { for (let i = 0; i < secs * 60; i++) step(sim, 1 / 60); };
const rec = (sim, id) => sim.bodies.get(id);
/* carry a piece by a local point to a world target, giving the hand time to get there */
function carry(sim, pid, id, local, to, secs = 1.5) {
  grab(sim, pid, id, local); move(sim, pid, to);
  for (let i = 0; i < secs * 60; i++) { move(sim, pid, to); step(sim, 1 / 60); }
  return release(sim, pid, true);
}
/* hold a piece up in the air by its middle and keep it there */
function holdUp(sim, pid, id, at, secs = 1.5) {
  grab(sim, pid, id, [0, 0, 0]); move(sim, pid, at);
  for (let i = 0; i < secs * 60; i++) { move(sim, pid, at); step(sim, 1 / 60); }
}
const joints = (sim) => [...sim.bodies.values()].reduce((n, b) => n + b.links.length, 0);

test('sticks fall onto the table and sleep', () => {
  const sim = createSim(RAPIER);
  const a = spawnStick(sim); const b = spawnStick(sim, PH.STICK_LEN / 2);
  assert.equal(sim.bag, 18.5);
  run(sim, 2);
  const sn = snapshot(sim);
  for (const row of sn.b) { assert.ok(Math.abs(row[4] - PH.STICK_HR) < 0.2, 'rests on the table: y=' + row[4]); assert.equal(row[10], 1, 'asleep'); }
  assert.equal(sn.top < 1, true);
});

test('a hand drags a stick where the finger goes, and it stays there', () => {
  const sim = createSim(RAPIER);
  const { id } = spawnStick(sim); run(sim, 0.5);
  const r = carry(sim, 'p1:1', id, [0, 0, 0], [10, 20, -5]);
  const p = rec(sim, id).body.translation();
  assert.ok(Math.abs(p.x - 10) < 1.5 && Math.abs(p.z + 5) < 1.5, 'followed the finger: ' + JSON.stringify(p));
  assert.ok(p.y > 15, 'held up in the air while carried: ' + p.y);
  run(sim, 2);
  assert.ok(rec(sim, id).body.translation().y < 1, 'falls back when let go');
  assert.equal(r.taped, 0);
});

test('a stick end let go against another stick glues itself there, and hangs from it', () => {
  const sim = createSim(RAPIER);
  const a = spawnStick(sim); const b = spawnStick(sim); run(sim, 0.5);
  // one stick is held up in the air, level, by its middle
  holdUp(sim, 'a:1', a.id, [0, 30, 0]);
  const ap = rec(sim, a.id).body.translation();
  assert.ok(ap.y > 25, 'held up: ' + ap.y);
  // while it is still held, the other stick shows no target until its end comes close
  grab(sim, 'b:1', b.id, [PH.STICK_LEN / 2, 0, 0]);
  assert.equal(tapeTargets(sim, rec(sim, b.id)).length, 0, 'nothing near yet');
  release(sim, 'b:1', false);
  // bring the second stick's end (local +12.5) to the held stick, 1 cm below its middle
  const res = carry(sim, 'b:1', b.id, [PH.STICK_LEN / 2, 0, 0], [ap.x, ap.y - 1, ap.z], 2);
  assert.equal(res.taped, 1, 'stuck to the other stick');
  assert.equal(rec(sim, a.id).links.length, 1, 'the joint lives on the stick it was pressed onto');
  assert.equal(rec(sim, a.id).links[0].id, b.id);
  run(sim, 2);
  const [e1, e2] = ends(rec(sim, b.id)); const hi = Math.max(e1.y, e2.y), lo = Math.min(e1.y, e2.y);
  assert.ok(hi > 22, 'glued end still up at the held stick: ' + hi);
  assert.ok(lo < 14, 'the free end swung down: ' + lo);
  release(sim, 'a:1', false); run(sim, 3);
  assert.equal(joints(sim), 1, 'still glued after the drop');
});

test('a joint tears when yanked apart', () => {
  const sim = createSim(RAPIER);
  const a = spawnStick(sim); const b = spawnStick(sim); run(sim, 0.3);
  const [, e] = ends(rec(sim, b.id));
  attach(sim, rec(sim, a.id), rec(sim, b.id), { x: e.x, y: e.y, z: e.z }, null);
  run(sim, 0.5);
  assert.equal(rec(sim, a.id).links.length, 1);
  // one stick is wedged (fixed); drag the other far past where its joint lets it go
  rec(sim, a.id).body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
  grab(sim, 'a:1', b.id, [0, 0, 0]);
  for (let i = 0; i < 120; i++) { move(sim, 'a:1', [-40, 40, -30]); step(sim, 1 / 60); }
  assert.equal(rec(sim, a.id).links.length, 0, 'the joint gave');
  assert.ok(sim.events.includes('tore'));
});

test('a tripod with the marshmallow on top stands and measures', () => {
  const sim = createSim(RAPIER);
  const m = spawnMarsh(sim);
  const legs = [spawnStick(sim), spawnStick(sim), spawnStick(sim)].map(x => rec(sim, x.id));
  run(sim, 0.3);
  const M = rec(sim, m.id); M.body.setTranslation({ x: 0, y: 22, z: 0 }, true); M.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  // legs leaning in from three sides, top ends at the marshmallow, bottoms on the table
  const top = { x: 0, y: 19.5, z: 0 };
  legs.forEach((L, i) => {
    const a = i * 2 * Math.PI / 3; const foot = { x: Math.cos(a) * 15, y: PH.STICK_R, z: Math.sin(a) * 15 };
    const dir = { x: top.x - foot.x, y: top.y - foot.y, z: top.z - foot.z }; const l = Math.hypot(dir.x, dir.y, dir.z); const d = { x: dir.x / l, y: dir.y / l, z: dir.z / l };
    // rotation taking +x to d
    const axis = { x: 0, y: -d.z, z: d.y }; const al = Math.hypot(axis.y, axis.z) || 1; const ang = Math.acos(Math.max(-1, Math.min(1, d.x)));
    const q = { x: 0, y: axis.y / al * Math.sin(ang / 2), z: axis.z / al * Math.sin(ang / 2), w: Math.cos(ang / 2) };
    L.body.setTranslation({ x: (foot.x + top.x) / 2, y: (foot.y + top.y) / 2, z: (foot.z + top.z) / 2 }, true); L.body.setRotation(q, true); L.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    const [e1, e2] = ends(L); const tip = e1.y > e2.y ? e1 : e2;
    attach(sim, M, L, tip, null);
  });
  run(sim, 4);
  const r = measure(sim);
  assert.ok(r.ok, 'stands: ' + r.note);
  assert.ok(r.height > 15 && r.height < 25, 'height ' + r.height);
  assert.equal(M.links.length, 3, 'all three legs still glued');
});

test('a stick end let go on the marshmallow glues to it; the marshmallow keeps its joints', () => {
  const sim = createSim(RAPIER);
  const m = spawnMarsh(sim); const s = spawnStick(sim); run(sim, 0.5);
  holdUp(sim, 'a:1', m.id, [0, 30, 0]);
  const mp = rec(sim, m.id).body.translation();
  const res = carry(sim, 'b:1', s.id, [PH.STICK_LEN / 2, 0, 0], [mp.x, mp.y - PH.MARSH / 2 - 0.2, mp.z], 2);
  assert.equal(res.taped, 1, 'stuck to the marshmallow');
  assert.equal(rec(sim, m.id).links.length, 1); assert.equal(rec(sim, s.id).links.length, 0);
  assert.equal(snapshot(sim).onMarsh, true);
});

test('remove puts a stick back in the bag and drops its joints', () => {
  const sim = createSim(RAPIER);
  const a = spawnStick(sim); const b = spawnStick(sim); run(sim, 0.3);
  const [, e] = ends(rec(sim, b.id)); attach(sim, rec(sim, a.id), rec(sim, b.id), e, null);
  assert.equal(sim.bag, 18);
  assert.equal(removeBody(sim, b.id).ok, true);
  assert.equal(sim.bag, 19); assert.equal(rec(sim, a.id).links.length, 0);
  run(sim, 1);
});

test('step cost stays small with a full kit on the table', () => {
  const sim = createSim(RAPIER);
  for (let i = 0; i < 20; i++) spawnStick(sim); spawnMarsh(sim);
  grab(sim, 'a:1', 's1', [0, 0, 0]);
  const t0 = performance.now(); for (let i = 0; i < 600; i++) { move(sim, 'a:1', [Math.sin(i / 20) * 20, 20, 0]); step(sim, 1 / 60); } const ms = (performance.now() - t0) / 600;
  console.log(`      ${ms.toFixed(3)} ms per 60 Hz tick, ${sim.bodies.size} bodies`);
  assert.ok(ms < 3, 'tick under 3 ms');
});

test('new pieces land where the phone asks, and step aside when the spot is taken', () => {
  const sim = createSim(RAPIER);
  const a = spawnStick(sim, PH.STICK_LEN, [10, -5], 0.7);
  const pa = rec(sim, a.id).body.translation();
  assert.ok(Math.abs(pa.x - 10) < 0.01 && Math.abs(pa.z + 5) < 0.01, 'first stick at the asked spot: ' + JSON.stringify(pa));
  const [e1, e2] = ends(rec(sim, a.id)); const dir = { x: e2.x - e1.x, z: e2.z - e1.z };
  assert.ok(Math.abs(Math.atan2(-dir.z, dir.x) - 0.7) < 0.01, 'lies at the asked yaw');
  const b = spawnStick(sim, PH.STICK_LEN, [10, -5], 0.7);
  const pb = rec(sim, b.id).body.translation();
  assert.ok(Math.hypot(pb.x - 10, pb.z + 5) >= 3.9, 'second stick moved aside: ' + JSON.stringify(pb));
  const m = spawnMarsh(sim, [200, 200]);
  const pm = rec(sim, m.id).body.translation();
  assert.ok(Math.abs(pm.x) <= PH.TABLE.w / 2 - 4 && Math.abs(pm.z) <= PH.TABLE.d / 2 - 4, 'clamped onto the table: ' + JSON.stringify(pm));
  run(sim, 1);
  assert.ok(sim.bodies.size === 3);
  assert.equal(joints(sim), 0, 'pieces that were only put down next to each other are not glued');
});

test('the snapshot carries a glue blob for every joint, where the joint is', () => {
  const sim = createSim(RAPIER);
  const a = spawnStick(sim); const b = spawnStick(sim); run(sim, 0.3);
  assert.deepEqual(snapshot(sim).j, []);
  const [, e] = ends(rec(sim, b.id)); attach(sim, rec(sim, a.id), rec(sim, b.id), e, null);
  const j = snapshot(sim).j;
  assert.equal(j.length, 1);
  assert.ok(Math.hypot(j[0][0] - e.x, j[0][1] - e.y, j[0][2] - e.z) < 0.2, 'blob sits on the joint: ' + JSON.stringify(j[0]));
});
