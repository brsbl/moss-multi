// What the pane's plugin binds in Suggest and Review mode (docs/design/suggestions.md §5): the fork F behind a shim
// provider, its requests on the doc session's socket, and the read-only composite C. B, the session's doc, is never
// written in either mode.
import { $getNodeByKey, $isElementNode, type LexicalEditor, type LexicalNode, type SerializedEditorState, type SerializedLexicalNode } from 'lexical';
import { stateToMarkdown } from '@moss-multi/sync/converter';
import { Composite, reviewDoc, SHIM_BODY_APPLY, SHIM_RECORD_APPLY, SuggestFork, type ForkEvent } from '@moss-multi/sync/suggest/client';
import { readMeta } from '@moss-multi/sync/suggest/records';
import * as Y from 'yjs';
import { bindingOf } from '../binding-registry.ts';
import type { DocSession } from '../doc-session.ts';
import { ShimProvider } from './shim.ts';

type CollabLike = { _xmlText?: Y.XmlText };

function serialize(node: LexicalNode): SerializedLexicalNode {
  const json = node.exportJSON() as SerializedLexicalNode & { children?: SerializedLexicalNode[] };
  if ($isElementNode(node)) json.children = node.getChildren().map(serialize);
  return json;
}

/** The markdown of F's blocks, through the editor bound to F; their text if the converter refuses. */
function blocksMarkdown(editor: LexicalEditor | null, blocks: Y.XmlText[]): string[] {
  const binding = editor && bindingOf(editor);
  if (!editor || !binding) return blocks.map((block) => block.toString());
  const keys = new Map<Y.XmlText, string>();
  for (const [key, collab] of binding.collabNodeMap) {
    const text = (collab as unknown as CollabLike)._xmlText;
    if (text) keys.set(text, key);
  }
  return editor.read(() => blocks.map((block) => {
    const key = keys.get(block);
    const node = key ? $getNodeByKey(key) : null;
    if (!node) return '';
    try {
      const state = { root: { type: 'root', version: 1, children: [serialize(node)], direction: null, format: '', indent: 0 } } as unknown as SerializedEditorState;
      return stateToMarkdown(state).trim();
    } catch {
      return node.getTextContent();
    }
  }));
}

export interface SuggestHooks {
  ready(): void;
  refused(unsaved: string[]): void;
  rebuild(): void;
  closed(event: Extract<ForkEvent, { type: 'closed' }>): void;
  change(): void;
}

/** Suggest mode: F, written under the active lease and forwarded as suggest requests on the session's socket. */
export class SuggestMount {
  readonly fork: SuggestFork;
  readonly provider: ShimProvider;
  editor: LexicalEditor | null = null;
  /** `suggest-refused` replies this mount received. */
  refusals = 0;
  readonly #stops: (() => void)[] = [];
  #dropped = false;

  constructor(readonly session: DocSession, me: string, hooks: SuggestHooks) {
    this.fork = new SuggestFork(session.doc, {
      me,
      send: (request) => session.sendSuggest(request),
      exportBlocks: (blocks) => blocksMarkdown(this.editor, blocks),
    });
    this.provider = new ShimProvider(session.provider, () => this.#begin());
    this.#stops.push(session.onSuggestReply((reply) => {
      if (reply.t === 'suggest-refused') this.refusals += 1;
      this.fork.receive(reply);
      if (reply.t === 'suggest-refused') hooks.change();
    }));
    this.#stops.push(this.fork.on((event) => {
      if (event.type === 'ready') {
        this.provider.synced();
        hooks.ready();
      } else if (event.type === 'refused') hooks.refused(event.unsaved);
      else if (event.type === 'rebuild') hooks.rebuild();
      else if (event.type === 'closed') hooks.closed(event);
      else hooks.change();
    }));
    const onSync = (synced: boolean) => {
      if (synced) this.#begin();
    };
    const onClose = () => {
      this.#dropped = true;
    };
    const onStatus = ({ status }: { status: string }) => {
      if (status !== 'connected' || !this.#dropped) return;
      this.#dropped = false;
      // Requests the dropped socket never answered come back to the fork, which resumes its leases first.
      session.takeUnsentSuggest();
      this.fork.reconnected();
    };
    session.provider.on('sync', onSync);
    session.provider.on('connection-close', onClose);
    session.provider.on('status', onStatus);
    this.#stops.push(() => {
      session.provider.off('sync', onSync);
      session.provider.off('connection-close', onClose);
      session.provider.off('status', onStatus);
    });
  }

  get doc(): Y.Doc {
    return this.fork.doc;
  }

  /** Leases once the body has synced and the binding observes F. */
  #begin(): void {
    if (this.provider.connected && this.session.state.synced) this.fork.begin();
  }

  dispose(): void {
    for (const stop of this.#stops.splice(0)) stop();
    this.fork.dispose();
  }
}

/** Review mode: C bound read-only; a closed or broken record remounts it, and a C Lexical cannot bind falls back to B. */
export class ReviewMount {
  readonly doc = new Y.Doc();
  readonly provider: ShimProvider;
  readonly #composite: Composite;
  #filled = false;
  #valid: string[] = [];
  get valid(): readonly string[] {
    return this.#valid;
  }
  /** Each valid record's leased clients, and its delete parts' targets: what Review paints. */
  clients = new Map<number, string>();
  readonly #stops: (() => void)[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly session: DocSession, readonly fallback: boolean, readonly hooks: { remount(fallback: boolean): void; change(): void }) {
    this.#composite = new Composite(session.doc);
    this.provider = new ShimProvider(session.provider, () => this.#fill());
    const onSync = (synced: boolean) => {
      if (synced) this.#fill();
    };
    const onUpdate = () => {
      if (!this.#filled) return;
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => this.#refresh(), 150);
    };
    session.provider.on('sync', onSync);
    session.doc.on('update', onUpdate);
    this.#stops.push(() => {
      session.provider.off('sync', onSync);
      session.doc.off('update', onUpdate);
      clearTimeout(this.#timer);
    });
  }

  #fill(): void {
    if (this.#filled || !this.provider.connected || !this.session.state.synced) return;
    this.#filled = true;
    if (this.fallback) {
      Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(this.session.doc), SHIM_BODY_APPLY);
    } else {
      const used = reviewDoc(this.session.doc, this.#composite, (doc) => {
        Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(doc), SHIM_RECORD_APPLY);
      }, (built) => {
        this.#valid = built.valid;
        this.clients = built.clients;
      });
      // A partly filled C cannot be emptied in place: remount on a fresh doc filled from the body.
      if (used === 'body') {
        this.hooks.remount(true);
        return;
      }
    }
    this.provider.synced();
    this.hooks.change();
  }

  /** Body or record changes: new content lands in C in place; a record that left C remounts it. */
  #refresh(): void {
    if (this.fallback) {
      Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(this.session.doc, Y.encodeStateVector(this.doc)), SHIM_BODY_APPLY);
      this.hooks.change();
      return;
    }
    const built = this.#composite.build();
    try {
      const gone = this.#valid.some((id) => !built.valid.includes(id) && readMeta(this.session.doc, id)?.status !== 'accepted');
      if (gone) {
        this.hooks.remount(false);
        return;
      }
      try {
        Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(built.doc, Y.encodeStateVector(this.doc)), SHIM_RECORD_APPLY);
      } catch {
        this.hooks.remount(true);
        return;
      }
      this.#valid = built.valid;
      this.clients = built.clients;
      this.hooks.change();
    } finally {
      built.doc.destroy();
    }
  }

  dispose(): void {
    for (const stop of this.#stops.splice(0)) stop();
    this.doc.destroy();
  }
}
