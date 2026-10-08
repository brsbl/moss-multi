// The REST client (A§17). Every call carries the agent key or the device-flow session as a bearer, never a cookie,
// so the origin gate passes it (A§18). Content is read as raw bytes: nothing here decodes, trims or appends.
import type { PushRequest, PushResponse } from '@moss-multi/protocol/push';
import { CliError, NOT_SIGNED_IN } from './errors.ts';

export interface DocRow {
  id: string;
  title: string;
  filename: string;
  folderId: string;
  vaultId: string;
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
}

export type Api = ReturnType<typeof createApi>;

function messageOf(text: string): string | null {
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown };
    return typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : null;
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

export function createApi(options: ApiOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.serverUrl;

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (options.token) headers.set('authorization', `Bearer ${options.token}`);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    try {
      return await fetchImpl(`${base}${path}`, { ...init, headers });
    } catch (error) {
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
    /** The doc's markdown file, byte for byte. */
    content: async (id: string): Promise<Uint8Array> => {
      const response = await call(`${doc(id)}/content`);
      if (!response.ok) throw await refusal(response);
      return new Uint8Array(await response.arrayBuffer());
    },
    create: async (input: { title?: string; markdown?: string; folderId?: string }) =>
      (await json<{ doc: { id: string; title: string; filename: string; folderId: string } }>('/api/docs', { method: 'POST', body: body(input) }, 'that folder')).doc,
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
    versions: async (id: string) => (await json<{ versions: VersionRow[] }>(`${doc(id)}/versions`)).versions,
    snapshot: async (id: string, name: string) =>
      (await json<{ version: VersionRow }>(`${doc(id)}/versions`, { method: 'POST', body: body({ name }) })).version,
    comment: async (id: string, input: { id: string; text: string; parentId?: string; anchor?: { quote: string } }) =>
      (await json<{ comment: { id: string; quote: string | null } }>(`${doc(id)}/comments`, { method: 'POST', body: body(input) })).comment,
    share: async (id: string, input: { email: string; role: string } | { agentId: string; role: string }) =>
      json<unknown>(`${doc(id)}/members`, { method: 'POST', body: body(input) }),
    signOut: async () => {
      await call('/api/auth/sign-out', { method: 'POST', body: '{}' });
    },
  };
}
