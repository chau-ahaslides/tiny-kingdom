#!/usr/bin/env node
/* Deploy what is committed, not what happens to be on disk.
 *
 *   node scripts/deploy.mjs                                  the game worker (play.ahaslides.io)
 *   node scripts/deploy.mjs -c library/worker/wrangler.jsonc the asset library worker
 *   node scripts/deploy.mjs --dry-run                        build and check, upload nothing
 *
 * `wrangler deploy` bundles the working directory, which is fine for one person and wrong for two:
 * this repo is worked in by more than one session at a time, and a deploy from a shared tree
 * publishes whatever the other one has half-finished — code its author has not committed, cannot
 * point at a hash for, and did not choose to ship.
 *
 * So this deploys a temporary git worktree checked out at HEAD. What reaches Cloudflare is exactly
 * the commit named in the output: uncommitted work in the tree is left behind, and named, so nobody
 * has to wonder which it was. Tests run against that same checkout first, so a deploy is also a
 * statement that the commit is green.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt = null) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };

const config = opt('-c') || opt('--config') || 'wrangler.jsonc';
const branch = opt('--branch', 'main');
const dryRun = flag('--dry-run');
const skipTests = flag('--skip-tests');

const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
const say = (s) => console.log(s);

// ---- what are we about to deploy, and is it allowed? ----------------------------------------
let head, subject, current;
try {
  head = git('rev-parse', 'HEAD');
  subject = git('log', '-1', '--pretty=%s');
  current = git('rev-parse', '--abbrev-ref', 'HEAD');
} catch {
  console.error('not a git repository: deploys come from a commit, so there has to be one');
  process.exit(1);
}

if (current !== branch && !flag('--any-branch')) {
  console.error(`on branch "${current}", not "${branch}".\n` +
    `Deploys come from ${branch}. Merge there first, or pass --any-branch if you mean it.`);
  process.exit(1);
}

const dirty = git('status', '--porcelain').split('\n').filter(Boolean);
const tracked = dirty.filter((l) => !l.startsWith('??'));
const untracked = dirty.filter((l) => l.startsWith('??'));

say(`deploying ${head.slice(0, 7)} — ${subject}`);
if (tracked.length || untracked.length) {
  say(`\nNot in that commit, and therefore not being deployed:`);
  for (const l of [...tracked, ...untracked].slice(0, 20)) say(`  ${l}`);
  if (dirty.length > 20) say(`  … and ${dirty.length - 20} more`);
  say(`If any of that is meant to be live, commit it first.\n`);
}

// a commit nobody else can see is a deploy nobody can reproduce
try {
  const remote = git('rev-parse', `origin/${branch}`);
  if (remote !== head) {
    const ahead = git('rev-list', '--count', `origin/${branch}..HEAD`);
    say(`note: HEAD is ${ahead} commit(s) ahead of origin/${branch} — push it so this deploy can be traced.`);
  }
} catch { say(`note: no origin/${branch} to compare against.`); }

// ---- a clean checkout of HEAD, built and tested there -----------------------------------------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aha-deploy-'));
const cleanup = () => {
  try { execFileSync('git', ['worktree', 'remove', '--force', work], { cwd: REPO, stdio: 'ignore' }); } catch {}
  try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

const run = (cmd, args, where = work) => {
  const r = spawnSync(cmd, args, { cwd: where, stdio: 'inherit', env: process.env });
  if (r.status !== 0) { console.error(`\n${cmd} ${args.join(' ')} failed`); cleanup(); process.exit(r.status || 1); }
};

git('worktree', 'add', '--detach', work, head);
// the deps are the same on either side of a commit, so they are borrowed rather than reinstalled
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(work, 'node_modules'), 'junction');

if (!skipTests) {
  say(`\nchecking ${head.slice(0, 7)} before it goes anywhere…`);
  run('npm', ['test', '--silent']);
}

say(`\ndeploying ${path.basename(config)} from ${head.slice(0, 7)}${dryRun ? ' (dry run)' : ''}…`);
run('npx', ['wrangler', 'deploy', '-c', config, ...(dryRun ? ['--dry-run'] : [])]);

cleanup();
say(`\n${dryRun ? 'would have deployed' : 'deployed'} ${head.slice(0, 7)} (${subject})`);
if (tracked.length || untracked.length) say(`${dirty.length} uncommitted path(s) stayed behind, as listed above.`);
