#!/usr/bin/env node
// The staging growth cap (A§21, T8.2). Soft delete never reclaims a DocDO, and the full suite seeds fresh
// principals and creates notes on every run, so deploy-staging.yml counts staging's docs and users and the D1 size,
// and the staging Worker's DocDOs and PrincipalDOs that hold storage, before a suite=full deploy, and refuses one
// that would carry staging past the cap. The prune (prune.mjs) shrinks only the D1 counts: a pruned principal's
// Durable Objects keep their storage, so only the object counts, read from Cloudflare's object list, bound it. Past
// the cap, the owner decides: purge with an explicit deleteAll() sweep, or move to fresh Worker and database names.
//   node scripts/deploy/growth.mjs objects OBJECTS.json   (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN)
//   node scripts/deploy/growth.mjs check COUNTS.json OBJECTS.json   (COUNTS: the count query, wrangler d1 execute --json)
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The most staging may hold after a full suite. */
export const GROWTH_CAP = { docs: 12_000, users: 18_000, d1Bytes: 200 * 1024 * 1024, docObjects: 30_000, principalObjects: 60_000 };

/**
 * What one full suite adds, rounded up from its runs on staging: about 1,000 notes and 5 MB, and its users are the
 * accounts the deploy seeds (seed.mjs, 16 shards of 300) plus the sign-ups its legs make through the login card.
 */
export const PER_FULL_RUN = { docs: 1_200, users: 4_900, d1Bytes: 8 * 1024 * 1024, docObjects: 1_200, principalObjects: 4_900 };

const WORKER = 'moss-multi-staging';
const OBJECT_CLASSES = { docObjects: 'DocDO', principalObjects: 'PrincipalDO' };
const MAX_PAGES = 100;

/**
 * The staging Worker's DocDOs and PrincipalDOs that hold storage, from Cloudflare's Durable Object list (paged by
 * cursor). Only the counts leave this function.
 * @param {{ accountId: string, token: string, fetch?: typeof fetch }} options
 */
export async function countObjects({ accountId, token, fetch: fetcher = fetch }) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/durable_objects/namespaces`;
  const get = async (url) => {
    const response = await fetcher(url, { headers: { authorization: `Bearer ${token}` } });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.success !== true || !Array.isArray(body.result)) {
      throw new Error(`Cloudflare's Durable Object list answered ${response.status}`);
    }
    return body;
  };
  const namespaces = (await get(`${base}?per_page=100`)).result;
  /** @type {Record<string, number>} */
  const counts = {};
  for (const [key, className] of Object.entries(OBJECT_CLASSES)) {
    const namespace = namespaces.find((entry) => entry?.script === WORKER && entry?.class === className);
    if (!namespace?.id) throw new Error(`no ${className} namespace for ${WORKER}`);
    let count = 0;
    let cursor = '';
    for (let page = 0; ; page += 1) {
      if (page === MAX_PAGES) throw new Error(`${className}'s object list ran past ${MAX_PAGES} pages`);
      const body = await get(`${base}/${encodeURIComponent(namespace.id)}/objects?limit=10000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      count += body.result.filter((object) => object?.hasStoredData === true).length;
      cursor = typeof body.result_info?.cursor === 'string' ? body.result_info.cursor : '';
      if (!cursor) break;
    }
    counts[key] = count;
  }
  return counts;
}

/**
 * The counts from `SELECT count(*) AS docs ..., count(*) AS users ...` and the database size wrangler reports, with
 * countObjects' counts when given.
 */
export function readGrowth(text, objectsText) {
  const [first] = JSON.parse(text);
  const row = first?.results?.[0];
  const objects = objectsText === undefined ? {} : JSON.parse(objectsText);
  const counts = {
    docs: row?.docs, users: row?.users, d1Bytes: first?.meta?.size_after,
    ...(objectsText === undefined ? {} : { docObjects: objects?.docObjects, principalObjects: objects?.principalObjects }),
  };
  for (const [key, value] of Object.entries(counts)) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`no ${key} count in the growth query's output`);
  }
  return counts;
}

/** Each measure a full suite would carry past its cap. */
export function growthProblems(counts, cap = GROWTH_CAP, perRun = PER_FULL_RUN) {
  return Object.keys(cap)
    .filter((key) => key in counts && counts[key] + perRun[key] > cap[key])
    .map((key) => `staging holds ${counts[key]} ${key}; a full suite adds about ${perRun[key]}, past the cap of ${cap[key]}. ` +
      'The owner decides: purge with a deleteAll() sweep, or fresh staging names (docs/DEPLOY.md).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, file, objectsFile] = process.argv.slice(2);
  try {
    if (mode === 'objects' && file) {
      const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: token } = process.env;
      if (!accountId || !token) throw new Error('growth.mjs objects needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
      const objects = await countObjects({ accountId, token });
      writeFileSync(file, JSON.stringify(objects));
    } else if (mode === 'check' && file && objectsFile) {
      const counts = readGrowth(readFileSync(file, 'utf8'), readFileSync(objectsFile, 'utf8'));
      console.log(`staging holds ${counts.docs} docs, ${counts.users} users, ${Math.round(counts.d1Bytes / 1024 / 1024)} MB of D1, ` +
        `${counts.docObjects} DocDOs and ${counts.principalObjects} PrincipalDOs with storage`);
      const problems = growthProblems(counts);
      for (const problem of problems) console.error(`::error::${problem}`);
      process.exitCode = problems.length > 0 ? 1 : 0;
    } else {
      throw new Error('usage: growth.mjs objects OBJECTS.json | check COUNTS.json OBJECTS.json');
    }
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
