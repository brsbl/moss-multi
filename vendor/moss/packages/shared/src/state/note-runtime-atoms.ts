// ported-from: packages/shared/src/state/note-runtime-atoms.ts @ 762abb777
import { atom, type PrimitiveAtom } from 'jotai';
import { atomFamily } from 'jotai-family';

import type { ActionTabEntry } from './atoms';

export const noteActionTabsAtom = atomFamily((_noteId: string) =>
  atom<ActionTabEntry[]>([])
);

export const noteExpandedActionTabIdsAtom = atomFamily((_noteId: string) =>
  atom<Set<string>>(new Set<string>())
);

export const initializedNoteIdsAtom: PrimitiveAtom<Set<string>> = atom(new Set<string>());

export const notePromptDraftAtom = atomFamily((_noteId: string) => atom<string>(''));

export const activeAgentNoteIdsAtom: PrimitiveAtom<Set<string>> = atom(new Set<string>());

export const pendingAgentExecutionNoteIdsAtom: PrimitiveAtom<Set<string>> = atom(new Set<string>());

export interface LinkResolutionCacheEntry {
  noteId: string | null;
  noteTitle: string;
  isResolved: boolean;
  preview?: string;
  updatedAt?: number;
  folderPath?: string;
  sourceContext?: string;
}

export function buildLinkResolutionCacheKey(
  target: string,
  sourceContext?: string,
  heading?: string
): string {
  const parts: string[] = [];
  if (sourceContext) parts.push(`ctx:${sourceContext}`);
  parts.push(target);
  if (heading) parts.push(`#${heading}`);
  return parts.join('::');
}

export const linkResolutionAtom = atomFamily((_cacheKey: string) =>
  atom<LinkResolutionCacheEntry | null>(null)
);

export function cleanupLinkResolutionCache(cacheKey: string): void {
  linkResolutionAtom.remove(cacheKey);
}
