import { test } from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { normalise, createWorld, apply, step } from '../src/phys-world.js';

await RAPIER.init();

const build = (spec) => { const { spec: s, errors } = normalise(spec); assert.deepEqual(errors, []); return createWorld(RAPIER, s); };
const run = (sim, secs) => { for (let i = 0; i < secs * 60; i++) step(sim, 1 / 60); };

const WORLD = {
  bodies: [
    { id: 'ground', type: 'fixed', shape: { cuboid: [10, 0.1, 10] }, pos: [0, 0, 0] },
    { id: 'crate', tag: 'box', shape: { cuboid: [0.5, 0.5, 0.5] }, pos: [0, 0.6, 0] },
    { id: 'ball', tag: 'ball', shape: { ball: 0.5 }, pos: [3, 0.5, 0] },
  ],
};

test('pick turns a tap into a body', () => {
  const sim = build(WORLD);
  const inside = apply(sim, { t: 'pick', at: [0, 0.6, 0] });
  assert.equal(inside.ok, true);
  assert.equal(inside.id, 'crate');
  assert.equal(inside.tag, 'box');
  assert.equal(inside.inside, true, 'the point was inside the crate');
  assert.equal(inside.distance, 0);

  const near = apply(sim, { t: 'pick', at: [3, 1.2, 0], radius: 0.5 });
  assert.equal(near.id, 'ball', 'just above the ball, within the radius');
  assert.ok(near.distance > 0 && near.distance < 0.5);
  assert.equal(near.inside, false);

  const nothing = apply(sim, { t: 'pick', at: [0, 8, 0], radius: 0.5 });
  assert.equal(nothing.ok, false);
  assert.equal(nothing.id, null);
  assert.match(nothing.msg, /nothing within/);

  assert.equal(apply(sim, { t: 'pick', at: [0, 8, 0], radius: 100 }).ok, true, 'a wide enough radius finds the floor');
});

test('a ray reports what it meets, where and which way the surface faces', () => {
  const sim = build(WORLD);
  const down = apply(sim, { t: 'ray', from: [3, 5, 0], dir: [0, -1, 0], max: 10 });
  assert.equal(down.id, 'ball');
  assert.equal(down.tag, 'ball');
  assert.ok(Math.abs(down.at.y - 1) < 0.02, `landed on top of the ball, got ${down.at.y}`);
  assert.ok(down.normal.y > 0.9, 'the surface faces up');
  assert.ok(Math.abs(down.distance - 4) < 0.02);

  const short = apply(sim, { t: 'ray', from: [3, 5, 0], dir: [0, -1, 0], max: 1 });
  assert.equal(short.ok, false, 'a ray that stops short meets nothing');

  const sideways = apply(sim, { t: 'ray', from: [-5, 0.6, 0], dir: [1, 0, 0], max: 20 });
  assert.equal(sideways.id, 'crate', 'the first thing along the line, not the furthest');
  assert.ok(sideways.normal.x < -0.9, 'and the face it met points back at us');

  assert.equal(apply(sim, { t: 'ray', from: [0, 5, 0], dir: [0, 0, 0] }).ok, false, 'a ray needs a direction');
});

test('area finds everything within a radius, nearest first', () => {
  const sim = build(WORLD);
  const near = apply(sim, { t: 'area', at: [0, 0.6, 0], radius: 1 });
  assert.equal(near.ok, true);
  assert.deepEqual(near.hits.map((h) => h.id), ['crate', 'ground'], 'the crate is nearer than the floor');

  const wide = apply(sim, { t: 'area', at: [0, 0.6, 0], radius: 5 });
  assert.deepEqual(wide.hits.map((h) => h.id).sort(), ['ball', 'crate', 'ground']);
  assert.equal(wide.count, 3);
  assert.equal(wide.hits[0].tag, 'box');

  assert.deepEqual(apply(sim, { t: 'area', at: [0, 50, 0], radius: 1 }).hits, [], 'nothing up there');
});

test('a sensor reports what passes through it, and stops nothing', () => {
  const sim = build({
    events: true,
    bodies: [
      { id: 'goal', tag: 'goal', type: 'fixed', sensor: true, shape: { cuboid: [1, 1, 1] }, pos: [0, 1, 0] },
      { id: 'shot', tag: 'ball', shape: { ball: 0.2 }, pos: [0, 5, 0] },
    ],
  });
  run(sim, 1.2);
  const entered = sim.events.find((e) => e.t === 'enter');
  assert.ok(entered, `the ball entered the goal (saw ${JSON.stringify(sim.events)})`);
  assert.equal(entered.zone, 'goal');
  assert.equal(entered.zoneTag, 'goal');
  assert.equal(entered.id, 'shot');
  assert.equal(entered.tag, 'ball');

  run(sim, 1.5);
  assert.ok(sim.events.some((e) => e.t === 'exit' && e.id === 'shot'), 'and out the other side');
  assert.ok(sim.bodies.get('shot').body.translation().y < 0, 'a sensor stopped nothing: it kept falling');
});

test('a sensor reports even when the world did not ask for collision events', () => {
  const sim = build({
    bodies: [
      { id: 'zone', type: 'fixed', sensor: true, shape: { cuboid: [2, 2, 2] }, pos: [0, 2, 0] },
      { id: 'drop', shape: { ball: 0.3 }, pos: [0, 6, 0] },
    ],
  });
  run(sim, 1.5);
  assert.equal(sim.events.length, 0, 'without events: true the world is quiet about ordinary hits');
  const s = build({ events: true, bodies: [
    { id: 'zone', type: 'fixed', sensor: true, shape: { cuboid: [2, 2, 2] }, pos: [0, 2, 0] },
    { id: 'drop', shape: { ball: 0.3 }, pos: [0, 6, 0] },
  ] });
  run(s, 1.5);
  assert.ok(s.events.some((e) => e.t === 'enter'), 'with it, the zone speaks');
});

test('queries do not wake a settled world', () => {
  const sim = build(WORLD);
  run(sim, 5);
  const asleep = [...sim.bodies.values()].filter((r) => r.body.isSleeping()).length;
  apply(sim, { t: 'pick', at: [0, 0.6, 0] });
  apply(sim, { t: 'ray', from: [0, 5, 0], dir: [0, -1, 0] });
  apply(sim, { t: 'area', at: [0, 0, 0], radius: 5 });
  assert.equal([...sim.bodies.values()].filter((r) => r.body.isSleeping()).length, asleep,
    'a read leaves the world exactly as it found it');
});
