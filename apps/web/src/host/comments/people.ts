// Who wrote a comment, and whom an @ can name (docs/design/comments.md §12, §14 decision 3): records carry principal
// ids only. The members list names the owner and grant holders to anyone with a grant; a link-only reader gets none,
// so every author but the reader is "Collaborator" there, and an author no longer on the note reads the same.
import { shareToken } from '../media/web-asset-url.ts';

export const ME = 'Me';
export const COLLABORATOR = 'Collaborator';
/** A failed or partial lookup is not repeated sooner than this. */
const RETRY_MS = 30_000;
/** An @ menu opened later than this after the last lookup asks again. */
const FRESH_MS = 2_000;

export interface Person { id: string; name: string; type: 'user' | 'agent' }
interface Roster { names: Map<string, string>; people: Person[]; asked: number; inFlight: Promise<void> | null }
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

async function ask(docId: string, roster: Roster): Promise<void> {
  roster.asked = Date.now();
  try {
    const share = shareToken();
    const response = await fetch(`/api/docs/${encodeURIComponent(docId)}/members`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(share ? { 'x-moss-share': share } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return;
    const body = (await response.json()) as { members?: { principalId?: unknown; principalType?: unknown; name?: unknown }[] };
    const people: Person[] = [];
    for (const member of body.members ?? []) {
      if (typeof member.principalId !== 'string' || typeof member.name !== 'string' || !member.name) continue;
      roster.names.set(member.principalId, member.name);
      people.push({ id: member.principalId, name: member.name, type: member.principalType === 'agent' ? 'agent' : 'user' });
    }
    roster.people = people;
    for (const listener of listeners) listener();
  } catch {
    // Unnamed authors stay "Collaborator"; a later unknown author asks again.
  }
}

function rosterOf(docId: string): Roster {
  let roster = rosters.get(docId);
  if (!roster) {
    roster = { names: new Map(), people: [], asked: 0, inFlight: null };
    rosters.set(docId, roster);
  }
  return roster;
}

/** Asks the members list again unless a lookup is under way or recent; signed-out link readers never ask (404s). */
function refresh(docId: string, roster: Roster, force = false): void {
  if (!myPrincipalId() || roster.inFlight || !(force || Date.now() - roster.asked > RETRY_MS)) return;
  roster.inFlight = ask(docId, roster).finally(() => {
    roster.inFlight = null;
  });
}

/** The label of `author` on `docId`, asking the members list once for authors it does not know. */
export function authorLabel(docId: string, author: string): string {
  if (author === myPrincipalId()) return ME;
  const roster = rosterOf(docId);
  const name = roster.names.get(author);
  if (name) return name;
  refresh(docId, roster);
  return COLLABORATOR;
}

/**
 * The people an @ in a comment on `docId` can name: the owner and grant holders, the reader excluded. The first ask
 * of an opened menu reads the list again, so someone shared a moment ago is offered.
 */
export function mentionable(docId: string, fresh = false): Person[] {
  const roster = rosterOf(docId);
  refresh(docId, roster, fresh && Date.now() - roster.asked > FRESH_MS);
  const me = myPrincipalId();
  return roster.people.filter((person) => person.id !== me);
}

/** The members lookup under way for `docId`, if any. */
export function rosterLookup(docId: string): Promise<void> | null {
  return rosterOf(docId).inFlight;
}
