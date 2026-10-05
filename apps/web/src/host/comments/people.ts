// Who wrote a comment (docs/design/comments.md §12, §14 decision 3): records carry principal ids only. The members
// list names the owner and grant holders to anyone with a grant; a link-only reader gets none, so every author but
// the reader is "Collaborator" there, and an author no longer on the note reads the same.
export const ME = 'Me';
export const COLLABORATOR = 'Collaborator';
/** A failed or partial lookup is not repeated sooner than this. */
const RETRY_MS = 30_000;

interface Roster { names: Map<string, string>; asked: number; inFlight: boolean }
const rosters = new Map<string, Roster>();
const listeners = new Set<() => void>();

// Set by the pane from the tab's session, so these modules stay free of the auth store (the viewer bundles them).
let me: string | null = null;

export const myPrincipalId = (): string | null => me;

export function setMyPrincipalId(id: string | null): void {
  me = id;
}

export function subscribePeople(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const shareParam = (): string | null => (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('share'));

async function ask(docId: string, roster: Roster): Promise<void> {
  roster.inFlight = true;
  roster.asked = Date.now();
  try {
    const share = shareParam();
    const response = await fetch(`/api/docs/${encodeURIComponent(docId)}/members`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(share ? { 'x-moss-share': share } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return;
    const body = (await response.json()) as { members?: { principalId?: unknown; name?: unknown }[] };
    for (const member of body.members ?? []) {
      if (typeof member.principalId === 'string' && typeof member.name === 'string' && member.name) roster.names.set(member.principalId, member.name);
    }
    for (const listener of listeners) listener();
  } catch {
    // Unnamed authors stay "Collaborator"; a later unknown author asks again.
  } finally {
    roster.inFlight = false;
  }
}

/** The label of `author` on `docId`, asking the members list once for authors it does not know. */
export function authorLabel(docId: string, author: string): string {
  if (author === myPrincipalId()) return ME;
  let roster = rosters.get(docId);
  if (!roster) {
    roster = { names: new Map(), asked: 0, inFlight: false };
    rosters.set(docId, roster);
  }
  const name = roster.names.get(author);
  if (name) return name;
  // Signed-out link readers cannot read members; they would only collect 404s.
  if (myPrincipalId() && !roster.inFlight && Date.now() - roster.asked > RETRY_MS) void ask(docId, roster);
  return COLLABORATOR;
}
