// SP11 spike (T5.0, docs/design/suggestions.md §4): vets a suggest-mode sync frame against the live doc without
// applying it. Not implemented yet.
import type * as Y from 'yjs';

/** A run of one client's consecutive items: the author's pending insert, by Yjs identity. */
export interface IdSpan {
  client: number;
  clock: number;
  len: number;
}

export type VetReason = 'delete-original' | 'mutate-original' | 'outside-body' | 'unresolvable';
export type Verdict = { ok: true; inserts: IdSpan[] } | { ok: false; reason: VetReason };

export function vetSuggestFrame(_doc: Y.Doc, _update: Uint8Array, _own: readonly IdSpan[]): Verdict {
  return { ok: true, inserts: [] };
}
