/* Brawl: Quiz Mode — Survival Brawl where every encounter starts with a quiz duel.
   When two fighters meet, both phones get the same question. The first RIGHT answer earns a random buff
   (a heal or lasting strength) plus the first strike; a WRONG answer costs the answerer HP but they may try
   another option. Then the sword fight decides it — the buff tilts the odds, it doesn't decide them.
   Duelling pairs are locked: nobody else can touch them.
   Base engine below is Survival Brawl:
   Every fighter is always pulled toward the nearest rival and swings automatically. Right after each of your
   own strikes an ESCAPE WINDOW opens: for a moment your tap wins over the pull and you can run toward it —
   pick your next opponent, or dodge the swing coming at you. When the window closes the pull wins again.
   Tap to move: the tap is where you WANT to be; the pull decides when you may go there.
   Modes: solo (default) · host (?host=1 — desktop runs the sim, phones scan to join) · client (?join=CODE).
   Multiplayer is host-authoritative: phones send tap targets, the host streams snapshots. */
(async () => {
const rnd = (a, b) => a + Math.random() * (b - a);
const qs = new URLSearchParams(location.search);
const MODE = qs.get('join') ? 'client' : (qs.has('host') ? 'host' : 'solo');
const JOIN_CODE = (qs.get('join') || '').toUpperCase();
const P = Math.max(4, Math.min(20, parseInt(qs.get('players'), 10) || 12));
document.querySelectorAll('#controls a').forEach(a => { if (a.search === '?players=' + P) a.classList.add('on'); });

// ---------- combat constants ----------
const DEFAULTS = { total: 20, dmgMin: 24, dmgMax: 36, crit: 15, critMult: 2.1, heal: 30, cdMin: .8, cdMax: 1.3, spdMin: 175, spdMax: 215 };
const CFG = Object.assign({}, DEFAULTS);
const ESC_F = 2.8;          // escape window = your own cooldown × this (≈ 2.5–4.5 s)
const ESC_PULL = .2;        // how hard the pull still tugs while you're escaping
const CTRL_PULLED = .3;     // how much say your tap has once the pull is back in charge
const CTRL_SPD = 1.08;      // a steered knight runs a touch faster than a bot
const HUMAN_SPD = 225;
const REST_CTRL = 1.0, REST_BOT = 1.0;   // after a kill: roam freely for a moment before the next matchup
const DODGE_MARGIN = 40;    // a swing lands only if the target is still within reach + this at impact — runners can dodge
// ---------- quiz duel constants ----------
const QUIZ_T = 10;          // seconds to answer before the pair falls back to a plain fight
const QUIZ_DMG = [12, 20];  // a wrong answer hurts the answerer — but they may try another option
const BUFF_HEAL = 35, BUFF_STR = 20, STR_MAX = 60;   // the quiz winner's prize: a heal, or strength (+20% damage per stack)
const FIRST_STRIKE = .15, SLOW_START = [.9, 1.3];    // ...and they swing first
const BOT_ANS = [1.8, 6];   // bots "think" this long before answering
const BOT_ACC = .5;         // ...and are right about half the time
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
  { q: 'Which planet is the Red Planet?', a: ['Venus', 'Mars', 'Jupiter'], c: 1 },
  { q: '15 ÷ 3 = ?', a: ['3', '4', '5'], c: 2 },
  { q: 'The opposite of "cold"?', a: ['Hot', 'Wet', 'Dark'], c: 0 },
  { q: 'Which is a primary colour?', a: ['Green', 'Red', 'Orange'], c: 1 },
];
let quizDeck = [];
function drawQuiz() {                                              // shuffled deck: every question once before any repeats
  if (!quizDeck.length) quizDeck = shuffle(QUIZ_POOL.slice());
  return quizDeck.pop();
}
function clampN(v, a, b) { return Math.max(a, Math.min(b, v)); }
function applyTotal(T) {                                          // same pacing curve as Survival Island
  const s = Math.pow(Math.max(2, T - 5) / 10.5, .608);
  CFG.cdMin = +clampN(.8 * s, .25, 3.2).toFixed(2);
  CFG.cdMax = +clampN(1.3 * s, .35, 4.5).toFixed(2);
  CFG.dmgMin = Math.round(clampN(24 / s, 4, 90));
  CFG.dmgMax = Math.round(clampN(36 / s, 6, 99));
}
try { CFG.total = clampN(parseInt(localStorage.getItem('tk-bq-total') || '', 10) || DEFAULTS.total, 6, 120); } catch (e) {}
applyTotal(CFG.total);
const lenin = document.getElementById('lenin');
lenin.value = CFG.total;
lenin.addEventListener('input', () => {
  const v = parseInt(lenin.value, 10);
  if (isNaN(v) || v < 6) return;
  CFG.total = v; applyTotal(v);
  try { localStorage.setItem('tk-bq-total', String(v)); } catch (e) {}
});
if (MODE === 'client') {                                          // a phone is a controller, not a menu
  document.getElementById('lenbox').style.display = 'none';
  document.getElementById('controls').innerHTML = '<a href="#" id="helpbtn">&#10068; how to play</a>';   // a phone is a controller, not a menu
}
const banner = document.getElementById('banner');
const helpEl = document.getElementById('help');
document.getElementById('helpbtn').addEventListener('click', e => { e.preventDefault(); helpEl.style.display = helpEl.style.display === 'flex' ? 'none' : 'flex'; });
document.getElementById('helpclose').addEventListener('click', () => { helpEl.style.display = 'none'; });
const hintEl = document.getElementById('hint');
let hintT = null;
function hint(txt, ms) {
  hintEl.textContent = txt; hintEl.classList.add('show');
  clearTimeout(hintT); hintT = setTimeout(() => hintEl.classList.remove('show'), ms || 5000);
}

// ---------- kits & fighter data ----------
const COLORS = ['Blue', 'Red', 'Yellow', 'Purple', 'Black'];
const TYPES = ['Warrior', 'Lancer', 'Pawn'];                      // melee only — everyone gets pulled into the scrum
const FRAMES = { Warrior: { Idle: 8, Run: 6, Attack: 4 }, Lancer: { Idle: 12, Run: 6, Attack: 3 }, Pawn: { Idle: 8, Run: 6, Attack: 6 } };
const CELL = { Lancer: 320 };
const MELEE = {
  Warrior: { close: 52, reach: 60, stand: 40, hold: .42, at: .26, fps: 10, dmgF: 1.2, cdF: 1, lunge: 14 },
  Lancer:  { close: 95, reach: 108, stand: 84, hold: .34, at: .2, fps: 9, dmgF: 1.15, cdF: 1.1, lunge: 8 },
  Pawn:    { close: 44, reach: 50, stand: 34, hold: .45, at: .3, fps: 14, dmgF: 1, cdF: .75, lunge: 12 },
};
const LABEL = { Warrior: 'Knight', Lancer: 'Lancer', Pawn: 'Pawn' };
const ANIMS = ['Idle', 'Run', 'Attack'];
const ANIMI = { Idle: 0, Run: 1, Attack: 2 };
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function fighterProps(p) {
  return Object.assign(p, {
    hp: 100, dmg: 0, dead: false, opp: null, state: 'wander', cd: rnd(.2, .6),
    wx: 0, wy: 0, wt: 0, swx: 0, swy: 0, speed: (p.human || p.remote) ? HUMAN_SPD : rnd(CFG.spdMin, CFG.spdMax),
    pend: null, lunge: 0, lvx: 0, lvy: 0, hopT: 0, face: 1, tx: null, ty: null,
    steer: { x: 0, y: 0 }, esc: 0, escMax: 1, escFrac: 0, restT: 0, duel: null, noQuizWith: null, str: 0,
  });
}
const isCtrl = p => !!(p.human || p.remote);                      // steered by a person (bots take over when a phone drops)
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
  'rock1', 'rock2', 'gold1', 'bush1', 'bush2', 'sheep_idle', 'cloud1', 'cloud2']
  .map(n => '/img/' + n + '.png'));
COLORS.forEach(c => { TYPES.forEach(t => { for (const st in FRAMES[t]) urls.add('/img/2x/' + c + '_' + t + '_' + st + '.png'); }); urls.add('/img/ribs_' + c + '.png'); });
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
  const ctrl = isCtrl(p) || (MODE === 'client' && p.id === myId);
  const rows = 1 + (ctrl ? 1 : 0) + (p.str > 0 ? 1 : 0);
  g.beginFill(INK, .8).drawRoundedRect(-43, -136, 86, 10 + rows * 8 - (rows > 1 ? 2 : 0), 6).endFill();
  const col = p.hp <= 35 ? 0xe2792b : 0x4fcf4f;
  if (p.hp > 0) g.beginFill(col).drawRoundedRect(-39, -132, Math.max(2, 78 * p.hp / 100), 6, 3).endFill();
  let y = -123;
  if (ctrl) {                                                     // escape meter: how long your tap still wins
    const f = Math.max(0, Math.min(1, p.escFrac));
    if (f > 0) g.beginFill(0x5ec8ff).drawRoundedRect(-39, y, Math.max(2, 78 * f), 5, 2).endFill();
    else g.beginFill(0x6b6b80, .6).drawRoundedRect(-39, y, 78, 5, 2).endFill();
    y -= 8;
  }
  if (p.str > 0) g.beginFill(0xffc93c).drawRoundedRect(-39, y, Math.max(2, 78 * Math.min(1, p.str / STR_MAX)), 5, 2).endFill();   // strength
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
  const ring = new PIXI.Graphics();                               // glows under your feet while the escape window is open
  ring.lineStyle(3, 0x5ec8ff, .95).drawEllipse(0, 0, 30, 12);
  ring.beginFill(0x5ec8ff, .18).drawEllipse(0, 0, 30, 12).endFill();
  ring.visible = false;
  const qmark = TXT('❓', 30, 0xffd24a);                         // shows while this fighter is in a quiz duel
  qmark.anchor.set(.5); qmark.y = -212; qmark.visible = false;
  ui.addChild(qmark);
  cont.addChild(ring, body, ui);
  scene.addChild(cont);
  p.cont = cont; p.body = body; p.ui = ui; p.spr = spr; p.hpg = hpg; p.cell = cell; p.ring = ring; p.qmark = qmark;
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
function pop(text, high) { const rp = document.getElementById('roundpop'); rp.style.top = high ? '16%' : '42%'; rp.querySelector('.rm').textContent = text; rp.classList.remove('pop'); void rp.offsetWidth; rp.classList.add('pop'); }

// ---------- tap-to-move: a tap is where you WANT to be; the pull decides when you may go ----------
let tapMark = null;
function clearTap() { if (tapMark) { if (tapMark.parent) scene.removeChild(tapMark); tapMark.destroy(); tapMark = null; } }
function showTap(x, y) {
  clearTap();
  const m = new PIXI.Graphics();
  m.lineStyle(3, 0x5ec8ff, .95).drawEllipse(0, 0, 16, 7);
  m.beginFill(0x5ec8ff, .2).drawEllipse(0, 0, 16, 7).endFill();
  m.x = x; m.y = y; m.zIndex = 5;
  scene.addChild(m); tapMark = m;
  fx(m, .5, (o, k) => { o.scale.set(1.6 - .6 * k); }, null);
}
function canSteer() {
  if (over || !human || human.dead || quizOpen || human.duel) return false;
  if (MODE === 'client') return !spectate;
  return MODE === 'solo';
}
document.addEventListener('dblclick', e => e.preventDefault(), { passive: false });
['gesturestart', 'gesturechange', 'gestureend'].forEach(g => document.addEventListener(g, e => e.preventDefault(), { passive: false }));
app.view.addEventListener('pointerdown', e => {
  if (!canSteer()) return;
  const r = app.view.getBoundingClientRect();
  const wx = (e.clientX - r.left - world.x) / world.scale.x;
  const wy = (e.clientY - r.top - world.y) / world.scale.y;
  const b = BOUNDS();
  const tx = Math.max(b.x0, Math.min(b.x1, wx)), ty = Math.max(b.y0, Math.min(b.y1, wy));
  if (MODE === 'client') {
    mpAll({ t: 'input', x: Math.round(tx), y: Math.round(ty) });
    human.ptx = tx; human.pty = ty;                               // predict yourself — everyone else is playback
  } else { human.tx = tx; human.ty = ty; }
  showTap(tx, ty);
});
function steerFromTarget(p) {                                      // the tap becomes a unit direction every tick
  if (p.tx === null || p.tx === undefined) { p.steer.x = p.steer.y = 0; return; }
  const dx = p.tx - p.x, dy = p.ty - p.y, d = Math.hypot(dx, dy);
  if (d < 10) { p.tx = p.ty = null; p.steer.x = p.steer.y = 0; if (p === human) clearTap(); return; }
  p.steer.x = dx / d; p.steer.y = dy / d;
}

// ---------- match-making: free fighters are pulled to the NEAREST free fighter ----------
function rematch() {
 try {
  const free = players.filter(p => !p.dead && !p.opp && !(p.restT > 0));   // resting winners sit this one out
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
  if (isCtrl(p)) { p.esc = p.escMax = p.cd * ESC_F; p.escFrac = 1; setBars(p); }   // your swing opens the escape window
  const dx = o.x - p.x, dy = o.y - p.y, dd = Math.hypot(dx, dy) || 1;
  p.face = dx >= 0 ? 1 : -1;
  p.lungeDir = { x: dx / dd, y: dy / dd };
  p.lungeMax = .42;
  p.lunge = p.lungeMax;
  setAnim(p, 'Attack', true); p.atkHold = M.hold;
  p.pend = { at: M.at, target: o };
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
  if (o.dead || p.dead) return;
  const M = MELEE[p.t];
  if (Math.hypot(o.x - p.x, o.y - p.y) > M.reach + DODGE_MARGIN) {   // they ran — the swing whiffs
    if (isCtrl(o)) { floatTxt(o, 'dodge!', 0x5ec8ff, 20); mpAll({ t: 'dodge', id: o.id }); }
    return;
  }
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
  if (o.ring) o.ring.visible = false;
  fx(o, .7, (q, k) => { q.body.rotation = rot * k; });
  fx(o, .8, (q, k) => { q.body.alpha = q.ui.alpha = 1 - .65 * k; });
  star(o, '\u{1F4AB}');
  setTimeout(() => fx(o.cont, .9, (c, k) => { c.alpha = 1 - k; }, c => { if (c.parent) scene.removeChild(c); c.destroy({ children: true }); }), 2000);
}
function kill(p, o) {
  o.dead = true; o.opp = null; if (p.opp === o) p.opp = null;
  o.tx = o.ty = null; if (o === human) clearTap();
  o.surv = (performance.now() - T0) / 1000;
  koVisual(o);
  fallen.push(o);
  o.finalRank = players.length - fallen.length + 1;
  refreshBoard();
  if (o.row) { o.row.classList.add('done'); o.row.classList.remove('pop'); void o.row.offsetWidth; o.row.classList.add('pop'); }
  if (o === human) hint('💀 you fell — ' + o.finalRank + (o.finalRank === 2 ? 'nd' : o.finalRank === 3 ? 'rd' : 'th') + ' place', 6000);
  p.hopT = 1;
  star(p, '\u{1F3C6}');
  p.hp = Math.min(100, p.hp + CFG.heal);
  setBars(p);
  p.state = 'wander'; p.wt = 0; p.cd = rnd(.3, .6);
  p.restT = isCtrl(p) ? REST_CTRL : REST_BOT;                     // a win buys a breather: nobody is matched with you yet
  if (isCtrl(p)) { p.esc = p.escMax = REST_CTRL; p.escFrac = 1; }
  const alive = players.filter(q => !q.dead);
  banner.textContent = alive.length > 1 ? '⚔ ' + alive.length + ' fighters remain' : '';
  if (alive.length === 1) finale(alive[0]);
  else setTimeout(rematch, rnd(120, 350));
}

// ---------- quiz duels (solo & host sim) ----------
let duelN = 0;
const duels = [];
function startDuel(a, b) {
  const def = drawQuiz();
  const d = { n: ++duelN, a, b, def, t: QUIZ_T, done: false, result: null, tried: { [a.id]: new Set(), [b.id]: new Set() }, botAt: {} };
  a.duel = b.duel = d; a.state = b.state = 'duel';
  a.pend = b.pend = null; a.tx = a.ty = b.tx = b.ty = null;
  a.face = b.x >= a.x ? 1 : -1; b.face = -a.face;
  setAnim(a, 'Idle'); setAnim(b, 'Idle');
  for (const p of [a, b]) {
    if (p.remote) mpTo(p.id, { t: 'quiz', n: d.n, q: def.q, a: def.a, s: QUIZ_T });
    else if (p.human) openQuizSolo(d);
    else d.botAt[p.id] = rnd(BOT_ANS[0], BOT_ANS[1]);
  }
  if (a === human) clearTap(); if (b === human) clearTap();
  duels.push(d);
}
function botThink(p, d, again) { if (!d.done) d.botAt[p.id] = again ? rnd(1, 3) : rnd(BOT_ANS[0], BOT_ANS[1]); }
function sendRes(p, res) {
  if (p.remote) mpTo(p.id, Object.assign({ t: 'quizres' }, res));
  else if (p.human) showModalResult(res);
}
function duelAnswer(p, d, choice) {
  if (d.done || p.dead || !d.def.a[choice] || d.tried[p.id].has(choice)) return;
  const o = d.a === p ? d.b : d.a;
  d.tried[p.id].add(choice);
  if (choice === d.def.c) {                                       // first right answer: a random prize + the first strike
    d.done = true; d.result = 'buff';
    const ans = d.def.a[d.def.c];
    const buff = Math.random() < .5 ? 'heal' : 'str';
    let amt;
    if (buff === 'heal') { amt = Math.min(BUFF_HEAL, 100 - p.hp); p.hp = Math.min(100, p.hp + BUFF_HEAL); floatTxt(p, '+' + BUFF_HEAL + ' ❤', 0x7ef17e, 26); }
    else { amt = Math.min(BUFF_STR, STR_MAX - p.str); p.str = Math.min(STR_MAX, p.str + BUFF_STR); floatTxt(p, '+' + BUFF_STR + ' ⚡', 0xffc93c, 26); p.hopT = .55; }
    setBars(p); refreshBoard();
    p.cd = FIRST_STRIKE; o.cd = rnd(SLOW_START[0], SLOW_START[1]);   // the quick thinker swings first
    const pk = { name: p.name };
    for (const f of [p, o]) {                                     // the card drops away: the fight happens on the field, in view
      if (f.remote) mpTo(f.id, { t: 'verdict', w: pk, ans, won: f === p ? 1 : 0, buff, amt });
      else if (f.human) duelVerdict(pk, ans, f === p, buff, amt);
    }
    endDuel(d);
  } else {                                                        // wrong: it hurts — pick again
    const dmg = Math.round(rnd(QUIZ_DMG[0], QUIZ_DMG[1]));
    p.hp = Math.max(4, p.hp - dmg); setBars(p);
    p.spr.tint = 0xff9d9d; setTimeout(() => { if (p.spr && !p.spr.destroyed) p.spr.tint = 0xffffff; }, 220);
    floatTxt(p, '✘ −' + dmg, 0xff8080, 24);
    mpAll({ t: 'dmg', id: p.id, n: dmg, crit: 0 });
    refreshBoard();
    sendRes(p, { right: 0, dmg, chosen: choice, n: d.n });
    if (!p.remote && !p.human) botThink(p, d, true);
  }
}
function endDuel(d) {
  d.done = true;
  const i = duels.indexOf(d); if (i >= 0) duels.splice(i, 1);
  for (const p of [d.a, d.b]) {
    p.duel = null;
    if (p.dead) continue;
    p.state = 'fight'; p.cd = rnd(.3, .8);
    const o = p === d.a ? d.b : d.a;
    p.noQuizWith = o.id;                                          // this pair has had its question
    if (d.result !== 'buff') { if (p.remote) mpTo(p.id, { t: 'qclose' }); else if (p.human) closeQuizNow(); }
  }
  floatTxt(d.a, '⚔', 0xffffff, 24); floatTxt(d.b, '⚔', 0xffffff, 24);
}
function duelTick(dt) {
  for (const d of duels.slice()) {
    if (d.done) continue;
    d.t -= dt;
    for (const p of [d.a, d.b]) {
      if (d.botAt[p.id] === undefined) continue;
      d.botAt[p.id] -= dt;
      if (d.botAt[p.id] <= 0) {
        delete d.botAt[p.id];
        const left = d.def.a.map((_, i) => i).filter(i => !d.tried[p.id].has(i));
        const wrongs = left.filter(i => i !== d.def.c);
        duelAnswer(p, d, (wrongs.length && Math.random() >= BOT_ACC) ? wrongs[Math.floor(Math.random() * wrongs.length)] : d.def.c);
        if (d.done) break;
      }
    }
    if (!d.done && d.t <= 0) { d.result = 'fight'; endDuel(d); }  // nobody answered: plain brawl
  }
}
function canDuel(p, o) {
  return o.opp === p && !p.duel && !o.duel && !p.dead && !o.dead && p.noQuizWith !== o.id && o.noQuizWith !== p.id;
}

// ---------- quiz modal (solo human & phones) ----------
let quizOpen = false, quizBtns = null, quizChoice = -1, quizN = 0, quizLeft = 0, quizUnlock = null;
const qbox = document.getElementById('quizbox');
function fillModal(def, n, secs, onPick) {
  const opts = document.getElementById('qopts');
  const qres = document.getElementById('qres');
  document.getElementById('qq').textContent = def.q;
  opts.innerHTML = ''; qres.style.display = 'none'; qres.className = '';
  let pending = false;
  quizBtns = []; quizChoice = -1; quizN = n; quizLeft = secs;
  const tried = new Set(def.tried || []);
  def.a.forEach((txt, i) => {
    const b = document.createElement('button');
    b.textContent = txt;
    if (tried.has(i)) { b.disabled = true; b.classList.add('bad'); }
    b.addEventListener('click', () => {
      if (pending || b.disabled) return;                          // one answer in flight at a time — no spamming
      pending = true; quizChoice = i;
      quizBtns.forEach(x => x.disabled = true);
      b.classList.add('picked');
      onPick(i);
    });
    quizBtns.push(b); opts.appendChild(b);
  });
  quizUnlock = () => { pending = false; quizBtns.forEach(x => { if (!x.classList.contains('bad')) x.disabled = false; }); };
  qbox.style.display = 'flex'; quizOpen = true;
  quizTotal = secs;
  renderTimer();
}
let quizTotal = QUIZ_T;
function renderTimer() {
  const t = document.getElementById('qtimer'), bar = document.getElementById('qbar');
  t.textContent = Math.ceil(quizLeft);
  t.classList.toggle('urgent', quizLeft <= 3);
  bar.style.width = Math.max(0, 100 * quizLeft / quizTotal) + '%';
  bar.classList.toggle('urgent', quizLeft <= 3);
}
function showModalResult(res) {                                  // only wrong answers come through here now
  if (!quizOpen || res.n !== quizN) return;
  const qres = document.getElementById('qres');
  if (quizBtns[res.chosen]) { quizBtns[res.chosen].classList.remove('picked'); quizBtns[res.chosen].classList.add('bad'); }
  qres.className = 'bad';
  qres.innerHTML = '✘  Wrong  −' + res.dmg + ' ❤<span class="lock">try another answer — every miss costs HP</span>';
  qres.style.display = 'block';
  if (quizUnlock) quizUnlock();
}
function closeQuizNow() { qbox.style.display = 'none'; quizOpen = false; quizBtns = null; }
function duelVerdict(w, ans, won, buff, amt) {                    // no dialog: a ribbon over the field, then the fight decides
  closeQuizNow();
  const prize = buff === 'heal' ? '+' + amt + ' ❤' : '+' + amt + ' ⚡';
  pop(won ? '✔ Correct! ' + prize : '✘ Too slow!', true);
  hint((won ? 'You' : w.name) + ' answered first (' + ans + ') → ' + prize + ' + first strike · ⚔ now the swords decide', 5000);
}
function openQuizSolo(d) { fillModal(d.def, d.n, d.t, i => duelAnswer(human, d, i)); }
function quizTimerTick(dt) {
  if (!quizOpen) return;
  quizLeft = Math.max(0, quizLeft - dt);
  renderTimer();
  if (quizLeft <= 0 && MODE === 'client') closeQuizNow();       // host's qclose normally arrives first
}

// ---------- the simulation (solo & host) ----------
let over = false;
let phase = MODE === 'solo' ? 'battle' : 'lobby';                 // lobby = warm-up: everyone roams, nobody fights
function wanderMove(p, dt, b) {                                   // bot autopilot: stroll, pause, look around
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
  if (p.rest) { setAnim(p, 'Idle'); return [0, 0]; }
  const dx = p.wx - p.x, dy = p.wy - p.y, d = Math.hypot(dx, dy) || 1;
  p.face = dx >= 0 ? 1 : -1;
  setAnim(p, 'Run');
  return [dx / d * p.speed * .55, dy / d * p.speed * .55];
}
function warmTick(dt) {                                           // lobby: phones run free, bots stroll, no fighting
  const b = BOUNDS();
  for (const p of players) {
    if (isCtrl(p)) steerFromTarget(p); else { p.steer.x = p.steer.y = 0; }
    let vx = 0, vy = 0;
    if (Math.hypot(p.steer.x, p.steer.y) > .1) {
      vx = p.steer.x * p.speed; vy = p.steer.y * p.speed;
      if (Math.abs(vx) > 10) p.face = vx >= 0 ? 1 : -1;
      setAnim(p, 'Run');
    } else { const v = wanderMove(p, dt, b); vx = v[0]; vy = v[1]; }
    moveAndDraw(p, vx, vy, dt, b, true);
  }
}
function battleTick(dt) {
  const b = BOUNDS();
  for (const p of players) {
    if (p.dead) { draw(p, dt); continue; }
    if (p.pend) { p.pend.at -= dt; if (p.pend.at <= 0) { const pd = p.pend; p.pend = null; applyHit(p, pd.target); } }
    if (p.lunge > 0) p.lunge = Math.max(0, p.lunge - dt);
    if (p.atkHold) { p.atkHold -= dt; if (p.atkHold <= 0) p.atkHold = 0; }
    if (p.esc > 0) {
      p.esc = Math.max(0, p.esc - dt);
      p.escFrac = p.esc / p.escMax;
      if (isCtrl(p)) setBars(p);
    }
    if (p.restT > 0) { p.restT -= dt; if (p.restT <= 0) { p.restT = 0; setTimeout(rematch, 50); } }   // rest over: back into the pool
    if (isCtrl(p) && p.state !== 'champion') steerFromTarget(p); else { p.steer.x = p.steer.y = 0; }
    const steering = isCtrl(p) && Math.hypot(p.steer.x, p.steer.y) > .1;
    let vx = 0, vy = 0;
    if (p.state === 'champion') {
      const dx = p.tx - p.x, dy = p.ty - p.y, d = Math.hypot(dx, dy);
      if (d > 8) { vx = dx / d * p.speed; vy = dy / d * p.speed; setAnim(p, 'Run'); p.face = dx >= 0 ? 1 : -1; }
      else if (!p.crowned) { p.crowned = true; setAnim(p, 'Idle'); p.face = 1; addCrown(p); }
    } else if (p.opp && !p.opp.dead) {
      const M = MELEE[p.t], o = p.opp, dx = o.x - p.x, dy = o.y - p.y, d = Math.hypot(dx, dy) || 1;
      const striking = p.lunge > 0 || p.atkHold > 0;
      if (!p.duel && !striking && canDuel(p, o) && d <= Math.max(M.reach, MELEE[o.t].reach) + 6) startDuel(p, o);   // they met: quiz first
      if (p.duel) {                                                // locked in the duel: stand your ground, face them
        p.state = 'duel';
        if (!(p.lunge > 0 || p.atkHold > 0)) { p.face = dx >= 0 ? 1 : -1; if (!(p.animSt === 'Attack' && p.animT < .4)) setAnim(p, 'Idle'); }
        if (d < 26) { vx = -dx / d * 40; vy = -dy / d * 40; }
        moveAndDraw(p, vx, vy, dt, b, true);
        continue;
      }
      p.cd -= dt;                                                  // cooldown always ticks — runners come back ready
      if (striking) {
        // hold still mid-swing
      } else if (steering) {
        // the PULL: toward the stand-off spot beside your opponent. Your tap fights it — and wins only inside the escape window.
        const free = p.esc > 0;
        const cw = free ? CTRL_SPD : CTRL_PULLED, pw = free ? ESC_PULL : 1;
        let px = 0, py = 0;
        if (d > M.close) {
          const tx = o.x - Math.sign(dx) * M.stand, ty = o.y;
          const dd = Math.hypot(tx - p.x, ty - p.y) || 1;
          px = (tx - p.x) / dd; py = (ty - p.y) / dd;
        } else if (d < 26) { px = -dx / d * .3; py = -dy / d * .3; }
        vx = (p.steer.x * cw + px * pw) * p.speed; vy = (p.steer.y * cw + py * pw) * p.speed;
        const vm = Math.hypot(vx, vy), cap = p.speed * CTRL_SPD;
        if (vm > cap) { vx *= cap / vm; vy *= cap / vm; }
        p.state = d > M.close ? 'seek' : 'fight';
        if (vm > 14) { p.face = Math.abs(vx) > 10 ? (vx >= 0 ? 1 : -1) : (dx >= 0 ? 1 : -1); setAnim(p, 'Run'); }
        else { p.face = dx >= 0 ? 1 : -1; if (!(p.animSt === 'Attack' && p.animT < .4)) setAnim(p, 'Idle'); }
      } else if (d > M.close) {
        p.state = 'seek';
        p.face = dx >= 0 ? 1 : -1;
        p.wt -= dt; if (p.wt <= 0) { p.wt = rnd(.3, .7); p.swx = rnd(-30, 30); p.swy = rnd(-24, 24); }
        const tx = o.x - Math.sign(dx) * M.stand + (p.swx || 0), ty = o.y + (p.swy || 0);
        const dd = Math.hypot(tx - p.x, ty - p.y) || 1;
        vx = (tx - p.x) / dd * p.speed; vy = (ty - p.y) / dd * p.speed;
        setAnim(p, 'Run');
      } else {
        p.state = 'fight';
        p.face = dx >= 0 ? 1 : -1;
        if (d < 26) { vx = -dx / d * 50; vy = -dy / d * 50; }
        if (!(p.animSt === 'Attack' && p.animT < .4)) setAnim(p, 'Idle');
      }
      if (!striking && p.cd <= 0 && !p.pend && d <= M.reach && !o.duel) strike(p);
    } else if (steering) {                                         // nobody to fight yet: roam freely
      p.state = 'roam';
      vx = p.steer.x * p.speed * CTRL_SPD; vy = p.steer.y * p.speed * CTRL_SPD;
      p.face = Math.abs(vx) > 10 ? (vx >= 0 ? 1 : -1) : p.face;
      setAnim(p, 'Run');
    } else { const v = wanderMove(p, dt, b); vx = v[0]; vy = v[1]; }
    moveAndDraw(p, vx, vy, dt, b, true);
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
  const fps = p.animSt === 'Run' ? 10 : p.animSt === 'Attack' ? MELEE[p.t].fps : 7;
  const fr = Math.floor(p.animT * fps) % p.animN;
  p.spr.texture = frameTex(p.sheet, fr, p.cell * 2, p.cell * 2);
  if (p.animSt === 'Attack' && p.animT * fps >= p.animN) setAnim(p, 'Idle');
  let ox = 0, oy = 0;
  if (p.lunge > 0 && p.lungeDir) {
    const amp = Math.sin(Math.PI * (1 - p.lunge / p.lungeMax)) * MELEE[p.t].lunge;
    ox = p.lungeDir.x * amp; oy = p.lungeDir.y * amp;
  }
  if (p.hopT > 0) { p.hopT = Math.max(0, p.hopT - dt); oy -= 22 * Math.abs(Math.sin(2 * Math.PI * (1 - p.hopT))); }
  p.cont.x = p.x + ox; p.cont.y = p.y + oy;
  p.cont.zIndex = Math.round(p.y);
  const s = .62 + .26 * (p.y / H0);
  p.body.scale.set(s * (p.face < 0 ? -1 : 1), s);
  p.ui.scale.set(s);
  if (p.qmark) {
    p.qmark.visible = !p.dead && !!p.duel;
    if (p.qmark.visible) {
      p.qmark.y = -212 - 5 * (1 + Math.sin(crownTime * 6));
      const secs = MODE === 'client' ? p.duel : (p.duel && p.duel.t !== undefined ? Math.max(1, Math.ceil(p.duel.t)) : 0);
      const txt = secs > 0 ? '❓ ' + secs : '❓';
      if (p.qmark.text !== txt) p.qmark.text = txt;
    }
  }
  if (p.ring) {
    const on = !p.dead && p.escFrac > 0 && (isCtrl(p) || (MODE === 'client' && p.id === myId));
    p.ring.visible = on;
    if (on) { p.ring.scale.set(s * (1 + .08 * Math.sin(crownTime * 9))); p.ring.alpha = .45 + .55 * p.escFrac; }
  }
}
function finale(champ) {
  over = true;
  clearTap();
  banner.textContent = '\u{1F451} ' + champ.name + ' rules the island!';
  pop('\u{1F451} ' + champ.name + '!');
  mpAll({ t: 'fin', id: champ.id, name: champ.name });
  champ.state = 'champion'; champ.opp = null; champ.pend = null; champ.esc = 0; champ.escFrac = 0; champ.steer.x = champ.steer.y = 0;
  champ.surv = (performance.now() - T0) / 1000;
  champ.tx = ISL.x + ISL.w / 2; champ.ty = ISL.y + ISL.h * .5;
  champ.final = true; champ.finalRank = 1;
  refreshBoard();
  if (champ.row) champ.row.classList.add('pop');
  const again = document.getElementById('again');
  if (MODE === 'host') { again.href = '#'; again.innerHTML = '&#8635; Play again &middot; same room'; }
  else again.href = location.pathname + '?players=' + P;
  again.style.display = 'block';
  confetti();
}
document.getElementById('again').addEventListener('click', e => { if (MODE === 'host') { e.preventDefault(); hostReset(); } });
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
const ICO = { Warrior: '\u{1F5E1}', Lancer: '⚔', Pawn: '\u{1FA93}' };
function buildBoard() {
  const rankEl = document.getElementById('ranking');
  rankEl.innerHTML = '';
  rankEl.style.height = (players.length * 26) + 'px';
  players.forEach((q, i) => {
    const r = document.createElement('div'); r.className = 'rrow';
    const me = q.human || (MODE === 'client' && q.id === myId);
    const who = (q.remote || me ? '\u{1F4F1} ' : '') + ICO[q.t] + ' ' + q.name.replace(/[<>&]/g, '');
    r.innerHTML = '<span><span class="rknum">' + (i + 1) + '.</span> <span class="who' + (me ? ' me' : '') + '">' + who + '</span></span><span class="tt">❤100 ⚡0</span>';
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
function beginBattle() {
  T0 = performance.now();
  banner.textContent = '⚔ ' + players.length + ' fighters — last one standing wins';
  pop('⚔ FIGHT ⚔');
  mpAll({ t: 'pop', txt: '⚔ FIGHT ⚔' });
  setTimeout(rematch, 900);
}

// ---------- reset: same room, same phones — back to the lobby for another round ----------
function clearField() {
  clearTap();
  for (const p of players) { if (p.cont && !p.cont.destroyed) { if (p.cont.parent) scene.removeChild(p.cont); p.cont.destroy({ children: true }); } }
  players = []; fallen.length = 0; human = null;
  for (const k in byId) delete byId[k];
  crowns.length = 0; FXS.length = 0; duels.length = 0; closeQuizNow();
  document.querySelectorAll('.confetti').forEach(c => c.remove());
  document.getElementById('podium').style.display = 'none';
  document.getElementById('again').style.display = 'none';
  hintEl.classList.remove('show');
  over = false;
}
function hostReset() {
  clearField();
  phase = 'lobby'; started = false; snapAcc = 0;
  mpAll({ t: 'reset' });
  for (const [id, name] of lobby) { const k = nextKit(); addFighter(fighterProps({ id, name, c: k.c, t: k.t, remote: true })); }
  syncBots(); sendRoster();
  document.getElementById('lobby').style.display = 'flex';
  document.getElementById('hostreset').style.display = 'none';
  pop('\u{1F504} NEW ROUND');
}
// live roster: knights exist from the moment the room opens; phones get theirs the moment they join
let kitIdx = 0, KITS = null, botN = 0;
function nextKit() {
  if (!KITS) KITS = shuffle(COLORS.flatMap(c => TYPES.map(t => ({ c, t }))));
  const k = KITS[kitIdx % KITS.length], gen = Math.floor(kitIdx / KITS.length); kitIdx++;
  return { c: k.c, t: k.t, suffix: gen ? ' ' + 'II III IV V'.split(' ')[Math.min(3, gen - 1)] : '' };
}
function addFighter(p) { players.push(p); byId[p.id] = p; makeFighter(p); return p; }
function removeFighter(p) {
  players = players.filter(q => q !== p); delete byId[p.id];
  if (p.cont && !p.cont.destroyed) { if (p.cont.parent) scene.removeChild(p.cont); p.cont.destroy({ children: true }); }
}
function syncBots() {                                             // bots fill the field: 8 minimum, phones + 5, 20 cap
  const remotes = players.filter(p => p.remote).length;
  const want = Math.min(20, Math.max(8, remotes + 5)) - remotes;
  const bots = players.filter(p => !p.remote);
  while (bots.length < want) { const k = nextKit(); bots.push(addFighter(fighterProps({ id: 'b' + (botN++), name: k.c + ' ' + LABEL[k.t] + k.suffix, c: k.c, t: k.t }))); }
  while (bots.length > want) removeFighter(bots.pop());
}
const rosterMsg = () => players.map(p => [p.id, p.name, p.c, p.t]);
function lobbyBanner() {
  const n = players.filter(p => p.remote).length;
  banner.textContent = '\u{1F4F1} scan to join — ' + (n ? n + ' knight' + (n > 1 ? 's' : '') + ' warming up' : 'nobody yet');
}
function sendRoster() { mpAll({ t: 'roster', roster: rosterMsg(), ph: phase }); lobbyBanner(); }

// ---------- HOST mode ----------
async function initHost() {
  const lobbyEl = document.getElementById('lobby');
  lobbyEl.classList.add('side');                                  // the island stays visible: knights warm up behind the QR
  lobbyEl.style.display = 'flex';
  syncBots(); lobbyBanner();
  const res = await fetch('/api/room', { method: 'POST' });
  const { code } = await res.json();
  const joinUrl = location.origin + '/bq/' + code;
  document.getElementById('roomcode').textContent = code;
  const qr = window.qrcode(0, 'M');
  qr.addData(joinUrl); qr.make();
  document.getElementById('qrbox').innerHTML = qr.createImgTag(4, 6);
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
      if (back) {                                                 // their knight is theirs again (mid-duel: re-send the question)
        back.remote = true; back.speed = HUMAN_SPD; setBars(back);
        const d = back.duel;
        if (d && !d.done) { delete d.botAt[back.id]; mpTo(m.id, { t: 'quiz', n: d.n, q: d.def.q, a: d.def.a, s: Math.max(1, d.t), tried: [...d.tried[back.id]] }); }
      }
      else if (phase === 'lobby') {                               // a knight appears the moment they join
        const k = nextKit();
        addFighter(fighterProps({ id: m.id, name: m.name, c: k.c, t: k.t, remote: true }));
        syncBots();
      }
      if (phase === 'battle') mpTo(m.id, { t: 'start', roster: rosterMsg(), late: back ? 0 : 1 });
      else sendRoster();
    } else if (m.t === 'leave') {
      lobby.delete(m.id); renderNames();
      const p = byId[m.id];
      if (!p) return;
      if (phase === 'lobby') { removeFighter(p); syncBots(); sendRoster(); }
      else if (!p.dead) { p.remote = false; p.tx = p.ty = null; p.speed = rnd(CFG.spdMin, CFG.spdMax); setBars(p); if (p.duel) botThink(p, p.duel); }   // fights on as a bot
    } else if (m.t === 'answer') {
      const p = byId[m.id];
      if (p && p.remote && p.duel && !p.duel.done && m.n === p.duel.n) duelAnswer(p, p.duel, m.choice | 0);   // stale answers are dropped
    } else if (m.t === 'input') {
      const p = byId[m.id];
      if (p && p.remote && !p.dead && !p.duel) {
        const b = BOUNDS();
        p.tx = Math.max(b.x0, Math.min(b.x1, +m.x || 0));
        p.ty = Math.max(b.y0, Math.min(b.y1, +m.y || 0));
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
  const resetLink = document.getElementById('hostreset');
  resetLink.addEventListener('click', e => { e.preventDefault(); if (started) hostReset(); });
  document.getElementById('startbtn').addEventListener('click', () => {
    if (phase === 'battle') return;
    phase = 'battle'; started = true;
    lobbyEl.style.display = 'none';
    resetLink.style.display = '';
    syncBots();
    players.forEach(p => { p.opp = null; p.tx = p.ty = null; p.cd = rnd(.2, .6); });   // the warm-up knights ARE the roster
    buildBoard();
    refreshBoard();
    mpAll({ t: 'start', roster: rosterMsg() });
    beginBattle();
  });
}
let snapAcc = 0;
function hostNet(dt) {
  snapAcc += dt;
  if (snapAcc < .08) return;
  snapAcc = 0;
  mpAll({
    t: 'snap',
    ps: players.map(p => [p.id, Math.round(p.x), Math.round(p.y), Math.round(p.hp), p.face, ANIMI[p.animSt] || 0, p.dead ? 1 : 0,
                          Math.round(Math.max(0, Math.min(1, p.escFrac)) * 10), p.dmg, p.duel ? Math.max(1, Math.ceil(p.duel.t)) : 0, p.str]),
    bn: banner.textContent, ph: phase,
  });
}

// ---------- CLIENT mode ----------
let snapA = null, snapB = null;
function initClient() {
  const jb = document.getElementById('joinbox');
  jb.style.display = 'flex';
  banner.textContent = '';
  const jstatus = document.getElementById('jstatus');
  const tokKey = 'tk-bq-tok-' + JOIN_CODE, nameKey = 'tk-bq-name-' + JOIN_CODE;
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
      if (ws !== sock) return;                                    // superseded socket
      if (!started) jstatus.textContent = '⚠ reconnecting…';
      else if (!over) banner.textContent = '⚠ reconnecting…';
      retries++;
      setTimeout(() => { if (ws === sock) doJoin(joinName); }, Math.min(5000, 800 * retries));   // even after a finale — the host may restart
    };
  };
  clientReconnect = () => { if (joinName && sock && sock.readyState > 1) doJoin(joinName); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) clientReconnect(); });
  document.getElementById('jbtn').addEventListener('click', () => {
    doJoin((document.getElementById('jname').value || '').trim() || 'Knight ' + Math.floor(rnd(2, 99)));
  });
  document.getElementById('jname').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('jbtn').click(); });
  let savedName = '';
  try { savedName = localStorage.getItem(nameKey) || ''; } catch (e) {}
  if (savedName) { jstatus.textContent = 'reconnecting…'; doJoin(savedName); }   // reload = seamless rejoin
  else { try { document.getElementById('jname').value = ''; } catch (e) {} }
}
function syncRoster(roster) {                                      // add newcomers, drop leavers, keep everyone else
  const ids = new Set(roster.map(r => r[0]));
  for (const p of players) if (!ids.has(p.id)) { if (p.cont && !p.cont.destroyed) { if (p.cont.parent) scene.removeChild(p.cont); p.cont.destroy({ children: true }); } delete byId[p.id]; }
  players = roster.map(r => byId[r[0]] || (byId[r[0]] = fighterProps({ id: r[0], name: r[1], c: r[2], t: r[3] })));
  for (const p of players) if (!p.cont) makeFighter(p);
  human = byId[myId] || null;
  if (human && human.px === undefined) { human.px = human.x; human.py = human.y; setBars(human); }
  buildBoard();
}
function onClientMsg(m, jb, jstatus) {
  if (m.t === 'welcome') {
    myId = m.id;
    jstatus.innerHTML = '✅ joined as <b>' + m.name.replace(/[<>&]/g, '') + '</b><br>loading the island…';
  } else if (m.t === 'roster') {                                 // the warm-up field, live
    phase = m.ph || 'lobby';
    syncRoster(m.roster);
    if (phase === 'lobby') {
      spectate = false;
      jb.style.display = 'none';
    }
  } else if (m.t === 'start') {
    started = true; phase = 'battle';
    syncRoster(m.roster);
    spectate = !byId[myId];                                      // joined mid-battle: watch, play next round
    jb.style.display = 'none';
    pop(spectate ? '\u{1F440} spectating' : '⚔ FIGHT ⚔');
    if (spectate) hint('👀 battle in progress — you join the next round', 8000);
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
    fillModal({ q: m.q, a: m.a, tried: m.tried }, m.n, m.s || QUIZ_T, i => mpAll({ t: 'answer', n: m.n, choice: i }));
  } else if (m.t === 'verdict') {
    duelVerdict(m.w, m.ans, !!m.won, m.buff, m.amt);
  } else if (m.t === 'quizres') {
    showModalResult(m);
  } else if (m.t === 'qclose') {
    closeQuizNow();
    hint('⏱ time — ⚔ the swords decide', 3000);
  } else if (m.t === 'dodge') {
    const p = byId[m.id];
    if (p) floatTxt(p, 'dodge!', 0x5ec8ff, 20);
  } else if (m.t === 'pop') {
    pop(m.txt);
  } else if (m.t === 'fin') {
    over = true;
    clearTap();
    const p = byId[m.id];
    if (p) addCrown(p);
    pop('\u{1F451} ' + m.name + '!');
    banner.textContent = '\u{1F451} ' + m.name + ' rules the island!';
    confetti();
  } else if (m.t === 'reset') {
    clearField();
    started = false; spectate = false; snapA = snapB = null; phase = 'lobby';
    closeQuizNow();
    banner.textContent = '';
    hint('\u{1F504} new round — warm up until the host starts', 6000);
  } else if (m.t === 'hostgone') {
    banner.textContent = '⚠ the host has left the island';
  }
}
function clientRender(dt) {
  if (!snapB || !players.length) return;
  const A = snapA || snapB, B = snapB;
  const span = Math.max(40, B.at - A.at);
  const k = Math.min(1.25, Math.max(0, (performance.now() - 100 - A.at) / span));
  const amap = {};
  A.ps.forEach(e => { amap[e[0]] = e; });
  if (!over) banner.textContent = B.bn || banner.textContent;
  if (B.ph) phase = B.ph;
  for (const e of B.ps) {
    const p = byId[e[0]];
    if (!p || !p.cont || p.cont.destroyed) continue;
    const a = amap[e[0]] || e;
    let X = a[1] + (e[1] - a[1]) * k, Y = a[2] + (e[2] - a[2]) * k;
    const escFrac = (e[7] || 0) / 10;
    let steering = false;
    if (p === human && !p.dead && !over) {
      if (p.ptx != null) {                                        // predict your own run; the snapshot reels you back in
        const dx = p.ptx - p.px, dy = p.pty - p.py, d = Math.hypot(dx, dy);
        if (d > 10) {
          const w = phase === 'lobby' ? 1 : escFrac > 0 ? CTRL_SPD : CTRL_PULLED;
          p.px += dx / d * HUMAN_SPD * w * dt; p.py += dy / d * HUMAN_SPD * w * dt;
          if (Math.abs(dx) > 10) p.face = dx >= 0 ? 1 : -1;
          steering = true;
        } else { p.ptx = null; clearTap(); }
      }
      p.px += (X - p.px) * (steering ? .12 : .3); p.py += (Y - p.py) * (steering ? .12 : .3);
      X = p.px; Y = p.py;
    }
    const an = ANIMS[e[5]] || 'Idle';
    if (steering && an !== 'Attack') { if (p.animSt !== 'Run') setAnim(p, 'Run'); }
    else if (an !== p.animSt) setAnim(p, an, an === 'Attack');
    p.x = X; p.y = Y;
    if (p.hp !== e[3] || p.escFrac !== escFrac || p.str !== (e[10] || 0)) { p.hp = e[3]; p.escFrac = escFrac; p.str = e[10] || 0; setBars(p); }
    p.dmg = e[8] || 0;
    p.duel = e[9] || null;                                       // seconds left in their duel, 0 = not duelling
    if (!steering) p.face = e[4];
    if (e[6] && !p.dead) { p.dead = true; koVisual(p); if (p === human) { p.ptx = null; clearTap(); hint('💀 you fell — watching the rest', 6000); } }
    draw(p, dt);
  }
  refreshBoardClient();
}
function refreshBoardClient() {
  const alive = players.filter(q => !q.dead).sort((a, b) => b.hp - a.hp || b.dmg - a.dmg);
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
  beginBattle();
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
  if (MODE === 'client') { clientRender(dt); if (quizOpen && performance.now() - lastMsgAt > 6000) closeQuizNow(); }
  else if (MODE === 'solo') { if (started) { duelTick(dt); battleTick(dt); } }
  else if (players.length) {
    if (phase === 'battle') { duelTick(dt); battleTick(dt); } else warmTick(dt);
    hostNet(dt);
  }
  quizTimerTick(dt);
  updateCamera(dt);
  fxTick(dt);
  crowns.forEach(c => { c.y = -205 - 6 * (1 + Math.sin(crownTime * 3.4)); });
  if (water) { water.tilePosition.x += 4 * dt; water.tilePosition.y += 8 * dt; }
  for (const cl of clouds) { cl.c.x += cl.sp * dt; if (cl.c.x > W0 + 320) cl.c.x = -320; }
 } catch (e) { console.error('tick error:', e.message, e.stack); }
});
// debug handles (used by the harness probes)
window.OBST = OBST; window.inObst = inObst; window.__world = world; window.__isFollow = () => followMode;
window.__byId = byId; window.__mode = MODE; window.__sock = () => sock;
window.CFG = CFG; window.__duels = duels; window.QUIZ_POOL_ACTIVE = QUIZ_POOL;
Object.defineProperty(window, 'quizOpen', { get: () => quizOpen });
Object.defineProperty(window, 'players', { get: () => players });
Object.defineProperty(window, 'human', { get: () => human });
Object.defineProperty(window, 'over', { get: () => over });
Object.defineProperty(window, 'started', { get: () => started });
Object.defineProperty(window, 'phase', { get: () => phase });
Object.defineProperty(window, 'snapB', { get: () => snapB });
})();
