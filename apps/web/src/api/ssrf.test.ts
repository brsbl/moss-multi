// SSRF guard (T3.2; A§18): every server fetch of a caller-supplied URL (unfurl, remote images) is HTTPS only, never
// reaches a private, loopback, link-local, CGNAT or ULA address however it is written, vets every DNS answer through
// DoH, and re-checks every redirect hop itself, failing closed.
import { describe, expect, it, vi } from 'vitest';
import { assertPublicUrl, createDohResolver, hostResolvesPublic, isBlockedHost, safeFetch, SsrfBlockedError, type HostResolver } from './ssrf.ts';

const blocked = (url: string) => {
  try {
    assertPublicUrl(url);
    return false;
  } catch (error) {
    return error instanceof SsrfBlockedError;
  }
};

describe('assertPublicUrl: the syntactic gate', () => {
  it('passes a public https URL and returns it parsed', () => {
    expect(assertPublicUrl('https://example.com/a?b=1').href).toBe('https://example.com/a?b=1');
    expect(assertPublicUrl(' https://8.8.8.8/ ').hostname).toBe('8.8.8.8');
  });

  it.each([
    ['cleartext http', 'http://example.com/'],
    ['ftp', 'ftp://example.com/file'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<p>'],
    ['file', 'file:///etc/passwd'],
    ['not a URL', 'example.com'],
    ['empty', ''],
  ])('refuses %s', (_label, url) => {
    expect(blocked(url), url).toBe(true);
  });

  it.each([
    ['loopback', 'https://127.0.0.1/'],
    ['loopback, high', 'https://127.255.255.254/'],
    ['this network', 'https://0.0.0.0/'],
    ['RFC 1918 10/8', 'https://10.1.2.3/'],
    ['RFC 1918 172.16/12, low', 'https://172.16.0.1/'],
    ['RFC 1918 172.16/12, high', 'https://172.31.255.255/'],
    ['RFC 1918 192.168/16', 'https://192.168.1.1/'],
    ['link-local 169.254/16', 'https://169.254.1.1/'],
    ['cloud metadata', 'https://169.254.169.254/latest/meta-data/'],
    ['CGNAT 100.64/10, low', 'https://100.64.0.1/'],
    ['CGNAT 100.64/10, high', 'https://100.127.255.254/'],
    ['benchmarking 198.18/15', 'https://198.18.0.1/'],
    ['multicast', 'https://224.0.0.1/'],
    ['broadcast', 'https://255.255.255.255/'],
  ])('refuses %s', (_label, url) => {
    expect(blocked(url), url).toBe(true);
  });

  it.each([
    ['32-bit decimal loopback', 'https://2130706433/'],
    ['32-bit hex loopback', 'https://0x7f000001/'],
    ['32-bit octal loopback', 'https://017700000001/'],
    ['dotted octal loopback', 'https://0177.0.0.1/'],
    ['dotted hex loopback', 'https://0x7f.0.0.1/'],
    ['short loopback', 'https://127.1/'],
    ['three-part loopback', 'https://127.0.1/'],
    ['trailing-dot loopback', 'https://127.0.0.1./'],
    ['hex metadata', 'https://0xa9fea9fe/'],
    ['decimal metadata', 'https://2852039166/'],
    ['decimal RFC 1918', 'https://3232235777/'],
    ['mixed-radix RFC 1918', 'https://0xc0.0250.1.1/'],
    ['decimal CGNAT', 'https://1681915905/'],
  ])('refuses obfuscated IPv4: %s', (_label, url) => {
    expect(blocked(url), url).toBe(true);
  });

  it.each([
    ['loopback', 'https://[::1]/'],
    ['unspecified', 'https://[::]/'],
    ['ULA fc00::/7, fc', 'https://[fc00::1]/'],
    ['ULA fc00::/7, fd', 'https://[fd12:3456:789a::1]/'],
    ['link-local fe80::/10', 'https://[fe80::1]/'],
    ['mapped loopback, dotted', 'https://[::ffff:127.0.0.1]/'],
    ['mapped loopback, hex', 'https://[::ffff:7f00:1]/'],
    ['mapped metadata', 'https://[::ffff:169.254.169.254]/'],
    ['mapped CGNAT', 'https://[::ffff:100.64.0.1]/'],
    ['IPv4-compatible loopback', 'https://[::127.0.0.1]/'],
    ['NAT64 loopback', 'https://[64:ff9b::7f00:1]/'],
    ['multicast', 'https://[ff02::1]/'],
  ])('refuses IPv6 %s', (_label, url) => {
    expect(blocked(url), url).toBe(true);
  });

  it.each([
    ['localhost', 'https://localhost/'],
    ['a localhost subdomain', 'https://api.localhost/'],
    ['mDNS', 'https://printer.local/'],
    ['an internal zone', 'https://metadata.google.internal/'],
    ['a trailing-dot localhost', 'https://localhost./'],
  ])('refuses %s', (_label, url) => {
    expect(blocked(url), url).toBe(true);
  });

  it.each([
    ['public IPv4', 'https://93.184.215.14/'],
    ['just past CGNAT', 'https://100.128.0.1/'],
    ['just past 172.16/12', 'https://172.32.0.1/'],
    ['public IPv6', 'https://[2606:4700:4700::1111]/'],
    ['a hostname', 'https://www.example.com/'],
  ])('passes %s', (_label, url) => {
    expect(blocked(url), url).toBe(false);
  });

  it('classifies bare hosts and answers alike', () => {
    expect(isBlockedHost('10.0.0.1')).toBe(true);
    expect(isBlockedHost('fd00::1')).toBe(true);
    expect(isBlockedHost('::ffff:10.0.0.1')).toBe(true);
    expect(isBlockedHost('1.1.1.1')).toBe(false);
    expect(isBlockedHost('2606:4700:4700::1111')).toBe(false);
  });
});

describe('hostResolvesPublic: DNS answers through DoH', () => {
  const answers = (ips: string[]): HostResolver => async () => ips;

  it('passes a host whose every answer is public', async () => {
    expect(await hostResolvesPublic('example.com', answers(['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c']))).toBe(true);
  });

  it.each([
    ['a private A answer', ['10.0.0.5']],
    ['one private answer among public ones', ['93.184.215.14', '127.0.0.1']],
    ['the metadata address', ['169.254.169.254']],
    ['a CGNAT answer', ['100.100.100.200']],
    ['a ULA AAAA answer', ['fd00::1']],
    ['a mapped private AAAA answer', ['::ffff:192.168.0.1']],
    ['no answer at all', []],
  ])('refuses %s', async (_label, ips) => {
    expect(await hostResolvesPublic('rebind.example', answers(ips))).toBe(false);
  });

  it('fails closed when the resolver fails', async () => {
    expect(await hostResolvesPublic('example.com', async () => { throw new Error('DoH down'); })).toBe(false);
  });

  it('skips resolution for an IP literal the syntactic gate already vetted', async () => {
    const resolve = vi.fn(answers(['10.0.0.1']));
    expect(await hostResolvesPublic('93.184.215.14', resolve)).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('reads the A and AAAA answers of a DoH JSON reply, ignoring CNAMEs', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const type = new URL(String(input)).searchParams.get('type');
      const Answer = type === 'A'
        ? [{ type: 5, data: 'alias.example.' }, { type: 1, data: '10.9.8.7' }]
        : [{ type: 28, data: 'fd00::7' }];
      return new Response(JSON.stringify({ Status: 0, Answer }), { headers: { 'content-type': 'application/dns-json' } });
    }) as unknown as typeof fetch;
    const ips = await createDohResolver(fetchImpl)('rebind.example');
    expect(ips.sort()).toEqual(['10.9.8.7', 'fd00::7']);
    const asked = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => new URL(String(url)));
    expect(asked.every((url) => url.protocol === 'https:' && url.searchParams.get('name') === 'rebind.example')).toBe(true);
  });

  it('fails closed on a DoH error reply', async () => {
    const fetchImpl = (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch;
    expect(await hostResolvesPublic('example.com', createDohResolver(fetchImpl))).toBe(false);
  });
});

describe('safeFetch: every redirect hop is checked again', () => {
  const PUBLIC: Record<string, string[]> = { 'a.example': ['93.184.215.14'], 'b.example': ['93.184.215.15'], 'c.example': ['93.184.215.16'] };
  const resolve: HostResolver = async (host) => PUBLIC[host] ?? (host === 'rebind.example' ? ['10.0.0.1'] : []);
  const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });

  function fetching(routes: Record<string, () => Response>) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect, 'redirects are never followed blindly').toBe('manual');
      const route = routes[String(input)];
      if (!route) throw new Error(`unexpected fetch ${String(input)}`);
      return route();
    });
  }

  it('follows a chain of public hops to its answer', async () => {
    const fetchImpl = fetching({
      'https://a.example/start': () => redirect('https://b.example/next', 301),
      'https://b.example/next': () => redirect('/last', 307),
      'https://b.example/last': () => redirect('https://c.example/end', 308),
      'https://c.example/end': () => new Response('done'),
    });
    const { response, url } = await safeFetch('https://a.example/start', { fetch: fetchImpl as unknown as typeof fetch, resolve });
    expect(await response.text()).toBe('done');
    expect(url).toBe('https://c.example/end');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['a loopback literal', 'https://127.0.0.1/admin'],
    ['the metadata address', 'https://169.254.169.254/latest/meta-data/'],
    ['an obfuscated loopback', 'https://0x7f.1/'],
    ['a ULA literal', 'https://[fd00::1]/'],
    ['a host that resolves privately', 'https://rebind.example/'],
    ['a cleartext downgrade', 'http://b.example/'],
  ])('refuses a hop to %s without fetching it', async (_label, location) => {
    const fetchImpl = fetching({ 'https://a.example/start': () => redirect(location) });
    await expect(safeFetch('https://a.example/start', { fetch: fetchImpl as unknown as typeof fetch, resolve })).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a first URL that resolves privately without fetching it', async () => {
    const fetchImpl = fetching({});
    await expect(safeFetch('https://rebind.example/', { fetch: fetchImpl as unknown as typeof fetch, resolve })).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stops after five redirects', async () => {
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i < 6; i += 1) routes[`https://a.example/${i}`] = () => redirect(`https://a.example/${i + 1}`);
    routes['https://a.example/6'] = () => new Response('too far');
    const fetchImpl = fetching(routes);
    const failure = await safeFetch('https://a.example/0', { fetch: fetchImpl as unknown as typeof fetch, resolve }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SsrfBlockedError);
    expect((failure as SsrfBlockedError).reason).toBe('too-many-redirects');
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('allows exactly five redirects', async () => {
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i < 5; i += 1) routes[`https://a.example/${i}`] = () => redirect(`https://a.example/${i + 1}`);
    routes['https://a.example/5'] = () => new Response('arrived');
    const { response } = await safeFetch('https://a.example/0', { fetch: fetching(routes) as unknown as typeof fetch, resolve });
    expect(await response.text()).toBe('arrived');
  });

  it('treats a redirect with no Location as the answer', async () => {
    const fetchImpl = fetching({ 'https://a.example/x': () => new Response(null, { status: 302 }) });
    const { response } = await safeFetch('https://a.example/x', { fetch: fetchImpl as unknown as typeof fetch, resolve });
    expect(response.status).toBe(302);
  });
});
