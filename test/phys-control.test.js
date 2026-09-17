import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, HOST_ONLY, normaliseControl, allowed, refusal, permissions } from '../src/phys-control.js';

test('open is the default, and it means what it says', () => {
  for (const spec of [undefined, null, 'open']) {
    const c = normaliseControl(spec);
    assert.deepEqual(c.players.sort(), [...COMMANDS].sort(), `${spec} lets players send everything`);
    for (const cmd of COMMANDS) assert.equal(allowed(c, cmd, false), true, cmd);
  }
  // even wide open, the world itself and the policy belong to the host
  const open = normaliseControl('open');
  for (const cmd of HOST_ONLY) {
    assert.equal(allowed(open, cmd, false), false, cmd);
    assert.equal(allowed(open, cmd, true), true, `${cmd} as host`);
  }
});

test("'host' leaves players watching", () => {
  const c = normaliseControl('host');
  assert.deepEqual(c.players, []);
  for (const cmd of [...COMMANDS, ...HOST_ONLY]) {
    assert.equal(allowed(c, cmd, false), false, `player cannot ${cmd}`);
    assert.equal(allowed(c, cmd, true), true, `host can ${cmd}`);
  }
  assert.match(refusal(c, 'impulse'), /host-controlled/);
});

test('a whitelist gives players exactly what it names', () => {
  const errors = [];
  const c = normaliseControl({ players: ['grab', 'drag', 'release', 'grab'] }, errors);
  assert.deepEqual(errors, []);
  assert.deepEqual(c.players, ['grab', 'drag', 'release'], 'deduplicated, in the order given');
  assert.equal(allowed(c, 'drag', false), true);
  assert.equal(allowed(c, 'add', false), false);
  assert.equal(allowed(c, 'add', true), true);
  assert.match(refusal(c, 'add'), /players send grab, drag, release/);
  assert.deepEqual(normaliseControl(['impulse']).players, ['impulse'], 'a bare array is a whitelist too');
});

test('a bad policy is reported rather than quietly ignored', () => {
  let errors = [];
  assert.deepEqual(normaliseControl({ players: ['grab', 'shove'] }, errors).players, ['grab']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown command "shove"/);

  errors = [];
  normaliseControl({ players: ['world'] }, errors);
  assert.match(errors[0], /always the host's/);

  errors = [];
  assert.deepEqual(normaliseControl('everyone', errors).players.sort(), [...COMMANDS].sort(), 'falls back to open');
  assert.match(errors[0], /expected 'open', 'host' or/);

  errors = [];
  normaliseControl(42, errors);
  assert.equal(errors.length, 1);
});

test('a client is told what it may do', () => {
  const carry = normaliseControl({ players: ['grab', 'drag', 'release'] });
  const asPlayer = permissions(carry, false);
  assert.deepEqual(asPlayer, { host: false, may: ['grab', 'drag', 'release'], open: false });
  const asHost = permissions(carry, true);
  assert.equal(asHost.host, true);
  assert.equal(asHost.may.includes('control'), true);
  assert.equal(permissions(normaliseControl('open'), false).open, true);
  assert.equal(permissions(normaliseControl('host'), false).may.length, 0);
});

test('an unknown command is refused whoever sends it', () => {
  const open = normaliseControl('open');
  assert.equal(allowed(open, 'selfDestruct', true), false);
  assert.equal(allowed(open, 'selfDestruct', false), false);
  assert.match(refusal(open, 'selfDestruct'), /unknown command/);
});
