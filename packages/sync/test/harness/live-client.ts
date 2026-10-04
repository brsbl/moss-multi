// A live client in the DocDO harness, as a browser pane binds a note (A§10.1-10.2, A§10.10): moss's node classes on a
// V1 binding with the wire exclusions, the register binding, the payload docs and their socket sync, and the body's one
// undo stack. Frames leave in the order the client made them; `up` delivers them and `down` reads the replies.
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Binding, type Provider } from '@lexical/yjs';
import {
  $createParagraphNode, $createTextNode, $getNodeByKey, $getRoot, $getSelection, $isElementNode, $isParagraphNode,
  $isRangeSelection, $isTextNode, type LexicalEditor, type LexicalNode, type NodeKey,
} from 'lexical';
import * as Y from 'yjs';
import { createConverterEditor } from '../../src/converter/index.ts';
import { excludedPropertiesFor } from '../../src/excluded-properties.ts';
import { BodyUndo, lexicalAction, PayloadSync, payloadDocsFor, payloadText, type PayloadDocs } from '../../src/payload-docs.ts';
import { bindRegisters, REGISTER_LOCAL_ORIGIN } from '../../src/registers.ts';
import { connect, step1, type Opened, type TestClient, type Who } from './do-harness.ts';

export const KINDS = ['code-block', 'html-block', 'formula'] as const;
export type Kind = (typeof KINDS)[number];
const ACCESSORS: Record<Kind, [get: string, set: string]> = {
  'code-block': ['getCode', 'setCode'],
  'html-block': ['getRawHtml', 'setRawHtml'],
  formula: ['getFormula', 'setFormula'],
};
type PayloadNode = LexicalNode & Record<string, unknown> & { __regId: string };

const noop = () => {};
const provider = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop,
  disconnect: noop,
  on: noop,
  off: noop,
} as unknown as Provider;

/** Origin of payload frames a live client applies from the server. */
const FROM_SERVER = Symbol('payload-from-server');

export class LiveClient {
  readonly doc = new Y.Doc();
  readonly editor: LexicalEditor = createConverterEditor();
  readonly binding: Binding;
  readonly payloads: PayloadDocs;
  readonly undo: BodyUndo;
  readonly errors: unknown[] = [];
  socket!: TestClient;
  #sync!: PayloadSync;
  readonly #stops: (() => void)[] = [];

  private constructor(public opened: Opened, readonly who: Who) {
    this.binding = createBinding(this.editor, provider, 'root', this.doc, new Map([['root', this.doc]]), excludedPropertiesFor(this.editor));
    this.payloads = payloadDocsFor(this.doc);
    this.#stops.push(bindRegisters(this.editor, this.doc));
    this.#stops.push(this.editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
      syncLexicalUpdateToYjs(this.binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
    }));
    const root = this.binding.root.getSharedType();
    const observer: Parameters<Y.XmlText['observeDeep']>[0] = (events, transaction) => {
      if (transaction.origin !== this.binding) {
        syncYjsChangesToLexical(this.binding, provider, events as never, transaction.origin instanceof Y.UndoManager, noop);
      }
    };
    root.observeDeep(observer);
    this.#stops.push(() => root.unobserveDeep(observer));
    this.undo = new BodyUndo(new Y.UndoManager(root, { trackedOrigins: new Set([this.binding]), captureTimeout: 0 }), lexicalAction(this.editor));
    for (const doc of this.payloads.docs.values()) this.undo.trackPayload(doc, REGISTER_LOCAL_ORIGIN, 0);
    this.#stops.push(this.payloads.onHold((_id, doc) => { this.undo.trackPayload(doc, REGISTER_LOCAL_ORIGIN, 0); }));
  }

  /** Connects, then exchanges the note's and every named payload's first sync. */
  static async open(opened: Opened, who: Who = {}): Promise<LiveClient> {
    const client = new LiveClient(opened, who);
    await client.#attach();
    return client;
  }

  async #attach(): Promise<void> {
    this.socket = await connect(this.opened, this.who, this.doc);
    this.socket.onOther = (frame) => { this.#sync.receive(frame); };
    this.#sync?.destroy();
    this.#sync = new PayloadSync(this.payloads, {
      send: (frame) => this.socket.queue(frame),
      open: () => this.socket.socket.readyState === 1,
      remote: FROM_SERVER,
    });
    await this.socket.hello();
    this.flush();
    // A reconnect re-delivers each held payload whole; acks are not modelled here.
    this.#sync.connected((id) => {
      const doc = this.payloads.hold(id);
      return doc.store.clients.size ? Y.encodeStateAsUpdate(doc) : null;
    });
    await this.sync();
  }

  /** A fresh socket over the same docs (a reconnect, or a wake that dropped the socket). */
  async reconnect(opened = this.opened): Promise<void> {
    this.opened = opened;
    await this.#attach();
  }

  /** The heartbeat's resync on a socket that survived a wake: a step 1, and every held payload's writes again. */
  async resync(opened = this.opened): Promise<void> {
    this.opened = opened;
    this.socket.opened = opened;
    await this.socket.deliver(step1(this.doc));
    for (const [id, doc] of this.payloads.docs) this.#sync.resend(id, Y.encodeStateAsUpdate(doc));
    await this.socket.push();
    await this.down();
  }

  /** Commits pending Lexical work and runs queued register refreshes. */
  flush(): void {
    this.editor.update(noop, { discrete: true });
    if (this.errors.length) throw this.errors[0];
  }

  /** Sends what this client made, in order. */
  async up(): Promise<void> {
    this.flush();
    await this.socket.push();
  }

  /** Reads what the server sent. */
  async down(): Promise<void> {
    await this.socket.pump();
    await Promise.resolve();
    this.flush();
  }

  async sync(): Promise<void> {
    await this.up();
    await this.down();
  }

  #read<T>(fn: () => T): T {
    this.flush();
    return this.editor.getEditorState().read(fn);
  }

  #nodes(): PayloadNode[] {
    const walk = (node: LexicalNode): PayloadNode[] =>
      (KINDS as readonly string[]).includes(node.getType()) ? [node as PayloadNode] : $isElementNode(node) ? node.getChildren().flatMap(walk) : [];
    return walk($getRoot());
  }

  #keys(): NodeKey[] {
    return this.#read(() => this.#nodes().map((node) => node.getKey()));
  }

  /** Each payload node's text, in document order, read through its getter. */
  texts(): string[] {
    return this.#read(() => this.#nodes().map((node) => String((node[ACCESSORS[node.getType() as Kind][0]] as () => string).call(node))));
  }

  ids(): string[] {
    return this.#read(() => this.#nodes().map((node) => node.__regId));
  }

  /** The Yjs items behind the payload nodes: a V1 move gives a node a new element. */
  elements(): string[] {
    return this.#keys().map((key) => {
      const element = (this.binding.collabNodeMap.get(key) as { _xmlElem?: Y.XmlElement } | undefined)?._xmlElem;
      return element?._item ? `${element._item.id.client}:${element._item.id.clock}` : '?';
    });
  }

  /** Each top-level paragraph's own text, without the inline payloads it holds. */
  paragraphs(): string[] {
    return this.#read(() => $getRoot().getChildren().filter($isParagraphNode)
      .map((node) => node.getChildren().filter($isTextNode).map((text) => text.getTextContent()).join('')));
  }

  /** The held payload doc behind payload node `index`. */
  payloadDoc(index: number): Y.Doc | undefined {
    return this.payloads.get(this.ids()[index]);
  }

  #make(kind: Kind, text: string): LexicalNode {
    const klass = this.editor._nodes.get(kind)!.klass as unknown as new (value: string, other?: string) => LexicalNode;
    return kind === 'formula' ? new klass(text, '') : new klass(text);
  }

  #update(fn: () => void): void {
    this.editor.update(fn, { discrete: true });
    if (this.errors.length) throw this.errors[0];
  }

  /** A new block (a formula goes in a new paragraph) after the first paragraph. */
  insert(kind: Kind, text: string): void {
    this.#update(() => {
      const node = this.#make(kind, text);
      const block = kind === 'formula' ? $createParagraphNode().append($createTextNode('Formula: '), node) : node;
      $getRoot().getFirstChildOrThrow().insertAfter(block);
    });
  }

  /** A block inside a new callout, a container V1 recreates with everything in it when it moves. */
  insertBoxed(kind: Kind, text: string): void {
    this.#update(() => {
      const klass = this.editor._nodes.get('callout')!.klass as unknown as new (type: string) => LexicalNode & { append(...nodes: LexicalNode[]): LexicalNode };
      $getRoot().getFirstChildOrThrow().insertAfter(new klass('note').append(this.#make(kind, text)));
    });
  }

  insertMany(kind: Kind, count: number): void {
    this.#update(() => {
      for (let i = 0; i < count; i++) $getRoot().getLastChildOrThrow().insertBefore(this.#make(kind, `block ${i};`));
    });
  }

  insertParagraph(text: string): void {
    this.#update(() => { $getRoot().getFirstChildOrThrow().insertAfter($createParagraphNode().append($createTextNode(text))); });
  }

  appendToParagraph(prefix: string, text: string): void {
    this.#update(() => {
      const paragraph = $getRoot().getChildren().find((node) => $isParagraphNode(node) && node.getTextContent().startsWith(prefix));
      const last = $isElementNode(paragraph) ? paragraph.getLastChild() : null;
      if (!$isTextNode(last)) throw new Error(`no paragraph ${prefix}`);
      last.spliceText(last.getTextContentSize(), 0, text);
    });
  }

  #write(index: number, edit: (value: string) => string): void {
    const key = this.#keys()[index];
    this.#update(() => {
      const node = $getNodeByKey(key) as PayloadNode;
      const [get, set] = ACCESSORS[node.getType() as Kind];
      (node[set] as (value: string) => void).call(node, edit((node[get] as () => string).call(node)));
    });
  }

  /** Types into payload `index` at `at`, through the node's setter as a field does. */
  type(index: number, at: number, text: string): void {
    this.#write(index, (value) => value.slice(0, Math.min(at, value.length)) + text + value.slice(Math.min(at, value.length)));
  }

  erase(index: number, at: number, length: number): void {
    this.#write(index, (value) => value.slice(0, at) + value.slice(at + length));
  }

  remove(index: number): void {
    const key = this.#keys()[index];
    this.#update(() => { $getNodeByKey(key)!.remove(); });
  }

  /** Moves the top-level block holding payload `index` to the end (V1 deletes its subtree and recreates it). */
  moveToEnd(index: number): void {
    const key = this.#keys()[index];
    this.#update(() => { $getRoot().getLastChildOrThrow().insertAfter($getNodeByKey(key)!.getTopLevelElementOrThrow()); });
  }

  moveToStart(index: number): void {
    const key = this.#keys()[index];
    this.#update(() => { $getRoot().getFirstChildOrThrow().insertBefore($getNodeByKey(key)!.getTopLevelElementOrThrow()); });
  }

  /** Splits the paragraph holding inline payload `index` before it (Enter at `offset` of its leading text). */
  splitBefore(index: number, offset: number): void {
    const key = this.#keys()[index];
    this.#update(() => {
      const leading = $getNodeByKey(key)!.getPreviousSibling();
      if (!$isTextNode(leading)) throw new Error('no text before the payload');
      leading.select(offset, offset);
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) throw new Error('no selection');
      selection.insertParagraph();
    });
  }

  /** A local edit of the node that leaves its payload alone (a language change, a result). */
  touch(index: number): void {
    const key = this.#keys()[index];
    this.#update(() => {
      const node = $getNodeByKey(key)!.getWritable() as PayloadNode;
      if (node.getType() === 'code-block') node.__language = 'rust';
      else if (node.getType() === 'formula') node.__result = '42';
    });
  }

  dispose(): void {
    this.#sync?.destroy();
    for (const stop of this.#stops.splice(0)) stop();
    this.undo.destroy();
    this.doc.destroy();
    this.payloads.destroy();
  }
}

/** The held text of a payload doc, for state checks. */
export const heldText = (doc: Y.Doc | undefined): string | undefined => (doc ? payloadText(doc).toString() : undefined);

/** Sends every client's frames, then lets every client read the replies (the spike's `sync`). */
export async function syncAll(...clients: LiveClient[]): Promise<void> {
  for (const client of clients) await client.up();
  for (const client of clients) await client.down();
}
