/* Hinges and sliders: the joints a game would otherwise fake by teleporting a body every frame. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { normalise, createWorld, apply, step, describe } from '../src/phys-world.js';

await RAPIER.init();

const build = (spec) => { const { spec: s, errors } = normalise(spec); assert.deepEqual(errors, []); return createWorld(RAPIER, s); };
const run = (sim, secs) => { for (let i = 0; i < secs * 60; i++) step(sim, 1 / 60); };
const at = (sim, id) => sim.bodies.get(id).body.translation();
const angle = (sim, id) => { const q = sim.bodies.get(id).body.rotation(); return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z)); };

/** A door: a fixed post at the origin and a panel hanging to its right, hinged where they meet. */
const DOOR = {
  plane: 'xy', settle: false,
  bodies: [
    { id: 'post', type: 'fixed', shape: { cuboid: [0.1, 1, 0.1] }, pos: [0, 0, 0] },
    { id: 'panel', shape: { cuboid: [0.5, 0.9, 0.05] }, pos: [0.6, 0, 0], density: 2 },
  ],
};
const hinge = (sim, extra = {}) => apply(sim, { t: 'joint', jid: 'h', kind: 'hinge', a: 'post', b: 'panel', at: [0.1, 0, 0], axis: [0, 0, 1], ...extra });

test('a hinge holds its body on one axis and lets it swing', () => {
  const sim = build({ ...DOOR, gravity: [0, -9.81, 0] });
  assert.equal(hinge(sim).ok, true);
  run(sim, 2);
  const p = at(sim, 'panel');
  assert.ok(Math.hypot(p.x - 0.1, p.y) < 0.75, `the panel stays on its hinge, at ${p.x.toFixed(2)},${p.y.toFixed(2)}`);
  assert.ok(Math.abs(angle(sim, 'panel')) > 0.3, 'and gravity swung it down');
});

test('limits stop it where it is told', () => {
  const sim = build({ ...DOOR, gravity: [0, -9.81, 0] });
  assert.equal(hinge(sim, { limits: [-0.3, 0.3] }).ok, true);
  run(sim, 3);
  const a = angle(sim, 'panel');
  assert.ok(a > -0.45 && a < 0.45, `held inside its limits, at ${a.toFixed(3)} rad`);
  assert.deepEqual(describe(sim).joints.find((j) => j.id === 'h').limits, [-0.3, 0.3]);

  assert.match(apply(sim, { t: 'motor', id: 'h', limits: [1, -1] }).msg, /min first/);
  assert.match(apply(sim, { t: 'motor', id: 'nope', motor: false }).msg, /no joint/);
});

test('a motor drives it at a speed, and holds it at a place', () => {
  const driven = build({ ...DOOR, gravity: [0, 0, 0] });
  hinge(driven, { motor: { speed: 2, force: 500 } });
  run(driven, 1);
  const spun = angle(driven, 'panel');
  assert.ok(spun > 1, `the motor turned it, ${spun.toFixed(2)} rad in a second at 2 rad/s`);

  const held = build({ ...DOOR, gravity: [0, -9.81, 0] });
  hinge(held, { motor: { target: 0.8, stiffness: 2000, damping: 200, force: 2000 } });
  run(held, 3);
  assert.ok(Math.abs(angle(held, 'panel') - 0.8) < 0.15, `held at its target against gravity, at ${angle(held, 'panel').toFixed(2)}`);

  // and letting go really lets go
  apply(held, { t: 'motor', id: 'h', motor: false });
  run(held, 2);
  assert.ok(angle(held, 'panel') < 0.5, 'slack again, so gravity takes it');
  assert.equal(describe(held).joints.find((j) => j.id === 'h').motor, undefined);
});

test('a slider is a lift: it travels along one axis and stops at its limits', () => {
  const sim = build({
    plane: 'xy', gravity: [0, -9.81, 0], settle: false,
    bodies: [
      { id: 'shaft', type: 'fixed', shape: { cuboid: [0.1, 3, 0.1] }, pos: [0, 0, 0] },
      { id: 'car', shape: { cuboid: [0.6, 0.2, 0.2] }, pos: [0, 0, 0], density: 2 },
    ],
  });
  assert.equal(apply(sim, { t: 'joint', jid: 'lift', kind: 'slider', a: 'shaft', b: 'car', at: [0, 0, 0], axis: [0, 1, 0], limits: [-1, 1] }).ok, true);
  run(sim, 2);
  assert.ok(at(sim, 'car').y < -0.8, 'it sank to the bottom of its travel');
  assert.ok(Math.abs(at(sim, 'car').x) < 0.05, 'and stayed on the shaft');

  apply(sim, { t: 'motor', id: 'lift', motor: { target: 0.9, stiffness: 3000, damping: 300, force: 5000 } });
  run(sim, 3);
  assert.ok(at(sim, 'car').y > 0.6, `the motor lifted it, y=${at(sim, 'car').y.toFixed(2)}`);
});

test('what a hinge refuses', () => {
  const sim = build(DOOR);
  assert.match(apply(sim, { t: 'joint', kind: 'hinge', a: 'post', b: 'panel', at: [0, 0, 0], axis: [0, 0, 0] }).msg, /axis with a length/);
  assert.equal(apply(sim, { t: 'joint', kind: 'hinge', a: 'post', b: 'nope', at: [0, 0, 0] }).ok, false);
  hinge(sim);
  assert.match(apply(sim, { t: 'motor', id: 'h', motor: 7 }).msg, /motor is/);

  const spring = build({ ...DOOR });
  apply(spring, { t: 'joint', jid: 'tape', kind: 'weld', a: 'post', b: 'panel', at: [0.1, 0, 0] });
  assert.match(apply(spring, { t: 'motor', id: 'tape', motor: { speed: 1 } }).msg, /only a hinge or a slider/);
});

test('a hinge is described to everyone who joins later', () => {
  const sim = build(DOOR);
  hinge(sim, { limits: [-1, 1], motor: { speed: 0.5 } });
  const j = describe(sim).joints.find((x) => x.id === 'h');
  assert.equal(j.kind, 'hinge');
  assert.deepEqual(j.axis, [0, 0, 1]);
  assert.deepEqual(j.limits, [-1, 1]);
  assert.equal(j.motor.speed, 0.5);
  assert.equal(apply(sim, { t: 'unjoint', id: 'h' }).ok, true);
  assert.equal(describe(sim).joints.length, 0);
});
