// POST /api/unfurl {noteId, url} (A§16): the card behind moss's web embeds and pills, read from the page's OpenGraph
// tags. Only a reader of the note may ask (a share link included), the fetch goes through the SSRF guard on every hop
// (A§18), each identity is throttled with 429, and answers are cached for a day. A page that is not HTML, fails or
// names a host with no DNS answers gets a fallback card, fetching nothing in the last case; a URL the guard refuses
// gets 422.
import { resolvePrincipal, sha256Hex, shareTokenOf } from '../auth/principal.ts';
import { createDb } from '../db/client.ts';
import { json } from '../worker/route.ts';
import { resolveDocAccess } from './access.ts';
import { readPrefix, remoteFetch, REMOTE_TIMEOUT_MS, takeFetchToken, type RemoteFetchEnv } from './remote.ts';
import { NO_STORE, notFound, readJsonObject } from './respond.ts';
import { assertPublicUrl, safeFetch, SsrfBlockedError } from './ssrf.ts';

export type UnfurlEnv = RemoteFetchEnv;

export interface Unfurled {
  status: 'resolved' | 'fallback';
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
  icon?: string;
  themeColor?: string;
  canonicalUrl?: string;
}

/** The head of a page is near its start; the rest is never read. */
const PAGE_PREFIX_BYTES = 512 * 1024;
const CACHE_SECONDS = 86_400;
const USER_AGENT = 'Mozilla/5.0 (compatible; moss-multi-unfurl/1.0)';

const refuse = (status: number, error: string, message: string, headers: Record<string, string> = {}) =>
  json({ error, message }, status, { ...NO_STORE, ...headers });

const blockedUrl = () => refuse(422, 'blocked-url', 'That address can’t be previewed.');

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

const clean = (text: string | undefined, max = 300): string | undefined => {
  const value = text === undefined ? '' : decodeEntities(text).replace(/\s+/g, ' ').trim();
  return value ? value.slice(0, max) : undefined;
};

function attributes(tag: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [, name, , double, single, bare] of tag.matchAll(/([a-zA-Z_:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    found[name.toLowerCase()] = double ?? single ?? bare ?? '';
  }
  return found;
}

/** An https URL from a page attribute, made absolute against the page; anything else is dropped. */
function httpsUrl(value: string | undefined, base: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(decodeEntities(value.trim()), base);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** The card a page's head describes: OpenGraph first, then Twitter's tags, then the plain <title> and meta. */
export function parseCard(html: string, pageUrl: string): Omit<Unfurled, 'status' | 'url'> {
  const head = html.slice(0, PAGE_PREFIX_BYTES);
  const meta = new Map<string, string>();
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(tag);
    const key = (attrs.property ?? attrs.name ?? '').toLowerCase();
    if (key && attrs.content !== undefined && !meta.has(key)) meta.set(key, attrs.content);
  }
  const links = [...head.matchAll(/<link\b[^>]*>/gi)].map(([tag]) => attributes(tag));
  const link = (rel: RegExp) => links.find((attrs) => rel.test(attrs.rel ?? ''))?.href;
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const themeColor = meta.get('theme-color')?.trim();
  return {
    title: clean(meta.get('og:title') ?? meta.get('twitter:title') ?? title, 200),
    description: clean(meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description')),
    siteName: clean(meta.get('og:site_name'), 100),
    image: httpsUrl(meta.get('og:image') ?? meta.get('og:image:url') ?? meta.get('twitter:image'), pageUrl),
    icon: httpsUrl(link(/(^|\s)(icon|apple-touch-icon)(\s|$)/i), pageUrl),
    themeColor: themeColor && /^#[0-9a-f]{3,8}$/i.test(themeColor) ? themeColor : undefined,
    canonicalUrl: httpsUrl(meta.get('og:url') ?? link(/(^|\s)canonical(\s|$)/i), pageUrl),
  };
}

async function unfurl(url: string): Promise<Unfurled> {
  const remote = remoteFetch();
  let fetched: { response: Response; url: string };
  try {
    fetched = await safeFetch(url, remote, {
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof SsrfBlockedError && error.reason !== 'unresolved-host') throw error;
    return { status: 'fallback', url };
  }
  const { response } = fetched;
  const type = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!response.ok || !/text\/html|application\/xhtml\+xml/.test(type)) {
    await response.body?.cancel();
    return { status: 'fallback', url };
  }
  const html = new TextDecoder().decode(await readPrefix(response, PAGE_PREFIX_BYTES));
  const card = parseCard(html, fetched.url);
  if (!card.title && !card.description && !card.image) return { status: 'fallback', url };
  return { status: 'resolved', url, ...card };
}

const cacheKey = async (url: string) => new Request(`https://unfurl.moss-multi.invalid/${await sha256Hex(url)}`);
const edgeCache = (): Cache | null => (typeof caches !== 'undefined' && 'default' in caches ? (caches as unknown as { default: Cache }).default : null);

export async function handleUnfurl(request: Request, env: UnfurlEnv): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405, { allow: 'POST' });
  const principal = await resolvePrincipal(request, env);
  const body = await readJsonObject(request);
  const noteId = typeof body?.noteId === 'string' ? body.noteId : '';
  const raw = typeof body?.url === 'string' ? body.url : '';
  if (!noteId || !raw) return refuse(400, 'bad-request', 'Name the note and the address to preview.');
  if (!principal) return notFound();
  const access = await resolveDocAccess(createDb(env.DB), principal, noteId, shareTokenOf(request));
  if (!access || access.deleted) return notFound();
  let url: string;
  try {
    url = assertPublicUrl(raw).href;
  } catch {
    return blockedUrl();
  }
  const cache = edgeCache();
  const key = await cacheKey(url);
  const cached = await cache?.match(key);
  if (cached) return json(await cached.json(), 200, NO_STORE);
  const throttled = await takeFetchToken(env, principal);
  if (throttled) return throttled;
  let card: Unfurled;
  try {
    card = await unfurl(url);
  } catch (error) {
    if (error instanceof SsrfBlockedError) return blockedUrl();
    throw error;
  }
  await cache?.put(key, json(card, 200, { 'cache-control': `max-age=${card.status === 'resolved' ? CACHE_SECONDS : 3600}` }));
  return json(card, 200, NO_STORE);
}
