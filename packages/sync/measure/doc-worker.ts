// T1.F2 bounded-work measurement Worker (A§10.10): the real DocDO in workerd, driven by scripts/measure-converter.mjs
// over real sockets. Test-only: it sets the trusted principal headers itself from the query string.
import { createBinding, syncYjsChangesToLexical, type Provider } from '@lexical/yjs';
import { getServerByName, routePartykitRequest } from 'partyserver';
import * as Y from 'yjs';
import { encodePartyPrincipal, isDocCapError, TRUSTED } from '@moss-multi/protocol/sync';
import { DocDO } from '../src/doc-do.ts';
import type { PayloadWork } from '../src/payloads.ts';
import { phases } from '../src/server-doc.ts';
import { textHash } from './text-hash.ts';
import { createConverterEditor } from '../src/converter/index.ts';
import { excludedPropertiesFor } from '../src/excluded-properties.ts';
import { breakdown, rebuildBody, samples, SHAPE_NAMES, syntheticDoc, type Defaults, type Rebuild } from './struct-breakdown.ts';
import { linearImportStats } from '@moss-desktop/renderer/editor/markdown/linear-import';

/** A full GC, when workerd runs with `--expose-gc` (scripts/measure-memory.mjs); `--trace-gc` prints it as `testing`. */
const collect = (globalThis as { gc?: () => void }).gc;
const tracedPhases: string[] = [];

const noop = () => {};
const provider = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop,
  disconnect: noop,
  on: noop,
  off: noop,
} as unknown as Provider;

/** The bodies scripts/measure-memory.mjs rebuilds beside the note, by name. */
const VARIANTS: Record<string, Rebuild> = {
  'as written': {},
  'as written, decoded with exact-size arrays': { exactArrays: true },
  'as written, decoded with exact-size arrays and shared keys': { exactArrays: true, sharedKeys: true },
  'defaults left out': { dropDefaults: true },
  'defaults left out, decoded with exact-size arrays and shared keys': { dropDefaults: true, exactArrays: true, sharedKeys: true },
  'defaults and text __type left out': { dropDefaults: true, dropTextType: true },
  'text runs as formatted strings': { dropDefaults: true, textAsFormat: true },
};

let defaultsCache: Defaults | null = null;
/** Each node type's defaults, from a binding of the converter editor (what the DocDO's mirror binds). */
function nodeDefaults(): Defaults {
  if (defaultsCache) return defaultsCache;
  const editor = createConverterEditor();
  const doc = new Y.Doc();
  const binding = createBinding(editor, provider, 'root', doc, new Map([['root', doc]]), excludedPropertiesFor(editor));
  defaultsCache = binding.nodeProperties as Defaults;
  doc.destroy();
  return defaultsCache;
}

/** The editor state a converter editor bound to a doc of `state` hydrates to, through the unmodified binding. */
function hydratedState(state: Uint8Array): string {
  const doc = new Y.Doc();
  const editor = createConverterEditor();
  const binding = createBinding(editor, provider, 'root', doc, new Map([['root', doc]]), excludedPropertiesFor(editor));
  const root = binding.root.getSharedType();
  const observer: Parameters<Y.XmlText['observeDeep']>[0] = (events, transaction) => {
    if (transaction.origin !== binding) syncYjsChangesToLexical(binding, provider, events as never, false, noop);
  };
  root.observeDeep(observer);
  try {
    Y.applyUpdate(doc, state);
    editor.update(noop, { discrete: true, skipTransforms: true });
    return JSON.stringify(editor.getEditorState().toJSON());
  } finally {
    root.unobserveDeep(observer);
    doc.destroy();
  }
}

/** Where two serialized states first differ, with some context, or null when they are equal. */
function firstDifference(a: string, b: string): string | null {
  if (a === b) return null;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return `at char ${i}: ${JSON.stringify(a.slice(Math.max(0, i - 60), i + 60))} vs ${JSON.stringify(b.slice(Math.max(0, i - 60), i + 60))}`;
}

const kindsOf = (doc: Y.Doc) => {
  const { structs, kinds } = breakdown(doc, nodeDefaults());
  return { structs, kinds };
};

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
   * among the copy's items. Returns the copy's struct count.
   */
  holdCopy(on: boolean, intern = false): number {
    this.#held?.destroy();
    this.#held = null;
    if (!on) return 0;
    this.#held = new Y.Doc();
    Y.applyUpdate(this.#held, Y.encodeStateAsUpdate(this.document));
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

  /** The note's structs by kind and its map entries by owner, plus the exact structs of one node of each type. */
  structBreakdown(): { breakdown: ReturnType<typeof breakdown>; samples: ReturnType<typeof samples> } {
    return { breakdown: breakdown(this.document, nodeDefaults()), samples: samples(this.document, nodeDefaults()) };
  }

  #rebuilt: Y.Doc | null = null;

  /** Holds the note's body rebuilt as `variant` (VARIANTS) beside the note, or releases it. Returns its struct kinds. */
  holdRebuilt(variant: string | null): { structs: number; kinds: Record<string, number> } {
    this.#rebuilt?.destroy();
    this.#rebuilt = null;
    if (variant === null) return { structs: 0, kinds: {} };
    const options = VARIANTS[variant];
    if (!options) throw new Error(`no variant ${variant}`);
    this.#rebuilt = rebuildBody(this.document, nodeDefaults(), options);
    return kindsOf(this.#rebuilt);
  }

  /** Whether the unmodified binding hydrates the body rebuilt as `variant` to the note's own editor state. */
  verifyRebuilt(variant: string): { same: boolean; chars: number; difference: string | null; error: string | null } {
    const options = VARIANTS[variant];
    if (!options) throw new Error(`no variant ${variant}`);
    // Compacting after decoding leaves the encoding as it was: its body reads as its uncompacted variant's does.
    const rebuilt = rebuildBody(this.document, nodeDefaults(), { ...options, exactArrays: false, sharedKeys: false });
    const state = Y.encodeStateAsUpdate(rebuilt);
    rebuilt.destroy();
    let read: string;
    try {
      read = hydratedState(state);
    } catch (error) {
      return { same: false, chars: 0, difference: null, error: String((error as Error).message).split('\n')[0].slice(0, 200) };
    }
    const own = hydratedState(Y.encodeStateAsUpdate(this.document));
    const difference = firstDifference(own, read);
    return { same: difference === null, chars: own.length, difference, error: null };
  }

  #synthetic: Y.Doc | null = null;

  /** Holds `n` synthetic blocks of `shape` (struct-breakdown.ts SHAPES), or releases them. Returns their struct kinds. */
  holdSynthetic(shape: string | null, n: number): { structs: number; kinds: Record<string, number> } {
    this.#synthetic?.destroy();
    this.#synthetic = null;
    if (shape === null) return { structs: 0, kinds: {} };
    this.#synthetic = syntheticDoc(shape, n);
    return kindsOf(this.#synthetic);
  }

  /** The note's encoded state size. */
  stateBytes(): number {
    return Y.encodeStateAsUpdate(this.document).byteLength;
  }
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
      const structs = await (await getServerByName(env.DocDO, docId)).holdCopy(url.searchParams.get('on') === '1', url.searchParams.has('intern'));
      return Response.json({ structs });
    }
    if (url.pathname === '/variants') return Response.json({ variants: Object.keys(VARIANTS), shapes: SHAPE_NAMES });
    if (url.pathname === '/breakdown') {
      return Response.json(await (await getServerByName(env.DocDO, docId)).structBreakdown());
    }
    if (url.pathname === '/hold-rebuilt') {
      return Response.json(await (await getServerByName(env.DocDO, docId)).holdRebuilt(url.searchParams.get('variant')));
    }
    if (url.pathname === '/verify-rebuilt') {
      return Response.json(await (await getServerByName(env.DocDO, docId)).verifyRebuilt(url.searchParams.get('variant') ?? ''));
    }
    if (url.pathname === '/hold-synthetic') {
      const stub = await getServerByName(env.DocDO, docId);
      return Response.json(await stub.holdSynthetic(url.searchParams.get('shape'), Number(url.searchParams.get('n') ?? 0)));
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
