#!/usr/bin/env node
// The network drops a staging run allows (A§21, T8.F). Off loopback a doc socket the network dropped (a heard 1006)
// whose replacement reached sync is the reconnect path working, not a finding: each one is listed, and a run passes
// with at most DROP_ALLOWANCE of them and none that never recovered. Each leg records its drops as a `network-drops`
// annotation (e2e/lib/actors.ts); the credential-free summary keeps them (canary-artifacts.mjs), and the run is judged
// across every job's summary here.
// A failed-only re-run adds its attempt's summaries to the first attempt's, so the allowance and each shard's request
// budget hold across the whole run, not per attempt.
//   node scripts/deploy/network-drops.mjs check SUMMARY.json...
//   node scripts/deploy/network-drops.mjs requests <artifact>/requests.json...
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The recovered drops one staging run may have, across every leg and job. */
export const DROP_ALLOWANCE = 2;

/**
 * `export`: after the resync, whether the replica showed what a fresh load of the doc shows (e2e/lib/actors.ts); a drop
 * whose export is `different` did not recover.
 * @typedef {{ doc: string, actor: string, at: number, recoveryMs: number | null, recovered: boolean, export?: 'same' | 'different' | 'closed' }} Drop
 */

const DOC = /^[A-Za-z0-9_-]{1,64}$/;
const ACTOR = /^[\w-]{1,24}$/;
const EXPORTS = ['same', 'different', 'closed'];

/**
 * The drops a `network-drops` annotation names, each field checked: anything else, and any text, is dropped.
 * @param {{ type?: string, description?: string }[]} annotations
 * @returns {Drop[]}
 */
export function dropsOf(annotations) {
  /** @type {Drop[]} */
  const drops = [];
  for (const { type, description } of annotations) {
    if (type !== 'network-drops') continue;
    let parsed;
    try {
      parsed = JSON.parse(String(description));
    } catch {
      continue;
    }
    for (const drop of Array.isArray(parsed) ? parsed.slice(0, 50) : []) {
      if (typeof drop?.doc !== 'string' || !DOC.test(drop.doc) || typeof drop.actor !== 'string' || !ACTOR.test(drop.actor)) continue;
      if (!Number.isFinite(drop.at) || typeof drop.recovered !== 'boolean') continue;
      const recoveryMs = Number.isFinite(drop.recoveryMs) && drop.recoveryMs >= 0 ? Math.round(drop.recoveryMs) : null;
      const found = EXPORTS.includes(drop.export) ? { export: drop.export } : {};
      drops.push({ doc: drop.doc, actor: drop.actor, at: Math.round(drop.at), recoveryMs, recovered: drop.recovered && drop.export !== 'different', ...found });
    }
  }
  return drops;
}

/**
 * The run's drops from its summaries' rows, and what fails it: more than DROP_ALLOWANCE recovered, or any not recovered.
 * @param {{ title: string, drops?: Drop[] }[]} rows
 */
export function dropVerdict(rows) {
  const drops = rows.flatMap((row) => (row.drops ?? []).map((drop) => ({ leg: row.title, ...drop })));
  const recovered = drops.filter((drop) => drop.recovered && drop.export !== 'different');
  const problems = [];
  if (recovered.length > DROP_ALLOWANCE) problems.push(`${recovered.length} recovered network drops (1006) in this run, ${DROP_ALLOWANCE} allowed`);
  const diverged = drops.filter((drop) => drop.export === 'different').length;
  const lost = drops.length - recovered.length - diverged;
  if (lost > 0) problems.push(`${lost} network drop${lost === 1 ? '' : 's'} (1006) never recovered to sync`);
  if (diverged > 0) problems.push(`${diverged} network drop${diverged === 1 ? '' : 's'} (1006) resynced to a different export`);
  return { drops, problems };
}

/**
 * Each job's requests summed over the run's attempts (artifact names end in `-<attempt>`): a job past its budget across
 * them fails the run, so a re-run cannot start its budget over.
 * @param {{ artifact: string, used: number, limit: number }[]} entries
 */
export function requestTotals(entries) {
  /** @type {Map<string, { used: number, limit: number, attempts: number }>} */
  const jobs = new Map();
  for (const { artifact, used, limit } of entries) {
    const job = artifact.replace(/-\d+$/, '');
    const total = jobs.get(job) ?? { used: 0, limit, attempts: 0 };
    total.used += used;
    total.limit = Math.min(total.limit, limit);
    total.attempts += 1;
    jobs.set(job, total);
  }
  const problems = [...jobs].filter(([, t]) => t.used > t.limit)
    .map(([job, t]) => `${job}: ${t.used} requests across ${t.attempts} attempt${t.attempts === 1 ? '' : 's'}, ${t.limit} allowed`);
  return { jobs, problems };
}

/** One drop as a log line: its leg, doc, actor, time and recovery time. */
export const dropLine = (/** @type {Drop & { leg: string }} */ drop) =>
  `${drop.leg}: doc ${drop.doc} [${drop.actor}] at ${new Date(drop.at).toISOString()}, ` +
  `${drop.export === 'different' ? 'resynced to a different export'
    : drop.recovered ? `recovered in ${drop.recoveryMs === null ? '?' : `${drop.recoveryMs} ms`}${drop.export ? `, export ${drop.export}` : ''}` : 'never recovered'}`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, ...files] = process.argv.slice(2);
  if ((mode !== 'check' && mode !== 'requests') || files.length === 0) {
    console.error('usage: network-drops.mjs check SUMMARY.json... | requests <artifact>/requests.json...');
    process.exit(2);
  }
  if (mode === 'requests') {
    const entries = [];
    for (const file of files) {
      try {
        const { used, limit } = JSON.parse(readFileSync(file, 'utf8'));
        if (Number.isFinite(used) && Number.isFinite(limit)) entries.push({ artifact: basename(dirname(file)), used, limit });
      } catch {
        console.error(`::warning::no request count at ${file}`);
      }
    }
    const { jobs, problems } = requestTotals(entries);
    for (const [job, t] of jobs) console.log(`  ${job}: ${t.used} requests in ${t.attempts} attempt${t.attempts === 1 ? '' : 's'}, ${t.limit} allowed`);
    for (const problem of problems) console.error(`::error::${problem}`);
    process.exit(problems.length > 0 ? 1 : 0);
  }
  /** @type {{ title: string, drops?: Drop[] }[]} */
  const rows = [];
  for (const file of files) {
    try {
      rows.push(...(JSON.parse(readFileSync(file, 'utf8')).tests ?? []));
    } catch {
      console.error(`::warning::no summary at ${file}`);
    }
  }
  const { drops, problems } = dropVerdict(rows);
  console.log(`${drops.length} network drop${drops.length === 1 ? '' : 's'} (1006) in ${files.length} summaries, ${DROP_ALLOWANCE} recovered allowed`);
  for (const drop of drops) console.log(`  ${dropLine(drop)}`);
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exitCode = problems.length > 0 ? 1 : 0;
}
