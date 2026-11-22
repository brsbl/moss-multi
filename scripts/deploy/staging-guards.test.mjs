// T8.F (T8.B4): an outsider's sign-up on staging, where sign-up is open, can block neither the prune nor the growth
// guard; and a run's network drops are counted, listed and allowed up to DROP_ALLOWANCE (network-drops.mjs).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { canarySummary } from './canary-artifacts.mjs';
import * as growth from './growth.mjs';
import * as prune from './prune.mjs';

// node:sqlite through require, so the test bundler never resolves it: the generated SQL runs on SQLite, as on D1.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const NOW = Date.UTC(2026, 10, 21, 12);
const OLD = NOW - 3 * 60 * 60 * 1000;
const selected = (rows) => JSON.stringify([{ results: rows, success: true, meta: {} }]);
const counted = (users, docs) => JSON.stringify([{ results: [{ users, docs }], success: true, meta: {} }]);

/** A local D1: the user and docs columns the prune and the growth count read. */
function database(users) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)');
  db.exec('CREATE TABLE docs (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO user (id, email, created_at) VALUES (?, ?, ?)');
  for (const { id, email, created_at: at } of users) insert.run(id, email, at);
  return db;
}

const OUTSIDERS = ['MM-x@example.invalid', 'mm-a_b@example.invalid', 'mm-x@EXAMPLE.invalid', 'canary-1@example.invalid',
  'demo-ada@example.invalid', 'jane.doe@gmail.com'];
const PER_RUN = ['mm-staging-38656278214-w0-ada-1@example.invalid', 'mm-staging-1-1-chromium-3-w0-ada-7@example.invalid',
  'mm-s38625043292-1-c3-17@example.invalid'];

describe('the prune with outsiders on staging (T8.B4) @p:R15', () => {
  it('deletes only exact per-run principals among outsiders, and never throws on one', () => {
    const rows = [...OUTSIDERS, ...PER_RUN].map((email, n) => ({ id: `u${n}`, email }));
    let plan;
    expect(() => { plan = prune.prunePlan(counted(rows.length, 0), selected(rows)); }).not.toThrow();
    expect(plan.ids).toEqual(PER_RUN.map((_, n) => `u${OUTSIDERS.length + n}`));
    expect(plan.summary).toMatch(new RegExp(`skips ${OUTSIDERS.length}\\b`));
    // An id that is not a plain id is skipped too, never put in the SQL.
    const odd = prune.prunePlan(counted(1, 0), selected([{ id: "u1') OR 1=1 --", email: PER_RUN[0] }]));
    expect(odd.ids).toEqual([]);
    expect(odd.sql).toBe('');
  });

  it('selects with one predicate, the plan\'s own, case-sensitive and exact, on SQLite', () => {
    expect(typeof prune.PER_RUN_SQL).toBe('string');
    expect(prune.PER_RUN).toBeInstanceOf(RegExp);
    const near = [
      ...OUTSIDERS, ...PER_RUN,
      'mm-staging-1-a@example.invalid', 'mm-staging-1-@example.invalid', 'mm-staging--a@example.invalid', 'mm-staging-1a-b@example.invalid',
      'mm-staging-1-A@example.invalid', 'mm-staging-1-a.b@example.invalid', 'mm-staging-1-x@y@example.invalid', 'mm-staging-1--a@example.invalid',
      `mm-staging-${'1'.repeat(20)}-a@example.invalid`, `mm-staging-${'1'.repeat(21)}-a@example.invalid`,
      `mm-staging-1-${'a'.repeat(200)}@example.invalid`, `mm-staging-1-${'a'.repeat(201)}@example.invalid`,
      'mm-staging-1-a@example.invalidx', 'mm-staging-1-a@example_invalid', 'mm-staging-1-é@example.invalid', 'mm-stagingx-1-ada-1@example.invalid',
      'mm-s1-1-c1-1@example.invalid', 'mm-s1-1-c1-1x@example.invalid', 'mm-s1-1-z9-1@example.invalid', 'mm-s1-1-c9-1@example.invalid',
      'mm-s1-12345-c1-1@example.invalid', 'mm-s1-1-c1-12345@example.invalid', 'mm-s1-1-w8-1234@example.invalid', 'mm-s-1-c1-1@example.invalid',
      'mm-s1-1-c1-@example.invalid', 'mm-s1-c1-1@example.invalid', 'mm-sc1-1-c1-1@example.invalid', 'mm-s1-1-c1-1-1@example.invalid',
      'mm-s1-1-cc1-1@example.invalid', 'mm-s1-1-c1-1@example.invalid ', 'MM-S1-1-C1-1@example.invalid', 'mm-s1-1-c1-1%@example.invalid',
    ];
    // Random addresses over the characters the two shapes use.
    const alphabet = 'ms-tagin0123456789cw8xA_.@';
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const random = Array.from({ length: 3_000 }, () => {
      const prefix = next() < 0.5 ? 'mm-staging-' : 'mm-s';
      const body = Array.from({ length: 1 + Math.floor(next() * 14) }, () => alphabet[Math.floor(next() * alphabet.length)]).join('');
      return `${prefix}${body}@example.invalid`;
    });
    const emails = [...new Set([...near, ...random])];
    const db = database(emails.map((email, n) => ({ id: `u${n}`, email, created_at: OLD })));
    const matched = db.prepare(`SELECT email FROM user WHERE ${prune.PER_RUN_SQL} ORDER BY email`).all().map((row) => row.email);
    expect(matched).toEqual(emails.filter((email) => prune.PER_RUN.test(email)).sort());
    expect(matched.length).toBeGreaterThan(PER_RUN.length);
    const { select, count } = prune.pruneSql(NOW);
    for (const sql of [select, count]) {
      expect(sql).toContain(prune.PER_RUN_SQL);
      expect(sql).not.toMatch(/\bLIKE\b/);
    }
    expect(select).toMatch(/ORDER BY created_at, id LIMIT \d+$/);
  });

  it('prunes 100 per-run principals behind 5,000 older outsiders that look like them', () => {
    const outsiders = Array.from({ length: 5_000 }, (_, n) => ({
      id: `o${String(n).padStart(5, '0')}`,
      email: [`MM-staging-1-x${n}@example.invalid`, `mm-staging-1-a_b${n}@example.invalid`, `mm-staging-1-x${n}@EXAMPLE.invalid`,
        `mm-s1-1-c1-${n}x@example.invalid`, `mm-staging-1-x.${n}@example.invalid`][n % 5],
      created_at: OLD - 60_000 - n,
    }));
    const perRun = Array.from({ length: 100 }, (_, n) => ({ id: `p${String(n).padStart(3, '0')}`, email: `mm-staging-2-1-webkit-${n}@example.invalid`, created_at: OLD }));
    const db = database([...outsiders, ...perRun]);
    const { count, select } = prune.pruneSql(NOW);
    const plan = prune.prunePlan(selected(db.prepare(count).all()), selected(db.prepare(select).all()));
    expect(plan.ids).toEqual(perRun.map((row) => row.id));
    expect(plan.summary).toMatch(/holds 100 selected principals/);
    expect(plan.summary).toMatch(/skips 0\b/);
  });
});

describe('the growth guard with outsiders on staging (T8.B4) @p:R15', () => {
  const zero = { docs: 0, users: 0, suiteDocs: 0, suiteUsers: 0, d1Bytes: 0, docObjects: 0, principalObjects: 0 };

  it("does not block on outsiders' sign-ups, and reports staging's totals past their ceiling", () => {
    const crowded = { ...zero, users: 95_000, docs: 20_000, principalObjects: 90_000, suiteUsers: 4_000, suiteDocs: 900 };
    expect(growth.growthProblems(crowded)).toEqual([]);
    expect(typeof growth.growthNotices).toBe('function');
    const past = growth.growthNotices({ ...crowded, users: growth.GROWTH_CEILING.users + 1 });
    expect(past).toHaveLength(1);
    expect(past[0]).toMatch(/users.*goes on/);
  });

  it('still blocks when the per-run principals or their docs would pass the cap', () => {
    const users = growth.growthProblems({ ...zero, suiteUsers: growth.GROWTH_CAP.suiteUsers - growth.PER_FULL_RUN.suiteUsers + 1 });
    expect(users).toHaveLength(1);
    expect(users[0]).toMatch(/suiteUsers.*owner/);
    expect(growth.growthProblems({ ...zero, suiteDocs: growth.GROWTH_CAP.suiteDocs })).toHaveLength(1);
  });

  it('counts the suite\'s principals and docs with the prune\'s predicate, on SQLite', () => {
    const db = database([...OUTSIDERS, ...PER_RUN].map((email, n) => ({ id: `u${n}`, email, created_at: OLD })));
    db.exec(`INSERT INTO docs (id, owner_user_id) VALUES ('d1', 'u0'), ('d2', 'u${OUTSIDERS.length}'), ('d3', 'u${OUTSIDERS.length}')`);
    const sql = growth.GROWTH_COUNT_SQL;
    expect(typeof sql).toBe('string');
    const text = JSON.stringify([{ results: db.prepare(sql).all(), success: true, meta: { size_after: 4096 } }]);
    expect(growth.readGrowth(text)).toEqual({ docs: 3, users: OUTSIDERS.length + PER_RUN.length, suiteDocs: 2, suiteUsers: PER_RUN.length, d1Bytes: 4096 });
  });

  it('runs that count in the deploy before a full suite', () => {
    const workflow = yaml.load(readFileSync(new URL('../../.github/workflows/deploy-staging.yml', import.meta.url), 'utf8'));
    const step = workflow.jobs.deploy.steps.find((s) => /growth\.mjs check/.test(s.run ?? ''));
    expect(step.run).toMatch(/--command "\$\(node scripts\/deploy\/growth\.mjs count-sql\)"/);
  });
});

describe("a staging run's network drops (T8.F) @p:R15", () => {
  const drop = (doc, at, recovered = true, recoveryMs = 900) => ({ doc, actor: 'ben', at, recovered, recoveryMs: recovered ? recoveryMs : null });
  const row = (title, drops) => ({ title, status: 'passed', duration: 1, drops });

  it('fails a run with 3 recovered drops', async () => {
    const { dropVerdict } = await import('./network-drops.mjs');
    const verdict = dropVerdict([row('j01 › a', [drop('d1', NOW), drop('d2', NOW + 1)]), row('j02 › b', [drop('d3', NOW + 2)])]);
    expect(verdict.problems).toEqual(['3 recovered network drops (1006) in this run, 2 allowed']);
  });

  it('fails a run with one drop that never recovered', async () => {
    const { dropVerdict } = await import('./network-drops.mjs');
    expect(dropVerdict([row('j01 › a', [drop('d1', NOW, false)])]).problems).toEqual(['1 network drop (1006) never recovered to sync']);
  });

  it('passes a run with 2 recovered drops and reports both: doc, leg, time and recovery time', async () => {
    const { dropLine, dropVerdict } = await import('./network-drops.mjs');
    const verdict = dropVerdict([row('j01 › a', [drop('d1', NOW, true, 1_200)]), row('j02 › b', []), row('j03 › c', [drop('d2', NOW + 5_000, true, 300)])]);
    expect(verdict.problems).toEqual([]);
    expect(verdict.drops.map(dropLine)).toEqual([
      'j01 › a: doc d1 [ben] at 2026-11-21T12:00:00.000Z, recovered in 1200 ms',
      'j03 › c: doc d2 [ben] at 2026-11-21T12:00:05.000Z, recovered in 300 ms',
    ]);
  });

  it("keeps a leg's drops in the summary, fields checked, no text", () => {
    const annotation = { type: 'network-drops', description: JSON.stringify([
      drop('d1', NOW), { doc: 'https://x/?share=secret', actor: 'ben', at: NOW, recovered: true, recoveryMs: 1 }, { doc: 'd2', actor: 'ben', at: 'x', recovered: true },
    ]) };
    const results = { suites: [{ title: 'j01.spec.ts', specs: [{ title: 'leg', tests: [{ status: 'expected', results: [{ status: 'passed', duration: 7, annotations: [annotation] }] }] }] }] };
    expect(canarySummary(results)).toEqual({ tests: [{ title: 'j01.spec.ts › leg', status: 'passed', duration: 7, drops: [drop('d1', NOW)] }] });
    expect(JSON.stringify(canarySummary(results))).not.toContain('secret');
  });

  it('judges the run in a job after the canary and every suite shard, from their summaries', () => {
    const workflow = yaml.load(readFileSync(new URL('../../.github/workflows/deploy-staging.yml', import.meta.url), 'utf8'));
    const [name, job] = Object.entries(workflow.jobs).find(([, j]) => (j.steps ?? []).some((s) => /network-drops\.mjs check/.test(s.run ?? ''))) ?? [];
    expect(name, 'a job checks the network drops').toBeTruthy();
    expect([job.needs].flat()).toEqual(expect.arrayContaining(['canary', 'sp9', 'suite']));
    expect(job.if).toMatch(/always\(\)/);
    expect(JSON.stringify(job)).not.toMatch(/secrets\./);
  });
});
