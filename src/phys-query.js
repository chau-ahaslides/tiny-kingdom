/* Asking the world questions, and hearing when something enters somewhere.
 *
 * Without these, a game has to keep its own copy of the world to answer "what did the player just
 * tap?", and poll snapshots to notice "the ball is in the goal". Both are the room's job: it has
 * the bodies, and Rapier answers either question in microseconds.
 *
 *   { t: 'pick', at: [x, y, z], radius }        what is at this point (the nearest body within radius)
 *   { t: 'ray', from: [...], dir: [...], max }  the first body a line meets, where, and its normal
 *   { t: 'area', at: [...], radius }            every body within a radius, nearest first
 *
 * Each answers the connection that asked, so a phone can turn a tap into a body id and then grab
 * it. They are reads: a world that has settled stays settled.
 *
 * Sensors are the other half. A body with `sensor: true` stops nothing and reports what passes
 * through it, as `enter` and `exit` events — a goal, a finish line, a pressure plate, a zone a game
 * scores on. The events name both bodies and their tags, so a game reads them without a lookup.
 */

const v3 = (a = [0, 0, 0]) => ({ x: +a[0] || 0, y: +a[1] || 0, z: +a[2] || 0 });
const num = (x, dflt, lo, hi) => (Number.isFinite(+x) ? Math.max(lo, Math.min(hi, +x)) : dflt);
const round = (n, p = 3) => +n.toFixed(p);
const point = (p) => ({ x: round(p.x), y: round(p.y), z: round(p.z) });

export const QUERY_LIMITS = { radius: 1000, distance: 10000, hits: 64 };

/** Collider handle -> the body record that owns it. */
function owners(sim) {
  const by = new Map();
  for (const rec of sim.bodies.values()) by.set(rec.collider.handle, rec);
  return by;
}

const found = (rec, extra = {}) => ({ ok: true, id: rec.id, tag: rec.tag ?? null, type: rec.def.type, ...extra });

/**
 * The body at a point: inside one if the point is inside it, otherwise the nearest within `radius`.
 * This is what a tap becomes — the id a game then grabs, removes or scores.
 */
export function pick(sim, m) {
  const at = v3(m.at || m.point);
  const radius = num(m.radius, 0.5, 0, QUERY_LIMITS.radius);
  const by = owners(sim);
  let best = null;
  // projectPoint gives the closest point on each collider; Rapier's own projection over the whole
  // world is one call, and it reports whether the point was inside the shape it found
  const hit = sim.world.projectPoint(at, true);
  if (hit) {
    const rec = by.get(hit.collider.handle);
    if (rec) {
      const p = hit.point;
      const inside = !!(hit.isInside ?? hit.inside);
      const d = inside ? 0 : Math.hypot(p.x - at.x, p.y - at.y, p.z - at.z);
      if (d <= radius || inside) best = found(rec, { at: point(p), inside, distance: round(d) });
    }
  }
  return best || { ok: false, msg: `nothing within ${radius} of ${[at.x, at.y, at.z].join(', ')}`, id: null };
}

/** The first body a line meets: what, where, which way its surface faces, how far. */
export function ray(sim, m) {
  const from = v3(m.from);
  const dir = v3(m.dir);
  const l = Math.hypot(dir.x, dir.y, dir.z);
  if (!l) return { ok: false, msg: 'ray needs a direction with a length' };
  const unit = { x: dir.x / l, y: dir.y / l, z: dir.z / l };
  const max = num(m.max, 100, 0, QUERY_LIMITS.distance);
  const hit = sim.world.castRayAndGetNormal(new sim.R.Ray(from, unit), max, true);
  if (!hit) return { ok: false, msg: 'the ray met nothing', id: null };
  const rec = owners(sim).get(hit.collider.handle);
  if (!rec) return { ok: false, msg: 'the ray met something the room does not own', id: null };
  const t = hit.timeOfImpact ?? hit.toi;
  return found(rec, {
    at: point({ x: from.x + unit.x * t, y: from.y + unit.y * t, z: from.z + unit.z * t }),
    normal: point(hit.normal),
    distance: round(t),
  });
}

/** Every body within a radius, nearest first — a blast, a magnet, "who is standing on the pad". */
export function area(sim, m) {
  const at = v3(m.at || m.point);
  const radius = num(m.radius, 1, 0, QUERY_LIMITS.radius);
  const hits = [];
  sim.world.intersectionsWithShape(at, { x: 0, y: 0, z: 0, w: 1 }, new sim.R.Ball(radius), (collider) => {
    const rec = owners(sim).get(collider.handle);
    if (rec) {
      const p = rec.body.translation();
      hits.push({ id: rec.id, tag: rec.tag ?? null, distance: round(Math.hypot(p.x - at.x, p.y - at.y, p.z - at.z)) });
    }
    return hits.length < QUERY_LIMITS.hits;
  });
  hits.sort((a, b) => a.distance - b.distance);
  return { ok: true, hits, count: hits.length };
}

/**
 * Turn Rapier's collision events into the room's: `hit` for two solid bodies meeting (with the
 * speed they met at, which is what a sound wants), `enter` and `exit` for a sensor. Called from the
 * world's step with the pre-step velocities, because a collision has already eaten them by the time
 * the solver is done.
 */
export function collisionEvent(sim, a, b, started, eventForce) {
  const sensor = a.def.sensor || b.def.sensor;
  if (sensor) {
    // the sensor is the place, the other body is the thing that entered it
    const [zone, body] = a.def.sensor ? [a, b] : [b, a];
    return { t: started ? 'enter' : 'exit', zone: zone.id, zoneTag: zone.tag ?? null, id: body.id, tag: body.tag ?? null };
  }
  if (!started) return null;
  const va = a.vel || a.body.linvel(), vb = b.vel || b.body.linvel();
  const speed = Math.hypot(va.x - vb.x, va.y - vb.y, va.z - vb.z);
  if (speed < eventForce) return null;
  return { t: 'hit', a: a.id, b: b.id, tagA: a.tag ?? null, tagB: b.tag ?? null, speed: round(speed, 2) };
}
