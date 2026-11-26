// Each doc's editing mode in this tab (docs/design/suggestions.md §5): Edit binds the body, Suggest a private fork,
// Review the composite read-only. A suggester is locked to Suggest (or Review by choice); an editor or owner toggles
// Suggest; any role may choose Review. The pane switches once its edits are acknowledged; the chrome reads the mode
// the pane shows and asks for another.
import type { EditMode } from '@moss-multi/protocol/dom-contract';
import { roleAtLeast, type Role } from '@moss-multi/protocol/roles';
import { useSyncExternalStore } from 'react';
import { markKept } from '../unacked.ts';

/** Why a note has no room for more suggestions: a note limit (A§5.1 Limits), or the state bytes (`room`). */
export type NoRoom = 'room' | 'text' | 'structure';

const chosen = new Map<string, EditMode>();
const shown = new Map<string, EditMode>();
const unsaved = new Map<string, string[]>();
/** Notes with no room for more suggestions: the note limit the refusal named, or `room` for the state bytes. */
const noRoom = new Map<string, NoRoom>();
/** Notes whose Suggest window the person's other windows leave no lease for: asking again, on their action. */
const busy = new Map<string, () => void>();
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

/**
 * Text a closed suggestion could not keep, offered back until dismissed (§5 refusal path). `full`: the DocDO refused
 * because the note has no room for more suggestions, which the band says even when nothing was unsaved, naming
 * `limit` when the refusal named one.
 */
export function offerUnsaved(docId: string, blocks: string[], full = false, limit?: 'text' | 'structure'): void {
  if (!blocks.length && !full) return;
  if (blocks.length) {
    unsaved.set(docId, [...(unsaved.get(docId) ?? []), ...blocks]);
    // The offered text lives only in this window: a reload or close asks first until it is dismissed.
    markKept(`suggest-unsaved:${docId}`, true);
  }
  if (full) noRoom.set(docId, limit ?? 'room');
  notify();
}

export function dismissUnsaved(docId: string): void {
  const had = noRoom.delete(docId);
  markKept(`suggest-unsaved:${docId}`, false);
  if (!unsaved.delete(docId) && !had) return;
  notify();
}

/**
 * The pane's Suggest window was refused its first lease because the person's other Suggest windows hold every one
 * (`lease-cap`): it shows the note read-only and asks again only when the person chooses Retry, through `ask`.
 */
export function suggestBusy(docId: string, ask: () => void): void {
  busy.set(docId, ask);
  notify();
}

/** The window has its lease again, or no longer asks. */
export function clearSuggestBusy(docId: string): void {
  if (busy.delete(docId)) notify();
}

/** Retry on the busy notice: asks again once. */
export function retrySuggest(docId: string): void {
  const ask = busy.get(docId);
  if (!ask) return;
  busy.delete(docId);
  notify();
  ask();
}

export function useSuggestBusy(docId: string | null): boolean {
  return useSyncExternalStore(subscribeModes, () => (docId ? busy.has(docId) : false), () => false);
}

/** Why the note has no room for more suggestions (the DocDO refused `doc-cap` or `ops-cap`), until dismissed; else null. */
export function useNoSuggestionRoom(docId: string | null): NoRoom | null {
  return useSyncExternalStore(subscribeModes, () => (docId ? (noRoom.get(docId) ?? null) : null), () => null);
}

const NONE: string[] = [];
export function useUnsaved(docId: string | null): string[] {
  return useSyncExternalStore(subscribeModes, () => (docId ? (unsaved.get(docId) ?? NONE) : NONE), () => NONE);
}
