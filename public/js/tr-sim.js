/* Tower Raid — the game rules, with no rendering in them.
   The big screen runs this and streams snapshots to the phones; test/tower-raid.test.js runs it in node to tune the numbers.
   Units: tiles and seconds. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.TR = factory();          // browsers, and node ESM (read it back from globalThis.TR)
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // ------------------------------------------------------------ board
  const COLS = 12, ROWS = 8;
  const PATH = [[0, 1], [1, 1], [2, 1], [3, 1], [3, 2], [3, 3], [3, 4], [2, 4], [1, 4], [1, 5], [1, 6], [2, 6], [3, 6], [4, 6], [5, 6], [6, 6], [6, 5], [6, 4], [6, 3], [6, 2], [7, 2], [8, 2], [9, 2], [9, 3], [9, 4], [9, 5], [10, 5], [11, 5]];
  const SEG = []; let total = 0;
  for (let i = 0; i < PATH.length - 1; i++) { const dx = PATH[i + 1][0] - PATH[i][0], dz = PATH[i + 1][1] - PATH[i][1]; const l = Math.hypot(dx, dz); SEG.push({ ax: PATH[i][0], az: PATH[i][1], dx: dx / l, dz: dz / l, start: total, len: l }); total += l; }
  const PATH_LEN = total;
  // Position and heading along the road; `side` is a lateral offset so raiders do not stack on one line.
  function posAt(d, side) {
    d = Math.max(0, Math.min(PATH_LEN, d));
    let s = SEG[SEG.length - 1];
    for (const seg of SEG) if (d <= seg.start + seg.len) { s = seg; break; }
    const k = d - s.start;
    return { x: s.ax + s.dx * k - s.dz * (side || 0), z: s.az + s.dz * k + s.dx * (side || 0), yaw: Math.atan2(s.dx, s.dz) };
  }

  // ------------------------------------------------------------ numbers to tune
  const RULES = {
    waves: 5,
    waveTime: 60,          // seconds before the defenders regroup and the wave is called off
    towerHpPer: 220,       // tower HP per raider (humans + bots), so a bigger party faces a bigger tower
    towerHpMin: 900,
    towerRegen: 0.02,      // share of max HP the tower repairs between waves
    raiderHp: 100,
    shield: 70,            // damage a correct quiz answer soaks up
    baseSpeed: 0.55,       // tiles per second when nobody taps
    tapSpeed: 0.16,        // extra tiles per second per tap-per-second, capped
    maxTapRate: 5,
    hitDmg: 1,             // tower damage per tap while at the walls
    autoHitRate: 1.0,      // idle hits per second while at the walls
    attackRange: 1.35,     // distance from the road's end where raiders stop and swing
    stopAtEnd: 1.0,        // path distance from the end where raiders stand
    quizBotCorrect: 0.55,
  };

  // Defence towers per wave: spot, type, level. Later waves add towers and upgrade earlier ones.
  const DEFENCE = [
    [['cannon', 11, 6, 1], ['ballista', 2, 2, 0]],
    [['cannon', 11, 6, 1], ['ballista', 2, 2, 0], ['turret', 5, 5, 0]],
    [['cannon', 11, 6, 1], ['ballista', 2, 2, 0], ['turret', 5, 5, 0], ['ballista', 7, 3, 0]],
    [['cannon', 11, 6, 1], ['ballista', 2, 2, 1], ['turret', 5, 5, 0], ['ballista', 7, 3, 0], ['cannon', 8, 4, 0]],
    [['cannon', 11, 6, 1], ['ballista', 2, 2, 1], ['turret', 5, 5, 1], ['ballista', 7, 3, 1], ['cannon', 8, 4, 0], ['turret', 2, 5, 0]],
  ];
  const TOWERS = {
    ballista: { ammoSpeed: 9, splash: 0, levels: [{ dmg: 8, range: 2.4, reload: 1.1 }, { dmg: 11, range: 2.6, reload: 1.0 }, { dmg: 15, range: 2.8, reload: 0.9 }] },
    cannon: { ammoSpeed: 6, splash: 0.9, levels: [{ dmg: 14, range: 2.2, reload: 2.2 }, { dmg: 24, range: 2.3, reload: 2.0 }, { dmg: 32, range: 2.3, reload: 1.6 }] },
    turret: { ammoSpeed: 14, splash: 0, levels: [{ dmg: 2, range: 2.1, reload: 0.25 }, { dmg: 3, range: 2.3, reload: 0.22 }, { dmg: 4, range: 2.5, reload: 0.2 }] },
  };

  const QUIZ = [
    ['How many legs does a spider have?', ['6', '8', '10', '12'], 1],
    ['Which planet is closest to the Sun?', ['Venus', 'Mars', 'Mercury', 'Earth'], 2],
    ['What is the capital of Australia?', ['Sydney', 'Canberra', 'Melbourne', 'Perth'], 1],
    ['How many minutes are in a day?', ['1,440', '1,240', '1,640', '2,400'], 0],
    ['Which gas do plants take in?', ['Oxygen', 'Nitrogen', 'Carbon dioxide', 'Helium'], 2],
    ['What is 15 × 4?', ['45', '50', '60', '75'], 2],
    ['The Great Wall is in which country?', ['Japan', 'China', 'India', 'Korea'], 1],
    ['How many strings does a standard guitar have?', ['4', '5', '6', '7'], 2],
    ['Which is the largest ocean?', ['Atlantic', 'Indian', 'Arctic', 'Pacific'], 3],
    ['Water boils at what temperature in °C?', ['90', '100', '110', '120'], 1],
    ['Which animal is the tallest?', ['Elephant', 'Giraffe', 'Camel', 'Moose'], 1],
    ['What colour do you get mixing blue and yellow?', ['Purple', 'Orange', 'Green', 'Brown'], 2],
    ['How many continents are there?', ['5', '6', '7', '8'], 2],
    ['Which is a prime number?', ['21', '27', '29', '33'], 2],
    ['What is the hardest natural material?', ['Steel', 'Diamond', 'Quartz', 'Granite'], 1],
    ['Which language has the most native speakers?', ['English', 'Hindi', 'Spanish', 'Mandarin'], 3],
    ['How many sides does a hexagon have?', ['5', '6', '7', '8'], 1],
    ['Which organ pumps blood?', ['Lungs', 'Liver', 'Heart', 'Kidney'], 2],
    ['What is the square root of 144?', ['10', '11', '12', '14'], 2],
    ['Which country hosts the Eiffel Tower?', ['Italy', 'Spain', 'France', 'Belgium'], 2],
    ['What is frozen water called?', ['Steam', 'Ice', 'Dew', 'Frost'], 1],
    ['How many players are on a football (soccer) side?', ['9', '10', '11', '12'], 2],
    ['Which is the smallest planet?', ['Mars', 'Mercury', 'Pluto', 'Venus'], 1],
    ['What is 7 × 8?', ['54', '56', '58', '64'], 1],
    ['Which metal is liquid at room temperature?', ['Iron', 'Mercury', 'Tin', 'Zinc'], 1],
    ['Which is the longest river?', ['Amazon', 'Nile', 'Yangtze', 'Mississippi'], 1],
    ['How many bones are in an adult human body?', ['106', '186', '206', '306'], 2],
    ['Which fruit is known for its potassium?', ['Apple', 'Banana', 'Grape', 'Cherry'], 1],
    ['What is the currency of Japan?', ['Yuan', 'Won', 'Yen', 'Baht'], 2],
    ['Which shape has three sides?', ['Square', 'Triangle', 'Circle', 'Pentagon'], 1],
    ['How many hours are in a week?', ['144', '168', '172', '196'], 1],
    ['Which sea creature has eight arms?', ['Squid', 'Octopus', 'Crab', 'Starfish'], 1],
  ];
  const BOT_NAMES = ['Ava Bot', 'Bao Bot', 'Cleo Bot', 'Dex Bot', 'Eli Bot', 'Fin Bot', 'Gia Bot', 'Hugo Bot', 'Ivy Bot', 'Jax Bot', 'Kai Bot', 'Lou Bot', 'Mia Bot', 'Nox Bot', 'Oli Bot', 'Pip Bot'];

  // ------------------------------------------------------------ state
  function create(opts) {
    const rules = Object.assign({}, RULES, opts && opts.rules);
    return {
      rules, rand: (opts && opts.rand) || Math.random,
      phase: 'lobby', wave: 0, time: 0, timeLeft: 0,
      tower: { hp: rules.towerHpMin, max: rules.towerHpMin },
      raiders: new Map(), order: [], defence: [], shots: [], quiz: null, events: [], seq: 0,
      won: null, lastQuiz: -1,
    };
  }
  function addPlayer(S, id, name, bot) {
    if (S.raiders.has(id)) { S.raiders.get(id).name = name || S.raiders.get(id).name; S.raiders.get(id).gone = false; return S.raiders.get(id); }
    const r = { id, name: name || 'Raider', bot: !!bot, skin: S.order.length % 12, d: 0, side: 0, hp: 0, shield: 0, state: 'wait', taps: 0, rate: 0, dmg: 0, kills: 0, reached: 0, answered: false, correct: 0, gone: false, swing: 0, bot_t: 0, bot_rate: 0, bot_ans: 0 };
    S.raiders.set(id, r); S.order.push(id);
    return r;
  }
  function removePlayer(S, id) {
    const r = S.raiders.get(id); if (!r) return;
    if (S.phase === 'lobby') { S.raiders.delete(id); S.order = S.order.filter(x => x !== id); }
    else r.gone = true;                                      // keep the score; the phone may come back
  }
  function setBots(S, totalPlayers) {
    // Fill (or trim) bots so that humans + bots === totalPlayers. Only in the lobby.
    if (S.phase !== 'lobby') return;
    const humans = [...S.raiders.values()].filter(r => !r.bot);
    const bots = [...S.raiders.values()].filter(r => r.bot);
    let want = Math.max(0, totalPlayers - humans.length);
    while (bots.length > want) { const b = bots.pop(); S.raiders.delete(b.id); S.order = S.order.filter(x => x !== b.id); }
    let n = 0;
    while (bots.length < want) { const name = BOT_NAMES[(bots.length + n++) % BOT_NAMES.length]; if ([...S.raiders.values()].some(r => r.name === name)) continue; bots.push(addPlayer(S, 'bot' + bots.length + '_' + Math.floor(S.rand() * 1e6), name, true)); }
  }

  // ------------------------------------------------------------ waves
  function startWave(S) {
    if (S.phase === 'over' || S.wave >= S.rules.waves) return false;
    if (S.wave === 0) { const n = [...S.raiders.values()].filter(r => !r.gone).length; S.tower.max = S.tower.hp = Math.max(S.rules.towerHpMin, Math.round(S.rules.towerHpPer * n)); }
    S.wave++; S.phase = 'wave'; S.timeLeft = S.rules.waveTime; S.shots = [];
    S.defence = DEFENCE[Math.min(S.wave, DEFENCE.length) - 1].map(([type, x, z, level], i) => ({ i, type, x, z, level, cool: S.rand() * 0.5, yaw: 0, target: null }));
    let qi; do { qi = Math.floor(S.rand() * QUIZ.length); } while (qi === S.lastQuiz);
    S.lastQuiz = qi; S.quiz = { i: qi, q: QUIZ[qi][0], opts: QUIZ[qi][1], answer: QUIZ[qi][2] };
    let n = 0;
    for (const id of S.order) {
      const r = S.raiders.get(id);
      if (r.gone && !r.bot) { r.state = 'wait'; continue; }
      r.hp = S.rules.raiderHp; r.state = 'run'; r.answered = false; r.taps = 0; r.rate = 0; r.swing = 0;
      r.d = -0.4 - (n % 4) * 0.35; r.side = ((n % 3) - 1) * 0.28;
      if (r.bot) { r.bot_rate = 2.5 + S.rand() * 2.5; r.bot_t = S.rand(); r.bot_ans = 3 + S.rand() * 10; }
      n++;
    }
    S.events.push({ e: 'wave', wave: S.wave });
    return true;
  }
  function endWave(S) {
    S.phase = S.wave >= S.rules.waves ? 'over' : 'between';
    for (const r of S.raiders.values()) if (r.state !== 'dead') r.state = 'wait';
    S.shots = [];
    if (S.phase === 'over') { S.won = false; S.events.push({ e: 'over', won: false }); }
    else { S.tower.hp = Math.min(S.tower.max, S.tower.hp + S.tower.max * S.rules.towerRegen); S.events.push({ e: 'waveEnd', wave: S.wave }); }
  }
  function towerDown(S) { S.phase = 'over'; S.won = true; S.tower.hp = 0; S.events.push({ e: 'over', won: true }); }

  // ------------------------------------------------------------ inputs
  function tap(S, id, n) { const r = S.raiders.get(id); if (!r || S.phase !== 'wave' || r.state === 'dead' || r.state === 'wait') return; r.taps += Math.max(1, Math.min(20, n | 0 || 1)); }
  function answer(S, id, i) {
    const r = S.raiders.get(id); if (!r || !S.quiz || S.phase !== 'wave') return 'late';
    if (r.answered) return 'dup';
    r.answered = true;
    if (i === S.quiz.answer) { r.correct++; r.shield = S.rules.shield; S.events.push({ e: 'shield', id }); return 'right'; }
    return 'wrong';
  }

  // ------------------------------------------------------------ simulation
  function damage(S, r, dmg, byId) {
    if (r.state === 'dead' || r.state === 'wait') return;
    if (r.shield > 0) { const s = Math.min(r.shield, dmg); r.shield -= s; dmg -= s; }
    r.hp -= dmg;
    S.events.push({ e: 'hit', id: r.id, dmg });
    if (r.hp <= 0) { r.hp = 0; r.state = 'dead'; S.events.push({ e: 'die', id: r.id }); }
  }
  function step(S, dt) {
    if (S.phase !== 'wave') return;
    S.time += dt; S.timeLeft -= dt; S.seq++;
    const R = S.rules;
    const endD = PATH_LEN - R.stopAtEnd;
    // Raiders
    for (const r of S.raiders.values()) {
      if (r.state !== 'run' && r.state !== 'attack') continue;
      if (r.bot) {                                            // bots mash in bursts and answer the quiz eventually
        r.bot_t -= dt;
        if (r.bot_t <= 0) { r.taps += Math.round(r.bot_rate * 0.25); r.bot_t = 0.25; if (S.rand() < 0.03) r.bot_rate = 1.5 + S.rand() * 3.5; }
        if (!r.answered) { r.bot_ans -= dt; if (r.bot_ans <= 0) answer(S, r.id, S.rand() < R.quizBotCorrect ? S.quiz.answer : (S.quiz.answer + 1) % 4); }
      }
      // Tap rate: taps accumulated this tick feed a decaying rate.
      r.rate += r.taps; r.taps = 0;
      r.rate *= Math.exp(-dt * 1.6);
      const rate = Math.min(R.maxTapRate, r.rate * 1.6);
      if (r.state === 'run') {
        r.d += (R.baseSpeed + rate * R.tapSpeed) * dt;
        if (r.d >= endD) { r.d = endD; r.state = 'attack'; r.reached++; S.events.push({ e: 'reach', id: r.id }); }
      } else {
        // At the walls: every tap is a swing, and idle raiders still swing slowly.
        r.swing += dt * R.autoHitRate + rate * dt * 1.0;
        while (r.swing >= 1) { r.swing -= 1; r.dmg += R.hitDmg; S.tower.hp -= R.hitDmg; S.events.push({ e: 'towerhit', id: r.id }); if (S.tower.hp <= 0) return towerDown(S); }
      }
    }
    // Defence towers pick the raider furthest along the road in range and shoot.
    for (const t of S.defence) {
      const def = TOWERS[t.type], st = def.levels[t.level];
      t.cool -= dt;
      let best = null, bestD = -1;
      for (const r of S.raiders.values()) {
        if (r.state !== 'run' && r.state !== 'attack') continue;
        const p = posAt(r.d, r.side); const dx = p.x - t.x, dz = p.z - t.z;
        if (dx * dx + dz * dz <= st.range * st.range && r.d > bestD) { best = r; bestD = r.d; }
      }
      t.target = best ? best.id : null;
      if (best) {
        const p = posAt(best.d, best.side);
        t.yaw = Math.atan2(p.x - t.x, p.z - t.z);
        if (t.cool <= 0) {
          t.cool = st.reload;
          const dist = Math.hypot(p.x - t.x, p.z - t.z);
          S.shots.push({ id: S.seq + ':' + t.i, tower: t.i, target: best.id, dmg: st.dmg, splash: def.splash, t: 0, dur: Math.max(0.08, dist / def.ammoSpeed), ax: p.x, az: p.z });
          S.events.push({ e: 'shot', tower: t.i, target: best.id, dur: Math.max(0.08, dist / def.ammoSpeed), splash: def.splash });
        }
      }
    }
    // Shots land after their flight time.
    S.shots = S.shots.filter(s => {
      s.t += dt; if (s.t < s.dur) return true;
      const tgt = S.raiders.get(s.target);
      if (s.splash > 0) {
        const p = tgt && tgt.state !== 'wait' ? posAt(tgt.d, tgt.side) : { x: s.ax, z: s.az };
        S.events.push({ e: 'boom', x: p.x, z: p.z, r: s.splash });
        for (const r of S.raiders.values()) { if (r.state !== 'run' && r.state !== 'attack') continue; const q = posAt(r.d, r.side); if (Math.hypot(q.x - p.x, q.z - p.z) <= s.splash + 0.3) damage(S, r, s.dmg); }
      } else if (tgt) damage(S, tgt, s.dmg);
      return false;
    });
    if (S.phase !== 'wave') return;
    const alive = [...S.raiders.values()].some(r => r.state === 'run' || r.state === 'attack');
    if (!alive || S.timeLeft <= 0) endWave(S);
  }

  // ------------------------------------------------------------ output
  function snapshot(S) {
    const a = [];
    for (const id of S.order) {
      const r = S.raiders.get(id);
      const p = posAt(r.d, r.side);
      a.push([id, +r.d.toFixed(2), Math.round(r.hp), Math.round(r.shield), r.state, +p.x.toFixed(2), +p.z.toFixed(2), +p.yaw.toFixed(2), r.rate > 0.3 ? 1 : 0]);
    }
    return { t: 's', ph: S.phase, w: S.wave, th: Math.round(S.tower.hp), tm: S.tower.max, tl: Math.ceil(S.timeLeft), a, dy: S.defence.map(t => +t.yaw.toFixed(2)) };
  }
  function roster(S) {
    return [...S.order].map(id => { const r = S.raiders.get(id); return { id, name: r.name, bot: r.bot, skin: r.skin, dmg: r.dmg, reached: r.reached, correct: r.correct, gone: r.gone }; });
  }
  function takeEvents(S) { const ev = S.events; S.events = []; return ev; }

  return { COLS, ROWS, PATH, PATH_LEN, posAt, RULES, DEFENCE, TOWERS, QUIZ, create, addPlayer, removePlayer, setBots, startWave, endWave, tap, answer, step, snapshot, roster, takeEvents };
});
