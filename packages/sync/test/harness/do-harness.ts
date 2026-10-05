// The real DocDO class in Node (L§4.7): opened over a Backing, clients connect through its fetch upgrade and send
// frames through the hibernation entry point, and a wake is a fresh instance over the same storage and sockets.
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { $createParagraphNode, $createTextNode, $getRoot, type ElementNode, type LexicalEditor } from 'lexical';
import { vi } from 'vitest';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { CUSTOM_PREFIX, encodePartyPrincipal, TRUSTED, type PrincipalKind, type ServerEvent } from '@moss-multi/protocol/sync';
import { createConverterEditor } from '../../src/converter/index.ts';
import { DocDO } from '../../src/doc-do.ts';
import { Backing, FakeState, serverEnds, type FakeSocket } from './workerd.ts';

export { Backing };

/** Origin of what a test client applies from the server; everything else it sends. */
const FROM_SERVER = Symbol('from-server');

type DocClass = new (ctx: never, env: never) => DocDO;

export interface Opened {
  dobj: DocDO;
  state: FakeState;
  backing: Backing;
  Doc: DocClass;
}

export function openDoc(backing = new Backing(), Doc: DocClass = DocDO as unknown as DocClass): Opened {
  const state = new FakeState(backing);
  return { dobj: new Doc(state as never, {} as never), state, backing, Doc };
}

/** Runs onStart as the first fetch, frame or RPC after a wake would. */
export async function start(opened: Opened): Promise<Opened> {
  await opened.dobj.__unsafe_ensureInitialized();
  return opened;
}

/** Evicts `opened` (its timers die and its storage handle goes dead) and returns a fresh, unstarted instance. */
export function wake(opened: Opened): Opened {
  opened.state.alive = false;
  vi.clearAllTimers();
  return openDoc(opened.backing, opened.Doc);
}

/** Row counts of the persistence tables (0 when a table does not exist). */
export function counts(backing: Backing): { updates: number; state: number } {
  const tables = new Set(backing.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name));
  const count = (table: string) => (tables.has(table) ? Number(backing.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0].n) : 0);
  return { updates: count('yupdates'), state: count('ystate') };
}

/** The `__type` of each block under the Lexical root, read from the Yjs tree. */
export function blockTypes(doc: Y.Doc): string[] {
  return (doc.get('root', Y.XmlText).toDelta() as { insert: unknown }[]).map((op) =>
    op.insert instanceof Y.XmlText ? String(op.insert.getAttribute('__type')) : typeof op.insert,
  );
}

export function syncFrame(type: number, update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  encoding.writeVarUint(encoder, type);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

export function step1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

export interface Who {
  /** null: no principal header at all. */
  id?: string | null;
  kind?: PrincipalKind;
  name?: string;
  role?: string;
  session?: string | null;
  share?: string | null;
}

let connections = 0;

/**
 * A WebSocket upgrade through the DO's own fetch, with the headers the Worker would set. Pass `doc` to reconnect a
 * provider that keeps its Y.Doc across sockets, and `pk` to reuse a partyserver connection id.
 */
export async function connect(opened: Opened, who: Who = {}, doc?: Y.Doc, pk?: string): Promise<TestClient> {
  connections += 1;
  const headers = new Headers({ upgrade: 'websocket' });
  if (who.id !== null) {
    headers.set(TRUSTED.principal, encodePartyPrincipal({ id: who.id ?? `user-${connections}`, kind: who.kind ?? 'user', name: who.name ?? `User ${connections}` }));
  }
  headers.set(TRUSTED.role, who.role ?? 'editor');
  if (who.session !== null) headers.set(TRUSTED.session, who.session ?? `session-${connections}`);
  if (who.share) headers.set(TRUSTED.share, who.share);
  const made = serverEnds.length;
  const url = `https://doc.test/parties/doc-d-o/${opened.backing.docId}?_pk=${pk ?? `conn-${connections}`}`;
  const response = await opened.dobj.fetch(new Request(url, { headers }));
  if (response.status !== 101) throw new Error(`upgrade answered ${response.status}: ${await response.text()}`);
  const socket = serverEnds[made];
  if (!socket) throw new Error('the upgrade made no socket pair');
  return new TestClient(opened, socket, doc);
}

/** A provider's half of the sync protocol over one accepted socket. */
export class TestClient {
  readonly events: ServerEvent[] = [];
  /** Binary frames that are neither sync nor awareness (payload frames), as received. */
  readonly others: Uint8Array[] = [];
  /** Called for each of `others` as it is read. */
  onOther: ((frame: Uint8Array) => void) | null = null;
  private read = 0;
  private readonly outbox: Uint8Array[] = [];

  constructor(
    public opened: Opened,
    readonly socket: FakeSocket,
    readonly doc = new Y.Doc(),
  ) {
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== FROM_SERVER) this.outbox.push(syncFrame(syncProtocol.messageYjsUpdate, update));
    });
  }

  get closed(): { code: number; reason: string } | null {
    return this.socket.closed;
  }

  /** Queues a frame behind this client's own updates, in order (a payload frame). */
  queue(frame: Uint8Array): void {
    this.outbox.push(frame);
  }

  /** Takes the queued frames without sending them. */
  drain(): Uint8Array[] {
    return this.outbox.splice(0);
  }

  /** One frame through the hibernation entry point, as workerd delivers it. */
  async deliver(frame: Uint8Array | string): Promise<void> {
    const message = typeof frame === 'string' ? frame : (frame.slice().buffer as ArrayBuffer);
    await this.opened.dobj.webSocketMessage(this.socket as never, message);
  }

  /** The socket drops: workerd closes it and runs the DO's close handler. */
  async drop(code = 1006): Promise<void> {
    this.socket.close(code);
    await this.opened.dobj.webSocketClose(this.socket as never, code, '', false);
  }

  /** What a provider sends on open (and on every resync), then the replies. */
  async hello(): Promise<void> {
    await this.deliver(step1(this.doc));
    await this.pump();
  }

  /** Reads every server frame not read yet, answering a step 1 with a step 2 as a provider does. */
  async pump(): Promise<void> {
    while (this.read < this.socket.sent.length) {
      const frame = this.socket.sent[this.read];
      this.read += 1;
      if (typeof frame === 'string') {
        if (frame.startsWith(CUSTOM_PREFIX)) this.events.push(JSON.parse(frame.slice(CUSTOM_PREFIX.length)) as ServerEvent);
        continue;
      }
      const decoder = decoding.createDecoder(frame);
      const type = decoding.readVarUint(decoder);
      if (type === 1) continue; // awareness
      if (type !== 0) {
        this.others.push(frame);
        this.onOther?.(frame);
        continue;
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, FROM_SERVER);
      if (encoding.length(encoder) > 1 && this.socket.readyState === 1) await this.deliver(encoding.toUint8Array(encoder));
    }
  }

  /** Sends this client's own updates, one frame each, then reads the replies. */
  async flush(): Promise<void> {
    await this.push();
    await this.pump();
  }

  /** Sends this client's queued frames, one each, in order. */
  async push(): Promise<void> {
    for (const frame of this.outbox.splice(0)) {
      if (this.socket.readyState !== 1) break;
      await this.deliver(frame);
    }
  }
}

const noop = () => {};
const stubProvider = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop,
  disconnect: noop,
  on: noop,
  off: noop,
} as unknown as Provider;

/** A headless V1 binding with moss's nodes, as a client editor holds one. Bind before syncing. */
export interface BoundLexical {
  editor: LexicalEditor;
  flush: () => void;
  /** Appends text to the last block. */
  type: (text: string) => void;
  text: () => string;
  blocks: () => string[];
}

export function bindLexical(doc: Y.Doc): BoundLexical {
  const editor = createConverterEditor();
  const binding = createBinding(editor, stubProvider, 'root', doc, new Map([['root', doc]]));
  editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    syncLexicalUpdateToYjs(binding, stubProvider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
  });
  binding.root.getSharedType().observeDeep((events, transaction) => {
    if (transaction.origin !== binding) syncYjsChangesToLexical(binding, stubProvider, events as never, false, noop);
  });
  const flush = () => editor.update(noop, { discrete: true });
  return {
    editor,
    flush,
    type: (text) => {
      flush();
      editor.update(
        () => {
          const root = $getRoot();
          let block = root.getLastChild<ElementNode>();
          if (!block) {
            block = $createParagraphNode();
            root.append(block);
          }
          block.append($createTextNode(text));
        },
        { discrete: true },
      );
    },
    text: () => {
      flush();
      return editor.getEditorState().read(() => $getRoot().getTextContent());
    },
    blocks: () => {
      flush();
      return editor.getEditorState().read(() => $getRoot().getChildren().map((node) => node.getType()));
    },
  };
}
