// @vitest-environment jsdom
import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { readField, writeField } from '@moss-multi/core/doc-fields';
import { frontmatterDirtySignalAtom, noteFrontmatterAtom } from '@moss/shared/state/note-atoms';
import { bindFrontmatter, parseFrontmatter, setPropertyDraft } from './frontmatter-binding.ts';

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

/** Ben's binding over a doc that receives every update Ada writes. */
function peers(noteId: string, yaml: string) {
  const ada = new Y.Doc();
  const ben = new Y.Doc();
  ada.on('update', (update: Uint8Array) => Y.applyUpdate(ben, update, 'remote'));
  writeField(ada, 'frontmatter', yaml, 'seed');
  const store = createStore();
  const atom = noteFrontmatterAtom(noteId);
  const commit = (next: Record<string, unknown>) => { store.set(atom, next); store.set(frontmatterDirtySignalAtom(noteId), (n) => n + 1); };
  const stop = bindFrontmatter(store, noteId, ben, () => true);
  const close = () => { setPropertyDraft(noteId, { key: null, adding: false }); stop(); ada.destroy(); ben.destroy(); };
  return { ada, ben, store, atom, commit, close };
}

describe('an open Properties draft survives peer changes (A§10.4: except the key being edited)', () => {
  it('a peer deleting the property being edited keeps its row until the draft commits, which writes it back', () => {
    const { ada, ben, store, atom, commit, close } = peers('draft-commit', 'status: draft\nowner: ada\ndue: soon\n');
    try {
      setPropertyDraft('draft-commit', { key: 'status' });
      writeField(ada, 'frontmatter', 'owner: ben\ndue: soon\n', 'seed');
      expect(store.get(atom), 'the open field keeps its row and place; other keys follow the peer').toEqual({ status: 'draft', owner: 'ben', due: 'soon' });
      expect(Object.keys(store.get(atom) ?? {})).toEqual(['status', 'owner', 'due']);
      commit({ ...store.get(atom), status: 'done' });
      setPropertyDraft('draft-commit', { key: null });
      expect(parseFrontmatter(readField(ben, 'frontmatter'))).toEqual({ status: 'done', owner: 'ben', due: 'soon' });
      expect(store.get(atom)).toEqual({ status: 'done', owner: 'ben', due: 'soon' });
    } finally { close(); }
  });

  it("cancelling the draft, or committing another field while it is held, accepts the peer's delete", () => {
    const { ada, ben, store, atom, commit, close } = peers('draft-cancel', 'status: draft\nowner: ada\n');
    try {
      setPropertyDraft('draft-cancel', { key: 'owner' });
      writeField(ada, 'frontmatter', 'status: draft\n', 'seed');
      expect(store.get(atom)).toEqual({ status: 'draft', owner: 'ada' });
      setPropertyDraft('draft-cancel', { key: null });
      expect(store.get(atom)).toEqual({ status: 'draft' });

      writeField(ada, 'frontmatter', 'status: draft\nowner: ada\n', 'seed');
      setPropertyDraft('draft-cancel', { key: 'owner' });
      writeField(ada, 'frontmatter', 'status: review\n', 'seed');
      // The held row rides along unchanged in another field's commit: it must not resurrect the deleted key.
      commit({ ...store.get(atom), status: 'done' });
      setPropertyDraft('draft-cancel', { key: null });
      expect(parseFrontmatter(readField(ben, 'frontmatter'))).toEqual({ status: 'done' });
      expect(store.get(atom)).toEqual({ status: 'done' });
    } finally { close(); }
  });

  it('a peer removing the last property keeps an open Add field row until it commits or closes', () => {
    const { ada, ben, store, atom, commit, close } = peers('draft-add', 'owner: ada\n');
    try {
      setPropertyDraft('draft-add', { adding: true });
      writeField(ada, 'frontmatter', '', 'seed');
      expect(store.get(atom), 'Properties stays open').toEqual({});
      commit({ reviewer: 'ben' });
      setPropertyDraft('draft-add', { adding: false });
      expect(parseFrontmatter(readField(ben, 'frontmatter'))).toEqual({ reviewer: 'ben' });

      setPropertyDraft('draft-add', { adding: true });
      writeField(ada, 'frontmatter', '', 'seed');
      expect(store.get(atom)).toEqual({});
      setPropertyDraft('draft-add', { adding: false });
      expect(store.get(atom), 'a closed form accepts the empty properties').toBeNull();
    } finally { close(); }
  });
});
