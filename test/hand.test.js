import { test } from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { createHand, trackHand, handLag, dropHand, pointOn } from '../src/hand.js';

await RAPIER.init();

const world = () => new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const cube = (w, at = { x: 0, y: 0, z: 0 }, rot = null) => {
  const body = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(at.x, at.y, at.z).setRotation(rot || { x: 0, y: 0, z: 0, w: 1 }));
  w.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setDensity(1), body);
  return body;
};
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

test('the finger starts exactly on the point that was grabbed, wherever the body is turned', () => {
  const w = world();
  const half = Math.SQRT1_2;
  const body = cube(w, { x: 3, y: 2, z: 0 }, { x: 0, y: half, z: 0, w: half });   // 90° about y
  const corner = { x: 0.5, y: 0, z: 0 };
  const h = createHand(RAPIER, w, body, corner, { k: 1e4, d: 100 });
  const expected = pointOn(body, corner);
  assert.ok(dist(h.finger.translation(), expected) < 1e-6);
  assert.ok(Math.abs(expected.z + 0.5) < 1e-6, 'the rotation was applied, not ignored');
  assert.deepEqual(h.target, expected, 'and it is not yet being pulled anywhere');
});

test('the finger closes on the pointer, and never faster than its speed limit', () => {
  const w = world();
  const h = createHand(RAPIER, w, cube(w), { x: 0, y: 0, z: 0 }, { k: 1e4, d: 100 });
  const dt = 1 / 60, speed = 10;

  // a kinematic body takes its next position when the world steps, which is how both games drive it
  const tick = () => { trackHand(h, dt, { track: 22, speed }); w.step(); };

  h.target = { x: 100, y: 0, z: 0 };                       // a pointer that jumped across the room
  const before = h.finger.translation();
  tick();
  const moved = dist(h.finger.translation(), before);
  assert.ok(moved <= speed * dt * (1 + 1e-6), `moved ${moved}, cap is ${speed * dt}`);   // positions are f32
  assert.ok(moved > speed * dt * 0.99, 'and it does move at the cap when the pointer is far');

  h.target = { ...h.finger.translation() };                // a pointer where the finger already is
  h.target.x += 0.001;
  const near = h.finger.translation();
  tick();
  assert.ok(dist(h.finger.translation(), near) < speed * dt, 'it does not overshoot a near target');

  // left alone, it converges rather than orbiting
  h.target = { x: 2, y: 1, z: 0 };
  for (let i = 0; i < 300; i++) tick();
  assert.ok(dist(h.finger.translation(), h.target) < 0.01, `it arrives, got ${JSON.stringify(h.finger.translation())}`);
});

test('lag reports how far the body has fallen behind the finger, and dropping frees both', () => {
  const w = world();
  const body = cube(w);
  const h = createHand(RAPIER, w, body, { x: 0, y: 0, z: 0 }, { k: 50, d: 1 });   // a deliberately weak grip
  assert.ok(handLag(h, body) < 1e-6, 'nothing has moved yet');

  h.target = { x: 0, y: 6, z: 0 };
  for (let i = 0; i < 120; i++) { trackHand(h, 1 / 60, { track: 22, speed: 40 }); w.step(); }
  assert.ok(handLag(h, body) > 0.5, 'a weak spring cannot lift it, so the finger runs away from the body');

  const bodies = w.bodies.len(), joints = w.impulseJoints.len();
  dropHand(w, h);
  assert.equal(w.bodies.len(), bodies - 1, 'the finger is gone');
  assert.equal(w.impulseJoints.len(), joints - 1, 'and so is the spring');
  dropHand(w, h);                                          // twice is harmless: a socket can close mid-grab
  assert.equal(w.bodies.len(), bodies - 1);
});

test('a stiff grip carries the body, a loose one lets it swing behind', () => {
  const w = world();
  const stiff = cube(w, { x: -2, y: 0, z: 0 });
  const loose = cube(w, { x: 2, y: 0, z: 0 });
  const a = createHand(RAPIER, w, stiff, { x: 0, y: 0, z: 0 }, { k: 2e4, d: 250 });
  const b = createHand(RAPIER, w, loose, { x: 0, y: 0, z: 0 }, { k: 300, d: 8 });
  a.target = { x: -2, y: 4, z: 0 };
  b.target = { x: 2, y: 4, z: 0 };
  for (let i = 0; i < 180; i++) { trackHand(a, 1 / 60, { track: 22, speed: 40 }); trackHand(b, 1 / 60, { track: 22, speed: 40 }); w.step(); }
  assert.ok(handLag(a, stiff) < handLag(b, loose), 'the stiff grip holds the body closer to the finger');
  assert.ok(stiff.translation().y > 3.5, 'and it actually lifted it');
});
