import { describe, expect, it, vi } from 'vitest';
import type { Build } from '../provenance.ts';
import { routeRequest, type PartyAuth, type RouteDeps } from './route.ts';

const BUILD: Build = {
  commit: 'a'.repeat(40),
  headSha: 'a'.repeat(40),
  dirty: false,
  diffHash: '',
  bundleHash: 'b'.repeat(64),
  clientHash: 'c'.repeat(64),
  buildTime: '2026-10-02T00:00:00.000Z',
  env: 'ci',
};

const ORIGIN = 'http://127.0.0.1:8850';
const TRUSTED = { 'x-moss-principal': 'p_real', 'x-moss-role': 'editor', 'x-moss-session': 's_real' };

function harness(auth: PartyAuth = { ok: true, headers: TRUSTED }) {
  const forwarded: Request[] = [];
  const marker = (name: string) => vi.fn(async () => new Response(name, { headers: { 'x-handler': name } }));
  const deps: RouteDeps = {
    build: BUILD,
    testHooksAllowed: () => false,
    handleTestHook: marker('test-hook'),
    handleAuth: marker('auth'),
    handleWorkspaceSocket: marker('workspace'),
    handleApi: marker('api'),
    authenticateParty: vi.fn(async () => auth),
    routeParty: vi.fn(async (request: Request) => {
      forwarded.push(request);
      return new Response('party', { headers: { 'x-handler': 'party' } });
    }),
    refuseSocket: vi.fn((code: number) => new Response(null, { headers: { 'x-handler': 'refused', 'x-close-code': String(code) } })),
    startFetch: marker('start'),
  };
  const route = (path: string, init?: RequestInit) => routeRequest(new Request(`${ORIGIN}${path}`, init), deps);
  return { deps, forwarded, route };
}

const UPGRADE = {
  upgrade: 'websocket',
  connection: 'Upgrade',
  'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
  'sec-websocket-version': '13',
  'sec-websocket-protocol': 'yjs',
};

describe('/api/version', () => {
  it('answers GET with the build, never cached', async () => {
    const response = await harness().route('/api/version');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await response.json()).toEqual(BUILD);
  });

  it('gets 405 for POST', async () => {
    const response = await harness().route('/api/version', { method: 'POST', body: '{}' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
  });
});

describe('/parties', () => {
  it.each(['/parties/search-d-o/global', '/parties/principal-d-o/p1', '/parties/main/x', '/parties/doc-d-o', '/parties/doc-d-o/d1/extra'])(
    'gets 404 for %s without authenticating or reaching a DO',
    async (path) => {
      const { deps, route } = harness();
      const response = await route(path, { headers: UPGRADE });
      expect(response.status).toBe(404);
      expect(deps.authenticateParty).not.toHaveBeenCalled();
      expect(deps.routeParty).not.toHaveBeenCalled();
      expect(deps.startFetch).not.toHaveBeenCalled();
    },
  );

  it('authorizes the room partyserver will route to', async () => {
    const { deps, route } = harness();
    await route('/parties/doc-d-o/d_123?share=tok');
    expect(deps.authenticateParty).toHaveBeenCalledWith(expect.any(Request), 'd_123');
  });

  it('strips client x-moss-* and x-partykit-* headers and sets the trusted ones', async () => {
    const { forwarded, route } = harness();
    const response = await route('/parties/doc-d-o/d_123', {
      headers: {
        ...UPGRADE,
        'x-moss-principal': 'p_forged',
        'X-Moss-Role': 'owner',
        'x-moss-share': 'forged-token',
        'x-partykit-props': '{"role":"owner"}',
        'x-partykit-room': 'other-doc',
        'x-other': 'kept',
      },
    });
    expect(response.headers.get('x-handler')).toBe('party');
    expect(forwarded).toHaveLength(1);
    const headers = Object.fromEntries(forwarded[0].headers);
    expect(headers['x-moss-principal']).toBe('p_real');
    expect(headers['x-moss-role']).toBe('editor');
    expect(headers['x-moss-session']).toBe('s_real');
    expect(headers).not.toHaveProperty('x-moss-share');
    expect(headers).not.toHaveProperty('x-partykit-props');
    expect(headers).not.toHaveProperty('x-partykit-room');
    expect(headers['x-other']).toBe('kept');
  });

  it('keeps Upgrade and Sec-WebSocket-* through the clone', async () => {
    const { forwarded, route } = harness();
    await route('/parties/doc-d-o/d_123?share=tok', { headers: UPGRADE });
    expect(forwarded).toHaveLength(1);
    const request = forwarded[0];
    for (const [name, value] of Object.entries(UPGRADE)) expect(request.headers.get(name)).toBe(value);
    expect(request.url).toBe(`${ORIGIN}/parties/doc-d-o/d_123?share=tok`);
    expect(request.method).toBe('GET');
  });

  it('accepts and closes a denied upgrade instead of refusing the handshake', async () => {
    const { deps, route } = harness({ ok: false, code: 4404 });
    const response = await route('/parties/doc-d-o/d_missing', { headers: UPGRADE });
    expect(deps.refuseSocket).toHaveBeenCalledWith(4404);
    expect(response.headers.get('x-close-code')).toBe('4404');
    expect(deps.routeParty).not.toHaveBeenCalled();
  });
});

describe('routing order', () => {
  it.each([
    ['/api/auth/sign-in/email', 'auth'],
    ['/api/workspace/ws', 'workspace'],
    ['/api/docs', 'api'],
    ['/api/versions', 'api'],
    ['/d/doc1', 'start'],
    ['/__test/docs/d1/instance', 'start'],
    ['/', 'start'],
  ])('%s goes to %s', async (path, handler) => {
    const response = await harness().route(path);
    expect(response.headers.get('x-handler')).toBe(handler);
  });

  it('reaches a test hook only through the gate', async () => {
    const { deps, route } = harness();
    deps.testHooksAllowed = () => true;
    expect((await route('/__test/docs/d1/instance')).headers.get('x-handler')).toBe('test-hook');
  });

  it('gives a path no hook serves the unknown-route 404, even through the gate', async () => {
    const { deps, route } = harness();
    deps.testHooksAllowed = () => true;
    deps.handleTestHook = vi.fn(async () => null);
    expect((await route('/__test/playground')).headers.get('x-handler')).toBe('start');
  });
});
