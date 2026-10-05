// The DocDO's headless side (A§5.1, A§12): moss's converter editor bound (V1) to a mirror Y.Doc, serverWrite for
// every server-side content write, the seed, and markdown export. Typechecks reach the vendored converter modules
// through src/moss-modules.d.ts.
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Binding, type Provider } from '@lexical/yjs';
import { registerList } from '@lexical/list';
import { $normalizeFormatWhitespace } from '@moss-desktop/renderer/editor/markdown/format-whitespace';
import {
  $createParagraphNode, $getRoot, $isDecoratorNode, $isElementNode, $isTextNode, TextNode, type ElementNode, type LexicalEditor, type LexicalNode,
} from 'lexical';
import * as Y from 'yjs';
import { readField } from '@moss-multi/core/doc-fields';
import { BLOCK_CHAR } from '@moss-multi/core/tree-anchor';
import { composeFrontmatter, importFrontmatter } from '@moss-multi/core/frontmatter';
import { $importNoteBody, createConverterEditor, exportMarkdown } from './converter/index.ts';
import { $recomputeExportFormulas } from './formula-export.ts';
import { bindRegisters, $refreshRegisters, migrateRegisters } from './registers.ts';
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

export interface Mirror {
  doc: Y.Doc;
  editor: LexicalEditor;
  binding: Binding;
  dispose: () => void;
}

/** A headless editor bound to a fresh Y.Doc that holds `live`'s state, with the hydration committed. */
export function mirrorOf(live: Y.Doc): Mirror {
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
  const stopRegisters = bindRegisters(editor, doc, { serializedImports: true });
  const root = binding.root.getSharedType();
  const observer: Parameters<Y.XmlText['observeDeep']>[0] = (events, transaction) => {
    if (transaction.origin !== binding) syncYjsChangesToLexical(binding, provider, events as never, false, noop);
  };
  root.observeDeep(observer);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(live), HYDRATE);
  migrateRegisters(doc);
  // The hydration commits on its own, under the collaboration tag, before any mutation runs.
  editor.update(() => $refreshRegisters(editor, doc), { discrete: true, skipTransforms: true });
  return {
    doc,
    editor,
    binding,
    dispose: () => {
      stopRegisters();
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

/** Where one imported comment's markers sat: its first and last unit (text-mode ordinals), and whether a decorator held it. */
export interface MarkRange {
  first: number;
  last: number;
  block: boolean;
}

/** What marker import recorded over the mark-transparent tree, and that tree's unit text to align it with the live doc. */
export interface ImportedMarks {
  ranges: Map<string, MarkRange>;
  text: string;
}

type Commentable = LexicalNode & { getCommentIds(): string[]; setCommentIds(ids: string[]): void };
const isCommentable = (node: LexicalNode): node is Commentable =>
  typeof (node as Partial<Commentable>).getCommentIds === 'function' && typeof (node as Partial<Commentable>).setCommentIds === 'function';
const isMark = (node: LexicalNode): node is ElementNode & { getIDs(): string[] } => node.getType() === 'mark' && $isElementNode(node);

/**
 * Records each comment id's units (MarkNodes and decorator ids, in the order anchor-frame counts units), then unwraps
 * every MarkNode and clears every decorator's ids, so nothing of a comment stays in the tree (comments.md §11, §13).
 */
function $stripCommentMarks(): ImportedMarks {
  const ranges = new Map<string, MarkRange>();
  const marks: ElementNode[] = [];
  const parts: string[] = [];
  let at = 0;
  const note = (ids: readonly string[], first: number, last: number, block: boolean) => {
    for (const id of ids) {
      const range = ranges.get(id);
      if (range) {
        range.last = last;
        range.block = false;
      } else {
        ranges.set(id, { first, last, block });
      }
    }
  };
  const visit = (node: LexicalNode, ids: readonly string[]) => {
    if ($isTextNode(node)) {
      const text = node.getTextContent();
      if (text.length) note(ids, at, at + text.length - 1, false);
      parts.push(text);
      at += text.length;
      return;
    }
    if ($isDecoratorNode(node)) {
      const own = isCommentable(node) ? node.getCommentIds() : [];
      note(ids, at, at, false);
      note(own.filter((id) => !ids.includes(id)), at, at, true);
      if (own.length) node.setCommentIds([]);
      parts.push(BLOCK_CHAR);
      at += 1;
      return;
    }
    if (!$isElementNode(node)) return;
    let inner = ids;
    if (isMark(node)) {
      marks.push(node);
      inner = [...ids, ...node.getIDs().filter((id) => !ids.includes(id))];
    }
    for (const child of node.getChildren()) visit(child, inner);
  };
  visit($getRoot(), []);
  for (const mark of marks) {
    for (const child of mark.getChildren()) mark.insertBefore(child);
    mark.remove();
  }
  return { ranges, text: parts.join('') };
}

/**
 * Replaces the body with `markdown` through the one converter (A§12), which imports with no selection (SP2). With a
 * comments sidecar, its markers become recorded ranges (moss's `$processCommentMarkers`, then unwrapped); without
 * one, markers are dropped.
 */
export function importBody(live: Y.Doc, markdown: string, admit?: (diff: Uint8Array) => void, frontmatter?: string, comments?: Record<string, unknown>): ImportedMarks {
  let marks: ImportedMarks = { ranges: new Map(), text: '' };
  serverWrite(live, SERVER_IMPORT, (doc) => {
    $importNoteBody(markdown, { comments: comments ?? {} });
    marks = $stripCommentMarks();
    if (frontmatter !== undefined) {
      importFrontmatter(doc, frontmatter, SERVER_IMPORT);
    }
  }, admit);
  return marks;
}

/** The `.md` file (A§12): the frontmatter block in its fences, then the body through the one converter. */
export function exportDocMarkdown(live: Y.Doc, noteId = live.guid): string {
  const mirror = mirrorOf(live);
  try {
    mirror.editor.update(() => {
      // Defense in depth: comments are never in the tree, but a mark a client wrote must not reach a file.
      $stripCommentMarks();
      $recomputeExportFormulas(noteId);
    }, { discrete: true });
    return composeFrontmatter(readField(live, 'frontmatter'), exportMarkdown(mirror.editor));
  } finally {
    mirror.dispose();
  }
}
