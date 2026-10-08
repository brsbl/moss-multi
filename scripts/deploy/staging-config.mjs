#!/usr/bin/env node
// The staging deploy config (A§21, T8.D). deploy-staging.yml deploys the exact dist the CI full lane tested, so it never
// rebuilds with CLOUDFLARE_ENV=staging: it lays env.staging from apps/web/wrangler.jsonc over the tested
// dist/server/wrangler.json. That is the same config a staging build writes (the keys below are everything a staging
// build changes), while the Worker and client bytes stay the tested ones.
//   guard <dist>                                      fails on local secret files in the dist, or an .assetsignore
//                                                     that would let them upload; and on D1 migrations out of order
//   write <dist> --d1-id ID --url URL [--dry-run]     rewrites <dist>/server/wrangler.json for staging
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readProvenance } from '../provenance.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
export const WRANGLER_JSONC = join(REPO, 'apps/web/wrangler.jsonc');
export const DRIZZLE = join(REPO, 'apps/web/drizzle');
/** Permanent: DO storage is bound to the Worker name (A§21). */
export const NAMES = { worker: 'moss-multi-staging', d1: 'moss-multi-staging', r2: 'moss-multi-staging-assets' };
/** Every key a CLOUDFLARE_ENV=staging build writes differently from the bare build (checked against vite-plugin 1.46.0). */
export const OVERLAY_KEYS = ['name', 'workers_dev', 'preview_urls', 'routes', 'observability', 'vars', 'durable_objects', 'migrations', 'd1_databases', 'r2_buckets'];
const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '0.0.0.0']);
/** Local secret files: never part of an upload. */
const secretFile = (name) =>
  name === '.dev.vars' || name.startsWith('.dev.vars.') || name === '.env' || name.startsWith('.env.') || name === 'cloudflare.env' ||
  name.endsWith('.pem') || name.endsWith('.key') || (name.startsWith('secrets') && name.endsWith('.json'));
/** Patterns dist/client/.assetsignore must carry, so a stray file there is never served as a static asset. */
export const ASSETS_IGNORE = ['.dev.vars*', '.env*'];

/** JSON with // and /* comments outside strings. */
export function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out);
}

export function readStagingEnv(path = WRANGLER_JSONC) {
  const env = parseJsonc(readFileSync(path, 'utf8')).env?.staging;
  if (!env) throw new Error(`${path} has no env.staging`);
  return env;
}

function httpsUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`staging URL ${JSON.stringify(url)} is not a URL`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`staging URL must be https, got ${parsed.protocol}`);
  if (LOOPBACK.has(parsed.hostname)) throw new Error('staging URL must not be loopback (test hooks would be reachable)');
  return parsed.origin;
}

/** The tested build's config with env.staging laid over it; throws on anything that would deploy the wrong thing. */
export function stagingConfig(built, env, { d1Id, url, dryRun = false }) {
  const origin = httpsUrl(url);
  if (!UUID.test(d1Id ?? '') || (d1Id === PLACEHOLDER_ID && !dryRun)) throw new Error(`D1 id ${JSON.stringify(d1Id)} is not a real database id`);
  if (env.name !== NAMES.worker) throw new Error(`the staging Worker name is permanent: ${NAMES.worker}, not ${env.name}`);
  const d1 = env.d1_databases ?? [];
  const r2 = env.r2_buckets ?? [];
  if (d1.length !== 1 || d1[0].database_name !== NAMES.d1) throw new Error(`the staging D1 name is permanent: ${NAMES.d1}`);
  if (r2.length !== 1 || r2[0].bucket_name !== NAMES.r2) throw new Error(`the staging R2 name is permanent: ${NAMES.r2}`);
  const config = structuredClone(built);
  for (const key of OVERLAY_KEYS) if (key in env) config[key] = structuredClone(env[key]);
  config.targetEnvironment = 'staging';
  config.vars = { ...config.vars, BETTER_AUTH_URL: origin };
  // migrations_dir stays the built one: it is relative to dist/server.
  const migrationsDir = built.d1_databases?.[0]?.migrations_dir;
  config.d1_databases = d1.map((db) => ({ ...db, database_id: d1Id, ...(migrationsDir ? { migrations_dir: migrationsDir } : {}) }));
  return config;
}

function walk(dir, root = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path, root) : [relative(root, path)];
  });
}

/** Local secret files anywhere in the dist, plus missing .assetsignore patterns; empty when the dist may upload. */
export function forbiddenFiles(dist) {
  const problems = walk(dist).filter((path) => secretFile(basename(path)));
  const ignorePath = join(dist, 'client/.assetsignore');
  const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8').split('\n').map((line) => line.trim()) : [];
  for (const pattern of ASSETS_IGNORE) if (!ignore.includes(pattern)) problems.push(`client/.assetsignore: missing ${pattern}`);
  return problems;
}

/** wrangler applies migrations by file name; the drizzle journal must list every file, in that order. */
export function migrationProblems(dir = DRIZZLE) {
  const files = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
  const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8')).entries ?? [];
  const tags = [...journal].sort((a, b) => a.idx - b.idx).map((entry) => `${entry.tag}.sql`);
  const problems = files.filter((file) => !tags.includes(file)).map((file) => `${file} is not in the journal`);
  for (const tag of tags) if (!files.includes(tag)) problems.push(`journal entry ${tag} has no file`);
  const listed = tags.filter((tag) => files.includes(tag));
  if (listed.join() !== [...listed].sort().join()) problems.push(`journal order ${listed.join(', ')} is not file-name order`);
  return problems;
}

function guard(dist) {
  return [...forbiddenFiles(dist), ...migrationProblems()];
}

function write(dist, { 'd1-id': d1Id, url, 'dry-run': dryRun }) {
  const problems = guard(dist);
  if (problems.length > 0) throw new Error(`refusing to deploy ${dist}:\n  ${problems.join('\n  ')}`);
  const before = readProvenance(dist);
  const path = join(dist, 'server/wrangler.json');
  const config = stagingConfig(JSON.parse(readFileSync(path, 'utf8')), readStagingEnv(), { d1Id, url, dryRun: Boolean(dryRun) });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  const after = readProvenance(dist);
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('provenance changed while writing the config');
  return after;
}

function main(argv) {
  const [command, dist, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i].replace(/^--/, '');
    if (rest[i + 1] && !rest[i + 1].startsWith('--')) opts[key] = rest[(i += 1)];
    else opts[key] = true;
  }
  if (!dist || !['guard', 'write'].includes(command)) {
    console.error('usage: node scripts/deploy/staging-config.mjs guard <dist> | write <dist> --d1-id ID --url URL [--dry-run]');
    return 2;
  }
  if (command === 'guard') {
    const problems = guard(dist);
    for (const problem of problems) console.error(`::error::upload guard: ${problem}`);
    if (problems.length === 0) console.log(`upload guard: ${dist} holds no local secret file and migrations are in order`);
    return problems.length === 0 ? 0 : 1;
  }
  const provenance = write(dist, opts);
  console.log(`staging config written for ${provenance.commit} bundle ${provenance.bundleHash}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
