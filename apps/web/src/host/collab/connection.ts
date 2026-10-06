// Connection truth (A§10.5): one reducer over a doc session's socket events and its heartbeat's verdicts. It never
// reads navigator.onLine, which knows nothing of a half-open socket (L§4.6). Each session publishes what it says for
// its doc; the indicator in the top bar and the banner in the notice band read it.
import type { ConnectionState } from '@moss-multi/protocol/dom-contract';
import { useSyncExternalStore } from 'react';

/** The heartbeat's check: an OPEN socket silent longer than SILENCE_LIMIT_MS is closed 4408 and detached. */
export const HEARTBEAT_CHECK_MS = 1_000;
export const SILENCE_LIMIT_MS = 12_000;
/** A sync step 1 this often keeps frames flowing while visible: the server always answers with a step 2. */
export const RESYNC_MS = 4_000;
/** A first sync later than this reads `retrying` (A§10.3). */
export const FIRST_SYNC_DEADLINE_MS = 8_000;
/** Not delivering for this long reads `offline`, and the banner shows (glyphdown's 10 s). */
export const OFFLINE_AFTER_MS = 10_000;
/** Consecutive handshakes that fail before opening, after which the client stops and asks REST. */
export const HANDSHAKE_FAILURES = 3;

/** Whether the doc's channel delivers, and since when it has not. */
export interface Link {
  /** The socket is open and has applied the server's step 2 on it. */
  delivering: boolean;
  /** When delivery stopped: the last frame heard before a silence, the close, or the session's start. */
  lostAt: number | null;
}

export type LinkEvent =
  /** The server's step 2 landed on the current socket. */
  | { type: 'synced' }
  /** The socket closed or failed to open. */
  | { type: 'closed'; at: number }
  /** The heartbeat found the socket silent since `lastHeard`. */
  | { type: 'silent'; lastHeard: number };

export const startLink = (at: number): Link => ({ delivering: false, lostAt: at });

export function reduceLink(link: Link, event: LinkEvent): Link {
  switch (event.type) {
    case 'synced':
      return { delivering: true, lostAt: null };
    case 'closed':
      return { delivering: false, lostAt: link.lostAt ?? event.at };
    case 'silent':
      return { delivering: false, lostAt: Math.min(link.lostAt ?? event.lastHeard, event.lastHeard) };
  }
}

export function connectionOf(link: Link, now: number): ConnectionState {
  if (link.delivering) return 'online';
  return link.lostAt !== null && now - link.lostAt >= OFFLINE_AFTER_MS ? 'offline' : 'reconnecting';
}

/** What a doc's session says about its connection, for the indicator and the banner. */
export interface DocConnection {
  connection: ConnectionState;
  /** The doc has had its first sync in this session. */
  synced: boolean;
  /** The first sync is past its deadline. */
  retrying: boolean;
}

const views = new Map<string, { owner: object; view: DocConnection }>();
const listeners = new Set<() => void>();

/** Publishes `owner`'s view of `docId`; null withdraws it, if `owner` still holds it. */
export function publishConnection(docId: string, owner: object, view: DocConnection | null): void {
  const held = views.get(docId);
  if (view === null) {
    if (held?.owner !== owner) return;
    views.delete(docId);
  } else {
    if (held?.owner === owner && sameView(held.view, view)) return;
    views.set(docId, { owner, view });
  }
  for (const listener of listeners) listener();
}

const sameView = (a: DocConnection, b: DocConnection): boolean =>
  a.connection === b.connection && a.synced === b.synced && a.retrying === b.retrying;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDocConnection(docId: string | null): DocConnection | null {
  return useSyncExternalStore(
    subscribe,
    () => (docId ? (views.get(docId)?.view ?? null) : null),
    () => null,
  );
}
