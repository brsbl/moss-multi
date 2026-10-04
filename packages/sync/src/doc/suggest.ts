// Suggest-mode ingest in the DocDO (docs/design/suggestions.md §3): bookkeeping, not authorization. Leases, the
// `suggest-ops` append and `suggest-delete` validation, each O(frame). The spike keeps leases in memory; T5.2
// persists them in `suggest_leases` and wires the doc-socket frames.
import * as Y from 'yjs';
import type { IdSpan } from '@moss-multi/core/suggest/apply';

export interface SuggestPrincipal {
  id: string;
  name: string;
}

export interface Lease {
  client: number;
  principal: string;
  record: string | null;
  nextClock: number;
  spent: boolean;
}

export const SUGGEST_CAPS = {
  /** Bytes of ops per record. */
  recordOpsBytes: 256 * 1024,
  openPerPrincipal: 20,
  /** All open records' ops, as a share of the state cap. */
  openOpsShare: 0.25,
  /** Spans per delete part, and items a part may name. */
  partSpans: 1024,
  partItems: 20_000,
} as const;

export type IngestRefusal =
  | 'role'
  | 'malformed'
  | 'not-author'
  | 'record-closed'
  | 'lease'
  | 'clock-gap'
  | 'record-cap'
  | 'open-cap'
  | 'ops-cap'
  | 'node-type'
  | 'target';

export type IngestResult = { ok: true; record: string; clocks: Record<number, number> } | { ok: false; reason: IngestRefusal };

export interface IngestOptions {
  stateCap: number;
  /** Registered Lexical node types (`__type` values). */
  registry: ReadonlySet<string>;
  now?: () => number;
}

export class SuggestIngest {
  readonly leases = new Map<number, Lease>();

  constructor(
    readonly doc: Y.Doc,
    readonly options: IngestOptions,
  ) {}

  /** Fresh client ids, absent from the body's state vector and from every other lease. */
  lease(principal: string, count = 2): number[] {
    void principal;
    void count;
    throw new Error('lease: not implemented');
  }

  ops(principal: SuggestPrincipal, role: string, record: string, update: Uint8Array): IngestResult {
    void principal;
    void role;
    void record;
    void update;
    throw new Error('ops: not implemented');
  }

  delete(principal: SuggestPrincipal, role: string, record: string, part: { id: string; targets: IdSpan[] }): IngestResult {
    void principal;
    void role;
    void record;
    void part;
    throw new Error('delete: not implemented');
  }

  /** An editor's body frame naming a leased client id is refused `protected-type` (T5.2). */
  namesLease(update: Uint8Array): boolean {
    void update;
    throw new Error('namesLease: not implemented');
  }
}
