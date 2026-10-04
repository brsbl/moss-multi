// Decorator payload docs (A§10.10; docs/design/registers.md), Yjs-level with no Lexical: each code, HTML or formula
// block's text is a Y.Text in its own Y.Doc keyed by the block's `__regId`, held beside the note's doc. This module
// holds them (PayloadDocs), carries them over a doc socket (PayloadSync) and gives the body one Cmd+Z stack across the
// note's undo manager and each payload's (BodyUndo).
import { Observable } from 'lib0/observable';
import * as Y from 'yjs';
import {
  decodePayloadFrame, encodePayloadFrame, PAYLOAD_STEP1, PAYLOAD_STEP2, PAYLOAD_UPDATE,
} from '@moss-multi/protocol/sync';

/** The register fields, by node type (A§10.10). */
export const REGISTER_FIELDS: Readonly<Record<string, string>> = {
  'code-block': '__code', 'html-block': '__rawHtml', formula: '__formula',
};

/** The payload's one shared type. */
export const PAYLOAD_TEXT = 'payload';

/** Origin of state a payload doc loads from storage or a source; never sent, never undoable. */
export const PAYLOAD_LOADED = Symbol('moss-multi:payload-loaded');

export const payloadText = (doc: Y.Doc): Y.Text => doc.getText(PAYLOAD_TEXT);

/** `fresh`: minted here this moment, so no one else has anything of it to ask for. */
type HoldListener = (id: string, doc: Y.Doc, fresh: boolean) => void;

/**
 * The payload docs held beside one note doc. A client holds one per id its tree names (and its own new ones); a server
 * mirror holds the ones it reads, loaded from `load`. Docs are destroyed with the note's doc, never replaced.
 */
export class PayloadDocs {
  readonly docs = new Map<string, Y.Doc>();
  readonly #listeners = new Set<HoldListener>();

  constructor(
    /** A held doc's starting state (the DocDO mirror reads named payloads); null for none. */
    private readonly load?: (id: string) => Uint8Array | null,
    /** Ids a source knows beyond the held ones (withheld payloads), so an import never reuses one. */
    private readonly known?: (id: string) => boolean,
  ) {}

  get(id: string): Y.Doc | undefined {
    return this.docs.get(id);
  }

  hold(id: string, fresh = false): Y.Doc {
    let doc = this.docs.get(id);
    if (doc) return doc;
    doc = new Y.Doc({ guid: id });
    const state = fresh ? null : this.load?.(id);
    if (state) Y.applyUpdate(doc, state, PAYLOAD_LOADED);
    this.docs.set(id, doc);
    for (const listener of [...this.#listeners]) listener(id, doc, fresh);
    return doc;
  }

  has(id: string): boolean {
    return this.docs.has(id) || (this.known?.(id) ?? false);
  }

  /** Calls `listener` for every doc held from now on; returns the unsubscriber. */
  onHold(listener: HoldListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  destroy(): void {
    this.#listeners.clear();
    for (const doc of this.docs.values()) doc.destroy();
    this.docs.clear();
  }
}

const hosts = new WeakMap<Y.Doc, PayloadDocs>();

/** The payload docs of a note doc: the session's for a live note, a fresh in-memory set otherwise. */
export function payloadDocsFor(root: Y.Doc): PayloadDocs {
  let host = hosts.get(root);
  if (!host) hosts.set(root, (host = new PayloadDocs()));
  return host;
}

/** Installs `host` as `root`'s payload docs (a session or a server mirror), before anything binds `root`. */
export function attachPayloadDocs(root: Y.Doc, host: PayloadDocs): PayloadDocs {
  hosts.set(root, host);
  return host;
}

export interface PayloadSyncOptions {
  /** Sends a frame on the doc socket; called only while `open()`. */
  send(frame: Uint8Array): void;
  open(): boolean;
  /** A local write to payload `id` (for the ack ledger). */
  wrote?(id: string, update: Uint8Array): void;
  /** The origin remote frames apply under, never sent back. */
  remote: unknown;
}

/**
 * A client's half of payload sync on the doc socket. Local writes go out as payload updates while the socket is open;
 * on every connect and wake each held payload sends a step 1 and its pending writes as a step 2. The server answers a
 * step 1 only for a payload an element names, and fans out or reveals payloads itself.
 */
export class PayloadSync {
  readonly #stops: (() => void)[] = [];

  constructor(
    readonly host: PayloadDocs,
    private readonly options: PayloadSyncOptions,
  ) {
    for (const [id, doc] of host.docs) this.#watch(id, doc);
    this.#stops.push(host.onHold((id, doc, fresh) => {
      this.#watch(id, doc);
      if (!fresh && options.open()) options.send(encodePayloadFrame(id, PAYLOAD_STEP1, Y.encodeStateVector(doc)));
    }));
  }

  #watch(id: string, doc: Y.Doc): void {
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === this.options.remote || origin === PAYLOAD_LOADED) return;
      this.options.wrote?.(id, update);
      if (this.options.open()) this.options.send(encodePayloadFrame(id, PAYLOAD_UPDATE, update));
    };
    doc.on('update', onUpdate);
    this.#stops.push(() => doc.off('update', onUpdate));
  }

  /** On every connect and wake: a step 1 per held payload, and what is still unacked as a step 2. */
  connected(pending: (id: string) => Uint8Array | null): void {
    if (!this.options.open()) return;
    for (const [id, doc] of this.host.docs) {
      this.options.send(encodePayloadFrame(id, PAYLOAD_STEP1, Y.encodeStateVector(doc)));
      this.resend(id, pending(id));
    }
  }

  /** Re-delivers unacked writes (the heartbeat's resync). */
  resend(id: string, update: Uint8Array | null): void {
    if (update && this.options.open()) this.options.send(encodePayloadFrame(id, PAYLOAD_STEP2, update));
  }

  /** A payload frame from the server; false when `bytes` is not one. */
  receive(bytes: Uint8Array): boolean {
    const frame = decodePayloadFrame(bytes);
    if (!frame) return false;
    // The server never asks a client for a payload; its fan-out and reveals are updates.
    if (frame.step !== PAYLOAD_STEP1) Y.applyUpdate(this.host.hold(frame.id), frame.data, this.options.remote);
    return true;
  }

  destroy(): void {
    for (const stop of this.#stops.splice(0)) stop();
  }
}

type StackEvent = 'stack-item-added' | 'stack-item-popped' | 'stack-cleared' | 'stack-item-updated';

/**
 * The action an edit belongs to: the Lexical update in flight, or the state it is committing (its update listeners,
 * where the binding writes the note). Outside an update an edit is its own step.
 */
export const lexicalAction = (editor: { _updating: boolean; _pendingEditorState: unknown; _editorState: unknown }) => (): unknown =>
  editor._updating ? (editor._pendingEditorState ?? editor._editorState) : null;

/** One Cmd+Z step: the managers that took the edits of one action (a Lexical update), in order. */
interface Step {
  managers: Y.UndoManager[];
  stamp: unknown;
}

/**
 * The body's one Cmd+Z stack (A§10.8): the note's UndoManager and one per held payload doc, since a Y.UndoManager
 * spans one doc. Each new tracked edit records which manager took it, and undo and redo replay that order. As one
 * UndoManager over every doc would, edits within the root's capture window of the last one join its step, and so do
 * edits one action made in several docs (a setter and an attribute in one Lexical update, same `stamp`). A new edit
 * ends every redo chain. It stands in for the root UndoManager where the plugin expects one (undo, redo, the stacks'
 * lengths, the events).
 */
export class BodyUndo extends Observable<StackEvent> {
  readonly managers: Y.UndoManager[] = [];
  readonly undone: Step[] = [];
  readonly redone: Step[] = [];
  #replaying = false;
  /** When the last tracked edit landed, in any doc. */
  #lastChange = 0;

  constructor(
    readonly root: Y.UndoManager,
    /** Identifies the action an edit belongs to; null when every edit is its own step. */
    private readonly stamp: () => unknown = () => null,
  ) {
    super();
    this.track(root);
  }

  /** Payload managers track this origin. */
  trackPayload(doc: Y.Doc, origin: unknown, captureTimeout: number): Y.UndoManager {
    const manager = new Y.UndoManager(payloadText(doc), { trackedOrigins: new Set([origin]), captureTimeout });
    this.track(manager);
    return manager;
  }

  track(manager: Y.UndoManager): void {
    this.managers.push(manager);
    manager.on('stack-item-added', (event: { type: 'undo' | 'redo' }) => {
      if (!this.#replaying && event.type === 'undo') this.#added(manager);
      this.emit('stack-item-added', [event, this]);
    });
    manager.on('stack-item-updated', (event: { type: 'undo' | 'redo' }) => {
      if (!this.#replaying && event.type === 'undo') this.#lastChange = Date.now();
      this.emit('stack-item-updated', [event, this]);
    });
    manager.on('stack-item-popped', (event: unknown) => this.emit('stack-item-popped', [event, this]));
  }

  #added(manager: Y.UndoManager): void {
    const now = Date.now();
    const stamp = this.stamp();
    const last = this.undone.at(-1);
    this.redone.length = 0;
    if (last && ((stamp !== null && last.stamp === stamp) || now - this.#lastChange < this.root.captureTimeout)) {
      last.managers.push(manager);
      last.stamp = stamp;
    } else {
      this.undone.push({ managers: [manager], stamp });
      for (const other of this.managers) if (other !== manager) other.stopCapturing();
    }
    this.#lastChange = now;
    for (const other of this.managers) if (other !== manager && other.redoStack.length) other.clear(false, true);
  }

  get undoStack(): readonly Step[] {
    return this.undone;
  }

  get redoStack(): readonly Step[] {
    return this.redone;
  }

  canUndo(): boolean {
    return this.undone.length > 0;
  }

  canRedo(): boolean {
    return this.redone.length > 0;
  }

  undo(): unknown {
    return this.#step(this.undone, this.redone, (managers) => [...managers].reverse().map((manager) => manager.undo()));
  }

  redo(): unknown {
    return this.#step(this.redone, this.undone, (managers) => managers.map((manager) => manager.redo()));
  }

  stopCapturing(): void {
    for (const manager of this.managers) manager.stopCapturing();
    this.#lastChange = 0;
  }

  clear(clearUndo = true, clearRedo = true): void {
    for (const manager of this.managers) manager.clear(clearUndo, clearRedo);
    if (clearUndo) this.undone.length = 0;
    if (clearRedo) this.redone.length = 0;
    this.emit('stack-cleared', [{ undoStackCleared: clearUndo, redoStackCleared: clearRedo }]);
  }

  override destroy(): void {
    for (const manager of this.managers) manager.destroy();
    this.managers.length = 0;
    super.destroy();
  }

  /** Pops steps until one has something to replay (a peer may have emptied another's). */
  #step(from: Step[], to: Step[], run: (managers: Y.UndoManager[]) => unknown[]): unknown {
    this.stopCapturing();
    this.#replaying = true;
    try {
      while (from.length) {
        const step = from.pop()!;
        const items = run(step.managers).filter((item) => item !== null);
        if (items.length) {
          to.push(step);
          return items[0];
        }
      }
      return null;
    } finally {
      this.#replaying = false;
    }
  }
}
