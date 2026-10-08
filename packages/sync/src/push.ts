// A CLI push landed on the live doc (A§17).
import type * as Y from 'yjs';
import type { Admit } from './server-doc.ts';

export interface PushInput {
  base: string;
  newText: string;
  force: boolean;
}

export type PushOutcome =
  | { ok: true; applied: number; failedHunks: string[]; changed: boolean }
  | { ok: false; reason: 'degenerate'; deletedRatio: number };

export function landPush(...args: [live: Y.Doc, noteId: string, input: PushInput, origin: unknown, admit?: Admit]): PushOutcome {
  throw new Error(`not implemented (${args.length})`);
}
