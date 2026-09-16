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
    return Promise.all(paths.map((p) => (p.startsWith('sfx/') || p.startsWith('music/') ? this.sound(p) : /\.(png|gif|jpe?g|webp)$/i.test(p) ? this.sheet(p) : this.sequence(p))));
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
    this.animations = meta.animations || {};
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
