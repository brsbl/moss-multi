// SSRF guard (A§18) for every server fetch of a caller-supplied URL: the unfurl behind web embeds and the remote-image
// store behind moss's paste. HTTPS only. A host written as an IP literal, in any encoding a URL parser or resolver
// would still route (decimal, octal, hex, short forms, IPv4-mapped or NAT64 IPv6), is refused when it lands in a
// loopback, private, link-local, CGNAT, ULA, multicast or other non-public range; a hostname is resolved through DoH
// and refused unless every A and AAAA answer is public. Redirects are never followed by fetch: each hop is checked
// again before it is requested, at most five of them. Every failure fails closed.

export type SsrfReason = 'invalid-url' | 'unsupported-scheme' | 'blocked-host' | 'too-many-redirects';

export class SsrfBlockedError extends Error {
  constructor(readonly reason: SsrfReason, detail?: string) {
    super(detail ? `ssrf-blocked:${reason}:${detail}` : `ssrf-blocked:${reason}`);
    this.name = 'SsrfBlockedError';
  }
}

/** A hostname's A and AAAA answers. */
export type HostResolver = (hostname: string) => Promise<string[]>;

export interface RemoteFetch {
  fetch: typeof fetch;
  resolve: HostResolver;
}

export const MAX_REDIRECTS = 5;

/** The parsed URL when it is https to a host that is not syntactically internal; throws SsrfBlockedError otherwise. */
export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SsrfBlockedError('invalid-url');
  }
  if (url.protocol !== 'https:') throw new SsrfBlockedError('unsupported-scheme', url.protocol);
  if (url.username || url.password) throw new SsrfBlockedError('invalid-url', 'credentials');
  if (isBlockedHost(url.hostname)) throw new SsrfBlockedError('blocked-host', url.hostname);
  return url;
}

const unbracket = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

/** True for localhost, internal zones, and IP literals outside public unicast space. */
export function isBlockedHost(hostname: string): boolean {
  const host = unbracket(hostname);
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;
  const v4 = parseIpv4(host);
  if (v4) return isBlockedV4(v4);
  if (host.includes(':')) return isBlockedV6(host);
  return false;
}

export function isIpLiteral(hostname: string): boolean {
  const host = unbracket(hostname);
  return parseIpv4(host) !== null || host.includes(':');
}

type V4 = [number, number, number, number];

function isBlockedV4([a, b]: V4): boolean {
  return a === 0 // this network
    || a === 10 // RFC 1918
    || a === 127 // loopback
    || (a === 100 && b >= 64 && b <= 127) // CGNAT
    || (a === 169 && b === 254) // link-local, cloud metadata
    || (a === 172 && b >= 16 && b <= 31) // RFC 1918
    || (a === 192 && b === 168) // RFC 1918
    || (a === 192 && b === 0) // IETF protocol assignments, TEST-NET-1
    || (a === 198 && (b === 18 || b === 19)) // benchmarking
    || a >= 224; // multicast, reserved, broadcast
}

/** Every IPv4 form WHATWG's host parser and inet_aton accept: 1 to 4 parts, each decimal, octal or hex. */
function parseIpv4(host: string): V4 | null {
  const parts = host.split('.');
  if (parts.length > 4 || parts.some((part) => part === '')) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    let value: number;
    if (/^0x[0-9a-f]*$/i.test(part)) value = part.length === 2 ? 0 : parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) value = parseInt(part.slice(1), 8);
    else if (/^(0|[1-9][0-9]*)$/.test(part)) value = Number(part);
    else return null;
    if (!Number.isSafeInteger(value)) return null;
    numbers.push(value);
  }
  const last = numbers.pop() as number;
  if (numbers.some((n) => n > 255) || last >= 256 ** (4 - numbers.length)) return null;
  const octets = [...numbers];
  for (let shift = 8 * (3 - numbers.length); shift >= 0; shift -= 8) octets.push(Math.floor(last / 2 ** shift) % 256);
  return octets as V4;
}

function isBlockedV6(host: string): boolean {
  const words = parseIpv6(host.split('%')[0]);
  if (!words) return true; // an unparseable literal fails closed
  const [first] = words;
  if (words.slice(0, 6).every((w) => w === 0)) return true; // ::, ::1 and every IPv4-compatible ::a.b.c.d
  if ((first & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((first & 0xffc0) === 0xfec0) return true; // site-local fec0::/10
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (first === 0x2001 && words[1] === 0x0db8) return true; // documentation
  const embedded = (hi: number, lo: number): V4 => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  // IPv4-mapped ::ffff:a.b.c.d and NAT64 64:ff9b::a.b.c.d reach the embedded IPv4 address.
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) return isBlockedV4(embedded(words[6], words[7]));
  if (first === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((w) => w === 0)) return isBlockedV4(embedded(words[6], words[7]));
  if (first === 0x2002) return isBlockedV4(embedded(words[1], words[2])); // 6to4
  return false;
}

function parseIpv6(host: string): number[] | null {
  let text = host;
  if (text.includes('.')) {
    const at = text.lastIndexOf(':');
    const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(text.slice(at + 1)) ? parseIpv4(text.slice(at + 1)) : null;
    if (!v4) return null;
    text = `${text.slice(0, at + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const words = (segment: string): number[] | null => {
    if (segment === '') return [];
    const out: number[] = [];
    for (const word of segment.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(word)) return null;
      out.push(parseInt(word, 16));
    }
    return out;
  };
  const head = words(halves[0]);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = words(halves[1]);
  if (!tail || head.length + tail.length > 7) return null;
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

const DOH = 'https://cloudflare-dns.com/dns-query';

/** A and AAAA answers over Cloudflare's DNS-over-HTTPS JSON API; an error reply contributes nothing. */
export function createDohResolver(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): HostResolver {
  return async (hostname) => {
    const answers = await Promise.all((['A', 'AAAA'] as const).map(async (type) => {
      const url = new URL(DOH);
      url.searchParams.set('name', hostname);
      url.searchParams.set('type', type);
      const response = await fetchImpl(url.href, { headers: { accept: 'application/dns-json' } });
      if (!response.ok) return [];
      const body = (await response.json()) as { Answer?: { type?: number; data?: unknown }[] };
      return (body.Answer ?? [])
        .filter((answer) => (answer.type === 1 || answer.type === 28) && typeof answer.data === 'string')
        .map((answer) => answer.data as string);
    }));
    return answers.flat();
  };
}

/** True only when every answer for `hostname` is public; an IP literal was already vetted, and nothing fails closed. */
export async function hostResolvesPublic(hostname: string, resolve: HostResolver): Promise<boolean> {
  if (isIpLiteral(hostname)) return !isBlockedHost(hostname);
  let ips: string[];
  try {
    ips = await resolve(unbracket(hostname));
  } catch {
    return false;
  }
  return ips.length > 0 && ips.every((ip) => !isBlockedHost(ip));
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Fetches `raw` with every hop vetted: the URL syntactically, then its host's DNS answers, then the request with
 * `redirect: 'manual'`. A redirect's Location is resolved against its hop and vetted the same way.
 */
export async function safeFetch(raw: string, remote: RemoteFetch, init: RequestInit = {}): Promise<{ response: Response; url: string }> {
  let url = assertPublicUrl(raw);
  for (let hop = 0; ; hop += 1) {
    if (!(await hostResolvesPublic(url.hostname, remote.resolve))) throw new SsrfBlockedError('blocked-host', url.hostname);
    const response = await remote.fetch(url.href, { ...init, redirect: 'manual' });
    const location = REDIRECTS.has(response.status) ? response.headers.get('location') : null;
    if (!location) return { response, url: url.href };
    await response.body?.cancel();
    if (hop >= MAX_REDIRECTS) throw new SsrfBlockedError('too-many-redirects');
    let next: string;
    try {
      next = new URL(location, url).href;
    } catch {
      throw new SsrfBlockedError('invalid-url', 'location');
    }
    url = assertPublicUrl(next);
  }
}
