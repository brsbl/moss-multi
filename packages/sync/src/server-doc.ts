// The DocDO's headless side (A§5.1, A§12): moss's converter editor bound (V1) to a mirror Y.Doc, serverWrite for
// every server-side content write, the seed, and markdown export. Typechecks reach the vendored converter modules
// through src/moss-modules.d.ts.
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs';
import { registerList } from '@lexical/list';
import { $normalizeFormatWhitespace } from '@moss-desktop/renderer/editor/markdown/format-whitespace';
import { $createParagraphNode, $getRoot, TextNode, type LexicalEditor } from 'lexical';
import * as Y from 'yjs';
import { readField } from '@moss-multi/core/doc-fields';
import { composeFrontmatter } from '@moss-multi/core/frontmatter';
import { $importNoteBody, createConverterEditor, exportMarkdown } from './converter/index.ts';
import { excludedPropertiesFor } from './excluded-properties.ts';

export const SERVER_SEED = 'server-seed';
export const SERVER_IMPORT = 'server-import';
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
  // Moss's live editor runs these transforms on imports before its binding writes them.
  const stopLists = registerList(editor);
  const stopWhitespace = editor.registerNodeTransform(TextNode, $normalizeFormatWhitespace);
  // The client's exclusions, so the mirror writes and reads the same fields the browser does (A§10.9).
  const binding = createBinding(editor, provider, 'root', doc, new Map([['root', doc]]), excludedPropertiesFor(editor));
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
  editor.update(noop, { discrete: true, skipTransforms: true });
  return {
    doc,
    editor,
    dispose: () => {
      stopUpdates();
      stopWhitespace();
      stopLists();
      root.unobserveDeep(observer);
      doc.destroy();
    },
  };
}

/** What `mutate` changes, as an update against `live`'s state. */
function mirrorDiff(live: Y.Doc, mutate: (doc: Y.Doc) => void): Uint8Array {
  const mirror = mirrorOf(live);
  try {
    const hydrated = Y.encodeStateVector(mirror.doc);
    mirror.editor.update(() => mutate(mirror.doc), { discrete: true });
    return Y.encodeStateAsUpdate(mirror.doc, hydrated);
  } finally {
    mirror.dispose();
  }
}

/**
 * The one server-side content writer (seed and import now; push, restore and accept later): run `mutate` inside a
 * headless update on a hydrated mirror, hand the mirror's diff to `admit` (which throws to refuse it), then apply
 * the diff to the live doc under `origin`. The mirror is released before returning. Returns whether the live doc
 * changed.
 */
export function serverWrite(live: Y.Doc, origin: unknown, mutate: (doc: Y.Doc) => void, admit: (diff: Uint8Array) => void = noop): boolean {
  const diff = mirrorDiff(live, mutate);
  admit(diff);
  let changed = false;
  const onUpdate = () => {
    changed = true;
  };
  live.on('update', onUpdate);
  try {
    Y.applyUpdate(live, diff, origin);
  } finally {
    live.off('update', onUpdate);
  }
  return changed;
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

/** Replaces the body with `markdown` through the one converter (A§12), which imports with no selection (SP2). */
export function importBody(live: Y.Doc, markdown: string, admit?: (diff: Uint8Array) => void, frontmatter?: string): boolean {
  return serverWrite(live, SERVER_IMPORT, (doc) => {
    $importNoteBody(markdown, { comments: {} });
    if (frontmatter !== undefined) {
      const field = doc.getText('frontmatter');
      field.delete(0, field.length);
      field.insert(0, frontmatter);
    }
  }, admit);
}

/** The `.md` file (A§12): the frontmatter block in its fences, then the body through the one converter. */
export function exportDocMarkdown(live: Y.Doc): string {
  const mirror = mirrorOf(live);
  try {
    return composeFrontmatter(readField(live, 'frontmatter'), exportMarkdown(mirror.editor));
  } finally {
    mirror.dispose();
  }
}
