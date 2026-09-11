/* Gremlin Siege — the 3D board (shared by the big screen and the phones), the model loader, and small DOM helpers.
   Needs three.js, GLTFLoader, tr-sim.js and tr-config.js loaded first. */
'use strict';
const $ = s => document.querySelector(s);
const show = id => { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === id)); };
let toastT = 0;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800); }
const ASSETS = CONFIG.assets;
const COLORS = CONFIG.theme.playerColors.map(c => parseInt(String(c).replace('#', ''), 16));
const FONT = CONFIG.theme.font;
const hex = c => '#' + c.toString(16).padStart(6, '0');
const LEVEL_LABEL = ['🏹 Small ballista', '💣 Medium cannon', '🔩 BIG turret', '🪨 HUGE catapult', '💎 LEGENDARY crystal turret'];
const TOP_LEVEL = LEVEL_LABEL.length - 1;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ===================== LOADER ===================== */
const loader = new THREE.GLTFLoader();
const cache = new Map();
function loadGLB(name) {
  if (!cache.has(name)) cache.set(name, new Promise((res, rej) => loader.load(ASSETS + name + '.glb', res, undefined, rej)));
  return cache.get(name);
}
function cloneSkinned(source) {
  const clone = source.clone(true);
  const skinned = [], cloneBones = new Map();
  clone.traverse(n => { if (n.isBone) cloneBones.set(n.name, n); if (n.isSkinnedMesh) skinned.push(n); });
  for (const mesh of skinned) mesh.bind(new THREE.Skeleton(mesh.skeleton.bones.map(b => cloneBones.get(b.name) || b), mesh.skeleton.boneInverses), mesh.bindMatrix);
  return clone;
}
const fixMaterials = root => root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; if (o.material && o.material.map) o.material.map.encoding = THREE.sRGBEncoding; } });
function textSprite(text, { size = 34, fill = '#20303f', stroke = '#fff', w = 256, h = 64, scale = 1.1 } = {}) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const cx = cv.getContext('2d');
  cx.font = '700 ' + size + 'px ' + FONT; cx.textAlign = 'center'; cx.lineWidth = Math.max(4, size / 6); cx.strokeStyle = stroke; cx.fillStyle = fill;
  cx.strokeText(text, w / 2, h * 0.7); cx.fillText(text, w / 2, h * 0.7);
  const tex = new THREE.CanvasTexture(cv); tex.minFilter = THREE.LinearFilter;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true })); sp.scale.set(scale, scale * h / w, 1); sp.renderOrder = 11;
  return sp;
}

/* ===================== VIEW (the 3D board; the big screen and the phones both use it) ===================== */
const OPENINGS = { 'tile-straight': [[0, 1], [0, -1]], 'tile-corner-square': [[1, 0], [0, 1]], 'tile-end': [[0, 1]], 'tile-spawn-end': [[0, 1]] };
const rotXZ = ([x, z], yaw) => [Math.round(x * Math.cos(yaw) + z * Math.sin(yaw)), Math.round(-x * Math.sin(yaw) + z * Math.cos(yaw))];
function yawFor(name, wanted) {
  const key = v => v.map(d => d.join(',')).sort().join('|'); const want = key(wanted);
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) if (key(OPENINGS[name].map(o => rotXZ(o, yaw))) === want) return yaw;
  return 0;
}
const TOWER_PARTS = { 0: ['tower-round-bottom-a'], 1: ['tower-round-bottom-b', 'tower-round-middle-a'], 2: ['tower-round-bottom-c', 'tower-round-middle-b', 'tower-round-top-a'], 3: ['tower-round-bottom-c', 'tower-round-middle-c', 'tower-round-middle-b', 'tower-round-top-b'], 4: ['tower-round-bottom-c', 'tower-round-middle-c', 'tower-round-middle-b', 'tower-round-top-c'] };
const WEAPON = { ballista: 'weapon-ballista', cannon: 'weapon-cannon', turret: 'weapon-turret', catapult: 'weapon-catapult', crystal: 'weapon-turret' };
const AMMO = { ballista: 'weapon-ammo-arrow', cannon: 'weapon-ammo-cannonball', turret: 'weapon-ammo-bullet', catapult: 'weapon-ammo-boulder', crystal: 'weapon-ammo-bullet' };
const WEAPON_LIFT = { cannon: 0.15, catapult: 0.05 };
const ENEMY_LOOK = { gremlin: { scale: 1.0, tint: null, anim: 'walk' }, runner: { scale: 0.8, tint: 0xc8ff70, anim: 'sprint' }, brute: { scale: 1.5, tint: 0xff7a7a, anim: 'walk' }, ufo: { scale: 0.9 } };
const DECOR_MODEL = { tree: 'tile-tree', tree2: 'tile-tree-double', rock: 'tile-rock' };

class View {
  constructor(canvas, opts) {
    this.opts = opts || {};
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.opts.lite ? 1.5 : 2));   // phones: fewer pixels, smoother frames
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.shadowMap.enabled = !this.opts.lite;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(CONFIG.theme.sky); this.scene.fog = new THREE.Fog(new THREE.Color(CONFIG.theme.sky), 20, 45);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    this.center = new THREE.Vector3(TR.COLS / 2 - 0.5, 0, TR.ROWS / 2 - 0.5);
    this.cam = { theta: this.opts.theta !== undefined ? this.opts.theta : -0.55, phi: this.opts.phi !== undefined ? this.opts.phi : 0.95, dist: 14, fit: 0 };
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x7fa86a, 0.85));
    const sun = new THREE.DirectionalLight(0xffffff, 0.95); sun.position.set(6, 12, 4); sun.castShadow = !this.opts.lite;
    sun.shadow.mapSize.set(1024, 1024); Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 40 }); sun.shadow.bias = -0.0005;
    this.scene.add(sun, sun.target); sun.target.position.copy(this.center);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshLambertMaterial({ color: new THREE.Color(CONFIG.theme.grass) })); ground.rotation.x = -Math.PI / 2; ground.position.y = -0.02; ground.receiveShadow = true; this.scene.add(ground);
    this.enemies = new Map(); this.pool = { orc: [], ufo: [] }; this.guns = []; this.shots = []; this.fx = []; this.clock = new THREE.Clock(); this.me = null;
    this.hpGeo = new THREE.PlaneGeometry(0.6, 0.07);
    addEventListener('resize', () => this.resize()); this.resize();
    this.placeCamera();
    if (this.opts.orbit) this.enableOrbit(canvas);
  }
  enableOrbit(el) {
    // Drag to orbit, wheel or pinch to zoom — the same feel as Tiny Towers.
    const pointers = new Map(); let lastPinch = 0; const cam = this.cam;
    const zoom = k => { cam.dist = Math.max(cam.fit * 0.4, Math.min(cam.fit * 2, cam.dist * k)); this.placeCamera(); };
    el.addEventListener('pointerdown', e => { pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); el.setPointerCapture(e.pointerId); if (this.onPick && pointers.size === 1) this.onPick(e.clientX, e.clientY); });
    el.addEventListener('pointermove', e => {
      const p = pointers.get(e.pointerId); if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
      if (pointers.size === 1) { if (this.onPick) this.onPick(e.clientX, e.clientY); else { cam.theta -= dx * 0.006; cam.phi = Math.max(0.35, Math.min(1.4, cam.phi + dy * 0.005)); this.placeCamera(); } }
      else if (pointers.size === 2) { const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); if (lastPinch) zoom(lastPinch / d); lastPinch = d; }
    });
    const up = e => { pointers.delete(e.pointerId); if (pointers.size < 2) lastPinch = 0; };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', e => zoom(1 + Math.sign(e.deltaY) * 0.08), { passive: true });
  }
  resize() {
    const w = innerWidth, h = innerHeight; this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    const portrait = this.camera.aspect < 1;
    if (portrait !== this.cam.portrait) { this.cam.portrait = portrait; this.cam.theta = portrait ? Math.PI / 2 - 0.35 : (this.opts.theta !== undefined ? this.opts.theta : -0.55); }
    this.fitBoard();
  }
  // Pull back and re-centre until the whole board (trees included) sits inside the view, leaving room for the HUD.
  fitBoard() {
    const m = this.opts.margins || { x: 0.9, y: 0.9, yBias: 0 };
    const corners = [];
    for (const x of [-1.5, TR.COLS + 0.5]) for (const z of [-1.5, TR.ROWS + 0.5]) for (const y of [0, 1.2]) corners.push(new THREE.Vector3(x, y, z));
    const userZoom = this.cam.fit ? Math.max(0.4, Math.min(2, this.cam.dist / this.cam.fit)) : 1;
    this.center.set(TR.COLS / 2 - 0.5, 0, TR.ROWS / 2 - 0.5);
    this.cam.dist = 16;
    const ray = new THREE.Raycaster(), ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3();
    for (let it = 0; it < 10; it++) {
      this.placeCamera();
      const p = corners.map(c => c.clone().project(this.camera));
      if (p.some(v => !isFinite(v.x) || v.z > 1)) { this.cam.dist *= 1.5; continue; }
      const minx = Math.min(...p.map(v => v.x)), maxx = Math.max(...p.map(v => v.x)), miny = Math.min(...p.map(v => v.y)), maxy = Math.max(...p.map(v => v.y));
      const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2, w = (maxx - minx) / 2, h = (maxy - miny) / 2;
      ray.setFromCamera({ x: cx, y: cy - m.yBias }, this.camera);
      if (ray.ray.intersectPlane(ground, hit)) { this.center.x += (hit.x - this.center.x) * 0.9; this.center.z += (hit.z - this.center.z) * 0.9; }
      const k = Math.max(w / m.x, h / m.y);
      this.cam.dist *= Math.max(0.5, Math.min(2, k));
      if (Math.abs(k - 1) < 0.01 && Math.abs(cx) < 0.01 && Math.abs(cy - m.yBias) < 0.01) break;
    }
    this.cam.fit = this.cam.dist; this.cam.dist *= userZoom; this.placeCamera();
  }
  placeCamera() {
    const c = this.cam, C = this.center;
    this.camera.position.set(C.x + c.dist * Math.cos(c.phi) * Math.sin(c.theta), C.y + c.dist * Math.sin(c.phi), C.z + c.dist * Math.cos(c.phi) * Math.cos(c.theta));
    this.camera.lookAt(C.x, 0.2, C.z);
    this.scene.fog.near = c.dist * 1.4; this.scene.fog.far = c.dist * 3.2;
  }
  async inst(name, x, z, yaw = 0, y = 0, parent) { const g = await loadGLB('kit/' + name); const o = g.scene.clone(true); fixMaterials(o); o.position.set(x, y, z); o.rotation.y = yaw; (parent || this.scene).add(o); return o; }
  async buildMap() {
    const PATH = TR.PATH;
    await Promise.all(['tile', 'tile-straight', 'tile-corner-square', 'tile-spawn-end', 'tile-end', 'tile-tree', 'tile-tree-double', 'tile-rock', 'tower-square-bottom-a', 'tower-square-middle-a', 'tower-square-top-a', 'tower-square-roof-a', 'tower-round-base', 'tile-crystal'].map(n => loadGLB('kit/' + n)));
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const g = new THREE.Group(); this.scene.add(g);
    for (const [key, d] of TR.DECOR) { const [x, z] = key.split(',').map(Number); await this.inst(DECOR_MODEL[d.kind] || 'tile', x, z, d.yaw, 0, g); }
    for (let i = 0; i < PATH.length; i++) {
      const [x, z] = PATH[i]; const prev = PATH[i - 1], next = PATH[i + 1]; const dirTo = (a, b) => [b[0] - a[0], b[1] - a[1]];
      let name, yaw;
      if (!prev) { name = 'tile-spawn-end'; yaw = yawFor(name, [dirTo([x, z], next)]); }
      else if (!next) { name = 'tile-end'; const a = dirTo(prev, [x, z]); yaw = yawFor(name, [[-a[0], -a[1]]]); }
      else { const a = dirTo(prev, [x, z]), b = dirTo([x, z], next); name = (a[0] === b[0] && a[1] === b[1]) ? 'tile-straight' : 'tile-corner-square'; yaw = yawFor(name, [[-a[0], -a[1]], b]); }
      await this.inst(name, x, z, yaw, 0, g);
    }
    // The Attention Tower: a tall square keep on the last road tile, crystal on top, name over it.
    const end = TR.END; const keep = new THREE.Group(); keep.position.set(end[0], 0.2, end[1]); keep.scale.setScalar(1.15); this.scene.add(keep); this.keep = keep;
    let y = 0;
    for (const p of ['tower-square-bottom-a', 'tower-square-middle-a', 'tower-square-middle-a', 'tower-square-top-a', 'tower-square-roof-a']) { const o = await this.inst(p, 0, 0, Math.PI / 2, y, keep); y += new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3()).y / 1.15 - 0.02; }
    const crystal = await this.inst('tile-crystal', 0, 0, 0, y - 0.25, keep); crystal.scale.setScalar(0.7); this.crystal = crystal;
    const tag = textSprite('🏰 ' + CONFIG.text.tower, { size: 56, fill: CONFIG.theme.blue, w: 512, h: 96, scale: 2.2 }); tag.position.set(0, y + 0.9, 0); tag.renderOrder = 12; keep.add(tag);
    for (let x = -1; x <= TR.COLS; x++) for (const z of [-1, TR.ROWS]) if (rnd() < 0.7) await this.inst(rnd() < .5 ? 'tile-tree' : 'tile-tree-double', x, z, rnd() * 6, 0, g);
    for (let z = 0; z < TR.ROWS; z++) for (const x of [-1, TR.COLS]) if (rnd() < 0.7 && !(x === -1 && z === PATH[0][1])) await this.inst(rnd() < .5 ? 'tile-tree' : 'tile-tree-double', x, z, rnd() * 6, 0, g);
    // Placement preview (phones): a ring on the tile and the gun's reach.
    this.ghost = new THREE.Group(); this.ghost.visible = false; this.scene.add(this.ghost);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.46, 32), new THREE.MeshBasicMaterial({ color: 0xffd23f, side: THREE.DoubleSide, transparent: true, opacity: 0.95 })); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.22; this.ghost.add(ring);
    const reach = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.22, depthWrite: false })); reach.rotation.x = -Math.PI / 2; reach.position.y = 0.21; this.ghost.add(reach); this.ghostReach = reach;
  }
  // Which board tile is under a screen point (ground-plane hit), or null off the board.
  pickTile(cx, cy) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster(); ray.setFromCamera({ x: (cx - r.left) / r.width * 2 - 1, y: -((cy - r.top) / r.height) * 2 + 1 }, this.camera);
    const hit = new THREE.Vector3(); if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return null;
    const x = Math.round(hit.x), z = Math.round(hit.z);
    return x < 0 || z < 0 || x >= TR.COLS || z >= TR.ROWS ? null : { x, z };
  }
  setGhost(x, z, range, ok = true) {
    if (!this.ghost) return; if (x === null) { this.ghost.visible = false; return; }
    this.ghost.visible = true; this.ghost.position.set(x, 0, z); this.ghostReach.scale.setScalar(range);
    const c = ok ? 0xffd23f : 0xe5533d; this.ghost.children[0].material.color.set(c); this.ghostReach.material.color.set(c);
    if (this.ghostGun) this.ghostGun.traverse(o => { if (o.isMesh) o.material.color.copy(o.material.__orig).lerp(new THREE.Color(0xe5533d), ok ? 0 : 0.6); });
  }
  // A see-through gun of the right type and size rides on the ghost while the player drags it around.
  async setGhostGun(type, level) {
    const gen = this.ghostGen = (this.ghostGen || 0) + 1;
    if (this.ghostGun) { this.ghost.remove(this.ghostGun); this.ghostGun = null; }
    const g = new THREE.Group(); g.position.y = 0.2;
    await this.inst('tower-round-base', 0, 0, 0, -0.2, g);
    let y = 0;
    for (const name of TOWER_PARTS[level]) { const o = await this.inst(name, 0, 0, 0, y, g); y += new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3()).y - 0.02; }
    const w = await this.inst(WEAPON[type], 0, 0, 0, y + (WEAPON_LIFT[type] || 0.02), g);
    if (type === 'crystal') this.crystalDress(w, g, y);
    if (gen !== this.ghostGen) return;
    g.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.6; o.material.depthWrite = false; o.material.__orig = o.material.color.clone(); o.castShadow = false; } });
    this.ghost.add(g); this.ghostGun = g;
  }
  // Guns persist for the whole game, so only new ones are built. `d` is one entry of TR.gunList().
  async addGun(d) {
    if (this.guns[d.i]) return;
    const group = new THREE.Group(); group.position.set(d.x, 0.2, d.z); this.scene.add(group);
    const entry = { group, weapon: null, muzzleY: 0.6, type: d.type, x: d.x, z: d.z, owner: d.owner }; this.guns[d.i] = entry;
    await this.inst('tower-round-base', 0, 0, 0, -0.2, group);
    let y = 0;
    for (const name of TOWER_PARTS[d.level]) { const o = await this.inst(name, 0, 0, 0, y, group); y += new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3()).y - 0.02; }
    const w = await this.inst(WEAPON[d.type], 0, 0, 0, y + (WEAPON_LIFT[d.type] || 0.02), group);
    if (d.type === 'crystal') this.crystalDress(w, group, y);
    entry.weapon = w; entry.muzzleY = 0.2 + w.position.y + 0.3; entry.top = y;
    // Ammo pill: a bar with the shots left, redrawn only when the count changes.
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 72; entry.ammoCv = cv; entry.ammoTex = new THREE.CanvasTexture(cv); entry.ammoTex.minFilter = THREE.LinearFilter;
    const pill = new THREE.Sprite(new THREE.SpriteMaterial({ map: entry.ammoTex, depthTest: false, transparent: true })); pill.scale.set(1.6, 1.6 * 72 / 256, 1); pill.position.y = y + 0.66; pill.renderOrder = 10; group.add(pill); entry.pill = pill;
    entry.ammo = d.ammo; entry.max = d.max; entry.frac = d.max ? d.ammo / d.max : 1; this.drawAmmo(entry);
    if (this.guns[d.i] !== entry) { this.scene.remove(group); return; }      // collapsed while loading
    const mine = d.owner === this.me;
    const label = textSprite((mine ? '★ ' : '') + d.name.slice(0, 14), { fill: mine ? '#e5533d' : hex(COLORS[d.skin % COLORS.length]), size: 44, scale: mine ? 1.9 : 1.6 }); label.position.y = y + 1.12; group.add(label);
    // A puff so the new gun is easy to spot.
    const puff = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .7 })); puff.position.set(d.x, 0.5, d.z); this.scene.add(puff); this.fx.push({ m: puff, t: 0, life: .5, r: 0.9, kind: 'boom' });
  }
  // The legendary gun: a turret scaled up, tinted cyan, ringed with crystals that spin.
  async crystalDress(weapon, group, y) {
    weapon.scale.setScalar(1.25); weapon.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); o.material.color.multiply(new THREE.Color(0x9fe8ff)); } });
    const ring = new THREE.Group(); ring.position.y = y - 0.1; group.add(ring); group.userData.ring = ring;
    for (let k = 0; k < 4; k++) { const c = await this.inst('detail-crystal', Math.cos(k * Math.PI / 2) * 0.42, Math.sin(k * Math.PI / 2) * 0.42, k, 0, ring); c.scale.setScalar(0.8); }
  }
  setGuns(list) { for (const d of list) if (!d.dead) this.addGun(d); }
  drawAmmo(t) {
    const cx = t.ammoCv.getContext('2d'); const W = 256, H = 72; cx.clearRect(0, 0, W, H);
    const god = !!t.god; const f = god ? 1 : Math.max(0, Math.min(1, t.frac)); const low = !god && f <= 0.25; const col = god ? '#ffd23f' : f > .5 ? '#4a8fe7' : f > .25 ? '#f3b53e' : '#e5533d';
    cx.fillStyle = god ? 'rgba(120,80,0,.85)' : 'rgba(32,48,63,.85)'; cx.beginPath(); cx.roundRect(4, 14, W - 8, 44, 22); cx.fill();
    cx.fillStyle = col; cx.beginPath(); cx.roundRect(10, 20, Math.max(12, (W - 20) * f), 32, 16); cx.fill();
    cx.font = '700 36px ' + FONT; cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.lineWidth = 6; cx.strokeStyle = god ? 'rgba(120,80,0,.9)' : 'rgba(32,48,63,.9)'; cx.fillStyle = '#fff';
    const text = (god ? '⚡ ' : low ? '🪫 ' : '🔫 ') + t.ammo; cx.strokeText(text, W / 2, 37); cx.fillText(text, W / 2, 37);
    t.ammoTex.needsUpdate = true;
  }
  // gh = ammo left per gun as a fraction, ga = shots left
  applyGuns(gh, ga) {
    const now = performance.now();
    for (let i = 0; i < gh.length; i++) {
      const t = this.guns[i]; if (!t || !t.pill) continue;
      const n = ga ? ga[i] : Math.round(gh[i] * (t.max || 1)); const g = (t.godT || 0) > now;   // freshly refilled: gold for a moment
      if (n !== t.ammo || g !== !!t.god) { t.ammo = n; t.frac = gh[i]; t.god = g; this.drawAmmo(t); }
      t.low = !g && gh[i] <= 0.25 && gh[i] > 0;
    }
  }
  // God Mode: a golden ring bursts from every gun and sparks rise over the whole board.
  godBurst(indices) {
    const list = indices ? indices.map(i => this.guns[i]).filter(Boolean) : this.guns.filter(Boolean);
    for (const t of list) { t.godT = performance.now() + 2500; const m = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.5, 32), new THREE.MeshBasicMaterial({ color: 0xffd23f, side: THREE.DoubleSide, transparent: true, opacity: .9 })); m.rotation.x = -Math.PI / 2; m.position.set(t.x, 0.25, t.z); this.scene.add(m); this.fx.push({ m, t: 0, life: 1.0, kind: 'ring' }); }
    for (let k = 0; k < 60; k++) { const m = new THREE.Mesh(new THREE.BoxGeometry(.12, .12, .12), new THREE.MeshBasicMaterial({ color: k % 2 ? 0xffd23f : 0xffffff })); m.position.set(Math.random() * TR.COLS, 0.2, Math.random() * TR.ROWS); this.scene.add(m); this.fx.push({ m, t: 0, life: 1.4 + Math.random(), kind: 'spark', vy: 2 + Math.random() * 3, vx: (Math.random() - .5), vz: (Math.random() - .5) }); }
    this.keepFlash = 0.6;
  }
  // Out of ammo: the gun tips over and sinks into the ground under a puff of smoke, then goes away.
  removeGun(i) {
    const t = this.guns[i]; if (!t) return; this.guns[i] = null;
    t.group.rotation.set(0, 0, 0); t.group.position.set(t.x, 0.2, t.z);
    this.fx.push({ m: t.group, t: 0, life: 1.1, kind: 'collapse', x: t.x, z: t.z, dir: Math.random() * Math.PI * 2 });
    for (let k = 0; k < 7; k++) { const m = new THREE.Mesh(new THREE.SphereGeometry(.16, 8, 6), new THREE.MeshBasicMaterial({ color: 0xb8c2cc, transparent: true, opacity: .8 })); m.position.set(t.x + (Math.random() - .5) * .6, 0.3 + Math.random() * .4, t.z + (Math.random() - .5) * .6); this.scene.add(m); this.fx.push({ m, t: 0, life: 1.2 + Math.random() * .4, kind: 'smoke', vx: (Math.random() - .5) * .6, vz: (Math.random() - .5) * .6 }); }
    const sp = textSprite('🪫 out of ammo', { size: 40, fill: '#e5533d', w: 384, h: 80, scale: 1.7 }); sp.position.set(t.x, (t.top || 0.6) + 1.1, t.z); this.scene.add(sp); this.fx.push({ m: sp, t: 0, life: 1.6, kind: 'text' });
  }
  // Enemies come and go every wave, so their models are pooled.
  ensureEnemy(id, kind) {
    if (this.enemies.has(id)) return this.enemies.get(id);
    const entry = { id, kind, holder: new THREE.Group(), mixer: null, clips: {}, cur: null, state: 'run', root: null, t: 0 };
    this.enemies.set(id, entry); this.scene.add(entry.holder); entry.holder.visible = false;
    this.dressEnemy(entry, kind);
    return entry;
  }
  async dressEnemy(entry, kind) {
    const id = entry.id; const look = ENEMY_LOOK[kind] || ENEMY_LOOK.gremlin; const poolKey = kind === 'ufo' ? 'ufo' : 'orc';
    let body = this.pool[poolKey].pop();
    if (!body) {
      body = { root: null, mixer: null, clips: {}, bar: null, fg: null };
      if (poolKey === 'ufo') { const g = await loadGLB('kit/enemy-ufo-a'); body.root = g.scene.clone(true); fixMaterials(body.root); }
      else {
        const g = await loadGLB('dungeon/character-orc'); body.root = cloneSkinned(g.scene); fixMaterials(body.root);
        body.root.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); o.material.__orig = o.material.color.clone(); } });
        body.mixer = new THREE.AnimationMixer(body.root);
        for (const c of g.animations) body.clips[c.name] = body.mixer.clipAction(c);
        body.clips.die.setLoop(THREE.LoopOnce); body.clips.die.clampWhenFinished = true;
      }
      const bar = new THREE.Group(); bar.renderOrder = 10;
      const bg = new THREE.Mesh(this.hpGeo, new THREE.MeshBasicMaterial({ color: 0x20303f, depthTest: false, transparent: true, opacity: .8 }));
      const fg = new THREE.Mesh(this.hpGeo, new THREE.MeshBasicMaterial({ color: 0xe5533d, depthTest: false })); fg.position.z = 0.001;
      bar.add(bg, fg); body.bar = bar; body.fg = fg;
    }
    if (this.enemies.get(id) !== entry) { this.pool[poolKey].push(body); return; }      // gone before the model arrived
    Object.assign(entry, { root: body.root, mixer: body.mixer, clips: body.clips, bar: body.bar, fg: body.fg, body, cur: null });
    body.root.scale.setScalar(look.scale); body.root.position.y = kind === 'ufo' ? 0.9 : 0; body.root.visible = true;
    body.root.traverse(o => { if (o.isMesh && o.material && o.material.__orig) { o.material.color.copy(o.material.__orig); if (look.tint) o.material.color.multiply(new THREE.Color(look.tint)); } });
    body.bar.position.y = (kind === 'ufo' ? 1.5 : 0.95 * look.scale) + 0.1; body.bar.visible = true;
    entry.holder.add(body.root, body.bar);
    if (body.mixer) { for (const a of Object.values(body.clips)) a.stop(); this.play(entry, look.anim); }
    entry.holder.visible = entry.state !== 'in';
  }
  releaseEnemy(id) {
    const e = this.enemies.get(id); if (!e) return; this.enemies.delete(id); this.scene.remove(e.holder);
    if (e.body) { e.holder.remove(e.body.root, e.body.bar); this.pool[e.kind === 'ufo' ? 'ufo' : 'orc'].push(e.body); }
  }
  play(e, name) {
    const a = e.clips[name]; if (!a || e.cur === a) return;
    if (e.cur) e.cur.fadeOut(0.15);
    a.reset().fadeIn(0.15).play(); e.cur = a;
  }
  // Apply one snapshot: list = [[id, kind, hpFrac, d, side, speed, state], …]
  // Snapshots arrive ten times a second; enemies keep walking the road between them and ease toward the reported spot.
  applyEnemies(list) {
    const seen = new Set();
    for (const [id, kind, hp, d, side, speed, state] of list) {
      seen.add(id);
      let e = this.enemies.get(id); if (!e) { e = this.ensureEnemy(id, kind); e.d = d; e.err = 0; continue; }
      if (e.d === undefined) { e.d = d; e.err = 0; }
      // Lead the reported spot by the typical snapshot age, then only speed up or slow down to close the gap (no jumps).
      e.err = d + (state === 'run' ? speed * 0.1 : 0) - e.d; e.side = side; e.speed = speed;
      if (Math.abs(e.err) > 1.5) { e.d = d; e.err = 0; }
      if (!e.root) continue;
      const was = e.state; e.state = state;
      e.holder.visible = state !== 'in';
      if (state === 'dead' && was !== 'dead') { if (e.clips.die) this.play(e, 'die'); else e.root.visible = false; this.coin(e.holder.position); e.bar.visible = false; }
      if (state === 'run') { e.bar.visible = true; e.fg.scale.x = Math.max(0.02, hp); e.fg.position.x = -(1 - hp) * 0.3; }
    }
    for (const id of [...this.enemies.keys()]) if (!seen.has(id)) this.releaseEnemy(id);
  }
  moveEnemies(dt) {
    for (const e of this.enemies.values()) {
      if (e.d === undefined) continue;
      if (e.state === 'run') { const rate = 1 + Math.max(-0.35, Math.min(0.35, (e.err || 0) * 1.0)); const step = (e.speed || 0) * dt * rate; e.d += step; e.err -= step - (e.speed || 0) * dt; }
      const p = TR.posAt(e.d, e.side || 0);
      e.holder.position.set(p.x, 0, p.z);
      if (e.root && e.state === 'run') { let diff = p.yaw - e.root.rotation.y; diff = Math.atan2(Math.sin(diff), Math.cos(diff)); e.root.rotation.y += diff * Math.min(1, 10 * dt); }
    }
  }
  async shot(fromGun, targetId, dur, splash) {
    const t = this.guns[fromGun]; const tgt = this.enemies.get(targetId); if (!t || !t.weapon || !tgt) return;
    const g = await loadGLB('kit/' + AMMO[t.type]); const m = g.scene.clone(true); m.scale.setScalar(t.type === 'turret' ? 1.6 : 1.1);
    const from = new THREE.Vector3(t.x, t.muzzleY, t.z); m.position.copy(from); this.scene.add(m);
    this.shots.push({ m, from, tgt, t: 0, dur, arc: splash > 0 });
    t.weapon.position.y -= 0.05; setTimeout(() => t.weapon.position.y += 0.05, 90);
  }
  boom(x, z, r) { const m = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: .8 })); m.position.set(x, 0.4, z); m.scale.setScalar(.1); this.scene.add(m); this.fx.push({ m, t: 0, life: .35, r: r + .2, kind: 'boom' }); }
  async coin(pos) { const g = await loadGLB('dungeon/coin'); const m = g.scene.clone(true); m.position.copy(pos).setY(0.6); this.scene.add(m); this.fx.push({ m, t: 0, life: .8, kind: 'coin' }); }
  hitKeep() { this.keepFlash = 0.35; }
  // The tower has fallen: it shakes, then its storeys tumble off one by one into the grass under a cloud of dust.
  crumbleKeep() {
    if (!this.keep || this.crumbled) return; this.crumbled = true; this.keepFlash = 1.4;
    this.focus = { x: TR.END[0] - 1.5, z: TR.END[1] - 0.5, dist: this.cam.fit * 0.55 };   // the camera glides in to watch
    const parts = [...this.keep.children].filter(o => !o.isSprite).sort((a, b) => b.position.y - a.position.y);   // top first
    for (const o of this.keep.children) if (o.isSprite) o.visible = false;
    parts.forEach((o, i) => {
      this.scene.attach(o); const a = Math.random() * Math.PI * 2;
      this.fx.push({ m: o, t: -1.2 - i * 0.28, life: 4, kind: 'tumble', vx: Math.cos(a) * (0.8 + Math.random()), vz: Math.sin(a) * (0.8 + Math.random()), vy: 1.5 + Math.random() * 1.5, rx: (Math.random() - .5) * 6, rz: (Math.random() - .5) * 6 });
    });
    for (let k = 0; k < 40; k++) { const m = new THREE.Mesh(new THREE.SphereGeometry(.2 + Math.random() * .2, 8, 6), new THREE.MeshBasicMaterial({ color: 0xb8a58a, transparent: true, opacity: .85 })); m.visible = false; m.position.set(TR.END[0] + (Math.random() - .5) * 1.2, 0.2 + Math.random() * 2.5, TR.END[1] + (Math.random() - .5) * 1.2); this.scene.add(m); this.fx.push({ m, t: -1.0 - Math.random() * 2.2, life: 1.8 + Math.random(), kind: 'smoke', vx: (Math.random() - .5) * 1.5, vz: (Math.random() - .5) * 1.5 }); }
  }
  biteText(text) {
    const sp = textSprite(text, { size: 64, fill: '#e5533d', w: 192, h: 96, scale: 1.6 }); sp.renderOrder = 12;
    sp.position.set(TR.END[0] + (Math.random() - .5) * .6, 2.6, TR.END[1]); this.scene.add(sp);
    this.fx.push({ m: sp, t: 0, life: 1.1, kind: 'text' });
  }
  frame(dt) {
    this.moveEnemies(dt);
    for (const e of this.enemies.values()) if (e.root && e.holder.visible) {
      if (e.mixer) e.mixer.update(dt); e.bar.quaternion.copy(this.camera.quaternion);
      if (e.kind === 'ufo') { e.t += dt; e.root.position.y = 0.9 + Math.sin(e.t * 4) * 0.08; e.root.rotation.y += dt * 2; }
    }
    for (let i = 0; i < this.guns.length; i++) {
      const t = this.guns[i]; if (!t || !t.weapon) continue; const y = this.gunYaw ? this.gunYaw[i] : 0; if (y !== undefined) { let d = y - t.weapon.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d)); t.weapon.rotation.y += d * Math.min(1, 12 * dt); }
      if (t.group.userData.ring) t.group.userData.ring.rotation.y += dt * 1.5;
      if (t.low) {   // running dry: the pill throbs and the gun rattles
        const k = performance.now() / 1000; const g = 1.6 * (1 + 0.12 * Math.sin(k * 12)); t.pill.scale.set(g, g * 72 / 256, 1);
        t.weapon.rotation.z = Math.sin(k * 40) * 0.05; t.pill.material.opacity = 0.75 + 0.25 * Math.sin(k * 12);
      } else if (t.pill && t.pill.material.opacity !== 1) { t.pill.material.opacity = 1; t.pill.scale.set(1.6, 1.6 * 72 / 256, 1); t.weapon.rotation.z = 0; }
    }
    this.shots = this.shots.filter(s => {
      s.t += dt / s.dur; if (s.t >= 1 || !s.tgt.root) { this.scene.remove(s.m); return false; }
      const aim = s.tgt.holder.position.clone().setY(s.tgt.kind === 'ufo' ? 0.9 : 0.35); s.m.position.lerpVectors(s.from, aim, s.t); if (s.arc) s.m.position.y += Math.sin(s.t * Math.PI) * s.from.distanceTo(aim) * 0.35; s.m.lookAt(aim); return true;
    });
    this.fx = this.fx.filter(f => { f.t += dt; const k = f.t / f.life; if (f.t < 0) { if (f.kind === 'smoke') f.m.visible = false; return true; } if (f.kind === 'smoke') f.m.visible = true; if (f.kind === 'tumble') { f.vy -= 9 * dt; f.m.position.x += f.vx * dt; f.m.position.z += f.vz * dt; f.m.position.y += f.vy * dt; if (f.m.position.y < 0.05) { f.m.position.y = 0.05; f.vy = -f.vy * 0.25; f.vx *= 0.7; f.vz *= 0.7; f.rx *= 0.5; f.rz *= 0.5; } f.m.rotation.x += f.rx * dt; f.m.rotation.z += f.rz * dt; if (k >= 1) return false; return true; } if (f.kind === 'boom') { f.m.scale.setScalar(f.r * Math.sin(k * Math.PI)); f.m.material.opacity = .8 * (1 - k); } else if (f.kind === 'text') { f.m.position.y += dt * 1.4; f.m.material.opacity = 1 - k * k; } else if (f.kind === 'ring') { f.m.scale.setScalar(1 + k * 5); f.m.material.opacity = .9 * (1 - k); } else if (f.kind === 'spark') { f.vy -= 4 * dt; f.m.position.x += f.vx * dt; f.m.position.z += f.vz * dt; f.m.position.y += f.vy * dt; f.m.rotation.x += dt * 6; f.m.rotation.y += dt * 4; } else if (f.kind === 'collapse') { const e = k * k; f.m.rotation.z = Math.cos(f.dir) * 0.9 * e; f.m.rotation.x = Math.sin(f.dir) * 0.9 * e; f.m.position.y = 0.2 - 1.4 * e; f.m.scale.setScalar(1 - 0.5 * e); } else if (f.kind === 'smoke') { f.m.position.x += f.vx * dt; f.m.position.z += f.vz * dt; f.m.position.y += dt * 0.9; f.m.scale.setScalar(1 + k * 1.5); f.m.material.opacity = .8 * (1 - k); } else { f.m.position.y += dt * 1.2; f.m.rotation.y += dt * 8; f.m.scale.setScalar(1 - k * .6); } if (k >= 1) { this.scene.remove(f.m); return false; } return true; });
    if (this.crystal) this.crystal.rotation.y += dt * 0.8;
    if (this.keep) { if (this.keepFlash > 0) { this.keepFlash -= dt; this.keep.position.x = TR.END[0] + (Math.random() - .5) * .08; } else this.keep.position.x = TR.END[0]; }
    if (this.ghost && this.ghost.visible) this.ghost.children[0].scale.setScalar(1 + 0.08 * Math.sin(performance.now() / 150));
    if (this.focus && dt > 0) { const k = Math.min(1, 1.5 * dt); this.center.x += (this.focus.x - this.center.x) * k; this.center.z += (this.focus.z - this.center.z) * k; this.cam.dist += (this.focus.dist - this.cam.dist) * k; this.placeCamera(); }
    this.renderer.render(this.scene, this.camera);
  }
}

