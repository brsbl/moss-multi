// B063: patches/wrangler@4.113.0.patch replays a forward lost on a closing keep-alive connection. Only GET and HEAD
// may be replayed: a POST lost after the Worker committed it would otherwise be applied twice. A POST instead waits
// out a connection that is about to idle out.
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PROXY = join(fileURLToPath(new URL('..', import.meta.url)), 'apps/web/node_modules/wrangler/wrangler-dist/ProxyWorker.js');
const { ProxyWorker } = await import(pathToFileURL(PROXY).href);

/** The patched ProxyWorker forwarding to a Worker at :9999, with `upstream` as its fetch. */
function proxy(upstream) {
  const calls = [];
  // workerd's Headers has getAll (Set-Cookie only); Node's has getSetCookie.
  Headers.prototype.getAll = function getAll() {
    return this.getSetCookie();
  };
  vi.stubGlobal('fetch', async (url, request) => {
    calls.push({ url: String(url), method: request.method, body: request.body ? await request.text() : null });
    return upstream(calls.length);
  });
  const env = { PROXY_CONTROLLER_AUTH_SECRET: 'controller', PROXY_CONTROLLER: { fetch: async () => new Response(null) } };
  const worker = new ProxyWorker({}, env);
  worker.proxyData = { userWorkerUrl: { protocol: 'http:', hostname: '127.0.0.1', port: '9999' }, headers: {} };
  return { worker, calls };
}

const lost = () => Promise.reject(new TypeError('fetch failed'));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete Headers.prototype.getAll;
});

describe('the patched wrangler ProxyWorker', () => {
  it('forwards a POST once, and a lost one is not replayed', async () => {
    const { worker, calls } = proxy(lost);
    const response = await worker.fetch(new Request('http://127.0.0.1:8850/api/docs', { method: 'POST', body: '{"title":"x"}' }));
    expect(calls).toEqual([{ url: 'http://127.0.0.1:9999/api/docs', method: 'POST', body: '{"title":"x"}' }]);
    expect(response.status).toBe(503);
  });

  it('replays a GET lost once and answers it', async () => {
    const { worker, calls } = proxy((n) => (n === 1 ? lost() : new Response('ok', { status: 200 })));
    const response = await worker.fetch(new Request('http://127.0.0.1:8850/api/version'));
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET']);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('forwards a POST that succeeds exactly once', async () => {
    const { worker, calls } = proxy(() => new Response('created', { status: 201 }));
    const response = await worker.fetch(new Request('http://127.0.0.1:8850/api/docs', { method: 'POST', body: 'b' }));
    expect(calls).toHaveLength(1);
    expect(response.status).toBe(201);
  });

  // The Worker closes a keep-alive connection 5 s after its last response, and the pool reuses the latest one first.
  it('holds a POST that would take a connection about to idle out until it has closed, then sends it once', async () => {
    vi.useFakeTimers({ now: 0 });
    const { worker, calls } = proxy(() => new Response('ok'));
    await worker.fetch(new Request('http://127.0.0.1:8850/api/version'));
    await vi.advanceTimersByTimeAsync(4800);
    const posted = worker.fetch(new Request('http://127.0.0.1:8850/api/docs', { method: 'POST', body: 'b' }));
    await vi.advanceTimersByTimeAsync(400);
    expect(calls.map((call) => call.method)).toEqual(['GET']);
    await vi.advanceTimersByTimeAsync(200);
    expect((await posted).status).toBe(200);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST']);
  });

  it('sends a POST at once when the connection it takes was used recently', async () => {
    vi.useFakeTimers({ now: 0 });
    const { worker, calls } = proxy(() => new Response('ok'));
    await worker.fetch(new Request('http://127.0.0.1:8850/api/version'));
    await vi.advanceTimersByTimeAsync(1000);
    const posted = worker.fetch(new Request('http://127.0.0.1:8850/api/docs', { method: 'POST', body: 'b' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    expect((await posted).status).toBe(200);
  });
});
