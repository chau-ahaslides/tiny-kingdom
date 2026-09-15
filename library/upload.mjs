#!/usr/bin/env node
// Upload library/out to the library worker (which writes into the R2 bucket).
//
//   LIB_URL=https://tiny-kingdom-lib.<account>.workers.dev LIB_TOKEN=... node library/upload.mjs [--prune] [--dry-run] [--force]
//
// Only files whose sha1 differs from the remote manifest are sent (--force sends everything);
// --prune deletes remote files that are no longer in the local manifest. manifest.json,
// packs.json and index.html go last so a reader never sees a manifest ahead of its files.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mimeOf } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const URL_ = (process.env.LIB_URL || 'https://tiny-kingdom-lib.ahaslides-game.workers.dev').replace(/\/+$/, '');
const TOKEN = process.env.LIB_TOKEN || process.env.TINY_KINGDOM_LIB_TOKEN || '';
const PRUNE = process.argv.includes('--prune');
const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const JOBS = Number(process.env.LIB_JOBS) || 12;

if (!TOKEN) { console.error('set LIB_TOKEN (the worker\'s LIB_UPLOAD_TOKEN secret; TINY_KINGDOM_LIB_TOKEN in ~/.env)'); process.exit(1); }
const manifestPath = path.join(OUT, 'manifest.json');
if (!fs.existsSync(manifestPath)) { console.error('no library/out/manifest.json: run `node library/build.mjs` first'); process.exit(1); }
const local = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

let remote = null;
try {
  const r = await fetch(`${URL_}/manifest.json`, { cache: 'no-store', headers: { authorization: `Bearer ${TOKEN}` } });
  if (r.ok) remote = await r.json();
} catch {}
const remoteSha = new Map((remote?.entries || []).map((e) => [e.path, e.sha1]));

const toSend = local.entries.filter((e) => FORCE || remoteSha.get(e.path) !== e.sha1);
const toDelete = PRUNE ? [...remoteSha.keys()].filter((p) => !local.entries.some((e) => e.path === p)) : [];
console.log(`remote has ${remoteSha.size} files; sending ${toSend.length}, deleting ${toDelete.length}${DRY ? ' (dry run)' : ''}`);

const headers = { authorization: `Bearer ${TOKEN}` };
async function put(rel) {
  const body = fs.readFileSync(path.join(OUT, rel));
  const r = await fetch(`${URL_}/${rel}`, { method: 'PUT', headers: { ...headers, 'content-type': mimeOf(rel) }, body });
  if (!r.ok) throw new Error(`PUT ${rel}: ${r.status} ${await r.text()}`);
}
async function del(rel) {
  const r = await fetch(`${URL_}/${rel}`, { method: 'DELETE', headers });
  if (!r.ok && r.status !== 404) throw new Error(`DELETE ${rel}: ${r.status} ${await r.text()}`);
}
async function pool(items, n, fn) {
  const it = items[Symbol.iterator]();
  let done = 0, failed = 0;
  const workers = Array.from({ length: n }, async () => {
    for (let x = it.next(); !x.done; x = it.next()) {
      try { if (!DRY) await fn(x.value); done++; if (done % 200 === 0) console.log(`  ${done}/${items.length}`); }
      catch (e) { failed++; console.error(`  ${e.message}`); }
    }
  });
  await Promise.all(workers);
  return failed;
}

const t0 = Date.now();
let failed = await pool(toSend.map((e) => e.path), JOBS, put);
failed += await pool(toDelete, JOBS, del);
if (failed) { console.error(`${failed} transfers failed; manifest not updated`); process.exit(1); }
if (!DRY) for (const f of ['packs.json', 'index.html', 'llms.txt', 'manifest.json']) await put(f);
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${URL_}/`);
