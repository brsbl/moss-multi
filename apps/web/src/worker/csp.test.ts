import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, mintNonce, withCsp } from './csp.ts';

describe('the page CSP', () => {
  it('mints a fresh nonce per request', () => {
    const nonces = new Set(Array.from({ length: 50 }, mintNonce));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{24}$/);
  });

  it('allows only nonced scripts, same-origin and data: frames, and the same-origin socket', () => {
    const policy = contentSecurityPolicy('abc', 'https://moss.example/d/1');
    expect(policy).toContain("script-src 'self' 'nonce-abc'");
    expect(policy).not.toMatch(/script-src[^;]*unsafe/);
    expect(policy).toContain("frame-src 'self' data: https:");
    expect(policy).toContain("connect-src 'self' wss://moss.example");
    expect(contentSecurityPolicy('abc', 'http://127.0.0.1:8850/')).toContain("connect-src 'self' ws://127.0.0.1:8850");
  });

  it('sets the header on HTML documents only, keeping status and headers', async () => {
    const page = withCsp(new Response('<html></html>', { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'x-kept': '1' } }), 'n0', 'http://127.0.0.1/x');
    expect(page.status).toBe(404);
    expect(page.headers.get('x-kept')).toBe('1');
    expect(page.headers.get('content-security-policy')).toContain("'nonce-n0'");
    expect(await page.text()).toBe('<html></html>');
    const json = withCsp(new Response('{}', { headers: { 'content-type': 'application/json' } }), 'n0', 'http://127.0.0.1/x');
    expect(json.headers.has('content-security-policy')).toBe(false);
  });
});
