// The principal plumbing against the real Worker: per-run @example.invalid principals sign up through the auth
// API, each context carries its own session, and /api/me tells them apart (invariant 8 with real ids).
import { Actors } from '../lib/actors.ts';
import { Stack } from '../lib/stack.ts';
import { expect, test } from './fixtures.ts';

test('per-run principals sign up, and each context carries its own session', async ({ browser }, testInfo) => {
  test.skip(!process.env.STACK_STATE, 'needs a stack: node scripts/stack.mjs start --hooks');
  const stack = Stack.fromState();
  await stack.assertProvenance();
  const runToken = `selftest-${process.env.RUN_ID ?? 'local'}-${Date.now().toString(36)}`.toLowerCase();
  const actors = new Actors(browser, testInfo, { stack, runToken });
  try {
    const ada = await actors.principal('ada');
    const ben = await actors.principal('ben');
    for (const principal of [ada, ben]) expect(principal.email).toMatch(/^mm-.+@example\.invalid$/);
    await actors.session(ada);
    await actors.session(ben);
    expect(await actors.requireDistinct(2)).toEqual([ada.id, ben.id]);
    expect(await actors.findings()).toEqual([]);
  } finally {
    await actors.dispose();
  }
});
