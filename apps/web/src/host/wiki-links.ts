// Wiki-link resolution past moss's exact title match (A§15; R3): `[[X]]` then resolves against the normalized
// title, then the filename stem, among the docs the sidebar lists, within the source note's vault. The bridge supplies
// the listing; the viewer supplies none, so its links keep moss's own resolution.
import { slug } from '@moss-multi/core/filenames';

export interface WikiCandidate {
  id: string;
  title: string;
  filename?: string;
  /** Listed from another vault (A§8 surfacing), not the active one. */
  surfaced?: boolean;
}

let candidates: () => readonly WikiCandidate[] = () => [];

export function setWikiCandidates(read: () => readonly WikiCandidate[]): void {
  candidates = read;
}

/**
 * The id `[[target]]` names by normalized title, else by filename stem; null when none does. A link in a note of the
 * active vault resolves only among that vault's docs (A§15); a surfaced note's vault isn't listed, so its links keep
 * the whole listing.
 */
export function resolveWikiTarget(target: string, sourceId?: string | null): string | null {
  const key = slug(target);
  if (!key) return null;
  const all = candidates();
  const source = sourceId ? all.find((doc) => doc.id === sourceId) : undefined;
  const listed = source && !source.surfaced ? all.filter((doc) => !doc.surfaced) : all;
  return listed.find((doc) => slug(doc.title) === key)?.id
    ?? listed.find((doc) => doc.filename?.replace(/\.md$/i, '').toLowerCase() === key)?.id
    ?? null;
}
