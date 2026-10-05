// The DocDO's headless side (A§5.1, A§12): moss's converter editor bound (V1) to a mirror Y.Doc, serverWrite for
// every server-side content write, the seed, and markdown export. Typechecks reach the vendored converter modules
// through src/moss-modules.d.ts.
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs';
import { registerList } from '@lexical/list';
import { $normalizeFormatWhitespace } from '@moss-desktop/renderer/editor/markdown/format-whitespace';
import { $createParagraphNode, $getRoot, TextNode, type LexicalEditor } from 'lexical';
import * as Y from 'yjs';
import { readField } from '@moss-multi/core/doc-fields';
import { composeFrontmatter, importFrontmatter } from '@moss-multi/core/frontmatter';
import { $importNoteBody, createConverterEditor, exportMarkdown } from './converter/index.ts';
import { $recomputeExportFormulas } from './formula-export.ts';
import { bindRegisters } from './registers.ts';
import { excludedPropertiesFor } from './excluded-properties.ts';
import { PAYLOAD_LOADED, PayloadDocs, payloadDocsFor } from './payload-docs.ts';

export const SERVER_SEED = 'server-seed';
export const SERVER_IMPORT = 'server-import';
const HYDRATE = Symbol('hydrate');

/**
 * Where a note's payloads live for its server-side readers and writers (A§10.10): the DocDO's store, which reads only
 * payloads an element names; or, for a doc outside a DocDO, its payload docs in memory.
 */
export interface PayloadSource {
  /** A named payload's state, or null. */
  read(id: string): Uint8Array | null;
  /** Any id the note knows, withheld ones included. */
  has(id: string): boolean;
  /** A server write to payload `id`. */
  write(id: string, update: Uint8Array): void;
}

const sources = new WeakMap<Y.Doc, PayloadSource>();

export function attachPayloadSource(live: Y.Doc, source: PayloadSource): void {
  sources.set(live, source);
}

function sourceOf(live: Y.Doc): PayloadSource {
  const attached = sources.get(live);
  if (attached) return attached;
  const host = payloadDocsFor(live);
  return {
    read: (id) => {
      const doc = host.get(id);
      return doc ? Y.encodeStateAsUpdate(doc) : null;
    },
    has: (id) => host.has(id),
    write: (id, update) => Y.applyUpdate(host.hold(id), update, SERVER_IMPORT),
  };
}

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
  /** Each payload the mutation wrote, as one update. */
  written: () => [string, Uint8Array][];
  dispose: () => void;
}

/**
 * A headless editor bound to a fresh Y.Doc that holds `live`'s state, with the hydration committed. Payloads load on
 * first read, from the named ones only.
 */
function mirrorOf(live: Y.Doc): Mirror {
  const doc = new Y.Doc();
  const source = sourceOf(live);
  const payloads = new PayloadDocs((id) => source.read(id), (id) => source.has(id));
  const writes = new Map<string, Uint8Array[]>();
  payloads.onHold((id, held) => {
    held.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === PAYLOAD_LOADED) return;
      const list = writes.get(id);
      if (list) list.push(update); else writes.set(id, [update]);
    });
  });
  const editor = createConverterEditor();
  // Moss's live editor runs these transforms on imports before its binding writes them.
  const stopLists = registerList(editor);
  const stopWhitespace = editor.registerNodeTransform(TextNode, $normalizeFormatWhitespace);
  // The client's exclusions, so the mirror writes and reads the same fields the browser does (A§10.9).
  const binding = createBinding(editor, provider, 'root', doc, new Map([['root', doc]]), excludedPropertiesFor(editor));
  const stopUpdates = editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
  });
  const stopRegisters = bindRegisters(editor, doc, { serializedImports: true, payloads });
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
    written: () => [...writes].map(([id, updates]) => [id, Y.mergeUpdates(updates)]),
    dispose: () => {
      stopRegisters();
      stopUpdates();
      stopWhitespace();
      stopLists();
      root.unobserveDeep(observer);
      payloads.destroy();
      doc.destroy();
    },
  };
}

/** What `mutate` changes: an update against `live`'s state, and each payload it wrote. */
function mirrorDiff(live: Y.Doc, mutate: (doc: Y.Doc) => void): { diff: Uint8Array; payloads: [string, Uint8Array][] } {
  const mirror = mirrorOf(live);
  try {
    const hydrated = Y.encodeStateVector(mirror.doc);
    mirror.editor.update(() => mutate(mirror.doc), { discrete: true });
    return { diff: Y.encodeStateAsUpdate(mirror.doc, hydrated), payloads: mirror.written() };
  } finally {
    mirror.dispose();
  }
}

/** Admission for a server write: the note's diff and each payload's; throws to refuse. */
export type Admit = (diff: Uint8Array, payloads: [string, Uint8Array][]) => void;

/**
 * The one server-side content writer (seed and import now; push, restore and accept later): run `mutate` inside a
 * headless update on a hydrated mirror, hand the mirror's diffs to `admit` (which throws to refuse them), then write
 * the payloads it changed and apply the note's diff to the live doc under `origin`. The mirror is released before
 * returning. Returns whether the live doc changed.
 */
export function serverWrite(live: Y.Doc, origin: unknown, mutate: (doc: Y.Doc) => void, admit: Admit = noop): boolean {
  const { diff, payloads } = mirrorDiff(live, mutate);
  admit(diff, payloads);
  const source = sourceOf(live);
  for (const [id, update] of payloads) source.write(id, update);
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
export function importBody(live: Y.Doc, markdown: string, admit?: Admit, frontmatter?: string): boolean {
  return serverWrite(live, SERVER_IMPORT, (doc) => {
    $importNoteBody(markdown, { comments: {} });
    if (frontmatter !== undefined) {
      importFrontmatter(doc, frontmatter, SERVER_IMPORT);
    }
  }, admit);
}

/** The `.md` file (A§12): the frontmatter block in its fences, then the body through the one converter. */
export function exportDocMarkdown(live: Y.Doc, noteId = live.guid): string {
  const mirror = mirrorOf(live);
  try {
    mirror.editor.update(() => $recomputeExportFormulas(noteId), { discrete: true });
    return composeFrontmatter(readField(live, 'frontmatter'), exportMarkdown(mirror.editor));
  } finally {
    mirror.dispose();
  }
}
