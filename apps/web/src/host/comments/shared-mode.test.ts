// @vitest-environment jsdom
// Which comment path an editor takes (comments.md §12). A pane bound to its doc stays shared while its collaboration
// plugin is down (a refused frame's resync, or another pane holding the doc), so its comment writes are refused there
// rather than landing in moss's local atoms, which the next publish overwrites (A§0 invariant 2). Only an editor no
// pane binds (the file-backed editor bundle) takes moss's own path.
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { createEditor, type LexicalEditor } from 'lexical';
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { useMossMultiPane } from '../collab/pane.tsx';
import { bound, liveAnchorIds, mutate, targets, useNoteBound } from './adapter.ts';
import { noteBound, painterOf } from './paint.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DOC = 'doc-shared-mode';
let captured: LexicalEditor | null = null;
const seen: boolean[] = [];

function Capture(): null {
  [captured] = useLexicalComposerContext();
  return null;
}

function Watch({ docId }: { docId: string }): null {
  seen.push(useNoteBound(docId));
  return null;
}

/** A pane with no content editable: the editor has no root, so the collaboration plugin never mounts. */
function Pane({ docId }: { docId: string }): ReactNode {
  const pane = useMossMultiPane({ id: docId });
  return createElement(
    LexicalComposer,
    { initialConfig: { namespace: 'shared-mode', onError: (error: Error) => { throw error; } } },
    pane.collaboration?.plugin,
    createElement(Capture),
    createElement(Watch, { docId }),
  );
}

it('a bound pane whose plugin is down stays shared and refuses every comment write', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Pane, { docId: DOC })));
  const editor = captured;
  if (!editor) throw new Error('no editor');
  expect(painterOf(editor), 'the plugin is down: no painter').toBeUndefined();
  expect(bound(editor), 'the pane binds the doc whether or not its plugin is mounted').toBe(true);
  expect(noteBound(DOC)).toBe(true);
  expect(seen.at(-1), 'useNoteBound keeps the author-only gates').toBe(true);
  expect(mutate(editor, { type: 'reply', parentId: 'c1', text: 'a reply' }), 'reply refused').toBe(false);
  expect(mutate(editor, { type: 'edit', id: 'c1', text: 'an edit' }), 'edit refused').toBe(false);
  expect(mutate(editor, { type: 'delete', id: 'c1', scope: 'comment' }), 'delete refused').toBe(false);
  expect(mutate(editor, { type: 'resolve', rootId: 'c1', resolved: true }), 'resolve refused').toBe(false);
  expect(targets(editor), 'the gutter does not fall back to MarkNodes').toEqual([]);
  expect(liveAnchorIds(editor), 'the anchor tracker does not fall back to MarkNodes').toEqual([]);
  await act(async () => root.unmount());
  host.remove();
  expect(bound(editor), 'unmounting the pane ends the binding').toBe(false);
  expect(noteBound(DOC)).toBe(false);
});

it('an editor no pane binds takes moss own path', () => {
  const editor = createEditor();
  expect(bound(editor)).toBe(false);
  expect(targets(editor), 'the gutter walks MarkNodes').toBeNull();
  expect(liveAnchorIds(editor), 'the anchor tracker walks MarkNodes').toBeNull();
  expect(mutate(editor, { type: 'reply', parentId: 'c1', text: 'a reply' })).toBe(false);
});
