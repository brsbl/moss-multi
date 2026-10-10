// T8.D: the staging deploy pipeline's pure parts and its assertion script, against a fake Worker on loopback. The
// build job runs the same assertion against the real production-mode smoke stack (ci.yml).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deployedProblems, hookProblems } from './assert-deployed.mjs';
import { canarySummary, recordingFor } from './canary-artifacts.mjs';
import { canaryState } from './canary-state.mjs';
import { growthProblems, GROWTH_CAP, PER_FULL_RUN, readGrowth } from './growth.mjs';
import { localOnlyProblems, scanJourneys } from './local-only.mjs';
import { preflightProblems } from './preflight.mjs';
import { gateProblems, runProblems } from './run-gate.mjs';
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
  const repo = { full_name: 'brsbl/moss-multi' };
  const run = { path: '.github/workflows/ci.yml', conclusion: 'success', event: 'workflow_dispatch', head_sha: COMMIT, repository: repo, head_repository: repo };

  it('refuses a run whose head repository is a fork', () => {
    const fork = { ...run, head_repository: { full_name: 'mallory/moss-multi' } };
    expect(testedRunProblems({ run: fork, jobs, groups, repository: 'brsbl/moss-multi' }).join('\n')).toMatch(/mallory\/moss-multi/);
    expect(testedRunProblems({ run, jobs, groups, repository: 'brsbl/moss-multi' })).toEqual([]);
  });

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

// The gate deploy-staging.yml runs from its own commit before any of the run's code or a secret is in reach.
describe('the run gate', () => {
  const REPO = 'brsbl/moss-multi';
  const TIP = 'e'.repeat(40);
  const repo = { full_name: REPO };
  const run = {
    id: 1,
    path: '.github/workflows/ci.yml',
    status: 'completed',
    conclusion: 'success',
    event: 'push',
    head_sha: COMMIT,
    head_branch: 'm8',
    repository: repo,
    head_repository: repo,
  };
  const ref = (sha, name = 'm8') => ({ ref: `refs/heads/${name}`, object: { sha, type: 'commit' } });
  const compare = (status, base = COMMIT) => ({ status, base_commit: { sha: base }, merge_base_commit: { sha: base } });
  const gate = (overrides) => gateProblems({ run, ref: ref(COMMIT), compare: compare('identical'), repository: REPO, ...overrides });

  it('passes a green push run at its branch head, and a few commits behind it', () => {
    expect(gate({})).toEqual([]);
    expect(gate({ run: { ...run, event: 'workflow_dispatch' } })).toEqual([]);
    expect(gate({ ref: ref(TIP), compare: compare('ahead') })).toEqual([]);
    expect(runProblems(run, REPO)).toEqual([]);
  });

  it('refuses a fork pull request run, even one whose own checks would pass', () => {
    const fork = { ...run, event: 'pull_request', head_branch: 'main', head_repository: { full_name: 'mallory/moss-multi' } };
    expect(gate({ run: fork }).join('\n')).toMatch(/mallory\/moss-multi/);
    expect(runProblems(fork, REPO).join('\n')).toMatch(/mallory\/moss-multi/);
  });

  it('refuses a same-repository pull request run', () => {
    expect(gate({ run: { ...run, event: 'pull_request' } }).join('\n')).toMatch(/pull_request/);
  });

  it('refuses a foreign head repository on a push-shaped run, and a run listed under another repository', () => {
    expect(gate({ run: { ...run, head_repository: { full_name: 'mallory/moss-multi' } } }).join('\n')).toMatch(/mallory/);
    expect(gate({ run: { ...run, repository: { full_name: 'mallory/moss-multi' } } }).join('\n')).toMatch(/mallory/);
    expect(gate({ run: { ...run, head_repository: null } })).not.toEqual([]);
    expect(gate({ repository: '' })).not.toEqual([]);
  });

  it('refuses another workflow, a failed or unfinished run, and a malformed head', () => {
    expect(gate({ run: { ...run, path: '.github/workflows/main.yml' } }).join('\n')).toMatch(/ci\.yml/);
    expect(gate({ run: { ...run, conclusion: 'failure' } }).join('\n')).toMatch(/failure/);
    expect(gate({ run: { ...run, status: 'in_progress', conclusion: null } }).join('\n')).toMatch(/in_progress/);
    expect(gate({ run: { ...run, head_sha: 'abc' } }).join('\n')).toMatch(/head_sha/);
    expect(gate({ run: { ...run, head_branch: '../../hooks' } }).join('\n')).toMatch(/branch/);
    expect(gate({ run: null })).not.toEqual([]);
  });

  it('refuses a run whose branch no longer exists', () => {
    expect(gate({ ref: null, compare: null }).join('\n')).toMatch(/m8 does not exist/);
    expect(gate({ ref: ref(COMMIT, 'm8-other') }).join('\n')).toMatch(/does not exist/);
  });

  it('refuses a head that is not reachable from its branch', () => {
    expect(gate({ ref: ref(TIP), compare: compare('diverged') }).join('\n')).toMatch(/not on m8/);
    expect(gate({ ref: ref(TIP), compare: compare('behind') }).join('\n')).toMatch(/not on m8/);
    expect(gate({ ref: ref(TIP), compare: null }).join('\n')).toMatch(/not on m8/);
    expect(gate({ ref: ref(TIP), compare: compare('ahead', TIP) }).join('\n')).toMatch(/not on m8/);
    expect(gate({ ref: ref(TIP), compare: compare('identical') }).join('\n')).toMatch(/not on m8/);
  });
});

const WORKFLOW = yaml.load(readFileSync(fileURLToPath(new URL('../../.github/workflows/deploy-staging.yml', import.meta.url)), 'utf8'));

describe('deploy-staging.yml', () => {
  const needsOf = (name) => [WORKFLOW.jobs[name].needs ?? []].flat();
  const upstream = (name) => needsOf(name).flatMap((need) => [need, ...upstream(need)]);
  const holdsSecret = (value) => JSON.stringify(value ?? {}).includes('secrets.');
  // A step that runs the run's code or holds a secret: a checkout of another ref, pnpm, or a secret in reach.
  const risky = (job, step) =>
    holdsSecret(job.env) ||
    holdsSecret(step.env) ||
    holdsSecret(step.with) ||
    holdsSecret(step.run) ||
    (step.uses?.startsWith('actions/checkout') && step.with?.ref !== undefined) ||
    step.uses?.startsWith('pnpm/') ||
    /\bpnpm\b/.test(step.run ?? '');

  it('decides whether the run may deploy before any of its code or any secret is in reach', () => {
    const gateJob = Object.keys(WORKFLOW.jobs).find((name) => WORKFLOW.jobs[name].steps.some((step) => step.id === 'gate'));
    expect(gateJob, 'a step with id gate').toBeTruthy();
    const steps = WORKFLOW.jobs[gateJob].steps;
    const at = steps.findIndex((step) => step.id === 'gate');
    expect(steps[at].run).toMatch(/scripts\/deploy\/run-gate\.mjs/);
    for (const step of steps.slice(0, at + 1)) expect(risky(WORKFLOW.jobs[gateJob], step), step.name ?? step.uses).toBe(false);
    // The only checkout before the gate is the workflow's own commit.
    for (const step of steps.slice(0, at)) if (step.uses?.startsWith('actions/checkout')) expect(step.with?.ref).toBeUndefined();
    expect(WORKFLOW.jobs[gateJob].outputs.sha).toBe('${{ steps.gate.outputs.sha }}');
    for (const [name, job] of Object.entries(WORKFLOW.jobs)) {
      if (name === gateJob) continue;
      for (const step of job.steps) {
        if (risky(job, step)) expect(upstream(name), `${name}: ${step.name ?? step.uses}`).toContain(gateJob);
        if (step.uses?.startsWith('actions/checkout') && step.with?.ref !== undefined) {
          expect(step.with.ref, `${name} checks out the gated sha`).toBe(`\${{ needs.${gateJob}.outputs.sha }}`);
        }
      }
    }
  });

  it("runs the staging canary with the config's reporters", () => {
    const run = WORKFLOW.jobs.canary.steps.find((step) => /playwright test/.test(step.run ?? '')).run;
    expect(run).toMatch(/--project=canary/);
    expect(run).not.toMatch(/--reporter|PLAYWRIGHT_/);
  });

  it('uploads only the credential-free canary files', () => {
    const uploads = Object.values(WORKFLOW.jobs).flatMap((job) => job.steps.filter((step) => step.uses?.startsWith('actions/upload-artifact')));
    expect(uploads.length).toBeGreaterThanOrEqual(1);
    for (const upload of uploads) {
      expect(upload.with.path.trim().split('\n').map((line) => line.trim()).sort()).toEqual(['e2e/canary-artifacts/requests.json', 'e2e/canary-artifacts/summary.json']);
    }
  });

  it('runs the full suite on staging only when dispatched with suite=full, after the canary, in both engines @p:R15', () => {
    const input = WORKFLOW.on.workflow_dispatch.inputs.suite;
    expect(input).toMatchObject({ type: 'choice', default: 'canary' });
    expect(input.options).toEqual(['canary', 'full']);
    const [name, job] = Object.entries(WORKFLOW.jobs).find(([, j]) => j.steps.some((step) => /--project="?staging-/.test(step.run ?? ''))) ?? [];
    expect(name, 'a job runs the staging projects').toBeTruthy();
    expect(job.if).toMatch(/inputs\.suite == 'full'/);
    expect(needsOf(name)).toEqual(expect.arrayContaining(['preflight', 'deploy', 'canary']));
    expect(job.strategy.matrix.browser).toEqual(['chromium', 'webkit']);
    expect(job.strategy['fail-fast']).toBe(false);
    const run = job.steps.find((step) => /playwright test/.test(step.run ?? '')).run;
    expect(run).toMatch(/--project=staging-"?\$\{?BROWSER/);
    expect(run).not.toMatch(/--reporter|PLAYWRIGHT_/);
    // The only narrowing is the suite_grep input, empty by default, for re-checking a staging-only failure.
    expect(run.match(/--grep\b.*/g)).toEqual(['--grep "$GREP" --pass-with-no-tests); echo "Only the legs matching --grep $GREP"; fi']);
    expect(WORKFLOW.on.workflow_dispatch.inputs.suite_grep).toMatchObject({ type: 'string', default: '' });
    expect(job.steps.find((step) => /playwright test/.test(step.run ?? '')).env.GREP).toBe('${{ inputs.suite_grep }}');
    // Per-run principals, never the pool secret, and this run's own budget.
    const state = job.steps.find((step) => /canary-state\.mjs/.test(step.run ?? ''));
    expect(state.run).toMatch(/--principals per-run/);
    expect(state.run).toMatch(/--budget/);
    expect(JSON.stringify(job)).not.toMatch(/CANARY_POOL_SECRET/);
  });
});

describe('the staging suite @p:R15', () => {
  it('tags every journey leg that needs the local stack @local-only, each with a reason', () => {
    const scan = scanJourneys();
    expect(scan.flatMap((spec) => spec.problems)).toEqual([]);
    const local = Object.fromEntries(scan.filter((spec) => spec.localOnly.length > 0).map((spec) => [spec.file, spec.localOnly.length]));
    for (const file of ['j00-roundtrip.spec.ts', 'j01-registers.spec.ts', 'j02-title.spec.ts', 'j03-connection.spec.ts', 'j04-hibernation.spec.ts']) {
      expect(local[file], file).toBeGreaterThan(0);
    }
    // A hook read alone is not local: the owner-only instance route answers it on staging, so j09's cold wake and
    // j04's warm creator run there.
    expect(local['j09-revoke-live.spec.ts'], 'j09 cold runs on staging').toBeUndefined();
    // The wake on staging is j04's owner-route leg, which stays in the suite.
    expect(readFileSync(fileURLToPath(new URL('../../e2e/journeys/j04-hibernation.spec.ts', import.meta.url)), 'utf8')).toMatch(/owner-only route @staging/);
  });

  it('flags an untagged hook leg, a stack lever, the default hook probe, and a tag with no reason', () => {
    const spec = [
      "test('probes', async ({ stack }) => { await stack.docInstance('d'); });",
      "test('restarts', async ({ stack }) => { await induce(stack, { docId, lever: 'restart', probe: p }); });",
      "test('hook probe', async ({ stack }) => { await induce(stack, { docId }); });",
      "test('tagged @local-only', async ({ stack }) => { await stack.pause(); });",
      '// local-only: SIGSTOPs the stack.',
      "test('explained @local-only', async ({ stack }) => { await stack.pause(); });",
      "test('owner route', async ({ stack }) => { await induce(stack, { docId, lever: canary ? 'idle' : 'reset', probe: ownerProbe(stack, a) }); });",
      'for (const s of [1, 2]) {',
      '  // local-only: resets the DO through the hook.',
      "  test(`loop ${s === 2 ? ' @local-only' : ''}`, async ({ stack }) => { if (s === 2) await stack.resetDoc('d'); });",
      '}',
      '// local-only: reads the DO through the loopback hook.',
      "test('hook read @local-only', async ({ stack }) => { await stack.docInstance('d'); });",
      '// local-only: serves a page on another port of the stack host.',
      "test('other origin @local-only', async ({ stack }) => { await servePage(host); });",
    ].join('\n');
    const problems = localOnlyProblems(spec, 'x.spec.ts');
    expect(problems).toHaveLength(5);
    expect(problems[0]).toMatch(/x\.spec\.ts:1 uses a test hook/);
    expect(problems[1]).toMatch(/:2 uses a restart or reset lever/);
    expect(problems[2]).toMatch(/:3 uses induce\(\) with the hook probe/);
    expect(problems[3]).toMatch(/:4 is @local-only with no/);
    expect(problems[4]).toMatch(/:13 is @local-only but uses no local-only lever/);
  });

  it('runs every journey but the @local-only legs in each engine on staging, recording nothing', async () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'suite-config-'));
    try {
      const statePath = join(dir, 'state.json');
      writeFileSync(statePath, JSON.stringify({ baseUrl: URL_STAGING }));
      vi.stubEnv('STACK_STATE', statePath);
      vi.resetModules();
      const config = (await import('../../e2e/playwright.config.ts')).default;
      for (const engine of ['chromium', 'webkit']) {
        const project = config.projects.find((p) => p.name === `staging-${engine}`);
        expect(project, engine).toBeTruthy();
        expect(project.testDir).toMatch(/journeys$/);
        expect(project.dependencies ?? []).toEqual([]);
        expect(project.grep).toBeUndefined();
        expect(project.grepInvert.test('j03 a leg @local-only @p:col-6')).toBe(true);
        expect(project.grepInvert.test('j04-hibernation: proven through the owner-only route @staging')).toBe(false);
        expect({ ...config.use, ...project.use }).toMatchObject({ browserName: engine, trace: 'off', screenshot: 'off', video: 'off' });
      }
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('canary recording', () => {
  const RETAIN = { trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'off' };
  const OFF = { trace: 'off', screenshot: 'off', video: 'off' };

  it('keeps traces against a loopback stack', () => {
    for (const url of ['http://127.0.0.1:8850', 'http://localhost:8787', 'http://[::1]:8850', 'http://127.4.5.6']) expect(recordingFor(url), url).toEqual(RETAIN);
  });

  it('turns trace, screenshot and video off for any other target, and when the target is unknown', () => {
    for (const url of [URL_STAGING, 'http://10.0.0.5:8850', 'http://127.0.0.1.example.com', 'http://localhost.example.com', 'not a url', '', undefined]) {
      expect(recordingFor(url), String(url)).toEqual(OFF);
    }
  });

  it('resolves the canary project from STACK_STATE in e2e/playwright.config.ts', async () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'canary-config-'));
    const load = async (baseUrl) => {
      const statePath = join(dir, `${encodeURIComponent(baseUrl)}.json`);
      writeFileSync(statePath, JSON.stringify({ baseUrl }));
      vi.stubEnv('STACK_STATE', statePath);
      vi.resetModules();
      const config = (await import('../../e2e/playwright.config.ts')).default;
      return { ...config.use, ...config.projects.find((project) => project.name === 'canary').use };
    };
    try {
      expect(await load(URL_STAGING)).toMatchObject(OFF);
      expect(await load('http://127.0.0.1:8850')).toMatchObject(RETAIN);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A failed authenticated request's error carries Playwright's call log, which lists the request's cookie header;
  // the public run log must not print it. Runs the real config's canary project on a synthetic failure.
  describe('the run log', () => {
    const E2E = fileURLToPath(new URL('../../e2e/', import.meta.url));
    const SESSION = 'better-auth.session_token=SYNTHETIC';
    const runCanary = (baseUrl) => {
      const dir = mkdtempSync(join(E2E, '.canary-log-'));
      const config = `${dir}.config.ts`;
      const message = `apiRequestContext.get: read ECONNRESET\nCall log:\n  - → GET ${baseUrl}/api/me\n    - cookie: ${SESSION}-CALLLOG`;
      try {
        writeFileSync(join(dir, 'state.json'), JSON.stringify({ baseUrl, expected: { commit: COMMIT, bundleHash: BUNDLE } }));
        writeFileSync(
          join(dir, 'leak.spec.ts'),
          [
            "import { test } from '@playwright/test';",
            "test('a request fails with a session in its call log', () => {",
            `  console.log(${JSON.stringify(`cookie: ${SESSION}-STDOUT`)});`,
            `  console.error(${JSON.stringify(`cookie: ${SESSION}-STDERR`)});`,
            `  throw new Error(${JSON.stringify(message)});`,
            '});',
            '',
          ].join('\n'),
        );
        writeFileSync(
          config,
          [
            "import base from './playwright.config.ts';",
            "const canary = base.projects.find((project) => project.name === 'canary');",
            `export default { ...base, testDir: ${JSON.stringify(dir)}, outputDir: ${JSON.stringify(join(dir, 'out'))}, projects: [{ name: 'canary', use: canary.use }] };`,
            '',
          ].join('\n'),
        );
        const cli = join(dirname(createRequire(join(E2E, 'package.json')).resolve('@playwright/test')), 'cli.js');
        const env = { ...process.env, CI: 'true', STACK_STATE: join(dir, 'state.json') };
        delete env.GITHUB_STEP_SUMMARY;
        const run = spawnSync(process.execPath, [cli, 'test', '-c', config], { cwd: E2E, env, encoding: 'utf8', timeout: 90_000 });
        return { status: run.status, output: `${run.stdout}${run.stderr}` };
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(config, { force: true });
      }
    };

    it('prints each result but no error text, call log or test output off loopback', () => {
      const { status, output } = runCanary(URL_STAGING);
      expect(status, output).toBe(1);
      expect(output).toMatch(/a request fails with a session in its call log/);
      expect(output).toMatch(/failed/);
      expect(output).not.toMatch(/SYNTHETIC/);
      expect(output).not.toContain(URL_STAGING);
    }, 120_000);

    it('keeps the full error on a loopback stack (the control)', () => {
      const { status, output } = runCanary('http://127.0.0.1:8850');
      expect(status, output).toBe(1);
      expect(output).toMatch(/SYNTHETIC-CALLLOG/);
    }, 120_000);

    it("prints a failure's suite source lines, kind and invariant facts, and no text of the error", async () => {
      const { failureTrace } = await import('./canary-reporter.mjs');
      const message = [
        'invariants: 5 finding(s)',
        `  invariant 1 [ada] HTTP 404 GET ${URL_STAGING}/s/Zq9SHARE-TOKEN7x/assets/9f8e7d6c-5b4a-4321-8fed-cba987654321 (undeclared)`,
        `  invariant 1 [ada] console error: Failed to load resource (${URL_STAGING}/api/me?token=SECRET)`,
        `  invariant 3 [ben] 9f8e7d6c-5b4a-4321-8fed-cba987654321: 2 socket opens in one document, 1 allowed`,
        '  invariant 7 [ben] 9f8e7d6c-5b4a-4321-8fed-cba987654321 title: "Suggest refusal" appears 0 time(s), typed 1',
        `  invariant 2 [cy] cookie: ${SESSION}`,
      ].join('\n');
      const stack = [
        `Error: ${message}`,
        `    at Actors.fail (/__w/moss-multi/moss-multi/e2e/lib/actors.ts:260:11)`,
        `    at /__w/moss-multi/moss-multi/e2e/journeys/j09-revoke-live.spec.ts:121:5`,
        `    at fetch (${URL_STAGING}/api/me?token=SECRET:1:1)`,
      ].join('\n');
      const lines = failureTrace({ errors: [{ message, stack }] });
      expect(lines).toEqual([
        'at e2e/lib/actors.ts:260 < e2e/journeys/j09-revoke-live.spec.ts:121',
        'invariant 1 [ada] HTTP 404 GET /s/:id/assets/:id',
        'invariant 1 [ada] console error',
        'invariant 3 [ben] 2 socket opens, 1 allowed',
        'invariant 7 [ben] title appears 0, typed 1',
        'invariant 2 [cy]',
      ]);
      expect(lines.join('\n')).not.toMatch(/SYNTHETIC|SHARE-TOKEN|SECRET|Suggest refusal|workers\.dev|9f8e7d6c/);
      expect(failureTrace({ status: 'passed' })).toEqual([]);
      const timedOut = { message: `expect(locator).toHaveAttribute(expected) failed\nLocator: a[href="${URL_STAGING}/s/SHARE-TOKEN"]\nTimeout 10000ms exceeded`, stack: '' };
      expect(failureTrace({ errors: [timedOut] })).toEqual(['kind timeout, expect']);
    });

    it('prints a field still unbound and numeric expected and received values, never text values', async () => {
      const { failureTrace } = await import('./canary-reporter.mjs');
      const unbound = { message: 'invariants: 1 finding(s)\n  invariant 7 [ben] 9f8e7d6c-5b4a-4321-8fed-cba987654321 body: still unbound after 15 s', stack: '' };
      expect(failureTrace({ errors: [unbound] })).toEqual(['invariant 7 [ben] body still unbound']);
      const late = { message: 'Error: within 1 s of the demotion\n\nexpect(received).toBeLessThan(expected)\n\nExpected: < 1000\nReceived:   1234', stack: '' };
      expect(failureTrace({ errors: [late] })).toEqual(['kind expect', 'expected < 1000, received 1234']);
      const text = { message: `expect(received).toBe(expected)\n\nExpected: "${SESSION}"\nReceived: "SYNTHETIC text"`, stack: '' };
      expect(failureTrace({ errors: [text] })).toEqual(['kind expect']);
      const kinds = { message: [
        'invariants: 3 finding(s)',
        `  invariant 1 [ada] console error: Failed to load resource: the server responded with a status of 404 () (${URL_STAGING}/api/docs/x/backlinks)`,
        `  invariant 1 [ben] console error: WebSocket connection to '${URL_STAGING.replace('https', 'wss')}/parties/doc-d-o/x?token=SECRET' failed`,
        '  invariant 3 [ben] 9f8e7d6c: 2 socket opens in one document, 1 allowed (1 errored; lived 12 ms (1006), open)',
      ].join('\n'), stack: '' };
      const facts = failureTrace({ errors: [kinds] });
      expect(facts).toEqual([
        'invariant 1 [ada] console error (load 404)',
        'invariant 1 [ben] console error (websocket)',
        'invariant 3 [ben] 2 socket opens, 1 allowed (1 errored; lived 12 ms (1006), open)',
      ]);
      expect(facts.join('\n')).not.toMatch(/SECRET|workers\.dev|backlinks/);
    });

    it("prints a failed wake proof's induction problems as fixed facts, never the instance ids", async () => {
      const { failureTrace } = await import('./canary-reporter.mjs');
      const esc = String.fromCharCode(27);
      const message = [
        'Error: the revocation met a woken DO',
        '',
        `${esc}[2mexpect(${esc}[22m${esc}[31mreceived${esc}[39m${esc}[2m).${esc}[22mtoEqual${esc}[2m(${esc}[22m${esc}[32mexpected${esc}[39m${esc}[2m)${esc}[22m`,
        '+ Array [',
        `+   "instance 9f8e7d6c-SYNTHETIC still serves the doc",`,
        '+   "instance constructed at 1760000000000, not after the baseline\'s 1760000000000",',
        '+   "instance constructed 31234 ms before the decisive action, so something else woke it",',
        '+   "instance constructed 4321 ms after the decisive action ended, so something else woke it",',
        '+ ]',
      ].join('\n');
      const lines = failureTrace({ errors: [{ message, stack: '' }] });
      expect(lines).toEqual([
        'kind expect',
        'induction: the same instance serves the doc',
        'induction: not constructed after the baseline',
        'induction: constructed 31234 ms before the decisive action',
        'induction: constructed 4321 ms after the decisive action ended',
      ]);
      expect(lines.join('\n')).not.toMatch(/SYNTHETIC|9f8e7d6c|1760000000000/);
      const induced = { message: 'Error: hibernation not induced (idle): instance abc still serves the doc', stack: '' };
      expect(failureTrace({ errors: [induced] })).toEqual(['induction: the same instance serves the doc']);
    });

    it('withholds a run-level error and test output off loopback', async () => {
      const { default: CanaryReporter } = await import('./canary-reporter.mjs');
      const lines = [];
      const log = vi.spyOn(console, 'log').mockImplementation((...args) => lines.push(args.join(' ')));
      const error = vi.spyOn(console, 'error').mockImplementation((...args) => lines.push(args.join(' ')));
      try {
        const reporter = new CanaryReporter();
        expect(reporter.printsToStdio()).toBe(true);
        reporter.onError?.({ message: `cookie: ${SESSION}`, stack: `cookie: ${SESSION}` });
        reporter.onStdOut?.(`cookie: ${SESSION}`);
        reporter.onStdErr?.(`cookie: ${SESSION}`);
      } finally {
        log.mockRestore();
        error.mockRestore();
      }
      expect(lines.join('\n')).not.toMatch(/SYNTHETIC/);
      expect(lines.join('\n')).toMatch(/error/i);
    });
  });

  it('summarizes results as title, status and duration only', () => {
    const failed = { status: 'failed', duration: 1234, error: { message: 'Cookie: better-auth.session_token=SECRET' }, attachments: [{ name: 'trace', path: '/x/trace.zip' }] };
    const results = {
      suites: [
        {
          title: 'journeys/j00-shell.spec.ts',
          specs: [],
          suites: [{ title: 'j00 shell', specs: [{ title: 'signs in', tests: [{ projectName: 'canary', results: [failed] }] }] }],
        },
      ],
    };
    const summary = canarySummary(results);
    expect(summary).toEqual({ tests: [{ title: 'journeys/j00-shell.spec.ts › j00 shell › signs in', status: 'failed', duration: 1234 }] });
    expect(JSON.stringify(summary)).not.toMatch(/SECRET|trace\.zip|Cookie/);
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

  it('signs in the fixed pool by default, and per-run principals for the full suite', () => {
    expect(canaryState({ ...base, budget: 2000, idleMs: 20_000 }).canary.principals).toBe('pool');
    expect(canaryState({ ...base, budget: 5000, idleMs: 20_000, principals: 'per-run' }).canary.principals).toBe('per-run');
    expect(() => canaryState({ ...base, budget: 2000, idleMs: 20_000, principals: 'mine' })).toThrow(/principals/);
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

describe('staging growth (A§21) @p:R15', () => {
  // `wrangler d1 execute --json` for the count query deploy-staging.yml runs before a full suite.
  const counted = (docs, users, bytes) => JSON.stringify([{ results: [{ docs, users }], success: true, meta: { size_after: bytes } }]);

  it('reads the counts and the database size', () => {
    expect(readGrowth(counted(4252, 6958, 18_710_528))).toEqual({ docs: 4252, users: 6958, d1Bytes: 18_710_528 });
    expect(() => readGrowth('[]')).toThrow(/count/);
    expect(() => readGrowth(counted('x', 1, 1))).toThrow(/count/);
  });

  it('refuses a full suite that would carry staging past its cap, and says what the owner decides', () => {
    expect(growthProblems({ docs: 4252, users: 6958, d1Bytes: 18_710_528 })).toEqual([]);
    const near = growthProblems({ docs: GROWTH_CAP.docs - PER_FULL_RUN.docs + 1, users: 0, d1Bytes: 0 });
    expect(near).toHaveLength(1);
    expect(near[0]).toMatch(/docs/);
    expect(near[0]).toMatch(/owner/);
    expect(growthProblems({ docs: 0, users: GROWTH_CAP.users, d1Bytes: GROWTH_CAP.d1Bytes })).toHaveLength(2);
  });

  it('checks the cap before a full-suite deploy, and never for the canary', () => {
    const steps = WORKFLOW.jobs.deploy.steps;
    const check = steps.findIndex((step) => /growth\.mjs/.test(step.run ?? ''));
    expect(check, 'a growth check step').toBeGreaterThan(-1);
    expect(steps[check].if).toMatch(/inputs\.suite == 'full'/);
    expect(check).toBeLessThan(steps.findIndex((step) => /WRANGLER" deploy/.test(step.run ?? '')));
    expect(steps[check].run).toMatch(/d1 execute moss-multi-staging --remote --json/);
  });
});
