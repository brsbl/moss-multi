#!/usr/bin/env node
// The staging growth cap (A§21, T8.2). Soft delete never reclaims a DocDO, and the full suite signs up fresh
// principals and creates notes on every run, so deploy-staging.yml counts staging's docs and users and the D1 size
// before a suite=full deploy and refuses one that would carry staging past the cap. Past it, the owner decides: purge
// with an explicit deleteAll() sweep, or move to fresh Worker and database names.
//   node scripts/deploy/growth.mjs check COUNTS.json   (the output of the count query, wrangler d1 execute --json)
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The most staging may hold after a full suite. */
export const GROWTH_CAP = { docs: 12_000, users: 18_000, d1Bytes: 200 * 1024 * 1024 };

/** What one full suite adds, rounded up from its runs on staging (about 1,000 notes and 1,500 sign-ups, about 5 MB). */
export const PER_FULL_RUN = { docs: 1_200, users: 1_800, d1Bytes: 8 * 1024 * 1024 };

/** The counts from `SELECT count(*) AS docs ..., count(*) AS users ...` and the database size wrangler reports. */
export function readGrowth(text) {
  const [first] = JSON.parse(text);
  const row = first?.results?.[0];
  const counts = { docs: row?.docs, users: row?.users, d1Bytes: first?.meta?.size_after };
  for (const [key, value] of Object.entries(counts)) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`no ${key} count in the growth query's output`);
  }
  return counts;
}

/** Each measure a full suite would carry past its cap. */
export function growthProblems(counts, cap = GROWTH_CAP, perRun = PER_FULL_RUN) {
  return Object.keys(cap)
    .filter((key) => counts[key] + perRun[key] > cap[key])
    .map((key) => `staging holds ${counts[key]} ${key}; a full suite adds about ${perRun[key]}, past the cap of ${cap[key]}. ` +
      'The owner decides: purge with a deleteAll() sweep, or fresh staging names (docs/DEPLOY.md).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, file] = process.argv.slice(2);
  try {
    if (mode !== 'check' || !file) throw new Error('usage: growth.mjs check COUNTS.json');
    const counts = readGrowth(readFileSync(file, 'utf8'));
    console.log(`staging holds ${counts.docs} docs, ${counts.users} users, ${Math.round(counts.d1Bytes / 1024 / 1024)} MB of D1`);
    const problems = growthProblems(counts);
    for (const problem of problems) console.error(`::error::${problem}`);
    process.exitCode = problems.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
