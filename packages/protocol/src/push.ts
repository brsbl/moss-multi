// The CLI push contract (A§17): POST /api/docs/:id/push. Glyphdown's shape, so its pure merge half carries over.

export interface PushRequest {
  newText: string;
  /** sha-256 hex of the pulled base text. */
  baseHash: string;
  /** Sent again when the server's base cache misses. */
  baseText?: string;
  /** Land the change as a pending suggestion. */
  suggest?: boolean;
  /** Push even when the change deletes most of the doc. */
  force?: boolean;
}

export type PushResponse =
  | { ok: true; mode: 'edit'; applied: number; failedHunks: string[] }
  | { ok: true; mode: 'suggest'; suggestionId: string }
  | { ok: false; reason: 'degenerate'; deletedRatio: number }
  | { ok: false; reason: 'base-missing' }
  | { ok: false; reason: 'forbidden' | 'too-large' | 'rate-limited'; retryAfterSec?: number };

/** CLI exit codes (A§17). */
export const EXIT = { ok: 0, other: 1, failedHunks: 2, degenerate: 3 } as const;
