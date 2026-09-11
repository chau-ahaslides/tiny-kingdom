/* Gremlin Siege — the host (big screen) and player (phone) controllers, the room link, and the GremlinSiege API.
   Needs tr-config.js, tr-sim.js, tr-view.js and tr-audio.js loaded first. */
'use strict';
/* ===================== ROOM LINK ===================== */
const WS_BASE = () => CONFIG.ws || (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/';
const emit = (name, data) => GremlinSiege.emit(name, data);
const T = CONFIG.text;
function link(url, onMsg, onState) {
  let ws = null, retries = 0, closed = false;
  const connect = () => {
    const me = ws = new WebSocket(url);
    me.onopen = () => { retries = 0; if (onState) onState('up'); };
    me.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } onMsg(m); };
    me.onclose = () => { if (me !== ws || closed) return; retries++; if (onState) onState('down'); setTimeout(() => { if (me === ws && !closed) connect(); }, Math.min(5000, 800 * retries)); };
  };
  connect();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ws && ws.readyState > 1 && !closed) connect(); });
  setInterval(() => { if (ws && ws.readyState === 1) { try { ws.send('{"t":"ping"}'); } catch (e) {} } }, 20000);
  return { send: (m) => { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(m)); } catch (e) {} } }, close: () => { closed = true; try { ws.close(); } catch (e) {} } };
}
async function openRoom() { const res = await fetch((CONFIG.api || '') + '/api/room', { method: 'POST' }); return (await res.json()).code; }

/* ===================== HOST (big screen: runs the rules, streams the state) ===================== */
const host = { link: null, code: '', view: null, S: null, total: CONFIG.host.partySize, lastSnap: 0, running: false, answers: new Map(), fx: { s: [], b: [] } };
async function startHost() {
  show('s-hostlobby');
  try { host.code = await openRoom(); } catch (e) { toast('Could not open a room — this page has to be served by the game server.'); return; }
  const joinUrl = (CONFIG.host.joinBase || location.origin) + '/tr/' + host.code;
  $('#code').textContent = host.code.split('').join(' '); $('#joinurl').textContent = joinUrl.replace(/^https?:\/\//, '');
  if (CONFIG.host.showQr) { const qr = qrcode(0, 'M'); qr.addData(joinUrl); qr.make(); $('#qr').innerHTML = qr.createImgTag(5, 8); }
  host.S = TR.create({ rules: CONFIG.rules, quiz: CONFIG.quiz }); TR.setBots(host.S, host.total); emit('room', { code: host.code, joinUrl }); $('#hpnote').textContent = TR.RULES.towerHp; $('#qtnote').textContent = TR.RULES.quizTime;
  host.link = link(WS_BASE() + host.code + '?role=host', hostReceive, st => { if (st === 'down') toast('Room link lost — reconnecting…'); });
  host.view = new View($('#gl'), { theta: 0.18, phi: 0.78, orbit: true, margins: { x: 0.64, y: 0.64, yBias: -0.12 } }); await host.view.buildMap();
  renderRoster();
}
function helloFor(p) { const S = host.S; return { t: 'hello', name: p.name, skin: p.skin, ph: S.phase, wave: S.wave, quizTime: S.rules.quizTime, placeTime: S.rules.placeTime, between: S.rules.between, towerHp: S.tower.max, streak: p.streak, kills: p.kills, alive: S.guns.filter(g => !g.dead && g.owner === p.id).length, pending: p.pending }; }
function hostReceive(m) {
  const S = host.S; if (!S) return;
  if (m.t === 'join') {
    const p = TR.addPlayer(S, m.id, m.name, false); if (S.phase === 'lobby') TR.setBots(S, host.total);
    host.link.send(Object.assign({ to: m.id }, helloFor(p)));
    host.link.send({ to: m.id, t: 'guns', list: TR.gunList(S) });
    if (S.phase === 'wave' && S.quiz) host.link.send({ to: m.id, t: 'quiz', q: S.quiz.q, opts: S.quiz.opts, wave: S.wave, done: p.answered, left: Math.ceil(S.quizLeft) });
    sendRoster(); renderRoster(); if (!m.rejoin) toast(p.name + ' joined'); emit('join', { id: m.id, name: p.name, rejoin: !!m.rejoin });
    return;
  }
  if (m.t === 'leave') { TR.removePlayer(S, m.id); if (S.phase === 'lobby') TR.setBots(S, host.total); sendRoster(); renderRoster(); emit('leave', { id: m.id }); return; }
  if (m.t === 'ans') {
    const res = TR.answer(S, m.id, m.i); const p = S.players.get(m.id);
    host.link.send({ to: m.id, t: 'ans', res, correct: S.quiz ? S.quiz.answer : -1, level: p && p.pending ? p.pending.level : 0, streak: p ? p.streak : 0 });
    if (res === 'right' || res === 'wrong' || res === 'god') { host.answers.set(m.id, m.i); renderQuiz(); SFX.play('answer', { pitch: 1.2 }); emit('answer', { id: m.id, name: p ? p.name : '', option: m.i, result: res, streak: p ? p.streak : 0, wave: S.wave }); }
    return;
  }
  if (m.t === 'place') {
    const res = TR.place(S, m.id, m.x, m.z);
    host.link.send({ to: m.id, t: 'placed', res });
    return;
  }
}
function sendRoster() { if (host.link) host.link.send({ t: 'roster', list: TR.roster(host.S) }); }
function renderRoster() {
  const list = TR.roster(host.S);
  $('#count').textContent = '(' + list.length + ')';
  $('#roster').innerHTML = list.length ? list.map(r => `<span class="chip ${r.bot ? 'bot' : ''}"><span class="dot" style="background:${hex(COLORS[r.skin % COLORS.length])}"></span>${r.bot ? '🤖 ' : ''}${esc(r.name)}</span>`).join('') : '<span class="hint">Waiting for phones…</span>';
  $('#total').textContent = host.total;
}
$('#b-less').onclick = () => { host.total = Math.max(1, host.total - 1); TR.setBots(host.S, host.total); renderRoster(); sendRoster(); };
$('#b-more').onclick = () => { host.total = Math.min(CONFIG.host.maxParty, host.total + 1); TR.setBots(host.S, host.total); renderRoster(); sendRoster(); };
$('#b-start').onclick = async () => {
  const S = host.S; if (!S) return;
  if (![...S.players.values()].some(r => !r.bot) && !confirm('No phones have joined. Start with bots only?')) return;
  $('#b-start').disabled = true; $('#b-start').textContent = 'Loading…'; SFX.unlock();
  try { await preload(); } catch (e) {}
  show('s-hostgame'); host.running = true; SFX.startMusic(); emit('start', { players: TR.roster(S) });
  beginWave();
}
// The first wave is started by hand; every later one starts on the clock inside the rules and arrives as a 'wave' event.
function beginWave() { TR.startWave(host.S); onWave(); }
function onWave() {
  const S = host.S; host.answers.clear(); host.lastCount = 0;
  const count = S.queue.filter(q => q.wave === S.wave).length;
  host.link.send({ t: 'quiz', q: S.quiz.q, opts: S.quiz.opts, wave: S.wave, left: S.rules.quizTime });
  sendRoster();
  bigMsg('Wave ' + S.wave + ' — ' + count + ' ' + T.enemies + ' marching!', 2000); SFX.play('wave'); SFX.play('quiz');
  emit('wave', { wave: S.wave, enemies: count, quiz: { q: S.quiz.q, opts: S.quiz.opts } });
  renderQuiz(); $('#h-quiz').classList.add('on');
}
function preload() {
  const names = new Set(['dungeon/coin', 'dungeon/character-orc', 'kit/enemy-ufo-a']);
  for (const type of TR.GUN_TYPES) { names.add('kit/' + WEAPON[type]); names.add('kit/' + AMMO[type]); }
  for (const lvl of Object.keys(TOWER_PARTS)) for (const p of TOWER_PARTS[lvl]) names.add('kit/' + p);
  names.add('kit/detail-crystal');
  return Promise.all([...names].map(loadGLB));
}
function renderQuiz() {
  const S = host.S; if (!S.quiz) return;
  $('#hq-q').textContent = '❓ ' + S.quiz.q;
  const counts = [0, 0, 0, 0]; for (const i of host.answers.values()) counts[i]++;
  const total = [...S.players.values()].filter(r => !r.gone).length;
  const reveal = S.phase !== 'wave' || S.quizLeft <= 0 || host.answers.size >= total;
  $('#hq-opts').innerHTML = S.quiz.opts.map((o, i) => `<div class="opt ${reveal && i === S.quiz.answer ? 'right' : ''}"><span>${'ABCD'[i]}. ${esc(o)}</span><span>${counts[i] || ''}</span></div>`).join('');
  $('#hq-who').innerHTML = [...host.answers.entries()].map(([id, i]) => { const p = S.players.get(id); if (!p) return ''; const ok = i === S.quiz.answer; const god = ok && p.streak >= S.rules.godStreak; return `<span class="chip ${ok ? 'ok' : 'bad'}">${god ? '⚡' : ok ? '🔫' : '❌'} ${p.bot ? '🤖 ' : ''}${esc(p.name)}${ok && p.streak > 1 ? ' 🔥' + p.streak : ''}</span>`; }).join('');
  $('#hq-note').textContent = reveal ? '✅ Answer: ' + S.quiz.opts[S.quiz.answer] + ' · ' + [...host.answers.values()].filter(i => i === S.quiz.answer).length + ' of ' + host.answers.size + ' got a gun' : host.answers.size + ' of ' + total + ' answered · right = place a gun · streak = bigger gun';
  $('#hq-time').classList.toggle('place', S.quizLeft <= 0 && S.placeLeft > 0);
  $('#hq-time').style.width = (S.phase === 'wave' ? 100 * Math.max(0, S.quizLeft) / S.rules.quizTime : 0) + '%';
}
function bigMsg(text, ms) { const el = $('#h-msg'); el.classList.remove('god'); el.textContent = text; el.classList.add('on'); clearTimeout(bigMsg.t); bigMsg.t = setTimeout(() => el.classList.remove('on'), ms); }
function godFeast(name, streak, refilled, guns) {
  const el = $('#h-msg'); el.textContent = '⚡ GOD MODE ⚡\n' + name + ' · streak ' + streak + '\n' + (refilled ? refilled + ' gun' + (refilled === 1 ? '' : 's') + ' refilled!' : 'nothing left to refill'); el.classList.add('on', 'god');
  clearTimeout(bigMsg.t); bigMsg.t = setTimeout(() => el.classList.remove('on', 'god'), 3200);
  host.view.godBurst(guns); SFX.play('win'); setTimeout(() => SFX.play('clear'), 250);
}
function renderBoard() {
  const list = TR.roster(host.S).sort((a, b) => b.kills - a.kills || b.dmg - a.dmg);
  $('#h-board').innerHTML = '<div class="hint" style="margin-bottom:4px">' + T.enemies[0].toUpperCase() + T.enemies.slice(1) + ' shot</div>' + list.map(r => `<div class="r"><span class="n"><span class="dot" style="width:10px;height:10px;border-radius:50%;background:${hex(COLORS[r.skin % COLORS.length])}"></span>${r.bot ? '🤖 ' : ''}${esc(r.name)}${r.streak > 1 ? ' 🔥' + r.streak : ''}${r.gods ? ' ⚡' + r.refills : ''} <span class="hint">🔫${r.alive}${r.lost ? ' 🪫' + r.lost : ''}</span></span><span>${r.kills}</span></div>`).join('');
}
// The rules tick on a timer so a hidden tab keeps the game going in real time; rendering stays on the frame callback.
function hostSim() {
  const S = host.S, view = host.view; if (!S || !view) return;
  const now = performance.now(); let elapsed = Math.min(2, (now - (host.simT || now)) / 1000); host.simT = now;
  if (host.paused) return;                       // the clock simply does not advance while paused
  if (host.running && (S.phase === 'wave' || S.phase === 'final')) {
    while (elapsed > 0) { const dt = Math.min(1 / 60, elapsed); elapsed -= dt; TR.step(S, dt); if (S.phase === 'over') break; }
    for (const ev of TR.takeEvents(S)) {
      if (ev.e === 'shot') { view.shot(ev.gun, ev.target, ev.dur, ev.splash); host.fx.s.push([ev.gun, ev.target, +ev.dur.toFixed(2), ev.splash]); const g = S.guns[ev.gun]; if (g) SFX.play(g.type === 'ballista' ? 'arrow' : g.type === 'turret' || g.type === 'crystal' ? 'turret' : 'cannon', { pitch: 0.85 + Math.random() * 0.3 }); }
      else if (ev.e === 'boom') { view.boom(ev.x, ev.z, ev.r); host.fx.b.push([+ev.x.toFixed(2), +ev.z.toFixed(2), ev.r]); SFX.play('boom', { pitch: 0.9 + Math.random() * 0.2, vol: Math.min(1.3, ev.r) }); }
      else if (ev.e === 'die') { SFX.play('kill', { pitch: 0.9 + Math.random() * 0.2 }); const p = S.players.get(ev.owner); if (p && !p.bot) host.link.send({ to: ev.owner, t: 'kill', n: ev.kills }); }
      else if (ev.e === 'reach') { view.hitKeep(); view.biteText('−' + ev.bite); SFX.play('bite'); SFX.play('alarm'); emit('bite', { hp: Math.max(0, S.tower.hp), max: S.tower.max, kind: ev.kind }); host.link.send({ t: 'bite', hp: Math.max(0, S.tower.hp), max: S.tower.max, bite: ev.bite, kind: ev.kind }); }
      else if (ev.e === 'placed') { view.addGun(ev.gun); host.link.send({ t: 'gun', g: ev.gun }); SFX.play('place'); emit('placed', ev.gun); }
      else if (ev.e === 'placeEnd') { host.link.send({ t: 'placeEnd' }); }
      else if (ev.e === 'god') { const p = S.players.get(ev.id); godFeast(p ? p.name : '?', ev.streak, ev.refilled, ev.guns); host.link.send({ t: 'god', id: ev.id, name: p ? p.name : '?', streak: ev.streak, n: ev.refilled, guns: ev.guns }); emit('god', { id: ev.id, name: p ? p.name : '', streak: ev.streak, refilled: ev.refilled }); }
      else if (ev.e === 'gunDown') { view.removeGun(ev.gun); SFX.play('empty'); emit('gunDown', { gun: ev.gun, owner: ev.owner }); host.link.send({ t: 'gunDown', i: ev.gun, owner: ev.owner }); const p = S.players.get(ev.owner); if (p) toast('🪫 ' + p.name + "'s gun is out of ammo"); }
      else if (ev.e === 'answer') { host.answers.set(ev.id, ev.i); renderQuiz(); SFX.play('answer', { pitch: 0.8 + Math.random() * 0.5 }); }
      else if (ev.e === 'quizEnd') { renderQuiz(); SFX.play('tick'); host.link.send({ t: 'quizEnd', correct: S.quiz.answer }); }
      else if (ev.e === 'waveEnd') { SFX.play('clear'); emit('waveEnd', { wave: ev.wave, hp: Math.max(0, S.tower.hp), max: S.tower.max, board: TR.roster(S) }); if (S.phase === 'final') { $('#h-quiz').classList.remove('on'); bigMsg('Last wave held — clear the road!', 2500); sendRoster(); } }
      else if (ev.e === 'wave') onWave();
      else if (ev.e === 'over') finish(ev.won);
    }
    const snap = TR.snapshot(S); host.snap = snap;
    if (now - host.lastSnap > 100) { host.lastSnap = now; host.link.send(snap); if (host.fx.s.length || host.fx.b.length) { host.link.send({ t: 'fx', s: host.fx.s, b: host.fx.b }); host.fx = { s: [], b: [] }; } }
  }
}
function hostTick(ts) {
  requestAnimationFrame(hostTick);
  const view = host.view; if (!view) return;
  const dt = Math.min(0.1, Math.max(0.001, ((ts || performance.now()) - (host.frameT || ts || performance.now())) / 1000)); host.frameT = ts || performance.now();
  const S = host.S, snap = host.snap;
  if (snap) { view.applyEnemies(snap.e); view.gunYaw = snap.gy; view.applyGuns(snap.gh, snap.ga); }
  if (host.running && (S.phase === 'wave' || S.phase === 'final')) {
    $('#h-hp').textContent = Math.max(0, S.tower.hp) + ' / ' + S.tower.max; const bar = $('#h-hpbar'); bar.style.width = (100 * Math.max(0, S.tower.hp) / S.tower.max) + '%'; bar.classList.toggle('low', S.tower.hp <= S.tower.max * 0.3);
    $('#h-wave').textContent = S.wave; $('#h-guns').textContent = S.guns.filter(g => !g.dead).length;
    $('#h-enemies').textContent = snap ? snap.left : 0;
    const now = performance.now(); if (Math.floor(now / 500) !== host.boardT) { host.boardT = Math.floor(now / 500); renderBoard(); if (S.phase === 'wave' && S.quizLeft > 0) renderQuiz(); }
  }
  if (host.running && S.phase === 'wave') {
    const watching = S.quizLeft <= 0 && S.placeLeft <= 0; const n = Math.max(0, Math.ceil(S.cycleLeft));
    phaseStrip($('#h-phases'), [S.quizLeft, S.placeLeft, watching ? S.cycleLeft : 0], [S.rules.quizTime, S.rules.placeTime, S.rules.between], S.phase);
    $('#b-next').style.display = watching ? '' : 'none';
    if (watching && n <= 3 && n > 0 && n !== host.lastCount && S.wave < S.rules.maxWaves) { host.lastCount = n; bigMsg('Wave ' + (S.wave + 1) + ' in ' + n, 950); host.link.send({ t: 'count', n, wave: S.wave + 1 }); SFX.play(n === 1 ? 'go' : 'tick'); }
  } else if (host.running && S.phase === 'final') { phaseStrip($('#h-phases'), [0, 0, 0], [S.rules.quizTime, S.rules.placeTime, S.rules.between], 'final'); $('#b-next').style.display = 'none'; }
  view.frame(host.paused ? 0 : dt);
}
setInterval(hostSim, 1000 / 60);
$('#b-next').onclick = () => { if (host.S && host.S.phase === 'wave') host.S.cycleLeft = 0; };
function setPaused(on) {
  if (!host.running || host.paused === on) return;
  host.paused = on; $('#b-pause').textContent = on ? '▶ Resume' : '⏸ Pause'; SFX.play('pause', { pitch: on ? 1 : 1.4 }); emit('pause', { on });
  const el = $('#h-msg'); clearTimeout(bigMsg.t);
  if (on) { el.textContent = '⏸ Paused'; el.classList.add('on'); } else el.classList.remove('on');
  host.link.send({ t: 'pause', on });
}
$('#b-pause').onclick = () => setPaused(!host.paused);
function soundButtons() { $('#b-sound').textContent = SFX.on ? '🔊' : '🔇'; $('#b-music').style.opacity = SFX.music ? 1 : .45; $('#p-sound').textContent = SFX.on ? '🔊' : '🔇'; }
$('#b-sound').onclick = () => { SFX.unlock(); SFX.setOn(!SFX.on); soundButtons(); if (SFX.on) SFX.play('tick'); };
$('#b-music').onclick = () => { SFX.unlock(); SFX.setMusic(!SFX.music); soundButtons(); if (SFX.music && host.running) SFX.startMusic(); };
$('#p-sound').onclick = () => { SFX.unlock(); SFX.setOn(!SFX.on); soundButtons(); if (SFX.on) SFX.play('tick'); };
document.addEventListener('pointerdown', () => SFX.unlock(), { capture: true });
soundButtons();
document.addEventListener('keydown', e => { if (e.key === ' ' && host.running && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); setPaused(!host.paused); } });
$('#b-recenter').onclick = () => { const v = host.view; if (!v) return; v.cam.theta = 0.18; v.cam.phi = 0.78; v.cam.fit = 0; v.fitBoard(); };
$('#b-abort').onclick = () => { if (confirm('End the game for everyone?')) finish(false, true); };
function finish(won, aborted) {
  const S = host.S; if (host.paused) setPaused(false); host.running = false; S.phase = 'over'; SFX.stopMusic(); SFX.play(won ? 'win' : 'lose');
  const fallen = !won && !aborted;
  const survived = aborted ? Math.max(0, S.wave - 1) : S.survived;
  const list = TR.roster(S).sort((a, b) => b.kills - a.kills || b.dmg - a.dmg);
  host.link.send({ t: 'over', won, board: list, survived, aborted: !!aborted }); emit('over', { won, survived, aborted: !!aborted, wave: S.wave, board: list });
  $('#ov-title').textContent = won ? '🏆 Legendary! The tower held every wave' : '💥 The ' + T.tower + ' has fallen';
  $('#ov-text').textContent = won ? 'All ' + S.rules.maxWaves + ' waves held. The Gremlins give up.' : (aborted ? 'The game was ended early after ' + survived + ' wave' + (survived === 1 ? '' : 's') + '.' : 'The defence held for ' + survived + ' wave' + (survived === 1 ? '' : 's') + ' and fell in wave ' + S.wave + '. The ' + T.enemies + ' have the room.');
  $('#ov-table').innerHTML = list.slice(0, 12).map((r, i) => `<tr><td>${i + 1}.</td><td>${r.bot ? '🤖 ' : ''}${esc(r.name)} <span class="hint">🔫${r.guns} placed · best streak ${r.best}</span></td><td>${r.kills} kills</td></tr>`).join('');
  if (fallen) { host.view.crumbleKeep(); $('#h-quiz').classList.remove('on'); bigMsg('💥 The ' + T.tower + ' has fallen!', 5000); setTimeout(() => { SFX.play('boom'); setTimeout(() => SFX.play('boom', { pitch: .8 }), 500); }, 1200); setTimeout(() => show('s-hostover'), 5500); }
  else show('s-hostover');
}
$('#b-again').onclick = () => location.href = location.pathname;

/* ===================== PLAYER (phone) ===================== */
const player = { link: null, code: '', id: null, name: '', view: null, ph: 'lobby', roster: [], answered: false, snap: null, quizTime: 15, pending: null, sel: null, type: 'ballista', guns: [], streak: 0, kills: 0, gunsN: 0 };
function joinGame(code, name) {
  player.code = code; player.name = name;
  let token = ''; try { token = localStorage.getItem('tk-tr-tok-' + code) || ''; if (!token) { token = Math.random().toString(36).slice(2, 12); localStorage.setItem('tk-tr-tok-' + code, token); } } catch (e) {}
  show('s-play'); $('#p-name').textContent = name;
  let seen = !CONFIG.player.onboarding; try { seen = seen || localStorage.getItem('tk-tr-onboard') === '1'; } catch (e) {}
  if (!seen) $('#p-onboard').classList.add('on');
  emit('joined', { code, name });
  player.view = new View($('#gl'), { lite: true, orbit: true, margins: { x: 0.96, y: 0.72, yBias: -0.12 } }); player.view.buildMap().then(() => { player.mapReady = true; });
  player.link = link(WS_BASE() + code + '?role=player&name=' + encodeURIComponent(name) + '&token=' + encodeURIComponent(token), playerReceive, st => { if (st === 'down') toast('Reconnecting…'); });
  playerTick();
}
function playerReceive(m) {
  const v = player.view;
  if (m.t === 'welcome') { player.id = m.id; v.me = m.id; emit('welcome', { id: m.id }); return; }
  if (m.t === 'nohost') { pMsg('The big screen is not open yet…', 4000); return; }
  if (m.t === 'hostgone') { pMsg('Big screen disconnected', 5000); setBtn('', 'Waiting…'); return; }
  if (m.t === 'hello') {
    player.quizTime = m.quizTime || 15; player.placeTime = m.placeTime || 5; player.between = m.between || 5; player.ph = m.ph; player.streak = m.streak || 0; player.kills = m.kills || 0; player.gunsN = m.alive || 0; updateMe();
    if (m.pending) openPlace(m.pending.level, player.streak);
    if (m.ph === 'lobby') { setBtn('', 'Waiting for the host…'); pMsg('You are in!\nEach wave: answer right → place a gun with your name on it', 5000); }
    return;
  }
  if (m.t === 'roster') { player.roster = m.list; const me = m.list.find(r => r.id === player.id); if (me) { player.streak = me.streak; player.kills = me.kills; player.gunsN = me.alive; updateMe(); } return; }
  if (m.t === 'guns') { player.guns = m.list; v.setGuns(m.list); return; }
  if (m.t === 'gunDown') { const g = player.guns.find(g => g.i === m.i); if (g) g.dead = true; v.removeGun(m.i); if (m.owner === player.id) { player.gunsN = Math.max(0, player.gunsN - 1); updateMe(); SFX.play('empty'); if (navigator.vibrate) navigator.vibrate(40); } return; }
  if (m.t === 'gun') { player.guns.push(m.g); v.addGun(m.g); if (m.g.owner === player.id) { player.gunsN++; updateMe(); } if (player.sel && player.sel.x === m.g.x && player.sel.z === m.g.z) placeAt(m.g.x, m.g.z); return; }
  if (m.t === 'quiz') { showQuiz(m); SFX.play('quiz'); emit('quiz', { wave: m.wave, q: m.q, opts: m.opts }); return; }
  if (m.t === 'placeEnd') { if (player.pending) { closePlace(); pMsg('⏰ Too slow — the gun is lost', 1600); SFX.play('wrong'); } return; }
  if (m.t === 'ans') {
    const btns = $('#pq-opts').querySelectorAll('button'); btns.forEach((b, i) => { b.disabled = true; if (i === m.correct) b.classList.add('right'); else if (b.classList.contains('picked')) b.classList.add('wrong'); });
    player.streak = m.streak; updateMe(); emit('answered', { result: m.res, streak: m.streak, level: m.level });
    const u = $('#pq-urgent');
    if (m.res === 'god') {
      $('#pq-note').textContent = '⚡ GOD MODE — streak ' + m.streak + ': you refill ' + (m.streak - 4) + ' guns!'; u.className = 'urgent good'; u.textContent = '⚡ GOD MODE ⚡';
      setTimeout(() => $('#p-quiz').classList.remove('on'), 900);
    } else if (m.res === 'right') {
      SFX.play('right');
      $('#pq-note').textContent = 'Right! Drag your ' + LEVEL_LABEL[m.level] + ' onto the board.'; u.className = 'urgent good'; u.textContent = m.streak > 1 ? '🔥 ' + m.streak + ' in a row — ' + LEVEL_LABEL[m.level] + (m.level === TOP_LEVEL ? ' (max)' : '') + '!' : '✅ Right — you get a gun!';
      if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
      pMsg(m.streak > 1 ? '🔥 STREAK ' + m.streak + '!\n' + LEVEL_LABEL[m.level] + ' unlocked' : '✅ RIGHT!\nPlace your gun', 1600);
      setTimeout(() => { $('#p-quiz').classList.remove('on'); openPlace(m.level, m.streak); }, 900);
    } else {
      $('#pq-note').textContent = m.res === 'wrong' ? 'Not this time — no gun this wave, streak lost.' : 'Too late for this wave.'; u.className = 'urgent calm'; u.textContent = '💔 No gun this wave';
      redFlash(); SFX.play('wrong'); if (navigator.vibrate) navigator.vibrate(120); pMsg('❌ WRONG!\nNo gun this wave — streak lost', 2200);
      setTimeout(() => $('#p-quiz').classList.remove('on'), 2200);
    }
    return;
  }
  if (m.t === 'quizEnd') {
    if (!player.answered && $('#p-quiz').classList.contains('on')) {
      $('#pq-opts').querySelectorAll('button').forEach((b, i) => { b.disabled = true; if (i === m.correct) b.classList.add('right'); });
      $('#pq-note').textContent = 'Time is up — no gun this wave.'; const u = $('#pq-urgent'); u.className = 'urgent calm'; u.textContent = '⏰ Too late';
      player.streak = 0; updateMe(); setTimeout(() => $('#p-quiz').classList.remove('on'), 2500);
    }
    return;
  }
  if (m.t === 'god') {
    const mine = m.id === player.id; const el = $('#p-msg'); clearTimeout(pMsg.t);
    el.textContent = (mine ? '⚡ YOU ARE IN GOD MODE ⚡\nstreak ' + m.streak : '⚡ GOD MODE ⚡\n' + m.name + ' · streak ' + m.streak) + '\n' + (m.n ? m.n + ' gun' + (m.n === 1 ? '' : 's') + ' refilled!' : 'nothing left to refill'); el.classList.add('on', 'god');
    pMsg.t = setTimeout(() => el.classList.remove('on', 'god'), mine ? 4500 : 3000);
    const g = $('#p-gold'); g.classList.add('on'); setTimeout(() => g.classList.remove('on'), mine ? 900 : 300);
    v.godBurst(m.guns); SFX.play('win'); if (navigator.vibrate) navigator.vibrate(mine ? [60, 40, 60, 40, 120] : [30, 30, 30]);
    return;
  }
  if (m.t === 'placed') {
    if (m.res === 'ok') { SFX.play('place'); closePlace(); emit('placedOwn', { x: player.sel && player.sel.x, z: player.sel && player.sel.z }); pMsg('🔫 GUN PLACED!\nIt is firing for you now', 2000); if (navigator.vibrate) navigator.vibrate(40); }
    else if (m.res === 'taken') { toast('That spot is taken — pick another'); if (player.sel) placeAt(player.sel.x, player.sel.z); }
    else closePlace();
    return;
  }
  if (m.t === 'kill') { player.kills = m.n; updateMe(); SFX.play('kill', { vol: 0.6 }); const now = performance.now(); if (now - (player.killT || 0) > 1500) { player.killT = now; pMsg('🎯 Gremlin shot! (' + m.n + ')', 900); } return; }
  if (m.t === 'bite') { redFlash(); v.hitKeep(); SFX.play('bite', { vol: 0.7 }); if (navigator.vibrate) navigator.vibrate(60); pMsg('👹 One got through!\nTower ' + m.hp + ' / ' + m.max, 1200); return; }
  if (m.t === 'msg') { pMsg(m.m, 1800); return; }
  if (m.t === 'fx') { for (const f of m.s || []) v.shot(f[0], f[1], f[2], f[3]); for (const b of m.b || []) v.boom(b[0], b[1], b[2]); return; }
  if (m.t === 'count') { pMsg('Wave ' + m.wave + ' in ' + m.n + '…', 950); SFX.play(m.n === 1 ? 'go' : 'tick'); return; }
  if (m.t === 'pause') { player.paused = m.on; const el = $('#p-msg'); clearTimeout(pMsg.t); if (m.on) { el.textContent = '⏸ Paused by the host'; el.classList.add('on'); } else el.classList.remove('on'); return; }
  if (m.t === 's') { player.snap = m; player.ph = m.ph; return; }
  if (m.t === 'over') {
    player.ph = 'over'; $('#p-quiz').classList.remove('on'); closePlace();
    const me = m.board.find(r => r.id === player.id); const rank = m.board.findIndex(r => r.id === player.id) + 1; emit('over', { won: m.won, survived: m.survived, me, rank });
    SFX.play(m.won ? 'win' : 'lose');
    const fallen = !m.won && !m.aborted; if (fallen) { v.crumbleKeep(); redFlash(); setTimeout(() => SFX.play('boom'), 1200); }
    setBtn(m.won ? 'ok' : 'hot', m.won ? '🏆 Every wave held!' : '💥 The tower fell after ' + m.survived + ' wave' + (m.survived === 1 ? '' : 's'));
    setTimeout(() => pMsg((m.won ? '🏆 LEGENDARY!\nThe tower held every wave.\n' : '💥 THE TOWER HAS FALLEN\nHeld for ' + m.survived + ' wave' + (m.survived === 1 ? '' : 's') + '.\n') + (me ? 'You shot ' + me.kills + ' gremlins (#' + rank + ')' : ''), 60000), fallen ? 3500 : 0);
  }
}
function updateMe() { $('#p-streak').textContent = player.streak; $('#p-kills').textContent = player.kills; $('#p-guns').textContent = player.gunsN; }
function showQuiz(m) {
  player.answered = !!m.done;
  $('#pq-q').textContent = '❓ Wave ' + m.wave + ': ' + m.q;
  $('#pq-opts').innerHTML = m.opts.map((o, i) => `<button data-i="${i}">${esc(o)}</button>`).join('');
  $('#pq-note').textContent = m.done ? 'Already answered this wave.' : '✅ Right = place a ' + LEVEL_LABEL[Math.min(TOP_LEVEL, player.streak)] + ' · ❌ Wrong = no gun, streak lost';
  $('#pq-opts').querySelectorAll('button').forEach(b => { b.disabled = !!m.done; b.onclick = () => { player.answered = true; b.classList.add('picked'); $('#pq-opts').querySelectorAll('button').forEach(x => x.disabled = true); player.link.send({ t: 'ans', i: +b.dataset.i }); }; });
  const u = $('#pq-urgent'); u.className = 'urgent' + (m.done ? ' calm' : ''); u.textContent = player.streak > 0 ? '🔥 Streak ' + player.streak + ' — answer right for a ' + LEVEL_LABEL[Math.min(TOP_LEVEL, player.streak)] + '!' : '⚠️ Gremlins are already marching! Answer right to place a gun';
  $('#pq-time').style.width = (100 * (m.left || player.quizTime) / player.quizTime) + '%';
  $('#p-quiz').classList.add('on');
}
/* --- placement: a top-down map of the board on the phone --- */
function openPlace(level, streak) {
  player.pending = { level }; player.sel = null; $('#b-place').disabled = true;
  $('#pl-h').textContent = 'Place your ' + LEVEL_LABEL[level] + (streak > 1 ? ' (streak ' + streak + ')' : '');
  $('#pl-hint').textContent = '👆 Drag the gun onto a free tile on the board';
  $('#p-place').classList.add('on'); player.type = TR.LEVEL_GUN[level]; player.view.setGhostGun(player.type, level);
  const v = player.view; v.onPick = pickAt;
  // Start the preview on a sensible free tile so there is something to drag right away.
  const start = [[4, 1], [2, 2], [4, 5], [7, 3], [8, 4], [5, 5], [10, 3], [2, 0]].find(([x, z]) => TR.freeTile({ guns: player.guns }, x, z));
  if (start) placeAt(start[0], start[1]);
}
function closePlace() { player.pending = null; player.sel = null; $('#p-place').classList.remove('on'); const v = player.view; v.onPick = null; v.setGhost(null); }
function pickAt(cx, cy) { const t = player.view.pickTile(cx, cy); if (t) placeAt(t.x, t.z); }
function placeAt(x, z) {
  if (!player.pending) return;
  const ok = TR.freeTile({ guns: player.guns }, x, z); const key = x + ',' + z;
  player.view.setGhost(x, z, gunRange(), ok);
  player.sel = ok ? { x, z } : null; $('#b-place').disabled = !ok;
  $('#pl-hint').textContent = ok ? 'This spot covers ' + TR.coverage(x, z, gunRange()) + ' road points — tap Place' : TR.PATH_SET.has(key) ? '🚫 Not on the road — drag onto grass' : player.guns.some(g => g.x === x && g.z === z) ? '🚫 That spot has a gun already' : '🚫 Blocked — drag onto a free tile';
  if (ok && (!player.lastSel || player.lastSel !== key)) { player.lastSel = key; if (navigator.vibrate) navigator.vibrate(8); }
}
function gunRange() { return TR.LEVELS[player.pending ? player.pending.level : 0].range; }
$('#b-place').onclick = () => { if (!player.sel || !player.pending) return; $('#b-place').disabled = true; $('#pl-hint').textContent = 'Placing…'; player.link.send({ t: 'place', x: player.sel.x, z: player.sel.z }); };
$('#b-onboard').onclick = () => { SFX.unlock(); SFX.play('go'); $('#p-onboard').classList.remove('on'); if ($('#onboard-skip').checked) { try { localStorage.setItem('tk-tr-onboard', '1'); } catch (e) {} } };
$('#p-recenter').onclick = () => { const v = player.view; if (!v) return; v.cam.theta = v.cam.portrait ? Math.PI / 2 - 0.35 : -0.55; v.cam.phi = 0.95; v.cam.fit = 0; v.fitBoard(); };
function setBtn(cls, text) { const b = $('#p-btn'); b.className = cls; b.textContent = text; }
function redFlash() { const r = $('#p-red'); r.classList.add('on'); setTimeout(() => r.classList.remove('on'), 120); }
function pMsg(text, ms) { const el = $('#p-msg'); el.classList.remove('god'); el.textContent = text; el.classList.add('on'); clearTimeout(pMsg.t); pMsg.t = setTimeout(() => el.classList.remove('on'), ms); }

function playerTick(ts) {
  requestAnimationFrame(playerTick);
  const v = player.view; if (!v) return;
  const dt = Math.min(0.1, Math.max(0.001, ((ts || performance.now()) - (player.frameT || ts || performance.now())) / 1000)); player.frameT = ts || performance.now();
  const s = player.snap;
  if (s) {
    v.applyEnemies(s.e); v.gunYaw = s.gy; v.applyGuns(s.gh, s.ga);
    for (const g of v.guns) if (g && g.low && g.owner === player.id && !g.warned) { g.warned = true; SFX.play('low'); }
    const bar = $('#p-thp'); bar.style.width = (100 * s.th / s.tm) + '%'; bar.classList.toggle('low', s.th <= s.tm * 0.3); $('#p-tpct').textContent = s.th + '/' + s.tm;
    $('#p-wave').textContent = s.w; $('#p-left').textContent = s.ph === 'wave' ? s.left : '–';
    if (s.ph === 'wave' || s.ph === 'final') {
      $('#pq-time').style.width = Math.max(0, 100 * s.ql / player.quizTime) + '%';
      phaseStrip($('#p-phases'), [s.ql, s.pl, s.nl], [player.quizTime, player.placeTime, player.between], s.ph);
      if (player.pending) {   // answered early? the rest of the answer phase plus the whole placement phase is yours to place in
        const leftToPlace = s.ql > 0 ? s.ql + player.placeTime : s.pl; const full = player.quizTime + player.placeTime;
        $('#pl-time').style.width = Math.max(0, 100 * leftToPlace / full) + '%'; $('#pl-clock').textContent = '⏱ ' + Math.max(0, leftToPlace) + ' s to place' + (leftToPlace <= 3 ? ' — hurry!' : '');
        $('#pl-time').style.background = leftToPlace <= 3 ? 'var(--red)' : 'var(--gold)';
      }
    }
    if (player.ph === 'over') {}
    else if (player.paused) setBtn('', '⏸ Paused');
    else if (s.ph === 'final') setBtn('ok', '⚔️ Last wave held — clear the road! 👹 ' + s.left);
    else if (player.pending) setBtn('hot', '📍 Place your gun' + (s.pl > 0 ? ' — ' + s.pl + ' s' : '') + '!');
    else if (s.ph === 'wave' && !player.answered && s.ql > 0) setBtn('hot', '❓ Answer the quiz — ' + s.ql + ' s');
    else if (s.ph === 'wave' && s.pl > 0) setBtn('', '📍 Guns being placed — ' + s.pl + ' s');
    else if (s.ph === 'wave') setBtn('ok', '⚔️ Wave ' + s.w + ' · 👹 ' + s.left + ' · next quiz in ' + s.nl + ' s');
    else setBtn('', s.ph === 'lobby' ? 'Waiting for the host…' : 'Waiting…');
  }
  v.frame(player.paused ? 0 : dt);
}

/* ===================== ENTRY ===================== */
$('#b-host').onclick = () => { startHost(); hostTick(); };
$('#b-join').onclick = () => { const c = $('#in-code').value.trim().toUpperCase(); if (/^[A-Z0-9]{4,8}$/.test(c)) askName(c); else toast('Enter the 4-letter room code'); };
$('#in-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('#b-join').click(); });
function askName(code) {
  show('s-join'); $('#j-code').textContent = code;
  try { $('#in-name').value = CONFIG.player.name || (CONFIG.player.rememberName && localStorage.getItem('tk-name')) || ''; } catch (e) {}
  const go = () => { const n = $('#in-name').value.trim().slice(0, 16) || 'Defender'; if (CONFIG.player.rememberName) { try { localStorage.setItem('tk-name', n); } catch (e) {} } joinGame(code, n); };
  $('#b-go').onclick = go; $('#in-name').onkeydown = e => { if (e.key === 'Enter') go(); };
  setTimeout(() => $('#in-name').focus(), 50);
}
// ------------------------------------------------------------ the GremlinSiege API (see tr-config.js for events and settings)
Object.assign(GremlinSiege, {
  host() { startHost(); hostTick(); },
  join(code, name) { code = String(code || '').toUpperCase(); if (!/^[A-Z0-9]{4,8}$/.test(code)) return false; if (name) joinGame(code, String(name).slice(0, 16)); else askName(code); return true; },
  start() { if (host.S && host.S.phase === 'lobby') $('#b-start').click(); },
  pause(on) { setPaused(on === undefined ? !host.paused : !!on); },
  nextWave() { if (host.S && host.S.phase === 'wave') host.S.cycleLeft = 0; },
  end() { if (host.running) finish(false, true); },
  setPartySize(n) { host.total = Math.max(1, Math.min(CONFIG.host.maxParty, n | 0)); if (host.S) { TR.setBots(host.S, host.total); renderRoster(); sendRoster(); } },
  state() { const S = host.S; return S ? { code: host.code, phase: S.phase, wave: S.wave, tower: { hp: Math.max(0, S.tower.hp), max: S.tower.max }, quizLeft: Math.ceil(S.quizLeft), placeLeft: Math.ceil(S.placeLeft), guns: TR.gunList(S).filter(g => !g.dead).length, players: TR.roster(S), paused: !!host.paused } : null; },
  sound: { effects(on) { SFX.setOn(!!on); soundButtons(); }, music(on) { SFX.setMusic(!!on); soundButtons(); if (on && host.running) SFX.startMusic(); } },
});
{
  trApplyConfig();
  const q = new URLSearchParams(location.search);
  const join = (q.get('join') || '').toUpperCase(); const name = (CONFIG.player.name || '').trim();
  if (/^[A-Z0-9]{4,8}$/.test(join)) { if (name) joinGame(join, name.slice(0, 16)); else askName(join); }
  else if (q.has('host')) { startHost(); hostTick(); if (CONFIG.host.autoStart) GremlinSiege.on((n) => { if (n === 'room') setTimeout(() => GremlinSiege.start(), 500); }); }
  else show('s-home');
  emit('ready', { config: CONFIG });
}
