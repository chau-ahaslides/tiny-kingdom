import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanName, cleanPath, imageSize, parseEffectSheet, parsePixelCombat, routeDest, slug, wavDuration, mimeOf } from '../library/lib.mjs';

test('slug', () => {
  assert.equal(slug('Bass Hit'), 'bass-hit');
  assert.equal(slug('Card and Board'), 'card-and-board');
  assert.equal(slug('SKILL IMPACT'), 'skill-impact');
  assert.equal(slug('  Sci-fi! '), 'sci-fi');
});

test('cleanName keeps case, strips spaces and punctuation', () => {
  assert.equal(cleanName('Run (8).png'), 'Run_8.png');
  assert.equal(cleanName('mana seed 3-color ramps, rare.png'), 'mana_seed_3-color_ramps_rare.png');
  assert.equal(cleanName('$Char_004_Idle.png'), 'Char_004_Idle.png');
  assert.equal(cleanName('Attack__000.PNG'), 'Attack_000.png');
  assert.equal(cleanName('LICENSE & CREDITS.txt'), 'LICENSE_CREDITS.txt');
  assert.equal(cleanName('4-color + 3-color base ramps (00d).png'), '4-color_3-color_base_ramps_00d.png');
  assert.equal(cleanName('LICENSE'), 'LICENSE');
  assert.equal(cleanPath('Free Sprites/Zombies/zombie sprite/zombie1NPC.png'), 'Free_Sprites/Zombies/zombie_sprite/zombie1NPC.png');
});

test('parsePixelCombat', () => {
  assert.deepEqual(parsePixelCombat('DSGNImpt_EXPLOSION-Bass Hit_HY_PC-001.wav'), { catId: 'DSGNImpt', category: 'explosion', name: 'Bass Hit', variant: 1 });
  assert.deepEqual(parsePixelCombat('DSGNMisc_SKILL IMPACT-Bubbly Zaps_HY_PC-006.wav'), { catId: 'DSGNMisc', category: 'skill-impact', name: 'Bubbly Zaps', variant: 6 });
  assert.deepEqual(parsePixelCombat('DSGNTonl_SKILL IMPACT-Retro Laser 1_HY_PC-003.wav'), { catId: 'DSGNTonl', category: 'skill-impact', name: 'Retro Laser 1', variant: 3 });
  assert.equal(parsePixelCombat('separated.rpp'), null);
  assert.equal(parsePixelCombat('DSGNImpt_EXPLOSION-Bass Hit_HY_PC.wav'), null, 'the compiled files have no variant number');
});

test('routeDest', () => {
  assert.equal(routeDest('sprites/x', 'a/b.png'), 'sprites/x/a/b.png');
  const map = { '': 'sprites/p', 'sounds/': 'sfx/p', 'music/': 'music/p' };
  assert.equal(routeDest(map, 'sprites/knight.png'), 'sprites/p/sprites/knight.png');
  assert.equal(routeDest(map, 'sounds/jump.m4a'), 'sfx/p/jump.m4a');
  assert.equal(routeDest(map, 'music/t.mp3'), 'music/p/t.mp3');
});

test('imageSize reads PNG and GIF headers', () => {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(384, 16); png.writeUInt32BE(416, 20);
  assert.deepEqual(imageSize(png), { width: 384, height: 416 });
  const gif = Buffer.alloc(10); gif.write('GIF89a'); gif.writeUInt16LE(64, 6); gif.writeUInt16LE(32, 8);
  assert.deepEqual(imageSize(gif), { width: 64, height: 32 });
  assert.equal(imageSize(Buffer.from('hello')), null);
});

test('wavDuration from fmt byte rate and data size', () => {
  const data = 44100 * 2 * 2 * 2; // 2 s of 16-bit stereo 44.1 kHz
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + data, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(44100, 24); buf.writeUInt32LE(44100 * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(data, 40);
  assert.equal(wavDuration(buf), 2);
  assert.equal(wavDuration(Buffer.from('nope')), null);
});

test('parseEffectSheet', () => {
  const txt = 'PNG/x/frame0000.png = 0 0 64 64\nPNG/x/frame0001.png = 64 0 64 64\n\nPNG/x/frame0002.png = 128 0 64 64\n';
  assert.deepEqual(parseEffectSheet(txt), { frames: 3, width: 64, height: 64 });
  assert.equal(parseEffectSheet(''), null);
});

test('mimeOf', () => {
  assert.equal(mimeOf('sfx/a/b.m4a'), 'audio/mp4');
  assert.equal(mimeOf('x.GLB'), 'model/gltf-binary');
  assert.equal(mimeOf('x.unknown'), 'application/octet-stream');
});
