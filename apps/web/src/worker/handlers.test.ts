import { describe, expect, it } from 'vitest';
import { testHooksAllowed } from './handlers.ts';

const ENV = { MOSS_TEST_HOOKS: '1', MOSS_TEST_HOOKS_SECRET: 'run-secret', BETTER_AUTH_URL: 'http://127.0.0.1:8850' };
const hook = (url = 'http://127.0.0.1:8850/__test/docs/d1/instance', secret: string | null = 'run-secret') =>
  new Request(url, { headers: secret === null ? {} : { 'x-moss-test-hook': secret } });

describe('testHooksAllowed', () => {
  it('opens only when all four conditions hold', () => {
    expect(testHooksAllowed(hook(), ENV)).toBe(true);
    expect(testHooksAllowed(hook('http://localhost:8850/__test/x'), ENV)).toBe(true);
  });

  it.each([
    ['hooks off', hook(), { ...ENV, MOSS_TEST_HOOKS: undefined }],
    ['hooks not exactly 1', hook(), { ...ENV, MOSS_TEST_HOOKS: 'true' }],
    ['no secret configured', hook('http://127.0.0.1:8850/__test/x', ''), { ...ENV, MOSS_TEST_HOOKS_SECRET: '' }],
    ['no secret header', hook(undefined, null), ENV],
    ['wrong secret', hook(undefined, 'guess'), ENV],
    ['non-loopback request', hook('https://moss-multi-staging.example.workers.dev/__test/x'), ENV],
    ['non-loopback BETTER_AUTH_URL', hook(), { ...ENV, BETTER_AUTH_URL: 'https://moss-multi-staging.example.workers.dev' }],
    ['missing BETTER_AUTH_URL', hook(), { ...ENV, BETTER_AUTH_URL: undefined }],
  ])('stays shut: %s', (_why, request, env) => {
    expect(testHooksAllowed(request, env)).toBe(false);
  });
});
