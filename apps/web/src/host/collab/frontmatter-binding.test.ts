// @vitest-environment jsdom
import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { readField, writeField } from '@moss-multi/core/doc-fields';
import { frontmatterDirtySignalAtom, noteFrontmatterAtom } from '@moss/shared/state/note-atoms';
import { bindFrontmatter, parseFrontmatter } from './frontmatter-binding.ts';

describe('frontmatter binding', () => {
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
      expect(raw.match(/^owner:/gm)).toHaveLength(2);
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
