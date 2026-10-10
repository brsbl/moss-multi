// B063: patches/wrangler@4.113.0.patch replays a forward lost on a closing keep-alive connection. Only GET and HEAD
// may be replayed: a POST lost after the Worker committed it would otherwise be applied twice.
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PROXY = join(fileURLToPath(new URL('..', import.meta.url)), 'apps/web/node_modules/wrangler/wrangler-dist/ProxyWorker.js');
const { ProxyWorker } = await import(pathToFileURL(PROXY).href);

/** The patched ProxyWorker forwarding to a Worker at :9999, with `upstream` as its fetch. */
function proxy(upstream) {
  const calls = [];
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
  vi.unstubAllGlobals();
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
});
