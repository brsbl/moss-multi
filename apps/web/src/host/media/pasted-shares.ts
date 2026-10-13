// The share link each pasted asset URL carried (A§16). moss's cross-note paste hands `images.copyFromNoteAsset` only
// the source note and path, so the link that opens the source, which may differ from the page's own, is kept here by
// note and path when the clipboard HTML is read, for the copy that follows.

const KEPT = 64;
const shares = new Map<string, string>();
const keyOf = (noteId: string, relativePath: string) => `${noteId}\n${relativePath}`;

export function rememberPastedShare(noteId: string, relativePath: string, share: string): void {
  const key = keyOf(noteId, relativePath);
  shares.delete(key);
  shares.set(key, share);
  if (shares.size > KEPT) shares.delete(shares.keys().next().value as string);
}

/** The link the last pasted URL for this note's file carried, or null. */
export const pastedShareOf = (noteId: string, relativePath: string): string | null => shares.get(keyOf(noteId, relativePath)) ?? null;
