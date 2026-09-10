import { test } from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { PH, createSim, spawnStick, spawnGlue, spawnMarsh, grab, move, release, step, snapshot, measure, ends, attach, removeBody } from '../src/physics.js';

await RAPIER.init();
const run = (sim, secs) => { for (let i = 0; i < secs * 60; i++) step(sim, 1 / 60); };
const rec = (sim, id) => sim.bodies.get(id);
/* carry a piece by a local point to a world target, giving the hand time to get there */
function carry(sim, pid, id, local, to, secs = 1.5) {
  grab(sim, pid, id, local); move(sim, pid, to);
  for (let i = 0; i < secs * 60; i++) { move(sim, pid, to); step(sim, 1 / 60); }
  return release(sim, pid, true);
}

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

test('a stick end pressed into a glue ball sticks, and hangs from it', () => {
  const sim = createSim(RAPIER);
  const g = spawnGlue(sim); const s = spawnStick(sim); run(sim, 0.5);
  // lift the glue ball up into the air, hold it there with one hand
  grab(sim, 'a:1', g.id, [0, 0, 0]); move(sim, 'a:1', [0, 30, 0]);
  for (let i = 0; i < 90; i++) { move(sim, 'a:1', [0, 30, 0]); step(sim, 1 / 60); }
  const gp = rec(sim, g.id).body.translation();
  assert.ok(gp.y > 25, 'glue held up: ' + gp.y);
  // bring the stick's end (local +12.5) to the ball
  const res = carry(sim, 'b:1', s.id, [PH.STICK_LEN / 2, 0, 0], [gp.x, gp.y - 0.5, gp.z], 2);
  assert.equal(res.taped, 1, 'stuck to the ball');
  assert.equal(rec(sim, g.id).links.length, 1);
  run(sim, 2);
  const [e1, e2] = ends(rec(sim, s.id)); const hi = Math.max(e1.y, e2.y), lo = Math.min(e1.y, e2.y);
  assert.ok(hi > 20, 'top end still up at the ball: ' + hi);
  assert.ok(lo < 12, 'the free end swung down: ' + lo);
  release(sim, 'a:1', false); run(sim, 3);
  assert.equal(rec(sim, g.id).links.length, 1, 'still glued after the drop');
});

test('tape tears when pulled apart hard', () => {
  const sim = createSim(RAPIER);
  const g = spawnGlue(sim); const s = spawnStick(sim); run(sim, 0.3);
  const [, e] = ends(rec(sim, s.id));
  attach(sim, rec(sim, g.id), rec(sim, s.id), { x: e.x, y: e.y, z: e.z }, null);
  run(sim, 0.5);
  assert.equal(rec(sim, g.id).links.length, 1);
  // the stick is wedged (fixed); yank the glue ball away from it, far and fast
  rec(sim, s.id).body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
  grab(sim, 'a:1', g.id, [0, 0, 0]);
  for (let i = 0; i < 120; i++) { move(sim, 'a:1', [-40, 40, -30]); step(sim, 1 / 60); }
  assert.equal(rec(sim, g.id).links.length, 0, 'the tape gave');
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

test('remove puts a stick back in the bag and drops its joints', () => {
  const sim = createSim(RAPIER);
  const g = spawnGlue(sim); const s = spawnStick(sim); run(sim, 0.3);
  const [, e] = ends(rec(sim, s.id)); attach(sim, rec(sim, g.id), rec(sim, s.id), e, null);
  assert.equal(removeBody(sim, s.id).ok, true);
  assert.equal(sim.bag, 20); assert.equal(rec(sim, g.id).links.length, 0);
  run(sim, 1);
});

test('step cost stays small with a full kit on the table', () => {
  const sim = createSim(RAPIER);
  for (let i = 0; i < 20; i++) spawnStick(sim); for (let i = 0; i < 20; i++) spawnGlue(sim); spawnMarsh(sim);
  grab(sim, 'a:1', 's1', [0, 0, 0]);
  const t0 = performance.now(); for (let i = 0; i < 600; i++) { move(sim, 'a:1', [Math.sin(i / 20) * 20, 20, 0]); step(sim, 1 / 60); } const ms = (performance.now() - t0) / 600;
  console.log(`      ${ms.toFixed(3)} ms per 60 Hz tick, ${sim.bodies.size} bodies`);
  assert.ok(ms < 3, 'tick under 3 ms');
});
