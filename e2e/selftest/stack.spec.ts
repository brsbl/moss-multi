// The principal plumbing against the real Worker: per-run @example.invalid principals sign up through the auth
// API, each context carries its own session, and /api/me tells them apart (invariant 8 with real ids). And the
// stack's own proxy answers every request it is handed.
import { request as httpRequest } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
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

/** One request on a connection of its own: its status, -1 for a network error, or null for no answer in `ms`. */
function probe(url: string, method: 'GET' | 'POST', ms: number): Promise<number | null> {
  return new Promise((resolve) => {
    const req = httpRequest(url, { method, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.setTimeout(ms, () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(-1));
    req.end();
  });
}

// wrangler dev forwards each request to the Worker over pooled keep-alive connections, which the Worker's side
// closes after 5 s idle. A forward written to one as it closes is lost, and wrangler 4.113 parks a lost GET until
// the next request reaches the stack and answers a lost POST 503 (workers-sdk#14641). In a quiet journey a module
// script then waits until the test times out and the shell never boots. So each burst lands as the pool idles out.
test('every request handed to the stack as its pooled connections idle out is answered at once @slow', async () => {
  test.skip(!process.env.STACK_STATE, 'needs a stack: node scripts/stack.mjs start --hooks');
  test.setTimeout(180_000);
  const url = new URL('/api/version', Stack.fromState().baseUrl).href;
  const burst = () => Promise.all(Array.from({ length: 16 }, async (_, i) => {
    const method = i % 4 === 3 ? 'POST' : 'GET';
    return { method, status: await probe(url, method, 3_000) };
  }));
  const lost: string[] = [];
  await burst();
  for (let idle = 4_976; idle <= 5_024; idle += 4) {
    await sleep(idle);
    for (const { method, status } of await burst()) {
      if (status !== (method === 'GET' ? 200 : 405)) lost.push(`${method} after ${idle} ms idle: ${status ?? 'no answer in 3 s'}`);
    }
  }
  expect(lost).toEqual([]);
});
