// aha-room SDK on the memory transport: node --test test/aha-room.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AhaRoom, RoomConflict } from '../public/js/aha-room.js';

const wait = ms => new Promise(r => setTimeout(r, ms));

async function setup(names = ['A']) {
  const hub = AhaRoom.memory();
  const room = await AhaRoom.host({ transport: hub, page: '/test-game' });
  const mes = names.map(n => AhaRoom.join({ transport: hub, name: n }));
  await hub.settle();
  return { hub, room, mes, me: mes[0] };
}

test('a phone joins, is welcomed, and gets the document in its first snapshot', async () => {
  const hub = AhaRoom.memory();
  const room = await AhaRoom.host({ transport: hub, page: '/test-game' });
  room.state.set({ phase: 'lobby', q: 'Ready?' });
  await hub.settle();
  const joins = [];
  room.on('join', j => joins.push(j));
  const me = AhaRoom.join({ transport: hub, name: 'Chau' });
  const states = [];
  me.on('state', (doc, mine) => states.push({ doc: JSON.parse(JSON.stringify(doc)), mine: JSON.parse(JSON.stringify(mine)) }));
  await hub.settle();
  assert.equal(me.name, 'Chau');
  assert.ok(me.id.startsWith('p'));
  assert.deepEqual(joins.map(j => [j.name, j.rejoin]), [['Chau', false]]);
  assert.equal(states[0].doc.phase, 'lobby');
  assert.equal(states[0].doc.q, 'Ready?');
  assert.equal(me.status, 'ok');
});

test('patches are coalesced and versioned; phones render the merged document', async () => {
  const { hub, room, me } = await setup();
  const seen = [];
  me.on('state', doc => seen.push(JSON.stringify(doc)));
  room.state.set({ phase: 'ask', n: 1 });
  room.state.set({ n: 2, endsAt: 123 });          // same turn: one patch
  await hub.settle();
  assert.equal(seen.length, 1);
  assert.deepEqual(me.state.get().n, 2);
  assert.equal(me.state.get().endsAt, 123);
  room.state.set({ endsAt: null });                // null deletes
  await hub.settle();
  assert.equal('endsAt' in me.state.get(), false);
  assert.equal(room.state.get().phase, 'ask');
});

test('private slices reach only their player', async () => {
  const { hub, room, mes } = await setup(['A', 'B']);
  const [a, b] = mes;
  room.state.setFor(a.id, { right: true, pts: 100 });
  room.state.setFor(b.id, { right: false });
  await hub.settle();
  assert.deepEqual(a.state.mine(), { right: true, pts: 100 });
  assert.deepEqual(b.state.mine(), { right: false });
  assert.deepEqual(room.state.getFor(a.id), { right: true, pts: 100 });
  assert.equal(JSON.stringify(a.state.get()).includes('pts'), false, 'private data never lands in the shared document');
});

test('a phone that misses a patch resyncs from a snapshot', async () => {
  const { hub, room, me } = await setup();
  room.state.set({ n: 1 }); await hub.settle();
  hub.lose(1);                                     // the next host→phone message vanishes
  room.state.set({ n: 2 }); await hub.settle();
  assert.equal(me.state.get().n, 1, 'the lost patch is not applied');
  room.state.set({ n: 3 }); await hub.settle();    // the gap is noticed here…
  await hub.settle();                              // …and the snapshot answers the resync
  assert.equal(me.state.get().n, 3);
});

test('presence: seats, online flags, players event, and the _players slice on phones', async () => {
  const { hub, room, mes } = await setup(['A', 'B', 'C']);
  const [a, b] = mes;
  const lists = [];
  room.on('players', l => lists.push(l.map(p => [p.name, p.online, p.seat])));
  assert.deepEqual(room.count(), { total: 3, online: 3 });
  assert.deepEqual([...room.players.values()].map(p => p.seat), [0, 1, 2]);
  assert.deepEqual(a.state.get()._players, { total: 3, online: 3, names: ['A', 'B', 'C'] });
  let leaves = 0; room.on('leave', () => leaves++);
  hub.drop(b); await hub.settle();
  assert.equal(leaves, 1);
  assert.deepEqual(room.count(), { total: 3, online: 2 });
  assert.equal(room.players.get(b.id).online, false);
  assert.equal(room.players.get(b.id).seat, 1, 'the seat is kept while offline');
  assert.equal(a.state.get()._players.online, 2);
  hub.rejoin(b); await hub.settle();
  assert.equal(room.players.get(b.id).online, true);
  assert.equal(room.players.get(b.id).seat, 1, 'and reclaimed on return');
  assert.equal(lists.length >= 2, true);
});

test('phones arriving before the host wait, then get the roster replayed to the host and a snapshot each', async () => {
  const hub = AhaRoom.memory();
  const me = AhaRoom.join({ transport: hub, name: 'Early' });
  const statuses = []; me.on('status', s => statuses.push(s));
  await hub.settle();
  assert.ok(statuses.includes('waiting-for-host'));
  const room = await AhaRoom.host({ transport: hub, page: '/test-game' });
  const joins = []; room.on('join', j => joins.push(j));
  room.state.set({ phase: 'lobby' });
  await hub.settle();
  assert.equal(joins.length, 0, 'a replayed roster is not a fresh join');
  assert.deepEqual(room.count(), { total: 1, online: 1 });
  assert.equal(me.state.get().phase, 'lobby');
  assert.equal(me.status, 'ok');
});

test('game messages flow both ways with the sender id stamped; reserved types are refused', async () => {
  const { hub, room, me } = await setup();
  const got = []; room.on('msg', m => got.push(m));
  const mine = []; me.on('msg', m => mine.push(m));
  me.send({ t: 'answer', i: 2 });
  me.send({ t: '_snap', doc: { hacked: true } });   // a phone cannot forge SDK messages
  room.send({ t: 'hit', n: 12 });
  room.sendTo(me.id, { t: 'quiz', q: 'x' });
  await hub.settle();
  assert.deepEqual(got, [{ t: 'answer', i: 2, id: me.id }]);
  assert.deepEqual(mine.map(m => m.t), ['hit', 'quiz']);
  assert.equal(me.state.get().hacked, undefined);
});

test('input helper batches samples into one message per interval with quantised numbers and a clock', async () => {
  const { hub, room, me } = await setup();
  const got = []; room.on('msg', m => got.push(m));
  const pts = me.input('stroke', { every: 30, quantise: 100 });
  pts.start({ s: 7 });
  pts.push([0.123, 0.456, 0.5]);
  pts.push([0.2, 0.4, 0.5]);
  await wait(45);
  pts.push([0.3, 0.3, 0.5]);
  pts.stop();
  await hub.settle();
  assert.equal(got.length, 2);
  assert.equal(got[0].t, 'stroke'); assert.equal(got[0].s, 7); assert.equal(got[0].q, 100);
  assert.deepEqual(got[0].pts.map(p => p.slice(0, 3)), [[12, 46, 50], [20, 40, 50]]);
  assert.ok(got[0].pts.every(p => p.length === 4 && p[3] >= 0), 'each sample carries ms since start');
  assert.equal(got[1].pts.length, 1);
});

test('tick: the host samples at a rate and the phone receives them', async () => {
  const { hub, room, me } = await setup();
  let x = 0;
  const t = room.tick('pos', 50, () => [['p1', x += 10, 0]]);
  const samples = []; me.tick('pos', { interpolate: [1] }).on('sample', s => samples.push(s));
  await wait(120); t.stop(); await hub.settle();
  assert.ok(samples.length >= 3, 'got ' + samples.length);
  assert.deepEqual(samples[0][0][0], 'p1');
});

test('the phone clock follows the host clock', async () => {
  const { me } = await setup();
  assert.ok(Math.abs(me.now() - Date.now()) < 50);
});

test('RoomConflict carries who holds the code', () => {
  const e = new RoomConflict({ code: 'ABCD', heldBy: '/survival-quiz', since: 1 });
  assert.equal(e instanceof Error, true);
  assert.equal(e.code, 'ABCD'); assert.equal(e.heldBy, '/survival-quiz');
});

test('a document over 16 KB is warned about, not blocked', async () => {
  const { hub, room, me } = await setup();
  const warnings = []; const orig = console.warn; console.warn = (...a) => warnings.push(a.join(' '));
  try { room.state.set({ big: 'x'.repeat(17000) }); await hub.settle(); } finally { console.warn = orig; }
  assert.equal(me.state.get().big.length, 17000);
  assert.equal(warnings.length, 1);
});
