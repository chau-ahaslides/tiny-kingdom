/* Marshmallow Challenge 2D: the room builds one spaghetti tower, side on.
 *
 * Two libraries, one code:
 *   aha-room.js     the lobby, names, the QR and the round (phase, clock, result): the big screen owns it
 *   aha-physics.js  the table itself: sticks, tape and the marshmallow, simulated on the server, so
 *                   every phone drags a real object and the big screen is just another viewer
 *
 * Units are tenths of a metre (1 unit = 10 cm), so a stick is 2.5 long and gravity is 98.1.
 * The bag is enforced by ids: sticks are s0..s19 (a snapped one becomes s7-a and s7-b), the
 * marshmallow is "marsh", and the room refuses a second body with an id that exists. */
import { AhaRoom } from '/js/aha-room.js';
import { AhaPhysics } from '/js/aha-physics.js';

const CM = 10;                                  // cm per unit
const HALF = 1.25, THICK = 0.035, DEPTH = 0.25; // stick half-length, half-thickness, and the (invisible) z half-depth
const MARSH = 0.21;                             // marshmallow half-size
const STICKS = 20;
const TABLE = 8;                                // table half-width
const TAPE = { kind: 'weld', stiffness: 1e4, bend: 0.5, arm: 1, breakAt: 0.35 };   // stiffer trembles faster than the world steps, and a tower walks across the table
const REACH = 0.1;                              // how close (1 cm) an end must be to tape itself on
const SPEC = {
  plane: 'xy', gravity: [0, -98.1, 0], timestep: 1 / 240, substeps: 4, iterations: 8, floor: -12,
  bodies: [{ id: 'table', type: 'fixed', tag: 'table', shape: { cuboid: [TABLE, 0.5, 1] }, pos: [0, -0.5, 0], friction: 0.8 }],
};
const PALETTE = ['#c2410c', '#1f7a4d', '#1d4ed8', '#9d174d', '#7c3aed', '#0e7490', '#a16207', '#be123c'];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const IS_PHONE = q.has('join') || location.hash.includes('join=');

/* ------------------------------------------------------------------ pieces */

const zrot = (a) => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
const stickBody = (id, x, y, angle, half = HALF) => ({
  id, tag: 'stick', shape: { cuboid: [half, THICK, DEPTH] }, pos: [x, y, 0], rot: zrot(angle),
  density: 1.2 / (2 * HALF * 2 * THICK * 2 * DEPTH), friction: 0.7, linearDamping: 0.3, angularDamping: 0.6,
});
const marshBody = (x, y) => ({
  id: 'marsh', tag: 'marsh', shape: { cuboid: [MARSH, MARSH, DEPTH] }, pos: [x, y, 0],
  density: 7 / (8 * MARSH * MARSH * DEPTH), friction: 0.9, linearDamping: 0.3, angularDamping: 0.6,
});
const isStick = (b) => !!b && (b.tag === 'stick' || /^s\d/.test(b.id));
// bodies added mid-game arrive without their shape, so the id says what a piece is: s7, s7-a (half), marsh
const halfOf = (b) => (b.shape && b.shape.cuboid ? b.shape.cuboid[0] : b.id === 'marsh' ? MARSH : /-[ab]$/.test(b.id) ? HALF / 2 : HALF);

function ends(b) {
  const h = halfOf(b), c = Math.cos(b.angle), s = Math.sin(b.angle);
  return [{ x: b.x - c * h, y: b.y - s * h }, { x: b.x + c * h, y: b.y + s * h }];
}
function closestOnSeg(a, b, p) {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L));
  return { x: a.x + dx * t, y: a.y + dy * t };
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
/** distance from p to the marshmallow's surface (0 inside) */
function marshGap(m, p) {
  const c = Math.cos(-m.angle), s = Math.sin(-m.angle);
  const lx = (p.x - m.x) * c - (p.y - m.y) * s, ly = (p.x - m.x) * s + (p.y - m.y) * c;
  return Math.hypot(Math.max(0, Math.abs(lx) - MARSH), Math.max(0, Math.abs(ly) - MARSH));
}
function top(b) {
  if (b.id === 'marsh') { const r = MARSH * (Math.abs(Math.cos(b.angle)) + Math.abs(Math.sin(b.angle))); return b.y + r; }
  const [a, c] = ends(b); return Math.max(a.y, c.y) + THICK;
}
function sticksLeft(world) {
  let used = 0;
  for (const b of world.bodies.values()) if (isStick(b)) used += halfOf(b) / HALF;
  return Math.max(0, Math.round((STICKS - used) * 2) / 2);
}
function freeStickId(world) {
  for (let i = 0; i < STICKS; i++) {
    const id = 's' + i;
    if (!world.bodies.has(id) && !world.bodies.has(id + '-a') && !world.bodies.has(id + '-b')) return id;
  }
  return null;
}
/** everything taped to a body, through any chain of tape */
function connected(world, id) {
  const seen = new Set([id]), queue = [id];
  while (queue.length) {
    const c = queue.pop();
    for (const j of world.joints.values()) {
      const o = j.a === c ? j.b : j.b === c ? j.a : null;
      if (o && !seen.has(o)) { seen.add(o); queue.push(o); }
    }
  }
  return seen;
}
/** where a piece would tape itself if let go now: [{ other, at }] */
function tapeTargets(world, heldId) {
  const held = world.bodies.get(heldId);
  if (!held) return [];
  const group = connected(world, heldId);
  const out = new Map();                                   // one joint per pair
  const add = (other, at) => { if (!group.has(other.id) && !out.has(other.id)) out.set(other.id, { other: other.id, at }); };
  const pieces = [...world.bodies.values()].filter((b) => b.id !== heldId && (isStick(b) || b.id === 'marsh'));
  if (held.id === 'marsh') {
    for (const o of pieces) for (const e of ends(o)) if (marshGap(held, e) < REACH * 0.6) add(o, e);
  } else {
    const [h1, h2] = ends(held);
    for (const o of pieces) {
      if (o.id === 'marsh') { for (const e of [h1, h2]) if (marshGap(o, e) < REACH * 0.6) add(o, e); continue; }
      const [o1, o2] = ends(o);
      for (const e of [h1, h2]) {                          // my end onto any part of the other stick
        const c = closestOnSeg(o1, o2, e);
        if (dist(c, e) - 2 * THICK < REACH) add(o, { x: (c.x + e.x) / 2, y: (c.y + e.y) / 2 });
      }
      for (const e of [o1, o2]) {                          // its end onto the middle of mine
        const c = closestOnSeg(h1, h2, e);
        if (dist(c, e) - 2 * THICK < REACH) add(o, { x: (c.x + e.x) / 2, y: (c.y + e.y) / 2 });
      }
    }
  }
  return [...out.values()];
}
/** the result, if the round ended now */
function measure(world) {
  const m = world.bodies.get('marsh');
  if (!m) return { ok: false, note: 'No marshmallow on the tower' };
  if ((world.hands || []).length) return { ok: false, note: 'Someone is still holding a piece' };
  const mt = top(m);
  if (mt - 2 * MARSH < 0.25) return { ok: false, note: 'The marshmallow is on the table' };
  for (const b of world.bodies.values()) if (isStick(b) && top(b) > mt + 0.05) return { ok: false, note: 'The marshmallow must be on the very top', cm: Math.round(mt * CM) };
  return { ok: true, cm: Math.round(mt * CM), note: 'Standing, with the marshmallow on top' };
}
function tallest(world) {
  let t = 0;
  for (const b of world.bodies.values()) if (isStick(b) || b.id === 'marsh') t = Math.max(t, top(b));
  return Math.round(t * CM);
}
/** somewhere on the table a new piece can lie without landing on anything */
function spawnSpot(world, wantX, half) {
  const clear = (x) => {
    if (Math.abs(x) + half > TABLE - 0.2) return false;
    for (const b of world.bodies.values()) {
      if (b.id === 'table') continue;
      const bh = b.id === 'marsh' ? MARSH : Math.abs(Math.cos(b.angle)) * halfOf(b) + 0.1;
      if (Math.abs(b.x - x) < half + bh + 0.6 && b.y < 3) return false;      // a hand's width apart, so nothing tapes by accident
    }
    return true;
  };
  const x0 = Math.max(-TABLE + half + 0.3, Math.min(TABLE - half - 0.3, wantX));
  for (let d = 0; d <= 16; d += 0.25) for (const x of [x0 + d, x0 - d]) if (clear(x)) return { x, y: null };
  return { x: x0, y: 9 };                                   // table's full: drop it in from above
}

/* ------------------------------------------------------------------ drawing */

const COLORS = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['paper', 'grid', 'ink', 'muted', 'line', 'accent', 'surface']) COLORS[k] = cs.getPropertyValue('--' + k).trim();
}
const colorOf = (id) => { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) | 0; return PALETTE[Math.abs(h) % PALETTE.length]; };

class View {
  constructor(canvas) { this.c = canvas; this.ctx = canvas.getContext('2d'); this.cx = 0; this.cy = 4; this.s = 60; this.w = 0; this.h = 0; this.dpr = 1; this.insetTop = 0; this.insetBottom = 0; }
  resize() {
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.w = innerWidth; this.h = innerHeight;
    this.c.width = Math.round(this.w * this.dpr); this.c.height = Math.round(this.h * this.dpr);
  }
  toScreen(x, y) { return [this.w / 2 + (x - this.cx) * this.s, this.midY() - (y - this.cy) * this.s]; }
  toWorld(px, py) { return { x: this.cx + (px - this.w / 2) / this.s, y: this.cy - (py - this.midY()) / this.s }; }
  midY() { return this.insetTop + (this.h - this.insetTop - this.insetBottom) / 2; }
  fit(x0, x1, y0, y1, pad = 1.08) {
    const H = this.h - this.insetTop - this.insetBottom;
    this.s = Math.min(this.w / ((x1 - x0) * pad), H / ((y1 - y0) * pad));
    this.cx = (x0 + x1) / 2; this.cy = (y0 + y1) / 2;
  }
}

function draw(view, world, { hands = [], nameOf = () => '', mine = null, targets = [], big = false } = {}) {
  const { ctx, s, dpr } = view;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COLORS.paper; ctx.fillRect(0, 0, view.w, view.h);

  // a ruler every 10 cm, labelled every 50
  const lo = view.toWorld(0, view.h), hi = view.toWorld(view.w, 0);
  ctx.lineWidth = 1;
  ctx.font = `500 ${big ? 16 : 12}px Fredoka, system-ui`;
  ctx.textBaseline = 'middle';
  for (let y = 1; y <= Math.ceil(hi.y); y++) {
    const [, py] = view.toScreen(0, y);
    if (py < view.insetTop + 16) break;
    const major = y % 5 === 0;
    ctx.strokeStyle = COLORS.grid; ctx.globalAlpha = major ? 1 : 0.55;
    ctx.beginPath(); ctx.moveTo(0, Math.round(py) + 0.5); ctx.lineTo(view.w, Math.round(py) + 0.5); ctx.stroke();
    ctx.globalAlpha = 1;
    // labels down the right edge: the left is where the lobby card and the log live
    if (major || s > 40) { ctx.fillStyle = COLORS.muted; ctx.textAlign = 'right'; ctx.fillText(`${y * CM} cm`, view.w - 10, py - (big ? 12 : 9)); ctx.textAlign = 'left'; }
  }

  // the table
  const [tl, tt] = view.toScreen(-TABLE, 0), [tr] = view.toScreen(TABLE, 0);
  ctx.fillStyle = '#b07a45'; ctx.fillRect(tl, tt, tr - tl, Math.max(10, 0.35 * s));
  ctx.fillStyle = '#8a5a2e'; ctx.fillRect(tl, tt + Math.max(10, 0.35 * s), tr - tl, Math.max(8, 0.25 * s));
  ctx.fillStyle = '#7a4d26'; ctx.fillRect(tl + 0.4 * s, tt, Math.max(8, 0.3 * s), view.h - tt);
  ctx.fillRect(tr - 0.4 * s - Math.max(8, 0.3 * s), tt, Math.max(8, 0.3 * s), view.h - tt);
  if (lo.x < -TABLE || hi.x > TABLE) { /* the floor is off-screen below; nothing to draw */ }

  const held = new Map(hands.map((h) => [h[1], h[0]]));
  const bodies = world.step();

  for (const b of bodies) {
    if (!isStick(b)) continue;
    const [sx, sy] = view.toScreen(b.x, b.y);
    const len = 2 * halfOf(b) * s, th = Math.max(big ? 5 : 4, 2 * THICK * s);
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(-b.angle);
    const by = held.get(b.id);
    if (by) { ctx.shadowColor = colorOf(by); ctx.shadowBlur = 14; }
    ctx.fillStyle = '#e8b64c'; ctx.strokeStyle = '#9a6b12'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(-len / 2, -th / 2, len, th, th / 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  const m = world.bodies.get('marsh');
  if (m) {
    const [sx, sy] = view.toScreen(m.x, m.y), r = MARSH * s;
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(-m.angle);
    const by = held.get('marsh');
    if (by) { ctx.shadowColor = colorOf(by); ctx.shadowBlur = 16; }
    ctx.fillStyle = '#fffaf5'; ctx.strokeStyle = '#c9ab98'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(-r, -r, 2 * r, 2 * r, r * 0.45); ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(236, 196, 178, .55)'; ctx.beginPath(); ctx.roundRect(-r * 0.8, r * 0.1, r * 1.6, r * 0.7, r * 0.3); ctx.fill();
    ctx.restore();
  }
  // tape: a little translucent square on each joint
  for (const j of world.joints.values()) {
    const p = world.jointPoint(j); if (!p) continue;
    const b = world.bodies.get(j.b) || world.bodies.get(j.a);
    const [sx, sy] = view.toScreen(p.x, p.y), t = Math.max(big ? 12 : 10, 0.2 * s);
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(-(b ? b.angle : 0) + 0.3);
    ctx.fillStyle = 'rgba(147, 176, 204, .78)'; ctx.strokeStyle = 'rgba(71, 101, 130, .9)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.rect(-t / 2, -t / 3, t, t * 2 / 3); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  // where the piece in my hand would tape itself
  for (const t of targets) {
    const [sx, sy] = view.toScreen(t.at.x, t.at.y);
    ctx.strokeStyle = COLORS.accent; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(sx, sy, big ? 14 : 12, 0, Math.PI * 2); ctx.stroke();
  }
  // everyone's hands, with names
  for (const [hid, , x, y] of hands) {
    const [sx, sy] = view.toScreen(x, y), col = colorOf(hid);
    ctx.fillStyle = col; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sx, sy, big ? 9 : 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    const name = hid === mine ? 'You' : nameOf(hid);
    if (!name) continue;
    ctx.font = `600 ${big ? 20 : 14}px Fredoka, system-ui`;
    const w = ctx.measureText(name).width + 16, hgt = big ? 30 : 24;
    ctx.fillStyle = col; ctx.beginPath(); ctx.roundRect(sx + 12, sy - hgt - 4, w, hgt, hgt / 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(name, sx + 20, sy - hgt / 2 - 4);
  }
  return bodies;
}

/* ------------------------------------------------------------------ a builder's hands: pointer, pinch, twist */

class Builder {
  /** world() returns the current AhaPhysics world; view is the View; onChange tells the page what is held */
  constructor(canvas, view, { world, canBuild, onChange, pan = true }) {
    Object.assign(this, { canvas, view, world, canBuild, onChange, pan });
    this.pointers = new Map(); this.heldId = null; this.angle = 0; this.lastDrag = 0; this.pending = null; this.twist = null; this.pinch = null;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    for (const ev of ['pointerup', 'pointercancel']) canvas.addEventListener(ev, (e) => this.up(e));
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
  }
  pick(px, py) {
    const w = this.world(); if (!w) return null;
    const p = this.view.toWorld(px, py), slop = 22 / this.view.s;   // a 44px-wide target, however far out we are zoomed
    let best = null, bd = Infinity;
    for (const b of w.bodies.values()) {
      let d;
      if (b.id === 'marsh') d = marshGap(b, p) - slop * 0.5;
      else if (isStick(b)) { const [a, c] = ends(b); d = dist(closestOnSeg(a, c, p), p) - THICK; }
      else continue;
      if (d < slop && d < bd) { bd = d; best = b; }
    }
    return best;
  }
  down(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const w = this.world();
    if (this.pointers.size === 1) {
      const b = this.canBuild() && this.pick(e.clientX, e.clientY);
      if (b && w) {
        const p = this.view.toWorld(e.clientX, e.clientY);
        const c = Math.cos(-b.angle), s = Math.sin(-b.angle);
        const local = [(p.x - b.x) * c - (p.y - b.y) * s, (p.x - b.x) * s + (p.y - b.y) * c, 0];
        this.heldId = b.id; this.angle = b.angle; this.grabPointer = e.pointerId;
        w.grab(b.id, local, 1, { ghost: true, hold: true });
        this.onChange(b.id);
      } else if (this.pan) this.panFrom = { x: e.clientX, y: e.clientY, cx: this.view.cx, cy: this.view.cy };
    } else if (this.pointers.size === 2) {
      const [a, c] = [...this.pointers.values()];
      if (this.heldId) this.twist = { base: Math.atan2(c.y - a.y, c.x - a.x), angle: this.angle };
      else if (this.pan) { this.panFrom = null; this.pinch = { d: Math.hypot(c.x - a.x, c.y - a.y), s: this.view.s, mid: this.view.toWorld((a.x + c.x) / 2, (a.y + c.y) / 2) }; }
    }
  }
  move(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const w = this.world();
    if (this.heldId && this.twist && this.pointers.size >= 2) {
      const [a, c] = [...this.pointers.values()];
      this.turnTo(this.twist.angle - (Math.atan2(c.y - a.y, c.x - a.x) - this.twist.base));
      return;
    }
    if (this.heldId && e.pointerId === this.grabPointer && w) {
      const p = this.view.toWorld(e.clientX, e.clientY);
      this.pending = [Math.max(-TABLE - 1, Math.min(TABLE + 1, p.x)), Math.max(0.05, Math.min(40, p.y))];
      const now = performance.now();
      if (now - this.lastDrag > 33) { w.drag(this.pending); this.lastDrag = now; this.pending = null; }
      else if (!this.flushT) this.flushT = setTimeout(() => { this.flushT = 0; if (this.pending && this.heldId) { this.world()?.drag(this.pending); this.lastDrag = performance.now(); this.pending = null; } }, 34);
      return;
    }
    if (this.pinch && this.pointers.size >= 2) {
      const [a, c] = [...this.pointers.values()];
      this.view.s = Math.max(8, Math.min(240, this.pinch.s * Math.hypot(c.x - a.x, c.y - a.y) / this.pinch.d));
      const now = this.view.toWorld((a.x + c.x) / 2, (a.y + c.y) / 2);
      this.view.cx += this.pinch.mid.x - now.x; this.view.cy += this.pinch.mid.y - now.y;
      return;
    }
    if (this.panFrom) {
      this.view.cx = this.panFrom.cx - (e.clientX - this.panFrom.x) / this.view.s;
      this.view.cy = this.panFrom.cy + (e.clientY - this.panFrom.y) / this.view.s;
    }
  }
  up(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) { this.twist = null; this.pinch = null; }
    if (e.pointerId === this.grabPointer) this.letGo();
    if (!this.pointers.size) this.panFrom = null;
  }
  wheel(e) {
    e.preventDefault();
    if (this.heldId) { this.turnTo(this.angle - Math.sign(e.deltaY) * Math.PI / 24); return; }
    if (!this.pan) return;
    const before = this.view.toWorld(e.clientX, e.clientY);
    this.view.s = Math.max(8, Math.min(240, this.view.s * Math.exp(-e.deltaY * 0.0015)));
    const after = this.view.toWorld(e.clientX, e.clientY);
    this.view.cx += before.x - after.x; this.view.cy += before.y - after.y;
  }
  turnTo(angle) {
    const w = this.world(); if (!w || !this.heldId) return;
    this.angle = angle;
    const now = performance.now();
    if (now - (this.lastTurn || 0) > 45) { w.turn(angle); this.lastTurn = now; }
    else { clearTimeout(this.turnT); this.turnT = setTimeout(() => { if (this.heldId) { this.world()?.turn(this.angle); this.lastTurn = performance.now(); } }, 50); }
  }
  turnBy(d) { this.turnTo(this.angle + d); }
  /** let go: tape whatever the piece is touching */
  async letGo({ tape = true } = {}) {
    const w = this.world(), id = this.heldId;
    this.heldId = null; this.grabPointer = null; this.twist = null;
    if (!w || !id) return 0;
    if (this.pending) { w.drag(this.pending); this.pending = null; }
    const targets = tape ? tapeTargets(w, id) : [];
    w.release();
    this.onChange(null);
    let n = 0;
    for (const t of targets) { try { await w.joint(id, t.other, [t.at.x, t.at.y], TAPE); n++; } catch (err) { /* the other piece went away */ } }
    return n;
  }
}

/* ------------------------------------------------------------------ shared bits */

const view = new View($('scene'));
let world = null;
function resize() { view.resize(); readColors(); }
addEventListener('resize', resize);
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', readColors);

function announce(text) { $('live').textContent = ''; requestAnimationFrame(() => { $('live').textContent = text; }); }
const mmss = (ms) => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

let audio = null;
function blip(freq, dur = 0.08, type = 'triangle', vol = 0.12) {
  try {
    audio ||= new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
    o.type = type; o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(freq * 0.6, t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(audio.destination); o.start(t); o.stop(t + dur);
  } catch (e) { /* no sound is fine */ }
}

/* ------------------------------------------------------------------ the big screen */

async function hostMain() {
  document.documentElement.classList.add('host');
  $('host').hidden = false;
  resize();
  const card = $('card');
  let room;
  const saved = sessionStorage.getItem('m2d:code');
  try { room = await AhaRoom.host(saved ? { code: saved } : {}); }
  catch (e) {
    try { room = await AhaRoom.host(); } catch (e2) { $('hint').textContent = 'Could not open a room. Check the connection and reload.'; return; }
  }
  sessionStorage.setItem('m2d:code', room.code);
  room.mountLobby(card);

  const logEl = $('log'), lines = [];
  const log = (s) => { lines.unshift(s); lines.length = Math.min(lines.length, 5); logEl.replaceChildren(...lines.map((t) => Object.assign(document.createElement('li'), { textContent: t }))); };

  async function connect() {
    world = await AhaPhysics.host(SPEC, { code: room.code });
    world.on('joined', () => blip(520, 0.06));
    world.on('broke', (e) => { if (e.why === 'stretched') { log('✂️ Some tape tore'); blip(180, 0.18, 'sawtooth', 0.08); } });
    world.on('added', (e) => { const who = nameOf(e.by); if (who && e.id === 'marsh') log(`${who} took out the marshmallow`); });
    world.on('close', () => { $('hint').textContent = 'Lost the table. Reconnecting…'; setTimeout(() => connect().then(() => { $('hint').textContent = HINT; }).catch(() => {}), 1500); });
  }
  const HINT = $('hint').textContent;
  const nameOf = (id) => (id && id.startsWith('host') ? 'Host' : room.players.get(id)?.name || '');
  try { await connect(); } catch (e) { $('hint').textContent = 'Could not reach the physics room. Reload to try again.'; return; }

  let doc = { phase: 'lobby', mins: 5, best: 0, round: 0 };
  const set = (patch) => { Object.assign(doc, patch); room.state.set(patch); render(); };
  set(doc);
  room.on('join', ({ name, rejoin }) => { if (!rejoin) log(`${name} joined`); });

  const builder = new Builder($('scene'), view, { world: () => world, canBuild: () => doc.phase === 'build', onChange: () => {}, pan: false });
  window.m2d = { view, world: () => world, builder, room };      // for the console and the end-to-end test
  addEventListener('keydown', (e) => {
    if (!builder.heldId) return;
    if (e.key === 'q' || e.key === 'Q') builder.turnBy(Math.PI / 12);
    if (e.key === 'e' || e.key === 'E') builder.turnBy(-Math.PI / 12);
  });

  $('mins').addEventListener('change', () => set({ mins: +$('mins').value }));
  $('start').addEventListener('click', () => {
    world.reset(SPEC);
    set({ phase: 'build', endsAt: Date.now() + doc.mins * 60000, result: null, round: doc.round + 1 });
    log('The clock is running'); announce(`Round started: ${doc.mins} minutes`); blip(660, 0.15);
  });
  $('end').addEventListener('click', () => { if (doc.phase === 'build') set({ endsAt: Date.now() }); });
  $('again').addEventListener('click', () => { world.reset(SPEC); set({ phase: 'lobby', result: null }); });

  function render() {
    const lobby = doc.phase === 'lobby';
    $('start').hidden = !lobby; $('minsWrap').hidden = !lobby;
    $('end').hidden = doc.phase !== 'build';
    $('again').hidden = doc.phase !== 'done';
    card.classList.toggle('small', !lobby);
    $('phase').textContent = { lobby: 'Waiting to start', build: 'Build!', settle: 'Hands off…', done: 'Round over' }[doc.phase];
    const r = doc.result;
    $('result').hidden = !r;
    if (r) {
      $('result').classList.toggle('fail', !r.ok);
      $('rbig').textContent = r.ok ? `${r.cm} cm` : 'No score';
      $('rnote').textContent = r.ok ? (r.cm >= doc.best ? `${r.note}. Best of the day!` : `${r.note}. Best today: ${doc.best} cm`) : r.note;
    }
  }

  let lastSay = '';
  function tick() {
    const now = Date.now();
    if (doc.phase === 'build') {
      const left = doc.endsAt - now;
      $('time').textContent = mmss(left);
      $('clock').classList.toggle('low', left < 30000);
      const say = left <= 10000 ? '' : left <= 30500 && left > 29500 ? '30 seconds left' : (Math.ceil(left / 1000) % 60 === 0 && left > 1000 ? `${Math.ceil(left / 60000)} minutes left` : '');
      if (say && say !== lastSay) { announce(say); lastSay = say; }
      if (left <= 0) { set({ phase: 'settle', settleAt: now + 4000 }); log('👐 Time! Hands off…'); announce('Time! Hands off'); blip(330, 0.3, 'square', 0.08); }
    } else if (doc.phase === 'settle') {
      $('time').textContent = '0:00'; $('clock').classList.remove('low');
      if (now >= doc.settleAt) {
        const r = measure(world);
        set({ phase: 'done', result: r, best: r.ok ? Math.max(doc.best, r.cm) : doc.best });
        log(r.ok ? `🏆 ${r.cm} cm` : `No score: ${r.note.toLowerCase()}`);
        announce(r.ok ? `The tower stands at ${r.cm} centimetres` : `No score. ${r.note}`);
      }
    } else if (doc.phase === 'lobby') { $('time').textContent = `${doc.mins}:00`; $('clock').classList.remove('low'); }
  }
  setInterval(tick, 250);

  function frame() {
    const h = Math.max(9, tallest(world) / CM + 2.5);
    view.insetTop = Math.min(view.h * 0.26, 280); view.insetBottom = 0;   // the header owns the top of the screen
    view.fit(-TABLE - 0.6, TABLE + 0.6, -1.4, h, 1.02);
    draw(view, world, { hands: world.hands || [], nameOf, big: true });
    $('bag').textContent = String(sticksLeft(world)).replace('.5', '½');
    $('height').textContent = `${tallest(world)} cm`;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ the phone */

async function phoneMain() {
  document.documentElement.classList.add('phone');
  $('phone').hidden = false;
  resize();
  const wait = $('wait');
  wait.hidden = false;

  const me = AhaRoom.join({
    askName: () => new Promise((resolve) => {
      const f = $('nameForm'); f.hidden = false; $('waitNote').textContent = 'Pick a name so the big screen can show whose hands are on the tower.';
      $('name').focus();
      f.addEventListener('submit', (e) => { e.preventDefault(); f.hidden = true; $('waitNote').textContent = 'Joining…'; resolve($('name').value); }, { once: true });
    }),
  });
  let doc = {}, holding = null, fitted = false;
  let toastT = 0;
  const toast = (s) => { const t = $('toast'); t.textContent = s; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 1800); };

  async function connect() {
    try {
      world = await AhaPhysics.join({ code: me.code, name: me.name, id: me.id });
      $('banner').hidden = true;
      world.on('close', () => { $('banner').hidden = false; if (builder.heldId) { builder.heldId = null; setHolding(null); } setTimeout(connect, 1500); });
      world.on('err', (e) => { if (e.of === 'add' && /already a body/.test(e.msg)) toast('Someone just took that one. Try again.'); });
    } catch (e) { $('banner').hidden = false; setTimeout(connect, 2000); }
  }
  me.on('welcome', () => { if (!world) connect(); });
  me.on('status', (s) => { $('banner').hidden = s === 'ok' || s === 'connecting'; });
  me.on('state', (d) => { doc = d; render(); });

  const builder = new Builder($('scene'), view, {
    world: () => world,
    canBuild: () => doc.phase === 'build',
    onChange: (id) => setHolding(id),
  });
  window.m2d = { view, world: () => world, builder, me };
  function setHolding(id) {
    holding = id;
    $('tools').hidden = !!id || doc.phase !== 'build';
    $('holding').hidden = !id;
    $('snap').hidden = !id || id === 'marsh' || /-[ab]$/.test(id);
  }

  $('fit').addEventListener('click', () => fitView());
  addEventListener('resize', () => fitView());
  $('ccw').addEventListener('click', () => builder.turnBy(Math.PI / 12));
  $('cw').addEventListener('click', () => builder.turnBy(-Math.PI / 12));
  $('back').addEventListener('click', async () => { const id = builder.heldId; await builder.letGo({ tape: false }); if (id) world.remove(id); toast('Back in the bag'); });
  $('snap').addEventListener('click', async () => {
    const id = builder.heldId, b = world.bodies.get(id); if (!b) return;
    await builder.letGo({ tape: false });
    const c = Math.cos(b.angle) * HALF / 2, s = Math.sin(b.angle) * HALF / 2;
    world.remove(id);
    await new Promise((r) => setTimeout(r, 60));
    world.add(stickBody(id + '-a', b.x - c, b.y - s, b.angle, HALF / 2)).catch(() => {});
    world.add(stickBody(id + '-b', b.x + c, b.y + s, b.angle, HALF / 2)).catch(() => {});
    toast('Snapped in half');
  });
  $('take').addEventListener('click', async () => {
    if (!world) return;
    const id = freeStickId(world);
    if (!id) return toast(sticksLeft(world) > 0 ? 'Only half sticks left on the table' : 'The bag is empty');
    const at = spawnSpot(world, view.cx, HALF);
    try { await world.add(stickBody(id, at.x, at.y ?? THICK + 0.01, 0)); toast('Your stick is on the table'); blip(600, 0.05); }
    catch (e) { toast('Could not take a stick. Try again.'); }
  });
  $('marsh').addEventListener('click', async () => {
    if (!world) return;
    if (world.bodies.has('marsh')) return toast('The marshmallow is already out');
    const at = spawnSpot(world, view.cx, MARSH);
    try { await world.add(marshBody(at.x, at.y ?? MARSH + 0.01)); toast('The marshmallow is out'); }
    catch (e) { toast('Someone just took it out'); }
  });

  function fitView() {
    view.insetTop = $('phone').querySelector('.bar').offsetHeight;
    // the toolbar may be hidden right now (the lobby), but it will be there while building
    view.insetBottom = Math.max($('tools').offsetHeight, $('holding').offsetHeight, 82);
    const h = world ? Math.max(5, tallest(world) / CM + 1.5) : 6;
    view.fit(-4.5, 4.5, -0.6, h, 1.04);                    // the middle of the table, where towers go
    // then sit the table on the toolbar rather than floating it mid-screen
    const bottom = view.toWorld(0, view.h - view.insetBottom).y;
    view.cy += -0.7 - bottom;
  }

  let lastPhase = null;
  function render() {
    const phase = doc.phase || 'lobby';
    wait.hidden = phase !== 'lobby' || !world;
    if (phase === 'lobby') $('waitNote').textContent = `You're in, ${me.name}. The round starts from the big screen.`;
    if (phase !== 'build' && builder.heldId) builder.letGo({ tape: phase === 'settle' });
    setHolding(builder.heldId);
    if (phase !== lastPhase) {
      if (phase === 'build') { announce('Build! Take a stick to start'); if (navigator.vibrate) navigator.vibrate(60); fitView(); }
      if (phase === 'settle') announce('Time! Hands off');
      if (phase === 'done') announce(doc.result?.ok ? `The tower stands at ${doc.result.cm} centimetres` : `No score. ${doc.result?.note || ''}`);
      lastPhase = phase;
    }
  }

  const bar = $('pstatus'), ptime = $('ptime');
  function frame() {
    if (world) {
      if (!fitted && view.w) { fitView(); fitted = true; }
      const targets = builder.heldId ? tapeTargets(world, builder.heldId) : [];
      draw(view, world, { hands: world.hands || [], mine: me.id, targets, nameOf: () => '' });
      const phase = doc.phase || 'lobby';
      if (phase === 'build') {
        const left = doc.endsAt - me.now();
        ptime.textContent = mmss(left); ptime.classList.toggle('low', left < 30000);
        bar.textContent = holding ? (targets.length ? `Let go to tape to ${targets.length} piece${targets.length > 1 ? 's' : ''}` : 'Touch an end to another stick')
          : `${String(sticksLeft(world)).replace('.5', '½')} sticks left · ${tallest(world)} cm`;
      } else if (phase === 'settle') { ptime.textContent = '0:00'; bar.textContent = 'Hands off! Will it stand?'; }
      else if (phase === 'done') { ptime.textContent = '0:00'; bar.textContent = doc.result?.ok ? `🏆 ${doc.result.cm} cm` : `No score: ${doc.result?.note || ''}`; }
      else { ptime.textContent = '–:––'; bar.textContent = 'Waiting for the host'; }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

(IS_PHONE ? phoneMain : hostMain)().catch((e) => { console.error(e); announce('Something went wrong. Reload the page.'); });

export { tapeTargets, measure, sticksLeft, stickBody, marshBody, SPEC, TAPE };
