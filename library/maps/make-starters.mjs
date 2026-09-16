#!/usr/bin/env node
// Writes the starter maps (one per tileset pack) as JSON next to this file. Run it after editing:
//   node library/maps/make-starters.mjs
// The JSON is what ships; this script only keeps the hand-placed layouts readable and regenerable.
// Cell references are the packs' own legend style: "7b" = row 7, column b (see the .txt legends).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const write = (rel, obj) => { const f = path.join(HERE, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj, null, 1) + '\n'); console.log('wrote', rel); };
const grid = (w, h, v = '.') => Array.from({ length: h }, () => Array(w).fill(v));
const rows = (g) => g.map((r) => r.join(' '));
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

// ---------------------------------------------------------------- 32rogues: a crypt
{
  const W = 26, H = 18;
  const floor = grid(W, H, '.');   // '.' = not carved (wall)
  const carve = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) floor[y][x] = pick(['7b', '7b', '7b', '7c', '7d']); };
  carve(2, 2, 9, 7);      // A: entry hall
  carve(9, 4, 15, 5);     // corridor A -> B
  carve(15, 2, 23, 8);    // B: chapel
  carve(4, 7, 5, 10);     // corridor A -> C
  carve(3, 10, 11, 15);   // C: cistern
  carve(19, 8, 20, 11);   // corridor B -> D
  carve(14, 11, 23, 15);  // D: crypt
  carve(11, 13, 14, 13);  // corridor C -> D
  const isFloor = (x, y) => y >= 0 && y < H && x >= 0 && x < W && floor[y][x] !== '.';
  const walls = grid(W, H, '.');
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (isFloor(x, y)) continue;
    const near = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]].some(([dx, dy]) => isFloor(x + dx, y + dy));
    if (near) walls[y][x] = isFloor(x, y + 1) ? '3b' : '3a';
  }
  const props = grid(W, H, '.');
  const put = (g, x, y, v) => { g[y][x] = v; };
  put(props, 3, 3, '17i');                       // stairs up (spawn)
  put(props, 22, 14, '17h');                     // stairs down (exit)
  put(props, 9, 4, '17c'); put(props, 9, 5, '17c'); // doors A -> corridor
  put(props, 19, 8, '17e');                      // door B -> D
  put(props, 19, 4, '17o');                      // pentagram
  put(props, 16, 3, '24a'); put(props, 16, 7, '24d'); put(props, 22, 3, '24b'); put(props, 22, 7, '24f');
  put(props, 10, 14, '18a');                     // chest
  put(props, 3, 15, '18e'); put(props, 4, 15, '18e'); put(props, 3, 14, '18c');
  put(props, 15, 15, '18g'); put(props, 23, 12, '18f');
  put(props, 7, 6, '22a'); put(props, 17, 13, '22b'); put(props, 20, 13, '23a'); put(props, 6, 11, '23c');
  put(props, 8, 2, '21a'); put(props, 11, 10, '21b'); put(props, 21, 2, '19a');
  const water = grid(W, H, '.');
  for (let y = 12; y <= 13; y++) for (let x = 5; x <= 8; x++) { water[y][x] = '11a'; props[y][x] = '.'; }
  const fire = grid(W, H, '.');
  for (const [x, y] of [[4, 1], [8, 1], [17, 1], [21, 1], [12, 3], [2, 12], [10, 9], [15, 10], [23, 10]]) fire[y][x] = '6a';  // wall torches
  fire[6][19] = '2a';                             // brazier before the altar (x 19, y 6)
  fire[13][18] = '4a';                            // fire pit in the crypt
  write('32rogues/crypt.json', {
    name: 'Crypt', basedOn: '32rogues', description: 'A four-room dungeon: entry hall with the stairs up, a chapel with a pentagram and coffins, a cistern with a pool and a chest, and the crypt with the stairs down. Torches, braziers and water animate.',
    tilesets: { tiles: 'sprites/32rogues/tiles.png', anim: 'sprites/32rogues/animated-tiles.png' },
    size: [W, H], background: '#0e0c12',
    layers: [
      { name: 'floor', tileset: 'tiles', rows: rows(floor) },
      { name: 'walls', tileset: 'tiles', solid: true, rows: rows(walls) },
      { name: 'water', tileset: 'anim', animate: { frames: 8, fps: 5 }, rows: rows(water) },
      { name: 'props', tileset: 'tiles', rows: rows(props) },
      { name: 'fire', tileset: 'anim', animate: { frames: 6, fps: 9 }, rows: rows(fire) },
    ],
    objects: [
      { type: 'spawn', x: 3, y: 4, sprite: 'sprites/32rogues/rogues.png', frame: '2b' },
      { type: 'exit', x: 22, y: 14 },
      { type: 'chest', x: 10, y: 14, loot: 'gold' },
      { type: 'enemy', kind: 'goblin', x: 7, y: 3, sprite: 'sprites/32rogues/monsters.png', frame: '1c' },
      { type: 'enemy', kind: 'goblin archer', x: 12, y: 5, sprite: 'sprites/32rogues/monsters.png', frame: '1f' },
      { type: 'enemy', kind: 'skeleton', x: 18, y: 6, sprite: 'sprites/32rogues/monsters.png', frame: '5a' },
      { type: 'enemy', kind: 'skeleton archer', x: 21, y: 5, sprite: 'sprites/32rogues/monsters.png', frame: '5b' },
      { type: 'enemy', kind: 'giant rat', x: 8, y: 11, sprite: 'sprites/32rogues/monsters.png', frame: '7l' },
      { type: 'enemy', kind: 'lich', x: 19, y: 12, sprite: 'sprites/32rogues/monsters.png', frame: '5c' },
    ],
  });
}

// ---------------------------------------------------------------- Brackeys: a meadow level
{
  const W = 48, H = 14;
  const ground = grid(W, H, '.');
  const top = (x) => (x >= 6 && x <= 9 ? 11 : x >= 26 && x <= 30 ? 10 : 12);   // ground height with two rises
  const gap = (x) => (x >= 18 && x <= 20) || (x >= 38 && x <= 40);              // pits
  for (let x = 0; x < W; x++) { if (gap(x)) continue; const t = top(x); ground[t][x] = '1a'; for (let y = t + 1; y < H; y++) ground[y][x] = '2a'; }
  const plat = grid(W, H, '.');
  const shelf = (x, y, row) => { plat[y][x] = `${row}a`; plat[y][x + 1] = `${row}b`; plat[y][x + 2] = `${row}c`; };
  shelf(12, 8, 1); shelf(19, 8, 3); shelf(23, 6, 3); shelf(33, 9, 2); shelf(39, 7, 4); shelf(44, 8, 1);
  const deco = grid(W, H, '.');
  deco[11][3] = '5b'; deco[11][15] = '6b'; deco[9][31] = '5b'; deco[11][43] = '6b';
  deco[11][22] = '6h'; deco[11][36] = '7h'; deco[11][42] = '8h';       // mushrooms
  deco[11][14] = '4g'; deco[10][14] = '4g';                            // crates
  deco[11][35] = '4h';                                                 // signpost
  deco[11][1] = '4i'; deco[11][2] = '4i';                              // fence
  deco[9][8] = '3a'; deco[9][9] = '3b';                                // ? and ! blocks over the rise
  write('brackeys-platformer/meadow.json', {
    name: 'Meadow', basedOn: 'brackeys-platformer', description: 'A 48-tile platformer level: two rises, two pits, floating platforms in the four colours, trees, mushrooms and crates; coins, fruit and slimes as objects.',
    tilesets: { world: 'sprites/brackeys-platformer/world_tileset.png', plat: 'sprites/brackeys-platformer/platforms.png' },
    size: [W, H], background: '#8fd3f4',
    layers: [
      { name: 'ground', tileset: 'world', solid: true, rows: rows(ground) },
      { name: 'platforms', tileset: 'plat', solid: true, rows: rows(plat) },
      { name: 'deco', tileset: 'world', rows: rows(deco) },
    ],
    stamps: [
      { layer: 'deco', at: [4, 9], from: '4a', size: [1, 3] },       // tree
      { layer: 'deco', at: [11, 9], from: '4f', size: [1, 3] },      // orange tree
      { layer: 'deco', at: [28, 6], from: '6c', size: [3, 4] },      // palm on the rise
      { layer: 'deco', at: [45, 9], from: '4g', size: [1, 3] },
    ],
    objects: [
      { type: 'spawn', x: 1, y: 11, sprite: 'sprites/brackeys-platformer/knight.png', frame: '1a', scale: 1 },
      ...[7, 8, 13, 14, 20, 24, 25, 29, 34, 40, 41, 45].map((x, i) => ({ type: 'coin', x, y: x < 26 ? (x >= 12 && x <= 14 ? 7 : x >= 19 && x <= 25 ? 5 : 9) : 6, sprite: 'sprites/brackeys-platformer/coin.png', anim: 'play', phase: i * 90 })),
      { type: 'fruit', kind: 'apple', x: 24, y: 5, sprite: 'sprites/brackeys-platformer/fruit.png', frame: '1a' },
      { type: 'fruit', kind: 'banana', x: 45, y: 7, sprite: 'sprites/brackeys-platformer/fruit.png', frame: '1b' },
      { type: 'enemy', kind: 'slime', x: 16, y: 11, patrol: [15, 17], sprite: 'sprites/brackeys-platformer/slime_green.png', frame: '1a', scale: 1 },
      { type: 'enemy', kind: 'slime', x: 32, y: 11, patrol: [31, 37], sprite: 'sprites/brackeys-platformer/slime_purple.png', frame: '1a', scale: 1 },
      { type: 'goal', x: 46, y: 11 },
    ],
  });
}

// ---------------------------------------------------------------- GandalfHardcore: a city street
{
  const W = 48, H = 12;
  const ground = grid(W, H, '.');
  for (let x = 0; x < W; x++) { ground[10][x] = '4a'; ground[11][x] = '4c'; }
  const deco = grid(W, H, '.');
  deco[9][11] = '1a'; deco[9][12] = '1b'; deco[9][30] = '1c'; deco[9][31] = '1d'; deco[9][42] = '1e';
  deco[9][18] = '2a'; deco[8][18] = '3a';   // a sign over a sign
  write('gandalf-city-tiles/street.json', {
    name: 'Street', basedOn: 'gandalf-city-tiles', description: 'A side-scrolling city block: sky and two parallax skyline layers, six building facades (offices, arches, brick, a shop), sidewalk and road, with bins, bags, a lamp post and signs.',
    tilesets: { buildings: 'sprites/gandalf-city-tiles/Building_Tiles_32x32.png', city: 'sprites/gandalf-city-tiles/GandalfHardcore_city_tiles_32x32.png', deco: 'sprites/gandalf-city-tiles/Decoration_32x32.png' },
    size: [W, H], background: '#7fb2e5',
    images: [
      { src: 'sprites/gandalf-city-tiles/City_background_sky.png', parallax: [0, 0], repeat: 'x', y: 0 },
      { src: 'sprites/gandalf-city-tiles/City_background_layer2.png', parallax: [0.2, 0], repeat: 'x', y: 0 },
      { src: 'sprites/gandalf-city-tiles/City_background_layer1.png', parallax: [0.45, 0], repeat: 'x', y: 0 },
    ],
    layers: [
      { name: 'buildings', tileset: 'buildings', rows: [] },
      { name: 'ground', tileset: 'city', solid: true, rows: rows(ground) },
      { name: 'deco', tileset: 'deco', rows: rows(deco) },
    ],
    stamps: [
      { layer: 'buildings', at: [1, 6], from: '1a', size: [9, 4] },     // blue glass office with a door
      { layer: 'buildings', at: [10, 6], from: '1j', size: [6, 4] },    // arched windows
      { layer: 'buildings', at: [16, 8], from: '1p', size: [3, 2] },    // low brick
      { layer: 'buildings', at: [19, 6], from: '5a', size: [9, 4] },    // red block
      { layer: 'buildings', at: [28, 6], from: '1s', size: [4, 4] },    // dark windows
      { layer: 'buildings', at: [32, 6], from: '9a', size: [9, 4] },    // the shop
      { layer: 'buildings', at: [41, 6], from: '1j', size: [6, 4] },
      { layer: 'deco', at: [24, 7], from: '2e', size: [2, 3] },         // lamp post
      { layer: 'deco', at: [4, 7], from: '1g', size: [2, 2] },          // traffic light
    ],
    objects: [
      { type: 'spawn', x: 2, y: 9, sprite: 'sprites/gandalf-warrior/GandalfHardcore_Warrior.png', frame: '1a', scale: 1 },
      { type: 'shop', x: 36, y: 9 },
      { type: 'enemy', kind: 'thug', x: 20, y: 9, patrol: [19, 27] },
      { type: 'goal', x: 46, y: 9 },
    ],
  });
}

// ---------------------------------------------------------------- Mana Seed: a winter clearing
{
  const W = 26, H = 18;
  const ground = grid(W, H, '2a');
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (rnd() < 0.18) ground[y][x] = pick(['3a', '4a', '5a', '6a']);
  const detail = grid(W, H, '.');
  for (const [x, y] of [[1, 8], [6, 2], [9, 15], [20, 15], [24, 6]]) detail[y][x] = pick(['7a', '7b', '7c', '7d', '8a', '8b']);   // stones
  for (const [x, y] of [[2, 13], [11, 3], [22, 12], [7, 16]]) detail[y][x] = pick(['9a', '9b', '10a', '10b']);                 // dead grass
  write('mana-seed-forest-winter/clearing.json', {
    name: 'Winter clearing', basedOn: 'mana-seed-forest-winter', description: 'A top-down snow clearing: a bare tree, a cave mouth in a cliff, a frozen pond with rocks, two thawed dirt patches, stones and dead grass.',
    tilesets: { winter: 'sprites/mana-seed-forest-winter/seasonal_sample_winter.png' },
    size: [W, H], background: '#dfe6ee',
    layers: [
      { name: 'ground', tileset: 'winter', rows: rows(ground) },
      { name: 'detail', tileset: 'winter', rows: rows(detail) },
      { name: 'features', tileset: 'winter', rows: [] },
    ],
    stamps: [
      { layer: 'features', at: [3, 2], from: '1b', size: [3, 3] },      // dirt patch
      { layer: 'features', at: [14, 12], from: '4b', size: [3, 3] },    // dirt patch with a hole
      { layer: 'features', at: [18, 0], from: '1l', size: [5, 7] },     // bare tree
      { layer: 'features', at: [20, 9], from: '8l', size: [5, 5] },     // cave in the cliff
      { layer: 'features', at: [4, 10], from: '12f', size: [6, 5] },    // frozen pond with rocks
      { layer: 'features', at: [10, 4], from: '11c', size: [3, 3] },    // a low stone wall
    ],
    solid: ['features'],
    objects: [
      { type: 'spawn', x: 12, y: 9, sprite: 'sprites/fantasy-dreamland/16x16/Char_001.png', anim: 'down' },
      { type: 'npc', kind: 'villager', x: 2, y: 6, sprite: 'sprites/fantasy-dreamland/16x16/Char_003.png', anim: 'right' },
      { type: 'cave', x: 22, y: 12 },
      { type: 'enemy', kind: 'mushroom', x: 16, y: 6 },
    ],
  });
}

// ---------------------------------------------------------------- Xilurus: an isometric hamlet
{
  const W = 9, H = 9;
  const ground = grid(W, H, '7a');
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (rnd() < 0.3) ground[y][x] = pick(['7a', '7e', '8f', '10d', '10h']);
  for (let i = 0; i < W; i++) { ground[4][i] = '10i'; ground[i][4] = '10i'; }   // a dirt crossroads
  const S2 = 'sprites/iso-village/Isometric_Assets_2.png', S3 = 'sprites/iso-village/Isometric_Assets_3.png', S4 = 'sprites/iso-village/Isometric_Assets_4.png';
  write('iso-village/hamlet.json', {
    name: 'Hamlet', basedOn: 'iso-village', description: 'An isometric village square: a dirt crossroads on grass slabs, three cottages, a well, trees, a cart, crates, pots and a lamp. Props are objects with a sheet region, drawn back to front.',
    tilesets: { ground: 'sprites/iso-village/Isometric_Assets_1.png' },
    size: [W, H], iso: true, isoHeight: 128, background: '#1f2430',
    layers: [{ name: 'ground', tileset: 'ground', rows: rows(ground) }],
    objects: [
      { type: 'house', x: 1, y: 1, sprite: S3, region: [1, 1, 4, 4], anchor: [0.5, 0.78] },
      { type: 'house', x: 6, y: 1, sprite: S3, region: [6, 1, 4, 5], anchor: [0.5, 0.82] },
      { type: 'house', x: 1, y: 6, sprite: S3, region: [1, 5, 4, 4], anchor: [0.5, 0.78] },
      { type: 'well', x: 5, y: 5, sprite: S3, region: [6, 6, 2, 2], anchor: [0.5, 0.7] },
      { type: 'tree', x: 7, y: 7, sprite: S2, region: [1, 7, 3, 4], anchor: [0.5, 0.86] },
      { type: 'tree', x: 8, y: 3, sprite: S2, region: [5, 7, 3, 4], anchor: [0.5, 0.86] },
      { type: 'cart', x: 3, y: 5, sprite: S4, region: [1, 1, 2, 2], anchor: [0.5, 0.7] },
      { type: 'crate', x: 6, y: 6, sprite: S2, region: [5, 2, 1, 1], anchor: [0.5, 0.5] },
      { type: 'barrel', x: 7, y: 6, sprite: S2, region: [6, 2, 1, 1], anchor: [0.5, 0.5] },
      { type: 'pot', x: 3, y: 3, sprite: S2, region: [1, 2, 1, 1], anchor: [0.5, 0.5] },
      { type: 'rock', x: 0, y: 8, sprite: S2, region: [1, 1, 1, 1], anchor: [0.5, 0.5] },
      { type: 'bush', x: 8, y: 0, sprite: S2, region: [8, 2, 1, 1], anchor: [0.5, 0.5] },
      { type: 'lamp', x: 5, y: 3, sprite: S2, region: [10, 6, 1, 2], anchor: [0.5, 0.75] },
      { type: 'sign', x: 3, y: 4, sprite: S2, region: [5, 4, 1, 1], anchor: [0.5, 0.5] },
      { type: 'spawn', x: 4, y: 8 },
    ],
  });
}

// ---------------------------------------------------------------- KayKit: a forest glade (3D)
{
  const placements = [];
  const trees = ['Tree_1_A_Color1', 'Tree_1_B_Color1', 'Tree_1_C_Color1', 'Tree_2_A_Color1', 'Tree_2_B_Color1', 'Tree_2_C_Color1', 'Tree_2_D_Color1', 'Tree_3_A_Color1', 'Tree_3_B_Color1', 'Tree_4_A_Color1', 'Tree_4_B_Color1'];
  const bushes = ['Bush_1_A_Color1', 'Bush_1_C_Color1', 'Bush_2_A_Color1', 'Bush_2_C_Color1', 'Bush_3_A_Color1', 'Bush_4_B_Color1'];
  const rocks = ['Rock_1_A_Color1', 'Rock_1_D_Color1', 'Rock_2_A_Color1', 'Rock_2_C_Color1', 'Rock_3_B_Color1'];
  const grass = ['Grass_1_A_Color1', 'Grass_1_B_Color1', 'Grass_2_A_Color1', 'Grass_2_C_Color1'];
  const R = 17;
  for (let i = 0; i < 26; i++) {                       // a ring of trees around the clearing
    const a = (i / 26) * Math.PI * 2 + rnd() * 0.15, r = R + rnd() * 3;
    placements.push({ model: pick(trees), at: [+(Math.cos(a) * r).toFixed(2), 0, +(Math.sin(a) * r).toFixed(2)], rotate: Math.round(rnd() * 360), scale: +(0.9 + rnd() * 0.4).toFixed(2) });
  }
  for (let i = 0; i < 14; i++) { const a = rnd() * Math.PI * 2, r = 5 + rnd() * 5; placements.push({ model: pick(bushes), at: [+(Math.cos(a) * r).toFixed(2), 0, +(Math.sin(a) * r).toFixed(2)], rotate: Math.round(rnd() * 360) }); }
  for (let i = 0; i < 8; i++) { const a = rnd() * Math.PI * 2, r = 2 + rnd() * 8; placements.push({ model: pick(rocks), at: [+(Math.cos(a) * r).toFixed(2), 0, +(Math.sin(a) * r).toFixed(2)], rotate: Math.round(rnd() * 360) }); }
  for (let i = 0; i < 30; i++) { const a = rnd() * Math.PI * 2, r = rnd() * 10; placements.push({ model: pick(grass), at: [+(Math.cos(a) * r).toFixed(2), 0, +(Math.sin(a) * r).toFixed(2)], rotate: Math.round(rnd() * 360) }); }
  write('kaykit-forest/glade.json', {
    name: 'Glade', kind: 'scene', basedOn: 'kaykit-forest', description: 'A 3D forest clearing: a ring of 26 trees around open ground, with bushes, rocks and grass tufts; a green ground plane 56 units square. Build it with assets.scene(url).build({ THREE, GLTFLoader }).',
    models: 'models/kaykit-forest/Assets/gltf/', ground: { size: [56, 56], color: "#4f8a3d" },
    camera: { position: [0, 34, 30], lookAt: [0, 0, -2] },
    objects: [{ type: 'spawn', at: [0, 0, 4] }],
    placements,
  });
}
