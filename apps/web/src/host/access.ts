// The tab's knowledge of its role on each doc (A§8): from the workspace listing, a create, or GET /api/docs/:id. The
// pane gates editing on it and the top bar offers Share on it; both read roles.ts, as the server does.
import { isRole, type Role } from '@moss-multi/protocol/roles';
import { useEffect, useSyncExternalStore } from 'react';

/** A doc's listing fields as `GET /api/docs/:id` returns them (epoch ms). */
export interface AccessibleDoc {
  id: string;
  folderId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

/** `GET /api/docs/:id` as the client reads it. */
export type DocAnswer =
  | { kind: 'open'; role: Role; doc: AccessibleDoc }
  /** Missing, trashed or not the caller's: the API cannot tell them apart, and neither does the page. */
  | { kind: 'denied' }
  | { kind: 'signed-out' }
  /** A transient failure: ask again, never conclude anything (R10). */
  | { kind: 'unavailable' };

const roles = new Map<string, Role>();
const listeners = new Set<() => void>();
const asking = new Map<string, Promise<DocAnswer>>();

export function rememberRole(docId: string, role: unknown): void {
  if (!isRole(role) || roles.get(docId) === role) return;
  roles.set(docId, role);
  for (const listener of listeners) listener();
}

export const knownRole = (docId: string): Role | null => roles.get(docId) ?? null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const shareParam = (): string | null => (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('share'));

/** One read of the doc and the caller's role; concurrent asks for one doc share it. */
export function askDocAccess(docId: string, fetcher: typeof fetch = (input, init) => fetch(input, init)): Promise<DocAnswer> {
  let pending = asking.get(docId);
  if (!pending) {
    pending = readDocAccess(docId, fetcher).finally(() => asking.delete(docId));
    asking.set(docId, pending);
  }
  return pending;
}

async function readDocAccess(docId: string, fetcher: typeof fetch): Promise<DocAnswer> {
  const share = shareParam();
  let response: Response;
  try {
    response = await fetcher(`/api/docs/${encodeURIComponent(docId)}`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(share ? { 'x-moss-share': share } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { kind: 'unavailable' };
  }
  if (response.status === 404) return { kind: 'denied' };
  if (response.status === 401) return { kind: 'signed-out' };
  if (!response.ok) return { kind: 'unavailable' };
  try {
    const body = (await response.json()) as { role?: unknown; doc?: AccessibleDoc };
    if (!isRole(body.role) || !body.doc) return { kind: 'unavailable' };
    rememberRole(docId, body.role);
    return { kind: 'open', role: body.role, doc: body.doc };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** Waits between failed asks: 1 s, 2 s, 4 s, 8 s, then every 15 s. */
const RETRY_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

/** The caller's role on the doc, asking the server when the tab does not know it yet; null until it is known. */
export function useDocRole(docId: string | null): Role | null {
  const role = useSyncExternalStore(subscribe, () => (docId ? knownRole(docId) : null), () => null);
  useEffect(() => {
    if (!docId || knownRole(docId)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async (attempt: number) => {
      const answer = await askDocAccess(docId);
      if (stopped || answer.kind !== 'unavailable') return;
      timer = setTimeout(() => void ask(attempt + 1), RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]);
    };
    void ask(0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [docId]);
  return role;
}

export { RETRY_MS as ACCESS_RETRY_MS };
