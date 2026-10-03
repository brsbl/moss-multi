import type { Connection, ConnectionContext, WSMessage } from 'partyserver';
import { YServer } from 'y-partyserver';
import * as Y from 'yjs';
import { splitFrontmatter } from '@moss-desktop/common/markdown-layers';
import { ACK_COALESCE_MS, AWARENESS_MAX_BYTES, MAX_CONNECTIONS, STATE_CAP_BYTES, WRITE_RATE } from '@moss-multi/protocol/limits';
import { roleAtLeast } from '@moss-multi/protocol/roles';
import { bytesToBase64, CLOSE, type ServerEvent, type WriteRefusalReason } from '@moss-multi/protocol/sync';
import { attachmentFrom, connectCode, parseFrame, revocationCode, stateBytesAfter, wouldChange, WriteRate, type Attachment } from './doc/admission.ts';
import { attach, attachmentOf, awarenessTooLarge } from './doc/awareness.ts';
import { AckCoalescer, DocStore, PERSISTENCE } from './doc/persistence.ts';
import type { SyncEnv } from './env.ts';
import { exportDocMarkdown, importBody, rootIsEmpty, SERVER_IMPORT, SERVER_SEED, seedEmptyParagraph } from './server-doc.ts';

export interface DocLimits {
  stateCapBytes: number;
  maxConnections: number;
  writeRate: { max: number; windowMs: number };
  awarenessMaxBytes: number;
}

export interface CreateDocInput {
  folderId: string;
  ownerId: string;
  /** A file stem (import); "+ Note" sends none, and placeholder text is never authored. */
  title?: string;
  /** A body to import through the one converter instead of the seed's empty paragraph. */
  markdown?: string;
}

/** A server write that would pass the state cap (A§5.1 Limits). */
export class DocCapError extends Error {
  constructor() {
    super('doc-cap');
    this.name = 'DocCapError';
  }
}

const isConnection = (origin: unknown): origin is Connection =>
  typeof origin === 'object' && origin !== null && typeof (origin as Connection).send === 'function' && 'id' in origin;

/**
 * One per doc, addressed by idFromName(docId) at /parties/doc-d-o/<docId> (A§5.1). The Worker authenticates every
 * socket and sets the trusted headers; this class persists, seeds, gates writes and answers RPCs. Every RPC that
 * reads the doc starts with ready(), so a stub that outlives an eviction never reads an empty doc.
 */
export class DocDO extends YServer<SyncEnv> {
  static options = { hibernate: true };
  /** Static so the Node harness can shrink them. */
  static limits: DocLimits = {
    stateCapBytes: STATE_CAP_BYTES,
    maxConnections: MAX_CONNECTIONS,
    writeRate: WRITE_RATE,
    awarenessMaxBytes: AWARENESS_MAX_BYTES,
  };

  readonly instanceId = crypto.randomUUID();
  readonly constructedAt = Date.now();

  #store: DocStore | null = null;
  #exported: string | null = null;
  readonly #limits = (this.constructor as typeof DocDO).limits;
  readonly #rate = new WriteRate(this.#limits.writeRate.max, this.#limits.writeRate.windowMs);
  readonly #acks = new AckCoalescer((connectionId) => this.#ack(connectionId), ACK_COALESCE_MS);

  /** Runs inside partyserver's blockConcurrencyWhile, so a woken DO replays before it sees any frame. */
  override async onLoad(): Promise<void> {
    const store = new DocStore(this.ctx.storage);
    store.load(this.document);
    this.#store = store;
    this.document.on('update', (update: Uint8Array, origin: unknown) => this.#persist(store, update, origin));
    this.#seed(store);
  }

  /** Debounced by y-partyserver (2 s, at most 10 s). */
  override async onSave(): Promise<void> {
    if (this.#store && this.#store.pendingRows > 0) this.#store.compact(this.document);
  }

  override async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const store = await this.#ready();
    const attachment = attachmentFrom(ctx.request.headers);
    const code = connectCode(attachment, {
      revoked: store.revoked,
      deleted: store.meta('deleted') === '1',
      connections: [...this.getConnections()].length,
      maxConnections: this.#limits.maxConnections,
    });
    if (code !== null || !attachment) {
      connection.close(code ?? CLOSE.noPrincipal, 'refused');
      return;
    }
    attach(connection, attachment);
    // Registering the socket in the PrincipalDO's sign-out registry lands with that registry (A§5.2, M2).
    return super.onConnect(connection, ctx);
  }

  override onMessage(connection: Connection, message: WSMessage): void {
    const attachment = attachmentOf(connection);
    const store = this.#store;
    if (!attachment || !store) {
      connection.close(CLOSE.noPrincipal, 'no principal');
      return;
    }
    const revoked = revocationCode(attachment, store.revoked);
    if (revoked !== null) {
      connection.close(revoked, 'revoked');
      return;
    }
    if (typeof message === 'string') {
      super.onMessage(connection, message);
      return;
    }
    const frame = parseFrame(message);
    if (frame.kind === 'other') return;
    if (frame.kind === 'awareness' && awarenessTooLarge(frame.bytes, this.#limits.awarenessMaxBytes)) return;
    // Inert frames (every step 2 answering a step 1) pass whatever the role; writes meet the gates.
    if (frame.kind === 'sync') {
      if (wouldChange(this.document, frame.update)) {
        if (this.#refused(connection, attachment, store, frame.update)) return;
      } else if (roleAtLeast(attachment.role, 'editor')) {
        // The doc already holds it, so nothing persists to ack it: an editor's reconnect step 2 after its ack was lost
        // with the old socket. Acked too, so the client learns its edits are on the server (A§10.6).
        this.#acks.schedule(connection.id);
      }
    }
    super.onMessage(connection, message);
  }

  /** Defense in depth: below editor, y-partyserver never applies a step 2 or update, inert or not. */
  override isReadOnly(connection: Connection): boolean {
    return !roleAtLeast(attachmentOf(connection)?.role, 'editor');
  }

  override onClose(connection: Connection, code: number, reason: string, wasClean: boolean): void {
    super.onClose(connection, code, reason, wasClean);
    this.#rate.forget(connection.id);
    this.#acks.cancel(connection.id);
  }

  /**
   * Records the doc's folder and owner and writes its starting content: the seed, or an imported body. Idempotent:
   * a repeated create changes nothing. Throws DocCapError for a body past the state cap.
   */
  async create(input: CreateDocInput): Promise<void> {
    const store = await this.#ready();
    this.#seed(store);
    if (store.meta('created') !== null) return;
    if (input.markdown) {
      const parts = splitFrontmatter(input.markdown);
      const hasFrontmatter = parts.hasFrontmatter && !parts.error;
      const frontmatter = hasFrontmatter ? input.markdown.slice(0, input.markdown.length - parts.body.length) : undefined;
      importBody(this.document, hasFrontmatter ? parts.body : input.markdown, (diff) => this.#admitServerWrite(store, diff), frontmatter);
    }
    const title = input.title?.trim();
    // POST /api/docs wrote the D1 title, so this write needs no projection.
    if (title) this.document.transact(() => this.document.getText('title').insert(0, title), SERVER_SEED);
    store.setMeta('folder', input.folderId);
    store.setMeta('owner', input.ownerId);
    store.setMeta('created', '1');
  }

  /** Internal RPC: preserves Yjs item identity, including relative anchors, without a markdown round trip. */
  async snapshotForDuplicate(): Promise<{ title: string; state: Uint8Array }> {
    await this.#ready();
    return { title: this.document.getText('title').toString(), state: Y.encodeStateAsUpdate(this.document) };
  }

  async createFromSnapshot(input: Omit<CreateDocInput, 'markdown'>, state: Uint8Array): Promise<void> {
    const store = await this.#ready();
    if (store.meta('created') !== null) return;
    if (state.byteLength > this.#limits.stateCapBytes) throw new DocCapError();
    this.document.transact(() => {
      // Drop only this new doc's seed, then apply the independent source snapshot.
      const root = this.document.get('root', Y.XmlText);
      root.delete(0, root.length);
      Y.applyUpdate(this.document, state, SERVER_IMPORT);
      const title = this.document.getText('title');
      title.delete(0, title.length);
      title.insert(0, input.title ?? '');
    }, SERVER_IMPORT);
    store.setMeta('folder', input.folderId);
    store.setMeta('owner', input.ownerId);
    store.setMeta('created', '1');
  }

  /** The doc as a `.md` file, memoized until the next update. */
  async exportMarkdown(): Promise<string> {
    await this.#ready();
    this.#exported ??= exportDocMarkdown(this.document);
    return this.#exported;
  }

  /** Called through a raw stub and never runs onStart, so it reads nothing from the doc (A§19). */
  probeInstance(): { instanceId: string; constructedAt: number } {
    return { instanceId: this.instanceId, constructedAt: this.constructedAt };
  }

  /** The reset test hook (A§19): drops this instance; the call that ends it rejects. */
  abortInstance(): void {
    this.ctx.abort('qa-reset');
  }

  async #ready(): Promise<DocStore> {
    await this.__unsafe_ensureInitialized();
    if (!this.#store) throw new Error('DocDO started without its store');
    return this.#store;
  }

  #seed(store: DocStore): void {
    if (store.meta('seeded') !== null) return;
    if (rootIsEmpty(this.document)) seedEmptyParagraph(this.document);
    store.setMeta('seeded', '1');
  }

  #persist(store: DocStore, update: Uint8Array, origin: unknown): void {
    this.#exported = null;
    if (origin === PERSISTENCE) return;
    store.record(update, this.document);
    if (isConnection(origin)) this.#acks.schedule(origin.id);
  }

  /** Simulated only near the cap, since the copy costs a full encode. */
  #overCap(store: DocStore, update: Uint8Array): boolean {
    const cap = this.#limits.stateCapBytes;
    return store.stateBytes + update.byteLength > cap && stateBytesAfter(this.document, update) > cap;
  }

  #admitServerWrite(store: DocStore, diff: Uint8Array): void {
    if (this.#overCap(store, diff)) throw new DocCapError();
  }

  /** True when the write was refused and the socket closed; a refusal is never silent. */
  #refused(connection: Connection, attachment: Attachment, store: DocStore, update: Uint8Array): boolean {
    if (!roleAtLeast(attachment.role, 'suggester')) return this.#refuse(connection, 'role', CLOSE.revoked);
    // A suggester's writes are vetted on a mirror (M5); until then they are refused, never applied unvetted.
    if (!roleAtLeast(attachment.role, 'editor')) return this.#refuse(connection, 'suggest', CLOSE.writeRefused);
    if (!this.#rate.allow(connection.id)) {
      // Transient: the client keeps its Y.Doc and its next step 2 re-delivers everything.
      connection.close(CLOSE.writeRate, 'write rate');
      return true;
    }
    if (this.#overCap(store, update)) return this.#refuse(connection, 'doc-cap', CLOSE.writeRefused);
    return false;
  }

  #refuse(connection: Connection, reason: WriteRefusalReason, code: number): true {
    const event: ServerEvent = { t: 'write-refused', reason };
    this.sendCustomMessage(connection, JSON.stringify(event));
    connection.close(code, `write-refused: ${reason}`);
    return true;
  }

  #ack(connectionId: string): void {
    const connection = this.getConnection(connectionId);
    if (!connection) return;
    const event: ServerEvent = { t: 'ack', sv: bytesToBase64(Y.encodeStateVector(this.document)) };
    this.sendCustomMessage(connection, JSON.stringify(event));
  }
}
