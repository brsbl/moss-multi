// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_PROTOCOL, OUTDATED_ERROR, PROTOCOL_HEADER } from '@moss-multi/protocol/client-protocol';
import { onOutdated, withClientProtocol } from './client-protocol.ts';

const seen: Request[] = [];
function backend(status = 200, body: unknown = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(typeof input === 'string' ? new URL(input, location.href).href : input instanceof URL ? input.href : input, init));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
}
const sent = () => seen[seen.length - 1];

afterEach(() => { seen.length = 0; });

describe('the bundle names its protocol on REST (registers.md rule 10)', () => {
  it.each(['/api/docs', `${location.origin}/api/docs/d1/access`, new URL('/api/folders', location.origin)])(
    'adds the header to same-origin API request %s', async (input) => {
      await withClientProtocol(backend())(input);
      expect(sent().headers.get(PROTOCOL_HEADER)).toBe(String(CLIENT_PROTOCOL));
    },
  );

  it('keeps the caller\'s method, body and headers, Request inputs included', async () => {
    await withClientProtocol(backend())(new Request(`${location.origin}/api/docs`, { method: 'POST', body: 'x', headers: { 'x-a': '1' } }));
    expect(sent().method).toBe('POST');
    expect(await sent().text()).toBe('x');
    expect(sent().headers.get('x-a')).toBe('1');
    expect(sent().headers.get(PROTOCOL_HEADER)).toBe(String(CLIENT_PROTOCOL));
  });

  it.each(['https://example.invalid/api/docs', '/assets/app.js', '/d/doc1'])('leaves %s alone', async (input) => {
    await withClientProtocol(backend())(input);
    expect(sent().headers.get(PROTOCOL_HEADER)).toBeNull();
  });

  it('tells the app when the server refuses this bundle as outdated', async () => {
    const listener = vi.fn();
    const off = onOutdated(listener);
    const response = await withClientProtocol(backend(426, { error: OUTDATED_ERROR }))('/api/docs');
    off();
    expect(response.status).toBe(426);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('a 426 from elsewhere, or another error, is not an update', async () => {
    const listener = vi.fn();
    const off = onOutdated(listener);
    await withClientProtocol(backend(426, { error: 'other' }))('/api/docs');
    await withClientProtocol(backend(500, { error: OUTDATED_ERROR }))('/api/docs');
    off();
    expect(listener).not.toHaveBeenCalled();
  });
});
