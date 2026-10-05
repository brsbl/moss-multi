// DocDO admission and gates (A§5.1): the connect order, frame parsing, the write classifier, the write rate and the
// state-size simulation. The DO turns their verdicts into closes; a refused write is never silent.
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import { NAME_MAX_CHARS } from '@moss-multi/protocol/limits';
import { isRole, type Role } from '@moss-multi/protocol/roles';
import {
  CLOSE, decodePartyPrincipal, decodePayloadFrame, PAYLOAD_MESSAGE, TRUSTED, type PayloadFrame, type PrincipalKind,
} from '@moss-multi/protocol/sync';
import type { Revoked } from './persistence.ts';

/** What a socket carries through hibernation (connection.setState). */
export interface Attachment {
  principalId: string;
  kind: PrincipalKind;
  name: string;
  role: Role;
  sessionId: string | null;
  shareToken: string | null;
  presenceAllowed?: boolean;
  /** When the Worker resolved `role` (epoch ms); 0 when unknown, which any principal revocation outdates. */
  resolvedAt?: number;
  /** When this DocDO admitted the socket (its own clock); DOC_SOCKET_MAX_MS later the socket closes 1013. */
  admittedAt?: number;
  /** The access epoch `role` was resolved under (A§8 pull validation); '' when unknown, which re-resolves it. */
  epoch?: string;
}

/** The Worker's trusted headers, or null with no principal or no known role. */
export function attachmentFrom(headers: Headers): Attachment | null {
  const principal = decodePartyPrincipal(headers.get(TRUSTED.principal));
  const role = headers.get(TRUSTED.role);
  if (!principal || !isRole(role)) return null;
  return {
    principalId: principal.id,
    kind: principal.kind,
    name: principal.name.slice(0, NAME_MAX_CHARS),
    role,
    sessionId: headers.get(TRUSTED.session) || null,
    shareToken: headers.get(TRUSTED.share) || null,
    presenceAllowed: headers.get(TRUSTED.presence) === '1' || (headers.get(TRUSTED.presence) === null && principal.kind !== 'anonymous' && !headers.get(TRUSTED.share)),
    resolvedAt: Number(headers.get(TRUSTED.resolvedAt)) || 0,
    epoch: headers.get(TRUSTED.epoch) ?? '',
  };
}

/** The principal id a recheck for everyone revokes: every socket resolved no later than it closes. */
export const EVERYONE = '*';

/**
 * 4402 for an ended session; 4403 for a principal, a share token or everyone revoked no earlier than the socket's role
 * was resolved. A role resolved afterwards read the change, so a demoted or re-added member reconnects, and a link
 * that reaches the note again (a note moved back under it) opens it again.
 */
export function revocationCode(attachment: Attachment, revoked: Revoked): number | null {
  if (attachment.sessionId !== null && revoked.session.has(attachment.sessionId)) return CLOSE.sessionEnded;
  const outdated = (at: number | undefined) => at !== undefined && (attachment.resolvedAt ?? 0) <= at;
  if (outdated(revoked.principal.get(attachment.principalId)) || outdated(revoked.principal.get(EVERYONE))) return CLOSE.revoked;
  if (attachment.shareToken !== null && outdated(revoked.token.get(attachment.shareToken))) return CLOSE.revoked;
  return null;
}

export interface ConnectState {
  revoked: Revoked;
  deleted: boolean;
  /** Open sockets, this one included. */
  connections: number;
  maxConnections: number;
}

/** The onConnect order: 4401, then 4402 and 4403, then 4410, then 4429; null admits. */
export function connectCode(attachment: Attachment | null, state: ConnectState): number | null {
  if (!attachment) return CLOSE.noPrincipal;
  const revoked = revocationCode(attachment, state.revoked);
  if (revoked !== null) return revoked;
  if (state.deleted) return CLOSE.deleted;
  if (state.connections > state.maxConnections) return CLOSE.connectionLimit;
  return null;
}

export type Frame =
  | { kind: 'awareness'; bytes: number }
  | { kind: 'step1' }
  /** A step 2 or an update: a write only if it would change the doc. */
  | { kind: 'sync'; update: Uint8Array }
  /** A decorator payload's own sync (A§10.10). */
  | { kind: 'payload'; payload: PayloadFrame }
  | { kind: 'other' };

/** The y-protocols envelope: message type 0 is sync (step 1, step 2, update), 1 is awareness; 7 is a payload's sync. */
export function parseFrame(message: ArrayBuffer | ArrayBufferView): Frame {
  const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  try {
    const decoder = decoding.createDecoder(bytes);
    const type = decoding.readVarUint(decoder);
    if (type === 1) return { kind: 'awareness', bytes: bytes.byteLength };
    if (type === PAYLOAD_MESSAGE) {
      const payload = decodePayloadFrame(bytes);
      return payload ? { kind: 'payload', payload } : { kind: 'other' };
    }
    if (type !== 0) return { kind: 'other' };
    const step = decoding.readVarUint(decoder);
    if (step === 0) return { kind: 'step1' };
    if (step === 1 || step === 2) return { kind: 'sync', update: decoding.readVarUint8Array(decoder) };
  } catch {
    // A frame that does not parse is dropped like an unknown type.
  }
  return { kind: 'other' };
}

/**
 * The write classifier: a sync frame changes the doc only if it carries a struct the doc's state vector lacks or
 * deletes an item the doc has not deleted. Every step 2 that merely answers a step 1 is inert.
 */
export function wouldChange(doc: Y.Doc, update: Uint8Array): boolean {
  return classifySync(doc, update).changes;
}

/** yjs does not export its DeleteSet type by name. */
export type DeleteSet = ReturnType<typeof Y.createDeleteSet>;

/**
 * The classifier's verdict, the deletes the frame carries (its ack names them, A§5.1 Acks), and whether the frame
 * needs a clock the doc lacks (`missing`).
 */
export function classifySync(doc: Y.Doc, update: Uint8Array): { changes: boolean; missing: boolean; deletes: DeleteSet } {
  const { structs, ds } = Y.decodeUpdate(update);
  return { changes: changes(doc, structs, ds), missing: missing(doc, structs, ds), deletes: ds };
}

/**
 * True when part of the frame would wait in Yjs's pending structs or deletes: a struct past the clocks the doc and the
 * frame hold, an origin or parent the doc lacks, or a delete of clocks it lacks. A pending struct integrates later,
 * inside whichever transaction supplies its dependency, so it would be counted and credited to that transaction's
 * sender. A client sends what it holds, and holds nothing the server lacks, so it never sends one.
 */
function missing(doc: Y.Doc, structs: (Y.Item | Y.GC | Y.Skip)[], ds: DeleteSet): boolean {
  const held = new Map<number, number>();
  const end = (client: number) => held.get(client) ?? Y.getState(doc.store, client);
  for (const struct of structs) {
    if (struct instanceof Y.Skip) continue;
    const { client, clock } = struct.id;
    if (clock > end(client)) return true;
    held.set(client, Math.max(end(client), clock + struct.length));
  }
  const lacks = (id: unknown) => id instanceof Y.ID && id.clock >= end(id.client);
  for (const struct of structs) {
    if (struct instanceof Y.Item && (lacks(struct.origin) || lacks(struct.rightOrigin) || lacks(struct.parent))) return true;
  }
  for (const [client, deletes] of ds.clients) {
    for (const { clock, len } of deletes) if (len > 0 && clock + len > end(client)) return true;
  }
  return false;
}

function changes(doc: Y.Doc, structs: (Y.Item | Y.GC | Y.Skip)[], ds: DeleteSet): boolean {
  for (const struct of structs) {
    if (struct instanceof Y.Skip) continue;
    if (Y.getState(doc.store, struct.id.client) < struct.id.clock + struct.length) return true;
  }
  for (const [client, deletes] of ds.clients) {
    const known = doc.store.clients.get(client) ?? [];
    const state = Y.getState(doc.store, client);
    for (const { clock, len } of deletes) {
      if (len <= 0) continue;
      if (clock + len > state) return true;
      for (let i = Y.findIndexSS(known, clock); i < known.length && known[i].id.clock < clock + len; i += 1) {
        if (!known[i].deleted) return true;
      }
    }
  }
  return false;
}

/** The encoded state the doc would have after `update`, measured on a copy. */
export function stateBytesAfter(doc: Y.Doc, update: Uint8Array): number {
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(copy, update);
    return Y.encodeStateAsUpdate(copy).byteLength;
  } finally {
    copy.destroy();
  }
}

/**
 * Writes per socket in a sliding window, keyed by the socket itself: a client may reuse its connection id while the
 * DO still holds the old socket. In memory: a wake starts every count at zero.
 */
export class WriteRate {
  private readonly hits = new WeakMap<object, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Counts one write; false once the socket is past `max` in the window. */
  allow(socket: object, now = Date.now()): boolean {
    const recent = (this.hits.get(socket) ?? []).filter((at) => now - at < this.windowMs);
    recent.push(now);
    this.hits.set(socket, recent);
    return recent.length <= this.max;
  }

  forget(socket: object): void {
    this.hits.delete(socket);
  }
}
