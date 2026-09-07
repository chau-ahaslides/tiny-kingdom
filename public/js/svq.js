/* Survival Quiz — answer quizzes to grow strong, then survive the battle royale.
   Modes: solo (default) · host (?host=1 — desktop runs the sim, phones scan to join) · client (?join=CODE).
   Multiplayer is host-authoritative: phones send inputs, the host streams snapshots.
   Quizzes stay on the field until someone answers CORRECTLY — wrong answers hurt only the answerer. */
(async () => {
const rnd = (a, b) => a + Math.random() * (b - a);
const qs = new URLSearchParams(location.search);
const MODE = qs.get('join') ? 'client' : (qs.has('host') ? 'host' : 'solo');
const JOIN_CODE = (qs.get('join') || '').toUpperCase();
const P = Math.max(4, Math.min(20, parseInt(qs.get('players'), 10) || 12));

// ---------- quiz pool (randomized for now — inject window.QUIZ_POOL later) ----------
const QUIZ_POOL = window.QUIZ_POOL || [
  { q: '7 × 8 = ?', a: ['54', '56', '63'], c: 1 },
  { q: 'Capital of France?', a: ['Berlin', 'Madrid', 'Paris'], c: 2 },
  { q: 'A spider has how many legs?', a: ['6', '8', '10'], c: 1 },
  { q: 'The largest ocean?', a: ['Atlantic', 'Indian', 'Pacific'], c: 2 },
  { q: '12 + 15 = ?', a: ['27', '25', '29'], c: 0 },
  { q: 'Blue + yellow makes…', a: ['Green', 'Purple', 'Orange'], c: 0 },
  { q: 'Days in a week?', a: ['5', '6', '7'], c: 2 },
  { q: 'The sun rises in the…', a: ['West', 'East', 'North'], c: 1 },
  { q: 'Which animal gives wool?', a: ['Sheep', 'Duck', 'Cat'], c: 0 },
  { q: '9 × 9 = ?', a: ['72', '81', '99'], c: 1 },
  { q: 'H₂O is…', a: ['Salt', 'Water', 'Air'], c: 1 },
  { q: 'Sides of a hexagon?', a: ['5', '6', '8'], c: 1 },
  { q: '100 − 37 = ?', a: ['63', '73', '67'], c: 0 },
  { q: 'Fastest land animal?', a: ['Horse', 'Cheetah', 'Lion'], c: 1 },
  { q: 'How many minutes in an hour?', a: ['60', '100', '90'], c: 0 },
  { q: 'A baby sheep is a…', a: ['Calf', 'Lamb', 'Kid'], c: 1 },
];
const pickQuiz = () => QUIZ_POOL[Math.floor(Math.random() * QUIZ_POOL.length)];
window.QUIZ_POOL_ACTIVE = QUIZ_POOL;                               // ground truth for harness probes

// ---------- combat constants ----------
const CFG = { dmgMin: 24, dmgMax: 36, crit: 15, critMult: 2.1, heal: 25, cdMin: .8, cdMax: 1.3,
              spdMin: 175, spdMax: 215, arrDmgMin: 11, arrDmgMax: 18, arrCdMin: .9, arrCdMax: 1.4 };
const QUIZ_DMG = [14, 22], QUIZ_HEAL = 35, QUIZ_STR = 15, STR_MAX = 75;   // right answers pay well
let quizTotal = Math.max(10, Math.min(300, parseInt(qs.get('quiz'), 10) || parseInt(localStorage.getItem('tk-quiztime') || '60', 10) || 60));
let quizLeft = quizTotal;
const lenin = document.getElementById('lenin');
lenin.value = quizTotal;
lenin.addEventListener('input', () => {
  const v = parseInt(lenin.value, 10);
  if (isNaN(v) || v < 5) return;
  quizLeft = Math.max(1, quizLeft + (v - quizTotal));
  quizTotal = v;
  try { localStorage.setItem('tk-quiztime', String(v)); } catch (e) {}
});
if (MODE === 'client') document.getElementById('lenbox').style.display = 'none';
const banner = document.getElementById('banner');

// ---------- kits & fighter data ----------
const COLORS = ['Blue', 'Red', 'Yellow', 'Purple', 'Black'];
const TYPES = ['Warrior', 'Archer', 'Lancer', 'Pawn'];
const FRAMES = { Warrior: { Idle: 8, Run: 6, Attack: 4 }, Archer: { Idle: 6, Run: 4, Shoot: 8 },
                 Lancer: { Idle: 12, Run: 6, Attack: 3 }, Pawn: { Idle: 8, Run: 6, Attack: 6 } };
const CELL = { Lancer: 320 };
const MELEE = {
  Warrior: { close: 52, reach: 60, stand: 40, hold: .42, at: .26, fps: 10, dmgF: 1.2, cdF: 1, lunge: 14 },
  Lancer:  { close: 95, reach: 108, stand: 84, hold: .34, at: .2, fps: 9, dmgF: 1.15, cdF: 1.1, lunge: 8 },
  Pawn:    { close: 44, reach: 50, stand: 34, hold: .45, at: .3, fps: 14, dmgF: 1, cdF: .75, lunge: 12 },
};
const LABEL = { Warrior: 'Knight', Archer: 'Archer', Lancer: 'Lancer', Pawn: 'Pawn' };
const ANIMS = ['Idle', 'Run', 'Attack', 'Shoot'];
const ANIMI = { Idle: 0, Run: 1, Attack: 2, Shoot: 3 };
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function fighterProps(p) {
  return Object.assign(p, {
    hp: 100, str: 0, dmg: 0, dead: false, opp: null, state: 'wander', cd: rnd(.2, .6),
    wx: 0, wy: 0, wt: 0, swx: 0, swy: 0, speed: (p.human || p.remote) ? 225 : rnd(CFG.spdMin, CFG.spdMax),
    pend: null, pendShot: null, lunge: 0, lvx: 0, lvy: 0, hopT: 0, face: 1,
    tx: null, ty: null, qtarget: null, answerT: 0, qretry: 0, quizQ: null, quizDef: null, quizT: 0,
    qlockQ: null, qlockT: 0,
  });
}
let players = [];
let human = null;                 // solo: You · client: own fighter · host: null
const byId = {};

// ---------- networking (host & client) ----------
let sock = null, started = MODE === 'solo';
const lobby = new Map();
let myId = null, spectate = false, joinName = '', lastMsgAt = 0, clientReconnect = null;
function mpAll(o) { if (sock && sock.readyState === 1) { try { sock.send(JSON.stringify(o)); } catch (e) {} } }
function mpTo(id, o) { o.to = id; mpAll(o); }

// ---------- PIXI stage: fixed world, fit or follow ----------
PIXI.BaseTexture.defaultOptions.scaleMode = PIXI.SCALE_MODES.NEAREST;
const app = new PIXI.Application({ resizeTo: window, background: 0x3d7fc4, antialias: false,
  resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: true });
document.getElementById('stage').appendChild(app.view);
const W0 = 1440, H0 = 810;
const world = new PIXI.Container();
let water = null;
let followMode = false, camZoom = 1, playW = 0;
function fitWorld() {
  const w = app.screen.width, h = app.screen.height;
  const bw = w > 820 ? 372 : 0;                                   // the leaderboard owns the right edge on desktop
  const f = Math.min((w - bw) / W0, h / H0);
  followMode = f < .55 && MODE !== 'host';
  playW = followMode ? w : w - bw;
  if (followMode) {
    camZoom = Math.max(1, h / H0, w / W0);
    world.scale.set(camZoom);
  } else {
    world.scale.set(f);
    world.x = (w - bw - W0 * f) / 2;
    world.y = (h - H0 * f) / 2;
  }
  if (water) { water.width = w; water.height = h; }
}
function updateCamera(dt, snap) {
  if (!followMode) return;
  let t = human;
  if (!t || t.dead) {
    const alive = players.filter(p => !p.dead);
    if (alive.length) t = alive.reduce((a, b) => (b.state === 'champion' || b.hp > a.hp) ? b : a);
  }
  if (!t) return;
  const w = app.screen.width, h = app.screen.height;
  const tx = Math.max(w - W0 * camZoom, Math.min(0, w / 2 - t.x * camZoom));
  const ty = Math.max(h - H0 * camZoom, Math.min(0, h / 2 - (t.y - 40) * camZoom));
  const k = snap ? 1 : Math.min(1, dt * 4);
  world.x += (tx - world.x) * k;
  world.y += (ty - world.y) * k;
}
const INK = 0x2b2b3d;

// load everything — multiplayer rosters are only known at start time
const urls = new Set(['tilemap', 'water-blue', 'foam', 'tower', 'house1', 'house2', 'tree1', 'tree2',
  'rock1', 'rock2', 'gold1', 'gold4', 'bush1', 'bush2', 'sheep_idle', 'cloud1', 'cloud2']
  .map(n => '/img/' + n + '.png'));
COLORS.forEach(c => { TYPES.forEach(t => { for (const st in FRAMES[t]) urls.add('/img/2x/' + c + '_' + t + '_' + st + '.png'); }); urls.add('/img/ribs_' + c + '.png'); });
urls.add('/img/2x/arrow.png');
await PIXI.Assets.load([...urls]);
for (const u of urls) if (u.indexOf('/img/2x/') === 0) {
  const t = PIXI.Assets.get(u);
  t.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
  t.baseTexture.mipmap = PIXI.MIPMAP_MODES.ON;
}
try { await document.fonts.load('bold 48px MedievalSharp'); } catch (e) {}

const texCache = {};
function frameTex(url, i, fw, fh) {
  const key = url + '#' + i;
  if (!texCache[key]) {
    const t = PIXI.Assets.get(url);
    texCache[key] = new PIXI.Texture(t.baseTexture, new PIXI.Rectangle(i * fw, 0, fw, fh));
  }
  return texCache[key];
}
const foamL = new PIXI.Container(), tileL = new PIXI.Container(),
      scene = new PIXI.Container(), skyL = new PIXI.Container();
scene.sortableChildren = true;
water = new PIXI.TilingSprite(PIXI.Assets.get('/img/water-blue.png'), 10, 10);
app.stage.addChild(water, world);
world.addChild(foamL, tileL, scene, skyL);
app.renderer.on('resize', fitWorld);

// ---------- scenery ----------
let ISL = null;
const OBST = [];
const inObst = (x, y) => OBST.some(o => x > o.x && x < o.x + o.w && y > o.y && y < o.y + o.h);
const BOUNDS = () => ({ x0: ISL.x + 42, x1: ISL.x + ISL.w - 42, y0: ISL.y + 96, y1: ISL.y + ISL.h - 44 });
const clouds = [];

function sprite(url, x, y, w, z) {
  const t = PIXI.Assets.get(url);
  const sp = new PIXI.Sprite(t);
  sp.x = x; sp.y = y;
  sp.scale.set(w / t.width);
  sp.zIndex = z !== undefined ? z : Math.round(y);
  scene.addChild(sp);
  return sp;
}
function variantSprite(url, fw, fh, variant, x, y, scale) {
  const sp = new PIXI.Sprite(frameTex(url, variant, fw, fh));
  sp.x = x; sp.y = y; sp.scale.set(scale);
  sp.zIndex = Math.round(y + fh * scale - 8);
  scene.addChild(sp);
  return sp;
}
function buildScenery() {
  const cols = 21, rows = 9;
  const ix = Math.round((W0 - cols * 64) / 2), iy = 110;
  ISL = { x: ix, y: iy, w: cols * 64, h: rows * 64 };
  const foamFrames = Array.from({ length: 16 }, (_, i) => frameTex('/img/foam.png', i, 192, 192));
  const foam = (x, y) => {
    const f = new PIXI.AnimatedSprite(foamFrames);
    f.x = x - 64; f.y = y - 64;
    f.animationSpeed = (16 / 1.8) / 60;
    f.gotoAndPlay(Math.floor(rnd(0, 16)));
    foamL.addChild(f);
  };
  for (let c = 0; c < cols; c++) { foam(ix + c * 64, iy); foam(ix + c * 64, iy + (rows - 1) * 64); }
  for (let r = 1; r < rows - 1; r++) { foam(ix, iy + r * 64); foam(ix + (cols - 1) * 64, iy + r * 64); }
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const tc = c === 0 ? 0 : c === cols - 1 ? 2 : 1, tr = r === 0 ? 0 : r === rows - 1 ? 2 : 1;
      const t = PIXI.Assets.get('/img/tilemap.png');
      const sp = new PIXI.Sprite(new PIXI.Texture(t.baseTexture, new PIXI.Rectangle(tc * 64, tr * 64, 64, 64)));
      sp.x = ix + c * 64; sp.y = iy + r * 64;
      tileL.addChild(sp);
    }
  sprite('/img/tower.png', ix + 34, iy + 14, 120, iy + 14 + 240);
  sprite('/img/tower.png', ix + ISL.w - 154, iy + 14, 120, iy + 14 + 240);
  sprite('/img/house1.png', ix + 60, iy + ISL.h - 250, 116, iy + ISL.h - 250 + 174);
  sprite('/img/house2.png', ix + ISL.w - 180, iy + ISL.h - 250, 116, iy + ISL.h - 250 + 174);
  const rnd8 = () => Math.floor(rnd(0, 8));
  variantSprite('/img/tree1.png', 192, 256, rnd8(), ix + 20, iy + ISL.h - 296, .85);
  variantSprite('/img/tree2.png', 192, 256, rnd8(), ix + ISL.w - 205, iy + ISL.h - 306, .9);
  sprite('/img/rock1.png', ix + ISL.w * .3, iy + ISL.h - 82, 46);
  sprite('/img/rock2.png', ix + ISL.w * .64, iy + ISL.h - 72, 50);
  sprite('/img/gold1.png', ix + 96, iy + ISL.h - 128, 52);
  variantSprite('/img/bush1.png', 128, 128, rnd8(), ix + ISL.w * .44, iy + ISL.h - 112, .75);
  variantSprite('/img/bush2.png', 128, 128, rnd8(), ix + ISL.w * .8, iy + 148, .7);
  const sheepFr = Array.from({ length: 6 }, (_, i) => frameTex('/img/sheep_idle.png', i, 128, 128));
  const sheep = new PIXI.AnimatedSprite(sheepFr);
  sheep.x = ix + ISL.w * .12; sheep.y = iy + 156; sheep.scale.set(.8);
  sheep.animationSpeed = (6 / 1.5) / 60; sheep.play();
  sheep.zIndex = Math.round(iy + 156 + 128 * .8 - 8);
  scene.addChild(sheep);
  const mkCloud = (n, y, w2, sp2, op) => {
    const c = new PIXI.Sprite(PIXI.Assets.get('/img/' + n + '.png'));
    c.y = y; c.x = rnd(-300, W0); c.alpha = op;
    c.scale.set(w2 / c.texture.width);
    skyL.addChild(c);
    clouds.push({ c, sp: sp2 });
  };
  mkCloud('cloud1', 8, 300, 1.55 * W0 / 75, .8);
  mkCloud('cloud2', H0 * .78, 240, 1.55 * W0 / 105, .7);
  OBST.length = 0;
  OBST.push({ x: ix + 34, y: iy + 164, w: 120, h: 92 });
  OBST.push({ x: ix + ISL.w - 154, y: iy + 164, w: 120, h: 92 });
  OBST.push({ x: ix + 60, y: iy + ISL.h - 166, w: 116, h: 92 });
  OBST.push({ x: ix + ISL.w - 180, y: iy + ISL.h - 166, w: 116, h: 92 });
  OBST.push({ x: ix + 80, y: iy + ISL.h - 143, w: 44, h: 60 });
  OBST.push({ x: ix + ISL.w - 142, y: iy + ISL.h - 144, w: 47, h: 63 });
  OBST.push({ x: ix + ISL.w * .3, y: iy + ISL.h - 74, w: 46, h: 32 });
  OBST.push({ x: ix + ISL.w * .64, y: iy + ISL.h - 62, w: 50, h: 34 });
  OBST.push({ x: ix + 96, y: iy + ISL.h - 114, w: 52, h: 34 });
}

// ---------- FX ----------
const FXS = [];
function fx(o, dur, fn, end) { FXS.push({ o, t: 0, dur, fn, end }); }
function fxTick(dt) {
  for (let i = FXS.length - 1; i >= 0; i--) {
    const f = FXS[i];
    if (f.o && f.o.destroyed) { FXS.splice(i, 1); continue; }
    f.t += dt;
    const k = Math.min(1, f.t / f.dur);
    f.fn(f.o, k);
    if (k >= 1) { if (f.end) f.end(f.o); FXS.splice(i, 1); }
  }
}
const TXT = (str, size, fill) => {
  const t = new PIXI.Text(str, {
    fontFamily: 'MedievalSharp, Georgia, serif', fontSize: size, fontWeight: 'bold',
    fill, stroke: INK, strokeThickness: Math.max(3, size / 7),
  });
  t.texture.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
  return t;
};
function floatTxt(p, text, color, size) {
  if (!p || !p.ui || p.ui.destroyed) return;
  const t = TXT(text, size || 22, color);
  t.anchor.set(.5); t.y = -165;
  p.ui.addChild(t);
  fx(t, 1, (o, k) => { o.y = -165 - 54 * k; o.alpha = 1 - k * k; }, o => o.destroy());
}
function star(p, ch) {
  if (!p || !p.ui || p.ui.destroyed) return;
  const t = TXT(ch, 34, 0xffffff);
  t.anchor.set(.5); t.y = -110;
  p.ui.addChild(t);
  fx(t, .9, (o, k) => { o.scale.set(.3 + 1.6 * k); o.rotation = .7 * k; o.alpha = 1 - k; }, o => o.destroy());
}
let crownTime = 0;
const crowns = [];
function addCrown(p) {
  const t = TXT('\u{1F451}', 30, 0xffd24a);
  t.anchor.set(.5); t.y = -205;
  p.ui.addChild(t);
  crowns.push(t);
}

// ---------- fighters ----------
function setBars(p) {
  const g = p.hpg;
  g.clear();
  g.beginFill(INK, .8).drawRoundedRect(-43, -136, 86, 22, 6).endFill();
  const col = p.hp <= 35 ? 0xe2792b : 0x4fcf4f;
  if (p.hp > 0) g.beginFill(col).drawRoundedRect(-39, -132, Math.max(2, 78 * p.hp / 100), 6, 3).endFill();
  if (p.str > 0) g.beginFill(0xffc93c).drawRoundedRect(-39, -123, Math.max(2, 78 * Math.min(1, p.str / STR_MAX)), 5, 2).endFill();
  else g.beginFill(0x6b6b80, .6).drawRoundedRect(-39, -123, 78, 5, 2).endFill();
}
function makeFighter(p) {
  const cont = new PIXI.Container();
  const body = new PIXI.Container();
  const ui = new PIXI.Container();
  const cell = CELL[p.t] || 192;
  const spr = new PIXI.Sprite(frameTex('/img/2x/' + p.c + '_' + p.t + '_Idle.png', 0, cell * 2, cell * 2));
  spr.anchor.set(.5, cell === 320 ? 203 / 320 : 142 / 192);
  spr.scale.set(.5);
  body.addChild(spr);
  const ribTex = PIXI.Assets.get('/img/ribs_' + p.c + '.png');
  ribTex.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
  const plane = new PIXI.NineSlicePlane(ribTex, 40, 0, 40, 0);
  const isMe = p.human || (MODE === 'client' && p.id === myId);
  const nameT = TXT(p.name, 17, isMe ? 0xffd24a : 0xffffff);
  nameT.anchor.set(.5);
  const pw = Math.max(102, nameT.width + 86);
  plane.width = pw; plane.height = 44;
  nameT.x = pw / 2; nameT.y = 18;
  const ribC = new PIXI.Container();
  ribC.addChild(plane, nameT);
  ribC.pivot.set(pw / 2, 0);
  ribC.y = -182;
  const hpg = new PIXI.Graphics();
  ui.addChild(ribC, hpg);
  cont.addChild(body, ui);
  scene.addChild(cont);
  p.cont = cont; p.body = body; p.ui = ui; p.spr = spr; p.hpg = hpg; p.cell = cell;
  setBars(p);
  const b = BOUNDS();
  if (p.x === undefined) {
    for (let t = 0; t < 25; t++) { p.x = rnd(b.x0, b.x1); p.y = rnd(b.y0, b.y1); if (!inObst(p.x, p.y)) break; }
  }
  p.animKey = ''; p.animT = 0;
  setAnim(p, 'Idle');
  draw(p, 0);
}
function setAnim(p, st, force) {
  const key = p.c + '_' + p.t + '_' + st;
  if (p.animKey === key && !force) return;
  p.animKey = key; p.animT = 0; p.animN = FRAMES[p.t][st]; p.animSt = st;
  p.sheet = '/img/2x/' + key + '.png';
}
function pop(text) { const rp = document.getElementById('roundpop'); rp.querySelector('.rm').textContent = text; rp.classList.remove('pop'); void rp.offsetWidth; rp.classList.add('pop'); }

// ---------- quiz objects: shared — ANY player may answer; the first CORRECT answer destroys it ----------
const quizzes = [];
const respawns = [];
function quizVisual(x, y) {
  const cont = new PIXI.Container();
  const g = new PIXI.Sprite(PIXI.Assets.get('/img/gold4.png'));
  g.anchor.set(.5, .8); g.scale.set(.5);
  const qm = TXT('❓', 30, 0xffd24a);
  qm.anchor.set(.5); qm.y = -52;
  cont.addChild(g, qm);
  cont.x = x; cont.y = y;
  cont.zIndex = Math.round(y);
  scene.addChild(cont);
  return { cont, qm };
}
function spawnQuiz() {
  const b = BOUNDS();
  let x = 0, y = 0, ok = false;
  for (let t = 0; t < 40 && !ok; t++) {
    x = rnd(b.x0 + 30, b.x1 - 30); y = rnd(b.y0 + 20, b.y1 - 10);
    ok = !inObst(x, y) && quizzes.every(q => Math.hypot(q.x - x, q.y - y) > 150);
  }
  const v = quizVisual(x, y);
  const q = { x, y, cont: v.cont, qm: v.qm, t: rnd(0, 6.28) };
  quizzes.push(q);
  return q;
}
function consumeQuiz(q) {
  const i = quizzes.indexOf(q);
  if (i >= 0) quizzes.splice(i, 1);
  fx(q.cont, .35, (c, k) => { c.alpha = 1 - k; c.scale.set(1 + .4 * k); }, c => { scene.removeChild(c); c.destroy({ children: true }); });
  if (phase === 'quiz') respawns.push(rnd(1, 2.2));
  players.forEach(p => { if (p.qtarget === q) p.qtarget = null; });
}
function lockQuiz(p, q) { p.qlockQ = q; p.qlockT = 2.6; }         // wrong answer: step back before retrying this one
function canEngage(p, q) { return !(p.qlockQ === q && p.qlockT > 0); }
function applyQuizResult(p, right) {
  const res = { right };
  if (right) {
    const h0 = p.hp, s0 = p.str;
    p.hp = Math.min(100, p.hp + QUIZ_HEAL);
    p.str = Math.min(STR_MAX, p.str + QUIZ_STR);
    res.healed = Math.round(p.hp - h0); res.strGain = p.str - s0;
    floatTxt(p, '+' + QUIZ_HEAL + ' ❤', 0x7ef17e, 24);
    setTimeout(() => { if (!p.dead) floatTxt(p, '+' + QUIZ_STR + ' ⚡', 0xffc93c, 22); }, 350);
    p.hopT = .55;
  } else {
    const d = Math.round(rnd(QUIZ_DMG[0], QUIZ_DMG[1]));
    p.hp = Math.max(4, p.hp - d);
    res.dmg = d;
    floatTxt(p, '−' + d, 0xff8080, 24);
    p.spr.tint = 0xff9d9d; setTimeout(() => { p.spr.tint = 0xffffff; }, 220);
  }
  setBars(p);
  refreshBoard();
  return res;
}

// ---------- HUD compass + tap input ----------
const guide = new PIXI.Sprite(PIXI.Assets.get('/img/2x/arrow.png'));
guide.anchor.set(.5); guide.scale.set(.85); guide.tint = 0xffd24a; guide.visible = false;
app.stage.addChild(guide);
let tapMark = null;
function showTap(x, y) {
  if (tapMark) { scene.removeChild(tapMark); tapMark.destroy(); }
  const m = new PIXI.Graphics();
  m.lineStyle(3, 0xffd24a, .9).drawCircle(0, 0, 14);
  m.x = x; m.y = y; m.zIndex = 5;
  scene.addChild(m); tapMark = m;
  fx(m, .6, (o, k) => { o.scale.set(1 - .5 * k); o.alpha = 1 - k; }, o => { if (tapMark === o) tapMark = null; if (o.parent) scene.removeChild(o); o.destroy(); });
}
document.addEventListener('dblclick', e => e.preventDefault(), { passive: false });
['gesturestart', 'gesturechange', 'gestureend'].forEach(g => document.addEventListener(g, e => e.preventDefault(), { passive: false }));
app.view.addEventListener('pointerdown', e => {
  if (phase !== 'quiz' || quizOpen || !started) return;
  const r = app.view.getBoundingClientRect();
  const wx = (e.clientX - r.left - world.x) / world.scale.x;
  const wy = (e.clientY - r.top - world.y) / world.scale.y;
  const b = BOUNDS();
  const tx = Math.max(b.x0, Math.min(b.x1, wx)), ty = Math.max(b.y0, Math.min(b.y1, wy));
  if (MODE === 'client') {
    if (!human || human.dead || spectate) return;
    mpAll({ t: 'input', x: Math.round(tx), y: Math.round(ty) });
    human.ptx = tx; human.pty = ty;                               // predict yourself — everyone else is playback
    showTap(tx, ty);
  } else if (MODE === 'solo') {
    if (!human || human.dead) return;
    human.tx = tx; human.ty = ty;
    showTap(tx, ty);
  }
});
function guideTo(target, nearest) {
  guide.visible = true;
  guide.x = playW / 2;
  guide.y = app.screen.height - 54;
  guide.rotation = Math.atan2(nearest[1] - target.y, nearest[0] - target.x);
  guide.alpha = .8 + .2 * Math.sin(crownTime * 5);
}
function updateGuide(target) {
  if (!target || target.dead || !quizzes.length || quizOpen || phase !== 'quiz') { guide.visible = false; return; }
  let best = null, bd = 1e9;
  for (const q of quizzes) { const d = Math.hypot(q.x - target.x, q.y - target.y); if (d < bd) { bd = d; best = q; } }
  guideTo(target, [best.x, best.y]);
}

// ---------- quiz modal ----------
let quizOpen = false, quizOpenedAt = 0;
const qbox = document.getElementById('quizbox');
function fillModal(quizDef, onPick) {
  const opts = document.getElementById('qopts');
  const qres = document.getElementById('qres');
  document.getElementById('qq').textContent = quizDef.q;
  opts.innerHTML = ''; qres.style.display = 'none';
  let answered = false;
  const btns = [];
  quizDef.a.forEach((txt, i) => {
    const bBtn = document.createElement('button');
    bBtn.textContent = txt;
    bBtn.addEventListener('click', () => {
      if (answered) return;
      answered = true;
      onPick(i, btns);
    });
    btns.push(bBtn);
    opts.appendChild(bBtn);
  });
  qbox.style.display = 'flex';
  quizOpen = true;
  quizOpenedAt = performance.now();
  return btns;
}
function showModalResult(res, chosen, btns) {
  const qres = document.getElementById('qres');
  btns[chosen].classList.add(res.right ? 'good' : 'bad');
  if (!res.right && res.correct !== undefined && btns[res.correct]) btns[res.correct].classList.add('good');
  qres.className = res.right ? 'good' : 'bad';
  qres.textContent = res.right ? '✔  +' + (res.healed || 0) + ' ❤   +' + (res.strGain || 0) + ' ⚡' : '✘  −' + res.dmg + ' ❤';
  qres.style.display = 'block';
  setTimeout(() => { qbox.style.display = 'none'; quizOpen = false; }, 1250);
}
function openQuizSolo(q) {
  const quizDef = pickQuiz();
  fillModal(quizDef, (i, btns) => {
    const right = i === quizDef.c;
    const res = applyQuizResult(human, right);
    res.correct = quizDef.c;
    showModalResult(res, i, btns);
    if (right) setTimeout(() => { if (quizzes.indexOf(q) >= 0) consumeQuiz(q); }, 1250);
    else lockQuiz(human, q);
  });
}
function closeQuizNow() { qbox.style.display = 'none'; quizOpen = false; }

// ---------- match-making ----------
function rematch() {
 try {
  const free = players.filter(p => !p.dead && !p.opp);
  while (free.length >= 2) {
    const a = free.shift();
    let bi = 0, bd = 1e9;
    for (let i = 0; i < free.length; i++) {
      const d = Math.hypot(free[i].x - a.x, free[i].y - a.y);
      if (d < bd) { bd = d; bi = i; }
    }
    const b = free.splice(bi, 1)[0];
    a.opp = b; b.opp = a; a.state = b.state = 'seek';
  }
  for (const p of free) p.state = 'wander';
 } catch (e) { console.error('rematch error:', e.message, e.stack); }
}

// ---------- combat ----------
function strike(p) {
  const M = MELEE[p.t], o = p.opp;
  p.cd = rnd(CFG.cdMin, CFG.cdMax) * M.cdF;
  const dx = o.x - p.x, dy = o.y - p.y, dd = Math.hypot(dx, dy) || 1;
  p.face = dx >= 0 ? 1 : -1;
  p.lungeDir = { x: dx / dd, y: dy / dd };
  p.lungeMax = .42;
  p.lunge = p.lungeMax;
  setAnim(p, 'Attack', true); p.atkHold = M.hold;
  p.pend = { at: M.at, target: o };
}
const SHOOT_FPS = 14, SHOOT_RELEASE = .36, ARR_SPD = 540, ARR_NEAR = 175, ARR_FAR = 460;
const arrows = [];
function shoot(p, onRun) {
  const o = p.opp;
  p.cd = rnd(CFG.arrCdMin, CFG.arrCdMax) * (onRun ? 1.7 : 1);
  p.face = o.x >= p.x ? 1 : -1;
  setAnim(p, 'Shoot', true);
  p.atkHold = FRAMES.Archer.Shoot / SHOOT_FPS;
  p.pendShot = { at: SHOOT_RELEASE, target: o };
}
function mkArrowSprite() {
  const el = new PIXI.Sprite(PIXI.Assets.get('/img/2x/arrow.png'));
  el.anchor.set(.5);
  el.scale.set(.5);
  scene.addChild(el);
  return el;
}
function launchArrow(p, o) {
  if (p.dead || o.dead) return;
  const sx = p.x + p.face * 14, sy = p.y - 60;
  const d0 = Math.hypot(o.x - sx, o.y - sy);
  const T = Math.max(.16, d0 / ARR_SPD);
  const b = BOUNDS();
  const tx = Math.max(b.x0, Math.min(b.x1, o.x + o.lvx * T * .7));
  const ty = Math.max(b.y0, Math.min(b.y1, o.y + o.lvy * T * .7)) - 42;
  arrows.push({ sx, sy, tx, ty, t: 0, T: Math.max(.16, Math.hypot(tx - sx, ty - sy) / ARR_SPD),
                arc: Math.min(64, Math.hypot(tx - sx, ty - sy) * .12), el: mkArrowSprite(), from: p, target: o, px: sx, py: sy });
}
function damage(p, o, mn, mx) {
  if (over || o.dead) return;
  let dmg = Math.round(rnd(mn, mx) * (1 + p.str / 100));
  const crit = Math.random() < CFG.crit / 100;
  if (crit) dmg = Math.round(dmg * CFG.critMult);
  p.dmg += dmg;
  o.hp = Math.max(0, o.hp - dmg);
  setBars(o);
  o.spr.tint = 0xff9d9d; setTimeout(() => { o.spr.tint = 0xffffff; }, 200);
  o.x += (o.x >= p.x ? 5 : -5);
  floatTxt(o, (crit ? '\u{1F4A5} ' : '−') + dmg, crit ? 0xffd24a : 0xffffff, crit ? 29 : 22);
  mpAll({ t: 'dmg', id: o.id, n: dmg, crit: crit ? 1 : 0 });
  refreshBoard();
  if (o.hp <= 0) kill(p, o);
}
function applyHit(p, o) {
  if (o.dead || p.dead || Math.hypot(o.x - p.x, o.y - p.y) > 150) return;
  const M = MELEE[p.t] || { dmgF: 1 };
  damage(p, o, CFG.dmgMin * M.dmgF, CFG.dmgMax * M.dmgF);
}
const fallen = [];
let T0 = performance.now();
const MEDALS = { 1: '\u{1F451}', 2: '\u{1F948}', 3: '\u{1F949}' };
function refreshBoard() {
  const alive = players.filter(q => !q.dead)
    .sort((a, b) => (a.finalRank || 99) - (b.finalRank || 99) || b.hp - a.hp || b.str - a.str);
  const list = [...alive, ...fallen.slice().reverse()];
  list.forEach((q, i) => {
    if (!q.row) return;
    q.row.style.top = (i * 26) + 'px';
    if (q.dead || q.final) {
      q.row.querySelector('.rknum').textContent = MEDALS[q.finalRank] || (q.finalRank ? q.finalRank + '.' : '💀');
      q.row.querySelector('.tt').textContent = q.surv !== undefined ? q.surv.toFixed(1) + 's' : '💀';
    } else {
      q.row.querySelector('.rknum').textContent = (i + 1) + '.';
      q.row.querySelector('.tt').textContent = '❤' + Math.round(q.hp) + ' ⚡' + q.str;
    }
  });
}
function koVisual(o) {
  const rot = 1.68 * (o.face < 0 ? -1 : 1);
  fx(o, .7, (q, k) => { q.body.rotation = rot * k; });
  fx(o, .8, (q, k) => { q.body.alpha = q.ui.alpha = 1 - .65 * k; });
  star(o, '\u{1F4AB}');
  setTimeout(() => fx(o.cont, .9, (c, k) => { c.alpha = 1 - k; }, c => { if (c.parent) scene.removeChild(c); c.destroy({ children: true }); }), 2000);
}
function kill(p, o) {
  o.dead = true; o.opp = null; if (p.opp === o) p.opp = null;
  o.surv = (performance.now() - T0) / 1000;
  koVisual(o);
  fallen.push(o);
  o.finalRank = players.length - fallen.length + 1;
  refreshBoard();
  if (o.row) { o.row.classList.add('done'); o.row.classList.remove('pop'); void o.row.offsetWidth; o.row.classList.add('pop'); }
  p.hopT = 1;
  star(p, '\u{1F3C6}');
  p.hp = Math.min(100, p.hp + CFG.heal);
  setBars(p);
  p.state = 'wander'; p.wt = 0; p.cd = rnd(.3, .6);
  const alive = players.filter(q => !q.dead);
  banner.textContent = alive.length > 1 ? '⚔ ' + alive.length + ' fighters remain' : '';
  if (alive.length === 1) finale(alive[0]);
  else setTimeout(rematch, rnd(120, 350));
}

// ---------- phases (solo & host sim) ----------
let phase = 'quiz', over = false;
function releaseQuiz(p) { p.quizQ = null; p.quizDef = null; p.state = 'wander'; }
function startBattle() {
  phase = 'battle';
  closeQuizNow();
  guide.visible = false;
  players.forEach(p => { if (p.remote && p.state === 'quiz') { mpTo(p.id, { t: 'qclose' }); releaseQuiz(p); } });
  while (quizzes.length) consumeQuiz(quizzes[0]);
  respawns.length = 0;
  players.forEach(p => { if (!p.dead) { p.state = 'wander'; p.opp = null; p.qtarget = null; p.tx = null; } });
  pop('⚔ FIGHT ⚔');
  mpAll({ t: 'pop', txt: '⚔ FIGHT ⚔' });
  banner.textContent = '⚔ ' + players.filter(p => !p.dead).length + ' fighters — last one standing wins';
  setTimeout(rematch, 500);
}
function quizTick(dt) {
  quizLeft -= dt;
  banner.textContent = '❓ Quiz time — ' + Math.max(0, Math.ceil(quizLeft)) + 's';
  if (quizLeft <= 0) { startBattle(); return; }
  for (let i = respawns.length - 1; i >= 0; i--) {
    respawns[i] -= dt;
    if (respawns[i] <= 0) { respawns.splice(i, 1); spawnQuiz(); }
  }
  quizzes.forEach(q => { q.t += dt; q.qm.y = -52 - 6 * (1 + Math.sin(q.t * 3)); });
  updateGuide(human);
  const b = BOUNDS();
  for (const p of players) {
    if (p.dead) { draw(p, dt); continue; }
    if (p.qlockT > 0) p.qlockT -= dt;
    let vx = 0, vy = 0;
    if (p.human) {
      if (quizOpen) { setAnim(p, 'Idle'); }
      else {
        const q = quizzes.find(q2 => canEngage(p, q2) && Math.hypot(q2.x - p.x, q2.y - p.y) < 46);
        if (q) { openQuizSolo(q); p.tx = null; setAnim(p, 'Idle'); }
        else if (p.tx !== null) {
          const dx = p.tx - p.x, dy = p.ty - p.y, d = Math.hypot(dx, dy);
          if (d > 10) { vx = dx / d * p.speed; vy = dy / d * p.speed; p.face = dx >= 0 ? 1 : -1; setAnim(p, 'Run'); }
          else { p.tx = null; setAnim(p, 'Idle'); }
        } else setAnim(p, 'Idle');
      }
    } else if (p.remote) {
      if (p.state === 'quiz') {
        setAnim(p, 'Idle');
        p.quizT -= dt;
        if (p.quizT <= 0 || !p.quizQ || quizzes.indexOf(p.quizQ) < 0) {   // timed out, or someone else solved it
          mpTo(p.id, { t: 'qclose' });
          if (p.quizQ) lockQuiz(p, p.quizQ);
          releaseQuiz(p);
        }
      } else {
        const q = quizzes.find(q2 => canEngage(p, q2) && Math.hypot(q2.x - p.x, q2.y - p.y) < 46);
        if (q) {
          p.state = 'quiz'; p.quizQ = q; p.quizDef = pickQuiz(); p.quizT = 15; p.tx = null;
          p.quizN = (p.quizN || 0) + 1;
          setAnim(p, 'Idle');
          mpTo(p.id, { t: 'quiz', n: p.quizN, q: p.quizDef.q, a: p.quizDef.a });
        } else if (p.tx !== null) {
          const dx = p.tx - p.x, dy = p.ty - p.y, d = Math.hypot(dx, dy);
          if (d > 10) { vx = dx / d * p.speed; vy = dy / d * p.speed; p.face = dx >= 0 ? 1 : -1; setAnim(p, 'Run'); }
          else { p.tx = null; setAnim(p, 'Idle'); }
        } else setAnim(p, 'Idle');
      }
    } else if (p.state === 'answer') {
      p.answerT -= dt;
      setAnim(p, 'Idle');
      if (p.answerT <= 0) {
        p.state = 'wander';
        const q = p.qtarget;
        p.qtarget = null;
        if (q && quizzes.indexOf(q) >= 0) {
          const right = Math.random() < .55;
          applyQuizResult(p, right);
          if (right) consumeQuiz(q);                             // only a CORRECT answer takes the quiz away
          else lockQuiz(p, q);
        }
      }
    } else {
      p.qretry -= dt;
      if ((!p.qtarget || quizzes.indexOf(p.qtarget) < 0) && p.qretry <= 0) {
        p.qretry = rnd(.4, 1);
        let best = null, bd = 1e9;
        for (const q of quizzes) {
          if (!canEngage(p, q)) continue;
          const d = Math.hypot(q.x - p.x, q.y - p.y);
          if (d < bd) { bd = d; best = q; }
        }
        p.qtarget = (best && Math.random() < .8) ? best : null;
      }
      if (p.qtarget) {
        const q = p.qtarget, dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
        if (d < 42) {
          p.state = 'answer'; p.answerT = rnd(1.4, 2.8);
          floatTxt(p, '\u{1F4AD}', 0xffffff, 20);
        } else {
          vx = dx / d * p.speed * .7; vy = dy / d * p.speed * .7;
          p.face = dx >= 0 ? 1 : -1;
          setAnim(p, 'Run');
        }
      } else {
        p.wt -= dt;
        if (p.wt <= 0 || Math.hypot(p.wx - p.x, p.wy - p.y) < 12) {
          p.wt = rnd(1.2, 3);
          for (let t = 0; t < 8; t++) {
            p.wx = Math.max(b.x0, Math.min(b.x1, p.x + rnd(-260, 260)));
            p.wy = Math.max(b.y0, Math.min(b.y1, p.y + rnd(-170, 170)));
            if (!inObst(p.wx, p.wy)) break;
          }
          p.rest = Math.random() < .35;
        }
        if (!p.rest) {
          const dx = p.wx - p.x, dy = p.wy - p.y, d = Math.hypot(dx, dy) || 1;
          vx = dx / d * p.speed * .55; vy = dy / d * p.speed * .55;
          p.face = dx >= 0 ? 1 : -1;
          setAnim(p, 'Run');
        } else setAnim(p, 'Idle');
      }
    }
    moveAndDraw(p, vx, vy, dt, b);
  }
}
function battleTick(dt) {
  const b = BOUNDS();
  for (const p of players) {
    if (p.dead) { draw(p, dt); continue; }
    if (p.pend) { p.pend.at -= dt; if (p.pend.at <= 0) { applyHit(p, p.pend.target); p.pend = null; } }
    if (p.pendShot) { p.pendShot.at -= dt; if (p.pendShot.at <= 0) { launchArrow(p, p.pendShot.target); p.pendShot = null; } }
    if (p.lunge > 0) p.lunge = Math.max(0, p.lunge - dt);
    if (p.atkHold) { p.atkHold -= dt; if (p.atkHold <= 0) p.atkHold = 0; }
    let vx = 0, vy = 0;
    if (p.state === 'champion') {
      const dx = p.tx - p.x, dy = p.ty - p.y, d = Math.hypot(dx, dy);
      if (d > 8) { vx = dx / d * p.speed; vy = dy / d * p.speed; setAnim(p, 'Run'); p.face = dx >= 0 ? 1 : -1; }
      else if (!p.crowned) { p.crowned = true; setAnim(p, 'Idle'); p.face = 1; addCrown(p); }
    } else if (p.opp && !p.opp.dead && p.t !== 'Archer') {
      const M = MELEE[p.t], o = p.opp, dx = o.x - p.x, dy = o.y - p.y, d = Math.hypot(dx, dy);
      const striking = p.lunge > 0 || p.atkHold > 0;
      if (!striking) p.face = dx >= 0 ? 1 : -1;
      if (d > M.close && !striking) {
        p.state = 'seek';
        p.wt -= dt; if (p.wt <= 0) { p.wt = rnd(.3, .7); p.swx = rnd(-30, 30); p.swy = rnd(-24, 24); }
        const tx = o.x - Math.sign(dx) * M.stand + (p.swx || 0), ty = o.y + (p.swy || 0);
        const dd = Math.hypot(tx - p.x, ty - p.y) || 1;
        vx = (tx - p.x) / dd * p.speed; vy = (ty - p.y) / dd * p.speed;
        setAnim(p, 'Run');
      } else {
        p.state = 'fight';
        if (d < 26 && !striking) { vx = -dx / (d || 1) * 50; vy = -dy / (d || 1) * 50; }
        p.cd -= dt;
        if (p.cd <= 0 && !p.pend && d <= M.reach) strike(p);
        if (!striking && !(p.animSt === 'Attack' && p.animT < .4)) setAnim(p, 'Idle');
      }
    } else if (p.opp && !p.opp.dead) {
      const o = p.opp, dx = o.x - p.x, dy = o.y - p.y, d = Math.hypot(dx, dy) || 1;
      const shooting = p.atkHold > 0;
      p.cd -= dt;
      if (d < ARR_NEAR) {
        p.state = 'flee';
        let fx2 = -dx / d, fy2 = -dy / d;
        const cx0 = (b.x0 + b.x1) / 2, cy0 = (b.y0 + b.y1) / 2;
        const nx = p.x + fx2 * 70, ny = p.y + fy2 * 70;
        if (nx < b.x0 || nx > b.x1) { fx2 = 0; fy2 = cy0 > p.y ? 1 : -1; }
        if (ny < b.y0 || ny > b.y1) { fy2 = 0; fx2 = cx0 > p.x ? 1 : -1; }
        if (!fx2 && !fy2) fx2 = cx0 > p.x ? 1 : -1;
        const fd = Math.hypot(fx2, fy2) || 1;
        vx = fx2 / fd * p.speed * .78; vy = fy2 / fd * p.speed * .78;
        p.face = dx >= 0 ? 1 : -1;
        if (!shooting) setAnim(p, 'Run');
        if (p.cd <= 0 && !p.pendShot) shoot(p, true);
      } else if (shooting) {
        p.state = 'fight';
      } else if (d > ARR_FAR) {
        p.state = 'seek';
        vx = dx / d * p.speed * .8; vy = dy / d * p.speed * .8;
        p.face = dx >= 0 ? 1 : -1;
        setAnim(p, 'Run');
      } else {
        p.state = 'fight';
        p.face = dx >= 0 ? 1 : -1;
        if (p.cd <= 0 && !p.pendShot) shoot(p);
        else setAnim(p, 'Idle');
      }
    } else {
      p.state = 'wander';
      p.wt -= dt;
      if (p.wt <= 0 || Math.hypot(p.wx - p.x, p.wy - p.y) < 12) {
        p.wt = rnd(1.2, 3.5);
        for (let t = 0; t < 8; t++) {
          p.wx = Math.max(b.x0, Math.min(b.x1, p.x + rnd(-260, 260)));
          p.wy = Math.max(b.y0, Math.min(b.y1, p.y + rnd(-170, 170)));
          if (!inObst(p.wx, p.wy)) break;
        }
        p.rest = Math.random() < .35;
      }
      if (!p.rest) {
        const dx = p.wx - p.x, dy = p.wy - p.y, d = Math.hypot(dx, dy) || 1;
        vx = dx / d * p.speed * .55; vy = dy / d * p.speed * .55;
        p.face = dx >= 0 ? 1 : -1;
        setAnim(p, 'Run');
      } else setAnim(p, 'Idle');
    }
    moveAndDraw(p, vx, vy, dt, b, true);
  }
  for (let i = arrows.length - 1; i >= 0; i--) {
    const a = arrows[i];
    a.t += dt;
    const k = Math.min(1, a.t / a.T);
    const x = a.sx + (a.tx - a.sx) * k;
    const y = a.sy + (a.ty - a.sy) * k - Math.sin(Math.PI * k) * a.arc;
    a.el.rotation = Math.atan2(y - a.py, x - a.px);
    a.px = x; a.py = y;
    a.el.x = x; a.el.y = y;
    a.el.zIndex = Math.round(y + 60);
    if (k >= 1) {
      const o = a.target;
      arrows.splice(i, 1);
      if (o && !o.dead && !a.from.dead && Math.hypot(o.x - a.tx, (o.y - 42) - a.ty) < 46) {
        a.el.destroy();
        damage(a.from, o, CFG.arrDmgMin, CFG.arrDmgMax);
      } else {
        fx(a.el, .8, (el, kk) => { el.alpha = 1 - kk; }, el => el.destroy());
      }
    }
  }
}
function moveAndDraw(p, vx, vy, dt, b, separate) {
  if (separate) {
    for (const q of players) {
      if (q === p || q.dead || q === p.opp) continue;
      const dx = p.x - q.x, dy = p.y - q.y, d = Math.hypot(dx, dy);
      if (d > 0 && d < 46) { vx += dx / d * 70; vy += dy / d * 70; }
    }
  }
  p.lvx = vx; p.lvy = vy;
  p.x = Math.max(b.x0, Math.min(b.x1, p.x + vx * dt));
  p.y = Math.max(b.y0, Math.min(b.y1, p.y + vy * dt));
  for (const ob of OBST) {
    if (p.x > ob.x && p.x < ob.x + ob.w && p.y > ob.y && p.y < ob.y + ob.h) {
      const dl = p.x - ob.x, dr = ob.x + ob.w - p.x, dtp = p.y - ob.y, db = ob.y + ob.h - p.y;
      const m = Math.min(dl, dr, dtp, db);
      if (m === dl) p.x = ob.x; else if (m === dr) p.x = ob.x + ob.w;
      else if (m === dtp) p.y = ob.y; else p.y = ob.y + ob.h;
    }
  }
  draw(p, dt);
}
function draw(p, dt) {
  if (!p.cont || !p.cont.parent) return;
  p.animT += dt;
  const fps = p.animSt === 'Run' ? 10 : p.animSt === 'Attack' ? (MELEE[p.t] ? MELEE[p.t].fps : 10) : p.animSt === 'Shoot' ? SHOOT_FPS : 7;
  const fr = Math.floor(p.animT * fps) % p.animN;
  p.spr.texture = frameTex(p.sheet, fr, p.cell * 2, p.cell * 2);
  if ((p.animSt === 'Attack' || p.animSt === 'Shoot') && p.animT * fps >= p.animN) setAnim(p, 'Idle');
  let ox = 0, oy = 0;
  if (p.lunge > 0 && p.lungeDir) {
    const amp = Math.sin(Math.PI * (1 - p.lunge / p.lungeMax)) * (MELEE[p.t] ? MELEE[p.t].lunge : 14);
    ox = p.lungeDir.x * amp; oy = p.lungeDir.y * amp;
  }
  if (p.hopT > 0) { p.hopT = Math.max(0, p.hopT - dt); oy -= 22 * Math.abs(Math.sin(2 * Math.PI * (1 - p.hopT))); }
  p.cont.x = p.x + ox; p.cont.y = p.y + oy;
  p.cont.zIndex = Math.round(p.y);
  const s = .62 + .26 * (p.y / H0);
  p.body.scale.set(s * (p.face < 0 ? -1 : 1), s);
  p.ui.scale.set(s);
}
function finale(champ) {
  over = true;
  banner.textContent = '\u{1F451} ' + champ.name + ' rules the island!';
  pop('\u{1F451} ' + champ.name + '!');
  mpAll({ t: 'fin', id: champ.id, name: champ.name });
  champ.state = 'champion'; champ.opp = null; champ.pendShot = null; champ.pend = null;
  champ.surv = (performance.now() - T0) / 1000;
  champ.tx = ISL.x + ISL.w / 2; champ.ty = ISL.y + ISL.h * .5;
  champ.final = true; champ.finalRank = 1;
  refreshBoard();
  if (champ.row) champ.row.classList.add('pop');
  const again = document.getElementById('again');
  again.href = location.pathname + (MODE === 'host' ? '?host=1' : '?players=' + P);
  again.style.display = 'block';
  confetti();
}
function confetti() {
  for (let i = 0; i < 90; i++) {
    const c = document.createElement('div'); c.className = 'confetti';
    c.style.left = rnd(0, 100) + 'vw';
    c.style.width = c.style.height = rnd(6, 12) + 'px';
    c.style.background = 'hsl(' + Math.floor(rnd(0, 360)) + ',85%,60%)';
    c.style.animationDuration = rnd(2.5, 6) + 's';
    c.style.animationDelay = rnd(0, 2.5) + 's';
    document.body.appendChild(c);
  }
}

// ---------- roster & board ----------
function buildBoard() {
  const rankEl = document.getElementById('ranking');
  rankEl.innerHTML = '';
  rankEl.style.height = (players.length * 26) + 'px';
  players.forEach((q, i) => {
    const r = document.createElement('div'); r.className = 'rrow';
    const ico = { Warrior: '\u{1F5E1}', Archer: '\u{1F3F9}', Lancer: '⚔', Pawn: '\u{1FA93}' }[q.t];
    const me = q.human || (MODE === 'client' && q.id === myId);
    r.innerHTML = '<span><span class="rknum">' + (i + 1) + '.</span> <span class="who' + (me ? ' me' : '') + '">' + ico + ' ' + q.name + '</span></span><span class="tt">❤100 ⚡0</span>';
    r.style.top = (i * 26) + 'px';
    q.row = r; rankEl.appendChild(r);
  });
  document.getElementById('podium').style.display = 'block';
  document.getElementById('again').style.display = 'none';
}
function soloRoster() {
  const KITS = shuffle(COLORS.flatMap(c => TYPES.map(t => ({ c, t }))));
  players = Array.from({ length: P }, (_, i) => {
    const k = KITS[i % KITS.length];
    return fighterProps({ id: 'b' + i, name: i === 0 ? 'You' : k.c + ' ' + LABEL[k.t], c: k.c, t: k.t, human: i === 0 });
  });
  players.forEach(p => { byId[p.id] = p; });
  human = players[0];
}

// ---------- HOST mode ----------
async function initHost() {
  const lobbyEl = document.getElementById('lobby');
  lobbyEl.style.display = 'flex';
  banner.textContent = '\u{1F4F1} waiting for players — scan to join';
  const res = await fetch('/api/room', { method: 'POST' });
  const { code } = await res.json();
  const joinUrl = location.origin + '/sq/' + code;
  document.getElementById('roomcode').textContent = code;
  const qr = window.qrcode(0, 'M');
  qr.addData(joinUrl); qr.make();
  document.getElementById('qrbox').innerHTML = qr.createImgTag(5, 8);
  document.getElementById('joinurl').textContent = joinUrl.replace(/^https?:\/\//, '');
  const namesEl = document.getElementById('lobbynames');
  const renderNames = () => {
    namesEl.innerHTML = lobby.size
      ? [...lobby.values()].map(n => '<span class="lname">⚔ ' + n.replace(/[<>&]/g, '') + '</span>').join('')
      : '<i>nobody yet — scan the code!</i>';
  };
  renderNames();
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const hostMsg = ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.t === 'join') {
      lobby.set(m.id, m.name); renderNames();
      const back = byId[m.id];
      if (back) { back.remote = true; back.tx = null; }            // their knight is theirs again
      if (started) mpTo(m.id, { t: 'start', roster: players.map(p => [p.id, p.name, p.c, p.t]), late: back ? 0 : 1 });
    } else if (m.t === 'leave') {
      lobby.delete(m.id); renderNames();
      const p = byId[m.id];
      if (p && !p.dead) { p.remote = false; p.tx = null; if (p.state === 'quiz') releaseQuiz(p); }   // their knight fights on as a bot
    } else if (m.t === 'input' && started && phase === 'quiz') {
      const p = byId[m.id];
      if (p && p.remote && !p.dead && p.state !== 'quiz') {
        const b = BOUNDS();
        p.tx = Math.max(b.x0, Math.min(b.x1, +m.x || 0));
        p.ty = Math.max(b.y0, Math.min(b.y1, +m.y || 0));
      }
    } else if (m.t === 'answer' && started) {
      const p = byId[m.id];
      if (p && p.remote && p.state === 'quiz' && p.quizDef && m.n === p.quizN) {   // stale answers (to an expired offer) are dropped
        const right = m.choice === p.quizDef.c;
        const r2 = applyQuizResult(p, right);
        r2.correct = p.quizDef.c;
        mpTo(m.id, Object.assign({ t: 'quizres' }, r2));
        if (right) { if (p.quizQ && quizzes.indexOf(p.quizQ) >= 0) consumeQuiz(p.quizQ); }
        else if (p.quizQ) lockQuiz(p, p.quizQ);                   // wrong: the quiz stays for everyone else
        releaseQuiz(p);
      }
    }
  };
  const connectHost = () => {
    const ws = new WebSocket(proto + location.host + '/ws/' + code + '?role=host');
    sock = ws;
    ws.onmessage = hostMsg;
    ws.onopen = () => { if (started) banner.textContent = ''; };
    ws.onclose = () => {
      if (ws !== sock) return;
      if (started) banner.textContent = '⚠ room link lost — reconnecting…';
      setTimeout(() => { if (ws === sock) connectHost(); }, 1200);   // players re-register via their own reconnects
    };
  };
  connectHost();
  document.getElementById('startbtn').addEventListener('click', () => {
    if (started) return;
    started = true;
    lobbyEl.style.display = 'none';
    const KITS = shuffle(COLORS.flatMap(c => TYPES.map(t => ({ c, t }))));
    const remotes = [...lobby.entries()];
    const total = Math.max(8, Math.min(20, remotes.length + 7));
    players = [];
    remotes.forEach(([id, name], i) => {
      const k = KITS[i % KITS.length];
      players.push(fighterProps({ id, name, c: k.c, t: k.t, remote: true }));
    });
    for (let i = remotes.length; i < total; i++) {
      const k = KITS[i % KITS.length];
      players.push(fighterProps({ id: 'b' + i, name: k.c + ' ' + LABEL[k.t], c: k.c, t: k.t }));
    }
    players.forEach(p => { byId[p.id] = p; });
    players.forEach(makeFighter);
    buildBoard();
    refreshBoard();
    T0 = performance.now();
    quizLeft = quizTotal;
    for (let i = 0; i < Math.max(3, Math.round(players.length / 3)); i++) spawnQuiz();
    pop('❓ QUIZ TIME ❓');
    mpAll({ t: 'start', roster: players.map(p => [p.id, p.name, p.c, p.t]) });
  });
}
let snapAcc = 0;
function hostNet(dt) {
  snapAcc += dt;
  if (snapAcc < .1) return;
  snapAcc = 0;
  mpAll({
    t: 'snap',
    ps: players.map(p => [p.id, Math.round(p.x), Math.round(p.y), Math.round(p.hp), p.str, p.face, ANIMI[p.animSt] || 0, p.dead ? 1 : 0]),
    qs: quizzes.map(q => [Math.round(q.x), Math.round(q.y)]),
    ars: arrows.map(a => [Math.round(a.px), Math.round(a.py), +a.el.rotation.toFixed(2)]),
    ph: phase, ql: Math.max(0, Math.ceil(quizLeft)), bn: banner.textContent,
  });
}

// ---------- CLIENT mode ----------
let snapA = null, snapB = null;
const clientQuizVis = new Map();
const clientArrows = [];
function initClient() {
  const jb = document.getElementById('joinbox');
  jb.style.display = 'flex';
  banner.textContent = '';
  const jstatus = document.getElementById('jstatus');
  const tokKey = 'tk-sq-tok-' + JOIN_CODE, nameKey = 'tk-sq-name-' + JOIN_CODE;
  let token = '';
  try {
    token = localStorage.getItem(tokKey) || '';
    if (!token) { token = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(tokKey, token); }
  } catch (e) {}
  let retries = 0;
  const doJoin = name => {
    joinName = name;
    try { localStorage.setItem(nameKey, name); } catch (e) {}
    document.getElementById('jname').style.display = 'none';
    document.getElementById('jbtn').style.display = 'none';
    jstatus.textContent = retries ? 'reconnecting…' : 'joining…';
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const ws = new WebSocket(proto + location.host + '/ws/' + JOIN_CODE + '?role=player&name=' + encodeURIComponent(name) + '&token=' + encodeURIComponent(token));
    sock = ws;
    ws.onopen = () => { retries = 0; };
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      lastMsgAt = performance.now();
      onClientMsg(m, jb, jstatus);
    };
    ws.onclose = () => {
      if (ws !== sock || over) return;                            // superseded socket, or game finished
      if (!started) jstatus.textContent = '⚠ reconnecting…';
      else banner.textContent = '⚠ reconnecting…';
      retries++;
      setTimeout(() => { if (ws === sock && !over) doJoin(joinName); }, Math.min(5000, 800 * retries));
    };
  };
  clientReconnect = () => { if (joinName && sock && sock.readyState > 1 && !over) doJoin(joinName); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) clientReconnect(); });
  document.getElementById('jbtn').addEventListener('click', () => {
    doJoin((document.getElementById('jname').value || '').trim() || 'Knight ' + Math.floor(rnd(2, 99)));
  });
  let savedName = '';
  try { savedName = localStorage.getItem(nameKey) || ''; } catch (e) {}
  if (savedName) { jstatus.textContent = 'reconnecting…'; doJoin(savedName); }   // reload = seamless rejoin
  else { try { document.getElementById('jname').value = ''; } catch (e) {} }
}
function onClientMsg(m, jb, jstatus) {
  if (m.t === 'welcome') {
    myId = m.id;
    jstatus.innerHTML = '✅ joined as <b>' + m.name.replace(/[<>&]/g, '') + '</b><br>waiting for the host to start…';
  } else if (m.t === 'start') {
    started = true;
    spectate = !m.roster.some(r => r[0] === myId);              // rejoining players get their own knight back
    if (players.length) { jb.style.display = 'none'; human = byId[myId] || null; if (human) { human.px = human.x; human.py = human.y; } return; }
    players = m.roster.map(r => fighterProps({ id: r[0], name: r[1], c: r[2], t: r[3] }));
    players.forEach(p => { byId[p.id] = p; makeFighter(p); });
    human = byId[myId] || null;
    if (human) { human.px = human.x; human.py = human.y; }
    buildBoard();
    jb.style.display = 'none';
    pop(spectate ? '\u{1F440} spectating' : '❓ QUIZ TIME ❓');
  } else if (m.t === 'snap') {
    m.at = performance.now();
    snapA = snapB; snapB = m;
  } else if (m.t === 'dmg') {
    const p = byId[m.id];
    if (p) {
      floatTxt(p, (m.crit ? '\u{1F4A5} ' : '−') + m.n, m.crit ? 0xffd24a : 0xffffff, m.crit ? 29 : 22);
      if (p.spr && !p.spr.destroyed) { p.spr.tint = 0xff9d9d; setTimeout(() => { if (p.spr && !p.spr.destroyed) p.spr.tint = 0xffffff; }, 200); }
    }
  } else if (m.t === 'quiz') {
    fillModal({ q: m.q, a: m.a }, (i, btns) => {
      mpAll({ t: 'answer', choice: i, n: m.n });
      window.__qbtns = btns; window.__qchoice = i;
    });
  } else if (m.t === 'quizres') {
    if (window.__qbtns) showModalResult(m, window.__qchoice, window.__qbtns);
    else closeQuizNow();
  } else if (m.t === 'qclose') {
    closeQuizNow();
  } else if (m.t === 'pop') {
    pop(m.txt);
  } else if (m.t === 'fin') {
    over = true;
    const p = byId[m.id];
    if (p) addCrown(p);
    pop('\u{1F451} ' + m.name + '!');
    confetti();
  } else if (m.t === 'hostgone') {
    banner.textContent = '⚠ the host has left the island';
  }
}
function clientRender(dt) {
  if (!snapB || !players.length) return;
  const A = snapA || snapB, B = snapB;
  const span = Math.max(40, B.at - A.at);
  const k = Math.min(1.25, Math.max(0, (performance.now() - 120 - A.at) / span));
  const amap = {};
  A.ps.forEach(e => { amap[e[0]] = e; });
  phase = B.ph;
  quizLeft = B.ql;
  banner.textContent = B.bn || banner.textContent;
  for (const e of B.ps) {
    const p = byId[e[0]];
    if (!p || !p.cont || p.cont.destroyed) continue;
    const a = amap[e[0]] || e;
    let X = a[1] + (e[1] - a[1]) * k, Y = a[2] + (e[2] - a[2]) * k;
    if (p === human && !p.dead && phase === 'quiz') {
      if (p.ptx != null) {
        const dx = p.ptx - p.px, dy = p.pty - p.py, d = Math.hypot(dx, dy);
        if (d > 10) { p.px += dx / d * 225 * dt; p.py += dy / d * 225 * dt; p.face = dx >= 0 ? 1 : -1; setAnim(p, 'Run'); }
        else { p.ptx = null; setAnim(p, 'Idle'); }
      }
      p.px += (X - p.px) * .06; p.py += (Y - p.py) * .06;
      X = p.px; Y = p.py;
    } else {
      const an = ANIMS[e[6]] || 'Idle';
      if (an !== p.animSt) setAnim(p, an, an === 'Attack' || an === 'Shoot');
    }
    p.x = X; p.y = Y;
    if (p.hp !== e[3] || p.str !== e[4]) { p.hp = e[3]; p.str = e[4]; setBars(p); }
    if (!(p === human && phase === 'quiz')) p.face = e[5];
    if (e[7] && !p.dead) { p.dead = true; koVisual(p); }
    draw(p, dt);
  }
  const seen = new Set();
  for (const [x, y] of B.qs) {
    const key = x + '_' + y;
    seen.add(key);
    if (!clientQuizVis.has(key)) clientQuizVis.set(key, Object.assign(quizVisual(x, y), { t: rnd(0, 6) }));
  }
  for (const [key, v] of clientQuizVis) {
    if (!seen.has(key)) {
      fx(v.cont, .35, (c, kk) => { c.alpha = 1 - kk; }, c => { if (c.parent) scene.removeChild(c); c.destroy({ children: true }); });
      clientQuizVis.delete(key);
    } else { v.t += dt; v.qm.y = -52 - 6 * (1 + Math.sin(v.t * 3)); }
  }
  const ars = B.ars || [];
  while (clientArrows.length < ars.length) clientArrows.push(mkArrowSprite());
  while (clientArrows.length > ars.length) { const el = clientArrows.pop(); el.destroy(); }
  const aars = A.ars || [];
  ars.forEach((ar, i) => {
    const prev = aars[i] || ar;
    const el = clientArrows[i];
    el.x = prev[0] + (ar[0] - prev[0]) * k;
    el.y = prev[1] + (ar[1] - prev[1]) * k;
    el.rotation = ar[2];
    el.zIndex = Math.round(el.y + 60);
  });
  if (phase === 'quiz' && human && !spectate && !human.dead && B.qs.length && !quizOpen) {
    let best = null, bd = 1e9;
    for (const [x, y] of B.qs) { const d = Math.hypot(x - human.x, y - human.y); if (d < bd) { bd = d; best = [x, y]; } }
    guideTo(human, best);
  } else guide.visible = false;
  refreshBoardClient();
}
function refreshBoardClient() {
  const alive = players.filter(q => !q.dead).sort((a, b) => b.hp - a.hp || b.str - a.str);
  const dead = players.filter(q => q.dead);
  [...alive, ...dead].forEach((q, i) => {
    if (!q.row) return;
    q.row.style.top = (i * 26) + 'px';
    q.row.querySelector('.rknum').textContent = q.dead ? '💀' : (i + 1) + '.';
    q.row.querySelector('.tt').textContent = q.dead ? '💀' : '❤' + Math.round(q.hp) + ' ⚡' + q.str;
  });
}

// ---------- go ----------
buildScenery();
fitWorld();
if (MODE === 'solo') {
  soloRoster();
  players.forEach(makeFighter);
  buildBoard();
  refreshBoard();
  for (let i = 0; i < Math.max(3, Math.round(P / 3)); i++) spawnQuiz();
  pop('❓ QUIZ TIME ❓');
} else if (MODE === 'host') {
  initHost();
} else {
  initClient();
}
updateCamera(0, true);
app.ticker.add(() => {
 try {
  const dt = Math.min(app.ticker.deltaMS / 1000, .05);
  crownTime += dt;
  if (MODE === 'client') {
    clientRender(dt);
    if (quizOpen && (performance.now() - quizOpenedAt > 20000 || performance.now() - lastMsgAt > 6000)) closeQuizNow();
  }
  else if (started && !over && phase === 'quiz') quizTick(dt);
  else if (started) battleTick(dt);
  if (MODE === 'host' && started) hostNet(dt);
  updateCamera(dt);
  fxTick(dt);
  crowns.forEach(c => { c.y = -205 - 6 * (1 + Math.sin(crownTime * 3.4)); });
  if (water) { water.tilePosition.x += 4 * dt; water.tilePosition.y += 8 * dt; }
  for (const cl of clouds) { cl.c.x += cl.sp * dt; if (cl.c.x > W0 + 320) cl.c.x = -320; }
 } catch (e) { console.error('tick error:', e.message, e.stack); }
});
// debug handles (used by the harness probes)
window.arrows = arrows; window.OBST = OBST; window.quizzes = quizzes;
window.inObst = inObst; window.__world = world; window.__isFollow = () => followMode;
window.__byId = byId; window.__mode = MODE;
window.__sock = () => sock;
Object.defineProperty(window, 'players', { get: () => players });
Object.defineProperty(window, 'human', { get: () => human });
Object.defineProperty(window, 'over', { get: () => over });
Object.defineProperty(window, 'phase', { get: () => phase });
Object.defineProperty(window, 'started', { get: () => started });
Object.defineProperty(window, 'quizLeft', { get: () => quizLeft, set: v => { quizLeft = v; } });
Object.defineProperty(window, 'snapB', { get: () => snapB });
window.T0 = T0;
})();
