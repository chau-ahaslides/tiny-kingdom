/* The physics room is a shared service: what belongs in it, and what belongs in a game, is written
   down in docs/physics-service.md. These tests are how that line is held rather than merely stated.
   Every one of them has already been a real mistake somewhere, or would be a silent one here. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS, HOST_ONLY, normaliseControl } from '../src/phys-control.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ENGINE = [...fs.readdirSync(path.join(ROOT, 'src')).filter((f) => /^phys-.*\.js$/.test(f)).map((f) => `src/${f}`),
  'src/hand.js', 'public/js/aha-physics.js'];

/** Code with its comments taken out: a comment may say where an idea came from, code may not. */
const codeOnly = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

test('the engine files exist and are the ones being checked', () => {
  assert.ok(ENGINE.includes('src/phys-world.js') && ENGINE.includes('src/phys-room.js') && ENGINE.includes('src/phys-control.js'));
  for (const f of ENGINE) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});

test('no game has left its vocabulary in the engine', () => {
  // Nouns that belong to a game, not to physics. Deliberately not generic words a physics file may
  // legitimately use (`round` is a rounding helper, `fixed` is a body type): a rule nobody trusts
  // gets switched off, so it only names things that could not innocently appear here.
  const GAME_WORDS = ['marshmallow', 'marsh', 'spaghetti', 'gremlin', 'quiz', 'brawl', 'knight',
    'siege', 'tape', 'stick', 'slime', 'dungeon', 'scoreboard', 'leaderboard', 'presenter', 'audience'];
  for (const file of ENGINE) {
    const lines = codeOnly(read(file)).split('\n');
    for (const word of GAME_WORDS) {
      const at = lines.findIndex((l) => new RegExp(`\\b${word}\\b`, 'i').test(l));
      assert.equal(at, -1, at < 0 ? '' :
        `${file}:${at + 1} names "${word}" in its code — a game's rule has leaked into the shared room `
        + `(docs/physics-service.md). The line is: ${lines[at].trim()}`);
    }
  }
});

test('the engine does not import a game', () => {
  for (const file of ENGINE) {
    for (const m of read(file).matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;                    // npm packages are fine (rapier)
      assert.equal(/physics\.js|marsh|m2d|tr-|sb\.js|svq|bq\.js/.test(spec), false,
        `${file} imports ${spec}: the shared room must not depend on one game`);
    }
  }
});

test('every command the world handles can be gated, and every gated command is handled', () => {
  const apply = read('src/phys-world.js');
  const body = apply.slice(apply.indexOf('export function apply('), apply.indexOf('export function wakeAll('));
  const handled = [...body.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]);
  assert.ok(handled.length >= 8, `found only ${handled.length} commands; did apply() move?`);

  for (const cmd of handled) {
    assert.ok(COMMANDS.includes(cmd) || HOST_ONLY.includes(cmd),
      `apply() handles "${cmd}" but phys-control.js does not list it, so allowed() refuses it for everyone — a command nobody can send`);
  }
  for (const cmd of COMMANDS) {
    assert.ok(handled.includes(cmd),
      `phys-control.js offers "${cmd}" in a policy but apply() has no case for it — a promise the room does not keep`);
  }
});

test('the room gates every command before it reaches the world', () => {
  const room = read('src/phys-room.js');
  const gate = room.indexOf('allowed(');
  const dispatch = room.indexOf('apply(this.sim, m)');
  assert.ok(gate > 0, 'phys-room.js no longer calls allowed(): every command would be open');
  assert.ok(gate < dispatch, 'the gate must come before apply(), or a refused command has already run');
  assert.match(room, /refusal\(/, 'a blocked command should be told why, not ignored');
});

test('every command is in the guide agents read', () => {
  const guide = read('docs/asset-library.md');
  const missing = [...COMMANDS, ...HOST_ONLY].filter((c) => !new RegExp(`\`${c}\`|'${c}'|\\b${c}\\b`).test(guide));
  assert.deepEqual(missing, [], `undocumented commands: ${missing.join(', ')} — add them to the physics room section`);
});

test('a world is open unless it says otherwise', () => {
  const dflt = normaliseControl(undefined);
  assert.deepEqual([...dflt.players].sort(), [...COMMANDS].sort(),
    'the default policy must stay open: tightening it would change every game already running');
});

test('the service documents its own boundary', () => {
  const doc = read('docs/physics-service.md');
  assert.match(doc, /The room owns the physics\. The game owns the rules\./);
  assert.match(doc, /Would a second, unrelated game want this\?/);
});
