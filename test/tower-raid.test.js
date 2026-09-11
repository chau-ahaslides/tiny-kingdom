// Gremlin Siege rules: node --test test/tower-raid.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
await import('../public/js/tr-sim.js');
const TR = globalThis.TR;

const seeded = (s) => () => { s = (s * 16807) % 2147483647; return s / 2147483647; };

// Plays a whole game with bots answering right with probability `right`.
function play({ total, right, seed = 1, rules }) {
  const S = TR.create({ rand: seeded(seed), rules: Object.assign({ botRight: right }, rules) });
  TR.setBots(S, total);
  while (S.phase !== 'over') {
    TR.startWave(S);
    let t = 0;
    while (S.phase === 'wave' && t < 300) { TR.step(S, 1 / 30); TR.takeEvents(S); t += 1 / 30; }
    assert.ok(t < 300, 'a wave always ends');
  }
  return { survived: S.survived, won: S.won, guns: S.guns.length };
}

test('bots fill the party up to the requested size and are trimmed again', () => {
  const S = TR.create({ rand: seeded(3) });
  TR.addPlayer(S, 'a', 'Ann'); TR.addPlayer(S, 'b', 'Bob');
  TR.setBots(S, 6);
  assert.equal(S.players.size, 6);
  assert.equal([...S.players.values()].filter(r => r.bot).length, 4);
  TR.setBots(S, 3);
  assert.equal(S.players.size, 3);
  TR.setBots(S, 1);                         // never drops humans
  assert.equal(S.players.size, 2);
});

test('a right answer earns a gun to place; a streak makes it bigger; a wrong answer breaks the streak', () => {
  const S = TR.create({ rand: seeded(5) });
  TR.addPlayer(S, 'a', 'Ann');
  TR.startWave(S);
  assert.equal(TR.answer(S, 'a', S.quiz.answer), 'right');
  const p = S.players.get('a');
  assert.deepEqual(p.pending, { level: 0, wave: 1 });
  assert.equal(TR.answer(S, 'a', S.quiz.answer), 'dup');
  assert.equal(TR.place(S, 'a', 0, 1), 'taken', 'not on the road');
  assert.equal(TR.place(S, 'a', 5, 5), 'ok');
  assert.equal(TR.place(S, 'a', 5, 5), 'none', 'one gun per right answer');
  assert.equal(S.guns.length, 1); assert.equal(S.guns[0].owner, 'a'); assert.equal(S.guns[0].level, 0);
  TR.endWave(S); TR.startWave(S);
  assert.equal(TR.answer(S, 'a', S.quiz.answer), 'right');
  assert.equal(p.streak, 2); assert.equal(p.pending.level, 1, 'second in a row: bigger gun');
  assert.equal(TR.place(S, 'a', 5, 5), 'taken', 'that tile already has a gun');
  assert.equal(TR.place(S, 'a', 4, 4), 'ok');
  TR.endWave(S); TR.startWave(S);
  assert.equal(TR.answer(S, 'a', (S.quiz.answer + 1) % 4), 'wrong');
  assert.equal(p.streak, 0); assert.equal(p.pending, null);
  TR.endWave(S); TR.startWave(S);
  TR.answer(S, 'a', S.quiz.answer);
  assert.equal(p.pending.level, 0, 'back to a small gun after the streak broke');
  assert.equal(S.guns.length, 2, 'guns placed earlier stay');
});

test('the quiz closes after quizTime; an unanswered quiz breaks the streak too', () => {
  const S = TR.create({ rand: seeded(8), rules: { quizTime: 2 } });
  TR.addPlayer(S, 'a', 'Ann'); TR.startWave(S);
  for (let i = 0; i < 90; i++) TR.step(S, 1 / 30);
  assert.equal(TR.answer(S, 'a', S.quiz.answer), 'late');
  S.players.get('a').streak = 3; TR.endWave(S);
  assert.equal(S.players.get('a').streak, 0);
});

test('gremlins that reach the tower bite it; the game ends when it falls, counting waves survived', () => {
  const S = TR.create({ rand: seeded(2), rules: { towerHp: 3 } });
  TR.addPlayer(S, 'a', 'Ann'); TR.startWave(S);
  let reached = 0, t = 0;
  while (S.phase === 'wave' && t < 120) { TR.step(S, 1 / 30); t += 1 / 30; reached += TR.takeEvents(S).filter(e => e.e === 'reach').length; }
  assert.equal(S.phase, 'over'); assert.equal(S.won, false); assert.equal(S.survived, 0);
  assert.equal(reached, 3, 'three bites of one each');
});

test('a phone that drops mid-game keeps its score and guns and rejoins the next wave', () => {
  const S = TR.create({ rand: seeded(7) });
  TR.addPlayer(S, 'a', 'Ann'); TR.addPlayer(S, 'b', 'Bob');
  TR.startWave(S); TR.answer(S, 'a', S.quiz.answer); TR.place(S, 'a', 2, 2);
  S.players.get('a').kills = 4;
  TR.removePlayer(S, 'a');
  assert.ok(S.players.has('a'), 'kept during the game');
  TR.endWave(S); TR.startWave(S);
  TR.addPlayer(S, 'a', 'Ann');
  assert.equal(S.players.get('a').kills, 4); assert.equal(S.players.get('a').gone, false);
  assert.equal(S.guns.length, 1);
});

test('guns shoot the gremlin furthest down the road and credit kills to their owner', () => {
  const S = TR.create({ rand: seeded(4), rules: { quizTime: 0.1 } });
  TR.addPlayer(S, 'a', 'Ann'); TR.startWave(S);
  TR.answer(S, 'a', S.quiz.answer); S.players.get('a').pending.level = 2;
  const spot = [[1, 0], [2, 0], [1, 2], [2, 2], [4, 1]].find(([x, z]) => TR.freeTile(S, x, z));
  assert.equal(TR.place(S, 'a', spot[0], spot[1]), 'ok'); assert.equal(S.guns[0].type, 'turret', 'a level-2 gun is a turret');
  let kills = 0, t = 0;
  while (S.phase === 'wave' && t < 120) { TR.step(S, 1 / 30); t += 1 / 30; kills += TR.takeEvents(S).filter(e => e.e === 'die' && e.owner === 'a').length; }
  assert.ok(kills > 0, 'the turret by the first straight kills something');
  assert.equal(S.players.get('a').kills, kills);
  assert.ok(S.players.get('a').dmg > 0);
});

test('difficulty: a room that is right half the time rarely holds three waves', () => {
  for (const total of [6, 10, 16]) {
    let held3 = 0, sum = 0;
    for (let seed = 1; seed <= 12; seed++) { const r = play({ total, right: 0.5, seed }); sum += r.survived; if (r.survived >= 3) held3++; assert.equal(r.won, false); }
    assert.ok(sum / 12 >= 1.6 && sum / 12 <= 3.0, `${total} players: avg ${(sum / 12).toFixed(2)} waves`);
    assert.ok(held3 <= 9, `${total} players: ${held3} of 12 rooms held three waves`);
  }
});

test('difficulty: a room that is always right holds well past three waves but still falls', () => {
  for (let seed = 1; seed <= 4; seed++) { const r = play({ total: 8, right: 1, seed }); assert.ok(r.survived >= 4, `seed ${seed} survived ${r.survived}`); assert.equal(r.won, false); }
});

test('difficulty: a room that is mostly wrong falls in the first wave or two', () => {
  let sum = 0; for (let seed = 1; seed <= 6; seed++) sum += play({ total: 8, right: 0.25, seed }).survived;
  assert.ok(sum / 6 < 1.8, `avg ${(sum / 6).toFixed(2)}`);
});

test('a wave step with 40 guns and a big wave is cheap', () => {
  const S = TR.create({ rand: seeded(9), rules: { botRight: 1, botAnsMin: 0.1, botAnsMax: 0.2, botPlace: 0.1 } }); TR.setBots(S, 16);
  for (let w = 0; w < 3; w++) { TR.startWave(S); let t = 0; while (S.phase === 'wave' && t < 300) { TR.step(S, 1 / 30); TR.takeEvents(S); t += 1 / 30; } }
  assert.ok(S.guns.length >= 40, `${S.guns.length} guns`);
  S.phase = 'between'; TR.startWave(S);
  const t0 = performance.now();
  for (let i = 0; i < 3000; i++) { TR.step(S, 1 / 60); TR.snapshot(S); TR.takeEvents(S); if (S.phase !== 'wave') { S.phase = 'between'; TR.startWave(S); } }
  const per = (performance.now() - t0) / 3000;
  assert.ok(per < 0.6, `${per.toFixed(3)} ms per step+snapshot`);
});

test('god mode: from streak six a right answer refills every gun instead of adding one', () => {
  const S = TR.create({ rand: seeded(12), rules: { towerHp: 999 } });
  TR.addPlayer(S, 'a', 'Ann');
  for (let w = 1; w <= 5; w++) { TR.startWave(S); TR.answer(S, 'a', S.quiz.answer); const spot = [[2, 2], [4, 4], [7, 3], [8, 4], [10, 3]][w - 1]; assert.equal(TR.place(S, 'a', spot[0], spot[1]), 'ok'); TR.endWave(S); }
  assert.deepEqual(S.guns.map(g => g.type), ['ballista', 'cannon', 'turret', 'catapult', 'crystal']);
  S.guns.forEach((g, i) => { g.ammo = [5, 1, 9, 3, 7][i]; });
  TR.startWave(S);
  assert.equal(TR.answer(S, 'a', S.quiz.answer), 'god');
  assert.equal(S.players.get('a').pending, null, 'no gun to place');
  const ev = TR.takeEvents(S).find(e => e.e === 'god'); assert.equal(ev.streak, 6); assert.equal(ev.refilled, 2);
  assert.deepEqual(ev.guns.sort(), [1, 4], 'the two emptiest guns, by share of ammo left');
  assert.equal(S.guns[1].ammo, S.guns[1].max); assert.equal(S.guns[4].ammo, S.guns[4].max); assert.equal(S.guns[0].ammo, 5, 'the others untouched');
  TR.endWave(S); TR.startWave(S);
  assert.equal(TR.answer(S, 'a', S.quiz.answer), 'god', 'and every right answer after that');
  assert.equal(TR.takeEvents(S).find(e => e.e === 'god').refilled, 3, 'streak 7 refills three');
});
