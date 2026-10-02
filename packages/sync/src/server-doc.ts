/// <reference path="./moss-modules.d.ts" />
// The DocDO's headless side (A§5.1, A§12): moss's converter editor bound (V1) to a mirror Y.Doc, serverWrite for
// every server-side content write, the seed, and markdown export.
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs';
import { $createParagraphNode, $getRoot, type LexicalEditor } from 'lexical';
import * as Y from 'yjs';
import { createConverterEditor, exportMarkdown } from './converter/index.ts';

export const SERVER_SEED = 'server-seed';
const HYDRATE = Symbol('hydrate');

const noop = () => {};
/** Server bindings need the provider's shape, not a network: no cursor sync, no mutation listeners (A§12). */
const provider = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop,
  disconnect: noop,
  on: noop,
  off: noop,
} as unknown as Provider;

interface Mirror {
  doc: Y.Doc;
  editor: LexicalEditor;
  dispose: () => void;
}

/** A headless editor bound to a fresh Y.Doc that holds `live`'s state, with the hydration committed. */
function mirrorOf(live: Y.Doc): Mirror {
  const doc = new Y.Doc();
  const editor = createConverterEditor();
  const binding = createBinding(editor, provider, 'root', doc, new Map([['root', doc]]));
  const stopUpdates = editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
  });
  const root = binding.root.getSharedType();
  const observer: Parameters<Y.XmlText['observeDeep']>[0] = (events, transaction) => {
    if (transaction.origin !== binding) syncYjsChangesToLexical(binding, provider, events as never, false, noop);
  };
  root.observeDeep(observer);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(live), HYDRATE);
  // The hydration commits on its own, under the collaboration tag, before any mutation runs.
  editor.update(noop, { discrete: true });
  return {
    doc,
    editor,
    dispose: () => {
      stopUpdates();
      root.unobserveDeep(observer);
      doc.destroy();
    },
  };
}

/**
 * The one server-side content writer (seed now; import, push, restore and accept later): run `mutate` inside a
 * headless update on a hydrated mirror, then apply the mirror's diff to the live doc under `origin`. Returns
 * whether the live doc changed.
 */
export function serverWrite(live: Y.Doc, origin: unknown, mutate: () => void): boolean {
  const mirror = mirrorOf(live);
  try {
    const hydrated = Y.encodeStateVector(mirror.doc);
    mirror.editor.update(mutate, { discrete: true });
    let changed = false;
    const onUpdate = () => {
      changed = true;
    };
    live.on('update', onUpdate);
    try {
      Y.applyUpdate(live, Y.encodeStateAsUpdate(mirror.doc, hydrated), origin);
    } finally {
      live.off('update', onUpdate);
    }
    return changed;
  } finally {
    mirror.dispose();
  }
}

export const rootIsEmpty = (doc: Y.Doc): boolean => doc.get('root', Y.XmlText).length === 0;

/** One empty paragraph into an empty root, under `server-seed`. Title and frontmatter stay empty. */
export function seedEmptyParagraph(live: Y.Doc): boolean {
  if (!rootIsEmpty(live)) return false;
  return serverWrite(live, SERVER_SEED, () => {
    const root = $getRoot();
    if (root.getChildrenSize() === 0) root.append($createParagraphNode());
  });
}

/** The `.md` file (A§12): the raw frontmatter block, then the body through the one converter. */
export function exportDocMarkdown(live: Y.Doc): string {
  const mirror = mirrorOf(live);
  try {
    const body = exportMarkdown(mirror.editor);
    const frontmatter = live.getText('frontmatter').toString();
    if (!frontmatter) return body;
    return frontmatter.endsWith('\n') ? `${frontmatter}${body}` : `${frontmatter}\n${body}`;
  } finally {
    mirror.dispose();
  }
}
