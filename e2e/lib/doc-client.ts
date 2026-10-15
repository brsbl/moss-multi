// Protocol-level doc clients (j00-roundtrip): YProvider over a real WebSocket carrying a principal's session cookie,
// bound to a headless V1 Lexical editor as a browser pane binds one (A§10.1-10.2), with no UI. Also raw doc sockets
// that only hold a connection slot (j03).
import { randomUUID } from 'node:crypto';
import { createHeadlessEditor } from '@lexical/headless';
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs';
import { $createParagraphNode, $createTextNode, $getRoot, type ElementNode } from 'lexical';
import WebSocket from 'ws';
import YProvider from 'y-partyserver/provider';
import * as Y from 'yjs';
import { CLIENT_PROTOCOL, PROTOCOL_PARAM } from '../../packages/protocol/src/client-protocol.ts';
import { DOC_SOCKET_PATH } from '../../packages/protocol/src/dom-contract.ts';
import { base64ToBytes, PAYLOAD_MESSAGE, type ServerEvent } from '../../packages/protocol/src/sync.ts';
import type { SessionCookie } from './principals.ts';

/** Every doc socket names the client protocol it speaks, as a browser bundle does (rule 10). */
export const PROTOCOL_QUERY = `${PROTOCOL_PARAM}=${CLIENT_PROTOCOL}`;

export const cookieHeader = (cookies: SessionCookie[]): string => cookies.map((c) => `${c.name}=${c.value}`).join('; ');

const upgradeHeaders = (baseUrl: string, cookie: string | null) => ({ origin: baseUrl, ...(cookie ? { cookie } : {}) });

/** ws presenting the principal's cookie and a same-origin Origin on the upgrade, as a browser tab would. */
function socketWith(baseUrl: string, cookie: string | null) {
  return class extends WebSocket {
    constructor(url: string) {
      super(url, { headers: upgradeHeaders(baseUrl, cookie) });
    }
  };
}

const noop = () => {};
const quietProvider = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop,
  disconnect: noop,
  on: noop,
  off: noop,
} as unknown as Provider;

async function until(what: string, ready: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

export interface DocClient {
  doc: Y.Doc;
  events: ServerEvent[];
  /** Resolves at the provider's first sync. */
  synced: Promise<void>;
  /** The Lexical root's block types. */
  blocks(): string[];
  text(): string;
  /** Appends a text node to the last block, through the binding. */
  type(text: string): void;
  /** Resolves once a server ack covers everything this client wrote. */
  acked(): Promise<void>;
  /** Idempotent. */
  close(): void;
}

export async function openDocClient(baseUrl: string, docId: string, cookie: string): Promise<DocClient> {
  const doc = new Y.Doc();
  const editor = createHeadlessEditor({
    namespace: 'j00-roundtrip',
    onError: (error) => {
      throw error;
    },
  });
  const binding = createBinding(editor, quietProvider, 'root', doc, new Map([['root', doc]]));
  editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    syncLexicalUpdateToYjs(binding, quietProvider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
  });
  binding.root.getSharedType().observeDeep((events, transaction) => {
    if (transaction.origin !== binding) syncYjsChangesToLexical(binding, quietProvider, events as never, false, noop);
  });
  const flush = () => editor.update(noop, { discrete: true });

  const provider = new YProvider(new URL(baseUrl).host, docId, doc, {
    party: 'doc-d-o',
    connect: false,
    disableBc: true,
    WebSocketPolyfill: socketWith(baseUrl, cookie) as unknown as typeof globalThis.WebSocket,
    params: { [PROTOCOL_PARAM]: String(CLIENT_PROTOCOL) },
  });
  // This client holds no decorator payloads (A§10.10); their frames ride the same socket and are ignored here.
  provider.messageHandlers[PAYLOAD_MESSAGE] = () => {};
  const events: ServerEvent[] = [];
  provider.on('custom-message', (message: string) => events.push(JSON.parse(message) as ServerEvent));
  const synced = new Promise<void>((resolve) => {
    provider.on('sync', (isSynced: boolean) => {
      if (isSynced) resolve();
    });
  });
  await provider.connect();
  let closed = false;

  return {
    doc,
    events,
    synced,
    blocks: () => {
      flush();
      return editor.getEditorState().read(() => $getRoot().getChildren().map((node) => node.getType()));
    },
    text: () => {
      flush();
      return editor.getEditorState().read(() => $getRoot().getTextContent());
    },
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
    acked: () =>
      until('an ack covering the local state', () => {
        const local = Y.decodeStateVector(Y.encodeStateVector(doc));
        return events.some((event) => {
          if (event.t !== 'ack') return false;
          const acked = Y.decodeStateVector(base64ToBytes(event.sv));
          return [...local].every(([client, clock]) => (acked.get(client) ?? 0) >= clock);
        });
      }),
    close: () => {
      if (closed) return;
      closed = true;
      provider.disconnect();
      provider.destroy();
      doc.destroy();
    },
  };
}

/** Opens a doc socket and reports whether the handshake completed and the close code (1006 when it was refused). */
export function probeSocket(baseUrl: string, docId: string, cookie: string | null): Promise<{ opened: boolean; code: number }> {
  const url = `${baseUrl.replace(/^http/, 'ws')}${DOC_SOCKET_PATH}${encodeURIComponent(docId)}?${PROTOCOL_QUERY}`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: upgradeHeaders(baseUrl, cookie) });
    let opened = false;
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`${url}: no close within 15 s`));
    }, 15_000);
    socket.on('open', () => {
      opened = true;
    });
    socket.on('error', noop);
    socket.on('close', (code) => {
      clearTimeout(timer);
      resolve({ opened, code });
    });
  });
}

export interface HeldSockets {
  /** Sockets still open. */
  open(): number;
  /** Closes every socket with 1000 and waits for each close. */
  close(): Promise<void>;
}

/**
 * `n` doc sockets that complete the upgrade and stay open without speaking sync, so the DocDO counts them against
 * its connection limit. Each carries its own `_pk`, as a provider does.
 */
export async function holdDocSockets(baseUrl: string, docId: string, cookie: string, n: number): Promise<HeldSockets> {
  const url = `${baseUrl.replace(/^http/, 'ws')}${DOC_SOCKET_PATH}${encodeURIComponent(docId)}`;
  const sockets: WebSocket[] = [];
  const closed = new Set<WebSocket>();
  const held: HeldSockets = {
    open: () => sockets.length - closed.size,
    close: async () => {
      await Promise.all(
        sockets
          .filter((socket) => !closed.has(socket))
          .map(
            (socket) =>
              new Promise<void>((done) => {
                socket.once('close', () => done());
                socket.close(1000, 'held socket released');
              }),
          ),
      );
    },
  };
  try {
    for (let i = 0; i < n; i += 1) {
      const socket = new WebSocket(`${url}?${PROTOCOL_QUERY}&_pk=held-${i}-${randomUUID()}`, { headers: upgradeHeaders(baseUrl, cookie) });
      socket.on('error', noop);
      socket.on('close', () => closed.add(socket));
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('close', (code) => reject(new Error(`held socket ${i + 1} of ${n} closed ${code} before it opened`)));
      });
    }
  } catch (error) {
    await held.close();
    throw error;
  }
  return held;
}
