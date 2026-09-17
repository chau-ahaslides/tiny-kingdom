import { test } from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { normalise, createWorld, addBody, removeBody, apply, step, snapshot, describe, isBusy, LIMITS } from '../src/phys-world.js';

await RAPIER.init();

const build = (spec) => { const { spec: s, errors } = normalise(spec); assert.deepEqual(errors, []); return createWorld(RAPIER, s); };
const run = (sim, secs) => { for (let i = 0; i < secs * 60; i++) step(sim, 1 / 60); };
const at = (sim, id) => sim.bodies.get(id).body.translation();

const GROUND = { id: 'ground', type: 'fixed', shape: { cuboid: [20, 0.1, 20] }, pos: [0, 0, 0] };

test('a world spec is checked before anything is built', () => {
  const { spec, errors } = normalise({
    gravity: [0, -20, 0], timestep: 1 / 1000, plane: 'xy', events: true,
    bodies: [
      { id: 'a', shape: { ball: 0.5 }, pos: [0, 3, 0] },
      { id: 'b', shape: { cuboid: [1, 1, 1] }, type: 'fixed' },
    ],
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(spec.gravity, [0, -20, 0]);
  assert.equal(spec.timestep, 1 / 240, 'clamped to something a room can step');
  assert.equal(spec.plane, 'xy');
  assert.equal(spec.bodies.length, 2);
  assert.equal(spec.bodies[0].density, 1, 'defaults filled in');

  const bad = normalise({ bodies: [{ shape: { ball: -1 } }, { shape: { blob: 2 } }, { id: 'x', shape: { cuboid: [1, 1] } }, 7] });
  assert.equal(bad.spec.bodies.length, 0);
  assert.equal(bad.errors.length, 4);
  assert.match(bad.errors[0], /ball radius/);
  assert.match(bad.errors[1], /unknown shape/);
  assert.match(bad.errors[2], /cuboid takes 3/);

  assert.match(normalise({ bodies: [{ id: 'a', shape: { ball: 1 } }, { id: 'a', shape: { ball: 1 } }] }).errors[0], /duplicate id/);
  assert.match(normalise({ bodies: [{ id: 'no spaces', shape: { ball: 1 } }] }).errors[0], /bad id/);
  assert.match(normalise({ bodies: Array.from({ length: LIMITS.bodies + 1 }, () => ({ shape: { ball: 1 } })) }).errors[0], /too many bodies/);
});

test('a ball falls, lands on the ground and goes to sleep', () => {
  const sim = build({ bodies: [GROUND, { id: 'ball', shape: { ball: 0.5 }, pos: [0, 6, 0], restitution: 0.2 }] });
  assert.equal(isBusy(sim), true);
  run(sim, 3);
  const p = at(sim, 'ball');
  assert.ok(Math.abs(p.y - 0.6) < 0.05, `rests on the ground surface, got y=${p.y}`);
  assert.ok(Math.abs(p.x) < 0.2 && Math.abs(p.z) < 0.2, 'did not wander');
  run(sim, 4);
  assert.equal(isBusy(sim), false, 'a settled world stops costing anything');
});

test('plane: "xy" turns the 3D engine into a 2D one', () => {
  const sim = build({ plane: 'xy', bodies: [GROUND, { id: 'box', shape: { cuboid: [0.5, 0.5, 0.5] }, pos: [0, 5, 0] }] });
  apply(sim, { t: 'impulse', id: 'box', v: [2, 0, 9] });          // a shove with a big z component
  run(sim, 2);
  const p = at(sim, 'box');
  assert.equal(Math.abs(p.z) < 1e-6, true, `z stays 0, got ${p.z}`);
  assert.ok(Math.abs(p.x) > 0.2, 'but x still moves');
  const q = sim.bodies.get('box').body.rotation();
  assert.ok(Math.abs(q.x) < 1e-6 && Math.abs(q.y) < 1e-6, 'and it only spins about z');
});

test('commands: add, impulse, velocity, place, remove, gravity', () => {
  const sim = build({ bodies: [GROUND] });
  assert.equal(apply(sim, { t: 'add', body: { id: 'crate', shape: { cuboid: [0.5, 0.5, 0.5] }, pos: [0, 4, 0] } }).ok, true);
  assert.equal(sim.bodies.size, 2);
  assert.equal(apply(sim, { t: 'add', body: { id: 'crate', shape: { ball: 1 } } }).ok, false, 'no two bodies with one id');
  assert.match(apply(sim, { t: 'add', body: { shape: { ball: 0 } } }).msg, /ball radius/);

  assert.equal(apply(sim, { t: 'impulse', id: 'nope', v: [0, 1, 0] }).ok, false);
  apply(sim, { t: 'velocity', id: 'crate', lin: [3, 0, 0] });
  step(sim, 1 / 60);
  assert.ok(sim.bodies.get('crate').body.linvel().x > 2, 'velocity took');

  apply(sim, { t: 'place', id: 'crate', pos: [7, 2, 1] });
  assert.deepEqual([at(sim, 'crate').x, at(sim, 'crate').z], [7, 1]);
  assert.equal(at(sim, 'crate').y, 2);

  apply(sim, { t: 'gravity', v: [0, 9.81, 0] });                  // upside down
  run(sim, 1);
  assert.ok(at(sim, 'crate').y > 2.5, 'it floats up now');

  assert.equal(apply(sim, { t: 'remove', id: 'crate' }).ok, true);
  assert.equal(sim.bodies.has('crate'), false);
  assert.equal(apply(sim, { t: 'unknown' }).ok, false);
});

test('a hand picks a body up, carries it and lets it go', () => {
  const sim = build({ bodies: [GROUND, { id: 'crate', shape: { cuboid: [0.4, 0.4, 0.4] }, pos: [0, 0.5, 0] }] });
  run(sim, 0.5);
  assert.equal(apply(sim, { t: 'grab', hand: 'phone1', id: 'ground' }).ok, false, 'fixed bodies cannot be picked up');
  assert.equal(apply(sim, { t: 'grab', hand: 'phone1', id: 'crate' }).ok, true);
  for (let i = 0; i < 180; i++) { apply(sim, { t: 'drag', hand: 'phone1', pos: [3, 3, 0] }); step(sim, 1 / 60); }
  const held = at(sim, 'crate');
  assert.ok(held.y > 2 && Math.abs(held.x - 3) < 1, `carried to the target, got ${JSON.stringify(held)}`);
  assert.equal(snapshot(sim).h.length, 1, 'the snapshot shows the hand');

  apply(sim, { t: 'release', hand: 'phone1' });
  assert.equal(sim.hands.size, 0);
  run(sim, 3);
  assert.ok(at(sim, 'crate').y < 1, 'and it falls when let go');
  assert.equal(apply(sim, { t: 'drag', hand: 'phone1', pos: [0, 0, 0] }).ok, false, 'an empty hand cannot drag');
});

test('snapshots carry what a client draws, and describe() what it is', () => {
  const sim = build({ bodies: [GROUND, { id: 'ball', tag: 'apple', shape: { ball: 0.5 }, pos: [0, 4, 0] }] });
  const s = snapshot(sim);
  assert.equal(s.b.length, 2);
  const row = s.b.find((r) => r[0] === 'ball');
  assert.equal(row.length, 9, '[id, x, y, z, qx, qy, qz, qw, sleeping]');
  assert.equal(row[2], 4);
  run(sim, 5);
  assert.equal(snapshot(sim, { all: false }).b.length, 0, 'sleeping bodies are not re-sent');

  const d = describe(sim);
  assert.deepEqual(d.gravity, [0, -9.81, 0]);
  assert.equal(d.bodies.find((b) => b.id === 'ball').tag, 'apple');
  assert.deepEqual(d.bodies.find((b) => b.id === 'ground').shape, { cuboid: [20, 0.1, 20] });
});

test('collision events report what hit what and how hard', () => {
  const sim = build({ events: true, eventForce: 0.5, bodies: [GROUND, { id: 'ball', tag: 'apple', shape: { ball: 0.5 }, pos: [0, 5, 0] }] });
  run(sim, 2);
  const hit = sim.events.find((e) => e.t === 'hit');
  assert.ok(hit, 'the landing was reported');
  assert.deepEqual([hit.a, hit.b].sort(), ['ball', 'ground']);
  assert.equal(hit.tagA === 'apple' || hit.tagB === 'apple', true);
  assert.ok(hit.speed > 0.5);
});

test('anything that falls out of the world is dropped and reported', () => {
  const sim = build({ floor: -5, bodies: [{ id: 'lost', shape: { ball: 0.5 }, pos: [0, 0, 0] }] });
  run(sim, 3);
  assert.equal(sim.bodies.has('lost'), false);
  assert.deepEqual(sim.events.find((e) => e.t === 'fell'), { t: 'fell', id: 'lost', tag: null });
});

test('the world is bounded: body count, sizes and speeds', () => {
  const sim = build({ bodies: [] });
  for (let i = 0; i < LIMITS.bodies; i++) addBody(sim, normalise({ bodies: [{ shape: { ball: 0.1 } }] }).spec.bodies[0]);
  assert.equal(sim.bodies.size, LIMITS.bodies);
  assert.match(addBody(sim, normalise({ bodies: [{ shape: { ball: 0.1 } }] }).spec.bodies[0]).msg, /world is full/);

  const s2 = build({ bodies: [{ id: 'x', shape: { ball: 0.5 }, pos: [0, 0, 0] }] });
  apply(s2, { t: 'velocity', id: 'x', lin: [1e9, 0, 0] });
  assert.ok(s2.bodies.get('x').body.linvel().x <= LIMITS.speed, 'a silly velocity is clamped');
  assert.equal(removeBody(s2, 'nope').ok, false);
});
