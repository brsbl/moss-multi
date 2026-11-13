import { describe, expect, it } from 'vitest';
import { createAuth } from './auth.ts';
import { configProblem, configuredSocialProviders, minPasswordLength, PLACEHOLDER_SECRET, refusalFor } from './config.ts';

const GOOD = { BETTER_AUTH_SECRET: 'f'.repeat(64), BETTER_AUTH_URL: 'http://127.0.0.1:8850' };
const STAGING = 'https://moss-multi-staging.example.workers.dev';

describe('fail closed', () => {
  it('serves a strong secret on loopback and on staging, with hooks only on loopback', () => {
    expect(configProblem(GOOD)).toBeNull();
    expect(configProblem({ ...GOOD, BETTER_AUTH_SECRET: 'f'.repeat(32) })).toBeNull();
    expect(configProblem({ ...GOOD, BETTER_AUTH_URL: STAGING })).toBeNull();
    expect(configProblem({ ...GOOD, MOSS_TEST_HOOKS: '1' })).toBeNull();
    expect(refusalFor(GOOD)).toBeNull();
  });

  it.each([
    ['a missing secret', { ...GOOD, BETTER_AUTH_SECRET: undefined }, /missing/],
    ['an empty secret', { ...GOOD, BETTER_AUTH_SECRET: '' }, /missing/],
    ['the placeholder secret', { ...GOOD, BETTER_AUTH_SECRET: `${PLACEHOLDER_SECRET}-0000` }, /placeholder/],
    ['a short secret', { ...GOOD, BETTER_AUTH_SECRET: 'f'.repeat(31) }, /under 32/],
    ['hooks on a non-loopback URL', { ...GOOD, BETTER_AUTH_URL: STAGING, MOSS_TEST_HOOKS: '1' }, /MOSS_TEST_HOOKS/],
    ['hooks with no BETTER_AUTH_URL', { ...GOOD, BETTER_AUTH_URL: undefined, MOSS_TEST_HOOKS: '1' }, /BETTER_AUTH_URL/],
    ['no BETTER_AUTH_URL', { ...GOOD, BETTER_AUTH_URL: undefined }, /BETTER_AUTH_URL/],
  ])('refuses %s', async (_case, env, reason) => {
    expect(PLACEHOLDER_SECRET.length).toBeGreaterThanOrEqual(32); // so the placeholder case is not a length case
    expect(configProblem(env)).toMatch(reason);
    const refusal = refusalFor(env);
    expect(refusal?.status).toBe(503);
    expect(await refusal?.json()).toEqual({ error: 'misconfigured' });
    expect(() => createAuth({ ...env, DB: {} as D1Database })).toThrow(reason);
  });
});

describe('password minimum', () => {
  it('is 8 on loopback and 12 elsewhere, and is what better-auth enforces', () => {
    expect(minPasswordLength(GOOD.BETTER_AUTH_URL)).toBe(8);
    expect(minPasswordLength(STAGING)).toBe(12);
    expect(minPasswordLength(undefined)).toBe(12);
    for (const url of [GOOD.BETTER_AUTH_URL, STAGING]) {
      const auth = createAuth({ ...GOOD, BETTER_AUTH_URL: url, DB: {} as D1Database });
      expect(auth.options.emailAndPassword?.minPasswordLength).toBe(minPasswordLength(url));
    }
  });
});

describe('social providers', () => {
  it('registers a provider only when both its id and secret exist', () => {
    expect(configuredSocialProviders({})).toEqual({});
    expect(configuredSocialProviders({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: '' })).toEqual({});
    expect(configuredSocialProviders({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: 'secret' })).toEqual({});
    expect(Object.keys(configuredSocialProviders({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' }))).toEqual(['github']);
  });
});
