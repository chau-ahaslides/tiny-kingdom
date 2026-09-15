# AhaSlides games asset library

A public CDN of game art, sound and 3D models for AhaSlides games, built from free packs
downloaded from itch.io (and a few from GameArt2D and OpenGameArt). Everything is served from one
host with CORS open, so any page, on any origin, can use it directly.

```
LIB = https://tiny-kingdom-lib.ahaslides-game.workers.dev
```

| Where to look | What you get |
|---|---|
| `LIB/<path>` | Any file: open to everyone, so games load them from any origin. |
| `LIB/llms.txt` | This guide, served from the CDN. Start here. **Gated.** |
| `LIB/manifest.json` | Every file (3,650) with `path`, `pack`, `bytes`, `sha1`, `type`, and per type: `width`/`height`, `duration`, `frames`/`frameWidth`/`frameHeight`, `category`, `variant`, `tags`. **Gated.** |
| `LIB/packs.json` | The 25 packs: title, author, page URL, licence, `commercial` (`yes`, or `credit` when attribution is required), the `credit` line to ship, description, notes. **Gated.** |
| `LIB/` | The catalog: every pack, its licence, thumbnails, play buttons, a filter box. **Gated**: open it once as `LIB/?key=<token>`. |
| `library/packs.json` in this repo | The same pack index, plus the build rules. Edit this to add or change a pack. |

**Gated** means the request needs the library read token, either as a header
`Authorization: Bearer <token>` or as `?key=<token>`. The token is `TINY_KINGDOM_LIB_READ_TOKEN` in
`~/.env` on the AhaSlides machines. Without it those four URLs answer 401; every asset file still
answers. The gate is deliberate: most packs forbid redistribution as an asset pack, so the host must
be an asset server for our games rather than a browsable library.

Ask the manifest, not the file system: it is 1.3 MB of JSON, so fetch it once and filter.

```js
const KEY = process.env.TINY_KINGDOM_LIB_READ_TOKEN;           // or whatever holds it where you run
const m = await (await fetch(`${LIB}/manifest.json`, { headers: { authorization: `Bearer ${KEY}` } })).json();
const explosions = m.entries.filter(e => e.pack === 'pixel-combat' && e.category === 'explosion');
const strips     = m.entries.filter(e => e.pack === 'pixel-effects' && e.category === 'impacts');
```

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

Responses carry `Access-Control-Allow-Origin: *`, an `ETag`, `Accept-Ranges: bytes`, and
`Cache-Control: public, max-age=86400`. A file at a given path is only ever replaced when a pack is
rebuilt; append `?v=<sha1 prefix>` from the manifest if you need an immutable URL.

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
| `pixel-effects` | `sprites/pixel-effects/<category>/` | 192 VFX strips (explosions, fantasy-spells, impacts, lightning, magic-bursts, sci-fi, smoke-bursts, splatters, symbols), 15 fps | in manifest: `frames`, `frameWidth`, `frameHeight` | **credit unTied Games** |
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
| `adventure-girl`, `ninja-girl` | `sprites/adventure-girl/png/`, `sprites/ninja-girl/png/` | cartoon side-scroller heroines as per-frame PNGs (about 640x540, 524x565) | per frame | CC0 |
| `dragons` | `sprites/dragons/dragons.png` | eleven pixel dragons on one 428x377 sheet | irregular | **credit Redshrike et al. (CC BY 3.0)** |

Strips animate by stepping a source rectangle across the sheet:

```js
// Any pixel-effects strip: frames are laid out left to right, one row.
const e = m.entries.find(x => x.path === 'sprites/pixel-effects/impacts/directional_impact_001_small_blue.png');
const img = new Image(); img.src = `${LIB}/${e.path}`;
let t0;
function draw(ctx2d, x, y, now) {
  t0 ??= now;
  const f = Math.floor((now - t0) / 1000 * e.fps) % e.frames;
  ctx2d.drawImage(img, f * e.frameWidth, 0, e.frameWidth, e.frameHeight, x, y, e.frameWidth, e.frameHeight);
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
library/worker/         the CDN worker (R2 bucket `tiny-kingdom-lib`)
```

**Add a pack**

1. Drop the zip in `LIB_SRC/Game Assets/` (or a folder in `LIB_SRC/`).
2. Add an entry to `library/packs.json`: `id` (becomes the URL segment), `from` (`{ "zip": … }`,
   `{ "dir": … }` or `{ "files": { src: dest } }`), `dest` (a prefix, or a map of source prefix to
   dest prefix for mixed packs), optional `skip` regexes, and the page facts: `url`, `author`,
   `license`, `commercial`, `credit`, `description`. Look the page up; do not guess the licence, and
   do not add a pack unless its page allows commercial use (`commercial` is `yes` or `credit`).
   Sound packs laid out as `<Folder>/<name>.wav` take `"handler": "sfx-folders"`.
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
To put the CDN on a domain, add a `routes` entry with `custom_domain: true` to
`library/worker/wrangler.jsonc`.

The library worker is separate from the game worker on purpose: it has its own `wrangler.jsonc`,
deploys on its own, and a game deploy never touches it (and vice versa).

**Why these formats.** WAV became AAC-LC in `.m4a` because it decodes in every browser (Safari
included) through both `<audio>` and `decodeAudioData`, keeps gapless timing for one-shots, and is
about 70x smaller than the 96 kHz sources (the whole sound library is 47 MB). PNG stays PNG:
pixel art needs lossless and the sheets are small. 3D ships as glTF/GLB only, the web format.
