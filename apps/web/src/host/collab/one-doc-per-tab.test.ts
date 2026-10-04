// @vitest-environment jsdom
// A§10.1, one session per open doc: moss's split rule is total (no navigation shows one note in both panes), and the
// tab's session registry refuses a second session for a doc without throwing.
import {
  activeNoteIdAtom, openSplitTabAtom, splitGoBackAtom, splitGoForwardAtom, splitNavigateToNoteAtom, splitTabNoteIdAtom,
} from '@moss/shared/state/atoms';
import { noteEntityAtom, noteIdsAtom } from '@moss/shared/state/note-atoms';
import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import { docOwner, openDocSession, releaseProvider, subscribeDocOwners } from './doc-session.ts';

/** A store with notes a, b and c, the left pane on c. */
function notes() {
  const store = createStore();
  const ids = ['a', 'b', 'c'];
  ids.forEach((id, i) => {
    store.set(noteEntityAtom(id), {
      id, title: id, createdAt: 1, updatedAt: 10 - i, trashedAt: null, lastOpenedAt: null, folderPath: 'Notes',
      contentType: 'text', links: { outgoing: [], incoming: [] },
    });
  });
  store.set(noteIdsAtom, new Set(ids));
  store.set(activeNoteIdAtom, 'c');
  return store;
}

describe("moss's split rule, made total (A§10.1)", () => {
  it("closes the split when its back reaches the left pane's note", () => {
    const store = notes();
    store.set(openSplitTabAtom, 'b');
    store.set(splitNavigateToNoteAtom, 'a');
    store.set(activeNoteIdAtom, 'b');
    expect(store.get(splitTabNoteIdAtom)).toBe('a');
    store.set(splitGoBackAtom);
    expect(store.get(splitTabNoteIdAtom), 'the split closed').toBeNull();
    expect(store.get(activeNoteIdAtom)).toBe('b');
  });

  it("closes the split when its forward reaches the left pane's note", () => {
    const store = notes();
    store.set(openSplitTabAtom, 'a');
    store.set(splitNavigateToNoteAtom, 'b');
    store.set(splitGoBackAtom);
    store.set(activeNoteIdAtom, 'b');
    expect(store.get(splitTabNoteIdAtom)).toBe('a');
    store.set(splitGoForwardAtom);
    expect(store.get(splitTabNoteIdAtom), 'the split closed').toBeNull();
    expect(store.get(activeNoteIdAtom)).toBe('b');
  });

  it("closes the split when the left pane moves to the split's note (its back, forward or any other path)", () => {
    const store = notes();
    store.set(openSplitTabAtom, 'b');
    store.set(activeNoteIdAtom, 'b');
    expect(store.get(splitTabNoteIdAtom), 'the split closed').toBeNull();
    expect(store.get(activeNoteIdAtom)).toBe('b');
  });

  it('keeps the split for navigation to any other note', () => {
    const store = notes();
    store.set(openSplitTabAtom, 'b');
    store.set(splitNavigateToNoteAtom, 'a');
    store.set(splitGoBackAtom);
    store.set(activeNoteIdAtom, 'a');
    expect([store.get(activeNoteIdAtom), store.get(splitTabNoteIdAtom)]).toEqual(['a', 'b']);
  });
});

describe("the tab's doc sessions (A§10.1)", () => {
  it('refuses a second session for a held doc without throwing, and frees the doc on release', () => {
    const left = {};
    const right = {};
    const first = openDocSession('doc-1', left);
    expect(first).not.toBeNull();
    expect(() => openDocSession('doc-1', right), 'a refusal is never a throw').not.toThrow();
    expect(openDocSession('doc-1', right), 'the second pane gets no session').toBeNull();
    expect(docOwner('doc-1')).toBe(left);

    let changes = 0;
    const stop = subscribeDocOwners(() => {
      changes += 1;
    });
    releaseProvider('doc-1', first!.provider, new Map());
    expect(docOwner('doc-1'), 'released').toBeNull();
    expect(changes, 'waiting panes hear the release').toBeGreaterThan(0);

    const second = openDocSession('doc-1', right);
    expect(second, 'the doc opens again once it is free').not.toBeNull();
    expect(docOwner('doc-1')).toBe(right);
    releaseProvider('doc-1', second!.provider, new Map());
    stop();
  });
});
