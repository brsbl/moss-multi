// @mentions of people in comments (docs/design/comments.md §12). Moss's comment composers mention notes and folders;
// the web adds people in the same encoding, `@person:Name` U+2062 principal id. A comment popover scopes its composers
// to its note, so moss's mention menu can offer that note's people first; the server notifies those it names.
import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import { Bot, User } from 'lucide-react';
import { mentionable, rosterLookup, type Person } from './people.ts';

/** The TypeaheadItem moss's mention menu takes (editor/typeahead/types.ts). */
interface MentionItem {
  id: string;
  label: string;
  description?: string;
  icon?: ComponentType<{ className?: string; size?: number }>;
  category?: string;
  data?: unknown;
}

/** A person's mention item carries this as `data`, so the menu inserts a person mention. */
export const PERSON = 'person';
const CATEGORY = 'People';
/** People offered at once; typing narrows them. */
const SHOWN = 8;

const MentionDoc = createContext<string | null>(null);

/** Scopes the comment composers below it to `docId`'s people; null offers none (a file-backed note). */
export function MentionScope({ docId, children }: { docId: string | null; children: ReactNode }): ReactNode {
  return <MentionDoc.Provider value={docId}>{children}</MentionDoc.Provider>;
}

/** The note whose people an @ in this composer can name, or null outside a comment. */
export function useMentionDoc(): string | null {
  return useContext(MentionDoc);
}

function items(people: Person[], query: string): MentionItem[] {
  const needle = query.trim().toLowerCase();
  return people
    .filter((person) => !needle || person.name.toLowerCase().includes(needle))
    .slice(0, SHOWN)
    .map((person) => ({
      id: person.id,
      label: person.name,
      ...(person.type === 'agent' ? { description: 'Agent' } : {}),
      icon: person.type === 'agent' ? Bot : User,
      category: CATEGORY,
      data: PERSON,
    }));
}

/**
 * The people matching `query` on `docId`, for the top of moss's mention menu. A menu's first search (`fresh`) reads
 * the list again; every search waits for a lookup under way, so people shared a moment ago show from the first key.
 */
export function peopleMatching(docId: string | null, query: string, fresh = false): MentionItem[] | Promise<MentionItem[]> {
  if (!docId || query.includes('/')) return [];
  const people = mentionable(docId, fresh);
  const lookup = rosterLookup(docId);
  return lookup ? lookup.then(() => items(mentionable(docId), query)) : items(people, query);
}

/** Puts `people` ahead of moss's own results; either may still be on its way. */
export function withPeople<T>(people: T[] | Promise<T[]>, results: T[] | Promise<T[]>): T[] | Promise<T[]> {
  if (Array.isArray(people) && !people.length) return results;
  if (Array.isArray(people) && Array.isArray(results)) return [...people, ...results];
  return Promise.all([people, results]).then(([found, rest]) => [...found, ...rest]);
}
