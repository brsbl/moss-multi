// The CLI push contract (A§17): POST /api/docs/:id/push. Glyphdown's shape, so its pure merge half carries over.
import { MARKDOWN_MAX_BYTES, STATE_CAP_BYTES, STRUCT_CAP, TEXT_CHAR_CAP } from './limits.ts';
import type { DocLimit } from './sync.ts';

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
  /** The change landed as an open suggestion; `failedHunks` were left out of it. */
  | { ok: true; mode: 'suggest'; suggestionId: string; failedHunks?: string[] }
  | { ok: false; reason: 'degenerate'; deletedRatio: number }
  | { ok: false; reason: 'base-missing' }
  /** The result would differ from the merged file somewhere (the converter cannot store a block exactly): nothing landed. */
  | { ok: false; reason: 'push-unverified'; message: string }
  /** The suggestion ingest refused the change (a cap, or a change a suggestion cannot hold): nothing was suggested. */
  | { ok: false; reason: 'suggest-refused'; message: string }
  /** The push would take the note past `limit` (A§5.1), or its body passes the transport bound (`markdown`): nothing landed. */
  | { ok: false; reason: 'too-large'; limit?: PushLimit; message?: string }
  | { ok: false; reason: 'forbidden' | 'rate-limited'; retryAfterSec?: number };

/** Which limit a refused push or create met: one of the note's (A§5.1), or the markdown a request may carry. */
export type PushLimit = DocLimit | 'markdown';

/** 1020000 as 1,020,000, without Intl. */
const thousands = (n: number): string => {
  const digits = String(n);
  let out = '';
  for (let i = 0; i < digits.length; i += 1) out += (i > 0 && (digits.length - i) % 3 === 0 ? ',' : '') + digits[i];
  return out;
};

/** What the CLI says, after "too large: ", when a write meets a limit. */
export const LIMIT_WORDS: Record<PushLimit, string> = {
  text: `a note holds at most ${thousands(TEXT_CHAR_CAP)} characters of text (1.02 million), and this would pass that`,
  structure: `a note holds at most ${thousands(STRUCT_CAP)} pieces of structure (every line, list item and table cell, and its `
    + 'past edits), and this would pass that; split it into smaller notes',
  state: `a note stores at most ${Math.floor(STATE_CAP_BYTES / 1_000_000)} MB, and this would pass that`,
  markdown: `a note's markdown can be at most ${MARKDOWN_MAX_BYTES / (1024 * 1024)} MB in one push or create`,
};

/** CLI exit codes (A§17). */
export const EXIT = { ok: 0, other: 1, failedHunks: 2, degenerate: 3 } as const;
