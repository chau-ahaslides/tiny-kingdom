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
| `LIB/packs.json` | The 276 packs: title, author, page URL, licence, `commercial` (`yes`, or `credit` when attribution is required), the `credit` line to ship, description, file and byte counts. Small; start here. **Gated.** |
| `LIB/manifest/<pack>.json` | One pack's files, with `path`, `bytes`, `sha1`, `type`, and per type: `width`/`height`, `cell`/`gap`/`cols`/`rows`/`frames`/`fps`/`animations`, `atlas`, `duration`, `category`, `variant`, `tags`. **This is the one to fetch.** **Gated.** |
| `LIB/manifest.json` | The same for every pack at once: 32,000 entries, 8 MB. Only worth fetching to search across packs. **Gated.** |
| `LIB/catalog` | The catalog: every pack, its licence, thumbnails, play buttons, the starter maps, a filter box. Sign in with your AhaSlides Google account. |
| `LIB/` | The same catalog for agents and scripts: open it once as `LIB/?key=<token>`. |
| `LIB/vendor/…` | three.js, PixiJS and Rapier (physics), pinned by version (see "Libraries on the CDN"). |
| `LIB/maps/<pack>/…` | A starter map per tileset pack, in the library's map format (see "Maps"). |
| `library/packs.json` in this repo | The same pack index, plus the build rules. Edit this to add or change a pack. |

**Reference, never inline.** Game code points at these URLs. Do not copy assets into a game's
folder, embed them as data URIs, or bundle three.js/PixiJS into the page; the CDN caches them for
a day at the edge and in the browser, and a pinned version path never changes.

**Gated** means the request needs one of two credentials. Agents and scripts send the library read
token, as a header `Authorization: Bearer <token>` or as `?key=<token>`; it is
`TINY_KINGDOM_LIB_READ_TOKEN` in `~/.env` on the AhaSlides machines. People open `LIB/catalog` in a
browser and sign in with their AhaSlides Google account (any `@ahaslides.com` address, no key to
copy); the cookie that sign-in sets then opens `llms.txt`, `manifest.json` and `packs.json` in that
browser too, for twelve hours. Without either, a browser is sent to the Google sign-in and anything
else answers 401; every asset file still answers. The gate is deliberate: most packs forbid redistribution as
an asset pack, so the host must be an asset server for our games rather than a browsable library.

Ask the index, not the file system, and ask it pack by pack: `packs.json` is small and names all
276 packs, and each pack's files are a separate small file. The whole manifest is 8 MB and is only
worth fetching to search across packs.

```js
const KEY = process.env.TINY_KINGDOM_LIB_READ_TOKEN;           // or whatever holds it where you run
const get = async (p) => (await fetch(`${LIB}/${p}`, { headers: { authorization: `Bearer ${KEY}` } })).json();

const { packs } = await get('packs.json');                     // 276 packs with licences and counts
const town = await get('manifest/kenney-tiny-town.json');      // one pack: 9 files
const sfx  = await get('manifest/pixel-combat.json');
const explosions = sfx.entries.filter(e => e.category === 'explosion');
const sheets = town.entries.filter(e => e.cell || e.atlas);    // the ready-split sheets
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

// A packed sheet (all the Kenney ones): frames have the artist's names, not grid positions.
const ui = await assets.atlas('sprites/kenney/ui-pack/Spritesheet/blueSheet.png');
ui.draw(ctx, 'blue_button00', 40, 40, { scale: 1.5 });
ui.find('button');                                                    // every frame name containing "button"

// A tile sheet with a 1px gap between cells: the gap is in its sidecar, so cells still count 1, 2, 3…
const town = await assets.sheet('sprites/kenney/1-bit-pack/Tilesheet/colored.png');
town.drawFrame(ctx, 99, 0, x, y, { scale: 2 });

// Warm everything before the first frame.
await assets.preload(['sfx/pixel-combat/hit/bit-kick', 'sprites/32rogues/tiles.png', 'sprites/ninja-girl/Jump']);
```

The module reads a small JSON that sits next to each asset: `<image>.json` (cell size, gap,
columns, rows, frame count, fps, named animations, or an atlas's frame names), `<image>.atlas.json`
(the same as a TexturePacker atlas, for Phaser and PixiJS, see below), `<Animation>.json` for
per-frame packs (the ordered frame list), and `<sound>.json` for Pixel Combat (the variant list). Those files are open, so the
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
| `maps/kenney-tiny-town/village.json` | Kenney Tiny Town | 30x20 crossroads village: five houses, a fenced paddock with a gate, orchards, a separate collision layer |
| `maps/kenney-tiny-dungeon/vault.json` | Kenney Tiny Dungeon | 24x14 three rooms and two corridors, chests, barrels, wall torches, enemies as objects |
| `maps/kenney-pixel-platformer/hills.json` | Kenney Pixel Platformer | 48x14 side-scroller: water pits, wooden ledges, a ladder, coins, a flag, clouds on a parallax layer |

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
https://play.ahaslides.io/js/aha-physics.js  the physics room SDK: a Rapier world the server runs (below)
https://play.ahaslides.io/sdk                its guide: messages, state document, worked examples
POST https://play.ahaslides.io/api/room      mints a room code and join URL (CORS for AhaSlides origins and sandboxed iframes)
https://play.ahaslides.io/j/<CODE>           the join link phones open; /ws/<CODE> the socket
https://play.ahaslides.io/phys/<CODE>        the physics room socket (GET it for what is in the room)
```

The backend is always `play.ahaslides.io`; the SDK talks to it from any page without being told.
The host mints a room, the audience joins it, no addresses in the game code:

```html
<script src="https://play.ahaslides.io/js/aha-room.js"></script>
<script>
// big screen
const room = await AhaRoom.host();                     // room.code to show; room.joinUrl for a QR when there is one
room.on('join', p => …); room.state.set({ phase: 'ask' });
// phone (the same page opened with ?join=CODE or #join=CODE, or a code typed in)
const me = AhaRoom.join({ code, askName: () => prompt('Your name') });
me.on('state', (doc, mine) => render(doc, mine)); me.send({ t: 'tap' });
</script>
```

`room.joinUrl` (`https://play.ahaslides.io/j/CODE`) redirects phones to the hosting page with
`?join=CODE`, so an artifact's audience joins on the artifact itself when the page can read its own
URL. A sandboxed frame cannot, so there `joinUrl` is `null`: show `room.code` and let people type
it, or pass `host({ page: 'https://…/artifacts/<id>' })` to get a link. Details at
`https://play.ahaslides.io/sdk#elsewhere`. This library only supplies the art, sound, maps and
libraries; the room service is `play.ahaslides.io`.

### A physics room: the server runs the world

`vendor/rapier*/…` above puts physics in the *page*, which is right for a solo game. When several
devices share one world, put it in the room instead: `play.ahaslides.io` runs Rapier server-side (the
same engine, the same machinery the Marshmallow Challenge has always used) and hands every device
the result. Nobody's browser is the source of truth, so a phone can shove something without asking
the big screen, a reload rejoins mid-flight, and twenty people see one world rather than twenty
slightly different ones.

```html
<script type="module">
  import { AhaPhysics } from 'https://play.ahaslides.io/js/aha-physics.js';

  // the big screen describes the world once; the server builds and runs it
  const world = await AhaPhysics.host({
    plane: 'xy',                                   // 2D: bodies keep z = 0 and spin only about z
    gravity: [0, -9.81],
    events: true,                                  // report collisions, for thud sounds
    bodies: [
      { id: 'ground', type: 'fixed', shape: { cuboid: [8, 0.2, 1] }, pos: [0, 0] },
      { id: 'ball', tag: 'ball', shape: { ball: 0.6 }, pos: [-6, 6], restitution: 0.6 },
    ],
  });
  show(world.code);                                // phones join with this, exactly like a normal room
  world.on('hit', (e) => thud(e.speed));           // e.a, e.b, e.speed in m/s

  (function frame(now) {
    for (const b of world.step(now)) draw(b);      // b.x, b.y, b.z, b.angle (2D) or b.qx…b.qw (3D)
    requestAnimationFrame(frame);
  })(performance.now());
</script>
```

```js
// a phone, on the same code
const me = await AhaPhysics.join({ code });        // or nothing at all: it reads ?join=CODE
me.impulse('ball', [12, 2]);                       // shove it
me.grab('crate'); me.drag([x, y]); me.release();   // or pick something up and carry it
```

The world spec, in full: `gravity`, `timestep` (1/240 to 1/20), `substeps`, `plane` (`'xy'`, `'xz'`
or nothing for full 3D), `floor` (bodies below it are dropped and reported), `events` +
`eventForce`, `sleep`, and `bodies`. A body is `{ id, type: 'dynamic' | 'fixed' | 'kinematic',
shape, pos, rot, density, friction, restitution, linearDamping, angularDamping, ccd, sensor, lock,
tag }`, with `shape` one of `{ ball: r }`, `{ cuboid: [hx, hy, hz] }`, `{ capsule: [halfHeight, r] }`
or `{ cylinder: [halfHeight, r] }` — half-extents, so a 2 x 1 x 2 m crate is `{ cuboid: [1, 0.5, 1] }`.
Commands are `add`, `remove`, `impulse`, `torque`, `velocity`, `place`, `gravity`, `grab`, `drag`,
`release` and `reset`; each connection has one hand, so one phone cannot drop another's grip.

Worth knowing: the room snapshots 20 times a second and `world.step(now)` interpolates between
snapshots, so drawing is smooth at any frame rate — call it once per animation frame even if nothing
of yours changed. Work in metres (a body should be roughly 0.1–10 m). A world where everything has
settled stops being stepped at all until the next command, so an idle room costs nothing. Limits: 400
bodies, 120 commands a second per connection, and the room is emptied 15 minutes after the last
command. `GET https://play.ahaslides.io/phys/<CODE>` says what is in a room right now, which is the
quickest way to see whether a game is doing what you think.

## Libraries on the CDN: three.js, PixiJS and Rapier

The engines the games use are hosted here too, pinned by version, so a game page references them
from this host and never bundles, copies or inlines them (the same rule as for assets: link the URL,
never paste bytes or base64 into game code):

```
vendor/three/0.186.0/build/three.module.js         three.js core (ES module; three.core.js is imported by it)
vendor/three/0.186.0/build/three.webgpu.js         the WebGPU renderer build, if wanted
vendor/three/0.186.0/examples/jsm/…                every addon: loaders/GLTFLoader.js, controls/OrbitControls.js, …
vendor/pixi/8.20.1/pixi.min.mjs                    PixiJS 8 as an ES module (pixi.mjs unminified; pixi.min.js / pixi.js for a <script> tag)
vendor/rapier2d/0.20.0/rapier.mjs                  Rapier 2D physics (Rust, compiled to WebAssembly), one ES module
vendor/rapier3d/0.20.0/rapier.mjs                  Rapier 3D physics, the same
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

### Rapier: physics

Use it for anything that should fall, collide, stack, swing or topple — a tower that can really
collapse, a ragdoll, a ball rolling round a maze, a vehicle. Rapier is Rust compiled to WebAssembly,
so a few hundred bodies step in well under a frame, and it is deterministic: the same inputs give
the same result on every machine, which is what makes a host-authoritative room work (the big screen
steps the world and broadcasts positions; phones only send input, and never run their own physics).

The build hosted here is the `-compat` one: a single ES module with the WebAssembly inlined, so it
loads from a URL with no bundler and no second request. **`await RAPIER.init()` once before touching
any other API** — everything else throws until the WebAssembly is ready.

```html
<script type="module">
  import RAPIER from 'https://games.ahaslides.io/vendor/rapier2d/0.20.0/rapier.mjs';
  await RAPIER.init();

  const world = new RAPIER.World({ x: 0, y: -9.81 });           // metres and seconds, y up
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(10, 0.1), ground);   // half-extents, so 20 x 0.2

  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 8));
  world.createCollider(RAPIER.ColliderDesc.ball(0.5).setRestitution(0.7).setDensity(1), body);

  const PX = 32;                                                 // 32 screen px to the metre
  (function frame() {
    world.step();                                                // a fixed 1/60 s step; call it once per frame
    const p = body.translation(), a = body.rotation();           // 3D: rotation() is a quaternion
    sprite.x = p.x * PX; sprite.y = -p.y * PX; sprite.rotation = -a;
    requestAnimationFrame(frame);
  })();
</script>
```

3D is the same module with `z` in every vector: `new RAPIER.World({ x: 0, y: -9.81, z: 0 })`,
`ColliderDesc.cuboid(hx, hy, hz)`, `body.translation()` giving `{x, y, z}` and `body.rotation()` a
quaternion you can hand straight to three.js (`mesh.quaternion.copy(q)`).

Things worth knowing before the first bug: work in metres, not pixels (a 600-pixel-tall box falling
under 9.81 m/s² behaves like a skyscraper — pick a scale like 32 px per metre and keep bodies roughly
0.1–10 m); `world.step()` advances a fixed 1/60 s, so call it once per animation frame and, if a
frame is late, step it at most a few times to catch up rather than passing a variable delta; give
every collider a density or mass, or it weighs nothing; `world.step()` is the only place the
simulation advances, so read positions after it; and events (contacts, sensors) arrive by passing a
`RAPIER.EventQueue` to `step` and draining it.

The WebAssembly runs inside a sandboxed iframe (the artifact viewer's `allow-scripts` frame, origin
`null`) — checked, not assumed — so a game hosted as an artifact can use it.

three.js and PixiJS are MIT, Rapier is Apache-2.0 (its LICENSE ships beside the module). To add a
version, add a pack with `"from": { "npm": "three", "version": "…" }` to `library/packs.json` and
rebuild; old versions stay so existing games keep working.

## Other engines

`aha-assets.js` draws with the 2D canvas and Web Audio, which is what the tiny-kingdom games use.
Every sheet also has `<image>.atlas.json`, a TexturePacker-style JSON hash that PixiJS and Phaser
read directly — frames named `r<row>c<col>` for a grid sheet, the artist's own names for a Kenney
packed sheet — and every Pixel Combat sound has `<sound>.json` listing its variants, so engines load
the library with their own loaders (PixiJS and three.js above):

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

// A Kenney packed sheet in Phaser or PixiJS: the frame names are the artist's own.
this.load.atlas('ui', `${LIB}/sprites/kenney/ui-pack/Spritesheet/blueSheet.png`,
                      `${LIB}/sprites/kenney/ui-pack/Spritesheet/blueSheet.png.atlas.json`);
this.add.image(x, y, 'ui', 'blue_button00');
// A Kenney tile sheet with a 1px gap, in Phaser's own loader (gap is `spacing`):
this.load.spritesheet('town', `${LIB}/sprites/kenney/1-bit-pack/Tilesheet/colored.png`, { frameWidth: 16, frameHeight: 16, spacing: 1 });
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
maps/<pack>/<name>.json                         starter maps and scenes

<image>.json                                    that image's grid or frame names (open, no token)
<image>.atlas.json                              the same as a TexturePacker atlas (Phaser, PixiJS)
```

Kenney's packs keep the same scheme one level deeper, because the bundle is 242 packs in itself:
`sprites/kenney/<pack>/…`, `models/kenney/<pack>/…`, `sfx/kenney/<pack>/…`, `fonts/kenney/<pack>/…`,
and their pack ids are `kenney-<pack>` (`kenney-tiny-town`, `kenney-ui-pack`, `kenney-furniture-kit`).

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

Two libraries cover most needs, with Kenney's 16 sound packs behind them. Every sound is a short
one-shot; decode once with Web Audio and play from the buffer (an `<audio>` element per hit is too
slow for games).

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

**Kenney's sound packs** (19) are at `sfx/kenney/<pack>/` (and `music/kenney/<pack>/` where
the pack is music), converted from Kenney's .ogg to the same AAC .m4a as everything else: `casino-audio`, `desert-shooter-pack`, `digital-audio`, `foley-sounds`, `impact-sounds`, `interface-sounds`, `music-jingles`, `music-loops`, `new-platformer-pack`, `retro-sounds-1`, `retro-sounds-2`, `rpg-audio`, `sci-fi-sounds`, `synth-voice-1`, `synth-voice-2`, `ui-audio`, `ui-pack`, `voiceover-pack`, `voiceover-pack-fighter`.
All CC0. Impact Sounds alone covers footsteps on eight surfaces; UI Audio and the Interface Sounds
pack cover clicks, switches and errors; Voiceover Pack has spoken numbers and words.

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
| `savanna-creatures-2` | `sprites/savanna-creatures-2/savanna-creatures-2.png` | 16 small pixel savanna animals (ostrich, vulture, warthog, wildebeest, caracal…), one still pose each; **AI-assisted** per its page | 61x61 cells, 4x4 | **credit Michael Jay (CC BY 4.0)** |

### Kenney: 242 packs, all CC0

The whole Kenney catalogue is here under `sprites/kenney/<pack>/`, `models/kenney/<pack>/`,
`sfx/kenney/<pack>/` and `fonts/kenney/<pack>/` — pixel and vector 2D packs, 3D kits (GLB),
UI packs, input-prompt icons, and sound packs. Public domain: use commercially, alter freely, no
credit needed. Find a pack in `packs.json` (search `kenney-`), then read `manifest/<pack>.json`.

Every sheet arrives already split, so no game measures pixels:

- **Packed sheets** (a `Spritesheet/` or `Tilesheet/` PNG that came with Kenney's XML atlas) carry
  `atlas: true` and `frames: <count>` in the manifest, and a `<sheet>.png.atlas.json` beside them
  with the artist's own frame names (`blue_button00`, `elephant`, `controller_battery_full`). Load
  with `assets.atlas(path)`, then `atlas.draw(ctx, name, x, y)`, `atlas.find('button')`,
  `atlas.frame(name)`. The loose per-frame PNGs those atlases name are deliberately not hosted: one
  request replaces hundreds, and nothing is lost.
- **Grid sheets** (tilemaps) carry `cell`, `cols`, `rows` and, where Kenney leaves a line between
  tiles, `gap: [1, 1]`. `assets.sheet(path)` reads all of it, so `drawFrame(ctx, i, 0, …)` and map
  cells count 1, 2, 3… as usual. 198 sheets carry a grid; 411 carry an atlas.
- Packs with neither (loose sprites only) are hosted file by file, as their own art.

Not hosted from the bundle: vector sources (SVG/AI/SWF), the FBX, OBJ, DAE and STL copies of models
that also ship as GLB, per-model preview renders, Construct and Unity sample projects, and the
Archive and Goodies categories.

Manifest entries for images carry `width`, `height` and, where the grid is known, `cell` `[w, h]`,
`gap`, `cols`, `rows`, `frames` (one-row strips), `fps` and `animations` (`{ name: { row, frames } }`);
a packed sheet carries `atlas: true` instead.
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

Kenney's 3D kits (CC0) are the bulk: about 4,900 GLB models across 54 kits — furniture, city,
nature, castle, racing, food, weapons, characters — at `models/kenney/<kit>/<model>.glb`. One
self-contained file per model, nothing to resolve. Then two CC0 KayKit packs in glTF only (FBX and
OBJ were dropped):

- `models/kaykit-adventurers/Characters/gltf/{Barbarian,Knight,Mage,Ranger,Rogue}.glb`, rigged and
  textured; animations in `Animations/gltf/Rig_Medium/Rig_Medium_General.glb`; weapons and props in
  `Assets/gltf/*.gltf` (+ `.bin`); preview renders in `Samples/`.
- `models/kaykit-forest/Assets/gltf/*.gltf` (105 trees, bushes, rocks, grass, flowers) sharing
  `forest_texture.png` in the same folder.

Animals, as one GLB per model:

- `models/everything-library-animals/<Category>/<Name>.glb`: David O'Reilly's Everything Library,
  178 low-poly creatures in `Animals` (91 mammals, e.g. `Animals/Panda.glb`), `Birds`,
  `BirdsUpright`, `Insects`, `FlyingInsects`, `Arachnids`, `Reptiles`, `Amphibians`, `Imaginary`
  and `AnimalParts` (skeleton, teeth, feathers, brain). Static, coloured by vertex colours, metre
  scale. **Credit required (CC BY 4.0).**
- `models/styloo-animals/{butterfly,cat,chicken,cow,dog,giraffe,ladybug}.glb`: rigged and textured,
  with clips on the cow (`iddle`, `jump`, `run`, `walk`, `walking`), dog (`attack1`, `iddle`, `jump`,
  `run`, `walk`, `walksent`), giraffe (`iddle`) and butterfly (`fly`); the names are the author's,
  typos included. CC0.
- `models/craftpix-wild-animals/{bear,boar,deer_1,deer_2,fox,hedgehog,owl,rabbit,squirrel,wolf}.glb`:
  rigged low-poly forest animals with no clips, one colour atlas embedded. CraftPix freebies licence:
  commercial use, no credit.

The Everything Library and CraftPix packs are FBX downloads: the build converts them with FBX2glTF
(the `fbx2gltf` npm package, staged like the vendor libraries) and `library/gltf.mjs` does the rest
(the embedded atlas, one file per creature, vertex colours shown). `handler: "fbx"` in `packs.json`
documents the options.

Load with three.js `GLTFLoader` straight from the URL; relative texture and buffer references
resolve on the CDN.

## Licences and credits

Every pack's page terms are in `packs.json` (`license`, `commercial`, `credit`). Everything in the
library may be used in commercial games. The 242 Kenney packs are **CC0 1.0** — public domain, no
credit required, alteration fine — and so are the KayKit models, Brackeys' platformer pack and the
two GameArt2D heroines; the rest keep their own terms below. packs whose free tier is personal-use only (ToffeeCraft's
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
3D animals: Everything Library 01 by David O'Reilly (davidoreilly.itch.io), CC BY 4.0
Savanna Creatures 2 by Michael Jay (michael-jay-rov.itch.io), CC BY 4.0
32rogues by Seth Boyles (sethbb.itch.io)                        (appreciated, not required)
AutoBattlers Crew by RafaelMatos (rafaelmatos.itch.io)          (appreciated, not required)
3D models: KayKit by Kay Lousberg (kaylousberg.com), CC0        (appreciated, not required)
Art and audio by Kenney (kenney.nl), CC0                        (appreciated, not required)
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
- **Credit in the game** for the eight `commercial: "credit"` packs, block above.
- **AI-assisted art:** Savanna Creatures 2 discloses generative AI in its graphics. Check that fits a game before using it.

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
| Free Isometric Animated Fox (Engvee) | the page states no licence, so all rights are reserved by default | ask Engvee for a licence in the page comments: https://engvee.itch.io/isometric-animated-fox |

## Maintaining the library

The sources (the original zips and the 8.6 GB of WAV) stay outside the repo, in
`~/Downloads/Game asset/` (`LIB_SRC` overrides that). The repo holds the recipe, not the bytes:

```
library/packs.json      pack index + build rules (edit this)
library/build.mjs       LIB_SRC -> library/out  (unzip, clean names, wav/ogg -> m4a, manifest, catalog)
library/lib.mjs         pure helpers (tests in test/library.test.js)
library/upload.mjs      library/out -> the worker (only changed files, by sha1)
library/catalog.html    the page served at LIB/
library/aha-assets.js   the runtime served at LIB/aha-assets.js (sheet, atlas, sequence, sound, map)
library/maps/           the starter maps and make-starters.mjs, which writes them
library/worker/         the CDN worker (R2 bucket `tiny-kingdom-lib`)
```

`node library/build.mjs --plan` lists what a build would write, per pack, without writing anything.
WAV conversion uses macOS's `afconvert`; Kenney's `.ogg` needs **ffmpeg**, on `PATH` or named by
`LIB_FFMPEG=/path/to/ffmpeg` (`npm i --no-save ffmpeg-static` gives you one without touching the
system). A build without ffmpeg simply fails on those files and converts everything else.

A pack whose `handler` is a bundle (`kenney`) expands into many packs at build time: the handler
walks the download, decides what is worth hosting, and registers one manifest pack per pack it finds
(`kenney-<name>`), all inheriting the bundle's licence. `library/packs.json` holds one entry for the
whole bundle.

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

**Google sign-in for staff** (once, in the Google Cloud project that owns the AhaSlides Workspace):

1. console.cloud.google.com, pick (or create) a project, APIs & Services, OAuth consent screen:
   User type **Internal**, app name "AhaSlides games asset library", support and developer email
   your own. Internal means only `@ahaslides.com` accounts can even reach the consent screen.
2. Credentials, Create credentials, OAuth client ID, type **Web application**. Name it the same.
   Authorised redirect URI: `https://games.ahaslides.io/auth/callback` (add
   `https://tiny-kingdom-lib.ahaslides-game.workers.dev/auth/callback` too if you want the
   workers.dev copy to accept sign-ins). No JavaScript origins are needed.
3. Copy the client ID into `GOOGLE_CLIENT_ID` in `library/worker/wrangler.jsonc`, then:

   ```
   npx wrangler secret put GOOGLE_CLIENT_SECRET -c library/worker/wrangler.jsonc   # from the same screen
   npx wrangler secret put LIB_SESSION_SECRET -c library/worker/wrangler.jsonc     # any long random string
   npm run lib:deploy
   ```

4. Open `https://games.ahaslides.io/catalog`: it bounces through Google and comes back signed in.

`LOGIN_DOMAINS` in the same file lists the email domains allowed in (`ahaslides.com` by default;
comma-separate to add more). The worker checks the Google ID token itself — RS256 signature against
Google's published keys, audience equal to our client ID, issuer, expiry, `email_verified`, and the
address's domain — and only then mints its own cookie, signed with `LIB_SESSION_SECRET`
(`HttpOnly`, `Secure`, `SameSite=Lax`, twelve hours, `/auth/logout` to drop it). An unverified or
outside address is refused even though Google authenticated it. Sign-in covers only the four gated
URLs; agents keep using the key, and asset files stay open to everyone. With `GOOGLE_CLIENT_ID`
empty the whole sign-in is off and only the key works.

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
