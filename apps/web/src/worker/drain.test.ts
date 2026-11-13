import { describe, expect, it } from 'vitest';
import { DRAIN_LIMIT, drainUnreadBody } from './drain.ts';

const patch = (body: string) =>
  new Request('http://127.0.0.1:8850/api/vaults/v1', { method: 'PATCH', body, headers: { 'content-length': String(body.length) } });

describe('drainUnreadBody', () => {
  it('reads a small body a refusal left unread', async () => {
    const request = patch('{"name":"Taken over"}');
    await drainUnreadBody(request);
    expect(request.bodyUsed).toBe(true);
  });

  it('leaves a body past the limit and one without a length', async () => {
    const large = patch('x'.repeat(DRAIN_LIMIT + 1));
    await drainUnreadBody(large);
    expect(large.bodyUsed).toBe(false);
    const unknown = new Request('http://127.0.0.1:8850/api/docs', { method: 'POST', body: 'x' });
    await drainUnreadBody(unknown);
    expect(unknown.bodyUsed).toBe(false);
  });

  it('passes over a read body and a request without one', async () => {
    const read = patch('{}');
    await read.text();
    await expect(drainUnreadBody(read)).resolves.toBeUndefined();
    const get = new Request('http://127.0.0.1:8850/api/version');
    await drainUnreadBody(get);
    expect(get.bodyUsed).toBe(false);
  });
});
