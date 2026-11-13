// T1.F2 bounded-work measurement Worker (A§10.10): the real DocDO in workerd, driven by scripts/measure-converter.mjs
// over real sockets. Test-only: it sets the trusted principal headers itself from the query string.
import { $getRoot, $isElementNode, $parseSerializedNode, type LexicalNode, type SerializedLexicalNode } from 'lexical';
import { getServerByName, routePartykitRequest } from 'partyserver';
import * as Y from 'yjs';
import { docLimitOf, encodePartyPrincipal, isDocCapError, TRUSTED } from '@moss-multi/protocol/sync';
import { DocDO } from '../src/doc-do.ts';
import { structCount } from '../src/note-size.ts';
import type { PayloadWork } from '../src/payloads.ts';
import { importBody, phases, serverWrite } from '../src/server-doc.ts';
import { structsPerBlock, type StructsPerBlock } from './structs-per-block.ts';
import { textHash } from './text-hash.ts';
import { IMPORT_BUDGET_SPENT, linearImportStats } from '@moss-desktop/renderer/editor/markdown/linear-import';

/** A full GC, when workerd runs with `--expose-gc` (scripts/measure-memory.mjs); `--trace-gc` prints it as `testing`. */
const collect = (globalThis as { gc?: () => void }).gc;
const tracedPhases: string[] = [];

/** The characters a save probe writes into the note's body (the one the first character is not), which the search entry it feeds must hold. */
const SAVE_MARKS = ['\u2042', '\u2051'];

/** What a save fed search: the entry's doc, body length, and which SAVE_MARKS its body holds. */
interface Fed {
  docId: string;
  bodyChars: number;
  marks: string[];
}
const fedTo = new Map<string, Fed>();

/** The first run of the body's text, inside nested elements (a table's cells), never in a payload. */
function firstRun(type: Y.AbstractType<unknown>, depth = 0): Y.Item | null {
  for (let item = type._start; item; item = item.right) {
    if (item.deleted) continue;
    if (item.content instanceof Y.ContentString && item.length > 0) return item;
    if (depth < 8 && item.content instanceof Y.ContentType && item.content.type instanceof Y.XmlText) {
      const run = firstRun(item.content.type, depth + 1);
      if (run) return run;
    }
  }
  return null;
}

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

  /** Holds a plain Y.Doc of the note's state beside the note, or releases it. Returns the copy's struct count. */
  holdCopy(on: boolean): number {
    this.#held?.destroy();
    this.#held = null;
    if (!on) return 0;
    this.#held = new Y.Doc();
    Y.applyUpdate(this.#held, Y.encodeStateAsUpdate(this.document));
    let count = 0;
    for (const structs of this.#held.store.clients.values()) count += structs.length;
    return count;
  }

  /** The note's structs per block, counted in place (T3.B31b). */
  structsPerBlock(): StructsPerBlock {
    return structsPerBlock(this.document);
  }

  /** What the note's last save fed search (`fed`), for the harness to check. */
  fed(): Fed | null {
    return fedTo.get(this.name) ?? null;
  }

  /**
   * A save of the whole note, as the debounced save runs it after an edit: one edit of the body's first character to a
   * SAVE_MARKS character it is not (the text keeps its length), then the compaction and the search feed of the edited
   * note. Throws unless search received it.
   */
  async saveNow(): Promise<number> {
    await this.noteSize();
    fedTo.delete(this.name);
    const run = firstRun(this.document.get('root', Y.XmlText));
    if (!run) throw new Error('the note holds no text to edit');
    const mark = (run.content as Y.ContentString).str.startsWith(SAVE_MARKS[0]) ? SAVE_MARKS[1] : SAVE_MARKS[0];
    const parent = run.parent as Y.XmlText;
    let offset = 0;
    for (let item = parent._start; item && item !== run; item = item.right) if (!item.deleted && item.countable) offset += item.length;
    this.document.transact(() => {
      parent.delete(offset, 1);
      parent.insert(offset, mark);
    }, 'measure-save');
    await this.onSave();
    const fed = fedTo.get(this.name);
    if (!fed?.marks.includes(mark)) throw new Error(`the save fed search ${fed ? 'the note without its edit' : 'nothing'}`);
    return structCount(this.document);
  }

  /** The note's encoded state size. */
  stateBytes(): number {
    return Y.encodeStateAsUpdate(this.document).byteLength;
  }

  /**
   * Appends rows to the note's last table, copying its last row with fresh text, until the next batch would
   * take the note's structs past `target`: a table grown by edits past what an import accepts. Each batch is a server
   * write through the same binding as an editor's. Returns the structs at the end.
   */
  async growTable(target: number): Promise<number> {
    await this.noteSize();
    const serialize = (node: LexicalNode): SerializedLexicalNode => {
      const json = node.exportJSON() as SerializedLexicalNode & { children?: SerializedLexicalNode[]; text?: string };
      if ($isElementNode(node)) json.children = node.getChildren().map(serialize);
      return json;
    };
    const retext = (json: SerializedLexicalNode & { children?: SerializedLexicalNode[]; text?: string }, row: number, cell = { at: 0 }): void => {
      if (typeof json.text === 'string') json.text = cell.at++ === 0 ? `row ${row}` : `value ${row}`;
      for (const child of json.children ?? []) retext(child, row, cell);
    };
    let rows = 0;
    for (let perRow = 16; ; ) {
      const before = (await this.noteSize()).structs;
      const batch = Math.min(1_000, Math.floor((target - before) / perRow) - 1);
      if (batch < 1) return before;
      serverWrite(this.document, 'measure-grow', () => {
        let table = $getRoot().getLastChild();
        while (table && table.getType() !== 'table') table = table.getPreviousSibling();
        if (!$isElementNode(table)) throw new Error('the note holds no table');
        const last = table.getLastChild();
        if (!last) throw new Error('the table has no rows');
        const json = serialize(last);
        for (let i = 0; i < batch; i += 1) {
          const copy = structuredClone(json);
          retext(copy, 100_000 + rows + i);
          table.append($parseSerializedNode(copy));
        }
      });
      rows += batch;
      perRow = Math.max(1, ((await this.noteSize()).structs - before) / batch);
    }
  }

  /**
   * `total` small edits at random places in the body's text, as typing corrections are: an insert or a delete of one to
   * three characters, each its own transaction, a new session (client id) every 50. Returns the note's structs after
   * every `every` edits.
   */
  async scatterEdits(total: number, every: number): Promise<number[]> {
    await this.noteSize();
    const doc = this.document;
    const root = doc.get('root', Y.XmlText);
    let seed = 12_345;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    const inBody = (type: unknown): boolean => {
      for (let at = type as Y.AbstractType<unknown> | null; at; at = (at._item?.parent as Y.AbstractType<unknown> | undefined) ?? null) if (at === (root as unknown)) return true;
      return false;
    };
    let runs: Y.Item[] = [];
    const counts: number[] = [];
    for (let edit = 0; edit < total; edit += 1) {
      if (edit % 500 === 0) {
        runs = [];
        for (const structs of doc.store.clients.values()) {
          for (const struct of structs) if (struct instanceof Y.Item && !struct.deleted && struct.content instanceof Y.ContentString && inBody(struct.parent)) runs.push(struct);
        }
      }
      if (edit % 50 === 0) doc.clientID = 1 + Math.floor(random() * 2_000_000_000);
      let run = runs[Math.floor(random() * runs.length)];
      for (let tries = 0; run.deleted && tries < 20; tries += 1) run = runs[Math.floor(random() * runs.length)];
      if (run.deleted) continue;
      const mark = (run.content as Y.ContentString).str.startsWith(SAVE_MARKS[0]) ? SAVE_MARKS[1] : SAVE_MARKS[0];
    const parent = run.parent as Y.XmlText;
      let offset = 0;
      for (let item = parent._start; item && item !== run; item = item.right) if (!item.deleted && item.countable) offset += item.length;
      const at = Math.floor(random() * (run.length + 1));
      const length = 1 + Math.floor(random() * 3);
      doc.transact(() => {
        if (random() < 0.6 || run.length - at < length) parent.insert(offset + at, 'xyz'.slice(0, length));
        else parent.delete(offset + at, length);
      }, 'measure-edits');
      if ((edit + 1) % every === 0) counts.push(structCount(doc));
    }
    return counts;
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
      const structs = await (await getServerByName(env.DocDO, docId)).holdCopy(url.searchParams.get('on') === '1');
      return Response.json({ structs });
    }
    if (url.pathname === '/wake') {
      // Addressing the DocDO starts it, which loads its stored note (onLoad): the wake alone.
      await getServerByName(env.DocDO, docId);
      return new Response('ok');
    }
    if (url.pathname === '/fed') {
      return Response.json(await (await getServerByName(env.DocDO, docId)).fed());
    }
    if (url.pathname === '/save') {
      return Response.json({ structs: await (await getServerByName(env.DocDO, docId)).saveNow() });
    }
    if (url.pathname === '/structs') {
      return Response.json(await (await getServerByName(env.DocDO, docId)).structsPerBlock());
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
          if (isDocCapError(error)) return Response.json({ error: 'doc-cap', limit: docLimitOf(error) }, { status: 413 });
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
    if (url.pathname === '/size') {
      return Response.json(await (await getServerByName(env.DocDO, docId)).noteSize());
    }
    if (url.pathname === '/grow-table') {
      const structs = await (await getServerByName(env.DocDO, docId)).growTable(Number(url.searchParams.get('structs')));
      return Response.json({ structs });
    }
    if (url.pathname === '/scatter') {
      const stub = await getServerByName(env.DocDO, docId);
      return Response.json(await stub.scatterEdits(Number(url.searchParams.get('edits')), Number(url.searchParams.get('every'))));
    }
    if (url.pathname === '/import-fits') {
      // Whether the converter's work budget takes the markdown, on a throwaway doc outside any DocDO.
      const doc = new Y.Doc();
      try {
        importBody(doc, await request.text());
        return Response.json({ fits: true });
      } catch (error) {
        if (error instanceof Error && error.message === IMPORT_BUDGET_SPENT) return Response.json({ fits: false });
        throw error;
      } finally {
        doc.destroy();
      }
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
