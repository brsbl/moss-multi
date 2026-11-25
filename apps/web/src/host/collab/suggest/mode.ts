// Each doc's editing mode in this tab (docs/design/suggestions.md §5): Edit binds the body, Suggest a private fork,
// Review the composite read-only. A suggester is locked to Suggest (or Review by choice); an editor or owner toggles
// Suggest; any role may choose Review while the note has an open suggestion. The pane switches once its edits are acknowledged; the chrome reads the mode
// the pane shows and asks for another.
import type { EditMode } from '@moss-multi/protocol/dom-contract';
import { roleAtLeast, type Role } from '@moss-multi/protocol/roles';
import { useSyncExternalStore } from 'react';
import { markKept } from '../unacked.ts';

/** Why a note has no room for more suggestions: a note limit (A§5.1 Limits), or the state bytes (`room`). */
export type NoRoom = 'room' | 'text' | 'structure';

const chosen = new Map<string, EditMode>();
const shown = new Map<string, EditMode>();
const openCounts = new Map<string, number>();
/** One closed suggestion's text that could not be kept, as it was typed, and when it was offered. */
export interface UnsavedPayload { id: number; blocks: string[]; at: number }
const unsaved = new Map<string, UnsavedPayload[]>();
let nextPayload = 1;
/** Notes with no room for more suggestions: the note limit the refusal named, or `room` for the state bytes. */
const noRoom = new Map<string, NoRoom>();
/** The writable mode a doc's Review was entered from, when it was Suggest. */
const paused = new Map<string, 'suggest'>();
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

/**
 * The mode Review paused for `role`, read from the current role (T9.33): Suggest for a suggester, and for an editor
 * or owner whichever of Edit and Suggest they entered Review from; null for a reader, who had nothing to pause.
 */
export function pausedMode(docId: string, role: Role | null): 'edit' | 'suggest' | null {
  if (lockedToSuggest(role)) return 'suggest';
  if (!roleAtLeast(role, 'editor')) return null;
  return paused.get(docId) === 'suggest' ? 'suggest' : 'edit';
}

/** Where Done takes `role`: back to the mode Review paused, or a reader's plain read-only note. */
export const reviewReturn = (docId: string, role: Role | null): EditMode => pausedMode(docId, role) ?? 'edit';

/** Review is entered only while the note has an open suggestion (T9.1). It remembers the mode it pauses. */
export function requestMode(docId: string, mode: EditMode): void {
  if (chosen.get(docId) === mode) return;
  if (mode === 'review' && !openCounts.get(docId)) return;
  if (mode === 'review') {
    const from = shown.get(docId) ?? chosen.get(docId);
    if (from === 'suggest') paused.set(docId, 'suggest');
    else paused.delete(docId);
  }
  chosen.set(docId, mode);
  notify();
}

/**
 * The note's open suggestions, as a synced pane last read them. When the last one is decided, a stored choice of
 * Review is dropped: an owner, editor or suggester goes back to the mode Review paused, and a colleague's next suggestion
 * does not put them back in Review. A viewer's or commenter's default is Review either way.
 */
export function setOpenSuggestions(docId: string, count: number): void {
  if (openCounts.get(docId) === count) return;
  openCounts.set(docId, count);
  if (count === 0 && chosen.get(docId) === 'review') {
    // Back to the mode Review paused (T9.33): an editor who was suggesting keeps suggesting.
    if (paused.get(docId) === 'suggest') chosen.set(docId, 'suggest');
    else chosen.delete(docId);
  }
  notify();
}

export function useOpenSuggestions(docId: string | null): number {
  return useSyncExternalStore(subscribeModes, () => (docId ? (openCounts.get(docId) ?? 0) : 0), () => 0);
}

/** The pane reports the mode it shows. */
export function showMode(docId: string, mode: EditMode | null): void {
  if (mode === null ? !shown.has(docId) : shown.get(docId) === mode) return;
  if (mode === null) shown.delete(docId);
  else shown.set(docId, mode);
  notify();
}

/** pausedMode, re-read as modes change. */
export function usePausedMode(docId: string | null, role: Role | null): 'edit' | 'suggest' | null {
  return useSyncExternalStore(subscribeModes, () => (docId ? pausedMode(docId, role) : null), () => null);
}

export function useShownMode(docId: string | null): EditMode | null {
  return useSyncExternalStore(subscribeModes, () => (docId ? (shown.get(docId) ?? null) : null), () => null);
}

/**
 * Text a closed suggestion could not keep, offered back until dismissed (§5 refusal path), one payload per closed
 * suggestion. `full`: the DocDO refused because the note has no room for more suggestions, which the notice says even
 * when nothing was unsaved, naming `limit` when the refusal named one.
 */
export function offerUnsaved(docId: string, blocks: string[], full = false, limit?: 'text' | 'structure'): void {
  if (!blocks.length && !full) return;
  if (blocks.length) {
    unsaved.set(docId, [...(unsaved.get(docId) ?? []), { id: nextPayload++, blocks: [...blocks], at: Date.now() }]);
    // The offered text lives only in this window: a reload or close asks first until it is dismissed.
    markKept(`suggest-unsaved:${docId}`, true);
  }
  if (full) noRoom.set(docId, limit ?? 'room');
  notify();
}

/** Dismisses one payload, or with none named the no-room notice; nothing else discards a payload. */
export function dismissUnsaved(docId: string, payload?: number): void {
  if (payload === undefined) {
    if (noRoom.delete(docId)) notify();
    return;
  }
  const held = unsaved.get(docId) ?? [];
  const left = held.filter((entry) => entry.id !== payload);
  if (left.length === held.length) return;
  if (left.length) unsaved.set(docId, left);
  else {
    unsaved.delete(docId);
    // The last payload is gone: nothing offered back is left in this window to ask about.
    markKept(`suggest-unsaved:${docId}`, false);
  }
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

const NONE: UnsavedPayload[] = [];
export const unsavedOf = (docId: string): UnsavedPayload[] => unsaved.get(docId) ?? NONE;

export function useUnsaved(docId: string | null): UnsavedPayload[] {
  return useSyncExternalStore(subscribeModes, () => (docId ? unsavedOf(docId) : NONE), () => NONE);
}
