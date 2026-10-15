#!/usr/bin/env node
// What a canary run may record and publish (A§21). Against any target but loopback, Playwright records no trace,
// screenshot or video: a trace carries the pooled sessions' cookies, and deploy-staging.yml's artifacts are public.
// The uploaded summary is each test's title, status and duration, never its error, URLs or attachments.
//   node scripts/deploy/canary-artifacts.mjs summary <results.json> <out.json>   (Playwright's JSON reporter output)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
 * @typedef {{ status?: string, duration?: number, errors?: { message?: string }[] }} Attempt
 * @typedef {{ title?: string, specs?: { title: string, tests?: { status?: string, results?: Attempt[] }[] }[], suites?: Suite[] }} Suite
 */

/**
 * One row per test: the suite path and test title, the last attempt's status and duration, and for a leg that passed
 * on its retry the infrastructure class its first attempt failed on (retry-gate.mjs; a label, never error text).
 * @param {{ suites?: Suite[] } | null} results
 */
export function canarySummary(results) {
  /** @type {{ title: string, status: string, duration: number, retry?: string }[]} */
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
        const row = { title: [...here, spec.title].join(' › '), status, duration: Number(last?.duration ?? 0) };
        tests.push(status === 'flaky' ? { ...row, retry: retryClass(test.results?.[0]?.errors) ?? 'not infrastructure' } : row);
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
