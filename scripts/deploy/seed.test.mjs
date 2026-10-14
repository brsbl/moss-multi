// T8.2: the staging suite's seeded principals. Staging caps sign-ups at 30 a day per address (auth.ts), so the deploy
// job writes this run's per-run accounts into D1 and each suite shard signs in to its own slots.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { canaryState } from './canary-state.mjs';
import { PER_FULL_RUN } from './growth.mjs';
import { prunePlan, PRUNE_CAP } from './prune.mjs';
import { claimSlot, SEED_PER_SHARD, SEED_SLOTS, seedEmail, seedHash, seedSql, seedToken, suitePassword } from './seed.mjs';

const WORKFLOW = yaml.load(readFileSync(new URL('../../.github/workflows/deploy-staging.yml', import.meta.url), 'utf8'));
const SECRET = 'k'.repeat(64);
const HASH = `${'a'.repeat(32)}:${'b'.repeat(128)}`;

describe('the staging suite seed (T8.2) @p:R15', () => {
  it('names one slot set per suite shard, each email a per-run principal the prune may take', () => {
    expect(SEED_SLOTS).toHaveLength(16);
    expect(new Set(SEED_SLOTS).size).toBe(16);
    const token = seedToken('38625043292', '1');
    expect(token).toBe('s38625043292-1');
    const email = seedEmail(token, 'c3', 17);
    expect(email).toBe('mm-s38625043292-1-c3-17@example.invalid');
    const plan = prunePlan(JSON.stringify([{ results: [{ users: 1, docs: 0 }] }]), JSON.stringify([{ results: [{ id: 'a'.repeat(32), email }] }]));
    expect(plan.ids).toEqual(['a'.repeat(32)]);
    expect(() => seedToken('12; DROP', '1')).toThrow(/run id/);
  });

  it('derives one password per run from the pool secret, long enough for staging and never the secret', () => {
    const one = suitePassword(SECRET, 's1-1');
    expect(one).toBe(suitePassword(SECRET, 's1-1'));
    expect(one).not.toBe(suitePassword(SECRET, 's2-1'));
    expect(one.length).toBeGreaterThanOrEqual(12);
    expect(one).not.toContain(SECRET.slice(0, 12));
    expect(() => suitePassword('short', 's1-1')).toThrow(/32/);
  });

  it("hashes the password as better-auth's sign-in verifies it", async () => {
    const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
    const { verifyPassword } = await import(pathToFileURL(require.resolve('better-auth/crypto')).href);
    const password = suitePassword(SECRET, 's1-1');
    const hash = await seedHash(password);
    expect(await verifyPassword({ hash, password })).toBe(true);
    expect(await verifyPassword({ hash, password: `${password}x` })).toBe(false);
  });

  it('writes a user and a credential account per slot, as a sign-up does, in bounded statements', () => {
    let n = 0;
    const sql = seedSql({ token: 's9-1', slots: ['c1', 'w1'], perShard: 150, hash: HASH, now: 1_000, newId: () => `id${String(n++).padStart(30, '0')}` });
    const users = sql.match(/^INSERT INTO user \(id, name, email, email_verified, image, created_at, updated_at\) VALUES/gm);
    const accounts = sql.match(/^INSERT INTO account \(id, account_id, provider_id, user_id, password, created_at, updated_at\) VALUES/gm);
    expect(users).toHaveLength(3);
    expect(accounts).toHaveLength(3);
    expect(sql.match(/'credential'/g)).toHaveLength(300);
    expect(sql).toContain("'mm-s9-1-c1-0@example.invalid'");
    expect(sql).toContain("'mm-s9-1-w1-149@example.invalid'");
    expect(sql).not.toContain('-c1-150@');
    // The account row points at its user and carries the hash, never a password.
    expect(sql).toContain(`('id${'0'.repeat(29)}1', 'id${'0'.repeat(30)}', 'credential', 'id${'0'.repeat(30)}', '${HASH}', 1000, 1000)`);
    expect(() => seedSql({ token: 's9-1', slots: ['c1'], perShard: 1, hash: "x'); DROP TABLE user; --", now: 1, newId: () => 'a'.repeat(32) })).toThrow(/hash/);
  });

  it('gives each slot to one claimant, across processes, and none past the count', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'seed-claims-'));
    try {
      expect([claimSlot(dir, 3), claimSlot(dir, 3), claimSlot(dir, 3)]).toEqual([0, 1, 2]);
      expect(claimSlot(dir, 3)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a seeded canary state names its token, slots, count and password env, and nothing secret', () => {
    const state = canaryState({
      baseUrl: 'https://x.example', expected: { commit: 'c', bundleHash: 'b', clientHash: 'd' }, statePath: '/tmp/s/state.json',
      budget: 10, idleMs: 20_000, principals: 'seeded', seed: { token: 's9-1', slots: 'w4' },
    });
    expect(state.canary.principals).toBe('seeded');
    expect(state.canary.seed).toEqual({ token: 's9-1', slots: 'w4', count: SEED_PER_SHARD, passwordEnv: 'MOSS_SUITE_PASSWORD', claimDir: '/tmp/s/seed-claims' });
    expect(() => canaryState({ ...state, baseUrl: 'https://x.example', budget: 10, idleMs: 20_000, principals: 'seeded', seed: { token: 's9-1', slots: 'z9' } })).toThrow(/slots/);
  });

  it('fits a full suite under the growth cap once the prune ran', () => {
    expect(PER_FULL_RUN.users).toBeGreaterThanOrEqual(SEED_SLOTS.length * SEED_PER_SHARD);
    expect(PRUNE_CAP).toBeGreaterThanOrEqual(PER_FULL_RUN.users);
  });

  it('seeds after the prune and growth check, before the deploy; the shards sign in with a masked derived password', () => {
    const steps = WORKFLOW.jobs.deploy.steps;
    const seed = steps.findIndex((step) => /seed\.mjs sql/.test(step.run ?? ''));
    expect(seed, 'a seed step').toBeGreaterThan(-1);
    expect(steps[seed].if).toMatch(/inputs\.suite == 'full'/);
    expect(seed).toBeGreaterThan(steps.findIndex((step) => /growth\.mjs/.test(step.run ?? '')));
    expect(seed).toBeLessThan(steps.findIndex((step) => /WRANGLER" deploy/.test(step.run ?? '')));
    expect(steps[seed].run).toMatch(/--file/);
    expect(steps[seed].run).toMatch(/> \/dev\/null/);
    expect(WORKFLOW.jobs.deploy.outputs.seedToken).toBeTruthy();

    const suite = WORKFLOW.jobs.suite.steps;
    const password = suite.find((step) => /seed\.mjs password/.test(step.run ?? ''));
    expect(password, 'a password step').toBeTruthy();
    expect(password.env.CANARY_POOL_SECRET).toMatch(/secrets\.CANARY_POOL_SECRET/);
    expect(password.run).toMatch(/::add-mask::/);
    expect(password.run.indexOf('::add-mask::')).toBeLessThan(password.run.indexOf('GITHUB_ENV'));
    const journeys = suite.find((step) => /playwright test/.test(step.run ?? ''));
    expect(journeys.env.CANARY_POOL_SECRET, 'the pool secret never reaches the journeys').toBeUndefined();
    const state = suite.find((step) => /canary-state\.mjs/.test(step.run ?? ''));
    expect(state.run).toMatch(/--principals seeded/);
    expect(state.run).toMatch(/--seed-token/);
  });
});
