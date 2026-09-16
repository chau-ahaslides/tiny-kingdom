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
import { cleanName, cleanPath, imageSize, mimeOf, parseEffectSheet, parsePixelCombat, PIXEL_COMBAT_CAT, routeDest, slug, wavDuration } from './lib.mjs';

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
    await run('unzip', ['-qo', path.join(SRC, 'Game Assets', zipName), '-d', dir]);
  }
  return unwrap(dir);
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
const HAS_FFMPEG = which('ffmpeg');
if (!HAS_AFCONVERT && !HAS_FFMPEG) { console.error('need afconvert (macOS) or ffmpeg on PATH to convert .wav'); process.exit(1); }

async function toM4a(src, dst) {
  if (upToDate(src, dst)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.tmp.m4a`;
  if (HAS_AFCONVERT) await run('afconvert', ['-f', 'm4af', '-d', 'aac@44100', '-b', '128000', '-q', '127', '-s', '3', src, tmp]);
  else await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-ar', '44100', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp]);
  fs.renameSync(tmp, dst);
  return true;
}

// ---------- per-file work items ----------
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
    const target = cleanPath(isWav ? rel.replace(/\.wav$/i, '.m4a') : rel);
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

const HANDLERS = { 'sfx-folders': planSfxFolders, 'pixel-combat': planPixelCombat, 'pixel-effects': planPixelEffects };

// ---------- plan ----------
console.log(`source: ${SRC}\nout:    ${OUT}\njobs:   ${JOBS}  (${HAS_AFCONVERT ? 'afconvert' : 'ffmpeg'})\n`);
for (const pack of packsFile.packs) {
  const from = pack.from;
  let root, rels;
  if (from.zip) { root = await stage(from.zip); rels = walk(root); }
  else if (from.dir) { root = unwrap(findSource(from.dir)); rels = walk(root); }
  else if (from.files) {
    for (const [srcName, dstName] of Object.entries(from.files)) add({ src: findSource(srcName), dst: `${pack.dest}/${dstName}`, pack: pack.id, convert: false, meta: {} });
    continue;
  } else throw new Error(`pack ${pack.id}: unknown from`);
  (HANDLERS[pack.handler] || planGeneric)(pack, root, rels);
  for (const extra of from.extra || []) add({ src: findSource(extra), dst: `${from.extraDest || pack.dest}/${cleanName(extra)}`, pack: pack.id, convert: false, meta: {} });
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
  files.push(entry);
  const s = (packStats[it.pack] ||= { files: 0, bytes: 0 });
  s.files++; s.bytes += buf.length;
}

// ---------- frame metadata: grid cells, animations, per-frame sequences, sound variants ----------
// Each image with a known cell gets `cell`, `cols`, `rows` (and `frames` for a one-row strip), `fps`,
// `animations`, and a sidecar <path>.json carrying the same so aha-assets.js can read it without the
// (gated) manifest. Per-frame packs get <Animation>.json listing the frames; Pixel Combat sounds get
// <stem>.json listing the variants.
const packById = Object.fromEntries(packsFile.packs.map((p) => [p.id, p]));
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
      if (e.width % cell[0] === 0 && e.height % cell[1] === 0) e.cell = cell;
      else console.warn(`  ${e.path}: ${e.width}x${e.height} is not a grid of ${cell.join('x')} cells, no cell recorded`);
    }
  }
  if (!e.cell) continue;
  e.cols = e.width / e.cell[0];
  e.rows = e.height / e.cell[1];
  if (e.rows === 1 && !e.frames) e.frames = e.cols;
  if (p.fps) e.fps ??= p.fps;
  if (p.animations && e.rows > 1) e.animations = p.animations;
  writeDerived(`${e.path}.json`, pick(e, ['path', 'width', 'height', 'cell', 'cols', 'rows', 'frames', 'fps', 'animations', 'animation']), e.pack);
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
for (const rel of walk(OUT)) if (!keep.has(rel)) { fs.rmSync(path.join(OUT, rel)); console.log(`  removed stale ${rel}`); }

const packs = {};
for (const p of packsFile.packs) {
  const { from, skip, only, handler, cells, ...pub } = p;
  packs[p.id] = { ...pub, ...(packStats[p.id] || { files: 0, bytes: 0 }) };
}
const manifest = { version: 1, generated: new Date().toISOString(), files: files.length, bytes: files.reduce((a, f) => a + f.bytes, 0), packs, entries: files };
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
fs.writeFileSync(path.join(OUT, 'packs.json'), JSON.stringify({ generated: manifest.generated, packs }, null, 2));
fs.copyFileSync(path.join(HERE, 'catalog.html'), path.join(OUT, 'index.html'));

// The guide, served from the CDN itself as llms.txt (the whole of docs/asset-library.md, live base URL baked in,
// a one-paragraph summary on top so an agent that reads only the first lines still knows what is here).
const LIB_URL = (process.env.LIB_URL || 'https://tiny-kingdom-lib.ahaslides-game.workers.dev').replace(/\/+$/, '');
const guide = fs.readFileSync(path.join(HERE, '..', 'docs', 'asset-library.md'), 'utf8').replace(/https:\/\/tiny-kingdom-lib\.[^\s`]+/g, LIB_URL);
fs.writeFileSync(path.join(OUT, 'llms.txt'), `# AhaSlides games asset library

> Free game art, sound effects and 3D models (${files.length} files, ${(manifest.bytes / 1048576).toFixed(0)} MB, ${Object.keys(packs).length} packs), all licensed for commercial use, served with open CORS for AhaSlides games. Files live at ${LIB_URL}/<path>; exact paths and metadata are in ${LIB_URL}/manifest.json, pack licences and credits in ${LIB_URL}/packs.json, a browsable catalog at ${LIB_URL}/. The full guide follows.

${guide.replace(/^# AhaSlides games asset library\n/, "")}`);

console.log(`\nmanifest: ${files.length} files (${derived.length} metadata), ${(manifest.bytes / 1048576).toFixed(1)} MB`);
for (const [id, s] of Object.entries(packStats)) console.log(`  ${id.padEnd(26)} ${String(s.files).padStart(5)} files ${(s.bytes / 1048576).toFixed(1).padStart(7)} MB`);
