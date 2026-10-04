// Bound-editor scenes for the comment anchor engine (docs/design/comments.md §5): real headless editors bound through
// @lexical/yjs V1 with a Y.UndoManager as the CollaborationPlugin wires it, a server Y.Doc that runs the engine on
// every frame through CommentsHost, and frames sent per local transaction (online), through groupPending (an
// offline replay under the frame discipline), or merged into one (a batched or forged frame).
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Binding, type Provider } from '@lexical/yjs';
import {
  $createRangeSelection, $getRoot, $isElementNode, $isTextNode, $setSelection, type LexicalEditor, type LexicalNode, type RangeSelection,
  type TextNode,
} from 'lexical';
import * as Y from 'yjs';
import { anchorText, liveUnits, mintAnchor, type Anchor } from '@moss-multi/core/anchor-frame';
import { groupPending } from '@moss-multi/core/group-pending';
import { CommentsHost, type FrameVerdict } from '../../src/doc/comments-host.ts';
import { createConverterEditor } from '../../src/converter/index.ts';
import { excludedPropertiesFor } from '../../src/excluded-properties.ts';
import { bindRegisters } from '../../src/registers.ts';
import { importBody } from '../../src/server-doc.ts';

const FROM_SERVER = 'from-server';
const noop = () => {};
const provider = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop, disconnect: noop, on: noop, off: noop,
} as unknown as Provider;

export const BODY = 'The quick brown fox jumps over the lazy dog.\n\nSecond paragraph here, a fox too.\n\nThird.';

export class Peer {
  readonly doc = new Y.Doc();
  readonly editor: LexicalEditor;
  readonly binding: Binding;
  readonly history: Y.UndoManager;
  /** This client's local updates not yet sent, one per Yjs transaction, as AckLedger keeps them. */
  readonly outbox: Uint8Array[] = [];
  readonly #dispose: () => void;

  constructor(private readonly scene: Scene) {
    const editor = createConverterEditor();
    this.editor = editor;
    const binding = createBinding(editor, provider, 'root', this.doc, new Map([['root', this.doc]]), excludedPropertiesFor(editor));
    this.binding = binding;
    const stopRegisters = bindRegisters(editor, this.doc);
    const stopUpdates = editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
      syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
    });
    const root = binding.root.getSharedType();
    const observer: Parameters<typeof root.observeDeep>[0] = (events, transaction) => {
      if (transaction.origin !== binding) syncYjsChangesToLexical(binding, provider, events as never, false, noop);
    };
    root.observeDeep(observer);
    Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(scene.server), FROM_SERVER);
    editor.update(noop, { discrete: true });
    this.history = new Y.UndoManager(root, { trackedOrigins: new Set([binding]), captureTimeout: 0 });
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== FROM_SERVER) this.outbox.push(update);
    });
    this.#dispose = () => {
      stopUpdates();
      stopRegisters();
      this.history.destroy();
      root.unobserveDeep(observer);
      this.doc.destroy();
    };
  }

  /** One Lexical update, committed at once. */
  edit(fn: () => void): this {
    this.editor.update(fn, { discrete: true });
    this.editor.update(noop, { discrete: true });
    return this;
  }

  undo(): this {
    this.history.undo();
    this.editor.update(noop, { discrete: true });
    return this;
  }

  redo(): this {
    this.history.redo();
    this.editor.update(noop, { discrete: true });
    return this;
  }

  /** Online: every local transaction is its own frame. */
  send(): FrameVerdict[] {
    const verdicts = this.outbox.splice(0).map((update) => this.scene.deliver(update));
    this.scene.pullAll();
    return verdicts;
  }

  /** An offline replay under the frame discipline (§6). */
  sendGrouped(): FrameVerdict[] {
    const verdicts = groupPending(this.outbox.splice(0)).map((frame) => this.scene.deliver(frame));
    this.scene.pullAll();
    return verdicts;
  }

  /** Everything pending as one frame: a batched or non-discipline client. */
  sendMerged(): FrameVerdict[] {
    const verdicts = [this.scene.deliver(Y.mergeUpdates(this.outbox.splice(0)))];
    this.scene.pullAll();
    return verdicts;
  }

  pull(): void {
    Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(this.scene.server, Y.encodeStateVector(this.doc)), FROM_SERVER);
    this.editor.update(noop, { discrete: true });
  }

  /** The editor's text, blocks joined by newlines. */
  text(): string {
    return this.editor.getEditorState().read(() => $getRoot().getTextContent());
  }

  dispose(): void {
    this.#dispose();
  }
}

export class Scene {
  readonly server = new Y.Doc();
  readonly host: CommentsHost;
  readonly peers: Peer[] = [];
  readonly #offline = new Set<Peer>();

  constructor(body = BODY) {
    importBody(this.server, body);
    this.host = new CommentsHost(this.server);
  }

  peer(): Peer {
    const peer = new Peer(this);
    this.peers.push(peer);
    return peer;
  }

  /** A peer that stops pulling, so it edits from an older state until `online`. */
  offline(peer: Peer): void {
    this.#offline.add(peer);
  }

  online(peer: Peer): void {
    this.#offline.delete(peer);
  }

  /** Comment `id` on the `nth` occurrence of `quote` in the server's live text (a decorator reads as U+FFFC). */
  comment(id: string, quote: string, nth = 0, kind: Anchor['kind'] = 'text'): Anchor {
    const { text, units } = liveUnits(this.server);
    let at = -1;
    for (let i = 0; i <= nth; i += 1) at = text.indexOf(quote, at + 1);
    if (at < 0) throw new Error(`"${quote}" is not in ${JSON.stringify(text)}`);
    const anchor = mintAnchor(units[at], units[at + quote.length - 1], kind);
    this.host.create(id, anchor);
    this.pullAll();
    return anchor;
  }

  status(id: string): Anchor['status'] | undefined {
    return this.host.anchor(id)?.status;
  }

  /** What comment `id` paints on the server, or null when it is detached. */
  text(id: string): string | null {
    const anchor = this.host.anchor(id);
    return anchor ? anchorText(this.server, anchor) : null;
  }

  deliver(update: Uint8Array): FrameVerdict {
    return this.host.receive(update);
  }

  pullAll(): void {
    for (const peer of this.peers) if (!this.#offline.has(peer)) peer.pull();
  }

  dispose(): void {
    for (const peer of this.peers) peer.dispose();
    this.server.destroy();
  }
}

/** Runs `body` against a fresh scene and always disposes it. */
export async function scene(run: (scene: Scene) => void | Promise<void>, body = BODY): Promise<void> {
  const fresh = new Scene(body);
  try {
    await run(fresh);
  } finally {
    fresh.dispose();
  }
}

/** A selection over the `nth` occurrence of `needle`, searching text nodes in order with blocks joined by '\n'. */
export function $select(needle: string, nth = 0, collapse?: 'start' | 'end'): RangeSelection {
  const nodes: { node: TextNode; start: number }[] = [];
  let text = '';
  let parent: LexicalNode | null = null;
  const visit = (node: LexicalNode) => {
    if ($isTextNode(node)) {
      if (parent && node.getParent() !== parent) text += '\n';
      parent = node.getParent();
      nodes.push({ node, start: text.length });
      text += node.getTextContent();
    } else if ($isElementNode(node)) {
      for (const child of node.getChildren()) visit(child);
    }
  };
  visit($getRoot());
  let at = -1;
  for (let i = 0; i <= nth; i += 1) at = text.indexOf(needle, at + 1);
  if (at < 0) throw new Error(`"${needle}" is not in ${JSON.stringify(text)}`);
  const point = (offset: number, end: boolean): [string, number] => {
    for (const { node, start } of nodes) {
      const size = node.getTextContentSize();
      if (end ? offset > start && offset <= start + size : offset >= start && offset < start + size) return [node.getKey(), offset - start];
    }
    throw new Error(`no text point at ${offset}`);
  };
  const [anchorKey, anchorOffset] = point(collapse === 'end' ? at + needle.length : at, collapse === 'end');
  const [focusKey, focusOffset] = collapse ? [anchorKey, anchorOffset] : point(at + needle.length, true);
  const selection = $createRangeSelection();
  selection.anchor.set(anchorKey, anchorOffset, 'text');
  selection.focus.set(focusKey, focusOffset, 'text');
  $setSelection(selection);
  return selection;
}

/** A collapsed caret just before (or after) the `nth` occurrence of `needle`. */
export const $caret = (needle: string, nth = 0, side: 'start' | 'end' = 'start') => $select(needle, nth, side);

/** The block at `index` under the root. */
export const $block = (index: number) => $getRoot().getChildren()[index];
