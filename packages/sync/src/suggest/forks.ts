// Each live fork by its doc F, dependency-free: what an editor bound to F writes is a suggestion, under the record caps.
import type { IdSpan, SuggestRefusal } from '@moss-multi/protocol/suggest';
import type * as Y from 'yjs';

/** What an editor needs of the fork it writes into. */
export interface ForkView {
  /**
   * Whether an edit adding `bytes` of ops, and striking `strike`, fits every suggestion cap: null, or the refusal it
   * would meet.
   */
  admit(bytes: number, strike?: readonly IdSpan[]): SuggestRefusal | null;
}

const forks = new WeakMap<Y.Doc, ForkView>();

export const registerFork = (doc: Y.Doc, fork: ForkView): void => {
  forks.set(doc, fork);
};

/** The fork whose doc is `doc`, if any. */
export const forkOf = (doc: Y.Doc): ForkView | undefined => forks.get(doc);
