// The suggest-mode wire (docs/design/suggestions.md §2): doc-socket string frames in the `__YPS:` envelope. Record
// ids are minted by the server with each lease; a client names only a record it was minted or one it authors.

export interface IdSpan {
  client: number;
  clock: number;
  len: number;
}

export type SuggestRequest =
  /**
   * Fresh leases for this connection, or `resume` of this principal's leases whose connection closed or idled.
   * `fork` names the client fork asking (random per fork): the same fork on a new socket may resume its leases while
   * the DocDO still holds the old socket open (a half-open drop), and no other connection may.
   */
  | { t: 'suggest-lease'; resume?: number[]; fork?: string }
  /** One fork transaction's V1 update, base64, in `doc`: the body (the default) or a payload doc by its id. */
  | { t: 'suggest-ops'; record: string; doc?: string; update: string }
  | { t: 'suggest-delete'; record: string; part: { id: string; targets: IdSpan[] } }
  | { t: 'suggest-undelete'; record: string; partId: string }
  | { t: 'suggest-merge'; into: string; from: string }
  | { t: 'suggest-withdraw'; record: string };

export type SuggestRefusal =
  | 'role'
  | 'malformed'
  | 'record'
  | 'not-author'
  | 'record-closed'
  | 'lease'
  | 'lease-cap'
  | 'clock-gap'
  | 'clock-overlap'
  | 'record-cap'
  | 'open-cap'
  | 'ops-cap'
  | 'doc-cap'
  | 'node-type'
  | 'channel'
  | 'target';

export interface LeaseGrant {
  client: number;
  /** The record id minted with this lease; the first frame naming it creates the record. */
  record: string;
  /** The acknowledged clock in the body: the next struct this lease may send there. */
  clock: number;
  /** The acknowledged clock in each doc the lease has written (`body`, or a payload id). */
  clocks: Record<string, number>;
}

export type SuggestReply =
  | { t: 'suggest-leased'; leases: LeaseGrant[] }
  /**
   * The frame landed in `record`, which differs from `requested` when the request opened a continuation of an
   * accepted record or followed a merge. `sv` is each of the record's leases' acknowledged clock in `doc`, the doc the
   * frame wrote (`body` for every frame but a payload op); `parts` the delete parts the record now holds.
   */
  | { t: 'suggest-ack'; record: string; requested: string; doc: string; sv: Record<string, number>; parts: string[] }
  | { t: 'suggest-refused'; record: string | null; reason: SuggestRefusal };

export const SUGGEST_LIMITS = {
  /** Live (unspent, unexpired) leases one principal may hold; a request cannot raise it. */
  liveLeases: 4,
  /** Leases one `suggest-lease` mints: the active one and a spare. */
  leaseBatch: 2,
  /** A lease no frame used for this long expires, as it does when its connection closes. */
  leaseIdleMs: 30 * 60_000,
  /** Refusals per principal per window that start the 4429 cooldown. */
  refusals: { max: 3, windowMs: 60_000 },
  cooldownMs: 60_000,
  /** A string frame larger than this is refused unparsed (base64 of a full record plus framing). */
  frameChars: 400 * 1024,
} as const;
