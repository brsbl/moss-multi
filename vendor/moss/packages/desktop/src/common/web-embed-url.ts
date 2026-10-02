// ported-from: packages/desktop/src/common/web-embed-url.ts @ 762abb777
/**
 * Shared URL classification and validation helpers for webpage embeds.
 *
 * These helpers validate `WebEmbedNode` URLs, main-process oEmbed fetch targets,
 * and nested `<iframe src>` values inside `moss-html`. Renderer-side validation
 * is syntactic and fast; the main-process fetcher performs the authoritative
 * resolved-address (DNS) checks before any response body is read.
 */

/** Obvious downloadable file extensions that should never be framed. */
const DOWNLOADABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.dmg',
  '.exe',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.iso',
  '.msi',
  '.pkg',
  '.deb',
  '.rpm',
  '.apk',
  '.bin'
]);

const SCHEME_RE = /^[a-z][a-z\d+.-]*:/i;
const SCHEMELESS_URL_DISALLOWED_CHARS_RE = /[\s<>{}|\\^[\]`]/;
const SCHEMELESS_LOCAL_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  ...DOWNLOADABLE_EXTENSIONS,
  '.avif',
  '.bmp',
  '.csv',
  '.gif',
  '.heic',
  '.ico',
  '.jpeg',
  '.jpg',
  '.json',
  '.m4v',
  '.markdown',
  '.md',
  '.mov',
  '.mp3',
  '.mp4',
  '.pdf',
  '.png',
  '.svg',
  '.tsv',
  '.txt',
  '.wav',
  '.webm',
  '.webp',
  '.yaml',
  '.yml'
]);

const TWITTER_STATUS_HOSTS: ReadonlySet<string> = new Set([
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'x.com',
  'www.x.com'
]);

const TWITTER_STATUS_PATH_RE = /^\/[^/]+\/status\/\d+/;
const FIGMA_HOSTS: ReadonlySet<string> = new Set(['figma.com', 'www.figma.com']);
const FIGMA_EMBED_PATH_KINDS: ReadonlySet<string> = new Set([
  'board',
  'deck',
  'design',
  'file',
  'proto',
  'slides'
]);
const FIGMA_EMBED_QUERY_PARAMS: ReadonlySet<string> = new Set([
  'client-id',
  'footer',
  'm',
  'mode',
  'node-id',
  'page-selector',
  'starting-point-node-id',
  'theme',
  'viewport-controls'
]);

const parseHttpsUrl = (text: string): URL | null => {
  const trimmed = normalizeSchemelessWebUrl(text.trim());
  if (trimmed.length === 0) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') {
    return null;
  }
  if (url.hostname.length === 0) {
    return null;
  }
  // Reject credentialed URLs (userinfo can mask the real host / leak secrets).
  if (url.username !== '' || url.password !== '') {
    return null;
  }
  return url;
};

const parseHttpOrHttpsUrl = (text: string): URL | null => {
  const trimmed = normalizeSchemelessWebUrl(text.trim());
  if (trimmed.length === 0) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }
  if (url.hostname.length === 0) {
    return null;
  }
  // Reject credentialed URLs (userinfo can mask the real host / leak secrets).
  if (url.username !== '' || url.password !== '') {
    return null;
  }
  return url;
};

/** Strip the IPv6 bracket wrapper that `URL.hostname` keeps for literals. */
const stripIpv6Brackets = (hostname: string): string =>
  hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

const isIpv4 = (host: string): boolean => {
  const parts = host.split('.');
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
};

const ipv4ToNumber = (host: string): number | null => {
  if (!isIpv4(host)) {
    return null;
  }
  return host.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
};

const ipv4Cidr = (base: string, prefixLength: number): { base: number; mask: number } => {
  const baseNumber = ipv4ToNumber(base);
  if (baseNumber === null) {
    throw new Error(`Invalid IPv4 CIDR base: ${base}`);
  }
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return { base: baseNumber, mask };
};

const SPECIAL_USE_IPV4_CIDRS: ReadonlyArray<{ base: number; mask: number }> = [
  ipv4Cidr('0.0.0.0', 8), // this network
  ipv4Cidr('10.0.0.0', 8), // private
  ipv4Cidr('100.64.0.0', 10), // carrier-grade NAT
  ipv4Cidr('127.0.0.0', 8), // loopback
  ipv4Cidr('169.254.0.0', 16), // link-local
  ipv4Cidr('172.16.0.0', 12), // private
  ipv4Cidr('192.0.0.0', 24), // IETF protocol assignments
  ipv4Cidr('192.0.2.0', 24), // documentation TEST-NET-1
  ipv4Cidr('192.88.99.0', 24), // deprecated 6to4 relay anycast
  ipv4Cidr('192.168.0.0', 16), // private
  ipv4Cidr('198.18.0.0', 15), // benchmarking
  ipv4Cidr('198.51.100.0', 24), // documentation TEST-NET-2
  ipv4Cidr('203.0.113.0', 24), // documentation TEST-NET-3
  ipv4Cidr('224.0.0.0', 4), // multicast
  ipv4Cidr('240.0.0.0', 4), // reserved, including 255.255.255.255
  ipv4Cidr('255.255.255.255', 32) // limited broadcast
];

const isPrivateOrReservedIpv4 = (host: string): boolean => {
  const address = ipv4ToNumber(host);
  if (address === null) {
    return false;
  }
  return SPECIAL_USE_IPV4_CIDRS.some(({ base, mask }) => ((address & mask) >>> 0) === ((base & mask) >>> 0));
};

/**
 * Expand an IPv6 literal (already bracket-free, lowercased) into 8 hextets.
 * Handles `::` zero-compression and a trailing embedded IPv4 (`::ffff:127.0.0.1`).
 * Returns null for anything that is not a well-formed IPv6 address.
 */
const expandIpv6 = (input: string): number[] | null => {
  let s = input;
  const lastColon = s.lastIndexOf(':');
  if (lastColon !== -1 && s.slice(lastColon + 1).includes('.')) {
    const dotted = s.slice(lastColon + 1);
    if (!isIpv4(dotted)) {
      return null;
    }
    const [a, b, c, d] = dotted.split('.').map(Number);
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : [];

  let groups: string[];
  if (halves.length === 1) {
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) {
      return null; // '::' must compress at least one group
    }
    groups = [...head, ...new Array(missing).fill('0'), ...tail];
  }
  if (groups.length !== 8) {
    return null;
  }

  const hextets: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) {
      return null;
    }
    hextets.push(parseInt(group, 16));
  }
  return hextets;
};

const hasIpv6Prefix = (hextets: number[], prefix: number[], prefixBits: number): boolean => {
  let remainingBits = prefixBits;
  for (let index = 0; index < 8; index += 1) {
    if (remainingBits <= 0) {
      return true;
    }
    const bits = Math.min(remainingBits, 16);
    const mask = (0xffff << (16 - bits)) & 0xffff;
    if ((hextets[index] & mask) !== (prefix[index] & mask)) {
      return false;
    }
    remainingBits -= bits;
  }
  return true;
};

const isPrivateOrReservedIpv6Hextets = (h: number[]): boolean => {
  if (h.every((value) => value === 0)) {
    return true; // :: unspecified
  }
  if (h.slice(0, 7).every((value) => value === 0) && h[7] === 1) {
    return true; // ::1 loopback
  }
  // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible (::a.b.c.d):
  // validate the embedded IPv4 against the v4 ranges, in dotted or hex form.
  const isV4Mapped = h.slice(0, 5).every((value) => value === 0) && h[5] === 0xffff;
  const isV4Compat = h.slice(0, 6).every((value) => value === 0);
  if (isV4Mapped || isV4Compat) {
    const ipv4 = `${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`;
    return isPrivateOrReservedIpv4(ipv4);
  }
  if ((h[0] & 0xffc0) === 0xfe80) {
    return true; // fe80::/10 link-local
  }
  if ((h[0] & 0xfe00) === 0xfc00) {
    return true; // fc00::/7 unique-local
  }
  if ((h[0] & 0xff00) === 0xff00) {
    return true; // ff00::/8 multicast
  }
  if (hasIpv6Prefix(h, [0x0064, 0xff9b, 0, 0, 0, 0, 0, 0], 96)) {
    return true; // 64:ff9b::/96 NAT64 well-known prefix
  }
  if (hasIpv6Prefix(h, [0x0100, 0, 0, 0, 0, 0, 0, 0], 64)) {
    return true; // 100::/64 discard-only
  }
  if (hasIpv6Prefix(h, [0x2001, 0, 0, 0, 0, 0, 0, 0], 23)) {
    return true; // 2001::/23 IETF protocol assignments, including Teredo
  }
  if (h[0] === 0x2002) {
    return true; // 2002::/16 6to4
  }
  if (h[0] === 0x2001 && h[1] === 0x0db8) {
    return true; // 2001:db8::/32 documentation
  }
  return false;
};

export function isSpecialUseIpAddress(address: string): boolean {
  const host = stripIpv6Brackets(address.trim()).toLowerCase().replace(/\.+$/, '');
  if (host.includes('%')) {
    return true;
  }
  if (isIpv4(host)) {
    return isPrivateOrReservedIpv4(host);
  }
  if (host.includes(':')) {
    const hextets = expandIpv6(host);
    return hextets ? isPrivateOrReservedIpv6Hextets(hextets) : false;
  }
  return false;
}

/**
 * True when a hostname is local, loopback, link-local, or a private/reserved IP
 * literal. Public DNS names that resolve to private space are not caught here —
 * that is the main-process fetcher's job.
 */
export function isPrivateOrLocalHostname(hostname: string): boolean {
  // Strip a fully-qualified trailing dot so `localhost.` / `127.0.0.1.` are caught.
  const host = stripIpv6Brackets(hostname.trim()).toLowerCase().replace(/\.+$/, '');
  if (host.length === 0) {
    return true;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  if (host.endsWith('.local')) {
    return true; // mDNS
  }
  if (isIpv4(host)) {
    return isSpecialUseIpAddress(host);
  }
  if (host.includes(':')) {
    const hextets = expandIpv6(host);
    // Unparseable IPv6-form host → treat as unsafe rather than letting it pass.
    return hextets ? isPrivateOrReservedIpv6Hextets(hextets) : true;
  }
  return false;
}

/** True only for loopback hosts that are safe to use in the interactive browser. */
export function isBrowserLoopbackHostname(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname.trim()).toLowerCase().replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  if (isIpv4(host)) {
    const address = ipv4ToNumber(host);
    const loopbackBase = ipv4ToNumber('127.0.0.0');
    return address !== null && loopbackBase !== null && ((address & 0xff000000) >>> 0) === loopbackBase;
  }
  if (host.includes(':')) {
    const hextets = expandIpv6(host);
    if (!hextets) {
      return false;
    }
    if (hextets.slice(0, 7).every((value) => value === 0) && hextets[7] === 1) {
      return true;
    }
    const isV4Mapped = hextets.slice(0, 5).every((value) => value === 0) && hextets[5] === 0xffff;
    if (isV4Mapped) {
      const ipv4 = `${hextets[6] >> 8}.${hextets[6] & 0xff}.${hextets[7] >> 8}.${hextets[7] & 0xff}`;
      return isBrowserLoopbackHostname(ipv4);
    }
  }
  return false;
}

const hasDownloadableExtension = (pathname: string): boolean => {
  const lastDot = pathname.lastIndexOf('.');
  if (lastDot === -1) {
    return false;
  }
  const lastSlash = pathname.lastIndexOf('/');
  if (lastDot < lastSlash) {
    return false;
  }
  return DOWNLOADABLE_EXTENSIONS.has(pathname.slice(lastDot).toLowerCase());
};

const looksLikeSchemelessWebHost = (hostname: string): boolean => {
  const host = stripIpv6Brackets(hostname.trim()).toLowerCase().replace(/\.+$/, '');
  if (host.length === 0) {
    return false;
  }
  if (isBrowserLoopbackHostname(host)) {
    return true;
  }
  if (isIpv4(host) || host.includes(':')) {
    return true;
  }
  if (!host.includes('.')) {
    return false;
  }
  const labels = host.split('.');
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    return false;
  }
  const tld = labels[labels.length - 1] ?? '';
  if (!/^[a-z][a-z0-9-]{1,23}$/.test(tld)) {
    return false;
  }
  return !SCHEMELESS_LOCAL_FILE_EXTENSIONS.has(`.${tld}`);
};

const normalizeSchemelessWebUrl = (trimmed: string): string => {
  if (
    trimmed.length === 0 ||
    SCHEME_RE.test(trimmed) ||
    trimmed.startsWith('//') ||
    /^[./~#?]/.test(trimmed) ||
    SCHEMELESS_URL_DISALLOWED_CHARS_RE.test(trimmed)
  ) {
    return trimmed;
  }

  let url: URL;
  try {
    url = new URL(`https://${trimmed}`);
  } catch {
    return trimmed;
  }
  if (url.username !== '' || url.password !== '' || !looksLikeSchemelessWebHost(url.hostname)) {
    return trimmed;
  }
  return url.href;
};

/** Parse + normalize a candidate URL. Returns the canonical href, or null. */
export function normalizeWebEmbedUrl(text: string): string | null {
  const url = parseHttpsUrl(text);
  if (!url) {
    return null;
  }
  return url.href;
}

/**
 * Syntactic safety predicate: HTTPS, non-local/private host, not an obvious
 * downloadable file. Does not classify image/video — callers order those first.
 */
export function isSafeWebEmbedUrl(text: string): boolean {
  const url = parseHttpsUrl(text);
  if (!url) {
    return false;
  }
  if (isPrivateOrLocalHostname(url.hostname)) {
    return false;
  }
  if (hasDownloadableExtension(url.pathname)) {
    return false;
  }
  return true;
}

/**
 * Browser-surface safety predicate: public HTTPS is allowed as before, and
 * loopback HTTP(S) (`localhost`/`*.localhost`/`127.0.0.0/8`/`::1`) is allowed so
 * local dev servers can render as Moss browser pills. LAN / private hosts
 * (`192.168.x`, `10.x`, `172.16-31.x`, link-local, `.local`, etc.) are NOT
 * supported in the in-app browser surface — they fall back to opening
 * externally. Metadata fetches still use `isSafeWebEmbedUrl`, so loopback
 * targets are not fetched by the SSRF-guarded preview pipeline either.
 */
export function isSafeWebBrowserUrl(text: string): boolean {
  const url = parseHttpOrHttpsUrl(text);
  if (!url) {
    return false;
  }
  if (hasDownloadableExtension(url.pathname)) {
    return false;
  }
  if (isBrowserLoopbackHostname(url.hostname)) {
    return true;
  }
  if (isPrivateOrLocalHostname(url.hostname)) {
    return false;
  }
  return url.protocol === 'https:' && isSafeWebEmbedUrl(url.href);
}

/** Parse + normalize an interactive browser URL. Returns the canonical href, or null. */
export function normalizeWebBrowserUrl(text: string): string | null {
  const url = parseHttpOrHttpsUrl(text);
  if (!url || !isSafeWebBrowserUrl(url.href)) {
    return null;
  }
  return url.href;
}

export function toFigmaEmbedUrl(text: string): string | null {
  const url = parseHttpsUrl(text);
  if (!url) {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'embed.figma.com') {
    const embedUrl = new URL(url.href);
    if (!embedUrl.searchParams.get('embed-host')) {
      embedUrl.searchParams.set('embed-host', 'moss');
    }
    return isSafeWebBrowserUrl(embedUrl.href) ? embedUrl.href : null;
  }
  if (!FIGMA_HOSTS.has(hostname)) {
    return null;
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const rawKind = segments[0]?.toLowerCase();
  const fileKey = segments[1];
  if (!rawKind || !FIGMA_EMBED_PATH_KINDS.has(rawKind) || !fileKey) {
    return null;
  }

  const embedKind = rawKind === 'file' ? 'design' : rawKind;
  const embedPath = [embedKind, fileKey, ...segments.slice(2)].join('/');
  const embedUrl = new URL(`https://embed.figma.com/${embedPath}`);
  embedUrl.searchParams.set('embed-host', 'moss');
  for (const [key, value] of url.searchParams.entries()) {
    if (FIGMA_EMBED_QUERY_PARAMS.has(key) && key !== 'embed-host') {
      embedUrl.searchParams.append(key, value);
    }
  }
  return isSafeWebBrowserUrl(embedUrl.href) ? embedUrl.href : null;
}

export function resolveRemoteWebSurfaceUrl(text: string): string {
  return toFigmaEmbedUrl(text) ?? text;
}

/** True for `twitter.com`/`x.com`-family `/{handle}/status/{id}` URLs. */
export function isTwitterStatusUrl(text: string): boolean {
  const url = parseHttpsUrl(text);
  if (!url) {
    return false;
  }
  if (!TWITTER_STATUS_HOSTS.has(url.hostname.toLowerCase())) {
    return false;
  }
  return TWITTER_STATUS_PATH_RE.test(url.pathname);
}

/** Readable title derived from a URL: hostname without a leading `www.`. */
export function extractWebEmbedTitle(url: string): string {
  const parsed = parseHttpsUrl(url);
  if (!parsed) {
    return url.trim();
  }
  return parsed.hostname.replace(/^www\./, '');
}
