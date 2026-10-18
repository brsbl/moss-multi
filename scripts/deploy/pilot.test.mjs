// T8.P1: the pilot deployment for the owner's real notes, apart from staging. Its config, preflight, workflow shape,
// read-only smoke, and the guards that keep every suite, canary, sweep and demo off it.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pilotProblems } from './assert-deployed.mjs';
import { canaryState } from './canary-state.mjs';
import { preflightProblems } from './preflight.mjs';
import { isPilotTarget, readStagingEnv, readTargetEnv, stagingConfig, TARGETS, targetConfig } from './staging-config.mjs';

const D1_ID = '7c1e2b3a-4d5f-4a6b-8c9d-0e1f2a3b4c5d';
const URL_PILOT = 'https://moss-multi-pilot.example.workers.dev';
const BUILT = {
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

describe('the pilot config', () => {
  it('has its own permanent Worker, D1 and R2 names, none shared with staging', () => {
    expect(TARGETS.pilot).toEqual({ worker: 'moss-multi-pilot', d1: 'moss-multi-pilot', r2: 'moss-multi-pilot-assets' });
    const staging = Object.values(TARGETS.staging);
    for (const name of Object.values(TARGETS.pilot)) expect(staging).not.toContain(name);
  });

  it('reads env.pilot: no test hooks, sign-up by allowlist only, the same DO classes', () => {
    const env = readTargetEnv('pilot');
    expect(env.name).toBe('moss-multi-pilot');
    expect(env.d1_databases.map((db) => db.database_name)).toEqual(['moss-multi-pilot']);
    expect(env.r2_buckets.map((r2) => r2.bucket_name)).toEqual(['moss-multi-pilot-assets']);
    expect(env.durable_objects.bindings.map((b) => b.class_name)).toEqual(['DocDO', 'PrincipalDO', 'SearchDO']);
    expect(env.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['DocDO', 'PrincipalDO', 'SearchDO'] }]);
    expect(env.vars).toEqual({ MOSS_TEST_HOOKS: '0', MOSS_SIGN_UP: 'allowlist' });
    expect(readStagingEnv().vars.MOSS_SIGN_UP, 'staging keeps open sign-up').toBeUndefined();
  });

  it('lays env.pilot over the tested build with the looked-up D1 id; the code stays', () => {
    const config = targetConfig(BUILT, readTargetEnv('pilot'), { target: 'pilot', d1Id: D1_ID, url: URL_PILOT });
    expect(config).toMatchObject({
      name: 'moss-multi-pilot',
      targetEnvironment: 'pilot',
      workers_dev: true,
      main: 'index.js',
      no_bundle: true,
      vars: { MOSS_TEST_HOOKS: '0', MOSS_SIGN_UP: 'allowlist', BETTER_AUTH_URL: URL_PILOT },
      r2_buckets: [{ binding: 'ASSETS', bucket_name: 'moss-multi-pilot-assets' }],
      d1_databases: [{ binding: 'DB', database_name: 'moss-multi-pilot', database_id: D1_ID, migrations_dir: '../../drizzle' }],
    });
  });

  it("refuses the staging env, a pilot env without the allowlist or with hooks, and staging's URL", () => {
    const env = readTargetEnv('pilot');
    expect(() => targetConfig(BUILT, readStagingEnv(), { target: 'pilot', d1Id: D1_ID, url: URL_PILOT })).toThrow(/permanent/);
    expect(() => targetConfig(BUILT, { ...env, vars: { MOSS_TEST_HOOKS: '0' } }, { target: 'pilot', d1Id: D1_ID, url: URL_PILOT })).toThrow(/allowlist/);
    expect(() => targetConfig(BUILT, { ...env, vars: { ...env.vars, MOSS_TEST_HOOKS: '1' } }, { target: 'pilot', d1Id: D1_ID, url: URL_PILOT })).toThrow(/hooks/);
    expect(() => targetConfig(BUILT, env, { target: 'pilot', d1Id: D1_ID, url: 'https://moss-multi-staging.example.workers.dev' })).toThrow(/staging/);
    expect(() => targetConfig(BUILT, env, { target: 'nope', d1Id: D1_ID, url: URL_PILOT })).toThrow(/target/);
    // Staging is unchanged by the generalization.
    expect(stagingConfig(BUILT, readStagingEnv(), { d1Id: D1_ID, url: 'https://moss-multi-staging.example.workers.dev' }).name).toBe('moss-multi-staging');
  });
});

describe('the pilot preflight', () => {
  const ok = {
    CLOUDFLARE_API_TOKEN: 't'.repeat(40),
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    PILOT_URL: URL_PILOT,
    PILOT_BETTER_AUTH_SECRET: 's'.repeat(48),
    PILOT_ALLOWED_EMAILS: 'owner@example.invalid',
  };

  it('passes when every pilot secret is configured, and needs no staging or canary secret', () => {
    expect(preflightProblems(ok, 'pilot')).toEqual([]);
  });

  it('names each missing secret, a bad URL, a short secret, an allowlist with no email, and the staging URL', () => {
    expect(preflightProblems({ ...ok, PILOT_ALLOWED_EMAILS: '' }, 'pilot')).toEqual(['secret PILOT_ALLOWED_EMAILS is not set']);
    expect(preflightProblems({ ...ok, PILOT_URL: 'http://127.0.0.1:8850' }, 'pilot')).toEqual(['secret PILOT_URL must be an https URL that is not loopback']);
    expect(preflightProblems({ ...ok, PILOT_BETTER_AUTH_SECRET: 'short' }, 'pilot')).toEqual(['secret PILOT_BETTER_AUTH_SECRET must be at least 32 characters']);
    expect(preflightProblems({ ...ok, PILOT_ALLOWED_EMAILS: 'not-an-email, ;' }, 'pilot')).toEqual(['secret PILOT_ALLOWED_EMAILS must list at least one email address, and only email addresses']);
    expect(preflightProblems({ ...ok, PILOT_URL: 'https://moss-multi-staging.example.workers.dev' }, 'pilot').join('\n')).toMatch(/staging/);
    expect(preflightProblems({ ...ok, STAGING_URL: URL_PILOT }, 'pilot').join('\n')).toMatch(/staging/);
  });
});

describe('nothing automated runs against the pilot', () => {
  it('recognizes the pilot by its Worker host or by PILOT_URL', () => {
    expect(isPilotTarget(URL_PILOT, {})).toBe(true);
    expect(isPilotTarget('https://notes.example.invalid/x', { PILOT_URL: 'https://notes.example.invalid' })).toBe(true);
    expect(isPilotTarget('https://moss-multi-staging.example.workers.dev', { PILOT_URL: URL_PILOT })).toBe(false);
    expect(isPilotTarget('http://127.0.0.1:8850', {})).toBe(false);
  });

  it('refuses a canary state for the pilot', () => {
    const expected = { commit: 'c'.repeat(40), bundleHash: 'b'.repeat(64), clientHash: 'd'.repeat(64) };
    expect(() => canaryState({ baseUrl: URL_PILOT, expected, statePath: '/tmp/x/state.json', budget: 10, idleMs: 20_000 })).toThrow(/pilot/);
  });

  it('the security sweep and the demo generator refuse the pilot before any request', () => {
    const sweep = readFileSync(fileURLToPath(new URL('../security/sweep.mjs', import.meta.url)), 'utf8');
    const demo = readFileSync(fileURLToPath(new URL('../demo.mjs', import.meta.url)), 'utf8');
    expect(sweep).toMatch(/isPilotTarget\(/);
    expect(demo).toMatch(/isPilotTarget\(/);
  });
});

const PILOT = yaml.load(readFileSync(fileURLToPath(new URL('../../.github/workflows/deploy-pilot.yml', import.meta.url)), 'utf8'));
const steps = (job) => PILOT.jobs[job].steps;
const allSteps = () => Object.values(PILOT.jobs).flatMap((job) => job.steps);
const text = JSON.stringify(PILOT);

describe('deploy-pilot.yml', () => {
  const needsOf = (name) => [PILOT.jobs[name].needs ?? []].flat();
  const upstream = (name) => needsOf(name).flatMap((need) => [need, ...upstream(need)]);
  const holdsSecret = (value) => JSON.stringify(value ?? {}).includes('secrets.');
  const risky = (job, step) =>
    holdsSecret(job.env) || holdsSecret(step.env) || holdsSecret(step.with) || holdsSecret(step.run) ||
    (step.uses?.startsWith('actions/checkout') && step.with?.ref !== undefined) || step.uses?.startsWith('pnpm/') || /\bpnpm\b/.test(step.run ?? '');

  it('runs only by manual dispatch, one deploy at a time', () => {
    expect(Object.keys(PILOT.on ?? PILOT[true])).toEqual(['workflow_dispatch']);
    expect(PILOT.concurrency).toEqual({ group: 'deploy-pilot', 'cancel-in-progress': false });
  });

  it('gates the CI run before any of its code or any secret is in reach, as deploy-staging does', () => {
    const at = steps('preflight').findIndex((step) => step.id === 'gate');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(steps('preflight')[at].run).toMatch(/scripts\/deploy\/run-gate\.mjs/);
    for (const step of steps('preflight').slice(0, at + 1)) expect(risky(PILOT.jobs.preflight, step), step.name ?? step.uses).toBe(false);
    for (const [name, job] of Object.entries(PILOT.jobs)) {
      if (name === 'preflight') continue;
      for (const step of job.steps) {
        if (risky(job, step)) expect(upstream(name), `${name}: ${step.name ?? step.uses}`).toContain('preflight');
        if (step.uses?.startsWith('actions/checkout') && step.with?.ref !== undefined) expect(step.with.ref).toBe('${{ needs.preflight.outputs.sha }}');
      }
    }
    expect(steps('deploy').some((step) => /tested-run\.mjs/.test(step.run ?? ''))).toBe(true);
  });

  it('touches only pilot secrets and resources: no staging, canary, suite or upload', () => {
    expect(text).not.toMatch(/STAGING_|CANARY_|moss-multi-staging|playwright|canary-state|sweep\.mjs|demo\.mjs/);
    expect(Object.keys(PILOT.jobs).sort()).toEqual(['deploy', 'preflight']);
    expect(allSteps().some((step) => step.uses?.startsWith('actions/upload-artifact'))).toBe(false);
    expect(steps('preflight').find((step) => /preflight\.mjs/.test(step.run ?? '')).run).toMatch(/preflight\.mjs pilot/);
  });

  it('migrates the pilot D1 before deploying, with the allowlist and its own auth secret', () => {
    const runs = steps('deploy').map((step) => step.run ?? '');
    const migrate = runs.findIndex((run) => /d1 migrations apply moss-multi-pilot --remote/.test(run));
    const deploy = runs.findIndex((run) => /wrangler"? deploy/.test(run) || /\$WRANGLER" deploy/.test(run));
    expect(migrate).toBeGreaterThanOrEqual(0);
    expect(deploy).toBeGreaterThan(migrate);
    expect(runs.some((run) => /staging-config\.mjs write .*--target pilot/.test(run))).toBe(true);
    const env = steps('deploy')[deploy].env;
    expect(env.PILOT_BETTER_AUTH_SECRET).toBe('${{ secrets.PILOT_BETTER_AUTH_SECRET }}');
    expect(env.PILOT_ALLOWED_EMAILS).toBe('${{ secrets.PILOT_ALLOWED_EMAILS }}');
    expect(runs[deploy]).toMatch(/BETTER_AUTH_SECRET/);
    expect(runs[deploy]).toMatch(/MOSS_ALLOWED_EMAILS/);
  });

  it('ends with the read-only smoke: the tested bytes, no hook, signed out 401 and sign-up closed', () => {
    const last = steps('deploy').at(-1).run;
    expect(last).toMatch(/assert-deployed\.mjs/);
    expect(last).toMatch(/--pilot/);
    expect(last).toMatch(/--expect-commit/);
  });
});

// A fake pilot Worker: /api/me without a session, and a sign-up refusal for anyone off its allowlist.
function fakePilot() {
  const options = { me: 401, signUp: 403, code: 'SIGN_UP_NOT_ALLOWED' };
  const seen = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, path, body, origin: req.headers.origin, cookie: req.headers.cookie });
      if (path === '/api/me') {
        res.writeHead(options.me, { 'content-type': 'application/json' });
        res.end(options.me === 401 ? '{"error":"unauthenticated"}' : '{"id":"u"}');
      } else if (path === '/api/auth/sign-up/email' && req.method === 'POST') {
        res.writeHead(options.signUp, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: options.code, message: 'no' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  return { server, options, seen };
}

describe('the pilot smoke', () => {
  const { server, options, seen } = fakePilot();
  let baseUrl;
  beforeAll(async () => {
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((done) => server.close(done)));

  it('passes when signed-out reads are 401 and sign-up is refused for a stranger', async () => {
    expect(await pilotProblems(baseUrl)).toEqual([]);
  });

  it('cannot create an account even if the allowlist were off: a stranger, a password too short, no cookie', async () => {
    seen.length = 0;
    await pilotProblems(baseUrl);
    const signUp = seen.find((request) => request.path === '/api/auth/sign-up/email');
    const body = JSON.parse(signUp.body);
    expect(body.email).toMatch(/@example\.invalid$/);
    expect(body.password.length).toBeLessThan(8);
    expect(signUp.origin).toBe(baseUrl);
    expect(seen.every((request) => !request.cookie)).toBe(true);
  });

  it('fails when a signed-out read is served, or sign-up is open', async () => {
    options.me = 200;
    try {
      expect((await pilotProblems(baseUrl)).join('\n')).toMatch(/\/api\/me/);
    } finally {
      options.me = 401;
    }
    options.signUp = 400;
    options.code = 'PASSWORD_TOO_SHORT';
    try {
      expect((await pilotProblems(baseUrl)).join('\n')).toMatch(/sign-up/);
    } finally {
      options.signUp = 403;
      options.code = 'SIGN_UP_NOT_ALLOWED';
    }
  });
});
