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

// The pending-write cue (T9.40): a write is only worth mentioning once it has waited a while for its ack. A cue shows
// after PENDING_CUE_AFTER_MS of continuous waiting; at the ack it loses its words at once but its anchor stays until
// CUE_SETTLE_MS of continuous idle (longer while held: its details open or it has focus), so bursts of writes never
// make it flicker. The delay is a presentation choice, not a protocol timeout: outages and refusals do not wait for it.

export const PENDING_CUE_AFTER_MS = 2_000;
export const CUE_SETTLE_MS = 1_000;

export type Cue = 'hidden' | 'pending' | 'settled';

export interface CueClock {
  /** Since when a write has waited, continuously; null while all are acked. */
  pendingSince: number | null;
  /** The cue has shown and not yet left. */
  revealed: boolean;
  /** Since when every write has been acked, while revealed. */
  idleSince: number | null;
}

export const CUE_START: CueClock = { pendingSince: null, revealed: false, idleSince: null };

/** Folds whether a write is unacked at `now` into the clock. */
export function stepCue(clock: CueClock, { unacked, held }: { unacked: boolean; held: boolean }, now: number): CueClock {
  if (unacked) {
    const pendingSince = clock.pendingSince ?? now;
    return { pendingSince, revealed: clock.revealed || now - pendingSince >= PENDING_CUE_AFTER_MS, idleSince: null };
  }
  if (!clock.revealed) return CUE_START;
  const idleSince = clock.idleSince ?? now;
  return !held && now - idleSince >= CUE_SETTLE_MS ? CUE_START : { pendingSince: null, revealed: true, idleSince };
}

export const cueOf = (clock: CueClock): Cue => (!clock.revealed ? 'hidden' : clock.pendingSince !== null ? 'pending' : 'settled');

/** When the clock next changes with no new input, or null. */
export function cueWakeAt(clock: CueClock, held: boolean): number | null {
  if (clock.pendingSince !== null) return clock.revealed ? null : clock.pendingSince + PENDING_CUE_AFTER_MS;
  return clock.revealed && !held && clock.idleSince !== null ? clock.idleSince + CUE_SETTLE_MS : null;
}

interface CueEntry {
  owner: object;
  unacked: boolean;
  held: boolean;
  clock: CueClock;
  timer: ReturnType<typeof setTimeout> | null;
}

// Kept apart from the connection views: `unacked` flips twice per keystroke, and only the cue and open details listen.
const cueEntries = new Map<string, CueEntry>();
const cueListeners = new Set<() => void>();
const heldCues = new Set<string>();

const emitCue = (): void => {
  for (const listener of cueListeners) listener();
};

function advanceCue(docId: string): void {
  const entry = cueEntries.get(docId);
  if (!entry) return;
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = null;
  entry.clock = stepCue(entry.clock, entry, Date.now());
  const at = cueWakeAt(entry.clock, entry.held);
  if (at !== null) entry.timer = setTimeout(() => { advanceCue(docId); emitCue(); }, Math.max(0, at - Date.now()));
}

/** Publishes whether `owner`'s session of `docId` holds unacked writes; null withdraws it, if `owner` still holds it. */
export function publishUnacked(docId: string, owner: object, unacked: boolean | null): void {
  const entry = cueEntries.get(docId);
  if (unacked === null) {
    if (entry?.owner !== owner) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    cueEntries.delete(docId);
  } else if (entry?.owner === owner) {
    if (entry.unacked === unacked) return;
    entry.unacked = unacked;
    advanceCue(docId);
  } else {
    if (entry && entry.timer !== null) clearTimeout(entry.timer);
    cueEntries.set(docId, { owner, unacked, held: heldCues.has(docId), clock: CUE_START, timer: null });
    advanceCue(docId);
  }
  emitCue();
}

/** Keeps `docId`'s cue in place while its details are open or it has focus. */
export function holdCue(docId: string, held: boolean): void {
  if (held) heldCues.add(docId);
  else heldCues.delete(docId);
  const entry = cueEntries.get(docId);
  if (!entry || entry.held === held) return;
  entry.held = held;
  advanceCue(docId);
  emitCue();
}

export const cueFor = (docId: string | null): Cue => (docId ? cueOf(cueEntries.get(docId)?.clock ?? CUE_START) : 'hidden');
export const unackedFor = (docId: string | null): boolean => (docId ? (cueEntries.get(docId)?.unacked ?? false) : false);

function subscribeCue(listener: () => void): () => void {
  cueListeners.add(listener);
  return () => cueListeners.delete(listener);
}

export function useCue(docId: string | null): Cue {
  return useSyncExternalStore(subscribeCue, () => cueFor(docId), () => 'hidden');
}

/** Whether the doc's session holds writes the server has not acked. */
export function useUnacked(docId: string | null): boolean {
  return useSyncExternalStore(subscribeCue, () => unackedFor(docId), () => false);
}
