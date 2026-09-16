// AhaSlides games asset library: the runtime. One ES module, no dependencies, served next to the assets.
//
//   import { assets } from 'https://tiny-kingdom-lib.ahaslides-game.workers.dev/aha-assets.js';
//
//   const hit = await assets.sound('sfx/pixel-combat/explosion/bass-hit');   // all 6 variants, decoded
//   hit.play();                                                              // a random variant
//
//   const guy = await assets.sheet('sprites/gandalf-characters/Character_skin_colors/Male_Skin1.png');
//   guy.draw(ctx, 'walk', performance.now(), x, y, { scale: 3 });            // the sheet knows its rows
//
//   const boom = await assets.sheet('sprites/pixel-effects/explosions/epic_explosion_001_small_orange.png');
//   const done = boom.draw(ctx, null, t - t0, x, y, { loop: false });        // a strip: frames left to right
//
//   const run = await assets.sequence('sprites/adventure-girl/Run');         // one PNG per frame
//   run.draw(ctx, t, x, y, { scale: 0.25, flip: true });
//
// Every sheet's cell size, rows, frame counts and fps come from a small JSON next to the image
// (the build writes it from the library's pack index), so the caller passes none of that. Where the
// library has no metadata for an image, pass it yourself: assets.sheet(path, { cell: [32, 32] }).
// Metadata files are open like the assets; only the library index is gated.

export const BASE = new URL('.', import.meta.url).href.replace(/\/$/, '');

/** Frame index at time t (ms) for an animation of n frames at fps. Loops unless loop is false, then holds the last frame. */
export function frameAt(t, n, fps, loop = true) {
  if (n <= 1) return 0;
  const i = Math.floor((Math.max(0, t) / 1000) * fps);
  return loop ? i % n : Math.min(i, n - 1);
}

/** Source rectangle of cell (col, row) in a grid of cw x ch cells. */
export function cellRect(col, row, cw, ch) {
  return { sx: col * cw, sy: row * ch, sw: cw, sh: ch };
}

export class AssetLibrary {
  constructor(base = BASE) {
    this.base = base;
    this.images = new Map();
    this.metas = new Map();
    this.sounds = new Map();
    this.ctx = null;
  }

  url(path) { return /^https?:/.test(path) ? path : `${this.base}/${path.replace(/^\/+/, '')}`; }

  /** An <img> that has finished loading (cached per path). */
  image(path) {
    if (!this.images.has(path)) {
      this.images.set(path, new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`image failed: ${path}`));
        img.src = this.url(path);
      }));
    }
    return this.images.get(path);
  }

  /** The JSON next to an asset (path + '.json', or path itself when it ends in .json), or null when there is none. */
  async meta(path) {
    const key = path.endsWith('.json') ? path : `${path}.json`;
    if (!this.metas.has(key)) {
      this.metas.set(key, fetch(this.url(key)).then((r) => (r.ok ? r.json() : null)).catch(() => null));
    }
    return this.metas.get(key);
  }

  /** A sprite sheet: a grid of cells, optionally with named animations (one per row) or a single strip. */
  async sheet(path, override = {}) {
    const [img, meta] = await Promise.all([this.image(path), this.meta(path)]);
    return new Sheet(img, { ...(meta || {}), ...override });
  }

  /** A per-frame animation: 'sprites/adventure-girl/Run' loads Run.json and every frame it lists. */
  async sequence(path, override = {}) {
    const meta = { ...((await this.meta(path.replace(/\.json$/, ''))) || {}), ...override };
    if (!meta.sequence?.length) throw new Error(`no sequence at ${path}.json`);
    const images = await Promise.all(meta.sequence.map((p) => this.image(p)));
    return new Sequence(images, meta);
  }

  /** Shared AudioContext; call unlock() from a click or touch handler on iOS. */
  audio() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    return this.ctx;
  }
  async unlock() { const c = this.audio(); if (c.state !== 'running') await c.resume(); return c; }

  /**
   * A sound: 'sfx/pixel-combat/explosion/bass-hit' loads bass-hit.json (every variant) or, failing that,
   * bass-hit.m4a. Decoded once; play() picks a random variant.
   */
  sound(path, opts = {}) {
    const key = path.replace(/\.(m4a|json)$/, '');
    if (!this.sounds.has(key)) {
      this.sounds.set(key, (async () => {
        const meta = await this.meta(key);
        const urls = meta?.variants?.length ? meta.variants : [`${key}.m4a`];
        const ctx = this.audio();
        const buffers = await Promise.all(urls.map(async (u) => {
          const r = await fetch(this.url(u));
          if (!r.ok) throw new Error(`sound failed: ${u}`);
          return ctx.decodeAudioData(await r.arrayBuffer());
        }));
        return new Sound(this, buffers, { ...(meta || {}), ...opts });
      })());
    }
    return this.sounds.get(key);
  }

  /** A looping music track as an <audio> element (not decoded into memory). */
  music(path, { volume = 0.5, loop = true } = {}) {
    const a = new Audio(this.url(path));
    a.crossOrigin = 'anonymous'; a.loop = loop; a.volume = volume; a.preload = 'auto';
    return a;
  }

  /** Warm the caches: paths of images, sheets ('...png'), sequences ('...Run') and sounds ('sfx/...'). */
  preload(paths) {
    return Promise.all(paths.map((p) => (p.startsWith('sfx/') || p.startsWith('music/') ? this.sound(p) : /\.(png|gif|jpe?g|webp)$/i.test(p) ? this.sheet(p) : p.startsWith('maps/') ? this.map(p) : this.sequence(p))));
  }

  /** A tile map (the library's grid format or Tiled JSON), with its tilesets, images and prop sprites loaded. */
  async map(path, opts = {}) {
    const r = await fetch(this.url(path));
    if (!r.ok) throw new Error(`map failed: ${path} (${r.status})`);
    return GameMap.from(this, await r.json(), path, opts);
  }

  /** A 3D scene file (a list of glTF placements): `scene.build({ THREE, GLTFLoader })` returns a THREE.Group. */
  async scene(path) {
    const r = await fetch(this.url(path));
    if (!r.ok) throw new Error(`scene failed: ${path} (${r.status})`);
    return new Scene(this, await r.json());
  }
}

// ---------- maps ----------

/**
 * A cell reference -> 1-based linear index into a sheet with `cols` columns (0 = empty).
 * "7b" or "7.2" or "7:2" = row 7, column b/2 (1-based, the way the packs' .txt legends count);
 * 42 = linear index 42 (row-major, 1-based, the Tiled convention); 0, "", "." = empty.
 */
export function parseCell(token, cols) {
  if (token == null || token === '' || token === '.' || token === 0) return 0;
  if (typeof token === 'number') return token;
  const s = String(token).trim();
  if (/^\d+$/.test(s)) return +s;
  let m = /^(\d+)[.:]?([a-z])$/i.exec(s);
  if (m) return (+m[1] - 1) * cols + (m[2].toLowerCase().charCodeAt(0) - 96);
  m = /^(\d+)[.:](\d+)$/.exec(s);
  if (m) return (+m[1] - 1) * cols + +m[2];
  throw new Error(`bad cell "${token}"`);
}

/** Isometric tile (x, y) -> screen px of the tile image's top-left, for a diamond `w` wide and `h` tall. */
export function isoToScreen(x, y, w, h) { return [(x - y) * (w / 2), (x + y) * (h / 2)]; }
/** Screen px -> isometric tile coordinates (fractional). */
export function screenToIso(sx, sy, w, h) { return [sy / h + sx / w, sy / h - sx / w]; }

/**
 * Rows of a layer -> flat Int32Array of cell indices. A row is an array of tokens, a whitespace-separated
 * string of tokens, or (with a legend) a string of one character per cell. Missing cells take `fill`.
 */
export function expandRows(rows, width, height, cols, { legend = null, fill = 0 } = {}) {
  const out = new Int32Array(width * height).fill(parseCell(fill, cols));
  const list = typeof rows === 'string' ? rows.split(/\r?\n/).filter((l) => l.length) : rows || [];
  list.forEach((row, y) => {
    if (y >= height) return;
    let tokens;
    if (Array.isArray(row)) tokens = row;
    else if (legend && !/\s/.test(row.trim())) tokens = [...row].map((ch) => (ch in legend ? legend[ch] : ch === ' ' || ch === '.' ? 0 : ch));
    else tokens = row.trim().split(/\s+/);
    tokens.forEach((tok, x) => { if (x < width) out[y * width + x] = tok === '~' ? out[y * width + x] : parseCell(tok, cols); });
  });
  return out;
}

export class GameMap {
  /** Build from parsed JSON (grid format or Tiled JSON) and load everything it references. */
  static async from(lib, data, url = '', opts = {}) {
    const isTiled = Array.isArray(data.layers) && data.layers.some((l) => l.type === 'tilelayer') && data.tilewidth;
    const spec = isTiled ? tiledToGrid(data, url) : data;
    const map = new GameMap(lib, spec, url);
    await map.load(opts);
    return map;
  }

  constructor(lib, spec, url = '') {
    this.lib = lib; this.spec = spec; this.url = url;
    this.name = spec.name || url.split('?')[0].split('/').pop().replace(/\.json$/, '');
    this.iso = spec.orientation === 'isometric' || spec.iso === true;
    // tilesets: { key: url | { url, cell } }, or a single `tileset`
    const ts = spec.tilesets || (spec.tileset ? { main: spec.tileset } : {});
    this.tilesetSpecs = Object.fromEntries(Object.entries(ts).map(([k, v]) => [k, typeof v === 'string' ? { url: v } : v]));
    this.defaultTileset = Object.keys(this.tilesetSpecs)[0];
    this.images = spec.images || [];
    this.objects = (spec.objects || []).map((o) => ({ ...o }));
    this.legend = spec.legend || {};
    this.solidLayers = new Set(spec.solid || []);
  }

  async load() {
    const lib = this.lib;
    // Tilesets (sheets know their cell size from their sidecar; a map may override with `cell`).
    this.tilesets = {};
    await Promise.all(Object.entries(this.tilesetSpecs).map(async ([k, s]) => {
      const cell = s.cell || this.spec.cell;
      this.tilesets[k] = await lib.sheet(s.url, cell ? { cell } : {});
    }));
    const main = this.tilesets[this.defaultTileset];
    this.cell = this.spec.cell || (main ? main.cell : [16, 16]);
    this.isoHeight = this.spec.isoHeight || this.cell[1] / 2;
    // Size: given, or the largest layer.
    const layerList = Array.isArray(this.spec.layers) ? this.spec.layers : Object.entries(this.spec.layers || {}).map(([name, rows]) => (Array.isArray(rows) || typeof rows === 'string' ? { name, rows } : { name, ...rows }));
    const rowCount = (rows) => (typeof rows === 'string' ? rows.split(/\r?\n/).filter((l) => l.length).length : (rows || []).length);
    const colCount = (rows, legend) => Math.max(0, ...(typeof rows === 'string' ? rows.split(/\r?\n/) : rows || []).map((r) => (Array.isArray(r) ? r.length : legend && !/\s/.test(r.trim()) ? r.length : r.trim().split(/\s+/).length)));
    this.width = this.spec.size?.[0] || Math.max(1, ...layerList.map((l) => colCount(l.rows, l.legend || this.legend)));
    this.height = this.spec.size?.[1] || Math.max(1, ...layerList.map((l) => rowCount(l.rows)));
    // Layers.
    this.layers = layerList.map((l) => {
      const sheet = this.tilesets[l.tileset || this.defaultTileset];
      if (!sheet) throw new Error(`layer "${l.name}": no tileset "${l.tileset || this.defaultTileset}"`);
      const cells = expandRows(l.rows, this.width, this.height, sheet.cols, { legend: l.legend || this.legend, fill: l.fill || 0 });
      return { name: l.name, sheet, cells, solid: !!l.solid || this.solidLayers.has(l.name), animate: l.animate || null, parallax: l.parallax || [1, 1], offset: l.offset || [0, 0], visible: l.visible !== false };
    });
    // Stamps: copy a block of source cells into a layer.
    for (const st of this.spec.stamps || []) {
      const layer = this.layers.find((l) => l.name === st.layer) || this.layers[0];
      const cols = layer.sheet.cols;
      const from = parseCell(st.from, cols) - 1;
      const [w, h] = st.size || [1, 1];
      for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
        const x = st.at[0] + dx, y = st.at[1] + dy;
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
        layer.cells[y * this.width + x] = from + dy * cols + dx + 1;
      }
    }
    // Background images and prop sprites.
    this.imageSheets = await Promise.all(this.images.map((im) => lib.sheet(im.src)));
    const propUrls = [...new Set(this.objects.map((o) => o.sprite).filter(Boolean))];
    const propSheets = await Promise.all(propUrls.map((u) => lib.sheet(u)));
    this.propSheets = Object.fromEntries(propUrls.map((u, i) => [u, propSheets[i]]));
    return this;
  }

  layer(name) { return this.layers.find((l) => l.name === name); }
  /** Cell index (0 = empty) of `layer` at tile (x, y). */
  tile(name, x, y) { const l = this.layer(name); return l && x >= 0 && y >= 0 && x < this.width && y < this.height ? l.cells[y * this.width + x] : 0; }
  /** True when any solid layer has a tile at (x, y), or the tile is outside the map. */
  solid(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return true;
    return this.layers.some((l) => l.solid && l.cells[y * this.width + x] !== 0);
  }
  find(type) { return this.objects.filter((o) => o.type === type); }

  /** Screen px (before camera and scale) of tile (x, y)'s image top-left. */
  toScreen(x, y) { return this.iso ? isoToScreen(x, y, this.cell[0], this.isoHeight) : [x * this.cell[0], y * this.cell[1]]; }
  /** Tile coordinates at screen px (before camera and scale). */
  toTile(sx, sy) { return this.iso ? screenToIso(sx - this.cell[0] / 2, sy, this.cell[0], this.isoHeight) : [sx / this.cell[0], sy / this.cell[1]]; }
  /** Pixel bounds of the drawn map, props included: { x, y, w, h } (x is negative for isometric maps). */
  bounds() {
    const [cw, ch] = this.cell;
    let b;
    if (!this.iso) b = { x: 0, y: 0, w: this.width * cw, h: this.height * ch };
    else { const x = -(this.height - 1) * cw / 2; b = { x, y: 0, w: (this.width + this.height) * cw / 2, h: (this.width + this.height - 2) * this.isoHeight / 2 + ch }; }
    let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
    for (const o of this.objects) {
      if (!o.sprite || !this.propSheets?.[o.sprite]) continue;
      const r = this.propRect(o);
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** Source rect and world-px destination of a prop object. */
  propRect(o) {
    const sheet = this.propSheets[o.sprite];
    let rect;
    if (o.region) { const [c, r, w, h] = o.region; rect = { sx: (c - 1) * sheet.cell[0], sy: (r - 1) * sheet.cell[1], sw: w * sheet.cell[0], sh: h * sheet.cell[1] }; }
    else if (o.anim != null) { const a = sheet.animation(o.anim); rect = sheet.frame(a.col, a.row); }
    else if (o.frame != null) rect = sheet.frame(parseCell(o.frame, sheet.cols) - 1, 0);
    else rect = { sx: 0, sy: 0, sw: sheet.width, sh: sheet.height };
    const s = o.scale || 1;
    const [px, py] = this.toScreen(o.x, o.y);
    const [ax, ay] = o.anchor || (this.iso ? [0.5, 1] : [0, 1]);
    const baseX = this.iso ? px + this.cell[0] / 2 : px, baseY = this.iso ? py + this.isoHeight / 2 : py + this.cell[1];
    return { ...rect, x: baseX - rect.sw * s * ax, y: baseY - rect.sh * s * ay, w: rect.sw * s, h: rect.sh * s };
  }

  /**
   * Draw the map. camera is the world px at the viewport's top-left; scale multiplies everything;
   * t (ms) drives animated layers and props; `layers` limits which layers draw; objects draws props.
   */
  draw(ctx, { camera = [0, 0], scale = 1, viewport = null, t = 0, layers = null, objects = true, smooth = false } = {}) {
    const [vw, vh] = viewport || [ctx.canvas.width, ctx.canvas.height];
    const [cw, ch] = this.cell;
    ctx.imageSmoothingEnabled = smooth;
    for (let i = 0; i < this.images.length; i++) {
      const im = this.images[i], sheet = this.imageSheets[i];
      const px = im.parallax || [0, 0], s = (im.scale || 1) * scale;
      const w = sheet.width * s, h = sheet.height * s;
      const ox = ((im.x || 0) - camera[0] * px[0]) * scale, oy = ((im.y || 0) - camera[1] * px[1]) * scale;
      if (im.repeat === 'x' || im.repeat === true) {
        for (let x = ((ox % w) + w) % w - w; x < vw; x += w) ctx.drawImage(sheet.img, x, oy, w, h);
      } else ctx.drawImage(sheet.img, ox, oy, w, h);
    }
    for (const l of this.layers) {
      if (!l.visible || (layers && !layers.includes(l.name))) continue;
      const ox = (l.offset[0] - camera[0] * l.parallax[0]) * scale, oy = (l.offset[1] - camera[1] * l.parallax[1]) * scale;
      const shift = l.animate ? frameAt(t, l.animate.frames, l.animate.fps || 8) : 0;
      let x0 = 0, y0 = 0, x1 = this.width, y1 = this.height;
      if (!this.iso) {
        x0 = Math.max(0, Math.floor(-ox / (cw * scale))); y0 = Math.max(0, Math.floor(-oy / (ch * scale)));
        x1 = Math.min(this.width, Math.ceil((vw - ox) / (cw * scale))); y1 = Math.min(this.height, Math.ceil((vh - oy) / (ch * scale)));
      }
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const idx = l.cells[y * this.width + x];
        if (!idx) continue;
        const { sx, sy, sw, sh } = l.sheet.frame(idx - 1 + shift, 0);
        const [px, py] = this.toScreen(x, y);
        ctx.drawImage(l.sheet.img, sx, sy, sw, sh, px * scale + ox, py * scale + oy, sw * scale, sh * scale);
      }
    }
    if (objects) {
      const props = this.objects.filter((o) => o.sprite).sort((a, b) => (this.iso ? a.x + a.y - b.x - b.y : a.y - b.y));
      for (const o of props) {
        const sheet = this.propSheets[o.sprite];
        const r = this.propRect(o);
        if (o.anim != null) {                       // advance the frame along the animation's row
          const a = sheet.animation(o.anim);
          const i = frameAt(t + (o.phase || 0), a.frames, o.fps || a.fps, true);
          Object.assign(r, sheet.frame(a.col + i, a.row));
        }
        ctx.drawImage(sheet.img, r.sx, r.sy, r.sw, r.sh, (r.x - camera[0]) * scale, (r.y - camera[1]) * scale, r.w * scale, r.h * scale);
      }
    }
  }
}

/** Tiled JSON (embedded tilesets, tile layers, object groups) -> the grid format GameMap reads. */
export function tiledToGrid(data, url = '') {
  const dir = url.replace(/[^/]*$/, '');
  const resolve = (p) => { const parts = (dir + p).split('/'); const out = []; for (const s of parts) { if (s === '..') out.pop(); else if (s !== '.' && s !== '') out.push(s); } return out.join('/'); };
  const sets = (data.tilesets || []).filter((t) => t.image).map((t) => ({ key: t.name || `ts${t.firstgid}`, firstgid: t.firstgid, url: resolve(t.image), cell: [t.tilewidth, t.tileheight], count: t.tilecount || Infinity })).sort((a, b) => b.firstgid - a.firstgid);
  const setOf = (gid) => sets.find((s) => gid >= s.firstgid);
  const tilesets = Object.fromEntries(sets.map((s) => [s.key, { url: s.url, cell: s.cell }]));
  const layers = [], objects = [];
  const walk = (list) => {
    for (const l of list) {
      if (l.type === 'group') walk(l.layers || []);
      else if (l.type === 'tilelayer' && Array.isArray(l.data)) {
        const byset = new Map();
        l.data.forEach((raw, i) => {
          const gid = raw & 0x1fffffff; if (!gid) return;
          const s = setOf(gid); if (!s) return;
          if (!byset.has(s.key)) byset.set(s.key, new Array(l.width * l.height).fill(0));
          byset.get(s.key)[i] = gid - s.firstgid + 1;
        });
        const props = Object.fromEntries((l.properties || []).map((p) => [p.name, p.value]));
        for (const [key, flat] of byset) {
          const rows = []; for (let y = 0; y < l.height; y++) rows.push(flat.slice(y * l.width, (y + 1) * l.width));
          layers.push({ name: byset.size > 1 ? `${l.name}:${key}` : l.name, tileset: key, rows, solid: !!props.solid, visible: l.visible !== false, offset: [l.offsetx || 0, l.offsety || 0], parallax: [l.parallaxx ?? 1, l.parallaxy ?? 1] });
        }
      } else if (l.type === 'objectgroup') {
        for (const o of l.objects || []) objects.push({ type: o.type || o.class || o.name, name: o.name, x: o.x / data.tilewidth, y: o.y / data.tileheight, ...(o.width ? { w: o.width / data.tilewidth, h: o.height / data.tileheight } : {}), ...Object.fromEntries((o.properties || []).map((p) => [p.name, p.value])) });
      }
    }
  };
  walk(data.layers || []);
  return { name: data.name, size: [data.width, data.height], cell: [data.tilewidth, data.tileheight], orientation: data.orientation, isoHeight: data.orientation === 'isometric' ? data.tileheight : undefined, tilesets, layers, objects };
}

// ---------- 3D scenes ----------

export class Scene {
  constructor(lib, data) { this.lib = lib; this.data = data; this.name = data.name; this.placements = data.placements || []; }
  /** Load every model once (glTF via the caller's loader), clone per placement, return a THREE.Group. */
  async build({ THREE, GLTFLoader }) {
    const loader = new GLTFLoader();
    const base = this.data.models || '';
    const names = [...new Set(this.placements.map((p) => p.model))];
    const loaded = await Promise.all(names.map((n) => loader.loadAsync(this.lib.url(/\.(glb|gltf)$/.test(n) ? n : `${base}${n}.gltf`))));
    const protos = Object.fromEntries(names.map((n, i) => [n, loaded[i].scene]));
    const group = new THREE.Group();
    group.name = this.name || 'scene';
    if (this.data.ground) {
      const g = this.data.ground, [w, d] = g.size || [20, 20];
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshLambertMaterial({ color: g.color || '#4a7c3f' }));
      mesh.rotation.x = -Math.PI / 2; mesh.position.set((g.center || [0, 0])[0], 0, (g.center || [0, 0])[1]); mesh.receiveShadow = true;
      group.add(mesh);
    }
    for (const p of this.placements) {
      const m = protos[p.model].clone(true);
      const [x, y, z] = p.at || [0, 0, 0];
      m.position.set(x, y, z);
      m.rotation.y = ((p.rotate || 0) * Math.PI) / 180;
      const s = p.scale || 1; m.scale.set(s, s, s);
      m.userData = { ...p };
      group.add(m);
    }
    return group;
  }
}

export class Sheet {
  constructor(img, meta = {}) {
    this.img = img;
    this.width = img.naturalWidth || img.width;
    this.height = img.naturalHeight || img.height;
    const [cw, ch] = meta.cell || [this.width, this.height];
    this.cell = [cw, ch];
    this.cols = meta.cols || Math.max(1, Math.floor(this.width / cw));
    this.rows = meta.rows || Math.max(1, Math.floor(this.height / ch));
    this.frames = meta.frames || this.cols;
    this.fps = meta.fps || 10;
    // A one-row strip is also an animation, under the sheet's own name or "play" (as in its atlas).
    this.animations = meta.animations || (this.rows === 1 && this.frames > 1 ? { [meta.animation || 'play']: { row: 0, frames: this.frames } } : {});
    this.meta = meta;
  }

  /** Source rect of a cell by (col, row), or by a single index counted left to right, top to bottom. */
  frame(col, row = 0) {
    if (row === 0 && col >= this.cols) { row = Math.floor(col / this.cols); col %= this.cols; }
    return cellRect(col, row, this.cell[0], this.cell[1]);
  }

  /** { row, frames, fps, col } for a named animation, an ad-hoc { row, frames } object, or null for the first row as a strip. */
  animation(name) {
    if (name && typeof name === 'object') return { fps: this.fps, col: 0, ...name };
    if (name == null) return { row: 0, col: 0, frames: this.frames, fps: this.fps };
    const a = this.animations[name];
    if (!a) throw new Error(`no animation "${name}" (have: ${Object.keys(this.animations).join(', ') || 'none'})`);
    return { fps: this.fps, col: 0, ...a };
  }

  /** Draw one cell at (x, y). scale multiplies the cell size; flip mirrors horizontally. */
  drawFrame(ctx, col, row, x, y, { scale = 1, flip = false, smooth = false } = {}) {
    const { sx, sy, sw, sh } = this.frame(col, row);
    const dw = sw * scale, dh = sh * scale;
    ctx.imageSmoothingEnabled = smooth;
    if (flip) {
      ctx.save(); ctx.translate(x + dw, y); ctx.scale(-1, 1);
      ctx.drawImage(this.img, sx, sy, sw, sh, 0, 0, dw, dh);
      ctx.restore();
    } else ctx.drawImage(this.img, sx, sy, sw, sh, x, y, dw, dh);
  }

  /**
   * Draw animation `name` at time t (ms since it started). Returns true once a non-looping animation
   * has shown its last frame. `name` may be null (the sheet is a strip), a string from `animations`,
   * or { row, frames, fps }.
   */
  draw(ctx, name, t, x, y, opts = {}) {
    const a = this.animation(name);
    const fps = opts.fps || a.fps;
    const loop = opts.loop !== false;
    const i = frameAt(t, a.frames, fps, loop);
    this.drawFrame(ctx, a.col + i, a.row, x, y, opts);
    return !loop && i >= a.frames - 1;
  }
}

export class Sequence {
  constructor(images, meta = {}) {
    this.images = images;
    this.frames = images.length;
    this.fps = meta.fps || 10;
    this.width = images[0].naturalWidth || images[0].width;
    this.height = images[0].naturalHeight || images[0].height;
    this.meta = meta;
  }
  draw(ctx, t, x, y, { scale = 1, flip = false, loop = true, fps = this.fps, smooth = true } = {}) {
    const i = frameAt(t, this.frames, fps, loop);
    const img = this.images[i];
    const dw = (img.naturalWidth || img.width) * scale, dh = (img.naturalHeight || img.height) * scale;
    ctx.imageSmoothingEnabled = smooth;
    if (flip) { ctx.save(); ctx.translate(x + dw, y); ctx.scale(-1, 1); ctx.drawImage(img, 0, 0, dw, dh); ctx.restore(); }
    else ctx.drawImage(img, x, y, dw, dh);
    return !loop && i >= this.frames - 1;
  }
}

export class Sound {
  constructor(lib, buffers, meta = {}) {
    this.lib = lib;
    this.buffers = buffers;
    this.duration = buffers[0]?.duration ?? meta.duration ?? 0;
    this.gain = meta.gain ?? 1;
    this.meta = meta;
  }
  /** Play once. variant picks a specific buffer (0-based); otherwise one is chosen at random. */
  play({ gain = this.gain, rate = 1, variant, when = 0 } = {}) {
    const ctx = this.lib.audio();
    if (ctx.state !== 'running') ctx.resume();
    const buf = this.buffers[variant ?? Math.floor(Math.random() * this.buffers.length)];
    const src = ctx.createBufferSource();
    src.buffer = buf; src.playbackRate.value = rate;
    const g = ctx.createGain(); g.gain.value = gain;
    src.connect(g).connect(ctx.destination);
    src.start(ctx.currentTime + when);
    return src;
  }
}

export const assets = new AssetLibrary();
