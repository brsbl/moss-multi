// A product-free reproduction of WebKit's network-process fault (T9.48g): no product code on the page, only the
// request pattern a note open makes against the stack. It runs only when a dispatch greps @repro, never in the gated
// lane. A crash or hang here is the engine's or the image's, not the product's. The second variant adds the harness's
// own interception (a context route and the sever's WebSocket proxy), which most journeys that met the crash use.
import { Actors } from '../lib/actors.ts';
import { DOC_SOCKET_PATH } from '../lib/contract.ts';
import { InfraBlocked } from '../lib/infra.ts';
import { Stack } from '../lib/stack.ts';
import { CLIENT_PROTOCOL, PROTOCOL_PARAM } from '../../packages/protocol/src/client-protocol.ts';
import { expect, test } from './fixtures.ts';

const CONTEXTS = 40;
const ROUNDS = 20;
const ANSWER_MS = 10_000;

for (const intercepted of [false, true]) {
  test(`a page with no product code that aborts loads in flight keeps its network process${intercepted ? ', with interception' : ''} @repro`, async ({ browser, browserName }) => {
    test.skip(!/@repro/.test(process.env.GREP ?? ''), 'runs only when a dispatch greps @repro');
    test.skip(browserName !== 'webkit', 'the fault is WebKit\'s');
    test.setTimeout(300_000);
    let stack: Stack;
    try {
      stack = Stack.fromState();
    } catch (error) {
      throw new InfraBlocked(`the reproduction needs a stack: ${(error as Error).message}`);
    }
    const actors = new Actors(browser, test.info(), { stack, runToken: `repro-${Date.now().toString(36)}` });
    const principal = await actors.principal('repro');
    const started = Date.now();
    try {
      for (let n = 1; n <= CONTEXTS; n += 1) {
        const actor = await actors.session(principal, { label: `r${n}`, severable: intercepted });
        if (intercepted) await actor.context.route('**/*', (route) => route.continue().catch(() => undefined));
        const created = await actor.context.request.post(new URL('/api/docs', stack.baseUrl).href, { headers: { origin: stack.baseUrl }, data: {} });
        expect(created.status()).toBe(201);
        const { doc } = (await created.json()) as { doc: { id: string } };
        // A same-origin JSON document: the page runs nothing of the product's.
        await actor.goto(new URL('/api/version', stack.baseUrl).href);
        const burst = actor.page.evaluate(async ({ docId, docPath, query, rounds }) => {
          const ws = location.origin.replace(/^http/, 'ws');
          const sockets = [new WebSocket(`${ws}/api/workspace/ws`), new WebSocket(`${ws}${docPath}${encodeURIComponent(docId)}?${query}`)];
          const reads: Promise<unknown>[] = [];
          for (let i = 0; i < rounds; i += 1) {
            // A read aborted as its answer arrives and reissued in the same tick, as a note open once did.
            const first = new AbortController();
            reads.push(fetch(`/api/docs/${docId}/backlinks`, { signal: first.signal }).catch(() => null));
            await new Promise((done) => setTimeout(done, (i % 4) * 10));
            first.abort();
            reads.push(fetch(`/api/docs/${docId}/backlinks`).then((r) => r.status).catch(() => null));
            // A frame load cancelled in flight.
            const frame = document.createElement('iframe');
            frame.src = `/api/version?frame=${i}`;
            document.body.append(frame);
            setTimeout(() => frame.remove(), (i % 3) * 5);
          }
          await Promise.all(reads);
          for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close();
          return (await fetch('/api/version')).status;
        }, { docId: doc.id, docPath: DOC_SOCKET_PATH, query: `${PROTOCOL_PARAM}=${CLIENT_PROTOCOL}`, rounds: ROUNDS });
        burst.catch(() => undefined);
        const answer = await Promise.race([burst, new Promise<string>((done) => setTimeout(() => done('no answer'), ANSWER_MS))]).catch((e: Error) => e.message);
        const crash = actor.telemetry.console.find((c) => /Network process crashed/.test(c.text));
        const internal = actor.telemetry.failed.find((f) => /internal error/.test(f.failure));
        if (answer !== 200 || crash || internal) {
          await actors.dispose({ capture: true });
          const at = `context ${n} of ${CONTEXTS}, ${((Date.now() - started) / 1000).toFixed(1)} s into the burst`;
          throw new Error(`reproduced at ${at}: answer ${String(answer)}; ${crash?.text ?? internal?.failure ?? 'no crash line'}`);
        }
        await actor.context.close();
      }
      test.info().annotations.push({ type: 'repro', description: `${intercepted ? 'intercepted, ' : ''}${CONTEXTS} contexts, ${ROUNDS} aborted reads each, no fault in ${((Date.now() - started) / 1000).toFixed(1)} s` });
    } finally {
      await actors.dispose();
    }
  });
}
