// Binary glTF (GLB) helpers for the build: read and write a GLB, cut one subtree out as its own GLB, put a
// texture on every material, and scale the scene. Only what the FBX-converted packs need; no dependencies.

const GLB_MAGIC = 0x46546c67, JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;
const pad4 = (n) => (n + 3) & ~3;

/** Parse a GLB buffer into { json, bin } (bin is null when the file has no binary chunk). */
export function readGlb(buf) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a GLB');
  const jsonLen = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== JSON_CHUNK) throw new Error('GLB: first chunk is not JSON');
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  let bin = null;
  const at = 20 + jsonLen;
  if (buf.length >= at + 8 && buf.readUInt32LE(at + 4) === BIN_CHUNK) bin = buf.subarray(at + 8, at + 8 + buf.readUInt32LE(at));
  return { json, bin };
}

/** Serialise { json, bin } as a GLB buffer, padding both chunks to 4 bytes as the spec asks. */
export function writeGlb({ json, bin }) {
  if (bin && json.buffers?.length) json.buffers[0].byteLength = bin.length;
  const text = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonChunk = Buffer.alloc(pad4(text.length), 0x20); text.copy(jsonChunk);
  const binChunk = bin ? Buffer.alloc(pad4(bin.length)) : null; if (bin) bin.copy(binChunk);
  const total = 12 + 8 + jsonChunk.length + (binChunk ? 8 + binChunk.length : 0);
  const head = Buffer.alloc(12); head.writeUInt32LE(GLB_MAGIC, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  const chunk = (type, body) => { const h = Buffer.alloc(8); h.writeUInt32LE(body.length, 0); h.writeUInt32LE(type, 4); return [h, body]; };
  return Buffer.concat([head, ...chunk(JSON_CHUNK, jsonChunk), ...(binChunk ? chunk(BIN_CHUNK, binChunk) : [])]);
}

/**
 * A new GLB holding just node `root` and everything under it: its meshes, materials, textures, images,
 * samplers, accessors and the bytes they use, re-indexed and packed into one buffer. Skins and
 * animations are not carried (the split packs have none; throws if the subtree uses a skin).
 */
export function extractNode({ json, bin }, root) {
  const nodes = [], nodeMap = new Map();
  (function visit(i) { nodeMap.set(i, nodes.length); nodes.push(i); for (const c of json.nodes[i].children || []) visit(c); })(root);
  const maps = { meshes: new Map(), materials: new Map(), accessors: new Map(), bufferViews: new Map(), textures: new Map(), images: new Map(), samplers: new Map() };
  const out = { asset: { ...json.asset, generator: `${json.asset?.generator || 'glTF'} + AhaSlides library split` }, scene: 0, scenes: [{ nodes: [0] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [], textures: [], images: [], samplers: [] };
  const chunks = []; let offset = 0;
  const take = (kind, i, build) => {
    if (i == null) return undefined;
    if (!maps[kind].has(i)) { maps[kind].set(i, out[kind].length); out[kind].push(null); out[kind][maps[kind].get(i)] = build(json[kind][i]); }
    return maps[kind].get(i);
  };
  const view = (i) => take('bufferViews', i, (bv) => {
    const bytes = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    const start = pad4(offset); if (start > offset) chunks.push(Buffer.alloc(start - offset));
    chunks.push(bytes); offset = start + bytes.length;
    const { buffer, byteOffset, ...rest } = bv;
    return { ...rest, buffer: 0, byteOffset: start };
  });
  const accessor = (i) => take('accessors', i, (a) => {
    const copy = { ...a, bufferView: view(a.bufferView) };
    if (a.sparse) copy.sparse = { ...a.sparse, indices: { ...a.sparse.indices, bufferView: view(a.sparse.indices.bufferView) }, values: { ...a.sparse.values, bufferView: view(a.sparse.values.bufferView) } };
    return copy;
  });
  const texture = (t) => t && { ...t, index: take('textures', t.index, (tx) => ({ ...tx, source: take('images', tx.source, (im) => (im.bufferView != null ? { ...im, bufferView: view(im.bufferView) } : { ...im })), sampler: take('samplers', tx.sampler, (s) => ({ ...s })) })) };
  const material = (i) => take('materials', i, (m) => {
    const copy = JSON.parse(JSON.stringify(m));
    for (const k of ['normalTexture', 'occlusionTexture', 'emissiveTexture']) if (m[k]) copy[k] = texture(m[k]);
    if (m.pbrMetallicRoughness) for (const k of ['baseColorTexture', 'metallicRoughnessTexture']) if (m.pbrMetallicRoughness[k]) copy.pbrMetallicRoughness[k] = texture(m.pbrMetallicRoughness[k]);
    return copy;
  });
  for (const i of nodes) {
    const n = json.nodes[i];
    if (n.skin != null) throw new Error(`extractNode: node ${n.name || i} uses a skin`);
    const copy = { ...n };
    if (n.children) copy.children = n.children.map((c) => nodeMap.get(c));
    if (n.mesh != null) copy.mesh = take('meshes', n.mesh, (m) => ({ ...m, primitives: m.primitives.map((p) => ({
      ...p,
      attributes: Object.fromEntries(Object.entries(p.attributes).map(([k, v]) => [k, accessor(v)])),
      ...(p.indices != null ? { indices: accessor(p.indices) } : {}),
      ...(p.material != null ? { material: material(p.material) } : {}),
      ...(p.targets ? { targets: p.targets.map((t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, accessor(v)]))) } : {}),
    })) }));
    out.nodes.push(copy);
  }
  const outBin = Buffer.concat([...chunks, Buffer.alloc(pad4(offset) - offset)]);
  out.buffers.push({ byteLength: outBin.length });
  for (const k of ['meshes', 'materials', 'accessors', 'bufferViews', 'textures', 'images', 'samplers']) if (!out[k].length) delete out[k];
  if (json.extensionsUsed) out.extensionsUsed = json.extensionsUsed;
  if (json.extensionsRequired) out.extensionsRequired = json.extensionsRequired;
  return { json: out, bin: outBin };
}

/**
 * Point every material's base colour at one PNG, embedded in the GLB. For exports whose texture slot names a
 * file that is not there (FBX2glTF then writes a 1x1 placeholder). Placeholder images are dropped.
 */
export function setBaseColorImage({ json, bin }, png, name = 'baseColor') {
  const start = pad4(bin ? bin.length : 0);
  const newBin = Buffer.concat([bin || Buffer.alloc(0), Buffer.alloc(start - (bin ? bin.length : 0)), png]);
  json.bufferViews = json.bufferViews || [];
  json.bufferViews.push({ buffer: 0, byteOffset: start, byteLength: png.length });
  json.images = [{ name, mimeType: 'image/png', bufferView: json.bufferViews.length - 1 }];
  json.samplers = json.samplers?.length ? json.samplers : [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
  json.textures = [{ source: 0, sampler: 0 }];
  if (!json.buffers?.length) json.buffers = [{ byteLength: 0 }];
  for (const m of json.materials || []) {
    m.pbrMetallicRoughness = { ...(m.pbrMetallicRoughness || {}), baseColorTexture: { index: 0 } };
    delete m.pbrMetallicRoughness.baseColorFactor;
    for (const k of ['normalTexture', 'occlusionTexture', 'emissiveTexture']) delete m[k];
    delete m.pbrMetallicRoughness.metallicRoughnessTexture;
  }
  return { json, bin: newBin };
}

/** Wrap the default scene's roots in one node scaled by `s` (e.g. 0.01 for centimetre exports). */
export function scaleScene({ json, bin }, s) {
  const scene = json.scenes[json.scene || 0];
  json.nodes.push({ name: 'scale', scale: [s, s, s], children: scene.nodes });
  scene.nodes = [json.nodes.length - 1];
  return { json, bin };
}

/** Axis-aligned size of the default scene's meshes, ignoring skins (from accessor min/max and node transforms). */
export function sceneSize({ json }) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const mul = (a, b) => { const o = new Array(16).fill(0); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
  const local = (n) => {
    if (n.matrix) return n.matrix;
    const [x, y, z, w] = n.rotation || [0, 0, 0, 1], [sx, sy, sz] = n.scale || [1, 1, 1], [tx, ty, tz] = n.translation || [0, 0, 0];
    return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0, 2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0, 2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const visit = (i, parent) => {
    const n = json.nodes[i], m = mul(parent, local(n));
    if (n.mesh != null) for (const p of json.meshes[n.mesh].primitives) {
      const a = json.accessors[p.attributes.POSITION]; if (!a?.min) continue;
      for (let c = 0; c < 8; c++) {
        const v = [c & 1 ? a.max[0] : a.min[0], c & 2 ? a.max[1] : a.min[1], c & 4 ? a.max[2] : a.min[2]];
        for (let k = 0; k < 3; k++) { const w = m[k] * v[0] + m[4 + k] * v[1] + m[8 + k] * v[2] + m[12 + k]; min[k] = Math.min(min[k], w); max[k] = Math.max(max[k], w); }
      }
    }
    for (const c of n.children || []) visit(c, m);
  };
  for (const r of json.scenes[json.scene || 0].nodes) visit(r, I);
  return max.map((v, k) => (Number.isFinite(v) ? v - min[k] : 0));
}

/**
 * For models coloured by vertex colour: set the base colour factor of every material used by a primitive with
 * COLOR_0 to white (keeping its alpha), since glTF multiplies the two and some exporters leave editor colours
 * there; and make a BLEND material OPAQUE when no vertex that uses it is actually transparent, so it sorts and
 * shadows like a solid.
 */
export function vertexColorsOnly({ json, bin }) {
  const minAlpha = (a) => {
    if (a.type !== 'VEC4') return 1;
    const bv = json.bufferViews[a.bufferView], size = { 5126: 4, 5121: 1, 5123: 2 }[a.componentType], max = { 5126: 1, 5121: 255, 5123: 65535 }[a.componentType];
    const stride = bv.byteStride || size * 4, base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    let min = 1;
    for (let i = 0; i < a.count; i++) {
      const at = base + i * stride + size * 3;
      const v = a.componentType === 5126 ? bin.readFloatLE(at) : a.componentType === 5121 ? bin[at] / max : bin.readUInt16LE(at) / max;
      if (v < min) min = v;
    }
    return min;
  };
  const mats = new Map();
  for (const m of json.meshes || []) for (const p of m.primitives) {
    if (p.material == null) continue;
    const s = mats.get(p.material) || { colored: false, solid: true };
    if (p.attributes.COLOR_0 != null) { s.colored = true; if (minAlpha(json.accessors[p.attributes.COLOR_0]) < 0.999) s.solid = false; } else s.solid = false;
    mats.set(p.material, s);
  }
  for (const [i, s] of mats) {
    if (!s.colored) continue;
    const mat = json.materials[i], pbr = (mat.pbrMetallicRoughness ||= {});
    pbr.baseColorFactor = [1, 1, 1, pbr.baseColorFactor?.[3] ?? 1];
    if (mat.alphaMode === 'BLEND' && s.solid && pbr.baseColorFactor[3] >= 0.999) mat.alphaMode = 'OPAQUE';
  }
  return { json, bin };
}
