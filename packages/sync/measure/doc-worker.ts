// T1.F2 bounded-work measurement Worker (A§10.10): the real DocDO in workerd, driven by scripts/measure-converter.mjs
// over real sockets. Test-only: it sets the trusted principal headers itself from the query string.
import { getServerByName, routePartykitRequest } from 'partyserver';
import * as Y from 'yjs';
import { encodePartyPrincipal, isDocCapError, TRUSTED } from '@moss-multi/protocol/sync';
import { DocDO } from '../src/doc-do.ts';
import type { PayloadWork } from '../src/payloads.ts';
import { phases } from '../src/server-doc.ts';
import { textHash } from './text-hash.ts';
import { linearImportStats } from '@moss-desktop/renderer/editor/markdown/linear-import';

/** A full GC, when workerd runs with `--expose-gc` (scripts/measure-memory.mjs); `--trace-gc` prints it as `testing`. */
const collect = (globalThis as { gc?: () => void }).gc;
const tracedPhases: string[] = [];

/** The DocDO, plus a method that reports its payload work (a getter is not an RPC method). */
export class MeasuredDocDO extends DocDO {
  work(): PayloadWork {
    return { ...this.payloadWork };
  }

  #held: Y.Doc | null = null;

  /** Collects garbage at each server write's and export's phase (`phases.mark`), recording the phases in order. */
  tracePhases(on: boolean): string[] {
    const seen = tracedPhases.splice(0);
    phases.mark = on && collect ? (phase) => {
      tracedPhases.push(phase);
      collect();
      collect();
    } : null;
    return seen;
  }

  /**
   * Holds a plain Y.Doc of the note's state beside the note, or releases it. `intern` shares each map key's string
   * among the copy's items. `shape` `rebuilt` copies the body item by item instead, and `untyped` does so without each
   * paragraph's and text run's `__type` (MEM.lean: what implicit types would save). Returns the copy's struct count.
   */
  holdCopy(on: boolean, intern = false, shape: 'state' | 'rebuilt' | 'untyped' = 'state'): number {
    this.#held?.destroy();
    this.#held = null;
    if (!on) return 0;
    if (shape === 'state') {
      this.#held = new Y.Doc();
      Y.applyUpdate(this.#held, Y.encodeStateAsUpdate(this.document));
    } else {
      this.#held = rebuilt(this.document, shape === 'untyped');
    }
    const keys = new Map<string, string>();
    let count = 0;
    for (const structs of this.#held.store.clients.values()) {
      count += structs.length;
      if (!intern) continue;
      for (const struct of structs) {
        if (!(struct instanceof Y.Item) || struct.parentSub === null) continue;
        const key = keys.get(struct.parentSub);
        if (key === undefined) keys.set(struct.parentSub, struct.parentSub);
        else struct.parentSub = key;
      }
    }
    return count;
  }

  /** The note's encoded state size. */
  stateBytes(): number {
    return Y.encodeStateAsUpdate(this.document).byteLength;
  }

  /**
   * The stored layout every binding created after this call writes and reads (the @lexical/yjs patch's LEAN_LAYOUT):
   * `v1` is the layout before it, so one run measures both.
   */
  useLayout(layout: string): string {
    setLayout(layout);
    return (globalThis as LayoutGlobal).__MOSS_YJS_LAYOUT ?? 'lean';
  }
}

interface LayoutGlobal {
  __MOSS_YJS_LAYOUT?: string;
}

function setLayout(layout: string): void {
  const global = globalThis as LayoutGlobal;
  if (layout === 'v1') global.__MOSS_YJS_LAYOUT = 'v1';
  else delete global.__MOSS_YJS_LAYOUT;
}

type Delta = { insert: unknown; attributes?: Record<string, unknown> }[];
const copyOf = (value: unknown): unknown => (value !== null && typeof value === 'object' ? structuredClone(value) : value);

/**
 * `source`'s body rebuilt item by item in one transaction. With `untyped`, a paragraph's and a text run's `__type`
 * are left out, as a layout that read a missing type as those two would store them. Nested Y.Maps (node state) are
 * copied; other nested types are skipped (the measured notes hold none).
 */
function rebuilt(source: Y.Doc, untyped: boolean): Y.Doc {
  const doc = new Y.Doc();
  const implicit = (key: string, value: unknown) => untyped && key === '__type' && (value === 'paragraph' || value === 'text');
  const fillMap = (from: Y.Map<unknown>, to: Y.Map<unknown>) => {
    for (const [key, value] of from.entries()) {
      if (implicit(key, value)) continue;
      if (value instanceof Y.Map) fillMap(value, to.set(key, new Y.Map()));
      else if (!(value instanceof Y.AbstractType) && !(value instanceof Y.Doc)) to.set(key, copyOf(value));
    }
  };
  // Both kinds keep attributes in their own map; one signature serves both.
  const fillAttributes = (from: Y.XmlText | Y.XmlElement, to: Y.XmlText | Y.XmlElement) => {
    const set = (key: string, value: unknown) => (to as Y.XmlText).setAttribute(key, value);
    for (const [key, value] of Object.entries((from as Y.XmlText).getAttributes() as Record<string, unknown>)) {
      if (implicit(key, value)) continue;
      if (value instanceof Y.Map) {
        const map = new Y.Map<unknown>();
        set(key, map);
        fillMap(value, map);
      } else if (!(value instanceof Y.AbstractType) && !(value instanceof Y.Doc)) set(key, copyOf(value));
    }
  };
  const fillText = (from: Y.XmlText, to: Y.XmlText) => {
    fillAttributes(from, to);
    let index = 0;
    for (const op of from.toDelta() as Delta) {
      if (typeof op.insert === 'string') {
        to.insert(index, op.insert, op.attributes ?? {});
        index += op.insert.length;
        continue;
      }
      const child = op.insert;
      if (child instanceof Y.XmlText) {
        const copy = new Y.XmlText();
        to.insertEmbed(index, copy, op.attributes ?? {});
        fillText(child, copy);
      } else if (child instanceof Y.Map) {
        const copy = new Y.Map<unknown>();
        to.insertEmbed(index, copy, op.attributes ?? {});
        fillMap(child as Y.Map<unknown>, copy);
      } else if (child instanceof Y.XmlElement) {
        const copy = new Y.XmlElement(child.nodeName);
        to.insertEmbed(index, copy, op.attributes ?? {});
        fillAttributes(child, copy);
      } else {
        to.insertEmbed(index, copyOf(child) as object, op.attributes ?? {});
      }
      index += 1;
    }
  };
  doc.transact(() => fillText(source.get('root', Y.XmlText), doc.get('root', Y.XmlText)));
  return doc;
}



interface Env {
  DocDO: DurableObjectNamespace<MeasuredDocDO>;
}

/** The payload ids a note's top-level blocks name. */
function namedIds(state: Uint8Array): string[] {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return (doc.get('root', Y.XmlText).toDelta() as { insert: unknown }[])
      .map((op) => (op.insert instanceof Y.XmlElement ? op.insert.getAttribute('__regId') : undefined))
      .filter((id): id is string => typeof id === 'string');
  } finally {
    doc.destroy();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ping') return new Response('ok');
    const docId = url.searchParams.get('doc') ?? '';
    if (url.pathname === '/gc') {
      if (!collect) return new Response('gc is not exposed', { status: 501 });
      collect();
      collect();
      return new Response('ok');
    }
    if (url.pathname === '/phases') {
      return Response.json(await (await getServerByName(env.DocDO, docId)).tracePhases(url.searchParams.get('on') === '1'));
    }
    if (url.pathname === '/hold-copy') {
      const shape = url.searchParams.get('shape');
      const structs = await (await getServerByName(env.DocDO, docId)).holdCopy(url.searchParams.get('on') === '1', url.searchParams.has('intern'), shape === 'rebuilt' || shape === 'untyped' ? shape : 'state');
      return Response.json({ structs });
    }
    if (url.pathname === '/layout') {
      const layout = url.searchParams.get('name') ?? 'lean';
      setLayout(layout);
      return Response.json({ layout: await (await getServerByName(env.DocDO, docId)).useLayout(layout) });
    }
    if (url.pathname === '/state-bytes') {
      return Response.json({ stateBytes: await (await getServerByName(env.DocDO, docId)).stateBytes() });
    }
    if (url.pathname === '/create') {
      // The body is the note's markdown. A doc-cap refusal is a 413, as POST /api/docs answers it.
      const stub = await getServerByName(env.DocDO, docId);
      if (url.searchParams.has('lean')) {
        // Only the create, so its heap is the create's own (scripts/measure-memory.mjs).
        try {
          await stub.create({ folderId: 'measure', ownerId: 'measure-owner', markdown: await request.text() });
        } catch (error) {
          if (isDocCapError(error)) return Response.json({ error: 'doc-cap' }, { status: 413 });
          throw error;
        }
        return new Response('ok');
      }
      const work = linearImportStats.spent;
      try {
        await stub.create({ folderId: 'measure', ownerId: 'measure-owner', markdown: await request.text() });
      } catch (error) {
        if (isDocCapError(error)) return Response.json({ error: 'doc-cap', work: linearImportStats.spent - work }, { status: 413 });
        throw error;
      }
      const { state } = await stub.snapshotForDuplicate();
      return Response.json({ ids: namedIds(state), work: linearImportStats.spent - work, stateBytes: state.byteLength });
    }
    if (url.pathname === '/export') {
      const markdown = await (await getServerByName(env.DocDO, docId)).exportMarkdown();
      if (url.searchParams.has('lean')) return Response.json({ length: markdown.length });
      return Response.json({ bytes: new TextEncoder().encode(markdown).byteLength, hash: textHash(markdown) });
    }
    if (url.pathname === '/work') {
      const stub = await getServerByName(env.DocDO, docId);
      return Response.json(await stub.work());
    }
    if (url.pathname.startsWith('/parties/')) {
      const forwarded = new Request(request);
      const principal = url.searchParams.get('principal') ?? 'measure';
      forwarded.headers.set(TRUSTED.principal, encodePartyPrincipal({ id: principal, kind: 'user', name: principal }));
      forwarded.headers.set(TRUSTED.role, 'editor');
      forwarded.headers.set(TRUSTED.session, `session-${principal}`);
      return (await routePartykitRequest(forwarded, env as never)) ?? new Response('not found', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  },
};
