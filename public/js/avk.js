/* Archers vs Knights — PIXI battle royale (sim logic mirrors /survival-island, per-class attacks) */
(async () => {
const rnd = (a, b) => a + Math.random() * (b - a);
const P = Math.max(2, Math.min(30, parseInt(new URLSearchParams(location.search).get('players'), 10) || 10));
document.querySelectorAll('#controls a').forEach(a => { if (a.search === '?players=' + P) a.classList.add('on'); });

// ---------- tunable combat params (shared tk-params storage — survive reload) ----------
const DEFAULTS = { total: 15, dmgMin: 24, dmgMax: 36, crit: 15, critMult: 2.1, heal: 25, cdMin: .8, cdMax: 1.3,
                   spdMin: 175, spdMax: 215, arrDmgMin: 11, arrDmgMax: 18, arrCdMin: .9, arrCdMax: 1.4 };
const CFG = Object.assign({}, DEFAULTS);
try { Object.assign(CFG, JSON.parse(localStorage.getItem('tk-params') || '{}')); } catch (e) {}
for (const k in DEFAULTS) if (typeof CFG[k] !== 'number' || isNaN(CFG[k])) CFG[k] = DEFAULTS[k];
function saveCFG() { try { localStorage.setItem('tk-params', JSON.stringify(CFG)); } catch (e) {} }
const FIELDS = [
  ['dmgMin', 'Sword dmg min', 1], ['dmgMax', 'Sword dmg max', 1],
  ['arrDmgMin', 'Arrow dmg min', 1], ['arrDmgMax', 'Arrow dmg max', 1],
  ['arrCdMin', 'Arrow cd min (s)', .05], ['arrCdMax', 'Arrow cd max (s)', .05],
  ['crit', 'Crit chance %', 1], ['critMult', 'Crit multiplier', .1],
  ['heal', 'Heal after kill', 5], ['cdMin', 'Sword cd min (s)', .05], ['cdMax', 'Sword cd max (s)', .05],
  ['spdMin', 'Run speed min', 5], ['spdMax', 'Run speed max', 5],
];
const tuner = document.getElementById('tuner');
tuner.innerHTML = '<h3>&#9881; Battle tuning</h3>' + FIELDS.map(f =>
  '<div class="row"><span>' + f[1] + '</span><input type="number" step="' + f[2] + '" data-k="' + f[0] + '" value="' + CFG[f[0]] + '"></div>').join('') +
  '<div class="note">saved automatically &middot; survives reload</div><button id="cfgreset">Reset defaults</button>';
function clampN(v, a, b) { return Math.max(a, Math.min(b, v)); }
function applyTotal(T) {
  const s = Math.pow(Math.max(2, T - 5) / 10.5, .608);
  CFG.cdMin = +clampN(.8 * s, .25, 3.2).toFixed(2);
  CFG.cdMax = +clampN(1.3 * s, .35, 4.5).toFixed(2);
  CFG.dmgMin = Math.round(clampN(24 / s, 4, 90));
  CFG.dmgMax = Math.round(clampN(36 / s, 6, 99));
  CFG.arrCdMin = +clampN(.9 * s, .3, 3.4).toFixed(2);
  CFG.arrCdMax = +clampN(1.4 * s, .45, 4.8).toFixed(2);
  CFG.arrDmgMin = Math.round(clampN(11 / s, 3, 70));
  CFG.arrDmgMax = Math.round(clampN(18 / s, 4, 90));
  CFG.heal = DEFAULTS.heal;
  tuner.querySelectorAll('input').forEach(i => { if (i.dataset.k !== 'total') i.value = CFG[i.dataset.k]; });
  const lb = document.getElementById('lenin'); if (lb) lb.value = T;
}
tuner.addEventListener('input', e => {
  const k = e.target.dataset.k; if (!k) return;
  const v = parseFloat(e.target.value);
  if (isNaN(v)) return;
  CFG[k] = v;
  if (k === 'total') applyTotal(v);
  saveCFG();
  if (k.indexOf('spd') === 0) players.forEach(q => { if (!q.dead) q.speed = rnd(CFG.spdMin, CFG.spdMax); });
});
document.getElementById('cfgreset').addEventListener('click', () => {
  Object.assign(CFG, DEFAULTS); saveCFG();
  tuner.querySelectorAll('input').forEach(i => { i.value = CFG[i.dataset.k]; });
  const lb = document.getElementById('lenin'); if (lb) lb.value = CFG.total;
  players.forEach(q => { if (!q.dead) q.speed = rnd(CFG.spdMin, CFG.spdMax); });
});
document.getElementById('tunebtn').addEventListener('click', e => {
  e.preventDefault(); tuner.style.display = tuner.style.display === 'block' ? 'none' : 'block';
});
const lenin = document.getElementById('lenin');
lenin.value = CFG.total;
lenin.addEventListener('input', () => {
  const v = parseFloat(lenin.value);
  if (isNaN(v)) return;
  CFG.total = v; applyTotal(v); saveCFG();
});
const banner = document.getElementById('banner');

// ---------- roster: shuffled solo kits of the 4 fighting classes ----------
const COLORS = ['Blue', 'Red', 'Yellow', 'Purple', 'Black'];
const FRAMES = { Warrior: { Idle: 8, Run: 6, Attack: 4 }, Archer: { Idle: 6, Run: 4, Shoot: 8 },
                 Lancer: { Idle: 12, Run: 6, Attack: 3 }, Pawn: { Idle: 8, Run: 6, Attack: 6 } };
const CELL = { Lancer: 320 };
const MELEE = {
  Warrior: { close: 52, reach: 60, stand: 40, hold: .42, at: .26, fps: 10, dmgF: 1.2, cdF: 1, lunge: 14 },
  Lancer:  { close: 95, reach: 108, stand: 84, hold: .34, at: .2, fps: 9, dmgF: 1.15, cdF: 1.1, lunge: 8 },
  Pawn:    { close: 44, reach: 50, stand: 34, hold: .45, at: .3, fps: 14, dmgF: 1, cdF: .75, lunge: 12 },
};
const LABEL = { Warrior: 'Knight', Archer: 'Archer', Lancer: 'Lancer', Pawn: 'Pawn' };
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const KITS = shuffle(COLORS.flatMap(c => ['Warrior', 'Archer', 'Lancer', 'Pawn'].map(t => ({ c, t }))));
const players = Array.from({ length: P }, (_, i) => {
  const k = KITS[i % KITS.length];
  return { name: k.c + ' ' + LABEL[k.t] + (i >= KITS.length ? ' II' : ''), c: k.c, t: k.t };
});
players.forEach(p => Object.assign(p, {
  hp: 100, dmg: 0, dead: false, opp: null, state: 'wander', cd: rnd(.2, .6),
  wx: 0, wy: 0, wt: 0, swx: 0, swy: 0, speed: rnd(CFG.spdMin, CFG.spdMax),
  pend: null, pendShot: null, lunge: 0, lvx: 0, lvy: 0, hopT: 0, face: 1,
}));

// ---------- PIXI stage ----------
PIXI.BaseTexture.defaultOptions.scaleMode = PIXI.SCALE_MODES.NEAREST;
const app = new PIXI.Application({ resizeTo: window, background: 0x3d7fc4, antialias: false,
  resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: true });
document.getElementById('stage').appendChild(app.view);
const W = () => app.screen.width, H = () => app.screen.height;
const INK = 0x2b2b3d;

const urls = new Set(['tilemap', 'water-blue', 'foam', 'tower', 'house1', 'house2', 'tree1', 'tree2',
  'rock1', 'rock2', 'gold1', 'bush1', 'bush2', 'sheep_idle', 'cloud1', 'cloud2']
  .map(n => '/img/' + n + '.png'));
players.forEach(p => { for (const st in FRAMES[p.t]) urls.add('/img/2x/' + p.c + '_' + p.t + '_' + st + '.png'); });
urls.add('/img/2x/arrow.png');
players.forEach(p => urls.add('/img/ribs_' + p.c + '.png'));
await PIXI.Assets.load([...urls]);
for (const u of urls) if (u.indexOf('/img/2x/') === 0) {          // fat texels: hard pixels baked in, sampled smoothly
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
const waterL = new PIXI.Container(), foamL = new PIXI.Container(), tileL = new PIXI.Container(),
      scene = new PIXI.Container(), skyL = new PIXI.Container();
scene.sortableChildren = true;
app.stage.addChild(waterL, foamL, tileL, scene, skyL);

// ---------- scenery ----------
let ISL = null;
const OBST = [];
const inObst = (x, y) => OBST.some(o => x > o.x && x < o.x + o.w && y > o.y && y < o.y + o.h);
const BOUNDS = () => ISL
  ? { x0: ISL.x + 42, x1: ISL.x + ISL.w - 42, y0: ISL.y + 96, y1: ISL.y + ISL.h - 44 }
  : { x0: W() * .1, x1: W() * .9, y0: H() * .5, y1: H() * .84 };
const clouds = [];
let water = null;

function sprite(url, x, y, w, z) {
  const t = PIXI.Assets.get(url);
  const sp = new PIXI.Sprite(t);
  sp.x = x; sp.y = y;
  sp.scale.set(w / t.width);
  sp.zIndex = z !== undefined ? z : Math.round(y);
  scene.addChild(sp);
  return sp;
}
function variantSprite(url, fw, fh, variant, x, y, scale, zbase) {
  const sp = new PIXI.Sprite(frameTex(url, variant, fw, fh));
  sp.x = x; sp.y = y; sp.scale.set(scale);
  sp.zIndex = Math.round(y + fh * scale - 8);
  scene.addChild(sp);
  return sp;
}
function buildScenery() {
  const w = W(), h = H();
  const boardW = 385;
  const avail = Math.max(720, w - boardW);
  const cols = Math.max(10, Math.min(26, Math.floor((avail - 100) / 64)));
  const iy = Math.round(Math.max(h * .11, 152));
  const rows = Math.max(7, Math.min(13, Math.floor((h - iy - 46) / 64)));
  const ix = Math.round((avail - cols * 64) / 2);
  ISL = { x: ix, y: iy, w: cols * 64, h: rows * 64 };
  water = new PIXI.TilingSprite(PIXI.Assets.get('/img/water-blue.png'), w, h);
  waterL.addChild(water);
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
  sheep.x = ix + ISL.w * .12; sheep.y = iy + 176; sheep.scale.set(.8);
  sheep.animationSpeed = (6 / 1.5) / 60; sheep.play();
  sheep.zIndex = Math.round(iy + 176 + 128 * .8 - 8);
  scene.addChild(sheep);
  const mkCloud = (n, y, w2, sp, op) => {
    const c = new PIXI.Sprite(PIXI.Assets.get('/img/' + n + '.png'));
    c.y = y; c.x = rnd(-300, W()); c.alpha = op;
    c.scale.set(w2 / c.texture.width);
    skyL.addChild(c);
    clouds.push({ c, sp });
  };
  mkCloud('cloud1', 16, 300, 1.55 * w / 75, .8);
  mkCloud('cloud2', h * .6, 240, 1.55 * w / 105, .7);
  // solid ground footprints — towers, houses, tree trunks, rocks, gold
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

// ---------- FX (floating damage, stars, fades, crown bobs) ----------
const FXS = [];
function fx(o, dur, fn, end) { FXS.push({ o, t: 0, dur, fn, end }); }
function fxTick(dt) {
  for (let i = FXS.length - 1; i >= 0; i--) {
    const f = FXS[i];
    if (f.o && f.o.destroyed) { FXS.splice(i, 1); continue; }      // its target died elsewhere — drop the effect
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
function floatDmg(p, text, crit) {
  const t = TXT(text, crit ? 29 : 22, crit ? 0xffd24a : 0xffffff);
  t.anchor.set(.5); t.y = -165;
  p.ui.addChild(t);
  fx(t, 1, (o, k) => { o.y = -165 - 54 * k; o.alpha = 1 - k * k; }, o => o.destroy());
}
function star(p, ch) {
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
function setHP(p) {
  const g = p.hpg;
  g.clear();
  g.beginFill(INK, .8).drawRoundedRect(-43, -132, 86, 14, 6).endFill();
  const col = p.hp <= 35 ? 0xe2792b : 0x4fcf4f;
  if (p.hp > 0) g.beginFill(col).drawRoundedRect(-39, -128, Math.max(2, 78 * p.hp / 100), 6, 3).endFill();
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
  if (p.name.endsWith(' II')) { const f = new PIXI.ColorMatrixFilter(); f.hue(45, false); body.filters = [f]; }
  // name ribbon (9-slice of the pre-composed banner) + hp bar
  const ribTex = PIXI.Assets.get('/img/ribs_' + p.c + '.png');
  ribTex.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
  const plane = new PIXI.NineSlicePlane(ribTex, 40, 0, 40, 0);
  const nameT = TXT(p.name, 17, 0xffffff);
  nameT.anchor.set(.5);
  const pw = Math.max(102, nameT.width + 86);
  plane.width = pw; plane.height = 44;
  nameT.x = pw / 2; nameT.y = 18;
  const ribC = new PIXI.Container();
  ribC.addChild(plane, nameT);
  ribC.pivot.set(pw / 2, 0);
  ribC.y = -178;
  const hpg = new PIXI.Graphics();
  ui.addChild(ribC, hpg);
  cont.addChild(body, ui);
  scene.addChild(cont);
  p.cont = cont; p.body = body; p.ui = ui; p.spr = spr; p.hpg = hpg; p.cell = cell;
  setHP(p);
  const b = BOUNDS();
  for (let t = 0; t < 25; t++) { p.x = rnd(b.x0, b.x1); p.y = rnd(b.y0, b.y1); if (!inObst(p.x, p.y)) break; }
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

// ---------- match-making: free fighters run to the NEAREST free fighter ----------
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
function launchArrow(p, o) {
  if (p.dead || o.dead) return;
  const sx = p.x + p.face * 14, sy = p.y - 60;
  const d0 = Math.hypot(o.x - sx, o.y - sy);
  const T = Math.max(.16, d0 / ARR_SPD);
  const b = BOUNDS();
  const tx = Math.max(b.x0, Math.min(b.x1, o.x + o.lvx * T * .7));
  const ty = Math.max(b.y0, Math.min(b.y1, o.y + o.lvy * T * .7)) - 42;
  const el = new PIXI.Sprite(PIXI.Assets.get('/img/2x/arrow.png'));
  el.anchor.set(.5);
  el.scale.set(.5);
  scene.addChild(el);
  arrows.push({ sx, sy, tx, ty, t: 0, T: Math.max(.16, Math.hypot(tx - sx, ty - sy) / ARR_SPD),
                arc: Math.min(64, Math.hypot(tx - sx, ty - sy) * .12), el, from: p, target: o, px: sx, py: sy });
}
function damage(p, o, mn, mx) {
  if (over || o.dead) return;
  let dmg = Math.round(rnd(mn, mx));
  const crit = Math.random() < CFG.crit / 100;
  if (crit) dmg = Math.round(dmg * CFG.critMult);
  p.dmg += dmg;
  o.hp = Math.max(0, o.hp - dmg);
  setHP(o);
  o.spr.tint = 0xff9d9d; setTimeout(() => { o.spr.tint = 0xffffff; }, 200);
  o.x += (o.x >= p.x ? 5 : -5);
  floatDmg(o, (crit ? '\u{1F4A5} ' : '−') + dmg, crit);
  if (o.hp <= 0) kill(p, o);
}
function applyHit(p, o) {
  if (o.dead || p.dead || Math.hypot(o.x - p.x, o.y - p.y) > 150) return;
  const M = MELEE[p.t] || { dmgF: 1 };
  damage(p, o, CFG.dmgMin * M.dmgF, CFG.dmgMax * M.dmgF);
}
const fallen = [];
const T0 = performance.now();
const MEDALS = { 1: '\u{1F451}', 2: '\u{1F948}', 3: '\u{1F949}' };
function refreshBoard() {
  const alive = players.filter(q => !q.dead).sort((a, b) => (a.finalRank || 99) - (b.finalRank || 99));
  const list = [...alive, ...fallen.slice().reverse()];
  list.forEach((q, i) => {
    q.row.style.top = (i * 26) + 'px';
    if (q.dead || q.final) {
      q.row.querySelector('.rknum').textContent = MEDALS[q.finalRank] || q.finalRank + '.';
      q.row.querySelector('.rknum').classList.remove('pend');
      q.row.querySelector('.tt').textContent = q.surv.toFixed(1) + 's';
      q.row.querySelector('.tt').classList.remove('pend');
    }
  });
}
function kill(p, o) {
  o.dead = true; o.opp = null; if (p.opp === o) p.opp = null;
  o.surv = (performance.now() - T0) / 1000;
  const rot = 1.68 * (o.face < 0 ? -1 : 1);
  fx(o, .7, (q, k) => { q.body.rotation = rot * k; });
  fx(o, .8, (q, k) => { q.body.alpha = q.ui.alpha = 1 - .65 * k; });   // corpse and nameplate dim together
  star(o, '\u{1F4AB}');
  fallen.push(o);
  o.finalRank = players.length - fallen.length + 1;
  refreshBoard();
  o.row.classList.add('done'); o.row.classList.remove('pop'); void o.row.offsetWidth; o.row.classList.add('pop');
  setTimeout(() => fx(o.cont, .9, (c, k) => { c.alpha = 1 - k; }, c => { scene.removeChild(c); c.destroy({ children: true }); }), 2000);
  p.hopT = 1;
  star(p, '\u{1F3C6}');
  p.hp = Math.min(100, p.hp + CFG.heal);
  setHP(p);
  p.state = 'wander'; p.wt = 0; p.cd = rnd(.3, .6);
  const alive = players.filter(q => !q.dead);
  banner.textContent = alive.length > 1 ? '⚔ ' + alive.length + ' fighters remain' : '';
  if (alive.length === 1) finale(alive[0]);
  else setTimeout(rematch, rnd(120, 350));
}

// ---------- the simulation ----------
let over = false;
function simTick(dt) {
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
      // ----- melee: run them down, strike at this weapon's reach -----
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
      // ----- archer: kite and loose arrows — even on the run -----
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
    for (const q of players) {
      if (q === p || q.dead || q === p.opp) continue;
      const dx = p.x - q.x, dy = p.y - q.y, d = Math.hypot(dx, dy);
      if (d > 0 && d < 46) { vx += dx / d * 70; vy += dy / d * 70; }
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
function draw(p, dt) {
  if (!p.cont.parent) return;
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
  const s = .55 + .3 * (p.y / H());
  p.body.scale.set(s * (p.face < 0 ? -1 : 1), s);
  p.ui.scale.set(s);
}

// ---------- finale ----------
function finale(champ) {
  over = true;
  banner.textContent = '\u{1F451} ' + champ.name + ' rules the field!';
  pop('\u{1F451} ' + champ.name + '!');
  champ.state = 'champion'; champ.opp = null; champ.pendShot = null; champ.pend = null;
  champ.surv = (performance.now() - T0) / 1000;
  champ.tx = ISL ? ISL.x + ISL.w / 2 : W() / 2; champ.ty = ISL ? ISL.y + ISL.h * .5 : Math.max(400, H() * .52);
  champ.final = true; champ.finalRank = 1;
  refreshBoard();
  champ.row.classList.add('pop');
  document.getElementById('again').href = location.pathname + '?players=' + P;
  document.getElementById('again').style.display = 'block';
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

// ---------- go ----------
buildScenery();
players.forEach(makeFighter);
const rankEl = document.getElementById('ranking');
rankEl.style.height = (players.length * 26) + 'px';
players.forEach((q, i) => {
  const r = document.createElement('div'); r.className = 'rrow';
  const ico = { Warrior: '\u{1F5E1}', Archer: '\u{1F3F9}', Lancer: '⚔', Pawn: '\u{1FA93}' }[q.t];
  r.innerHTML = '<span><span class="rknum pend">&#9876;</span> <span class="who">' + ico + ' ' + q.name + '</span></span><span class="tt pend">&hellip;</span>';
  r.style.top = (i * 26) + 'px';
  q.row = r; rankEl.appendChild(r);
});
document.getElementById('podium').style.display = 'block';
document.getElementById('again').style.display = 'none';
banner.textContent = '⚔ ' + P + ' fighters enter — last one standing wins';
setTimeout(() => { pop('\u{1F3F9} FIGHT ⚔'); rematch(); }, 900);
app.ticker.add(() => {
 try {
  const dt = Math.min(app.ticker.deltaMS / 1000, .05);
  crownTime += dt;
  simTick(dt);
  fxTick(dt);
  crowns.forEach(c => { c.y = -205 - 6 * (1 + Math.sin(crownTime * 3.4)); });
  if (water) { water.tilePosition.x += 4 * dt; water.tilePosition.y += 8 * dt; }
  for (const cl of clouds) { cl.c.x += cl.sp * dt; if (cl.c.x > W() + 320) cl.c.x = -320; }
 } catch (e) { console.error('tick error:', e.message, e.stack); }
});
// debug handles (used by the harness probes)
window.players = players; window.arrows = arrows; window.OBST = OBST;
window.inObst = inObst; Object.defineProperty(window, 'over', { get: () => over });
window.T0 = T0;
})();
