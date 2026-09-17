#!/usr/bin/env node
// Build the asset library: LIB_SRC (the itch.io downloads) -> library/out (the tree uploaded to the CDN).
//
//   node library/build.mjs            incremental: only converts/copies what changed
//   node library/build.mjs --clean    wipe library/out first
//   LIB_SRC=~/Downloads/"Game asset"  where the zips and folders live (default)
//
// What it does, per pack in packs.json:
//   1. unzips (once) into library/.stage/<zip name>/, unwraps a single top-level folder
//   2. routes every file to its CDN path (see `dest`), cleaning names for URLs
//   3. converts .wav -> .m4a (AAC 128 kbps, 44.1 kHz) with afconvert (ffmpeg fallback)
//   4. writes out/manifest.json (every file with bytes, sha1, image size, duration, frames),
//      out/packs.json and out/index.html (the catalog page)

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanName, cleanPath, imageSize, mimeOf, parseEffectSheet, parseKenneyAtlas, parsePixelCombat, PIXEL_COMBAT_CAT, routeDest, slug, wavDuration } from './lib.mjs';
import { parseCell } from './aha-assets.js';
import { extractNode, readGlb, setBaseColorImage, vertexColorsOnly, writeGlb } from './gltf.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = (process.env.LIB_SRC || path.join(os.homedir(), 'Downloads', 'Game asset')).replace(/^~/, os.homedir());
const STAGE = path.join(HERE, '.stage');
const OUT = path.join(HERE, 'out');
const CLEAN = process.argv.includes('--clean');
const JOBS = Number(process.env.LIB_JOBS) || Math.max(2, Math.min(8, os.cpus().length));

const GLOBAL_SKIP = [/(^|\/)__MACOSX\//, /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/, /\.(rpp|ase|aseprite|psd|url|db)$/i];
const packsFile = JSON.parse(fs.readFileSync(path.join(HERE, 'packs.json'), 'utf8'));

if (!fs.existsSync(SRC)) { console.error(`LIB_SRC not found: ${SRC}`); process.exit(1); }
if (CLEAN) fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(STAGE, { recursive: true });

// ---------- small utils ----------
const run = (cmd, args) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.on('error', reject);
  p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} failed (${code}): ${err.trim()}`))));
});
const which = (cmd) => (process.env.PATH || '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, cmd)));

async function pool(items, n, fn) {
  const it = items[Symbol.iterator]();
  const workers = Array.from({ length: n }, async () => { for (let x = it.next(); !x.done; x = it.next()) await fn(x.value); });
  await Promise.all(workers);
}

function walk(dir, base = dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, base, acc);
    else if (ent.isFile()) acc.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return acc;
}

/** Descend while the directory holds exactly one entry and it is a directory. */
function unwrap(dir) {
  for (;;) {
    const ents = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !GLOBAL_SKIP.some((re) => re.test(e.name)));
    if (ents.length === 1 && ents[0].isDirectory()) dir = path.join(dir, ents[0].name);
    else return dir;
  }
}

async function stage(zipName) {
  const dir = path.join(STAGE, zipName.replace(/\.zip$/i, ''));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    await run('unzip', ['-qo', findSource(zipName), '-d', dir]);
  }
  return unwrap(dir);
}

/** A library from npm: `npm pack name@version` once into .stage/npm/, extracted; the pack's `only`/`skip` pick the files. */
async function stageNpm(name, version) {
  const dir = path.join(STAGE, 'npm', `${name.replace(/[@/]/g, '-')}-${version}`);
  if (!fs.existsSync(path.join(dir, 'package'))) {
    fs.mkdirSync(dir, { recursive: true });
    const tgz = await new Promise((resolve, reject) => {
      const p = spawn('npm', ['pack', `${name}@${version}`, '--pack-destination', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve(out.trim().split('\n').pop()) : reject(new Error(`npm pack ${name}@${version} failed: ${err.trim()}`))));
    });
    await run('tar', ['xzf', path.join(dir, tgz), '-C', dir]);
  }
  return path.join(dir, 'package');
}

function findSource(name) {
  for (const c of [path.join(SRC, name), path.join(SRC, 'Game Assets', name)]) if (fs.existsSync(c)) return c;
  throw new Error(`source not found: ${name}`);
}

const upToDate = (src, dst) => fs.existsSync(dst) && fs.statSync(dst).mtimeMs >= fs.statSync(src).mtimeMs;
function copyIfChanged(src, dst) {
  if (upToDate(src, dst)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return true;
}

// ---------- audio ----------
const HAS_AFCONVERT = which('afconvert');
// LIB_FFMPEG points at a binary off PATH; `npx --yes ffmpeg-static-bin` or Homebrew both do
const FFMPEG = process.env.LIB_FFMPEG || 'ffmpeg';
const HAS_FFMPEG = process.env.LIB_FFMPEG ? fs.existsSync(FFMPEG) : which('ffmpeg');
if (!HAS_AFCONVERT && !HAS_FFMPEG) { console.error('need afconvert (macOS) or ffmpeg on PATH to convert .wav'); process.exit(1); }

async function toM4a(src, dst) {
  if (upToDate(src, dst)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.tmp.m4a`;
  // afconvert is macOS's own and much the fastest, but it cannot read Vorbis, so .ogg goes through ffmpeg
  const vorbis = /\.ogg$/i.test(src);
  if (HAS_AFCONVERT && !vorbis) await run('afconvert', ['-f', 'm4af', '-d', 'aac@44100', '-b', '128000', '-q', '127', '-s', '3', src, tmp]);
  else await run(FFMPEG, ['-y', '-loglevel', 'error', '-i', src, '-ar', '44100', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp]);
  fs.renameSync(tmp, dst);
  return true;
}

// ---------- per-file work items ----------
// Packs a handler discovers rather than packs.json listing them (Kenney's 250); they join the
// manifest's pack list on equal terms.
const generated = [];
// item: { src, dst (relative to OUT), pack, meta: { ...extra manifest fields }, convert: bool }
const items = [];
const seen = new Map();
function add(item) {
  if (seen.has(item.dst)) throw new Error(`destination collision: ${item.dst} <- ${item.src} and ${seen.get(item.dst)}`);
  seen.set(item.dst, item.src);
  items.push(item);
}

function planGeneric(pack, root, rels) {
  const skips = (pack.skip || []).map((s) => new RegExp(s));
  for (const rel of rels) {
    if (GLOBAL_SKIP.some((re) => re.test(rel)) || skips.some((re) => re.test('/' + rel))) continue;
    if (pack.only && !pack.only.some((p) => rel.startsWith(p))) continue;
    const isWav = /\.wav$/i.test(rel);
    const named = pack.rename?.[rel] || rel;
    const target = cleanPath(isWav ? named.replace(/\.wav$/i, '.m4a') : named);
    add({ src: path.join(root, rel), dst: routeDest(pack.dest, target), pack: pack.id, convert: isWav, meta: {} });
  }
}

function planSfxFolders(pack, root, rels) {
  // "<Folder>/<name>.wav" -> "<dest>/<folder-slug>/<name>.m4a"
  for (const rel of rels) {
    if (GLOBAL_SKIP.some((re) => re.test(rel))) continue;
    const parts = rel.split('/');
    const file = parts.pop();
    const folder = parts.map(slug).join('/');
    const isWav = /\.wav$/i.test(file);
    const name = cleanName(isWav ? file.replace(/\.wav$/i, '.m4a') : file);
    add({ src: path.join(root, rel), dst: `${pack.dest}/${folder ? folder + '/' : ''}${name}`, pack: pack.id, convert: isWav, meta: { category: folder || null } });
  }
}

function planPixelCombat(pack, root, rels) {
  const parsed = [];
  for (const rel of rels) {
    const p = parsePixelCombat(path.basename(rel));
    if (!p) { if (!GLOBAL_SKIP.some((re) => re.test(rel))) console.warn(`  skip (unrecognised name): ${rel}`); continue; }
    parsed.push({ rel, ...p });
  }
  // The same sound name can exist under two UCS ids in one category (e.g. UIMisc and DSGNMisc "Zap Select");
  // those get the id folded into the slug so nothing is lost.
  const byKey = new Map();
  for (const p of parsed) {
    const k = `${p.category}/${slug(p.name)}`;
    byKey.set(k, (byKey.get(k) || new Set()).add(p.catId));
  }
  for (const p of parsed) {
    const base = slug(p.name);
    const clash = byKey.get(`${p.category}/${base}`).size > 1;
    const stem = clash ? `${base}-${slug(p.catId)}` : base;
    add({
      src: path.join(root, p.rel),
      dst: `${pack.dest}/${p.category}/${stem}-${String(p.variant).padStart(2, '0')}.m4a`,
      pack: pack.id, convert: true,
      meta: { name: p.name, category: p.category, variant: p.variant, tags: PIXEL_COMBAT_CAT[p.catId] || [slug(p.catId)], ucs: p.catId, original: path.basename(p.rel) },
    });
  }
}

function planPixelEffects(pack, root, rels) {
  // spritesheet/<Category>/<anim>/<anim_variant>/spritesheet.png + .txt -> sprites/pixel-effects/<category>/<anim_variant>.png
  for (const rel of rels) {
    if (GLOBAL_SKIP.some((re) => re.test(rel))) continue;
    const m = /^spritesheet\/([^/]+)\/([^/]+)\/([^/]+)\/spritesheet\.png$/.exec(rel);
    if (m) {
      const txt = path.join(root, rel.replace(/\.png$/, '.txt'));
      const sheet = fs.existsSync(txt) ? parseEffectSheet(fs.readFileSync(txt, 'utf8')) : null;
      add({ src: path.join(root, rel), dst: `${pack.dest}/${slug(m[1])}/${cleanName(m[3])}.png`, pack: pack.id, convert: false,
        meta: { category: slug(m[1]), animation: m[2], fps: 15, ...(sheet ? { frames: sheet.frames, cell: [sheet.width, sheet.height] } : {}) } });
    } else if (/^[^/]+\.txt$/.test(rel)) {
      add({ src: path.join(root, rel), dst: `${pack.dest}/${cleanName(rel)}`, pack: pack.id, convert: false, meta: {} });
    }
    // PNG/ (one file per frame) is not hosted: the strips carry the same frames.
  }
}

/* ---------- Kenney's All-in-1 bundle ----------
   250 packs in one folder, every one of them CC0. Each becomes a pack of its own (kenney-<slug>,
   under sprites|models|sfx|music|fonts/kenney/<slug>/), because "Kenney" as a single pack would be
   30,000 files in one heap. Only the web-ready form of each asset is hosted:

     a sheet with an XML atlas   the PNG, plus a generated .atlas.json carrying Kenney's own frame
                                 names; the loose frames the atlas already names are not hosted
     a Tilemap / Tilesheet grid  the sheet (the per-tile PNGs beside it are the same pixels)
     other PNGs                  as they are
     Models/GLTF format/*.glb    the FBX, OBJ, DAE and STL copies of the same model are not hosted
     Audio                       .ogg converted to .m4a, like every other sound here
     fonts                       .ttf / .otf

   Vector sources, per-model preview renders, Construct and Unity projects, and the Archive and
   Goodies categories stay out; they are downloads, not things a game loads. */
const KENNEY_CATEGORIES = new Set(['2D assets', '3D assets', 'Audio', 'UI assets', 'Icons', 'Early access', 'Other']);
const KENNEY_ONLY_PACKS = { Other: new Set(['Fonts']) };            // the rest of "Other" is sample projects
const KENNEY_KEEP = /\.(png|glb|gltf|bin|ogg|wav|mp3|ttf|otf)$/i;
const KENNEY_SHEET_DIR = /(^|\/)(spritesheets?|tilesheets?|tilemap)(\/|$)/i;
const KENNEY_TILE_DIR = /(^|\/)tiles?( \([^)]*\))?(\/|$)/i;
const KENNEY_DROP_DIR = /(^|\/)(vector|previews?|sources?|construct|samples?|skins)(\/|$)/i;
const KENNEY_MUSIC = /music|jingle|soundtrack/i;

/**
 * kenney.nl's page for a pack. library/kenney-urls.json maps every pack folder in the bundle to the
 * page that actually exists (checked against kenney.nl's own list; some packs were renamed, and a
 * few are bundle-only, which point at the catalogue). Anything not in the map falls back to the
 * name lower-cased and hyphenated, which is the site's usual shape.
 */
const KENNEY_URLS = JSON.parse(fs.readFileSync(path.join(HERE, 'kenney-urls.json'), 'utf8'));
const kenneyUrl = (name) => KENNEY_URLS[name] || `https://kenney.nl/assets/${name.toLowerCase().replace(/[()×]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`;

/** tilewidth/tileheight/spacing/margin out of a Tiled .tsx or .tmx, which says it exactly. */
function tiledGrid(xml) {
  const n = (k) => { const m = new RegExp(`${k}="(\\d+)"`).exec(xml); return m ? +m[1] : null; };
  const w = n('tilewidth'), h = n('tileheight');
  return w && h ? { cell: [w, h], gap: n('spacing') || 0, margin: n('margin') || 0 } : null;
}

/**
 * The grid of a tile sheet: the cell size is what one loose tile measures, and the gap is whatever
 * makes that cell size divide the sheet exactly. Kenney draws most sheets with a 1px gap between
 * tiles, which is the thing every agent otherwise has to work out by eye.
 */
function fitGrid(sheet, cell) {
  if (!sheet || !cell) return null;
  const [cw, ch] = cell;
  if (cw > sheet.width || ch > sheet.height) return null;
  for (const gap of [0, 1, 2]) {
    for (const margin of [0, gap]) {
      const fits = (total, size) => (total - 2 * margin + gap) % (size + gap) === 0 && (total - 2 * margin + gap) / (size + gap) >= 1;
      if (fits(sheet.width, cw) && fits(sheet.height, ch)) {
        return { cell: [cw, ch], ...(gap ? { gap: [gap, gap] } : {}), ...(margin ? { margin: [margin, margin] } : {}) };
      }
    }
  }
  return null;
}

/** The size most of these images share, which for a folder of tiles is the tile size. */
function modalSize(paths, share = 0.3) {
  const counts = new Map();
  let n = 0;
  for (const f of paths.slice(0, 40)) {
    try {
      const s = imageSize(fs.readFileSync(f));
      if (!s) continue;
      n++;
      const k = `${s.width}x${s.height}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    } catch { /* unreadable: it simply does not vote */ }
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= Math.max(2, n * share) ? best[0].split('x').map(Number) : null;
}

function planKenney(pack, root, rels) {
  const groups = new Map();
  for (const rel of rels) {
    if (GLOBAL_SKIP.some((re) => re.test(rel))) continue;
    const parts = rel.split('/');
    if (parts.length < 3) continue;                                  // Overview.html, assets.json, the .url shortcuts
    const [category, name] = parts;
    if (!KENNEY_CATEGORIES.has(category)) continue;
    if (KENNEY_ONLY_PACKS[category] && !KENNEY_ONLY_PACKS[category].has(name)) continue;
    const key = `${category}/${name}`;
    (groups.get(key) || groups.set(key, []).get(key)).push(parts.slice(2).join('/'));
  }

  for (const [key, files] of [...groups].sort()) {
    const [category, name] = key.split('/');
    const id = `kenney-${slug(name)}`;
    const dir = `kenney/${slug(name)}`;
    const audioDest = KENNEY_MUSIC.test(name) ? `music/${dir}` : `sfx/${dir}`;

    // The atlases first: they decide which loose frames are worth hosting.
    const atlases = [];
    for (const rel of files) {
      if (!/\.xml$/i.test(rel)) continue;
      const parsed = parseKenneyAtlas(fs.readFileSync(path.join(root, key, rel), 'utf8'));
      // The sheet is the PNG of the same name; older packs all claim imagePath="sprites.png", so that
      // is only the fallback.
      const dir2 = path.posix.dirname(rel);
      const sameName = path.posix.join(dir2, path.basename(rel).replace(/\.xml$/i, '.png'));
      const png = files.includes(sameName) ? sameName : path.posix.join(dir2, parsed.image || '');
      if (!files.includes(png)) continue;                            // an atlas for a sheet that is not here
      // Frame names lose the .png some packs carry, so every atlas here names frames the same way.
      const frames = Object.fromEntries(Object.entries(parsed.frames).map(([n, f]) => [n.replace(/\.(png|jpg)$/i, ''), f]));
      atlases.push({ rel, png, frames });
    }
    const covered = new Set(atlases.flatMap((a) => Object.keys(a.frames)));
    const hasSheet = atlases.length > 0 || files.some((f) => KENNEY_SHEET_DIR.test(f) && /\.png$/i.test(f));

    // The tile size: a Tiled file in the pack if there is one, otherwise what the loose tiles measure.
    const tiled = files.filter((f) => /\.(tsx|tmx)$/i.test(f)).map((f) => tiledGrid(fs.readFileSync(path.join(root, key, f), 'utf8'))).find(Boolean);
    const tilePngs = files.filter((f) => /\.png$/i.test(f) && KENNEY_TILE_DIR.test(f) && !KENNEY_SHEET_DIR.test(f)).map((f) => path.join(root, key, f));
    const loosePngs = files.filter((f) => /\.png$/i.test(f) && !KENNEY_SHEET_DIR.test(f) && !KENNEY_DROP_DIR.test(f)).map((f) => path.join(root, key, f));
    // A sheet's cell is what one of the pack's own sprites measures — its tiles if it has a tile
    // folder, otherwise whatever size most of its loose sprites share (half of them, to be sure).
    const tileCell = tiled?.cell || modalSize(tilePngs) || modalSize(loosePngs, 0.5);
    // Some kits ship the same models twice, as .glb and as .gltf+.bin; one self-contained file wins.
    const modelDir = files.some((f) => /(^|\/)glb format\//i.test(f)) ? /(^|\/)glb format\//i : /(^|\/)gltf format\//i;

    let kept = 0;
    for (const rel of files) {
      if (!KENNEY_KEEP.test(rel)) continue;
      if (KENNEY_DROP_DIR.test(rel)) continue;
      if (/(^|\/)preview\.png$/i.test(rel)) continue;
      const ext = path.extname(rel).toLowerCase();
      const base = path.basename(rel, ext);

      if (ext === '.glb' || ext === '.gltf' || ext === '.bin') {
        if (!modelDir.test(rel)) continue;                           // Models/{FBX,OBJ,DAE,STL} format/ are the same models
        add({ src: path.join(root, key, rel), dst: `models/${dir}/${cleanName(path.basename(rel))}`, pack: id, convert: false, meta: {} });
        kept++; continue;
      }
      if (/(^|\/)models?(\/|$)/i.test(rel)) continue;                 // anything else under Models/ is a source format
      if (ext === '.ogg' || ext === '.wav' || ext === '.mp3') {
        // "Audio (Female)/1.ogg" and "Audio (Male)/1.ogg" are different sounds: keep the folder as a category
        const sub = path.posix.dirname(rel).split('/').filter((d) => d && d !== '.' && !/^audio$/i.test(d)).map(slug).join('/');
        add({ src: path.join(root, key, rel), dst: `${audioDest}/${sub ? sub + '/' : ''}${cleanName(base)}.m4a`, pack: id, convert: true, meta: sub ? { category: sub } : {} });
        kept++; continue;
      }
      if (ext === '.ttf' || ext === '.otf') {
        add({ src: path.join(root, key, rel), dst: `fonts/${dir}/${cleanName(path.basename(rel))}`, pack: id, convert: false, meta: {} });
        kept++; continue;
      }
      // PNG: a sheet the atlas describes, a grid sheet, or a loose frame no sheet covers
      const atlas = atlases.find((a) => a.png === rel);
      if (!atlas) {
        if (covered.has(base)) continue;                             // the atlas names this frame already
        if (hasSheet && KENNEY_TILE_DIR.test(rel) && !KENNEY_SHEET_DIR.test(rel)) continue;   // the tilesheet holds these tiles
      }
      // A sheet arrives ready to use: named frames from its atlas, or a grid the library measured.
      let meta = {};
      if (atlas) meta = { atlas: true, frames: Object.keys(atlas.frames).length };
      else if (KENNEY_SHEET_DIR.test(rel) && tileCell) {
        const grid = fitGrid(imageSize(fs.readFileSync(path.join(root, key, rel))), tileCell);
        if (grid) meta = grid;
      }
      add({
        src: path.join(root, key, rel),
        dst: `sprites/${dir}/${cleanPath(rel)}`,
        pack: id, convert: false, meta,
        atlas: atlas ? atlas.frames : undefined,
      });
      kept++;
    }
    if (!kept) continue;
    generated.push({
      id, title: `Kenney ${name}`, author: 'Kenney', authorUrl: 'https://kenney.nl',
      url: kenneyUrl(name), source: 'kenney.nl', price: 'free (also in the $29.95 All-in-1 bundle)',
      kind: category === '3D assets' ? 'models' : category === 'Audio' ? 'sfx' : 'sprites',
      dest: { '': `sprites/${dir}`, 'models/': `models/${dir}`, 'sfx/': audioDest, 'fonts/': `fonts/${dir}` },
      license: pack.license, commercial: pack.commercial, credit: pack.credit, licenseFile: pack.licenseFile,
      description: `${name} from Kenney's All-in-1 bundle (${category}).`,
      notes: KENNEY_URLS[name] === 'https://kenney.nl/assets' ? 'Only in the All-in-1 bundle: kenney.nl has no page of its own for this pack (renamed or retired).' : null,
      bundle: pack.id, category,
    });
  }
}

function planMaps(pack, root, rels) {
  // library/maps/<pack>/<name>.json -> maps/<pack>/<name>.json; validated against the planned files below.
  for (const rel of rels) {
    if (!/\.json$/i.test(rel) || GLOBAL_SKIP.some((re) => re.test(rel))) continue;
    const data = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
    add({ src: path.join(root, rel), dst: `${pack.dest}/${cleanPath(rel)}`, pack: pack.id, convert: false,
      meta: { kind: data.kind === 'scene' ? 'scene' : 'map', name: data.name, basedOn: data.basedOn || null, description: data.description || null, ...(data.size ? { size: data.size } : {}), ...(data.iso ? { iso: true } : {}) },
      validate: data });
  }
}

/** Every tileset, sprite and model a map refers to must be a planned file; every cell must parse and fit its sheet. */
function validateMap(it) {
  const data = it.validate, errors = [];
  const exists = (p) => seen.has(p);
  const sizeOf = (p) => imageSize(fs.readFileSync(seen.get(p)));
  if (data.kind === 'scene') {
    for (const p of data.placements || []) { const f = /\.(glb|gltf)$/.test(p.model) ? p.model : `${data.models || ''}${p.model}.gltf`; if (!exists(f)) errors.push(`model ${f}`); }
  } else {
    const sets = data.tilesets || (data.tileset ? { main: data.tileset } : {});
    const cols = {};
    for (const [k, v] of Object.entries(sets)) {
      const url = typeof v === 'string' ? v : v.url;
      if (!exists(url)) { errors.push(`tileset ${url}`); continue; }
      const cell = (typeof v === 'object' && v.cell) || data.cell || cellOfPlanned(url);
      if (!cell) { errors.push(`tileset ${url}: no cell size known`); continue; }
      const s = sizeOf(url); cols[k] = Math.floor(s.width / cell[0]); cols[`${k}:rows`] = Math.floor(s.height / cell[1]);
    }
    const first = Object.keys(sets)[0];
    const layers = Array.isArray(data.layers) ? data.layers : Object.entries(data.layers || {}).map(([name, rows]) => (Array.isArray(rows) || typeof rows === 'string' ? { name, rows } : { name, ...rows }));
    for (const l of layers) {
      const key = l.tileset || first; if (!(key in cols)) { errors.push(`layer ${l.name}: tileset ${key}`); continue; }
      const max = cols[key] * cols[`${key}:rows`];
      const check = (tok, where) => { try { const i = parseCell(tok, cols[key]); if (i > max) errors.push(`${where}: cell ${tok} is outside ${key} (${cols[key]}x${cols[`${key}:rows`]})`); } catch (e) { errors.push(`${where}: ${e.message}`); } };
      if (l.fill) check(l.fill, `layer ${l.name} fill`);
      const legend = l.legend || data.legend || null;
      for (const row of (typeof l.rows === 'string' ? l.rows.split(/\r?\n/) : l.rows || [])) {
        const toks = Array.isArray(row) ? row : legend && !/\s/.test(row.trim()) ? [...row].map((ch) => legend[ch] ?? (ch === ' ' || ch === '.' ? 0 : ch)) : row.trim().split(/\s+/);
        toks.forEach((tok) => { if (tok !== '~') check(tok, `layer ${l.name}`); });
      }
    }
    for (const st of data.stamps || []) { const l = layers.find((x) => x.name === st.layer) || layers[0]; const key = l?.tileset || first; if (key in cols) { try { parseCell(st.from, cols[key]); } catch (e) { errors.push(`stamp ${st.from}: ${e.message}`); } } }
    for (const im of data.images || []) if (!exists(im.src)) errors.push(`image ${im.src}`);
    for (const o of data.objects || []) if (o.sprite && !exists(o.sprite)) errors.push(`object sprite ${o.sprite}`);
  }
  return errors;
}
function cellOfPlanned(url) {
  // the pack's cell rule for this planned file (same lookup the manifest uses later)
  const it = items.find((i) => i.dst === url); if (!it) return null;
  if (it.meta.cell) return it.meta.cell;
  const p = packsFile.packs.find((x) => x.id === it.pack); if (!p) return null;
  const d = typeof p.dest === 'string' ? p.dest : Object.values(p.dest)[0];
  const rel = url.startsWith(`${d}/`) ? url.slice(d.length + 1) : url;
  for (const [re, cell] of Object.entries(p.cells || {})) if (new RegExp(re).test(rel)) return cell;
  return p.cell || null;
}

/**
 * FBX packs, served as GLB like every other model here. Each .fbx (after `only`/`skip`) goes through FBX2glTF
 * (the npm fbx2gltf package, staged like the vendor libraries) into .stage/fbx/<pack>/, then:
 *   texture: "<source path>"   put this PNG on every material (for exports whose texture slot names a missing file)
 *   vertexColors: true          white base colour so vertex colours show, solid materials made opaque
 *   doubleSided: true           every material double-sided (thin wings, leaves, feathers)
 *   split: <depth>              one GLB per node at that depth below the scene root, as <dest>/<parent>/<node>.glb
 *                               (depth 3 = root node > group > category > item); otherwise <dest>/<name>.glb
 *   rename: { "<source rel>": "<new rel>" }  fix typos in file names before cleaning
 */
let fbxTool = null;
async function fbx2glb(src, dst) {
  if (upToDate(src, dst)) return;
  if (!fbxTool) {
    fbxTool = process.env.LIB_FBX2GLTF || path.join(await stageNpm('fbx2gltf', '0.9.7-p1'), 'bin', os.type(), os.type() === 'Windows_NT' ? 'FBX2glTF.exe' : 'FBX2glTF');
    if (!fs.existsSync(fbxTool)) throw new Error(`FBX2glTF not found at ${fbxTool} (set LIB_FBX2GLTF)`);
    fs.chmodSync(fbxTool, 0o755);
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  await run(fbxTool, ['--binary', '--pbr-metallic-roughness', '--input', src, '--output', dst.replace(/\.glb$/, '')]);
}
async function planFbx(pack, root, rels) {
  const skips = (pack.skip || []).map((x) => new RegExp(x));
  const texture = pack.texture ? fs.readFileSync(path.join(root, pack.texture)) : null;
  for (const rel of rels) {
    if (!/\.fbx$/i.test(rel) || GLOBAL_SKIP.some((re) => re.test(rel)) || skips.some((re) => re.test('/' + rel))) continue;
    if (pack.only && !pack.only.some((x) => rel.startsWith(x))) continue;
    const src = path.join(root, rel);
    const raw = path.join(STAGE, 'fbx', pack.id, rel.replace(/\.fbx$/i, '.glb'));
    await fbx2glb(src, raw);
    const fix = (g) => {
      if (texture) g = setBaseColorImage(g, texture, path.basename(pack.texture, '.png'));
      if (pack.vertexColors) g = vertexColorsOnly(g);
      if (pack.doubleSided) for (const m of g.json.materials || []) m.doubleSided = true;
      return writeGlb(g);
    };
    const done = path.join(STAGE, 'fbx', pack.id, 'out');
    const emit = (name, make) => {
      const file = path.join(done, name);
      if (!(fs.existsSync(file) && fs.statSync(file).mtimeMs >= stamp)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, make()); }
      add({ src: file, dst: `${pack.dest}/${name}`, pack: pack.id, convert: false, meta: {} });
    };
    // redo the fixes when the raw GLB, the pack's settings or the helpers change
    const stamp = Math.max(...[raw, path.join(HERE, 'packs.json'), path.join(HERE, 'gltf.mjs')].map((f) => fs.statSync(f).mtimeMs));
    const whole = readGlb(fs.readFileSync(raw));
    if (pack.split) {
      const { json } = whole;
      let level = json.scenes[json.scene || 0].nodes.map((i) => ({ i, parent: null }));
      for (let d = 0; d < pack.split; d++) level = level.flatMap(({ i }) => (json.nodes[i].children || []).map((c) => ({ i: c, parent: json.nodes[i].name })));
      for (const { i, parent } of level) emit(cleanPath(`${parent ? parent + '/' : ''}${json.nodes[i].name}.glb`), () => fix(extractNode(whole, i)));
    } else {
      const named = pack.rename?.[rel] || rel;
      emit(cleanName(path.basename(named).replace(/\.fbx$/i, '.glb')), () => fix(whole));
    }
  }
}

const HANDLERS = { fbx: planFbx, 'sfx-folders': planSfxFolders, 'pixel-combat': planPixelCombat, 'pixel-effects': planPixelEffects, maps: planMaps, kenney: planKenney };

// ---------- plan ----------
console.log(`source: ${SRC}\nout:    ${OUT}\njobs:   ${JOBS}  (${HAS_AFCONVERT ? 'afconvert' : 'ffmpeg'})\n`);
for (const pack of packsFile.packs) {
  const from = pack.from;
  let root, rels;
  if (from.zip) { root = await stage(from.zip); rels = walk(root); }
  else if (from.dir) { root = unwrap(findSource(from.dir)); rels = walk(root); }
  else if (from.npm) { root = await stageNpm(from.npm, from.version); rels = walk(root); }
  else if (from.repo) { root = path.join(HERE, from.repo); rels = walk(root); }
  else if (from.files) {
    for (const [srcName, dstName] of Object.entries(from.files)) add({ src: findSource(srcName), dst: `${pack.dest}/${dstName}`, pack: pack.id, convert: false, meta: {} });
    continue;
  } else throw new Error(`pack ${pack.id}: unknown from`);
  await (HANDLERS[pack.handler] || planGeneric)(pack, root, rels);
  for (const extra of from.extra || []) add({ src: findSource(extra), dst: `${from.extraDest || pack.dest}/${cleanName(extra)}`, pack: pack.id, convert: false, meta: {} });
}

if (process.argv.includes('--plan')) {
  const byPack = {};
  for (const it of items) (byPack[it.pack] ||= { files: 0, convert: 0 }).files++, (it.convert && byPack[it.pack].convert++);
  const rows = Object.entries(byPack).sort((a, b) => b[1].files - a[1].files);
  console.log(`planned ${items.length} files across ${rows.length} packs (${generated.length} discovered)\n`);
  for (const [id, s] of rows.slice(0, 30)) console.log(`  ${id.padEnd(34)} ${String(s.files).padStart(6)} files${s.convert ? `  (${s.convert} to convert)` : ''}`);
  if (rows.length > 30) console.log(`  … and ${rows.length - 30} more packs`);
  process.exit(0);
}

// Maps are checked against everything planned above before anything is copied.
{
  let bad = 0;
  for (const it of items.filter((i) => i.validate)) {
    const errors = validateMap(it);
    for (const e of errors) console.error(`  map ${it.dst}: ${e}`);
    bad += errors.length;
  }
  if (bad) { console.error(`${bad} map problems`); process.exit(1); }
}

// ---------- execute ----------
let converted = 0, copied = 0, failed = 0;
const t0 = Date.now();
await pool(items, JOBS, async (it) => {
  const dst = path.join(OUT, it.dst);
  try {
    if (it.convert) { if (await toM4a(it.src, dst)) converted++; }
    else if (copyIfChanged(it.src, dst)) copied++;
  } catch (e) { failed++; console.error(`  FAIL ${it.dst}: ${e.message}`); }
});
console.log(`converted ${converted} wav, copied ${copied} files, ${failed} failed, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (failed) process.exit(1);

// glTF sanity: every relative uri must exist next to the file.
let brokenRefs = 0;
for (const it of items) {
  if (!/\.gltf$/i.test(it.dst)) continue;
  const json = JSON.parse(fs.readFileSync(path.join(OUT, it.dst), 'utf8'));
  for (const ref of [...(json.buffers || []), ...(json.images || [])]) {
    if (!ref.uri || /^data:/.test(ref.uri)) continue;
    if (!fs.existsSync(path.join(OUT, path.dirname(it.dst), decodeURIComponent(ref.uri)))) { brokenRefs++; console.warn(`  glTF ${it.dst} references missing ${ref.uri}`); }
  }
}
if (brokenRefs) console.warn(`${brokenRefs} broken glTF references`);

// ---------- manifest ----------
const files = [];
const packStats = {};
for (const it of items.sort((a, b) => a.dst.localeCompare(b.dst))) {
  const full = path.join(OUT, it.dst);
  const buf = fs.readFileSync(full);
  const entry = { path: it.dst, pack: it.pack, bytes: buf.length, sha1: createHash('sha1').update(buf).digest('hex'), type: mimeOf(it.dst) };
  const img = imageSize(buf);
  if (img) Object.assign(entry, img);
  if (it.convert) { const d = wavDuration(fs.readFileSync(it.src)); if (d != null) entry.duration = d; }
  Object.assign(entry, it.meta);
  if (it.validate) entry.kind = it.meta.kind;
  files.push(entry);
  const s = (packStats[it.pack] ||= { files: 0, bytes: 0 });
  s.files++; s.bytes += buf.length;
}

// ---------- frame metadata: grid cells, animations, per-frame sequences, sound variants ----------
// Each image with a known cell gets `cell`, `cols`, `rows` (and `frames` for a one-row strip), `fps`,
// `animations`, and a sidecar <path>.json carrying the same so aha-assets.js can read it without the
// (gated) manifest. Per-frame packs get <Animation>.json listing the frames; Pixel Combat sounds get
// <stem>.json listing the variants.
const packById = Object.fromEntries([...packsFile.packs, ...generated].map((p) => [p.id, p]));
const relInPack = (e, p) => { const d = typeof p.dest === 'string' ? p.dest : Object.values(p.dest)[0]; return e.path.startsWith(`${d}/`) ? e.path.slice(d.length + 1) : e.path; };
const cellFor = (e, p) => { const rel = relInPack(e, p); for (const [re, cell] of Object.entries(p.cells || {})) if (new RegExp(re).test(rel)) return cell; return p.cell || null; };
const derived = [];
function writeDerived(rel, obj, pack) {
  const text = JSON.stringify(obj);
  fs.mkdirSync(path.dirname(path.join(OUT, rel)), { recursive: true });
  fs.writeFileSync(path.join(OUT, rel), text);
  derived.push({ path: rel, pack, bytes: Buffer.byteLength(text), sha1: createHash('sha1').update(text).digest('hex'), type: 'application/json', kind: 'meta' });
}
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
for (const e of files) {
  const p = packById[e.pack];
  if (!p || !e.type.startsWith('image/')) continue;
  if (!e.cell) {
    const cell = cellFor(e, p);
    if (cell) {
      const grid = fitGrid({ width: e.width, height: e.height }, cell);
      if (grid) Object.assign(e, grid);
      else console.warn(`  ${e.path}: ${e.width}x${e.height} is not a grid of ${cell.join('x')} cells, no cell recorded`);
    }
  }
  if (!e.cell) continue;
  const [gx, gy] = e.gap || [0, 0], [mx, my] = e.margin || [0, 0];
  e.cols = Math.floor((e.width - 2 * mx + gx) / (e.cell[0] + gx));
  e.rows = Math.floor((e.height - 2 * my + gy) / (e.cell[1] + gy));
  if (e.rows === 1 && !e.frames) e.frames = e.cols;
  if (p.fps) e.fps ??= p.fps;
  if (p.animations && e.rows > 1) e.animations = p.animations;
  writeDerived(`${e.path}.json`, pick(e, ['path', 'width', 'height', 'cell', 'gap', 'margin', 'cols', 'rows', 'frames', 'fps', 'animations', 'animation']), e.pack);
  writeDerived(`${e.path}.atlas.json`, atlasFor(e), e.pack);
}

/**
 * A TexturePacker-style "JSON hash" atlas for the sheet, which Phaser (load.atlas) and PixiJS
 * (Assets.load, Spritesheet) read natively. Frames are named r<row>c<col>; `animations` lists the
 * named rows, or the whole strip under its animation name (or "play").
 */
function atlasFor(e) {
  const [w, h] = e.cell;
  const [gx, gy] = e.gap || [0, 0];
  const [mx, my] = e.margin || [0, 0];
  const frames = {};
  const name = (r, c) => `r${r}c${c}`;
  for (let r = 0; r < e.rows; r++) for (let c = 0; c < e.cols; c++) {
    const x = mx + c * (w + gx), y = my + r * (h + gy);
    frames[name(r, c)] = { frame: { x, y, w, h }, rotated: false, trimmed: false, spriteSourceSize: { x: 0, y: 0, w, h }, sourceSize: { w, h } };
  }
  const animations = {};
  if (e.animations) for (const [n, a] of Object.entries(e.animations)) animations[n] = Array.from({ length: a.frames }, (_, i) => name(a.row, (a.col || 0) + i));
  else if (e.rows === 1 && e.frames > 1) animations[e.animation || 'play'] = Array.from({ length: e.frames }, (_, i) => name(0, i));
  return { frames, animations, meta: { app: 'AhaSlides games asset library', version: '1', image: path.basename(e.path), format: 'RGBA8888', size: { w: e.width, h: e.height }, scale: '1', ...(e.fps ? { fps: e.fps } : {}) } };
}
// Packed sheets (Kenney's): the same TexturePacker "JSON hash" file as a grid sheet gets, but with the
// artist's own frame names, plus a .json sidecar so `assets.image` users can see what is in there.
for (const it of items.filter((i) => i.atlas)) {
  const e = files.find((f) => f.path === it.dst);
  const frames = {};
  for (const [name, f] of Object.entries(it.atlas)) {
    frames[name] = { frame: { x: f.x, y: f.y, w: f.w, h: f.h }, rotated: false, trimmed: false, spriteSourceSize: { x: 0, y: 0, w: f.w, h: f.h }, sourceSize: { w: f.w, h: f.h } };
  }
  writeDerived(`${it.dst}.atlas.json`, { frames, animations: {}, meta: { app: 'AhaSlides games asset library', version: '1', image: path.basename(it.dst), format: 'RGBA8888', size: { w: e?.width || 0, h: e?.height || 0 }, scale: '1' } }, it.pack);
  writeDerived(`${it.dst}.json`, { path: it.dst, width: e?.width, height: e?.height, atlas: `${it.dst}.atlas.json`, frames: Object.keys(it.atlas) }, it.pack);
}

for (const p of packsFile.packs.filter((x) => x.sequences)) {
  const groups = {};
  for (const e of files) {
    if (e.pack !== p.id || !e.type.startsWith('image/')) continue;
    const m = /^([^/]+?)_+(\d+)\.png$/.exec(relInPack(e, p));
    if (m) (groups[m[1]] ||= []).push({ n: +m[2], e });
  }
  for (const [name, list] of Object.entries(groups)) {
    list.sort((a, b) => a.n - b.n);
    for (const { e } of list) e.animation = name;
    writeDerived(`${p.dest}/${name}.json`, { animation: name, sequence: list.map((x) => x.e.path), frames: list.length, fps: p.fps || 10, width: list[0].e.width, height: list[0].e.height }, p.id);
  }
}
{
  const groups = {};
  for (const e of files) if (e.type === 'audio/mp4' && e.variant != null) (groups[e.path.replace(/-\d+\.m4a$/, '')] ||= []).push(e);
  for (const [stem, list] of Object.entries(groups)) {
    list.sort((a, b) => a.variant - b.variant);
    writeDerived(`${stem}.json`, { name: list[0].name, category: list[0].category, tags: list[0].tags, variants: list.map((e) => e.path), duration: list[0].duration }, list[0].pack);
  }
}
for (const d of derived) { files.push(d); const s = packStats[d.pack]; s.files++; s.bytes += d.bytes; }
files.sort((a, b) => a.path.localeCompare(b.path));
fs.copyFileSync(path.join(HERE, 'aha-assets.js'), path.join(OUT, 'aha-assets.js'));

// Remove stale output (files neither planned nor derived this run).
const keep = new Set([...items.map((i) => i.dst), ...derived.map((d) => d.path), 'manifest.json', 'packs.json', 'index.html', 'llms.txt', 'aha-assets.js']);
for (const rel of walk(OUT)) if (!keep.has(rel) && !rel.startsWith('manifest/')) { fs.rmSync(path.join(OUT, rel)); console.log(`  removed stale ${rel}`); }

const packs = {};
for (const p of [...packsFile.packs, ...generated]) {
  const { from, skip, only, handler, cells, ...pub } = p;
  if (p.expands && !packStats[p.id]) continue;          // the bundle itself hosts nothing; its packs do
  packs[p.id] = { ...pub, ...(packStats[p.id] || { files: 0, bytes: 0 }) };
}
const manifest = { version: 1, generated: new Date().toISOString(), files: files.length, bytes: files.reduce((a, f) => a + f.bytes, 0), packs, entries: files };
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
fs.writeFileSync(path.join(OUT, 'packs.json'), JSON.stringify({ generated: manifest.generated, packs }, null, 2));

// One manifest per pack as well. The whole manifest is large now that Kenney is in it, and almost
// nobody wants all of it: pick a pack from packs.json, then read that pack's own entries.
{
  const perPack = {};
  for (const e of files) (perPack[e.pack] ||= []).push(e);
  fs.rmSync(path.join(OUT, 'manifest'), { recursive: true, force: true });
  for (const [id, entries] of Object.entries(perPack)) {
    const p = packs[id] || {};
    const body = JSON.stringify({ version: 1, generated: manifest.generated, pack: id, title: p.title, license: p.license, credit: p.credit, url: p.url, files: entries.length, bytes: entries.reduce((a, e) => a + e.bytes, 0), entries }, null, 1);
    fs.mkdirSync(path.join(OUT, 'manifest'), { recursive: true });
    fs.writeFileSync(path.join(OUT, 'manifest', `${id}.json`), body);
  }
  console.log(`manifest/: ${Object.keys(perPack).length} per-pack slices`);
}
fs.copyFileSync(path.join(HERE, 'catalog.html'), path.join(OUT, 'index.html'));

// The guide, served from the CDN itself as llms.txt (the whole of docs/asset-library.md, live base URL baked in,
// a one-paragraph summary on top so an agent that reads only the first lines still knows what is here).
const LIB_URL = (process.env.LIB_URL || 'https://games.ahaslides.io').replace(/\/+$/, '');
const guide = fs.readFileSync(path.join(HERE, '..', 'docs', 'asset-library.md'), 'utf8').replace(/https:\/\/games\.ahaslides\.io/g, LIB_URL);
fs.writeFileSync(path.join(OUT, 'llms.txt'), `# AhaSlides games asset library

> Free game art, sound effects and 3D models (${files.length} files, ${(manifest.bytes / 1048576).toFixed(0)} MB, ${Object.keys(packs).length} packs, Kenney's whole CC0 catalogue among them), all licensed for commercial use, plus three.js, PixiJS and the Rapier physics engine under ${LIB_URL}/vendor/, served for AhaSlides games (CORS for *.ahaslides.com/.io/.ai). Reference these URLs from game code; never inline assets or libraries. Files live at ${LIB_URL}/<path>. Start at ${LIB_URL}/packs.json (every pack with its licence and credit line), then read one pack's files from ${LIB_URL}/manifest/<pack>.json; ${LIB_URL}/manifest.json has all 32,000 entries at once and is only worth fetching to search across packs. Sheets arrive already split: each has <image>.json (cell, gap, rows, animations) and <image>.atlas.json beside it. A browsable catalog is at ${LIB_URL}/. The full guide follows.

${guide.replace(/^# AhaSlides games asset library\n/, "")}`);

console.log(`\nmanifest: ${files.length} files (${derived.length} metadata), ${(manifest.bytes / 1048576).toFixed(1)} MB`);
for (const [id, s] of Object.entries(packStats)) console.log(`  ${id.padEnd(26)} ${String(s.files).padStart(5)} files ${(s.bytes / 1048576).toFixed(1).padStart(7)} MB`);
