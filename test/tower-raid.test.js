// Tower Raid rules: node --test test/tower-raid.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
await import('../public/js/tr-sim.js');
const TR = globalThis.TR;

const seeded = (s) => () => { s = (s * 16807) % 2147483647; return s / 2147483647; };

// Plays a whole game. Humans answer the quiz 4 s into each wave, right with probability `correct`.
function play({ total, humans = 0, correct = 0, seed = 1 }) {
  const S = TR.create({ rand: seeded(seed) });
  for (let i = 0; i < humans; i++) TR.addPlayer(S, 'h' + i, 'Human ' + i, false);
  TR.setBots(S, total);
  while (S.phase !== 'over') {
    TR.startWave(S);
    let t = 0;
    while (S.phase === 'wave') {
      const dt = 1 / 30; t += dt;
      for (let i = 0; i < humans; i++) {
        if (t > 4 && !S.raiders.get('h' + i).answered) TR.answer(S, 'h' + i, S.rand() < correct ? S.quiz.answer : (S.quiz.answer + 1) % 4);
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

test('a right answer grants a shield that soaks damage before HP; a wrong one costs HP; one answer per wave', () => {
  const S = TR.create({ rand: seeded(5) });
  TR.addPlayer(S, 'a', 'Ann');
  TR.startWave(S);
  assert.equal(TR.answer(S, 'a', (S.quiz.answer + 1) % 4), 'wrong');
  assert.equal(S.raiders.get('a').hp, S.rules.raiderHp - S.rules.wrongHp);
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

test('tower HP scales with the party and the game ends after the last wave', () => {
  const r = play({ total: 6, seed: 2 });
  assert.equal(r.wave, TR.RULES.waves);
  assert.equal(r.won, false);
  const S = TR.create({ rand: seeded(1) }); TR.setBots(S, 12); TR.startWave(S);
  assert.equal(S.tower.max, 12 * S.rules.towerHpPer);
});

test('difficulty: bots alone (random answers) never win and leave a good part of the tower standing', () => {
  for (const total of [4, 6, 8, 12]) for (let seed = 1; seed <= 4; seed++) {
    const r = play({ total, seed });
    assert.equal(r.won, false, `${total} bots seed ${seed}`);
    assert.ok(r.left > 0.15, `${total} bots seed ${seed} left ${r.left.toFixed(2)}`);
  }
});

test('difficulty: a party right three times out of four usually gets close and fails', () => {
  let wins = 0, left = 0;
  for (let seed = 1; seed <= 6; seed++) { const r = play({ total: 6, humans: 6, correct: 0.75, seed }); wins += r.won ? 1 : 0; left += r.left; }
  assert.ok(wins <= 2, `${wins} wins of 6`);
  assert.ok(left / 6 < 0.3 && left / 6 > 0.02, `avg left ${(left / 6).toFixed(2)}`);
});

test('difficulty: a party that answers everything right takes the tower, in the last wave', () => {
  for (let seed = 1; seed <= 4; seed++) {
    const r = play({ total: 6, humans: 6, correct: 1, seed });
    assert.equal(r.won, true, `seed ${seed} left ${r.left.toFixed(2)}`);
    assert.ok(r.wave >= TR.RULES.waves, `seed ${seed} won in wave ${r.wave}`);
  }
});

test('reaching the walls gives three swings and then the raider is done for the wave', () => {
  const S = TR.create({ rand: seeded(11), rules: { waveTime: 60 } });
  TR.addPlayer(S, 'a', 'Ann'); TR.startWave(S); S.defence = [];      // no towers: walk in untouched
  const r = S.raiders.get('a'); const strikes = [];
  for (let i = 0; i < 60 * 40 && r.state !== 'done'; i++) { TR.step(S, 1 / 60); strikes.push(...TR.takeEvents(S).filter(e => e.e === 'strike')); }
  assert.equal(r.state, 'done');
  assert.equal(strikes.length, S.rules.strikes);
  assert.equal(strikes.reduce((a, e) => a + e.dmg, 0), r.dmg);
  assert.ok(r.dmg > 0);
});

test('a wave step with 12 raiders and 8 towers is cheap', () => {
  const S = TR.create({ rand: seeded(9) }); TR.setBots(S, 12); S.wave = TR.RULES.waves - 1; TR.startWave(S);
  const t0 = performance.now();
  for (let i = 0; i < 6000; i++) { TR.step(S, 1 / 60); TR.snapshot(S); TR.takeEvents(S); if (S.phase !== 'wave') { S.phase = 'between'; S.wave = TR.RULES.waves - 1; TR.startWave(S); } }
  const per = (performance.now() - t0) / 6000;
  assert.ok(per < 0.5, `${per.toFixed(3)} ms per step+snapshot`);
});
