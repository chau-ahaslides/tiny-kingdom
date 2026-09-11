/* Gremlin Siege — the game rules, with no rendering in them.
   Players defend the Attention Tower. Each wave opens with a quiz: a right answer lets the player place a gun (bigger with a
   streak of right answers), a wrong one breaks the streak. Gremlins march the road; every one that gets through bites the tower.
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
  const PATH_SET = new Set(PATH.map(([x, z]) => x + ',' + z));
  // Position and heading along the road; `side` is a lateral offset so enemies do not stack on one line.
  function posAt(d, side) {
    d = Math.max(-2, Math.min(PATH_LEN, d));
    let s = SEG[SEG.length - 1];
    for (const seg of SEG) if (d <= seg.start + seg.len) { s = seg; break; }
    const k = d - s.start;
    return { x: s.ax + s.dx * k - s.dz * (side || 0), z: s.az + s.dz * k + s.dx * (side || 0), yaw: Math.atan2(s.dx, s.dz) };
  }
  // Scenery is decided here (seeded), so the rules and both renderers agree on which tiles are blocked.
  const DECOR = new Map();
  { let seed = 42; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let x = 0; x < COLS; x++) for (let z = 0; z < ROWS; z++) {
      if (PATH_SET.has(x + ',' + z)) continue;
      const r = rnd(); const yaw = Math.floor(rnd() * 4) * Math.PI / 2;
      DECOR.set(x + ',' + z, { kind: r < 0.07 ? 'tree' : r < 0.11 ? 'tree2' : r < 0.14 ? 'rock' : '', yaw });
    } }
  const END = PATH[PATH.length - 1];
  function freeTile(S, x, z) {
    if (!Number.isInteger(x) || !Number.isInteger(z) || x < 0 || z < 0 || x >= COLS || z >= ROWS) return false;
    if (PATH_SET.has(x + ',' + z)) return false;
    const d = DECOR.get(x + ',' + z); if (d && d.kind) return false;
    return !S.guns.some(g => !g.dead && g.x === x && g.z === z);
  }
  // Road points a gun at (x,z) with `range` can hit — the score bots use to pick a spot.
  const ROAD_PTS = []; for (let d = 0; d <= PATH_LEN; d += 0.5) ROAD_PTS.push(posAt(d, 0));
  function coverage(x, z, range) { let n = 0; for (const p of ROAD_PTS) if (Math.hypot(p.x - x, p.z - z) <= range) n++; return n; }

  // ------------------------------------------------------------ numbers to tune
  const RULES = {
    maxWaves: 10,          // hold all of these and the room wins outright
    quizTime: 15,          // seconds from the wave start to answer the quiz…
    placeTime: 5,          // …then this long to drag the gun into place (a gun not placed in time is lost)
    towerHp: 10,           // attention points; every gremlin that gets through bites some off
    spawnGap: 1.0,         // seconds between gremlins leaving the spawn…
    spawnRoom: 9,          // …shrinking for rooms bigger than this, so a big room gets a denser wave rather than a longer one
    countBase: 2, countPerWave: 2.5, countPerPlayer: 0.8,   // gremlins per wave
    hpGrow: 0.55,          // enemy HP compounds by this share each wave
    hpPerPlayer: 0,        // …and grows by this share for every player beyond six (off: the gremlin count already scales with the room)
    botRight: 0.5,         // how often a bot answers right (the tuning target: half the room)
    botAnsMin: 3, botAnsMax: 10, botPlace: 2.5,
    between: 5,            // seconds between waves: watch the field settle, get ready for the next quiz
    maxStreakLevel: 4,     // gun level = min(this, streak - 1)
    godStreak: 6,          // from this streak on a right answer is God Mode: it refills the emptiest guns on the board…
    godBase: 4,            // …streak minus this many of them (streak 6 = 2 guns, 7 = 3, and so on)
  };
  const ENEMY = {
    gremlin: { hp: 110, speed: 1.15, bite: 1 },
    runner: { hp: 60, speed: 2.0, bite: 1 },
    brute: { hp: 420, speed: 0.72, bite: 3 },
    ufo: { hp: 180, speed: 1.45, bite: 2, fly: true },
  };
  // Every gun carries a fixed load of ammo and is removed when it runs dry, so the defence never piles up for good.
  const GUNS = {
    ballista: { ammoSpeed: 9, splash: 0 },
    cannon: { ammoSpeed: 6, splash: 0.9 },
    turret: { ammoSpeed: 14, splash: 0 },
    catapult: { ammoSpeed: 5, splash: 1.4 },
    crystal: { ammoSpeed: 16, splash: 0.4 },
  };
  const GUN_TYPES = Object.keys(GUNS);
  // The ladder a streak climbs: one gun per level, bigger every step.
  const LEVELS = [
    { type: 'ballista', name: 'Small ballista', dmg: 15, range: 2.4, reload: 1.0, ammo: 30 },
    { type: 'cannon', name: 'Medium cannon', dmg: 34, range: 2.4, reload: 1.8, ammo: 20 },
    { type: 'turret', name: 'BIG turret', dmg: 10, range: 2.6, reload: 0.18, ammo: 180 },
    { type: 'catapult', name: 'HUGE catapult', dmg: 95, range: 3.1, reload: 2.4, ammo: 26 },
    { type: 'crystal', name: 'LEGENDARY crystal turret', dmg: 18, range: 3.3, reload: 0.15, ammo: 260 },
  ];
  const LEVEL_GUN = LEVELS.map(l => l.type);
  // What marches in each wave: a list of kinds, in spawn order.
  function waveList(wave, players, R) {
    R = R || RULES;
    const n = Math.round(R.countBase + R.countPerWave * (wave - 1) + R.countPerPlayer * players);
    const list = [];
    for (let i = 0; i < n; i++) {
      let kind = 'gremlin';
      if (wave >= 3 && i % 6 === 5) kind = 'brute';
      else if (wave >= 2 && i % 3 === 1) kind = 'runner';
      else if (wave >= 4 && i % 5 === 3) kind = 'ufo';
      list.push(kind);
    }
    if (wave >= 3) list.push('brute');
    return list;
  }

  const QUIZ = [
    ['What feeds the Attention Gremlin?', ['Live polls', 'A one-way monologue with 40 slides', 'A quick quiz', 'Audience Q&A'], 1],
    ['Roughly how long can an audience stay focused before the Gremlin creeps in?', ['About 10 minutes', 'Three hours', 'A whole day', 'Forty-five seconds'], 0],
    ["What is the Gremlin's favourite slide?", ['A word cloud', 'A live poll', 'A wall of text in 9-point font', 'A spinner wheel'], 2],
    ['Which weapon hurts the Gremlin the most?', ['Reading the slides aloud', 'Turning the lights off', 'A smaller font', 'Asking the audience a question'], 3],
    ['How does an audience join the fight in AhaSlides?', ['Install an app first', 'Send a fax', 'Scan the QR code or enter the code online', 'Email the presenter'], 2],
    ['Which AhaSlides slide lets everyone shout ideas that grow on screen?', ['Gantt chart', 'Word cloud', 'Pivot table', 'Footnote'], 1],
    ['In an AhaSlides quiz, who scores the most points?', ['The slowest right answer', 'Whoever shouts loudest', 'The presenter', 'The fastest right answer'], 3],
    ['The room has gone quiet. What sends the Gremlin running?', ['Speak faster', 'Ask a question and show the live answers', 'Add more bullet points', 'Skip to the end'], 1],
    ['Which of these does NOT fight the Gremlin?', ['A live Q&A', 'A quick poll', 'A spinner-wheel prize', 'A 40-slide monologue'], 3],
    ['The Gremlin flees when the audience…', ['Checks email', 'Participates', 'Naps', 'Leaves early'], 1],
  ];
  const BOT_NAMES = ['Ava Bot', 'Bao Bot', 'Cleo Bot', 'Dex Bot', 'Eli Bot', 'Fin Bot', 'Gia Bot', 'Hugo Bot', 'Ivy Bot', 'Jax Bot', 'Kai Bot', 'Lou Bot', 'Mia Bot', 'Nox Bot', 'Oli Bot', 'Pip Bot'];

  // ------------------------------------------------------------ state
  function create(opts) {
    const rules = Object.assign({}, RULES, opts && opts.rules);
    return {
      rules, rand: (opts && opts.rand) || Math.random,
      phase: 'lobby', wave: 0, time: 0, timeLeft: 0, quizLeft: 0, placeLeft: 0, quizPool: (opts && opts.quiz && opts.quiz.length) ? opts.quiz : QUIZ,
      tower: { hp: rules.towerHp, max: rules.towerHp },
      players: new Map(), order: [], guns: [], enemies: [], queue: [], spawnT: 0, shots: [], quiz: null, events: [], seq: 0, eid: 0,
      won: null, survived: 0, lastQuiz: -1,
    };
  }
  function addPlayer(S, id, name, bot) {
    if (S.players.has(id)) { const p = S.players.get(id); p.name = name || p.name; p.gone = false; return p; }
    const p = { id, name: name || 'Defender', bot: !!bot, skin: S.order.length % 12, correct: 0, wrong: 0, streak: 0, best: 0, kills: 0, dmg: 0, answered: false, pending: null, guns: 0, lost: 0, gone: false, bot_ans: 0, bot_place: 0 };
    S.players.set(id, p); S.order.push(id);
    return p;
  }
  function removePlayer(S, id) {
    const p = S.players.get(id); if (!p) return;
    if (S.phase === 'lobby') { S.players.delete(id); S.order = S.order.filter(x => x !== id); }
    else p.gone = true;                                      // keep the score and the guns; the phone may come back
  }
  function setBots(S, totalPlayers) {
    // Fill (or trim) bots so that humans + bots === totalPlayers. Only in the lobby.
    if (S.phase !== 'lobby') return;
    const humans = [...S.players.values()].filter(r => !r.bot);
    const bots = [...S.players.values()].filter(r => r.bot);
    let want = Math.max(0, totalPlayers - humans.length);
    while (bots.length > want) { const b = bots.pop(); S.players.delete(b.id); S.order = S.order.filter(x => x !== b.id); }
    let n = 0;
    while (bots.length < want) { const name = BOT_NAMES[(bots.length + n++) % BOT_NAMES.length]; if ([...S.players.values()].some(r => r.name === name)) continue; bots.push(addPlayer(S, 'bot' + bots.length + '_' + Math.floor(S.rand() * 1e6), name, true)); }
  }

  // ------------------------------------------------------------ waves
  function startWave(S) {
    if (S.phase === 'over' || S.wave >= S.rules.maxWaves) return false;
    S.wave++; S.phase = 'wave'; S.quizLeft = S.rules.quizTime; S.placeLeft = 0; S.shots = []; S.enemies = []; S.spawnT = 0;              // the first gremlin leaves the spawn on the very first step
    const active = [...S.players.values()].filter(p => !p.gone).length;
    S.queue = waveList(S.wave, active, S.rules);
    const pool = S.quizPool; let qi; do { qi = Math.floor(S.rand() * pool.length); } while (pool.length > 1 && qi === S.lastQuiz);
    S.lastQuiz = qi; S.quiz = { i: qi, q: pool[qi][0], opts: pool[qi][1], answer: pool[qi][2] };
    for (const p of S.players.values()) {
      p.answered = false;
      if (p.bot) { p.bot_ans = S.rules.botAnsMin + S.rand() * (S.rules.botAnsMax - S.rules.botAnsMin); p.bot_place = 0; }
    }
    S.events.push({ e: 'wave', wave: S.wave, count: S.queue.length });
    return true;
  }
  function endWave(S) {
    S.survived = S.wave; S.shots = []; S.enemies = []; S.queue = [];
    // A quiz nobody answered still counts against the streak; a gun that was never placed is lost.
    for (const p of S.players.values()) { if (!p.answered && !p.gone) { p.streak = 0; } p.pending = null; }
    if (S.wave >= S.rules.maxWaves) { S.phase = 'over'; S.won = true; S.events.push({ e: 'over', won: true, survived: S.survived }); }
    else { S.phase = 'between'; S.events.push({ e: 'waveEnd', wave: S.wave }); }
  }
  function towerDown(S) { S.phase = 'over'; S.won = false; S.tower.hp = 0; S.survived = S.wave - 1; S.shots = []; S.events.push({ e: 'over', won: false, survived: S.survived }); }

  // ------------------------------------------------------------ inputs
  function answer(S, id, i) {
    const p = S.players.get(id); if (!p || !S.quiz || S.phase !== 'wave' || S.quizLeft <= 0) return 'late';
    if (p.answered) return 'dup';
    p.answered = true;
    if (i === S.quiz.answer) {
      p.correct++; p.streak++; p.best = Math.max(p.best, p.streak);
      if (p.streak >= S.rules.godStreak) {
        const want = p.streak - S.rules.godBase;
        const picked = S.guns.filter(g => !g.dead && g.ammo < g.max).sort((a, b) => a.ammo / a.max - b.ammo / b.max).slice(0, want);
        for (const g of picked) g.ammo = g.max;
        p.gods = (p.gods || 0) + 1; p.refills = (p.refills || 0) + picked.length;
        S.events.push({ e: 'god', id, streak: p.streak, want, refilled: picked.length, guns: picked.map(g => g.i) });
        return 'god';
      }
      const level = Math.min(S.rules.maxStreakLevel, p.streak - 1);
      p.pending = { level, wave: S.wave };
      S.events.push({ e: 'right', id, level, streak: p.streak });
      return 'right';
    }
    p.wrong++; p.streak = 0;
    S.events.push({ e: 'wrong', id });
    return 'wrong';
  }
  function place(S, id, x, z) {
    const p = S.players.get(id); if (!p || !p.pending || S.phase !== 'wave') return 'none';
    if (S.quizLeft <= 0 && S.placeLeft <= 0) { p.pending = null; return 'late'; }
    const type = LEVEL_GUN[p.pending.level];
    if (!freeTile(S, x, z)) return 'taken';
    const ammo = LEVELS[p.pending.level].ammo;
    const g = { i: S.guns.length, owner: id, type, level: p.pending.level, x, z, cool: 0.2, yaw: 0, target: null, kills: 0, ammo, max: ammo, dead: false };
    S.guns.push(g); p.pending = null; p.guns++;
    S.events.push({ e: 'placed', id, gun: gunInfo(S, g) });
    return 'ok';
  }
  function gunInfo(S, g) { const p = S.players.get(g.owner); return { i: g.i, owner: g.owner, name: p ? p.name : '', skin: p ? p.skin : 0, bot: p ? p.bot : false, type: g.type, level: g.level, x: g.x, z: g.z, ammo: g.ammo, max: g.max, dead: g.dead }; }
  // Bots pick a spot that covers a lot of road, with some randomness so they do not all pile onto one tile.
  function botSpot(S, level, type) {
    const range = LEVELS[level].range; const cands = [];
    for (let x = 0; x < COLS; x++) for (let z = 0; z < ROWS; z++) if (freeTile(S, x, z)) cands.push({ x, z, s: coverage(x, z, range) + S.rand() * 3 });
    cands.sort((a, b) => b.s - a.s);
    return cands[Math.floor(S.rand() * Math.min(4, cands.length))] || null;
  }

  // ------------------------------------------------------------ simulation
  function spawn(S, kind) {
    const def = ENEMY[kind]; const grow = Math.pow(1 + S.rules.hpGrow, S.wave - 1) * Math.max(1, 1 + S.rules.hpPerPlayer * (S.players.size - 6));
    const e = { id: ++S.eid, kind, hp: Math.round(def.hp * grow), max: Math.round(def.hp * grow), d: -0.6, side: ((S.eid % 3) - 1) * 0.26, speed: def.speed, bite: def.bite, fly: !!def.fly, state: 'run', t: 0 };
    S.enemies.push(e); S.events.push({ e: 'spawn', id: e.id, kind });
  }
  function hurt(S, e, dmg, gun) {
    if (e.state !== 'run') return;
    e.hp -= dmg;
    const p = gun && S.players.get(gun.owner); if (p) p.dmg += dmg;
    if (e.hp <= 0) { e.hp = 0; e.state = 'dead'; e.t = 0; if (gun) { gun.kills++; if (p) p.kills++; } S.events.push({ e: 'die', id: e.id, gun: gun ? gun.i : -1, owner: gun ? gun.owner : null, kills: p ? p.kills : 0 }); }
  }
  function step(S, dt) {
    if (S.phase !== 'wave') return;
    S.time += dt; S.seq++;
    if (S.quizLeft > 0) { S.quizLeft -= dt; if (S.quizLeft <= 0) { S.quizLeft = 0; S.placeLeft = S.rules.placeTime; S.events.push({ e: 'quizEnd' }); } }
    else if (S.placeLeft > 0) { S.placeLeft -= dt; if (S.placeLeft <= 0) { S.placeLeft = 0; for (const p of S.players.values()) if (p.pending) { p.pending = null; S.events.push({ e: 'unplaced', id: p.id }); } S.events.push({ e: 'placeEnd' }); } }
    const R = S.rules;
    // Bots answer, then place their gun somewhere sensible.
    for (const p of S.players.values()) {
      if (!p.bot) continue;
      if (!p.answered && S.quizLeft > 0) { p.bot_ans -= dt; if (p.bot_ans <= 0) { const pick = S.rand() < R.botRight ? S.quiz.answer : (S.quiz.answer + 1 + Math.floor(S.rand() * 3)) % 4; answer(S, p.id, pick); S.events.push({ e: 'answer', id: p.id, i: pick }); p.bot_place = R.botPlace * (0.6 + 0.8 * S.rand()); } }
      else if (p.pending) { p.bot_place -= dt; if (p.bot_place <= 0) { const s = botSpot(S, p.pending.level, LEVEL_GUN[p.pending.level]); if (s) place(S, p.id, s.x, s.z); else p.pending = null; } }
    }
    // Gremlins leave the spawn one at a time and march.
    if (S.queue.length) { S.spawnT -= dt; if (S.spawnT <= 0) { S.spawnT = R.spawnGap * Math.min(1, R.spawnRoom / Math.max(1, S.players.size)); spawn(S, S.queue.shift()); } }
    for (const e of S.enemies) {
      if (e.state === 'run') {
        e.d += e.speed * dt;
        if (e.d >= PATH_LEN - 0.5) { e.state = 'in'; e.t = 0; S.tower.hp -= e.bite; S.events.push({ e: 'reach', id: e.id, bite: e.bite, kind: e.kind }); if (S.tower.hp <= 0) return towerDown(S); }
      } else e.t += dt;
    }
    S.enemies = S.enemies.filter(e => e.state === 'run' || e.t < 1.2);
    // Guns pick the enemy furthest along the road in range and shoot.
    for (const g of S.guns) {
      if (g.dead) continue;
      const def = GUNS[g.type], st = LEVELS[g.level];
      g.cool -= dt;
      let best = null, bestD = -1;
      for (const e of S.enemies) {
        if (e.state !== 'run') continue;
        const p = posAt(e.d, e.side); const dx = p.x - g.x, dz = p.z - g.z;
        if (dx * dx + dz * dz <= st.range * st.range && e.d > bestD) { best = e; bestD = e.d; }
      }
      g.target = best ? best.id : null;
      if (best) {
        const p = posAt(best.d, best.side);
        g.yaw = Math.atan2(p.x - g.x, p.z - g.z);
        if (g.cool <= 0) {
          g.cool = st.reload; g.ammo--;
          if (g.ammo <= 0) { g.dead = true; const o = S.players.get(g.owner); if (o) o.lost++; S.events.push({ e: 'gunDown', gun: g.i, owner: g.owner, x: g.x, z: g.z }); }
          const dist = Math.hypot(p.x - g.x, p.z - g.z); const dur = Math.max(0.08, dist / def.ammoSpeed);
          S.shots.push({ gun: g, target: best.id, dmg: st.dmg, splash: def.splash, t: 0, dur, ax: p.x, az: p.z });
          S.events.push({ e: 'shot', gun: g.i, target: best.id, dur, splash: def.splash });
        }
      }
    }
    // Shots land after their flight time.
    S.shots = S.shots.filter(s => {
      s.t += dt; if (s.t < s.dur) return true;
      const tgt = S.enemies.find(e => e.id === s.target);
      if (s.splash > 0) {
        const p = tgt ? posAt(tgt.d, tgt.side) : { x: s.ax, z: s.az };
        S.events.push({ e: 'boom', x: p.x, z: p.z, r: s.splash });
        for (const e of S.enemies) { if (e.state !== 'run') continue; const q = posAt(e.d, e.side); if (Math.hypot(q.x - p.x, q.z - p.z) <= s.splash + 0.3) hurt(S, e, s.dmg, s.gun); }
      } else if (tgt) hurt(S, tgt, s.dmg, s.gun);
      return false;
    });
    if (!S.queue.length && !S.enemies.some(e => e.state === 'run')) endWave(S);
  }

  // ------------------------------------------------------------ output
  function snapshot(S) {
    // Road distance + speed rather than a position, so renderers can move enemies smoothly between snapshots.
    const e = S.enemies.map(e => [e.id, e.kind, +(e.hp / e.max).toFixed(2), +e.d.toFixed(3), +e.side.toFixed(2), e.speed, e.state]);
    return { t: 's', ph: S.phase, w: S.wave, th: Math.max(0, S.tower.hp), tm: S.tower.max, ql: Math.ceil(S.quizLeft), pl: Math.ceil(S.placeLeft), left: S.queue.length + S.enemies.filter(x => x.state === 'run').length, e, gy: S.guns.map(g => +g.yaw.toFixed(2)), gh: S.guns.map(g => g.dead ? 0 : +(g.ammo / g.max).toFixed(2)), ga: S.guns.map(g => g.dead ? 0 : g.ammo) };
  }
  function roster(S) {
    return [...S.order].map(id => { const p = S.players.get(id); return { id, name: p.name, bot: p.bot, skin: p.skin, kills: p.kills, dmg: Math.round(p.dmg), correct: p.correct, wrong: p.wrong, streak: p.streak, best: p.best, gods: p.gods || 0, refills: p.refills || 0, guns: p.guns, alive: S.guns.filter(g => !g.dead && g.owner === id).length, lost: p.lost, gone: p.gone }; });
  }
  function gunList(S) { return S.guns.map(g => gunInfo(S, g)); }
  function takeEvents(S) { const ev = S.events; S.events = []; return ev; }

  return { COLS, ROWS, PATH, PATH_LEN, PATH_SET, DECOR, END, posAt, freeTile, coverage, RULES, ENEMY, GUNS, GUN_TYPES, LEVELS, LEVEL_GUN, QUIZ, waveList, create, addPlayer, removePlayer, setBots, startWave, endWave, answer, place, step, snapshot, roster, gunList, takeEvents };
});
