# The physics room: what belongs in it

`play.ahaslides.io/phys/<CODE>` is a shared service. One Durable Object per room runs Rapier, and
several games now depend on it at once. That makes it different from a game's own code: a change
here reaches every game, and a game that cannot express itself through it has to wait for a backend
change and a deploy.

Two failure modes follow, and they pull in opposite directions. If the service is too thin, every
new game needs an edit to `phys-world.js` and the queue is us. If the service absorbs whatever each
game needs, it becomes a pile of one-game features that nobody else can use and nobody dares
change. This file is the line between them.

## The rule

**The room owns the physics. The game owns the rules.**

The question to ask of anything proposed for `src/phys-*.js`:

> Would a second, unrelated game want this?

A hinge is physics: a door, a catapult and a pinball flipper all want one. "The marshmallow must be
on top to score" is a rule: only one game will ever want it, and it belongs in that game's own code.

| In the room | In the game |
|---|---|
| Bodies, shapes, materials | What a body *is* — a stick, a gremlin, a vote |
| Forces, impulses, velocities | When to apply them |
| Joints, motors, limits, breaking | What counts as tape, and how sticky it is |
| Grabbing, carrying, turning | Who may hold what, and what happens when they let go |
| Collisions, sensors, queries | What a collision *means* — a point, a death, a goal |
| Snapshots and interpolation | Drawing, sound, score, phase, turn order |

Game state — scores, phases, whose turn it is — goes through `aha-room.js`, which is built for it.
A game can put both rooms on one code: `AhaPhysics.host(spec, { code: room.code })`.

## How the line is held

`test/phys-boundary.test.js` fails the build when it is crossed:

1. **No game vocabulary in the engine.** The code of `src/phys-*.js`, `src/hand.js` and
   `public/js/aha-physics.js` may not name a game or its nouns. Comments may — saying where an idea
   came from is worth keeping — but an identifier, string or field called `marshmallow` or `tape` is
   a rule that has leaked into the engine.
2. **The engine may not import a game.** `src/phys-*.js` never imports `physics.js`, `marsh-room.js`
   or anything under `public/js/` that belongs to one game.
3. **Dispatch and policy stay in step.** Every command `apply()` handles is in `COMMANDS` in
   `phys-control.js`, and every command in `COMMANDS` is handled. A command missing from `COMMANDS`
   cannot be sent by anyone (`allowed()` refuses what it does not know), so the drift is silent, and
   one that is listed but unhandled is a promise the room does not keep.
4. **Every command is documented.** A command that exists and is not in `docs/asset-library.md` is a
   command no agent will ever use.
5. **The default stays open.** `control` defaults to every command being available to every
   connection. Tightening that default would quietly change every game already running.

## Adding to the room

1. Ask the question above. If the answer is no, it goes in the game.
2. Put the work in its own module (`phys-joints.js`, `phys-query.js`) with a thin hook in
   `phys-world.js`, rather than growing the core file.
3. Add the command to `COMMANDS` in `phys-control.js` so a world can gate it, and to the guide.
4. Keep it backwards-compatible. Live games are connected to this: a new field defaults to the old
   behaviour, and an existing field does not change meaning.
5. `npm test` and `npm run build` both stay green — the build matters because the esbuild plugin
   that swaps Rapier's wasm glue is what lets the Durable Object run at all.

## What is still missing

The surface is close to complete; these would each otherwise force a backend change:

- **Joint motors and limits.** `phys-joints.js` has springs (pin, weld, breaking). A hinge or slider
  with a limit and a motor would cover doors, wheels, pistons and catapults.
- **A character controller.** Rapier's kinematic character controller, for a platformer that wants
  slopes and steps rather than a rolling capsule.
- **Heightfields and meshes.** Today a world is built from balls, boxes, capsules and cylinders; a
  terrain or a traced outline needs one of these.

Anything not on that list is probably a game rule. Check it against the table first.
