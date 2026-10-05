// Before a trash (A§10.6): the docs going to Trash close to writes in this tab, the guard waits at most 5 s for their
// unacked edits, and past that asks (TrashConfirmation, Cancel the default). The bridge calls `release` once the
// request is done or abandoned, so a cancelled or refused trash leaves the docs writable again, and a trash the server
// confirmed ends their sessions here at once rather than waiting for the 4410. boot.tsx wires the
// doc sessions in, so this module and the bridge stay free of the collab code.

export const TRASH_ACK_WAIT_MS = 5_000;

export interface TrashGuard {
  /** True when the trash may go ahead. */
  prepare(docIds: string[]): Promise<boolean>;
  /** `trashed`: the server moved them to Trash. */
  release(docIds: string[], trashed?: boolean): void;
}

export interface TrashGuardDeps {
  close(docIds: string[], closed: boolean): void;
  waitAcked(docIds: string[], timeoutMs: number): Promise<boolean>;
  confirm(): Promise<boolean>;
  /** Ends this tab's sessions of docs the server trashed (terminal `deleted`). */
  end?(docIds: string[]): void;
}

export function createTrashGuard({ close, waitAcked, confirm, end }: TrashGuardDeps): TrashGuard {
  return {
    async prepare(docIds) {
      close(docIds, true);
      if (await waitAcked(docIds, TRASH_ACK_WAIT_MS) || await confirm()) return true;
      close(docIds, false);
      return false;
    },
    release: (docIds, trashed = false) => {
      if (trashed) end?.(docIds);
      close(docIds, false);
    },
  };
}

let answer: ((discard: boolean) => void) | null = null;
const listeners = new Set<() => void>();
const publish = () => { for (const listener of listeners) listener(); };

export const needsTrashConfirmation = () => answer !== null;
export function subscribeTrashConfirmation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function answerTrash(discard: boolean): void {
  const pending = answer;
  answer = null;
  publish();
  pending?.(discard);
}

/** Asks through the shell's TrashConfirmation; a newer question cancels an older one. */
export const askTrashConfirmation = (): Promise<boolean> => new Promise<boolean>((resolve) => {
  answer?.(false);
  answer = resolve;
  publish();
});
