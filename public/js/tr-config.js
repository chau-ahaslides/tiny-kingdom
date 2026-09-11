/* Gremlin Siege — settings in one place, so another system can embed the game and change names, colours, sounds,
   quiz content and balance without touching the game code.

   Three ways to override, applied in this order (later wins):
     1. window.TR_CONFIG = { … }   — set by the embedding page in a <script> BEFORE this file loads (any subset of the keys below)
     2. URL parameters             — name, host, join, bots, sound=0, music=0, title, tower, enemy, theme=dark|light|<json>
     3. GremlinSiege.configure({…}) — at runtime, before hosting or joining
   Everything the game does is also reported through GremlinSiege.on(fn) / config.onEvent, a CustomEvent 'gremlinsiege' on
   window, and postMessage to the parent frame when embedded, as { type: 'gremlinsiege', name, data }. */
'use strict';
const TR_DEFAULTS = {
  text: {
    title: 'Defend the Attention Tower',
    tower: 'Attention Tower',                 // the thing being defended; shown over the keep and in the HUD
    enemy: 'gremlin', enemies: 'gremlins',    // what marches down the road
    godMode: 'GOD MODE',
    joinButton: 'Join the defence',
    credit: 'Models by Kenney (CC0): Tower Defense Kit, Mini Characters, Mini Dungeon',
  },
  theme: {                                    // CSS variables + scene colours
    ink: '#20303f', gold: '#f3b53e', red: '#e5533d', green: '#4fbb6c', blue: '#4a8fe7', purple: '#8e6be8',
    sky: '#cfe8ff', grass: '#6fcf8a', card: '#ffffff',
    font: 'Fredoka, system-ui, sans-serif',
    playerColors: ['#e5533d', '#4a8fe7', '#4fbb6c', '#f3b53e', '#8e6be8', '#ef8fb5', '#2bb3c0', '#a46a3c', '#6c7a89', '#d94fd0', '#9ccc3d', '#ff7a3d'],
  },
  sound: { effects: true, music: true, volume: 1, musicVolume: 0.3 },
  player: { name: '', rememberName: true, onboarding: true },
  host: { partySize: 6, maxParty: 16, botsAllowed: true, autoStart: false, showQr: true, joinBase: '' /* origin used in the QR; empty = this site */ },
  rules: {},                                  // any TR.RULES key: quizTime, placeTime, between, towerHp, maxWaves, godStreak, botRight, …
  quiz: null,                                 // [[question, [option × 4], answerIndex], …]; null = the built-in Gremlin quiz
  assets: '/assets/td/',                      // where the Kenney GLB packs live
  ws: '',                                     // websocket base, e.g. 'wss://game.example.com/ws/'; empty = this site
  api: '',                                    // http base for /api/room; empty = this site
  onEvent: null,                              // function (name, data) — mirror of GremlinSiege.on
};

function trDeepMerge(base, over) {
  if (!over || typeof over !== 'object') return base;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(over)) {
    const v = over[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? trDeepMerge(base[k], v) : v;
  }
  return out;
}
function trConfigFromUrl() {
  const q = new URLSearchParams(location.search); const c = {};
  const bool = v => !(v === '0' || v === 'false' || v === 'off');
  if (q.has('name')) c.player = { name: q.get('name').trim().slice(0, 16) };
  if (q.has('bots')) c.host = { partySize: Math.max(1, Math.min(16, +q.get('bots') || 6)) };
  if (q.has('sound') || q.has('music')) c.sound = {}; if (q.has('sound')) c.sound.effects = bool(q.get('sound')); if (q.has('music')) c.sound.music = bool(q.get('music'));
  if (q.has('title') || q.has('tower') || q.has('enemy')) c.text = {};
  if (q.has('title')) c.text.title = q.get('title').slice(0, 60);
  if (q.has('tower')) c.text.tower = q.get('tower').slice(0, 40);
  if (q.has('enemy')) { const e = q.get('enemy').slice(0, 20); c.text.enemy = e; c.text.enemies = e.endsWith('s') ? e : e + 's'; }
  if (q.has('theme')) { const t = q.get('theme'); if (t === 'dark') c.theme = { sky: '#1b2430', grass: '#2f6b4a', card: '#ffffff' }; else if (t[0] === '{') { try { c.theme = JSON.parse(t); } catch (e) {} } }
  if (q.has('rules')) { try { c.rules = JSON.parse(q.get('rules')); } catch (e) {} }
  return c;
}
const CONFIG = trDeepMerge(trDeepMerge(TR_DEFAULTS, window.TR_CONFIG), trConfigFromUrl());
// Which top-level sections were set on purpose (by the embedding page or the URL): those beat anything remembered in this browser.
CONFIG.explicit = Object.assign({}, ...[window.TR_CONFIG || {}, trConfigFromUrl()].map(o => Object.fromEntries(Object.keys(o).map(k => [k, true]))));

// Colours and names into the page. Runs once the DOM is there (the game scripts load at the end of the body).
function trApplyConfig() {
  const t = CONFIG.theme, root = document.documentElement.style;
  for (const k of ['ink', 'gold', 'red', 'green', 'blue', 'purple', 'sky', 'grass', 'card']) if (t[k]) root.setProperty('--' + k, t[k]);
  if (t.font) root.setProperty('--font', t.font);
  document.title = CONFIG.text.title;
  for (const el of document.querySelectorAll('[data-text]')) { const v = CONFIG.text[el.dataset.text]; if (v !== undefined) el.textContent = v; }
}

// The integration surface. Filled in by tr-game.js; listeners can be attached at any time.
window.GremlinSiege = {
  config: CONFIG,
  configure(over) { Object.assign(CONFIG, trDeepMerge(CONFIG, over)); trApplyConfig(); return CONFIG; },
  _listeners: [],
  on(fn) { this._listeners.push(fn); return () => { this._listeners = this._listeners.filter(f => f !== fn); }; },
  emit(name, data) {
    const payload = Object.assign({}, data || {});
    for (const fn of this._listeners) { try { fn(name, payload); } catch (e) {} }
    if (typeof CONFIG.onEvent === 'function') { try { CONFIG.onEvent(name, payload); } catch (e) {} }
    try { window.dispatchEvent(new CustomEvent('gremlinsiege', { detail: { name, data: payload } })); } catch (e) {}
    if (window.parent && window.parent !== window) { try { window.parent.postMessage({ type: 'gremlinsiege', name, data: payload }, '*'); } catch (e) {} }
  },
};
