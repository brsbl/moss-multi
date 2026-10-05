// The suggest-mode fork (docs/design/suggestions.md §5), headless: a moss editor bound V1 to F, a private copy of the
// body plus the author's own records, written under the active lease. Every F transaction whose origin is not one of
// the shim's own is forwarded as `suggest-ops`, so the binding, register writers and the UndoManager are all
// recorded without an allowlist. The spike's headless harness; the client's fork is client.ts.
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Binding, type Provider } from '@lexical/yjs';
import { registerList } from '@lexical/list';
import { $normalizeFormatWhitespace } from '@moss-desktop/renderer/editor/markdown/format-whitespace';
import { TextNode, type LexicalEditor } from 'lexical';
import * as Y from 'yjs';
import type { SuggestionRecord } from '@moss-multi/core/suggest/apply';
import { createConverterEditor } from '../converter/index.ts';
import { excludedPropertiesFor } from '../excluded-properties.ts';
import { bindRegisters } from '../registers.ts';
import { SHIM_BODY_APPLY, SHIM_RECORD_APPLY } from './client.ts';

export { SHIM_BODY_APPLY, SHIM_RECORD_APPLY };

const noop = () => {};
const provider = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop,
  disconnect: noop,
  on: noop,
  off: noop,
} as unknown as Provider;

/** A moss editor bound V1 to `doc`, with the client's list and whitespace transforms and its registers. */
export function bindEditor(doc: Y.Doc): { editor: LexicalEditor; binding: Binding; undo: Y.UndoManager; dispose: () => void } {
  const editor = createConverterEditor();
  const stopLists = registerList(editor);
  const stopWhitespace = editor.registerNodeTransform(TextNode, $normalizeFormatWhitespace);
  const binding = createBinding(editor, provider, 'root', doc, new Map([['root', doc]]), excludedPropertiesFor(editor));
  const stopRegisters = bindRegisters(editor, doc);
  const stopUpdates = editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
  });
  const root = binding.root.getSharedType();
  const observer: Parameters<Y.XmlText['observeDeep']>[0] = (events, transaction) => {
    if (transaction.origin !== binding) syncYjsChangesToLexical(binding, provider, events as never, false, noop);
  };
  root.observeDeep(observer);
  const undo = new Y.UndoManager(root, { trackedOrigins: new Set([binding]), captureTimeout: 0 });
  return {
    editor,
    binding,
    undo,
    dispose: () => {
      undo.destroy();
      stopUpdates();
      stopRegisters();
      stopWhitespace();
      stopLists();
      root.unobserveDeep(observer);
    },
  };
}

export class ForkShim {
  readonly fork = new Y.Doc();
  readonly editor: LexicalEditor;
  /** Every forwarded update, in order: what the client sends as `suggest-ops`. */
  readonly sent: Uint8Array[] = [];
  readonly #bound: ReturnType<typeof bindEditor>;

  /** F binds first and is filled after, so the binding reconciles it like a first sync. */
  constructor(body: Y.Doc, lease: number, records: readonly SuggestionRecord[] = []) {
    this.fork.clientID = lease;
    this.#bound = bindEditor(this.fork);
    this.editor = this.#bound.editor;
    this.fork.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== SHIM_BODY_APPLY && origin !== SHIM_RECORD_APPLY) this.sent.push(update);
    });
    Y.applyUpdate(this.fork, Y.encodeStateAsUpdate(body), SHIM_BODY_APPLY);
    for (const record of records) for (const op of record.ops) Y.applyUpdate(this.fork, op, SHIM_RECORD_APPLY);
    this.commit();
  }

  /** A body update from the provider. */
  receive(update: Uint8Array): void {
    Y.applyUpdate(this.fork, update, SHIM_BODY_APPLY);
    this.commit();
  }

  /** A user edit; returns what it forwarded. */
  act(fn: () => void): Uint8Array[] {
    const from = this.sent.length;
    this.commit();
    this.editor.update(fn, { discrete: true });
    this.commit();
    return this.sent.slice(from);
  }

  /** Cmd+Z through the binding's UndoManager. */
  undo(): Uint8Array[] {
    const from = this.sent.length;
    this.#bound.undo.undo();
    this.commit();
    return this.sent.slice(from);
  }

  /** Flushes pending Lexical work (register refreshes, reconciles) before the next step. */
  commit(): void {
    this.editor.update(noop, { discrete: true });
  }

  dispose(): void {
    this.#bound.dispose();
    this.fork.destroy();
  }
}
