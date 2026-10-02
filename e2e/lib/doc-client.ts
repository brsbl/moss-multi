// Protocol-level doc clients (j00-roundtrip): YProvider over a real WebSocket carrying a principal's session cookie,
// bound to a headless V1 Lexical editor as a browser pane binds one (A§10.1-10.2), with no UI.
import { createHeadlessEditor } from '@lexical/headless';
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs';
import { $createParagraphNode, $createTextNode, $getRoot, type ElementNode } from 'lexical';
import WebSocket from 'ws';
import YProvider from 'y-partyserver/provider';
import * as Y from 'yjs';
import { DOC_SOCKET_PATH } from '../../packages/protocol/src/dom-contract.ts';
import { base64ToBytes, type ServerEvent } from '../../packages/protocol/src/sync.ts';
import type { SessionCookie } from './principals.ts';

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
  });
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
  const url = `${baseUrl.replace(/^http/, 'ws')}${DOC_SOCKET_PATH}${encodeURIComponent(docId)}`;
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
