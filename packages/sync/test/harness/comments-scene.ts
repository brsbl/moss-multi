// Bound-editor scenes for the comment anchor engine (docs/design/comments.md §5): real headless editors bound through
// @lexical/yjs V1 with a Y.UndoManager as the CollaborationPlugin wires it, the real DocDO (in the Node harness) that
// runs gate 2b, the engine and writeComments on every frame it receives over an editor's doc socket, and frames sent
// per local transaction (online), through groupPending (an offline replay under the frame discipline), or merged into
// one (a batched or forged frame).
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Binding, type Provider } from '@lexical/yjs';
import {
  $createRangeSelection, $getRoot, $isElementNode, $isTextNode, $setSelection, type LexicalEditor, type LexicalNode, type RangeSelection,
  type TextNode,
} from 'lexical';
import { vi } from 'vitest';
import * as Y from 'yjs';
import { anchorText, liveUnits, mintAnchor, type Anchor } from '@moss-multi/core/anchor-frame';
import { groupPending } from '@moss-multi/core/group-pending';
import { createConverterEditor } from '../../src/converter/index.ts';
import { DocDO } from '../../src/doc-do.ts';
import { excludedPropertiesFor } from '../../src/excluded-properties.ts';
import { bindRegisters } from '../../src/registers.ts';
import { connect, openDoc, start, syncFrame, type Opened, type TestClient } from './do-harness.ts';

const FROM_SERVER = 'from-server';
const noop = () => {};
const provider = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop, disconnect: noop, on: noop, off: noop,
} as unknown as Provider;

export const BODY = 'The quick brown fox jumps over the lazy dog.\n\nSecond paragraph here, a fox too.\n\nThird.';

/** A frame's verdict at the DocDO: the write-refused reason its socket was closed with, or null when it applied. */
export interface FrameVerdict {
  refused: string | null;
}

/** The DocDO without a per-socket write rate: a scene or a fuzz run sends more frames than one window allows. */
class SceneDoc extends DocDO {
  static override limits = { ...DocDO.limits, writeRate: { max: Number.MAX_SAFE_INTEGER, windowMs: 5_000 } };
}

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
  send(): Promise<FrameVerdict[]> {
    return this.#deliver(this.outbox.splice(0));
  }

  /** An offline replay under the frame discipline (§6). */
  sendGrouped(): Promise<FrameVerdict[]> {
    return this.#deliver(groupPending(this.outbox.splice(0)));
  }

  /** Everything pending as one frame: a batched or non-discipline client. */
  sendMerged(): Promise<FrameVerdict[]> {
    const pending = this.outbox.splice(0);
    return this.#deliver(pending.length ? [Y.mergeUpdates(pending)] : []);
  }

  async #deliver(frames: Uint8Array[]): Promise<FrameVerdict[]> {
    const verdicts: FrameVerdict[] = [];
    for (const frame of frames) verdicts.push(await this.scene.deliver(frame));
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
  readonly peers: Peer[] = [];
  readonly #offline = new Set<Peer>();
  #socket: TestClient | null = null;
  /** Called after every frame the DocDO receives, refused or not. */
  afterFrame: (() => void) | null = null;

  private constructor(readonly opened: Opened) {}

  /** A started DocDO created with `body`, as POST /api/docs imports one. */
  static async open(body = BODY): Promise<Scene> {
    const opened = await start(openDoc(undefined, SceneDoc as never));
    await opened.dobj.create({ folderId: 'folder', ownerId: 'owner', markdown: body });
    return new Scene(opened);
  }

  /** The DocDO's live Y.Doc. */
  get server(): Y.Doc {
    return this.opened.dobj.document;
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

  /**
   * Comment `id` on the `nth` occurrence of `quote` in the server's live text (a decorator reads as U+FFFC), through
   * the DocDO's create RPC as REST creates one.
   */
  async comment(id: string, quote: string, nth = 0, kind: Anchor['kind'] = 'text'): Promise<Anchor> {
    const { text, units } = liveUnits(this.server);
    let at = -1;
    for (let i = 0; i <= nth; i += 1) at = text.indexOf(quote, at + 1);
    if (at < 0) throw new Error(`"${quote}" is not in ${JSON.stringify(text)}`);
    return this.commentAt(id, at, quote.length, kind);
  }

  /** Comment `id` on `length` live units from unit `at`. */
  async commentAt(id: string, at: number, length: number, kind: Anchor['kind'] = 'text'): Promise<Anchor> {
    const { units } = liveUnits(this.server);
    const minted = mintAnchor(units[at], units[at + length - 1], kind);
    const result = await this.opened.dobj.createComment({ author: 'ada', id, text: `comment ${id}`, anchor: { kind, start: minted.start, end: minted.end } });
    if (!result.ok) throw new Error(`create ${id}: ${result.status} ${result.error}`);
    this.pullAll();
    return this.anchor(id)!;
  }

  anchor(id: string): Anchor | undefined {
    return this.server.getMap<Anchor>('comments').get(`a:${id}`);
  }

  status(id: string): Anchor['status'] | undefined {
    return this.anchor(id)?.status;
  }

  /** What comment `id` paints on the server, or null when it is detached. */
  text(id: string): string | null {
    const anchor = this.anchor(id);
    return anchor ? anchorText(this.server, anchor) : null;
  }

  /** One sync update over an editor's doc socket; a refused frame closes it, and the next frame opens another. */
  async deliver(update: Uint8Array): Promise<FrameVerdict> {
    if (!this.#socket || this.#socket.closed) this.#socket = await connect(this.opened, { role: 'editor' });
    const socket = this.#socket;
    const seen = socket.events.length;
    await socket.deliver(syncFrame(2, update));
    await socket.pump();
    const refusal = socket.events.slice(seen).find((event) => event.t === 'write-refused');
    this.afterFrame?.();
    if (refusal?.t === 'write-refused') return { refused: refusal.reason };
    return { refused: socket.closed ? `closed ${socket.closed.code}` : null };
  }

  pullAll(): void {
    for (const peer of this.peers) if (!this.#offline.has(peer)) peer.pull();
  }

  dispose(): void {
    for (const peer of this.peers) peer.dispose();
  }
}

/** Runs `run` against a fresh scene and always disposes it. The DocDO's timers are faked, as in its other tests. */
export async function scene(run: (scene: Scene) => void | Promise<void>, body = BODY): Promise<void> {
  vi.useFakeTimers();
  try {
    const fresh = await Scene.open(body);
    try {
      await run(fresh);
    } finally {
      fresh.dispose();
    }
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
}

/** The text a selection helper searches: text nodes in order, blocks joined by '\n'. */
function $textMap(): { text: string; nodes: { node: TextNode; start: number }[] } {
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
  return { text, nodes };
}

/** The searched text (see $select), so a caller can pick offsets. */
export const $searchText = (): string => $textMap().text;

/** A selection over [at, at + length) of the searched text, or a caret at `at` when `length` is 0. */
export function $selectAt(at: number, length: number): RangeSelection {
  const { nodes } = $textMap();
  const point = (offset: number, end: boolean): [string, number] => {
    for (const { node, start } of nodes) {
      const size = node.getTextContentSize();
      if (end ? offset > start && offset <= start + size : offset >= start && offset < start + size) return [node.getKey(), offset - start];
    }
    throw new Error(`no text point at ${offset}`);
  };
  const [anchorKey, anchorOffset] = length === 0 ? point(at, at > 0) : point(at, false);
  const [focusKey, focusOffset] = length === 0 ? [anchorKey, anchorOffset] : point(at + length, true);
  const selection = $createRangeSelection();
  selection.anchor.set(anchorKey, anchorOffset, 'text');
  selection.focus.set(focusKey, focusOffset, 'text');
  $setSelection(selection);
  return selection;
}

/** A selection over the `nth` occurrence of `needle`, searching text nodes in order with blocks joined by '\n'. */
export function $select(needle: string, nth = 0, collapse?: 'start' | 'end'): RangeSelection {
  const { text, nodes } = $textMap();
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
