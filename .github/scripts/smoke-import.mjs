/**
 * Imports every backend module so the build fails on a syntax error, a bad
 * import path or a missing export. The backend has no test suite; this is the
 * honest substitute.
 *
 * It is also the ONLY automated check that catches case-mismatched imports.
 * Windows and macOS resolve './offLease.service.js' and './offlease.service.js'
 * to the same file; the Linux VPS does not. That exact mismatch already broke
 * a production deploy (commit c88461a), and nothing else in this pipeline
 * would notice, because CI runs on Linux but a developer's machine may not.
 *
 * Run from backend/:  node ../.github/scripts/smoke-import.mjs
 */
import { readdir } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const NL = String.fromCharCode(10);

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/* Hard watchdog: importing a module can start a timer or open a socket and
   keep the event loop alive. Without this the job could hang until GitHub
   kills it at the 6-hour limit instead of failing in seconds. */
setTimeout(() => {
  console.error('::error::smoke-import timed out after 120s');
  process.exit(1);
}, 120000).unref();

/* server.js is the ENTRYPOINT, not a library: importing it boots the whole app
   (binds a port, connects to Mongo, starts cron). It is parse-checked below
   instead, which catches syntax errors without executing anything. */
const ENTRYPOINTS = new Set(['src/server.js']);

/* walk() yields backslashes on Windows and forward slashes on the Linux CI
   runner; normalise before comparing. */
const norm = (p) => p.split(String.fromCharCode(92)).join('/');

const files = (await walk('src')).filter((f) => !ENTRYPOINTS.has(norm(f)));
const allFiles = [...files, ...ENTRYPOINTS].filter((f) => existsSync(f));
const broken = [];

/* CASE-SENSITIVITY PASS. Runs on every OS, unlike the import pass below.
 *
 * On Windows and macOS the filesystem is case-INSENSITIVE, so
 * './Expiry.Service.js' happily resolves to 'expiry.service.js' and the import
 * pass sees nothing wrong. The Linux VPS is case-SENSITIVE and the same import
 * is a hard failure at boot. That is exactly how commit c88461a reached
 * production and broke it.
 *
 * Comparing each relative specifier against the real directory entry catches
 * it on the DEVELOPER'S machine, before the push — rather than on the Linux
 * runner minutes later, or worse, in production. */
const dirCache = new Map();
function entriesOf(dir) {
  if (!dirCache.has(dir)) {
    try { dirCache.set(dir, readdirSync(dir)); } catch { dirCache.set(dir, []); }
  }
  return dirCache.get(dir);
}

/* Pulls the quoted specifier out of any line that imports or re-exports from
   a relative path. Deliberately string-based rather than a regex: this file
   has to survive being written through several layers of shell quoting, and a
   regex full of escapes does not. */
function relativeSpecifiers(src) {
  const found = [];
  for (const rawLine of src.split(String.fromCharCode(10))) {
    const line = rawLine.trim();
    if (!line.startsWith('import') && !line.startsWith('export') && !line.includes('import(')) continue;
    for (const quote of [String.fromCharCode(39), String.fromCharCode(34)]) {
      let i = line.indexOf(quote);
      while (i !== -1) {
        const j = line.indexOf(quote, i + 1);
        if (j === -1) break;
        const spec = line.slice(i + 1, j);
        if (spec.startsWith('.')) found.push(spec);
        i = line.indexOf(quote, j + 1);
      }
    }
  }
  return found;
}

/* Verifies EVERY path segment, not just the filename: '../Services/x.js' and
   '../services/X.js' are both fatal on Linux, and this repo genuinely mixes
   casings across real paths (pages/offLease/ beside api/offlease.api.js), so
   a filename-only check would miss half of them. */
function caseMismatch(fromFile, spec) {
  const segments = spec.split('/').filter((s) => s.length && s !== '.');
  let dir = dirname(fromFile);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === '..') { dir = dirname(dir); continue; }
    const entries = entriesOf(dir);
    if (entries.includes(seg)) { dir = join(dir, seg); continue; }
    const ci = entries.find((e) => e.toLowerCase() === seg.toLowerCase());
    if (ci) return { want: seg, actual: ci };   // right file, wrong case
    return null;                                // missing entirely - import pass reports it
  }
  return null;
}

for (const file of allFiles) {
  for (const spec of relativeSpecifiers(readFileSync(file, 'utf8'))) {
    const bad = caseMismatch(file, spec);
    if (bad) {
      broken.push(relative('.', file) + ' imports ' + spec + ' but on disk it is ' + bad.actual + ' (CASE MISMATCH - fails on Linux)');
    }
  }
}


for (const file of files) {
  try {
    await import(pathToFileURL(join(process.cwd(), file)).href);
  } catch (err) {
    const msg = String(err && err.message);
    /* A module that needs real credentials or a live socket AT IMPORT TIME is
       not a build failure — CI has neither. A module that cannot be RESOLVED
       or PARSED is. Keeping these apart is what stops this check from being
       either useless (ignore everything) or permanently red (fail on
       everything). */
    const isBuildBreak =
      /Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND/i.test(msg) ||
      /SyntaxError|Unexpected token|Unexpected end/i.test(msg) ||
      /does not provide an export named/i.test(msg);
    if (isBuildBreak) broken.push(relative('.', file) + ' :: ' + msg.split(NL)[0]);
    else console.log('  skip ' + relative('.', file) + ' (runtime env: ' + msg.slice(0, 70) + ')');
  }
}

/* Entrypoints: --check reports a syntax error without booting the server, so a
   broken server.js still fails the build. */
let entryCount = 0;
for (const entry of ENTRYPOINTS) {
  if (!existsSync(entry)) continue;
  entryCount++;
  try {
    execFileSync(process.execPath, ['--check', entry], { stdio: 'pipe' });
    console.log('  parsed ' + entry + ' (entrypoint, not executed)');
  } catch (err) {
    broken.push(entry + ' :: ' + String(err.stderr || err.message).split(NL)[0]);
  }
}

console.log(NL + (files.length + entryCount) + ' modules checked, ' + broken.length + ' broken');
for (const b of broken) console.error('::error::' + b);
process.exit(broken.length ? 1 : 0);
