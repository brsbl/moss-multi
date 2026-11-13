// The DocDO's headless side (A§5.1, A§12): moss's converter editor bound (V1) to a mirror Y.Doc, serverWrite for
// every server-side content write, the seed, and markdown export, which reads the live doc in place. Typechecks reach
// the vendored converter modules through src/moss-modules.d.ts.
import { createYjsBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Binding, type Provider } from '@lexical/yjs';
import { registerList } from '@lexical/list';
import { $normalizeFormatWhitespace } from '@moss-desktop/renderer/editor/markdown/format-whitespace';
import { refusingSpentImports } from '@moss-desktop/renderer/editor/markdown/linear-import';
import { $addUpdateTag, $createParagraphNode, $getRoot, COLLABORATION_TAG, SKIP_SCROLL_INTO_VIEW_TAG, TextNode, type LexicalEditor } from 'lexical';
import * as Y from 'yjs';
import { readField } from '@moss-multi/core/doc-fields';
import { composeFrontmatter, importFrontmatter } from '@moss-multi/core/frontmatter';
import { $importNoteBody, createConverterEditor, exportMarkdown } from './converter/index.ts';
import { $recomputeExportFormulas } from './formula-export.ts';
import { bindRegisters, clientEditorReads } from './registers.ts';
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

/** Measurement only (scripts/measure-memory.mjs): called between a server write's or an export's phases. */
export const phases: { mark: ((phase: string) => void) | null } = { mark: null };
const mark = (phase: string) => phases.mark?.(phase);

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

/**
 * A V1 binding of `editor` to `doc`, with the client's exclusions, so the server writes and reads the same fields the
 * browser does (A§10.9). The binding reads each node type's defaults in an update of its own, committed here: left to
 * commit in a microtask, it held the editor, and everything bound to it, until the caller returned. With `ownTypeMap`
 * (the patched @lexical/yjs) it keeps its map from Yjs types to collab nodes to itself and writes nothing to `doc`;
 * otherwise it tags `doc`'s types, which costs less, for a mirror whose doc it owns.
 */
function bindingOf(editor: LexicalEditor, doc: Y.Doc, ownTypeMap = false): Binding {
  let binding!: Binding;
  editor.update(() => {
    binding = createYjsBinding({ editor, id: 'root', doc, docMap: new Map([['root', doc]]), excludedProperties: excludedPropertiesFor(editor), ownTypeMap });
  }, { discrete: true });
  return binding;
}

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
  const binding = bindingOf(editor, doc);
  const stopUpdates = editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
  });
  const stopRegisters = bindRegisters(editor, doc, { serializedImports: true, payloads });
  const root = binding.root.getSharedType();
  const observer: Parameters<Y.XmlText['observeDeep']>[0] = (events, transaction) => {
    if (transaction.origin !== binding) syncYjsChangesToLexical(binding, provider, events as never, false, noop);
  };
  root.observeDeep(observer);
  // The hydration commits on its own, under the collaboration tag, before any mutation runs. The observer's update
  // nests in this discrete one: on its own it would queue its commit in a microtask, which held the whole mirror until
  // the caller returned.
  editor.update(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(live), HYDRATE), { discrete: true, skipTransforms: true });
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
    mark('write: mirror hydrated');
    const hydrated = Y.encodeStateVector(mirror.doc);
    mirror.editor.update(() => mutate(mirror.doc), { discrete: true });
    mark('write: mutated');
    const diff = Y.encodeStateAsUpdate(mirror.doc, hydrated);
    mark('write: diff encoded');
    return { diff, payloads: mirror.written() };
  } finally {
    mirror.dispose();
  }
}

/** Admission for a server write: the note's diff and each payload's; throws to refuse. */
export type Admit = (diff: Uint8Array, payloads: [string, Uint8Array][]) => void;

/**
 * The one server-side content writer (seed and import now; push, restore and accept later): run `mutate` inside a
 * headless update on a hydrated mirror, hand the mirror's diffs to `admit` (which throws to refuse them), then write
 * the payloads it changed and apply the note's diff to the live doc under `origin`. The mirror (its editor and Y.Doc)
 * is unreachable before the diff applies, so the two never share the heap. Returns whether the live doc changed.
 */
export function serverWrite(live: Y.Doc, origin: unknown, mutate: (doc: Y.Doc) => void, admit: Admit = noop): boolean {
  const { diff, payloads } = mirrorDiff(live, mutate);
  mark('write: mirror released');
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
  mark('write: applied');
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

/**
 * Replaces the body with `markdown` through the one converter (A§12), which imports with no selection (SP2). Throws
 * IMPORT_BUDGET_SPENT, writing nothing, for markdown that spends the converter's whole work budget.
 */
export function importBody(live: Y.Doc, markdown: string, admit?: Admit, frontmatter?: string): boolean {
  return serverWrite(live, SERVER_IMPORT, (doc) => {
    refusingSpentImports(() => $importNoteBody(markdown, { comments: {} }));
    if (frontmatter !== undefined) {
      importFrontmatter(doc, frontmatter, SERVER_IMPORT);
    }
  }, admit);
}

/** An export that read a doc in place saw an update emitted on it; no update listener heard that update. */
export class ExportWroteError extends Error {
  constructor() {
    super('an export wrote to the doc it read in place');
    this.name = 'ExportWroteError';
  }
}

type Listeners = Map<string, Set<(...args: unknown[]) => void>>;

/**
 * Runs `read` with `live`'s update listeners (the DocDO's persistence, y-partyserver's broadcast and save) set aside, so
 * an update emitted meanwhile reaches none of them; then fails if one was. The listeners are swapped on the doc's own
 * observer map: a listener can neither stop the others nor throw without leaving Yjs's transaction cleanup half done.
 */
function refusingWrites<T>(live: Y.Doc, read: () => T): T {
  const observers = (live as unknown as { _observers: Listeners })._observers;
  let wrote = false;
  const refuse = () => {
    wrote = true;
  };
  const held = new Map<string, Set<(...args: unknown[]) => void> | undefined>();
  for (const name of ['update', 'updateV2']) {
    held.set(name, observers.get(name));
    observers.set(name, new Set([refuse]));
  }
  let result: T;
  try {
    result = read();
  } finally {
    for (const [name, listeners] of held) {
      // A listener added meanwhile stays.
      const added = [...(observers.get(name) ?? [])].filter((listener) => listener !== refuse);
      const kept = listeners ?? new Set();
      for (const listener of added) kept.add(listener);
      if (kept.size > 0) observers.set(name, kept);
      else observers.delete(name);
    }
  }
  if (wrote) throw new ExportWroteError();
  return result;
}

interface View {
  editor: LexicalEditor;
  dispose: () => void;
}

/**
 * A headless editor that reads `live` itself, for an export: its binding keeps its own map from `live`'s types to its
 * collab nodes (the patched @lexical/yjs), so the export holds the note once plus its Lexical tree and leaves `live`
 * as it was. Nothing writes Lexical's changes back (no update listener), so the formula recompute stays in the editor;
 * payloads load from the named ones into docs of the view's own. Hydrates as a binding hears a whole state applied: one
 * event on the root.
 */
function viewOf(live: Y.Doc): View {
  const source = sourceOf(live);
  const payloads = new PayloadDocs((id) => source.read(id), (id) => source.has(id));
  const editor = createConverterEditor();
  const stopLists = registerList(editor);
  const stopWhitespace = editor.registerNodeTransform(TextNode, $normalizeFormatWhitespace);
  const binding = bindingOf(editor, live, true);
  const stopRegisters = bindRegisters(editor, live, { serializedImports: true, payloads });
  const dispose = () => {
    stopRegisters();
    stopWhitespace();
    stopLists();
    payloads.destroy();
  };
  try {
    const root = binding.root;
    const keys = new Set(Object.keys(root._xmlText.getAttributes()));
    if (root._xmlText.length > 0 || keys.size > 0) {
      editor.update(() => {
        if (keys.size > 0) root.syncPropertiesFromYjs(binding, keys);
        if (root._xmlText.length > 0) {
          root.applyChildrenYjsDelta(binding, root._xmlText.toDelta());
          root.syncChildrenFromYjs(binding);
        }
        $addUpdateTag(SKIP_SCROLL_INTO_VIEW_TAG);
      }, { discrete: true, skipTransforms: true, tag: COLLABORATION_TAG });
      // As the binding's own commit callback does for a root left empty.
      if (root.isEmpty()) {
        editor.update(() => {
          if ($getRoot().getChildrenSize() === 0) $getRoot().append($createParagraphNode());
        }, { discrete: true });
      }
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return { editor, dispose };
}

/** Whether the editor's committed tree holds a formula node. */
function hasFormulas(editor: LexicalEditor): boolean {
  for (const node of editor.getEditorState()._nodeMap.values()) if (node.__type === 'formula') return true;
  return false;
}

/**
 * The `.md` file (A§12): the frontmatter block in its fences, then the body through the one converter. A doc no client
 * editor reads (the DocDO's) is read in place, never through a second whole copy; an update emitted on it meanwhile is
 * refused before any listener persists or broadcasts it, and the export throws ExportWroteError. A doc a client editor
 * reads is exported from a copy, as that editor owns it.
 */
export function exportDocMarkdown(live: Y.Doc, noteId = live.guid): string {
  if (clientEditorReads(live)) return exportFrom(mirrorOf(live), live, noteId);
  return refusingWrites(live, () => exportFrom(viewOf(live), live, noteId));
}

function exportFrom(view: View, live: Y.Doc, noteId: string): string {
  try {
    mark('export: hydrated');
    // An update clones the editor state's node map; a note without formulas has nothing to recompute.
    if (hasFormulas(view.editor)) view.editor.update(() => $recomputeExportFormulas(noteId), { discrete: true });
    const markdown = composeFrontmatter(readField(live, 'frontmatter'), exportMarkdown(view.editor));
    mark('export: exported');
    return markdown;
  } finally {
    view.dispose();
  }
}
