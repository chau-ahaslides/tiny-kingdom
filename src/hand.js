/* A hand: how a pointer picks a rigid body up and carries it without owning the physics.
 *
 * The trick, which the Marshmallow Challenge worked out and the shared physics room now uses too:
 * do not teleport the body to the finger. Create a kinematic point at the spot that was grabbed,
 * tie the body to it with a stiff spring, and let the point chase the pointer at a limited speed.
 * The body then swings, drags its neighbours, bumps into things and gets left behind when it snags —
 * all of which a teleport throws away, and all of which is what makes carrying feel physical.
 *
 * Two knobs decide the feel:
 *   k, d      how stiff the spring is, and how much it damps. Soft: the body lags and swings.
 *             Stiff: it follows exactly, and shoves whatever is in the way.
 *   track     how quickly the finger closes the gap to the pointer (per second), and
 *   speed     the ceiling on that, in world units per second, so a pointer that jumps across the
 *             screen drags the body rather than flinging it.
 *
 * Every game keeps its own extras on top (Marshmallow changes damping and collision masks while
 * carrying, and tears joints when you pull too hard); this file only owns the part they share.
 */

const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
const add = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const scale = (a, s) => v3(a.x * s, a.y * s, a.z * s);
const len = (a) => Math.hypot(a.x, a.y, a.z);

/** local point -> world, given the body's pose. */
export function pointOn(body, local) {
  const q = body.rotation(), p = body.translation();
  const ix = q.w * local.x + q.y * local.z - q.z * local.y, iy = q.w * local.y + q.z * local.x - q.x * local.z;
  const iz = q.w * local.z + q.x * local.y - q.y * local.x, iw = -q.x * local.x - q.y * local.y - q.z * local.z;
  return {
    x: p.x + ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: p.y + iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: p.z + iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}

/**
 * Grip `body` at `local` (a point in the body's own frame). Returns the hand:
 * { finger, joint, local, target }, which the caller stores and passes back to track and drop.
 */
export function createHand(R, world, body, local, { k, d }) {
  const lp = v3(local.x || 0, local.y || 0, local.z || 0);
  const at = pointOn(body, lp);
  const finger = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(at.x, at.y, at.z));
  const joint = world.createImpulseJoint(R.JointData.spring(0, k, d, v3(), lp), finger, body, true);
  body.wakeUp();
  return { finger, joint, local: lp, target: at };
}

/** Move the finger one substep towards the pointer: proportional, and speed-capped. */
export function trackHand(hand, dt, { track, speed }) {
  const p = hand.finger.translation();
  let step = scale(sub(hand.target, p), Math.min(1, track * dt));
  const l = len(step), cap = speed * dt;
  if (l > cap) step = scale(step, cap / l);
  hand.finger.setNextKinematicTranslation(add(p, step));
}

/** How far the body's grabbed point has fallen behind the finger — a snagged or overloaded grip. */
export function handLag(hand, body) {
  return len(sub(hand.finger.translation(), pointOn(body, hand.local)));
}

/** Let go: the joint and the finger both go away. Safe to call twice. */
export function dropHand(world, hand) {
  if (!hand) return;
  try { world.removeImpulseJoint(hand.joint, true); } catch (e) {}
  try { world.removeRigidBody(hand.finger); } catch (e) {}
}
