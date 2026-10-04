// Preview, accept, reject and withdraw of a suggestion record (docs/design/suggestions.md §4), on the DocDO's live
// doc. Accept applies the record to a hydrated mirror, runs the gates, and lands the mirror's diff only when every
// gate passes; reject and withdraw write only the record.
import type * as Y from 'yjs';
import type { GateReason, Hunk } from '@moss-multi/core/suggest/apply';

export interface Reviewer {
  id: string;
  role: string;
}

export type Preview = { ok: true; hunks: Hunk[]; hash: string; digest: string } | { ok: false; reason: GateReason | 'missing' };

export type ReviewResult = { ok: true } | { ok: false; status: 403 | 404 | 409; reason: GateReason | 'role' | 'missing' };

export interface AcceptInput {
  previewHash: string;
  digest: string;
}

export function previewRecord(live: Y.Doc, id: string): Preview {
  void live;
  void id;
  throw new Error('previewRecord: not implemented');
}

export function acceptRecord(live: Y.Doc, id: string, input: AcceptInput, reviewer: Reviewer, options: { stateCap?: number; now?: number } = {}): ReviewResult {
  void live;
  void id;
  void input;
  void reviewer;
  void options;
  throw new Error('acceptRecord: not implemented');
}

export function rejectRecord(live: Y.Doc, id: string, reviewer: Reviewer, now = Date.now()): ReviewResult {
  void live;
  void id;
  void reviewer;
  void now;
  throw new Error('rejectRecord: not implemented');
}

export function withdrawRecord(live: Y.Doc, id: string, reviewer: Reviewer, now = Date.now()): ReviewResult {
  void live;
  void id;
  void reviewer;
  void now;
  throw new Error('withdrawRecord: not implemented');
}

/** Registered node types of the converter editor, the ingest's `__type` registry. */
export function nodeRegistry(): ReadonlySet<string> {
  throw new Error('nodeRegistry: not implemented');
}
