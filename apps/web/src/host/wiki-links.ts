// Wiki-link resolution past moss's exact title match (A§15; R3): `[[X]]` then resolves against the normalized
// title, then the filename stem, among the docs the sidebar lists. The bridge supplies the listing; the viewer
// supplies none, so its links keep moss's own resolution.
import { slug } from '@moss-multi/core/filenames';

export interface WikiCandidate {
  id: string;
  title: string;
  filename?: string;
}

let candidates: () => readonly WikiCandidate[] = () => [];

export function setWikiCandidates(read: () => readonly WikiCandidate[]): void {
  candidates = read;
}

/** The id `[[target]]` names by normalized title, else by filename stem; null when none does. */
export function resolveWikiTarget(target: string): string | null {
  const key = slug(target);
  if (!key) return null;
  const listed = candidates();
  return listed.find((doc) => slug(doc.title) === key)?.id
    ?? listed.find((doc) => doc.filename?.replace(/\.md$/i, '').toLowerCase() === key)?.id
    ?? null;
}
