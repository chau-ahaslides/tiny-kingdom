// Tower Raid rules: node --test test/tower-raid.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
await import('../public/js/tr-sim.js');
const TR = globalThis.TR;

const seeded = (s) => () => { s = (s * 16807) % 2147483647; return s / 2147483647; };

// Plays a whole game. Humans tap at `rate` per second and answer the quiz 5 s into each wave, right with probability `correct`.
function play({ total, humans = 0, rate = 0, correct = 0, seed = 1 }) {
  const S = TR.create({ rand: seeded(seed) });
  for (let i = 0; i < humans; i++) TR.addPlayer(S, 'h' + i, 'Human ' + i, false);
  TR.setBots(S, total);
  while (S.phase !== 'over') {
    TR.startWave(S);
    let t = 0;
    while (S.phase === 'wave') {
      const dt = 1 / 30; t += dt;
      for (let i = 0; i < humans; i++) {
        if (t > 5 && !S.raiders.get('h' + i).answered) TR.answer(S, 'h' + i, S.rand() < correct ? S.quiz.answer : (S.quiz.answer + 1) % 4);
        if (Math.floor(t * rate) !== Math.floor((t - dt) * rate)) TR.tap(S, 'h' + i, 1);
      }
      TR.step(S, dt); TR.takeEvents(S);
    }
  }
  return { won: S.won, left: S.tower.hp / S.tower.max, wave: S.wave };
}

test('bots fill the party up to the requested size and are trimmed again', () => {
  const S = TR.create({ rand: seeded(3) });
  TR.addPlayer(S, 'a', 'Ann'); TR.addPlayer(S, 'b', 'Bob');
  TR.setBots(S, 6);
  assert.equal(S.raiders.size, 6);
  assert.equal([...S.raiders.values()].filter(r => r.bot).length, 4);
  TR.setBots(S, 3);
  assert.equal(S.raiders.size, 3);
  TR.setBots(S, 1);                         // never drops humans
  assert.equal(S.raiders.size, 2);
});

test('a right answer grants a shield that soaks damage before HP; one answer per wave', () => {
  const S = TR.create({ rand: seeded(5) });
  TR.addPlayer(S, 'a', 'Ann');
  TR.startWave(S);
  assert.equal(TR.answer(S, 'a', (S.quiz.answer + 1) % 4), 'wrong');
  assert.equal(TR.answer(S, 'a', S.quiz.answer), 'dup');
  const S2 = TR.create({ rand: seeded(5) });
  TR.addPlayer(S2, 'a', 'Ann'); TR.startWave(S2);
  assert.equal(TR.answer(S2, 'a', S2.quiz.answer), 'right');
  const r = S2.raiders.get('a');
  assert.equal(r.shield, S2.rules.shield);
  // Run into the defence and watch the shield go first.
  let ticks = 0;
  while (r.shield === S2.rules.shield && ticks++ < 3000) TR.step(S2, 1 / 30);
  assert.ok(r.shield < S2.rules.shield, 'shield took the first hit');
  assert.equal(r.hp, S2.rules.raiderHp, 'HP untouched while the shield holds');
});

test('a phone that drops mid-game keeps its score and rejoins the next wave', () => {
  const S = TR.create({ rand: seeded(7) });
  TR.addPlayer(S, 'a', 'Ann'); TR.addPlayer(S, 'b', 'Bob');
  TR.startWave(S);
  S.raiders.get('a').dmg = 42;
  TR.removePlayer(S, 'a');
  assert.ok(S.raiders.has('a'), 'kept during the game');
  TR.endWave(S); TR.startWave(S);
  assert.equal(S.raiders.get('a').state, 'wait', 'sits out while gone');
  TR.addPlayer(S, 'a', 'Ann');
  assert.equal(S.raiders.get('a').dmg, 42);
  assert.equal(S.raiders.get('a').gone, false);
});

test('tower HP scales with the party and the game ends after five waves', () => {
  const r = play({ total: 6, seed: 2 });
  assert.equal(r.wave, 5);
  assert.equal(r.won, false);
  const S = TR.create({ rand: seeded(1) }); TR.setBots(S, 12); TR.startWave(S);
  assert.equal(S.tower.max, 12 * S.rules.towerHpPer);
});

test('difficulty: bots alone never win and leave most of the tower standing', () => {
  for (const total of [4, 6, 8, 12]) for (let seed = 1; seed <= 4; seed++) {
    const r = play({ total, seed });
    assert.equal(r.won, false, `${total} bots seed ${seed}`);
    assert.ok(r.left > 0.4, `${total} bots seed ${seed} left ${r.left.toFixed(2)}`);
  }
});

test('difficulty: decent players (5 taps/s at the walls, 90% quiz) get close but do not take the tower in five waves', () => {
  for (let seed = 1; seed <= 4; seed++) {
    const r = play({ total: 6, humans: 6, rate: 5, correct: 0.9, seed });
    assert.equal(r.won, false, `seed ${seed}`);
    assert.ok(r.left < 0.35 && r.left > 0.03, `seed ${seed} left ${r.left.toFixed(2)}`);
  }
});

test('difficulty: a perfect party (7 taps/s, every answer right) can just about take it', () => {
  let best = 1;
  for (let seed = 1; seed <= 4; seed++) { const r = play({ total: 8, humans: 8, rate: 7, correct: 1, seed }); best = Math.min(best, r.left); }
  assert.ok(best < 0.06, `best perfect run left ${best.toFixed(2)}`);
});

test('a wave step with 12 raiders and 6 towers is cheap', () => {
  const S = TR.create({ rand: seeded(9) }); TR.setBots(S, 12); S.wave = 4; TR.startWave(S);
  const t0 = performance.now();
  for (let i = 0; i < 6000; i++) { TR.step(S, 1 / 60); TR.snapshot(S); TR.takeEvents(S); if (S.phase !== 'wave') { TR.startWave(S); } }
  const per = (performance.now() - t0) / 6000;
  assert.ok(per < 0.5, `${per.toFixed(3)} ms per step+snapshot`);
});
