// Pure helpers for the asset-library build (no I/O), so they can be unit-tested.

/** URL-safe lowercase slug: "Bass Hit" -> "bass-hit", "Card and Board" -> "card-and-board". */
export function slug(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Keep a file or directory name recognisable but URL-clean: case is kept,
 * anything outside [A-Za-z0-9._-] becomes "_", runs collapse, and stray "_"
 * next to the extension dot or the ends are dropped.
 * "Run (8).png" -> "Run_8.png"; "mana seed 3-color ramps, rare.png" -> "mana_seed_3-color_ramps_rare.png".
 */
export function cleanName(name) {
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && dot < name.length - 1 && !/[\s]/.test(name.slice(dot));
  const base = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot + 1) : '';
  const clean = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').replace(/_+\./g, '.').replace(/\._+/g, '.');
  const b = clean(base) || 'file';
  return ext ? `${b}.${clean(ext).toLowerCase()}` : b;
}

/** Clean every segment of a relative path. */
export function cleanPath(rel) {
  return rel.split('/').filter(Boolean).map(cleanName).join('/');
}

/**
 * Parse a Pixel Combat file name.
 * "DSGNImpt_EXPLOSION-Bass Hit_HY_PC-001.wav" ->
 * { catId: "DSGNImpt", category: "explosion", name: "Bass Hit", variant: 1 }
 * "DSGNMisc_SKILL IMPACT-Bubbly Zaps_HY_PC-003.wav" -> category "skill-impact"
 */
export function parsePixelCombat(file) {
  const m = /^([A-Za-z]+)_([A-Z ]+)-(.+?)_HY_PC-(\d{3})\.wav$/i.exec(file);
  if (!m) return null;
  return { catId: m[1], category: slug(m[2]), name: m[3].trim(), variant: parseInt(m[4], 10) };
}

/** UCS-ish category id -> readable tags. */
export const PIXEL_COMBAT_CAT = {
  DSGNImpt: ['designed', 'impact'],
  DSGNMisc: ['designed'],
  DSGNSynth: ['designed', 'synth'],
  DSGNTonl: ['designed', 'tonal'],
  FEETMisc: ['footsteps'],
  FGHTImpt: ['fight', 'impact'],
  MAGAngl: ['magic', 'angelic'],
  MAGSpel: ['magic', 'spell'],
  SWSH: ['swoosh'],
  WHSH: ['whoosh'],
  UIClick: ['ui', 'click'],
  UIGlitch: ['ui', 'glitch'],
  UIMisc: ['ui'],
};

/**
 * Decide the destination for a source-relative path given a pack's `dest`
 * (string, or map of source prefix -> dest prefix; longest matching prefix wins).
 */
export function routeDest(dest, rel) {
  if (typeof dest === 'string') return `${dest}/${rel}`;
  let best = null;
  for (const [prefix, target] of Object.entries(dest)) {
    if (rel.startsWith(prefix) && (best === null || prefix.length > best[0].length)) best = [prefix, target];
  }
  if (!best) throw new Error(`no dest route for ${rel}`);
  return `${best[1]}/${rel.slice(best[0].length)}`;
}

/** PNG / GIF dimensions from the first bytes of the file, or null. */
export function imageSize(buf) {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && buf.toString('latin1', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  return null;
}

/** Duration in seconds of a RIFF/WAVE file from its fmt and data chunks, or null. */
export function wavDuration(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  let pos = 12, byteRate = 0, dataBytes = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(pos + 16);
    if (id === 'data') { dataBytes = Math.min(size, buf.length - pos - 8); break; }
    pos += 8 + size + (size & 1);
  }
  if (!byteRate || dataBytes === null) return null;
  return Math.round((dataBytes / byteRate) * 1000) / 1000;
}

/**
 * Parse a Super Pixel Effects spritesheet.txt ("path/frame0000.png = x y w h" per line)
 * into { frames, width, height } (all frames share one size in this pack).
 */
export function parseEffectSheet(text) {
  const rects = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /=\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) rects.push({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] });
  }
  if (!rects.length) return null;
  return { frames: rects.length, width: rects[0].w, height: rects[0].h };
}

export const MIME = {
  m4a: 'audio/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
  png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml',
  gltf: 'model/gltf+json', glb: 'model/gltf-binary', bin: 'application/octet-stream',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  json: 'application/json', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8', tmx: 'application/xml', tsx: 'application/xml',
};

export function mimeOf(path) {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}
