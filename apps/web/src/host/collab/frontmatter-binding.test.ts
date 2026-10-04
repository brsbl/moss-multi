// @vitest-environment jsdom
import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { readField, writeField } from '@moss-multi/core/doc-fields';
import { frontmatterDirtySignalAtom, noteFrontmatterAtom } from '@moss/shared/state/note-atoms';
import { bindFrontmatter, parseFrontmatter, setEditingProperty } from './frontmatter-binding.ts';

describe('frontmatter binding', () => {
  it('keeps moss date normalization and rejects malformed or non-mapping YAML', () => {
    expect(parseFrontmatter('due: 2026-10-03\nnested:\n  dates: [2026-10-04, 2026-10-03T12:34:56Z]\n'))
      .toEqual({ due: '2026-10-03', nested: { dates: ['2026-10-04', '2026-10-03T12:34:56.000Z'] } });
    for (const yaml of ['', '  ', '- item\n', 'scalar\n', 'broken: [\n']) expect(parseFrontmatter(yaml)).toBeNull();
    expect(parseFrontmatter('status: done\n')).toEqual({ status: 'done' });
  });

  it('converges after disconnected same-key additions and reopens with untouched properties', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    writeField(a, 'frontmatter', 'status: done\n', 'seed');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const ada = createStore();
    const ben = createStore();
    const atom = noteFrontmatterAtom('same-key-race');
    const signal = frontmatterDirtySignalAtom('same-key-race');
    const stops = [bindFrontmatter(ada, 'same-key-race', a, () => true), bindFrontmatter(ben, 'same-key-race', b, () => true)];
    try {
      for (const [store, owner] of [[ada, 'ada'], [ben, 'ben']] as const) {
        store.set(atom, { ...store.get(atom), owner });
        store.set(signal, (n) => n + 1);
      }
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      const raw = readField(a, 'frontmatter');
      expect(raw).toBe(readField(b, 'frontmatter'));
      expect(raw.match(/^owner:/gm)).toHaveLength(1);
      expect(ada.get(atom)).toEqual(ben.get(atom));
      expect(ada.get(atom)).toEqual({ status: 'done', owner: raw.trimEnd().split('\n').at(-1)?.slice('owner: '.length) });

      const reopened = new Y.Doc();
      Y.applyUpdate(reopened, Y.encodeStateAsUpdate(a));
      const store = createStore();
      const stop = bindFrontmatter(store, 'same-key-race', reopened, () => true);
      try {
        expect(store.get(atom)).toEqual(ada.get(atom));
        store.set(atom, { ...store.get(atom), due: 'soon' });
        store.set(signal, (n) => n + 1);
        expect(parseFrontmatter(readField(reopened, 'frontmatter'))).toEqual({ ...ada.get(atom), due: 'soon' });
      } finally { stop(); reopened.destroy(); }
    } finally { stops.forEach((stop) => stop()); a.destroy(); b.destroy(); }
  });
});

it('keeps values when Properties reorders its keys', () => {
  const doc = new Y.Doc();
  writeField(doc, 'frontmatter', 'first: one\nsecond: two\n', 'seed');
  const store = createStore();
  const stop = bindFrontmatter(store, 'reorder', doc, () => true);
  store.set(noteFrontmatterAtom('reorder'), { second: 'two', first: 'one' });
  store.set(frontmatterDirtySignalAtom('reorder'), (n) => n + 1);
  expect(Object.keys(parseFrontmatter(readField(doc, 'frontmatter')) ?? {})).toEqual(['second', 'first']);
  stop();
  doc.destroy();
});

it('keeps the empty Add field form open until its first value commits', () => {
  const doc = new Y.Doc();
  const store = createStore();
  const atom = noteFrontmatterAtom('first-field');
  const signal = frontmatterDirtySignalAtom('first-field');
  const stop = bindFrontmatter(store, 'first-field', doc, () => true);
  store.set(atom, {});
  store.set(signal, (n) => n + 1);
  expect(store.get(atom)).toEqual({});
  store.set(atom, { first: 'value' });
  store.set(signal, (n) => n + 1);
  expect(readField(doc, 'frontmatter')).toBe('first: value\n');
  stop();
  doc.destroy();
});

it('keeps the property being edited when a peer deletes it, until the draft commits or is cancelled', () => {
  const ada = new Y.Doc();
  const ben = new Y.Doc();
  ada.on('update', (update: Uint8Array) => Y.applyUpdate(ben, update, 'remote'));
  writeField(ada, 'frontmatter', 'status: draft\nowner: ada\n', 'seed');
  const store = createStore();
  const atom = noteFrontmatterAtom('delete-during-draft');
  const signal = frontmatterDirtySignalAtom('delete-during-draft');
  const stop = bindFrontmatter(store, 'delete-during-draft', ben, () => true);
  try {
    setEditingProperty('delete-during-draft', 'status');
    writeField(ada, 'frontmatter', 'owner: ada\n', 'seed');
    expect(Object.keys(store.get(atom) ?? {}), 'the open field keeps its row').toEqual(['status', 'owner']);
    // Ben commits his draft: the edit is kept, not silently dropped.
    store.set(atom, { ...store.get(atom), status: 'done' });
    store.set(signal, (n) => n + 1);
    setEditingProperty('delete-during-draft', null);
    expect(parseFrontmatter(readField(ben, 'frontmatter'))).toEqual({ status: 'done', owner: 'ada' });

    setEditingProperty('delete-during-draft', 'owner');
    writeField(ada, 'frontmatter', 'status: done\n', 'seed');
    expect(store.get(atom)).toEqual({ status: 'done', owner: 'ada' });
    // Cancelling the draft accepts the peer's delete.
    setEditingProperty('delete-during-draft', null);
    expect(store.get(atom)).toEqual({ status: 'done' });
  } finally { stop(); ada.destroy(); ben.destroy(); }
});
