import { test } from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { normalise, createWorld, apply, step, describe, isBusy } from '../src/phys-world.js';

await RAPIER.init();

const build = (spec) => { const { spec: s, errors } = normalise(spec); assert.deepEqual(errors, []); return createWorld(RAPIER, s); };
const run = (sim, secs) => { for (let i = 0; i < secs * 60; i++) step(sim, 1 / 60); };
const at = (sim, id) => sim.bodies.get(id).body.translation();

// the 2D Marshmallow world in miniature: 1 unit = 10 cm, sticks 25 cm long
const TABLE = { id: 'table', type: 'fixed', shape: { cuboid: [8, 0.5, 1] }, pos: [0, -0.5, 0], friction: 0.8 };
const zrot = (a) => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
const stick = (id, x, y, a) => ({ id, shape: { cuboid: [1.25, 0.035, 0.25] }, pos: [x, y, 0], rot: zrot(a), density: 7, friction: 0.7 });
const TAPE = { kind: 'weld', stiffness: 1e4, bend: 0.5, arm: 1, breakAt: 0.35 };
const WORLD = { plane: 'xy', gravity: [0, -98.1, 0], timestep: 1 / 240, substeps: 4, iterations: 8 };

test('a joint holds two bodies where they were, and describe() tells a late joiner about it', () => {
  const sim = build({ ...WORLD, bodies: [TABLE, stick('a', 0, 0.035, 0), stick('b', 2.5, 0.035, 0)] });
  const r = apply(sim, { t: 'joint', a: 'a', b: 'b', at: [1.25, 0.035, 0], ...TAPE });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.joint).sort(), ['a', 'b', 'id', 'kind', 'la', 'lb']);
  assert.deepEqual(r.joint.la, [1.25, 0, 0], 'anchors are in each body\'s own frame');
  assert.equal(describe(sim).joints.length, 1);

  apply(sim, { t: 'grab', hand: 'p', id: 'a', at: [-1.25, 0, 0] });
  for (let i = 0; i < 120; i++) { apply(sim, { t: 'drag', hand: 'p', pos: [-1.25, 1, 0] }); step(sim, 1 / 60); }
  assert.ok(at(sim, 'b').y > 0.2, `lifting one end (to y=1, five units away) lifts the other body's middle by about a quarter, got y=${at(sim, 'b').y}`);

  assert.equal(apply(sim, { t: 'joint', a: 'a', b: 'a' }).ok, false, 'not to itself');
  assert.equal(apply(sim, { t: 'joint', a: 'a', b: 'nope' }).ok, false);
  assert.equal(apply(sim, { t: 'unjoint', id: r.id }).ok, true);
  assert.equal(describe(sim).joints.length, 0);
});

test('a taped triangle with a mast holds a marshmallow up, stands still and settles; untaped it is a heap', () => {
  // a base on the table, two legs taped to its ends and to each other, a mast, the marshmallow on top
  const L = 2.5, sp = 1.25, ht = Math.sqrt(L * L - sp * sp), A = Math.atan2(ht, sp), y0 = 0.036;
  const bodies = [TABLE, stick('b', 0, y0, 0), stick('l', -sp / 2, ht / 2 + y0, A), stick('r', sp / 2, ht / 2 + y0, Math.PI - A),
    stick('v', 0, ht + 1.25 + y0, Math.PI / 2),
    { id: 'marsh', shape: { cuboid: [0.21, 0.21, 0.25] }, pos: [0, ht + 2.5 + 0.25, 0], density: 80, friction: 0.9 }];
  const joints = [['b', 'l', -1.25, y0], ['b', 'r', 1.25, y0], ['l', 'r', 0, ht + y0], ['l', 'v', 0, ht + y0], ['v', 'marsh', 0, ht + 2.5 + y0]];

  const taped = build({ ...WORLD, bodies });
  for (const [p, q, x, y] of joints) assert.equal(apply(taped, { t: 'joint', a: p, b: q, at: [x, y, 0], ...TAPE }).ok, true);
  run(taped, 6);
  assert.ok(at(taped, 'marsh').y > 4.6, `the tower stands, marshmallow at y=${at(taped, 'marsh').y}`);
  assert.equal(taped.events.filter((e) => e.t === 'broke').length, 0, 'and no tape tore');
  const x0 = at(taped, 'marsh').x;
  run(taped, 6);
  assert.ok(Math.abs(at(taped, 'marsh').x - x0) < 0.1, `and does not creep across the table, moved ${at(taped, 'marsh').x - x0}`);
  assert.equal(isBusy(taped), false, 'a standing tower settles, so the room stops stepping it');

  const loose = build({ ...WORLD, bodies });
  run(loose, 6);
  assert.ok(at(loose, 'marsh').y < 1, `without tape it is a heap, marshmallow at y=${at(loose, 'marsh').y}`);
});

test('tape tears when yanked, and the break is reported', () => {
  const sim = build({ ...WORLD, bodies: [TABLE, stick('a', 0, 0.035, 0), stick('b', 2.5, 0.035, 0)] });
  apply(sim, { t: 'joint', a: 'a', b: 'b', at: [1.25, 0.035, 0], ...TAPE });
  sim.bodies.get('b').body.lockTranslations(true, true);                    // held down at the far end
  apply(sim, { t: 'grab', hand: 'p', id: 'a', strength: 20 });
  for (let i = 0; i < 180; i++) { apply(sim, { t: 'drag', hand: 'p', pos: [-8, 6, 0] }); step(sim, 1 / 60); }
  const broke = sim.events.find((e) => e.t === 'broke');
  assert.ok(broke, 'the joint came apart');
  assert.deepEqual([broke.a, broke.b, broke.why], ['a', 'b', 'stretched']);
  assert.equal(sim.joints.size, 0);
});

test('removing a body takes its joints with it', () => {
  const sim = build({ ...WORLD, bodies: [TABLE, stick('a', 0, 0.035, 0), stick('b', 2.5, 0.035, 0)] });
  apply(sim, { t: 'joint', a: 'a', b: 'b', at: [1.25, 0.035, 0], ...TAPE });
  apply(sim, { t: 'remove', id: 'b' });
  assert.equal(sim.joints.size, 0);
  assert.equal(sim.events.find((e) => e.t === 'broke').why, 'removed');
});

test('a ghost grab carries a piece through others; hold keeps its angle and turn sets it', () => {
  const sim = build({ ...WORLD, bodies: [TABLE, stick('wall', 0, 1.25, Math.PI / 2), stick('s', -3, 0.035, 0)] });
  run(sim, 0.2);
  sim.bodies.get('wall').body.lockTranslations(true, true);                 // a post that stays put
  apply(sim, { t: 'grab', hand: 'p', id: 's', ghost: true, hold: true });
  for (let i = 0; i < 240; i++) { apply(sim, { t: 'drag', hand: 'p', pos: [3, 1, 0] }); step(sim, 1 / 60); }
  assert.ok(at(sim, 's').x > 2.5, `carried straight through the post, x=${at(sim, 's').x}`);
  const q = sim.bodies.get('s').body.rotation();
  assert.ok(Math.abs(q.z) < 0.02, 'held level, not swinging');

  assert.equal(apply(sim, { t: 'turn', hand: 'p', angle: Math.PI / 2 }).ok, true);
  const q2 = sim.bodies.get('s').body.rotation();
  assert.ok(Math.abs(Math.abs(2 * Math.atan2(q2.z, q2.w)) - Math.PI / 2) < 0.01, 'turned upright');

  apply(sim, { t: 'release', hand: 'p' });
  apply(sim, { t: 'place', id: 's', pos: [0, 4, 0] });
  run(sim, 2);
  assert.ok(at(sim, 's').y > 2.4, `let go, it collides again and lands on the post, y=${at(sim, 's').y}`);
  assert.equal(apply(sim, { t: 'turn', hand: 'p', angle: 1 }).ok, false, 'an empty hand turns nothing');
});
