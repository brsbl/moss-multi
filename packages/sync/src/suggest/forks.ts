// Each live fork by its doc F, dependency-free: what an editor bound to F writes is a suggestion, under the record caps.
import type * as Y from 'yjs';

/** What an editor needs of the fork it writes into. */
export interface ForkView {
  /** Input closed: a refusal closed it, or the fork was disposed. */
  readonly closed: boolean;
  /** Bytes the record the next edit writes already holds. */
  nextRecordBytes(): number;
}

const forks = new WeakMap<Y.Doc, ForkView>();

export const registerFork = (doc: Y.Doc, fork: ForkView): void => {
  forks.set(doc, fork);
};

/** The fork whose doc is `doc`, if any. */
export const forkOf = (doc: Y.Doc): ForkView | undefined => forks.get(doc);
