// Each doc's editing mode in this tab (docs/design/suggestions.md §5): Edit binds the body, Suggest a private fork,
// Review the composite read-only. A suggester is locked to Suggest (or Review by choice); an editor or owner toggles
// Suggest; any role may choose Review. The pane switches once its edits are acknowledged; the chrome reads the mode
// the pane shows and asks for another.
import type { EditMode } from '@moss-multi/protocol/dom-contract';
import { roleAtLeast, type Role } from '@moss-multi/protocol/roles';
import { useSyncExternalStore } from 'react';

const chosen = new Map<string, EditMode>();
const shown = new Map<string, EditMode>();
const unsaved = new Map<string, string[]>();
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of [...listeners]) listener();
};

export function subscribeModes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A suggester cannot leave Suggest except for Review. */
export const lockedToSuggest = (role: Role | null): boolean => role === 'suggester';

/**
 * The mode a pane of `docId` should show for `role`: Review by default for viewers and commenters (PRODUCT ruling
 * 17), who may leave it for the plain body; Suggest for a suggester; Edit for editors and owners.
 */
export function modeFor(docId: string, role: Role | null): EditMode {
  const choice = chosen.get(docId);
  if (choice === 'review' && role !== null) return 'review';
  if (lockedToSuggest(role)) return 'suggest';
  if (roleAtLeast(role, 'editor')) return choice ?? 'edit';
  if (role === null) return 'edit';
  return choice === 'edit' ? 'edit' : 'review';
}

export function requestMode(docId: string, mode: EditMode): void {
  if (chosen.get(docId) === mode) return;
  chosen.set(docId, mode);
  notify();
}

/** The pane reports the mode it shows. */
export function showMode(docId: string, mode: EditMode | null): void {
  if (mode === null ? !shown.has(docId) : shown.get(docId) === mode) return;
  if (mode === null) shown.delete(docId);
  else shown.set(docId, mode);
  notify();
}

export function useShownMode(docId: string | null): EditMode | null {
  return useSyncExternalStore(subscribeModes, () => (docId ? (shown.get(docId) ?? null) : null), () => null);
}

/** Text a closed suggestion could not keep, offered back until dismissed (§5 refusal path). */
export function offerUnsaved(docId: string, blocks: string[]): void {
  unsaved.set(docId, [...(unsaved.get(docId) ?? []), ...blocks]);
  notify();
}

export function dismissUnsaved(docId: string): void {
  if (!unsaved.delete(docId)) return;
  notify();
}

const NONE: string[] = [];
export function useUnsaved(docId: string | null): string[] {
  return useSyncExternalStore(subscribeModes, () => (docId ? (unsaved.get(docId) ?? NONE) : NONE), () => NONE);
}
