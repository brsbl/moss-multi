// Each live fork by its doc F, dependency-free: what an editor bound to F writes is a suggestion, under the record caps.
import type * as Y from 'yjs';

const forks = new WeakMap<Y.Doc, { readonly closed: boolean }>();

export const registerFork = (doc: Y.Doc, fork: { readonly closed: boolean }): void => {
  forks.set(doc, fork);
};

/** The fork whose doc is `doc`, if any: `closed` once a refusal closed its input. */
export const forkOf = (doc: Y.Doc): { readonly closed: boolean } | undefined => forks.get(doc);
