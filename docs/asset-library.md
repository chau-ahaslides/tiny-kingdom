# AhaSlides games asset library

A public CDN of game art, sound and 3D models for AhaSlides games, built from free packs
downloaded from itch.io (and a few from GameArt2D and OpenGameArt). Everything is served from one
host; pages on AhaSlides origins can load it directly (CORS is limited to those).

```
LIB = https://games.ahaslides.io
```

| Where to look | What you get |
|---|---|
| `LIB/<path>` | Any file: open to everyone, so games load them from any origin. |
| `LIB/llms.txt` | This guide, served from the CDN. Start here. **Gated.** |
| `LIB/manifest.json` | Every file (3,650 assets, 1,298 metadata) with `path`, `pack`, `bytes`, `sha1`, `type`, and per type: `width`/`height`, `cell`/`cols`/`rows`/`frames`/`fps`/`animations`, `duration`, `category`, `variant`, `tags`. **Gated.** |
| `LIB/packs.json` | The 25 packs: title, author, page URL, licence, `commercial` (`yes`, or `credit` when attribution is required), the `credit` line to ship, description, notes. **Gated.** |
| `LIB/catalog` | The catalog: every pack, its licence, thumbnails, play buttons, the starter maps, a filter box. Sign in with an AhaSlides account (Cloudflare Access). |
| `LIB/` | The same catalog for agents and scripts: open it once as `LIB/?key=<token>`. |
| `LIB/vendor/…` | three.js and PixiJS, pinned by version (see "Libraries on the CDN"). |
| `LIB/maps/<pack>/…` | A starter map per tileset pack, in the library's map format (see "Maps"). |
| `library/packs.json` in this repo | The same pack index, plus the build rules. Edit this to add or change a pack. |

**Reference, never inline.** Game code points at these URLs. Do not copy assets into a game's
folder, embed them as data URIs, or bundle three.js/PixiJS into the page; the CDN caches them for
a day at the edge and in the browser, and a pinned version path never changes.

**Gated** means the request needs one of two credentials. Agents and scripts send the library read
token, as a header `Authorization: Bearer <token>` or as `?key=<token>`; it is
`TINY_KINGDOM_LIB_READ_TOKEN` in `~/.env` on the AhaSlides machines. People sign in with their
AhaSlides account at `LIB/catalog`, which sits behind Cloudflare Access; the session cookie it sets
then opens `llms.txt`, `manifest.json` and `packs.json` in that browser too. Without either, those URLs
answer 401; every asset file still answers. The gate is deliberate: most packs forbid redistribution as
an asset pack, so the host must be an asset server for our games rather than a browsable library.

Ask the manifest, not the file system: it is 1.3 MB of JSON, so fetch it once and filter.

```js
const KEY = process.env.TINY_KINGDOM_LIB_READ_TOKEN;           // or whatever holds it where you run
const m = await (await fetch(`${LIB}/manifest.json`, { headers: { authorization: `Bearer ${KEY}` } })).json();
const explosions = m.entries.filter(e => e.pack === 'pixel-combat' && e.category === 'explosion');
const strips     = m.entries.filter(e => e.pack === 'pixel-effects' && e.category === 'impacts');
```

## Fastest path: aha-assets.js

`LIB/aha-assets.js` is a dependency-free ES module (open, like the assets) that does the loading,
decoding, sheet splitting and frame timing, so a game needs none of that code:

```js
import { assets } from 'https://games.ahaslides.io/aha-assets.js';

// Sounds: a Pixel Combat name loads all its variants; play() picks one at random.
const hit  = await assets.sound('sfx/pixel-combat/explosion/bass-hit');
const coin = await assets.sound('sfx/brackeys-platformer/coin');        // a single file works too
button.onclick = () => { assets.unlock(); hit.play({ gain: 0.8 }); };    // unlock() inside a gesture, for iOS

// A sheet with one animation per row: the sheet knows its cells, rows and frame counts.
const guy = await assets.sheet('sprites/gandalf-characters/Character_skin_colors/Male_Skin1.png');
const hair = await assets.sheet('sprites/gandalf-characters/Male_Hair/Male_Hair1.png');
function frame(now) {
  guy.draw(ctx, 'walk', now, x, y, { scale: 3, flip: facingLeft });     // layers share rows, so
  hair.draw(ctx, 'walk', now, x, y, { scale: 3, flip: facingLeft });    // draw them in the same call order
  requestAnimationFrame(frame);
}

// A strip (frames left to right), played once: draw() returns true when it has finished.
const boom = await assets.sheet('sprites/pixel-effects/explosions/epic_explosion_001_small_orange.png');
const done = boom.draw(ctx, null, now - startedAt, x, y, { loop: false });

// A 4x4 top-down character: rows are facings.
const hero = await assets.sheet('sprites/fantasy-dreamland/16x16/Char_001.png');
hero.draw(ctx, 'left', now, x, y, { scale: 4 });

// One PNG per frame (the GameArt2D packs): the animation name loads every frame.
const run = await assets.sequence('sprites/adventure-girl/Run');
run.draw(ctx, now, x, y, { scale: 0.25 });

// Any cell by hand, e.g. the 32rogues monster at row 5 column 2 (the .txt legend counts from 1).
const mobs = await assets.sheet('sprites/32rogues/monsters.png');
mobs.drawFrame(ctx, 1, 4, x, y, { scale: 2 });

// Warm everything before the first frame.
await assets.preload(['sfx/pixel-combat/hit/bit-kick', 'sprites/32rogues/tiles.png', 'sprites/ninja-girl/Jump']);
```

The module reads a small JSON that sits next to each asset: `<image>.json` (cell size, columns,
rows, frame count, fps, named animations), `<image>.atlas.json` (the same as a TexturePacker atlas,
for Phaser and PixiJS, see below), `<Animation>.json` for per-frame packs (the ordered frame list),
and `<sound>.json` for Pixel Combat (the variant list). Those files are open, so the
runtime never needs the token; the same fields are in the manifest for authoring. Where the library
has no cell for an image (single pictures, previews, the large RPG Maker battler sheets), pass one:
`assets.sheet(path, { cell: [150, 150] })`, or an ad-hoc animation:
`sheet.draw(ctx, { row: 2, frames: 6 }, t, x, y)`. Playback rates default to the pack's `fps`;
override per call with `{ fps: 12 }`. Pixel art is drawn unsmoothed unless `{ smooth: true }`.

## Maps and other game data

A map is content that belongs to one game, so it is a data file the game loads, never a layout
typed into code. The library provides the loader, the format, and a starter map per tileset pack;
each game keeps its own maps in its own folder (`public/maps/<game>/<level>.json`), not on the CDN.

**Start from a starter map.** Every tileset pack has one under `maps/<pack>/`, drawn live on the
catalog page:

| map | tiles | what |
|---|---|---|
| `maps/32rogues/crypt.json` | 32rogues | four dungeon rooms, doors, animated torches and water, chest, stairs, enemies as objects |
| `maps/brackeys-platformer/meadow.json` | Brackeys | a side-scrolling level: rises, pits, floating platforms, coins, fruit, slimes |
| `maps/gandalf-city-tiles/street.json` | GandalfHardcore city | parallax skyline, six facades, sidewalk and road, props |
| `maps/mana-seed-forest-winter/clearing.json` | Mana Seed winter | top-down snow clearing with a tree, a cave, a frozen pond |
| `maps/iso-village/hamlet.json` | Xilurus isometric | isometric square with cottages, a well, trees, a cart (props as objects) |
| `maps/kaykit-forest/glade.json` | KayKit forest (3D) | a scene file: 78 glTF placements around a clearing |

The three steps for a new game: copy the closest starter into the game's folder, edit the data
(rows, stamps, objects), and load it. The code stays generic.

```js
const map = await assets.map('maps/32rogues/crypt.json');      // or the game's own file
map.width, map.height, map.cell                                 // 26, 18, [32, 32]
map.solid(x, y)                                                 // true on a wall or outside the map
map.tile('props', x, y)                                         // cell index, 0 = empty
map.find('enemy')                                               // objects by type; map.objects has them all
const spawn = map.find('spawn')[0];
function frame(now) {
  map.draw(ctx, { camera: [camX, camY], scale: 2, t: now });   // layers, animated tiles, props
}
```

**The format** (`GameMap` reads this or Tiled JSON, see below):

```jsonc
{
  "name": "Crypt",
  "tilesets": { "tiles": "sprites/32rogues/tiles.png", "anim": "sprites/32rogues/animated-tiles.png" },
  "size": [26, 18],                       // tiles; cell size comes from each tileset's sidecar
  "background": "#0e0c12",                // for the page to fill behind the map
  "legend": { "#": "3a", ".": "7b" },     // optional: one character per cell in string rows
  "layers": [
    { "name": "floor", "tileset": "tiles", "fill": "7b", "rows": ["7b 7c 7b …", "…"] },
    { "name": "walls", "tileset": "tiles", "solid": true, "rows": "###..##\n#.....#" },
    { "name": "fire", "tileset": "anim", "animate": { "frames": 6, "fps": 9 }, "rows": [] }
  ],
  "stamps": [ { "layer": "props", "at": [3, 2], "from": "26d", "size": [1, 2] } ],   // copy a block of cells
  "images": [ { "src": "sprites/…/sky.png", "parallax": [0.2, 0], "repeat": "x" } ], // behind the layers
  "objects": [
    { "type": "spawn", "x": 3, "y": 4 },
    { "type": "enemy", "kind": "goblin", "x": 7, "y": 3, "sprite": "sprites/32rogues/monsters.png", "frame": "1c" },
    { "type": "coin", "x": 8, "y": 9, "sprite": "sprites/brackeys-platformer/coin.png", "anim": "play" },
    { "type": "house", "x": 1, "y": 1, "sprite": "sprites/iso-village/Isometric_Assets_3.png", "region": [1, 1, 4, 4], "anchor": [0.5, 0.78] }
  ],
  "iso": false                            // true for isometric (with "isoHeight": diamond height, default half the cell)
}
```

Cells are written the way the packs' `.txt` legends count: `"7b"` is row 7, column b (1-based);
`"7.2"` is the same; a plain number is a 1-based row-major index (Tiled's convention); `"."`, `0`
or `""` is empty and `"~"` keeps the layer's `fill`. A row is a space-separated string, an array, or
(with a `legend`) one character per cell. `stamps` copy a rectangle of sheet cells into a layer, which
is how multi-tile things (a tree, a building facade, a cave mouth) go in. `animate` steps a layer's
cells along their row (the 32rogues torches are six frames per row). Objects are the game's data,
whatever fields it likes; those with a `sprite` (plus `frame`, `anim`, or a `region` of cells) are
drawn as props, sorted by depth, with `anchor` [ax, ay] against the tile's base. The build refuses a
map whose tilesets, cells or sprites do not exist.

Tiled (`.tmj`) files load too, with embedded tilesets whose image paths resolve relative to the map
file, tile layers (a `solid` custom property marks collision), object groups, and isometric
orientation. External `.tsx` tilesets are not supported: embed them.

**3D scenes** work the same way with glTF: a JSON list of placements, built into a `THREE.Group`.

```js
const scene = await assets.scene('maps/kaykit-forest/glade.json');
world.add(await scene.build({ THREE, GLTFLoader }));             // one load per model, cloned per placement
// { "models": "models/kaykit-forest/Assets/gltf/", "ground": { "size": [32, 32], "color": "#4f8a3d" },
//   "placements": [ { "model": "Tree_1_A_Color1", "at": [3, 0, -8], "rotate": 120, "scale": 1.1 }, … ] }
```

Enemy tables, wave scripts, dialogue: same rule. Data file per game, loaded by URL.

## Rooms: the multiplayer backend

Live rooms (a host on the big screen, phones joining by QR) are a separate service at
`https://play.ahaslides.io`, not part of this CDN:

```
https://play.ahaslides.io/js/aha-room.js     the room SDK (host(), join(), replicated state, presence)
https://play.ahaslides.io/sdk                its guide: messages, state document, worked examples
POST https://play.ahaslides.io/api/room      mints a room code and join URL (CORS for AhaSlides origins and sandboxed iframes)
https://play.ahaslides.io/j/<CODE>           the join link phones open; /ws/<CODE> the socket
```

A game page served from `play.ahaslides.io` calls `AhaRoom.host()` and `AhaRoom.join()` with no
configuration. A page on another origin passes the relay explicitly:
`AhaRoom.host({ transport: new AhaRoom.RelayTransport({ origin: 'https://play.ahaslides.io' }) })`.
The join link always opens the game's page on `play.ahaslides.io`, so a multiplayer game's page
belongs on that host; this library only supplies its art, sound, maps and libraries.

## Libraries on the CDN: three.js and PixiJS

The two engines the games use are hosted here too, pinned by version, so a game page references
them from this host and never bundles, copies or inlines them (the same rule as for assets: link the
URL, never paste bytes or base64 into game code):

```
vendor/three/0.186.0/build/three.module.js         three.js core (ES module; three.core.js is imported by it)
vendor/three/0.186.0/build/three.webgpu.js         the WebGPU renderer build, if wanted
vendor/three/0.186.0/examples/jsm/…                every addon: loaders/GLTFLoader.js, controls/OrbitControls.js, …
vendor/pixi/8.20.1/pixi.min.mjs                    PixiJS 8 as an ES module (pixi.mjs unminified; pixi.min.js / pixi.js for a <script> tag)
```

three.js addons import the bare specifier `three`, so the page declares an import map once:

```html
<script type="importmap">
{ "imports": {
    "three": "https://games.ahaslides.io/vendor/three/0.186.0/build/three.module.js",
    "three/addons/": "https://games.ahaslides.io/vendor/three/0.186.0/examples/jsm/"
} }
</script>
<script type="module">
  import * as THREE from 'three';
  import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
  const LIB = 'https://games.ahaslides.io';
  // models load straight from the CDN; textures and buffers resolve next to the .gltf
  new GLTFLoader().load(`${LIB}/models/kaykit-adventurers/Characters/gltf/Knight.glb`, (g) => scene.add(g.scene));
</script>
```

```html
<script type="module">
  import * as PIXI from 'https://games.ahaslides.io/vendor/pixi/8.20.1/pixi.min.mjs';
  const LIB = 'https://games.ahaslides.io';
  const app = new PIXI.Application(); await app.init({ width: 640, height: 360 }); document.body.append(app.canvas);
  const sheet = await PIXI.Assets.load(`${LIB}/sprites/gandalf-characters/Character_skin_colors/Male_Skin1.png.atlas.json`);
  const guy = new PIXI.AnimatedSprite(sheet.animations.walk);
  guy.animationSpeed = 10 / 60; guy.play(); app.stage.addChild(guy);
</script>
```

Both are MIT-licensed. To add a version, add a pack with `"from": { "npm": "three", "version": "…" }`
to `library/packs.json` and rebuild; old versions stay so existing games keep working.

## Other engines

`aha-assets.js` draws with the 2D canvas and Web Audio, which is what the tiny-kingdom games use.
Every sheet with a known grid also has `<image>.atlas.json`, a TexturePacker-style JSON hash
(frames named `r<row>c<col>`, plus `animations`), and every Pixel Combat sound has `<sound>.json`
listing its variants, so engines load the library with their own loaders (PixiJS and three.js
above):

```js
// Phaser 3
this.load.atlas('guy', `${LIB}/sprites/gandalf-characters/Character_skin_colors/Male_Skin1.png`,
                       `${LIB}/sprites/gandalf-characters/Character_skin_colors/Male_Skin1.png.atlas.json`);
this.load.audio('hit', [`${LIB}/sfx/pixel-combat/explosion/bass-hit-01.m4a`]);
// later, in create():
this.anims.create({ key: 'walk', frames: this.anims.generateFrameNames('guy', { prefix: 'r1c', start: 0, end: 7 }), frameRate: 10, repeat: -1 });
this.add.sprite(x, y, 'guy').play('walk');
// or, without the atlas, straight from the numbers in <image>.json:
this.load.spritesheet('boom', `${LIB}/sprites/pixel-effects/explosions/epic_explosion_001_small_orange.png`, { frameWidth: 64, frameHeight: 64 });
```

Godot, Unity and other native engines are not web-facing: download the files (a pack's paths are in
the manifest) and use the cell sizes from `<image>.json`. Whatever the engine, the page has to be on
an AhaSlides origin (`*.ahaslides.com`, `*.ahaslides.io`, `*.ahaslides.ai`, `*.ahaslides-game.workers.dev`, or localhost while
developing): cross-origin loading is allowed for those origins only.

## URL scheme

```
sfx/<pack>/<category>/<name>[-<variant>].m4a    sounds: AAC-LC 128 kbps 44.1 kHz in .m4a (plays everywhere)
music/<pack>/<track>.mp3                        the one music track
sprites/<pack>/<original path, cleaned>         PNG / GIF sheets and frames
models/<pack>/…/<name>.gltf|.glb (+ .bin, textures beside them)
fonts/<pack>/<name>.ttf
```

Names are the pack's own names with spaces and punctuation turned into `_` (`Run (8).png` becomes
`Run_8.png`); folders that are categories are lower-case slugs (`Card and Board` becomes
`card-and-board`). The manifest's `path` is always the exact key, so copy from there.

Responses carry an `ETag`, `Accept-Ranges: bytes`, and `Cache-Control: public, max-age=86400`.
`Access-Control-Allow-Origin` is set only for AhaSlides origins (`https://*.ahaslides.com` / `.io` / `.ai`,
`https://*.ahaslides-game.workers.dev`, `http://localhost:*`) and for the `null` origin that a
sandboxed iframe reports (the artifact viewer runs games that way): from those, `fetch`, Web Audio,
canvas readback and `import` of `aha-assets.js` all work; from anywhere else only plain `<img>` and
`<audio>` tags do. A file at a given path is only ever replaced when a pack is rebuilt; append
`?v=<sha1 prefix>` from the manifest if you need an immutable URL.

## Sounds

Two libraries cover most needs. Every sound is a short one-shot; decode once with Web Audio and
play from the buffer (an `<audio>` element per hit is too slow for games).

**pixel-combat** (`sfx/pixel-combat/`) is Helton Yan's retro JRPG combat set: 350 sounds, each in
six variations (`-01` … `-06`), in 12 categories:

| category | sounds | for |
|---|---|---|
| `explosion` | 41 | bombs, bursts, mecha detonations |
| `hit` | 33 | landing a blow, laser hits, fleeting hits |
| `melee` | 16 | punches, kicks, swings |
| `projectile` | 15 | shots leaving |
| `skill-impact` / `skill-release` | 35 / 27 | spell hits and casts, lasers, sparkles |
| `cast` | 45 | magic spell casts (MAGSpel), synth casts |
| `buff` | 37 | power-ups, angelic chords |
| `movement` | 49 | whooshes, swooshes, jumps, dashes |
| `step` | 16 | footsteps |
| `interface` | 11 | clicks, selects, confirms |
| `usable` | 25 | pickups, potions, coins, glitches |

Each entry has `name` ("Bass Hit"), `variant`, `tags` (`designed`, `magic`, `ui`, `whoosh` …),
`ucs` (the original UCS category id) and `original` (the WAV file name), so you can find a sound by
its store name. Two names exist twice in a category under different UCS ids; those carry the id in
the slug (`interface/zap-select-uimisc-01.m4a` and `interface/zap-select-dsgnmisc-01.m4a`).

**400-sounds** (`sfx/400-sounds/`) is Chequered Ink's everyday set, one file per sound, in
`card-and-board`, `combat-and-gore`, `environment`, `footsteps`, `human`, `items`, `machines`,
`match-three`, `materials`, `musical-effects`, `other`, `retro`, `ui`, `weapons`. Good for doors,
clocks, wind, cards, coins, notifications.

**brackeys-platformer** (`sfx/brackeys-platformer/`) has six classic platformer blips (jump, coin,
hurt, tap, power_up, explosion) and `music/brackeys-platformer/time_for_adventure.mp3`.

```js
// A tiny sound bank: load a few names, play a random variant.
const ctx = new AudioContext();
const bank = {};
async function load(name, urls) {
  bank[name] = await Promise.all(urls.map(async u => ctx.decodeAudioData(await (await fetch(u)).arrayBuffer())));
}
function play(name, gain = 1) {
  const bufs = bank[name]; if (!bufs) return;
  const src = ctx.createBufferSource(); src.buffer = bufs[Math.random() * bufs.length | 0];
  const g = ctx.createGain(); g.gain.value = gain; src.connect(g).connect(ctx.destination); src.start();
}
const m = await (await fetch(`${LIB}/manifest.json`)).json();
const variants = n => m.entries.filter(e => e.pack === 'pixel-combat' && e.name === n).map(e => `${LIB}/${e.path}`);
await load('hit', variants('Bass Hit'));
await load('coin', [`${LIB}/sfx/brackeys-platformer/coin.m4a`]);
```

Remember iOS: create or resume the `AudioContext` inside a user gesture.

## Sprites

| pack | path | what | cell / frame size | licence |
|---|---|---|---|---|
| `32rogues` | `sprites/32rogues/` | 32x32 roguelike: rogues, monsters, animals, items, tiles, autotiles, animated tiles; a `.txt` legend per sheet (row.column) | 32x32 grid | commercial OK, no redistribution |
| `pixel-effects` | `sprites/pixel-effects/<category>/` | 192 VFX strips (explosions, fantasy-spells, impacts, lightning, magic-bursts, sci-fi, smoke-bursts, splatters, symbols), 15 fps | per strip: `cell`, `frames` | **credit unTied Games** |
| `brackeys-platformer` | `sprites/brackeys-platformer/` | 16x16 knight (32x32 frames), slimes, coin, fruit, platforms, world tileset | 16 / 32 | CC0 |
| `fantasy-dreamland` | `sprites/fantasy-dreamland/<16x16|32x32|48x48>/` | six top-down characters, 4-direction walk + idle, plus RPG Maker sheets | folder name | **credit ELV Games** |
| `female-adventurer` | `sprites/female-adventurer/<Idle|Walk|Jump|Dash|Death>/` | 8-direction top-down adventurer, one sheet per facing per animation, matching shadow sheets | see `frame_dimensions.png` at the pack root | commercial OK |
| `hd-knight` | `sprites/hd-knight/<Animation>.png` | HD (non-pixel) 8-direction knight, 29 animations with shadows | 128x128 cells, 15 columns x 8 direction rows on 1920x1024 | commercial OK |
| `gandalf-characters` | `sprites/gandalf-characters/` | 80x64 side-scroller male/female base + paper-doll layers (skin, hair, clothes, hand items) | 80x64 | commercial OK |
| `gandalf-warrior`, `gandalf-effects`, `gandalf-city-tiles` | `sprites/gandalf-*/` | matching warrior sheet, 25 effect strips, 32x32 modern-city tiles + parallax | 80x64 / 32x32 | commercial OK |
| `kobold-warrior` | `sprites/kobold-warrior/` | 48x64 side-view kobold, 7 strips | 48x64 | commercial OK |
| `forest-monsters` | `sprites/forest-monsters/Mushroom/` | 80x64 mushroom enemy, 7 strips, with/without hit VFX | 80x64 | commercial OK |
| `free-foes` | `sprites/free-foes/` | 16 cartoon side-view enemies sized for RPG Maker MV (about 2700 px wide sheets), zombies, German shepherd | large | **credit Robert Pinero** |
| `card-rpg-monsters` | `sprites/card-rpg-monsters/` | 31 single monster portraits for cards | single images | commercial OK |
| `autobattlers-crew` | `sprites/autobattlers-crew/` | cute auto-battler roster sheet (+2x outlined), UI sheet | sheet | commercial OK |
| `iso-village` | `sprites/iso-village/` | 150+ isometric tiles on four sheets | 256x256 | **credit Xilurus (CC BY 4.0)** |
| `mana-seed-farmer` | `sprites/mana-seed-farmer/` | paper-doll farmer sample: walk + jump, guides, colour ramps | 64x64 cells | commercial OK (sample) |
| `mana-seed-forest-winter` | `sprites/mana-seed-forest-winter/` | three 16x16 winter forest tile sheets | 16x16 | commercial OK (sample) |
| `adventure-girl`, `ninja-girl` | `sprites/adventure-girl/<Anim>_<n>.png`, `sprites/ninja-girl/<Anim>_<nnn>.png` | cartoon side-scroller heroines as per-frame PNGs (about 640x540, 376x520); `<Anim>.json` lists each animation's frames | per frame | CC0 |
| `dragons` | `sprites/dragons/dragons.png` | eleven pixel dragons on one 428x377 sheet | irregular | **credit Redshrike et al. (CC BY 3.0)** |

Manifest entries for images carry `width`, `height` and, where the grid is known, `cell` `[w, h]`,
`cols`, `rows`, `frames` (one-row strips), `fps` and `animations` (`{ name: { row, frames } }`).
Without `aha-assets.js`, a strip animates by stepping a source rectangle across the sheet:

```js
const e = m.entries.find(x => x.path === 'sprites/pixel-effects/impacts/directional_impact_001_small_blue.png');
const img = new Image(); img.src = `${LIB}/${e.path}`;
let t0;
function draw(ctx2d, x, y, now) {
  t0 ??= now;
  const f = Math.floor((now - t0) / 1000 * e.fps) % e.frames;
  const [w, h] = e.cell;
  ctx2d.drawImage(img, f * w, 0, w, h, x, y, w, h);
}
```

Set `imageSmoothingEnabled = false` (or CSS `image-rendering: pixelated`) when scaling pixel art.

## Models

Two CC0 KayKit packs in glTF only (FBX and OBJ were dropped):

- `models/kaykit-adventurers/Characters/gltf/{Barbarian,Knight,Mage,Ranger,Rogue}.glb`, rigged and
  textured; animations in `Animations/gltf/Rig_Medium/Rig_Medium_General.glb`; weapons and props in
  `Assets/gltf/*.gltf` (+ `.bin`); preview renders in `Samples/`.
- `models/kaykit-forest/Assets/gltf/*.gltf` (105 trees, bushes, rocks, grass, flowers) sharing
  `forest_texture.png` in the same folder.

Load with three.js `GLTFLoader` straight from the URL; relative texture and buffer references
resolve on the CDN.

## Licences and credits

Every pack's page terms are in `packs.json` (`license`, `commercial`, `credit`). Everything in the
library may be used in commercial games: packs whose free tier is personal-use only (ToffeeCraft's
trees and environment sheet, LimeZu's Fantasy Battlers trial) and files whose origin could not be
identified (a monster spritesheet zip, a weapon-icon sheet, Elthen's destructible objects) were
downloaded but are deliberately not hosted. Keep it that way: a pack goes in only when its page
says commercial use is allowed.

**Credit required** for the packs marked `commercial: "credit"`. Ship this block (or the relevant
lines) in the game's credits screen or page:

```
Sound effects: Pixel Combat SFX by Helton Yan (heltonyan.itch.io), CC BY 4.0
Effects: Super Pixel Effects Gigapack by unTied Games (untiedgames.itch.io)
Characters by ELV Games (elvgames.itch.io)
Enemy sprites by Robert Pinero (robertpinero.itch.io)
Isometric village tiles by Xilurus (xilurus.itch.io), CC BY 4.0
Dragons by Stephen 'Redshrike' Challener, MrBeast, Surt, Blarumyrran, Sharm, Zabin (opengameart.org), CC BY 3.0
32rogues by Seth Boyles (sethbb.itch.io)                        (appreciated, not required)
AutoBattlers Crew by RafaelMatos (rafaelmatos.itch.io)          (appreciated, not required)
3D models: KayKit by Kay Lousberg (kaylousberg.com), CC0        (appreciated, not required)
```

Most of the other packs say "use in your games, do not redistribute as an asset pack". Hosting them
on our own CDN for our own games is that use; re-publishing the CDN as a general asset site is not.
So the index (guide, manifest, packs, catalog) is behind the read token, the host is not linked from
any public page, and the library is referenced from AhaSlides games only.

**Conditions that still apply** to hosted packs (all in `packs.json` under `license`):

- **Not for "game development tools":** the four GandalfHardcore packs. Free Foes, Kobold Warrior
  and both Mana Seed samples allow the files only as part of a shipped project. So the library must
  not be exposed to AhaSlides customers as an asset picker; it is for games we build.
- **No AI or machine-learning use** of the art: 32rogues, AutoBattlers Crew, ELV Games, Mana Seed.
  An agent reading the manifest to build a game is fine; training a model on the files is not.
- **Credit in the game** for the six `commercial: "credit"` packs, block above.

**Nothing hosted needs a purchase.** Several packs are the free tier of a paid pack; buying adds
content, not rights (the free files are already licensed for commercial use). If a game needs more:

| Pack | Paid tier adds | Buy |
|---|---|---|
| HD Knight | the other 8 characters and projectiles, from $9.95 | https://smallscaleint.itch.io/hd-8-directional-top-down-character-pack-1 |
| Kobold Warrior | all 10 animations, from $5 | https://xzany.itch.io/kobold-warrior-2d-pixel-art |
| Forest Monsters | slime and bush monster, from $4 | https://monopixelart.itch.io/forest-monsters-pixel-art |
| Super Pixel Effects | 68 more effect types and colour themes, from $4.99 | https://untiedgames.itch.io/super-pixel-effects-gigapack |
| Female Adventurer | run, spear and gun animations, from $3 | https://sscary.itch.io/the-adventurer-female |
| KayKit Adventurers / Forest | Extra tiers (more characters, colour variants), from $7.95 / $9.99 | https://kaylousberg.itch.io/kaykit-adventurers · https://kaylousberg.itch.io/kaykit-forest |
| Mana Seed Farmer / Winter Forest | full sprite system $29.99 / full tileset $19.99. The Mana Seed licence limits a purchased pack to **one product**, so a purchase covers one game, not this library | https://seliel-the-shaper.itch.io/farmer-base · https://seliel-the-shaper.itch.io/winter-forest |

**Downloaded but not hosted.** These would need a purchase (or an identified source) before they can
go in; if you buy one, add it to `packs.json` and rebuild:

| Pack | Why it is out | What fixes it |
|---|---|---|
| Tree Animated (ToffeeCraft) | free tier is personal use only | premium licence from $0.80: https://toffeecraft.itch.io/tree-animated-forest |
| Forest Nature Pack (ToffeeCraft) | free tier is personal use only | premium licence from $1.80: https://toffeecraft.itch.io/forest-nature-pack |
| RPG Fantasy Battlers (LimeZu) | free trial has no commercial licence | complete version from $1.50, CC BY 4.0: https://limezu.itch.io/fantasy-battlers |
| Destructible Objects (Elthen) | commercial terms are on a separate licensing page, unconfirmed | confirm at https://elthen.itch.io/pixel-art-destructible-objects |
| `spritesheets.zip` (12 monster strips), `File.png` (weapon icons) | no source page found, licence unknown | identify the source, or replace |

## Maintaining the library

The sources (the original zips and the 8.6 GB of WAV) stay outside the repo, in
`~/Downloads/Game asset/` (`LIB_SRC` overrides that). The repo holds the recipe, not the bytes:

```
library/packs.json      pack index + build rules (edit this)
library/build.mjs       LIB_SRC -> library/out  (unzip, clean names, wav -> m4a, manifest, catalog)
library/lib.mjs         pure helpers (tests in test/library.test.js)
library/upload.mjs      library/out -> the worker (only changed files, by sha1)
library/catalog.html    the page served at LIB/
library/aha-assets.js   the runtime served at LIB/aha-assets.js (sheet, sequence, sound helpers)
library/worker/         the CDN worker (R2 bucket `tiny-kingdom-lib`)
```

**Add a pack**

1. Drop the zip in `LIB_SRC/Game Assets/` (or a folder in `LIB_SRC/`).
2. Add an entry to `library/packs.json`: `id` (becomes the URL segment), `from` (`{ "zip": … }`,
   `{ "dir": … }` or `{ "files": { src: dest } }`), `dest` (a prefix, or a map of source prefix to
   dest prefix for mixed packs), optional `skip` regexes, and the page facts: `url`, `author`,
   `license`, `commercial`, `credit`, `description`. Look the page up; do not guess the licence, and
   do not add a pack unless its page allows commercial use (`commercial` is `yes` or `credit`).
   Sound packs laid out as `<Folder>/<name>.wav` take `"handler": "sfx-folders"`. For sheets, add
   `cell` `[w, h]` (or `cells`, a map of path regex to cell), `fps`, and `animations`
   (`{ name: { row, frames } }`) when the rows are animations; `"sequences": true` for one-PNG-per-frame
   packs. The build records them in the manifest and writes the `.json` sidecars the runtime reads.
3. `npm run lib:build` (incremental; `--clean` to start over). Needs macOS `afconvert` or `ffmpeg`.
   It refuses two files landing on one path and warns about glTF files whose textures went missing.
4. `npm test` still passes; check `library/out/index.html` in a browser via `npm run lib:dev`
   (serves the worker locally on :8790; upload to it with `LIB_URL=http://localhost:8790
   LIB_TOKEN=devtoken npm run lib:upload`).
5. `LIB_URL=https://… LIB_TOKEN=… npm run lib:upload` (add `--prune` to delete files that left the
   manifest). Commit `library/packs.json` and this doc.

**First deployment** (once, needs `npx wrangler login` in a terminal):

```
npx wrangler r2 bucket create tiny-kingdom-lib
npx wrangler secret put LIB_UPLOAD_TOKEN -c library/worker/wrangler.jsonc   # writes; any long random string
npx wrangler secret put LIB_READ_TOKEN -c library/worker/wrangler.jsonc     # index reads; a different string
npm run lib:deploy                                                          # prints the workers.dev URL
LIB_URL=<that url> LIB_TOKEN=<the upload token> npm run lib:upload
```

Both tokens are kept in `~/.env` on the machine that deployed them: `TINY_KINGDOM_LIB_TOKEN` (upload)
and `TINY_KINGDOM_LIB_READ_TOKEN` (index reads). A later upload is
`LIB_TOKEN=$TINY_KINGDOM_LIB_TOKEN npm run lib:upload` (the URL above is the default); the upload
token also opens the index.

**AhaSlides login for people** (Cloudflare Access, once, in the Zero Trust dashboard of the account
that owns `ahaslides.io`):

1. Zero Trust, Settings, Authentication: make sure a login method exists for the company, either
   Google Workspace (the AhaSlides domain) or One-time PIN by email.
2. Zero Trust, Access, Applications, Add an application, Self-hosted. Name "AhaSlides games asset
   library"; application domain `games.ahaslides.io`, path `catalog`. Session duration 24 hours.
3. Policy: name "AhaSlides staff", action Allow, include Emails ending in `@ahaslides.com`,
   `@ahaslides.io`, `@ahaslides.ai` (one rule per domain).
4. Save. On the application's overview copy the **Application Audience (AUD) tag**, and note the
   team domain (`<team>.cloudflareaccess.com`, under Settings, Custom Pages).
5. Put both into `library/worker/wrangler.jsonc` (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`) and
   `npm run lib:deploy`.

Only `/catalog` is behind Access, so agents keep using `/` with the key and asset files stay open.
The worker verifies the Access JWT (signature against the team's public keys, audience, issuer,
expiry) before honouring the session, so a stray `CF_Authorization` cookie cannot open the index.
To put the CDN on a domain, add a `routes` entry with `custom_domain: true` to
`library/worker/wrangler.jsonc`.

The library worker is separate from the game worker on purpose: it has its own `wrangler.jsonc`,
deploys on its own, and a game deploy never touches it (and vice versa).

**Why these formats.** WAV became AAC-LC in `.m4a` because it decodes in every browser (Safari
included) through both `<audio>` and `decodeAudioData`, keeps gapless timing for one-shots, and is
about 70x smaller than the 96 kHz sources (the whole sound library is 47 MB). The one exception is
Chromium built without proprietary codecs (chrome-headless-shell, some Linux distro builds), where
`decodeAudioData` never resolves for AAC; real Chrome, Safari, Firefox and Edge all decode it. PNG stays PNG:
pixel art needs lossless and the sheets are small. 3D ships as glTF/GLB only, the web format.
