// T8.D: the staging deploy pipeline's pure parts and its assertion script, against a fake Worker on loopback. The
// build job runs the same assertion against the real production-mode smoke stack (ci.yml).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployedProblems, hookProblems } from './assert-deployed.mjs';
import { canaryState } from './canary-state.mjs';
import { preflightProblems } from './preflight.mjs';
import { forbiddenFiles, migrationProblems, parseJsonc, readStagingEnv, stagingConfig } from './staging-config.mjs';
import { testedRunProblems } from './tested-run.mjs';

const COMMIT = 'c'.repeat(40);
const BUNDLE = 'b'.repeat(64);
const CLIENT = 'd'.repeat(64);
const D1_ID = '2f9a6c1e-0b7d-4e57-9c11-3a5d8e2b4f60';
const URL_STAGING = 'https://moss-multi-staging.example.workers.dev';

// The bare build's dist/server/wrangler.json (the cloudflare vite plugin's output, trimmed to what matters).
const BUILT = {
  topLevelName: 'moss-multi',
  definedEnvironments: ['staging'],
  targetEnvironment: '',
  compatibility_date: '2025-09-02',
  compatibility_flags: ['nodejs_compat'],
  rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }],
  name: 'moss-multi',
  main: 'index.js',
  assets: { directory: '../client' },
  vars: {},
  durable_objects: { bindings: [{ name: 'DocDO', class_name: 'DocDO' }, { name: 'PrincipalDO', class_name: 'PrincipalDO' }, { name: 'SearchDO', class_name: 'SearchDO' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['DocDO', 'PrincipalDO', 'SearchDO'] }],
  r2_buckets: [{ binding: 'ASSETS', bucket_name: 'moss-multi-assets' }],
  d1_databases: [{ binding: 'DB', database_name: 'moss-multi', database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: '../../drizzle' }],
  no_bundle: true,
};

describe('staging config', () => {
  it('parses JSONC comments without touching strings that hold comment markers', () => {
    expect(parseJsonc('{\n  // a comment\n  "url": "https://x/y", /* block */ "glob": "a/*b"\n}')).toEqual({ url: 'https://x/y', glob: 'a/*b' });
  });

  it('reads env.staging from apps/web/wrangler.jsonc with the permanent A§21 names', () => {
    const env = readStagingEnv();
    expect(env.name).toBe('moss-multi-staging');
    expect(env.d1_databases.map((db) => db.database_name)).toEqual(['moss-multi-staging']);
    expect(env.r2_buckets.map((r2) => r2.bucket_name)).toEqual(['moss-multi-staging-assets']);
    expect(env.durable_objects.bindings.map((b) => b.class_name)).toEqual(['DocDO', 'PrincipalDO', 'SearchDO']);
    expect(env.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['DocDO', 'PrincipalDO', 'SearchDO'] }]);
    expect(env.vars.MOSS_TEST_HOOKS).toBe('0');
  });

  it('lays env.staging over the tested build: names, bindings, vars and the looked-up D1 id; the code stays', () => {
    const config = stagingConfig(BUILT, readStagingEnv(), { d1Id: D1_ID, url: URL_STAGING });
    expect(config).toMatchObject({
      name: 'moss-multi-staging',
      targetEnvironment: 'staging',
      workers_dev: true,
      main: 'index.js',
      no_bundle: true,
      assets: { directory: '../client' },
      vars: { MOSS_TEST_HOOKS: '0', BETTER_AUTH_URL: URL_STAGING },
      r2_buckets: [{ binding: 'ASSETS', bucket_name: 'moss-multi-staging-assets' }],
      d1_databases: [{ binding: 'DB', database_name: 'moss-multi-staging', database_id: D1_ID, migrations_dir: '../../drizzle' }],
    });
    expect(config.rules).toEqual(BUILT.rules);
    expect(BUILT.name, 'the input is not mutated').toBe('moss-multi');
  });

  it('refuses a loopback or non-https URL, a placeholder D1 id outside a dry run, and renamed resources', () => {
    const env = readStagingEnv();
    expect(() => stagingConfig(BUILT, env, { d1Id: D1_ID, url: 'http://127.0.0.1:8850' })).toThrow(/https/);
    expect(() => stagingConfig(BUILT, env, { d1Id: D1_ID, url: 'https://localhost' })).toThrow(/loopback/);
    expect(() => stagingConfig(BUILT, env, { d1Id: '00000000-0000-0000-0000-000000000000', url: URL_STAGING })).toThrow(/D1 id/);
    expect(stagingConfig(BUILT, env, { d1Id: '00000000-0000-0000-0000-000000000000', url: URL_STAGING, dryRun: true }).name).toBe('moss-multi-staging');
    expect(() => stagingConfig(BUILT, { ...env, name: 'moss-multi-staging-2' }, { d1Id: D1_ID, url: URL_STAGING })).toThrow(/permanent/);
  });
});

describe('the upload guard', () => {
  let dist;
  beforeAll(() => {
    dist = mkdtempSync(join(os.tmpdir(), 't8d-dist-'));
    mkdirSync(join(dist, 'server/assets'), { recursive: true });
    mkdirSync(join(dist, 'client/assets'), { recursive: true });
    writeFileSync(join(dist, 'server/index.js'), 'export default {}');
    writeFileSync(join(dist, 'client/.assetsignore'), 'wrangler.json\n.dev.vars*\n.env*\n');
  });
  afterAll(() => rmSync(dist, { recursive: true, force: true }));

  it('passes a clean dist whose .assetsignore keeps local secret files out of the assets upload', () => {
    expect(forbiddenFiles(dist)).toEqual([]);
  });

  it('names every local secret file anywhere in the dist', () => {
    for (const path of ['server/.dev.vars', 'server/.dev.vars.staging', 'client/.env', 'client/assets/.env.local', 'server/key.pem']) {
      writeFileSync(join(dist, path), 'X=1');
    }
    expect(forbiddenFiles(dist).sort()).toEqual(['client/.env', 'client/assets/.env.local', 'server/.dev.vars', 'server/.dev.vars.staging', 'server/key.pem']);
    for (const path of ['server/.dev.vars', 'server/.dev.vars.staging', 'client/.env', 'client/assets/.env.local', 'server/key.pem']) rmSync(join(dist, path));
  });

  it('fails when .assetsignore does not exclude .dev.vars* and .env*', () => {
    writeFileSync(join(dist, 'client/.assetsignore'), 'wrangler.json\n.dev.vars\n');
    expect(forbiddenFiles(dist)).toEqual(['client/.assetsignore: missing .dev.vars*', 'client/.assetsignore: missing .env*']);
    writeFileSync(join(dist, 'client/.assetsignore'), 'wrangler.json\n.dev.vars*\n.env*\n');
  });
});

describe('D1 migrations', () => {
  it('apply in journal order, one file per entry', () => {
    expect(migrationProblems()).toEqual([]);
    const dir = mkdtempSync(join(os.tmpdir(), 't8d-drizzle-'));
    mkdirSync(join(dir, 'meta'));
    writeFileSync(join(dir, '0000_a.sql'), '');
    writeFileSync(join(dir, '0001_b.sql'), '');
    writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ entries: [{ idx: 0, tag: '0001_b' }, { idx: 1, tag: '0000_a' }] }));
    expect(migrationProblems(dir).length).toBeGreaterThan(0);
    writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ entries: [{ idx: 0, tag: '0000_a' }] }));
    expect(migrationProblems(dir)).toEqual(['0001_b.sql is not in the journal']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('preflight', () => {
  const ok = {
    CLOUDFLARE_API_TOKEN: 't'.repeat(40),
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    STAGING_URL: URL_STAGING,
    STAGING_BETTER_AUTH_SECRET: 's'.repeat(48),
    CANARY_POOL_SECRET: 'p'.repeat(48),
  };

  it('passes when every secret is configured', () => {
    expect(preflightProblems(ok)).toEqual([]);
  });

  it('names each missing secret, a loopback URL and a short secret', () => {
    expect(preflightProblems({ ...ok, CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: undefined })).toEqual([
      'secret CLOUDFLARE_API_TOKEN is not set',
      'secret CLOUDFLARE_ACCOUNT_ID is not set',
    ]);
    expect(preflightProblems({ ...ok, STAGING_URL: 'http://127.0.0.1:8850' })).toEqual(['secret STAGING_URL must be an https URL that is not loopback']);
    expect(preflightProblems({ ...ok, STAGING_BETTER_AUTH_SECRET: 'short' })).toEqual(['secret STAGING_BETTER_AUTH_SECRET must be at least 32 characters']);
  });
});

describe('the tested run', () => {
  const groups = ['shell', 'editing'];
  const job = (name, conclusion = 'success') => ({ name, conclusion });
  const jobs = [
    ...['plan', 'checks', 'build', 'editor-host', 'oracle', 'parity', 'viewer', 'editor', 'canary', 'ci-ok'].map((name) => job(name)),
    ...['chromium', 'webkit'].flatMap((engine) => groups.map((group) => job(`e2e (${engine}, ${group})`))),
  ];
  const run = { path: '.github/workflows/ci.yml', conclusion: 'success', event: 'workflow_dispatch', head_sha: COMMIT };

  it('accepts a green full lane in both engines over every journey group', () => {
    expect(testedRunProblems({ run, jobs, groups })).toEqual([]);
  });

  it('refuses a grep run, one engine, a failed shard, another workflow or a red run', () => {
    const grep = jobs.filter((j) => !j.name.startsWith('e2e')).concat([job('e2e (chromium, all)'), job('e2e (webkit, all)')]);
    expect(testedRunProblems({ run, jobs: grep, groups }).join('\n')).toMatch(/grep/);
    expect(testedRunProblems({ run, jobs: jobs.filter((j) => !j.name.includes('webkit')), groups }).join('\n')).toMatch(/webkit/);
    expect(testedRunProblems({ run, jobs: jobs.map((j) => (j.name === 'e2e (webkit, shell)' ? job(j.name, 'failure') : j)), groups }).join('\n')).toMatch(/e2e \(webkit, shell\): failure/);
    expect(testedRunProblems({ run: { ...run, path: '.github/workflows/main.yml' }, jobs, groups }).join('\n')).toMatch(/ci\.yml/);
    expect(testedRunProblems({ run: { ...run, conclusion: 'failure' }, jobs, groups }).join('\n')).toMatch(/failure/);
    expect(testedRunProblems({ run: { ...run, event: 'pull_request' }, jobs, groups }).join('\n')).toMatch(/pull_request/);
  });

  // `lane=e2e` plans no checks (scripts/ci/plan.mjs), so ci-ok is green with checks skipped: not a full lane.
  it.each(['checks', 'canary', 'parity', 'viewer', 'editor-host'])('refuses a run whose %s job was skipped or missing', (name) => {
    const skipped = jobs.map((j) => (j.name === name ? job(name, 'skipped') : j));
    expect(testedRunProblems({ run, jobs: skipped, groups })).toContain(`${name}: skipped`);
    expect(testedRunProblems({ run, jobs: jobs.filter((j) => j.name !== name), groups })).toContain(`${name}: missing`);
  });
});

describe('the canary state', () => {
  const base = { baseUrl: URL_STAGING, expected: { commit: COMMIT, bundleHash: BUNDLE, clientHash: CLIENT }, statePath: '/tmp/canary/state.json' };

  it('carries no hooks, the budget, the idle window and where the pool secret comes from', () => {
    expect(canaryState({ ...base, budget: 2000, idleMs: 20_000 })).toMatchObject({
      baseUrl: URL_STAGING,
      hooks: false,
      expected: base.expected,
      canary: { budget: 2000, idleMs: 20_000, poolSecretEnv: 'CANARY_POOL_SECRET', budgetPath: '/tmp/canary/requests.json' },
    });
  });

  it('refuses an idle under 15 s (SP14) and a missing budget', () => {
    expect(() => canaryState({ ...base, budget: 2000, idleMs: 10_000 })).toThrow(/15/);
    expect(() => canaryState({ ...base, budget: 0, idleMs: 20_000 })).toThrow(/budget/);
  });
});

// A fake Worker: /api/version, a shell page with one stylesheet and one module, and the unknown-route 404 (a fresh
// nonce on every response, as the real SSR 404 carries). `hooks` makes the hook paths answer; `bundle` is served.
function fakeWorker() {
  const options = { hooks: false, bundle: BUNDLE };
  let n = 0;
  const notFound = (res) => {
    n += 1;
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><script nonce="n${n}">1</script><title>Not found</title></head><body>Not found</body></html>`);
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/api/version') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ commit: COMMIT, bundleHash: options.bundle, clientHash: CLIENT }));
    } else if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><head><meta name="moss-build" content="${COMMIT}:${options.bundle}"><link rel="stylesheet" href="/a.css"><script type="module" src="/a.js"></script></head></html>`);
    } else if (path === '/a.css') {
      res.writeHead(200, { 'content-type': 'text/css' });
      res.end('body{}');
    } else if (path === '/a.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end('export {}');
    } else if (options.hooks && path.startsWith('/__test/') && (options.hooks === true || req.headers['x-moss-test-hook'] === options.hooks)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"instanceId":"x","constructedAt":1}');
    } else {
      notFound(res);
    }
  });
  return { server, options };
}

describe('the deployed-build assertion', () => {
  const { server, options } = fakeWorker();
  let baseUrl;
  const expected = { commit: COMMIT, bundleHash: BUNDLE, clientHash: CLIENT };
  beforeAll(async () => {
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((done) => server.close(done)));

  it('passes when /api/version is the tested bytes and every hook is the unknown-route 404', async () => {
    expect(await deployedProblems(baseUrl, expected)).toEqual([]);
  });

  it('fails when the served bundle is not the tested one', async () => {
    options.bundle = 'e'.repeat(64);
    try {
      expect((await deployedProblems(baseUrl, expected)).join('\n')).toMatch(/bundleHash/);
    } finally {
      options.bundle = BUNDLE;
    }
  });

  it('fails when a test hook answers', async () => {
    options.hooks = true;
    try {
      const problems = await hookProblems(baseUrl);
      expect(problems.join('\n')).toMatch(/\/__test\/docs\/[^/]+\/instance/);
      expect(problems.join('\n')).toMatch(/\/__test\/docs\/[^/]+\/reset/);
    } finally {
      options.hooks = false;
    }
  });

  // The negative control: hooks gated on a per-run secret answer only with it, so the run's secret proves the check.
  it('fails when a hook answers only to the per-run secret, given that secret', async () => {
    options.hooks = 'per-run-secret';
    try {
      expect(await hookProblems(baseUrl)).toEqual([]);
      const problems = (await hookProblems(baseUrl, { secret: 'per-run-secret' })).join('\n');
      expect(problems).toMatch(/\/__test\/docs\/[^/]+\/instance with the hook secret: 200/);
      expect(problems).toMatch(/\/__test\/docs\/[^/]+\/reset with the hook secret: 200/);
    } finally {
      options.hooks = false;
    }
  });
});
