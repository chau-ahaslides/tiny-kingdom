import test from 'node:test';
import assert from 'node:assert/strict';
import { extractNode, readGlb, sceneSize, setBaseColorImage, vertexColorsOnly, writeGlb } from '../library/gltf.mjs';

// Two triangles, each its own node and mesh, with RGBA vertex colours (the second one half transparent).
function twoTriangles() {
  const bin = Buffer.alloc(96);
  const tri = (at, x) => [[x, 0, 0], [x + 1, 0, 0], [x, 2, 0]].forEach((v, i) => v.forEach((n, k) => bin.writeFloatLE(n, at + i * 12 + k * 4)));
  tri(0, 0); tri(36, 10);
  const colors = Buffer.alloc(96); for (let i = 0; i < 6; i++) colors.writeFloatLE(i < 3 ? 1 : 0.5, i * 16 + 12);
  const all = Buffer.concat([bin.subarray(0, 72), colors]);
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'root', children: [1, 2] }, { name: 'A', mesh: 0, translation: [0, 5, 0] }, { name: 'B', mesh: 1 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 2 }, material: 0 }] }, { primitives: [{ attributes: { POSITION: 1, COLOR_0: 3 }, material: 1 }] }],
    materials: [{ name: 'red', alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }, { name: 'blue', alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [0, 0, 1, 1] } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 2, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3', min: [10, 0, 0], max: [11, 2, 0] },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' },
      { bufferView: 3, componentType: 5126, count: 3, type: 'VEC4' },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 }, { buffer: 0, byteOffset: 72, byteLength: 48 }, { buffer: 0, byteOffset: 120, byteLength: 48 }],
    buffers: [{ byteLength: all.length }],
  };
  return { json, bin: all };
}

test('GLB round trip keeps JSON and binary, padded to 4 bytes', () => {
  const g = twoTriangles();
  const buf = writeGlb(g);
  assert.equal(buf.length % 4, 0);
  assert.equal(buf.readUInt32LE(8), buf.length);
  const back = readGlb(buf);
  assert.deepEqual(back.json.nodes, g.json.nodes);
  assert.equal(back.bin.readFloatLE(36), 10);
});

test('extractNode keeps one subtree and only the bytes it uses', () => {
  const g = twoTriangles();
  const b = extractNode(g, 2);
  assert.deepEqual(b.json.nodes.map((n) => n.name), ['B']);
  assert.equal(b.json.meshes.length, 1);
  assert.deepEqual(b.json.materials.map((m) => m.name), ['blue']);
  assert.equal(b.json.accessors.length, 2);
  assert.equal(b.bin.readFloatLE(b.json.bufferViews[b.json.accessors[0].bufferView].byteOffset), 10, 'positions of B, not A');
  assert.equal(b.json.buffers[0].byteLength, b.bin.length);
  const reread = readGlb(writeGlb(b));
  assert.deepEqual(sceneSize(reread).map((v) => +v.toFixed(3)), [1, 2, 0]);
  const whole = extractNode(g, 0);
  assert.deepEqual(whole.json.nodes.map((n) => [n.name, n.children]), [['root', [1, 2]], ['A', undefined], ['B', undefined]]);
  assert.deepEqual(sceneSize(whole).map((v) => +v.toFixed(3)), [11, 7, 0], 'node translation counts');
});

test('vertexColorsOnly whitens the factor and makes solid BLEND materials opaque', () => {
  const g = vertexColorsOnly(twoTriangles());
  assert.deepEqual(g.json.materials[0].pbrMetallicRoughness.baseColorFactor, [1, 1, 1, 1]);
  assert.equal(g.json.materials[0].alphaMode, 'OPAQUE', 'every vertex alpha is 1');
  assert.equal(g.json.materials[1].alphaMode, 'BLEND', 'vertex alpha 0.5 stays blended');
});

test('setBaseColorImage embeds one PNG and points every material at it', () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const g = setBaseColorImage(twoTriangles(), png, 'atlas');
  const back = readGlb(writeGlb(g));
  assert.equal(back.json.images.length, 1);
  const view = back.json.bufferViews[back.json.images[0].bufferView];
  assert.equal(view.byteOffset % 4, 0);
  assert.deepEqual(back.bin.subarray(view.byteOffset, view.byteOffset + png.length), png);
  for (const m of back.json.materials) assert.deepEqual(m.pbrMetallicRoughness.baseColorTexture, { index: 0 });
});
