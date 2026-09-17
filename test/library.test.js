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

test('aha-assets frame math', async () => {
  const { frameAt, cellRect } = await import('../library/aha-assets.js');
  assert.equal(frameAt(0, 8, 10), 0);
  assert.equal(frameAt(150, 8, 10), 1);
  assert.equal(frameAt(850, 8, 10), 0, 'loops after 8 frames at 10 fps');
  assert.equal(frameAt(5000, 8, 10, false), 7, 'holds the last frame when not looping');
  assert.equal(frameAt(999, 1, 10), 0);
  assert.deepEqual(cellRect(3, 2, 80, 64), { sx: 240, sy: 128, sw: 80, sh: 64 });
});

test('originAllowed: AhaSlides sites, the games account, localhost', async () => {
  const { originAllowed } = await import('../library/lib.mjs');
  for (const ok of ['https://ahaslides.com', 'https://app.ahaslides.com', 'https://presenter.staging.ahaslides.com', 'https://ahaslides.io', 'https://live-deck.ahaslides.ai', 'https://tiny-kingdom.ahaslides-game.workers.dev', 'http://localhost:8791', 'http://127.0.0.1', 'null']) assert.equal(originAllowed(ok), true, ok);
  for (const no of ['http://ahaslides.com', 'https://ahaslides.com.evil.io', 'https://notahaslides.com', 'https://ahaslides.net', 'https://evil.workers.dev', 'https://localhost', '', undefined]) assert.equal(originAllowed(no), false, String(no));
});

test('map helpers: parseCell, expandRows, iso projection', async () => {
  const { parseCell, expandRows, isoToScreen, screenToIso, tiledToGrid } = await import('../library/aha-assets.js');
  assert.equal(parseCell('7b', 17), 6 * 17 + 2);
  assert.equal(parseCell('7.2', 17), 6 * 17 + 2);
  assert.equal(parseCell('1a', 17), 1);
  assert.equal(parseCell(42, 17), 42);
  assert.equal(parseCell('.', 17), 0);
  assert.equal(parseCell('', 17), 0);
  assert.throws(() => parseCell('x9', 17));
  const cells = expandRows(['1a 2a .', '3a'], 3, 2, 4, { fill: '4d' });
  assert.deepEqual([...cells], [1, 5, 0, 9, 16, 16]);
  const legend = expandRows(['#.#', '.~.'], 3, 2, 4, { legend: { '#': '1a' }, fill: '2b' });
  assert.deepEqual([...legend], [1, 0, 1, 0, 6, 0]);
  assert.deepEqual(isoToScreen(2, 1, 256, 128), [128, 192]);
  const [tx, ty] = screenToIso(128, 192, 256, 128);
  assert.ok(Math.abs(tx - 2) < 1e-9 && Math.abs(ty - 1) < 1e-9);
  const g = tiledToGrid({ width: 2, height: 1, tilewidth: 16, tileheight: 16, orientation: 'orthogonal',
    tilesets: [{ name: 'world', firstgid: 1, image: '../../sprites/p/world.png', tilewidth: 16, tileheight: 16 }],
    layers: [{ type: 'tilelayer', name: 'ground', width: 2, height: 1, data: [1, 0x80000000 | 3], properties: [{ name: 'solid', value: true }] },
             { type: 'objectgroup', objects: [{ name: 'spawn', x: 16, y: 32 }] }] }, 'maps/p/a.json');
  assert.equal(g.tilesets.world.url, 'sprites/p/world.png');
  assert.deepEqual(g.layers[0].rows, [[1, 3]]);
  assert.equal(g.layers[0].solid, true);
  assert.deepEqual(g.objects[0], { type: 'spawn', name: 'spawn', x: 1, y: 2 });
});

test('verifyJwt (a Google ID token): signature, audience, issuer, expiry', async () => {
  const { verifyJwt } = await import('../library/lib.mjs');
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' };
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const sign = async (payload, kid = 'k1') => {
    const head = `${b64({ alg: 'RS256', kid })}.${b64(payload)}`;
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(head));
    return `${head}.${Buffer.from(sig).toString('base64url')}`;
  };
  const now = 1_800_000_000;
  const good = { aud: ['app-aud'], iss: 'https://accounts.google.com', exp: now + 600, email: 'chau@ahaslides.com' };
  const opts = { keys: [jwk], aud: 'app-aud', issuer: 'https://accounts.google.com', now };
  assert.equal((await verifyJwt(await sign(good), opts))?.email, 'chau@ahaslides.com');
  assert.equal(await verifyJwt(await sign({ ...good, aud: 'other' }), opts), null, 'wrong audience');
  assert.equal(await verifyJwt(await sign({ ...good, iss: 'https://evil' }), opts), null, 'wrong issuer');
  assert.equal(await verifyJwt(await sign({ ...good, exp: now - 1 }), opts), null, 'expired');
  assert.equal(await verifyJwt(await sign(good, 'k2'), opts), null, 'unknown key id');
  const t = await sign(good); assert.equal(await verifyJwt(t.slice(0, -4) + 'AAAA', opts), null, 'tampered signature');
  assert.equal(await verifyJwt('not.a.jwt', opts), null);
});

test('the staff session cookie: signed, scoped to our domains, expires', async () => {
  const { signSession, readSession, emailAllowed, parseCookies, safeNext } = await import('../library/lib.mjs');
  const now = 1_800_000_000;
  const value = await signSession({ email: 'chau@ahaslides.com', exp: now + 600 }, 'secret-one');
  assert.equal((await readSession(value, 'secret-one', now))?.email, 'chau@ahaslides.com');
  assert.equal(await readSession(value, 'secret-two', now), null, 'another key must not open it');
  assert.equal(await readSession(value, 'secret-one', now + 601), null, 'expired');
  assert.equal(await readSession(value.slice(0, -4) + 'AAAA', 'secret-one', now), null, 'tampered signature');
  const [body] = value.split('.');
  assert.equal(await readSession(body, 'secret-one', now), null, 'unsigned');
  assert.equal(await readSession('', 'secret-one', now), null);
  assert.equal(await readSession(value, '', now), null, 'no secret configured');
  // a payload swapped for another email no longer matches the signature
  const other = await signSession({ email: 'someone@example.com', exp: now + 600 }, 'secret-one');
  assert.equal(await readSession(other.split('.')[0] + '.' + value.split('.')[1], 'secret-one', now), null);

  const ours = ['ahaslides.com'];
  assert.equal(emailAllowed('chau@ahaslides.com', ours), true);
  assert.equal(emailAllowed('CHAU@AhaSlides.com', ours), true);
  assert.equal(emailAllowed('chau@ahaslides.com.evil.com', ours), false, 'suffix trick');
  assert.equal(emailAllowed('chau@evil.com', ours), false);
  assert.equal(emailAllowed('chau@ahaslides.io', ours), false, 'only the listed domains');
  assert.equal(emailAllowed('chau@ahaslides.io', ['ahaslides.com', 'ahaslides.io']), true);
  assert.equal(emailAllowed('nobody', ours), false);
  assert.equal(emailAllowed('@ahaslides.com', ours), false);
  assert.equal(emailAllowed(undefined, ours), false);

  assert.deepEqual(parseCookies('a=1; aha_lib_session=x.y; b=2'), { a: '1', aha_lib_session: 'x.y', b: '2' });
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(null), {});

  assert.equal(safeNext('/catalog'), '/catalog');
  assert.equal(safeNext('/llms.txt?x=1'), '/llms.txt?x=1');
  assert.equal(safeNext('//evil.com/'), '/catalog', 'protocol-relative');
  assert.equal(safeNext('https://evil.com/'), '/catalog');
  assert.equal(safeNext('/\\evil.com'), '/catalog');
  assert.equal(safeNext(undefined, '/'), '/');
});

test('Kenney atlases: parsed from the XML, named frames at the right rects', async () => {
  const { parseKenneyAtlas } = await import('../library/lib.mjs');
  const { Atlas } = await import('../library/aha-assets.js');
  const xml = `<TextureAtlas imagePath="sprites.png">
\t<SubTexture name="blue_button00" x="0" y="94" width="190" height="49"/>
\t<SubTexture name="blue_boxTick.png" x="190" y="94" width="38" height="36" />
\t<!-- a comment, and a line that is not a SubTexture -->
</TextureAtlas>`;
  const a = parseKenneyAtlas(xml);
  assert.equal(a.image, 'sprites.png');
  assert.deepEqual(Object.keys(a.frames), ['blue_button00', 'blue_boxTick.png']);
  assert.deepEqual(a.frames.blue_button00, { x: 0, y: 94, w: 190, h: 49 });
  assert.deepEqual(parseKenneyAtlas('').frames, {});
  assert.deepEqual(parseKenneyAtlas(null).frames, {});

  // the build writes these as a TexturePacker "JSON hash" file, which is what Atlas reads
  const data = { frames: { blue_button00: { frame: { x: 0, y: 94, w: 190, h: 49 } }, blue_boxTick: { frame: { x: 190, y: 94, w: 38, h: 36 } } }, animations: { press: ['blue_button00', 'blue_boxTick'] }, meta: { size: { w: 512, h: 256 } } };
  const atlas = new Atlas({ width: 512, height: 256 }, data);
  assert.deepEqual(atlas.frame('blue_button00'), { sx: 0, sy: 94, sw: 190, sh: 49 });
  assert.equal(atlas.has('blue_boxTick'), true);
  assert.equal(atlas.has('nope'), false);
  assert.throws(() => atlas.frame('nope'), /no frame "nope"/);
  assert.deepEqual(atlas.find('button'), ['blue_button00']);
  assert.deepEqual(atlas.find(/box/i), ['blue_boxTick']);
  assert.deepEqual(atlas.names, ['blue_button00', 'blue_boxTick']);
});

test('sheets with a gap between cells (Kenney tile sheets)', async () => {
  const { cellRect, Sheet } = await import('../library/aha-assets.js');
  assert.deepEqual(cellRect(3, 2, 16, 16, [1, 1]), { sx: 51, sy: 34, sw: 16, sh: 16 });
  assert.deepEqual(cellRect(0, 0, 16, 16, [1, 1], [2, 2]), { sx: 2, sy: 2, sw: 16, sh: 16 });
  assert.deepEqual(cellRect(3, 2, 80, 64), { sx: 240, sy: 128, sw: 80, sh: 64 }, 'no gap: unchanged');

  const spaced = new Sheet({ width: 832, height: 373 }, { cell: [16, 16], gap: [1, 1] });   // Kenney 1-Bit Pack
  assert.equal(spaced.cols, 49);
  assert.equal(spaced.rows, 22);
  assert.deepEqual(spaced.frame(99), { sx: 17, sy: 34, sw: 16, sh: 16 }, 'index 99 wraps to row 2, column 1');
  const packed = new Sheet({ width: 784, height: 352 }, { cell: [16, 16] });                // the same sheet, packed
  assert.equal(packed.cols, 49);
  assert.deepEqual(packed.frame(99), { sx: 16, sy: 32, sw: 16, sh: 16 });
});
