// @vitest-environment jsdom
// T3.S6: while a peer's large paste reconciles, its large lists and tables go without dir="auto" (WebKit recomputes it
// per child added), and get it back right after; small edits and local ones leave it alone.
import type { LexicalEditor } from 'lexical';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { liftDirOnLargeRemote } from './dir-lift.ts';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function page(items: number) {
  const root = document.createElement('div');
  const list = document.createElement('ul');
  list.dir = 'auto';
  for (let i = 0; i < items; i += 1) list.appendChild(document.createElement('li'));
  const paragraph = document.createElement('p');
  paragraph.dir = 'auto';
  root.append(paragraph, list);
  return { editor: { getRootElement: () => root } as unknown as LexicalEditor, list, paragraph };
}

/** An update from another client adding `chars` characters. */
function remote(chars: number): Uint8Array {
  const peer = new Y.Doc();
  peer.getText('t').insert(0, 'x'.repeat(chars));
  return Y.encodeStateAsUpdate(peer);
}

it("lifts a large list's dir while a large remote change reconciles, and restores it after", () => {
  const doc = new Y.Doc();
  const { editor, list, paragraph } = page(200);
  const stop = liftDirOnLargeRemote(editor, doc);
  Y.applyUpdate(doc, remote(10), 'peer');
  expect(list.getAttribute('dir'), 'a small remote change lifts nothing').toBe('auto');
  Y.applyUpdate(doc, remote(1_000), 'peer');
  expect(list.hasAttribute('dir')).toBe(false);
  expect(paragraph.getAttribute('dir'), 'a small element keeps it').toBe('auto');
  vi.runAllTimers();
  expect(list.getAttribute('dir')).toBe('auto');
  doc.getText('t').insert(0, 'y'.repeat(1_000));
  expect(list.getAttribute('dir'), 'a local change lifts nothing').toBe('auto');
  stop();
});
