#!/usr/bin/env node
// The network drops a staging run allows (A§21, T8.F). Off loopback a doc socket the network dropped (a heard 1006)
// whose replacement reached sync is the reconnect path working, not a finding: each one is listed, and a run passes
// with at most DROP_ALLOWANCE of them and none that never recovered. Each leg records its drops as a `network-drops`
// annotation (e2e/lib/actors.ts); the credential-free summary keeps them (canary-artifacts.mjs), and the run is judged
// across every job's summary here.
//   node scripts/deploy/network-drops.mjs check SUMMARY.json...
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The recovered drops one staging run may have, across every leg and job. */
export const DROP_ALLOWANCE = 2;

/** @typedef {{ doc: string, actor: string, at: number, recoveryMs: number | null, recovered: boolean }} Drop */

const DOC = /^[A-Za-z0-9_-]{1,64}$/;
const ACTOR = /^[\w-]{1,24}$/;

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
      drops.push({ doc: drop.doc, actor: drop.actor, at: Math.round(drop.at), recoveryMs, recovered: drop.recovered });
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
  const recovered = drops.filter((drop) => drop.recovered);
  const problems = [];
  if (recovered.length > DROP_ALLOWANCE) problems.push(`${recovered.length} recovered network drops (1006) in this run, ${DROP_ALLOWANCE} allowed`);
  const lost = drops.length - recovered.length;
  if (lost > 0) problems.push(`${lost} network drop${lost === 1 ? '' : 's'} (1006) never recovered to sync`);
  return { drops, problems };
}

/** One drop as a log line: its leg, doc, actor, time and recovery time. */
export const dropLine = (/** @type {Drop & { leg: string }} */ drop) =>
  `${drop.leg}: doc ${drop.doc} [${drop.actor}] at ${new Date(drop.at).toISOString()}, ` +
  `${drop.recovered ? `recovered in ${drop.recoveryMs === null ? '?' : `${drop.recoveryMs} ms`}` : 'never recovered'}`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, ...files] = process.argv.slice(2);
  if (mode !== 'check' || files.length === 0) {
    console.error('usage: network-drops.mjs check SUMMARY.json...');
    process.exit(2);
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
