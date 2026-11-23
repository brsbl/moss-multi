#!/usr/bin/env node
// What a canary run may record and publish (A§21). Against any target but loopback, Playwright records no trace,
// screenshot or video: a trace carries the pooled sessions' cookies, and deploy-staging.yml's artifacts are public.
// The uploaded summary is each test's title, status, duration, numeric measures, setup resends and network drops
// (doc id, actor label, times), never its error, URLs or attachments.
//   node scripts/deploy/canary-artifacts.mjs summary <results.json> <out.json>   (Playwright's JSON reporter output)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dropsOf } from './network-drops.mjs';
import { retryClass } from './retry-gate.mjs';

/** The run log off loopback: titles, statuses and durations, never error text or test output. */
export const CANARY_REPORTER = fileURLToPath(new URL('./canary-reporter.mjs', import.meta.url));

/** @typedef {{ trace: 'retain-on-failure' | 'off', screenshot: 'only-on-failure' | 'off', video: 'off' }} Recording */

/** @type {Recording} What a run against a local stack records: a failure's trace and screenshot. */
export const RECORD_FAILURES = { trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'off' };
/** @type {Recording} */
const OFF = { trace: 'off', screenshot: 'off', video: 'off' };

/** @param {string | undefined} baseUrl */
export function isLoopback(baseUrl) {
  let host;
  try {
    host = new URL(baseUrl ?? '').hostname;
  } catch {
    return false;
  }
  return host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Playwright's trace, screenshot and video settings for a run against `baseUrl`; off unless it is loopback.
 * @param {string | undefined} baseUrl
 * @returns {Recording}
 */
export function recordingFor(baseUrl) {
  return isLoopback(baseUrl) ? { ...RECORD_FAILURES } : { ...OFF };
}

/**
 * @typedef {{ type?: string, description?: string }} Annotation
 * @typedef {{ status?: string, duration?: number, errors?: { message?: string }[], annotations?: Annotation[] }} Attempt
 * @typedef {{ title?: string, specs?: { title: string, tests?: { status?: string, annotations?: Annotation[], results?: Attempt[] }[] }[], suites?: Suite[] }} Suite
 * @typedef {{ title: string, status: string, duration: number, retry?: string, measures?: Record<string, Record<string, number>>, resends?: Record<string, number>, drops?: import('./network-drops.mjs').Drop[] }} Row
 */

/** The measure annotations a summary keeps, each as its named numeric fields only (SP9's near-cap upload, T8.2). */
const MEASURES = { 'sp9-near-cap': ['bytes', 'uploadMs'] };

/**
 * A test's measure annotations, numbers only: any other field or annotation, and any text, is dropped.
 * @param {Annotation[]} annotations
 */
function measuresOf(annotations) {
  /** @type {Record<string, Record<string, number>>} */
  const measures = {};
  for (const { type, description } of annotations) {
    const fields = Object.hasOwn(MEASURES, type ?? '') ? MEASURES[/** @type {keyof typeof MEASURES} */ (type)] : null;
    if (!fields) continue;
    let parsed;
    try {
      parsed = JSON.parse(String(description));
    } catch {
      continue;
    }
    /** @type {Record<string, number>} */
    const kept = {};
    for (const field of fields) if (typeof parsed?.[field] === 'number' && Number.isFinite(parsed[field])) kept[field] = parsed[field];
    if (Object.keys(kept).length) measures[/** @type {string} */ (type)] = kept;
  }
  return Object.keys(measures).length ? measures : null;
}

const RESEND_KINDS = new Set(['sign-in', 'sign-up', 'setup']);
const RESEND_CAUSES = { 429: 'a 429', 'lost forward': 'a lost forward', 'stale connection': 'a stale connection' };

/**
 * Setup's auth resends (`setup-resend` annotations, e2e/lib/principals.ts) by fixed label, e.g. `sign-in after a 429`,
 * with their counts; a malformed one is dropped.
 * @param {Annotation[]} annotations
 * @returns {Record<string, number>}
 */
export function resendsOf(annotations) {
  /** @type {Record<string, number>} */
  const resends = {};
  for (const { type, description } of annotations) {
    if (type !== 'setup-resend') continue;
    let parsed;
    try {
      parsed = JSON.parse(String(description));
    } catch {
      continue;
    }
    const cause = Object.hasOwn(RESEND_CAUSES, String(parsed?.cause)) ? RESEND_CAUSES[/** @type {keyof typeof RESEND_CAUSES} */ (String(parsed.cause))] : null;
    if (!RESEND_KINDS.has(parsed?.kind) || !cause || !Number.isInteger(parsed.count) || parsed.count < 1 || parsed.count > 1000) continue;
    const label = `${parsed.kind} after ${cause}`;
    resends[label] = (resends[label] ?? 0) + parsed.count;
  }
  return resends;
}

/**
 * Every attempt's annotations, or the test's when no attempt carries any (Playwright copies them to both).
 * @param {{ annotations?: Annotation[], results?: Attempt[] }} test
 */
const attemptAnnotations = (test) => {
  const attempts = (test.results ?? []).flatMap((result) => result.annotations ?? []);
  return attempts.length > 0 ? attempts : test.annotations ?? [];
};

/**
 * One row per test: the suite path and test title, the last attempt's status and duration, for a leg that passed on
 * its retry the infrastructure class its first attempt failed on (retry-gate.mjs; a label, never error text), its
 * measure annotations as numbers, setup's auth resends by label, and its network drops (network-drops.mjs).
 * @param {{ suites?: Suite[] } | null} results
 */
export function canarySummary(results) {
  /** @type {Row[]} */
  const tests = [];
  /**
   * @param {Suite} suite
   * @param {string[]} path
   */
  const walk = (suite, path) => {
    const here = suite.title ? [...path, suite.title] : path;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const last = test.results?.at(-1);
        const status = test.status === 'flaky' ? 'flaky' : String(last?.status ?? 'skipped');
        /** @type {Row} */
        const row = { title: [...here, spec.title].join(' › '), status, duration: Number(last?.duration ?? 0) };
        if (status === 'flaky') row.retry = retryClass(test.results?.[0]?.errors) ?? 'not infrastructure';
        const measures = measuresOf([...(test.annotations ?? []), ...(last?.annotations ?? [])]);
        if (measures) row.measures = measures;
        const annotations = attemptAnnotations(test);
        const resends = resendsOf(annotations);
        if (Object.keys(resends).length) row.resends = resends;
        const drops = dropsOf(annotations);
        if (drops.length) row.drops = drops;
        tests.push(row);
      }
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const suite of results?.suites ?? []) walk(suite, []);
  return { tests };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, resultsPath, out] = process.argv.slice(2);
  if (mode !== 'summary' || !resultsPath || !out) {
    console.error('usage: canary-artifacts.mjs summary <results.json> <out.json>');
    process.exit(2);
  }
  let results = null;
  try {
    results = JSON.parse(readFileSync(resultsPath, 'utf8'));
  } catch {
    console.error(`::warning::no Playwright results at ${resultsPath}`);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(canarySummary(results), null, 2)}\n`);
}
