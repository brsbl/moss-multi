// The REST client (A§17). Every call carries the agent key or the device-flow session as a bearer, never a cookie,
// so the origin gate passes it (A§18). Content is read as raw bytes: nothing here decodes, trims or appends.
// No request follows a redirect: a 3xx is an error, so a credential is only ever sent to the configured server.
import type { PushRequest, PushResponse } from '@moss-multi/protocol/push';
import { CliError, NOT_SIGNED_IN } from './errors.ts';
import { fieldSafe } from './output.ts';

export interface DocRow {
  id: string;
  title: string;
  filename: string;
  folderId: string;
  vaultId: string | null;
  role: string;
  updatedAt: number;
}

export interface VaultRow {
  id: string;
  name: string;
  role: string;
  owned: boolean;
}

export interface VersionRow {
  id: string;
  kind: string;
  name: string | null;
  createdAt: number;
  title: string;
}

export interface CommentRow {
  id: string;
  parentId: string | null;
  author: { id: string; name: string; type: 'user' | 'agent' };
  text: string;
  quote: string | null;
  status: 'anchored' | 'orphaned' | null;
  resolved: boolean;
  createdAt: number;
}

export interface SuggestionRow {
  id: string;
  author: { id: string; name: string };
  status: string;
  source: string;
  createdAt: number;
  updatedAt: number;
  outdated: boolean;
}

export interface Me {
  type: 'user' | 'agent';
  id: string;
  name: string;
  email?: string;
}

export interface ApiOptions {
  serverUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
  /**
   * Stops the client (`watch` on Ctrl+C): a read in flight is aborted and none starts after it. A write is never
   * aborted once sent, so its answer can be recorded; nor is a read marked `finish`, which records one.
   */
  signal?: AbortSignal;
}

export type Api = ReturnType<typeof createApi>;

function messageOf(text: string): string | null {
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown };
    const message = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : null;
    // It ends up in a one-line error header, so a line break in it can't forge another line.
    return message === null ? null : fieldSafe(message);
  } catch {
    return null;
  }
}

/** A refused request as a CliError with exit code 1; `what` names the thing asked for in a 404. */
export async function refusal(response: Response, what = 'that doc', read?: string): Promise<CliError> {
  const status = response.status;
  if (status === 401) return new CliError(1, NOT_SIGNED_IN, status);
  if (status === 404) return new CliError(1, `not found: ${what} does not exist or you can't open it`, status);
  if (status === 429) {
    const after = response.headers.get('retry-after');
    return new CliError(1, `rate limited${after ? `: try again in ${after} s` : ''}`, status);
  }
  if (status === 413) return new CliError(1, 'too large: a note holds at most 2 MB of markdown', status);
  const message = messageOf(read ?? (await response.text().catch(() => '')));
  if (status === 403) return new CliError(1, `forbidden${message && message !== 'forbidden' ? `: ${message}` : ''}`, status);
  return new CliError(1, `the server refused the request (HTTP ${status})${message ? `: ${message}` : ''}`, status);
}

/** `fetch` with redirects refused: a 3xx answer (or an opaque redirect) becomes an error naming where it pointed. */
export async function fetchNoRedirect(fetchImpl: typeof fetch, url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetchImpl(url, { ...init, redirect: 'manual' });
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    const location = response.headers.get('location');
    let where = 'elsewhere';
    try {
      if (location) where = new URL(location, url).origin === new URL(url).origin ? new URL(location, url).pathname : new URL(location, url).origin;
    } catch {
      // An unparseable Location still refuses.
    }
    throw new CliError(1, `the server answered with a redirect (HTTP ${response.status}) to ${where}; moss-multi does not follow redirects, so set MOSS_MULTI_SERVER to the address it should use`);
  }
  return response;
}

export function createApi(options: ApiOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.serverUrl;

  async function call(path: string, init: RequestInit = {}, finish = false): Promise<Response> {
    const read = (init.method ?? 'GET') === 'GET' || init.method === 'HEAD';
    const stoppable = read && !finish && options.signal ? { signal: options.signal } : {};
    const headers = new Headers(init.headers);
    if (options.token) headers.set('authorization', `Bearer ${options.token}`);
    if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
    try {
      return await fetchNoRedirect(fetchImpl, `${base}${path}`, { ...init, ...stoppable, headers });
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(1, `cannot reach ${base}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function json<T>(path: string, init: RequestInit = {}, what?: string): Promise<T> {
    const response = await call(path, init);
    if (!response.ok) throw await refusal(response, what);
    return (await response.json()) as T;
  }

  const doc = (id: string) => `/api/docs/${encodeURIComponent(id)}`;
  const body = (value: unknown) => JSON.stringify(value);

  return {
    serverUrl: base,
    me: async () => (await json<{ principal: Me }>('/api/me')).principal,
    listDocs: async () => (await json<{ docs: DocRow[] }>('/api/docs')).docs,
    listVaults: async () => (await json<{ vaults: VaultRow[] }>('/api/vaults')).vaults,
    /** The doc's markdown file, byte for byte; `finish`: the read records a write already made, so it is never aborted. */
    content: async (id: string, finish = false): Promise<Uint8Array> => {
      const response = await call(`${doc(id)}/content`, {}, finish);
      if (!response.ok) throw await refusal(response);
      return new Uint8Array(await response.arrayBuffer());
    },
    /**
     * `titleLine`: a leading `# Title` line is the title (moss interchange); `comments`: moss's comments.json. The
     * answer's `content` is the created revision's export (absent from a server that predates it).
     */
    create: async (input: { title?: string; markdown?: string; folderId?: string; titleLine?: boolean; comments?: Record<string, unknown> }) => {
      const created = await json<{ doc: { id: string; title: string; filename: string; folderId: string }; content?: unknown }>('/api/docs', { method: 'POST', body: body(input) }, 'that folder');
      return { doc: created.doc, content: typeof created.content === 'string' ? created.content : undefined };
    },
    rename: async (id: string, title: string) =>
      (await json<{ doc: { id: string; title: string } }>(doc(id), { method: 'PATCH', body: body({ title }) })).doc,
    trash: async (id: string) => {
      const response = await call(doc(id), { method: 'DELETE' });
      if (!response.ok) throw await refusal(response);
      return (await response.json()) as { doc: { id: string } };
    },
    /** A push answers a PushResponse even when it refuses; anything else is an error. */
    push: async (id: string, request: PushRequest): Promise<PushResponse> => {
      const response = await call(`${doc(id)}/push`, { method: 'POST', body: body(request) });
      const text = await response.text();
      try {
        const parsed = JSON.parse(text) as PushResponse & { ok?: unknown };
        if (typeof parsed.ok === 'boolean') {
          const after = response.headers.get('retry-after');
          return !parsed.ok && parsed.reason === 'rate-limited' && after ? { ...parsed, retryAfterSec: Number(after) } : parsed;
        }
      } catch {
        // Not a push answer: map the status below.
      }
      throw await refusal(response, 'that doc', text);
    },
    /** The sha256 of the doc's media file `name` (its ETag), or null when the doc has none by that name. */
    assetHash: async (id: string, name: string): Promise<string | null> => {
      const response = await call(`${doc(id)}/assets/${encodeURIComponent(name)}`, { method: 'HEAD' });
      if (response.status === 404) return null;
      if (!response.ok) throw await refusal(response, `assets/${name}`, '');
      return /^"([0-9a-f]{64})"$/.exec(response.headers.get('etag') ?? '')?.[1] ?? '';
    },
    /** The doc's media file `name`, byte for byte. */
    asset: async (id: string, name: string): Promise<Uint8Array> => {
      const response = await call(`${doc(id)}/assets/${encodeURIComponent(name)}`);
      if (!response.ok) throw await refusal(response, `assets/${name}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    /** Uploads `bytes` into the doc as `name`; answers the name the doc stores them under, which may differ. */
    uploadAsset: async (id: string, name: string, bytes: Uint8Array, contentType: string): Promise<string> => {
      const response = await call(`${doc(id)}/assets?filename=${encodeURIComponent(name)}`, { method: 'POST', body: bytes, headers: { 'content-type': contentType } });
      const text = await response.text();
      if (!response.ok) {
        const message = messageOf(text);
        // The server's own words for what it refused (size, type, quota, rate), past the generic mapping.
        if (message && ![401, 404].includes(response.status) && message !== 'forbidden') throw new CliError(1, message, response.status);
        throw await refusal(response, 'that doc', text);
      }
      const answer = JSON.parse(text) as { filename?: unknown };
      if (typeof answer.filename !== 'string') throw new CliError(1, 'the server answered the upload without a file name');
      return answer.filename;
    },
    versions: async (id: string) => (await json<{ versions: VersionRow[] }>(`${doc(id)}/versions`)).versions,
    snapshot: async (id: string, name: string) =>
      (await json<{ version: VersionRow }>(`${doc(id)}/versions`, { method: 'POST', body: body({ name }) })).version,
    comment: async (id: string, input: { id: string; text: string; parentId?: string; anchor?: { quote: string } }) =>
      (await json<{ comment: { id: string; quote: string | null } }>(`${doc(id)}/comments`, { method: 'POST', body: body(input) })).comment,
    comments: async (id: string) => (await json<{ comments: CommentRow[] }>(`${doc(id)}/comments`)).comments,
    suggestions: async (id: string) => (await json<{ suggestions: SuggestionRow[] }>(`${doc(id)}/suggestions`)).suggestions,
    share: async (id: string, input: { email: string; role: string } | { agentId: string; role: string }) =>
      json<{ shared?: { email?: unknown; role?: unknown } }>(`${doc(id)}/members`, { method: 'POST', body: body(input) }),
    /** The doc's open invites with their copyable links (owners only). */
    invites: async (id: string) => (await json<{ invites: { email: string; role: string; url: string }[] }>(`${doc(id)}/invites`)).invites,
    /** The auth routes refuse an unsafe request without an Origin; the server's own origin is the one they accept. */
    signOut: async (): Promise<boolean> =>
      (await call('/api/auth/sign-out', { method: 'POST', body: '{}', headers: { origin: new URL(base).origin } })).ok,
  };
}
