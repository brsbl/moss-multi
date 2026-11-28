// @vitest-environment jsdom
// T5.B3 (B283, B287): Edit-mode marks never throw on a stored BigInt and see a `__proto__` attribute; strike membership
// (the fork's isStruck and the paint over a binding) grows near-linearly as characters and strike spans double, and
// what paints follows a withdrawn part.
import { SUGGEST_MARK_ATTR, SUGGESTION_ID_ATTR } from '@moss-multi/protocol/dom-contract';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import type { IdSpan, SuggestReply, SuggestRequest } from '@moss-multi/protocol/suggest';
import { $createParagraphNode, $createTextNode, $getRoot, createEditor, type LexicalEditor } from 'lexical';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MARKDOWN_EDITOR_NODES } from '../../../../../../packages/sync/src/converter/index.ts';
import { handleSuggest, SuggestIngest } from '../../../../../../packages/sync/src/doc/suggest.ts';
import { payloadDocsFor } from '../../../../../../packages/sync/src/payload-docs.ts';
import { Composite, destroyView, spanWork, SuggestFork } from '../../../../../../packages/sync/src/suggest/client.ts';
import { bindEditor } from '../../../../../../packages/sync/src/suggest/fork-shim.ts';
import { closeRecord, createRecord, opsOf, partsOf, patchMeta, writeSuggestions } from '../../../../../../packages/sync/src/suggest/records.ts';
import { nodeRegistry } from '../../../../../../packages/sync/src/suggest/review.ts';
import { deterministicIds, forgeRecord, opOn, OTHER_SUGGESTER, seededBody, SUGGESTER, textNode } from '../../../../../../packages/sync/src/suggest/test-support.ts';
import { textIds } from './chars.ts';
import { clearPaint, drawMarks, editMarks, paintBound } from './paint.ts';

let restore: () => void = () => {};
beforeEach(() => {
  restore = deterministicIds();
});
afterEach(() => restore());

/** A fork of `live` for `who`, bound to a moss editor (rendering into a root element with `dom`), every request answered. */
function forkOf(live: Y.Doc, who: { id: string; name: string } = SUGGESTER, dom = false) {
  const ingest = new SuggestIngest(live, { stateCap: STATE_CAP_BYTES, registry: nodeRegistry() });
  const outbox: SuggestRequest[] = [];
  const fork = new SuggestFork(live, { me: who.id, name: who.name, send: (request) => outbox.push(request), now: () => 1_000 });
  let editor: LexicalEditor | undefined;
  let root: HTMLElement | null = null;
  if (dom) {
    root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
    editor = createEditor({ namespace: 'paint-test', nodes: MARKDOWN_EDITOR_NODES, onError: (error) => { throw error; } });
    editor.setRootElement(root);
  }
  const bound = bindEditor(fork.doc, editor);
  const deliver = () => {
    while (outbox.length) fork.receive(handleSuggest(ingest, { ...who, role: 'suggester', connection: 'paint' }, outbox.shift()!) as SuggestReply);
  };
  fork.begin();
  deliver();
  bound.editor.update(() => {}, { discrete: true });
  return {
    fork,
    ...bound,
    dispose: () => {
      bound.dispose();
      fork.dispose();
      root?.remove();
    },
  };
}

const root = (doc: Y.Doc) => doc.get('root', Y.XmlText);
const blocks = (doc: Y.Doc) => (root(doc).toDelta() as { insert: unknown }[]).map((op) => op.insert);
const paragraph = (doc: Y.Doc) => blocks(doc).find((x) => x instanceof Y.XmlText) as Y.XmlText;
const decorator = (doc: Y.Doc) => blocks(doc).find((x) => x instanceof Y.XmlElement && x.getAttribute('__type') === 'code-block') as Y.XmlElement;
const codeKey = (doc: Y.Doc) => String(decorator(doc).getAttribute('__regId'));

describe('T5.B3 Edit-mode marks over stored values JSON cannot hold (B283) @p:mean-2 @p:R17', () => {
  /** The marks an editor sees for one forged record `g` holding `op`, read over a binding of B. */
  function marksFor(live: Y.Doc, op: ReturnType<typeof opOn>) {
    forgeRecord(live, 'g', [op]);
    const built = new Composite(live).build();
    // Another suggester's fork holds B as it is: none of the record's ops are its own.
    const view = forkOf(live, OTHER_SUGGESTER);
    try {
      expect(built.valid, 'the record is valid and open').toEqual(['g']);
      let marks: ReturnType<typeof editMarks> = [];
      expect(() => {
        marks = editMarks(live, built, view.binding);
      }).not.toThrow();
      return marks;
    } finally {
      view.dispose();
      destroyView(built);
    }
  }

  it.each([10n, 11n])('a payload map field set to the BigInt %s: the code block gets its wedge, the preview naming the value', (value) => {
    const live = seededBody();
    const key = codeKey(live);
    const marks = marksFor(live, opOn(payloadDocsFor(live).get(key)!, key, (doc) => doc.getMap('payload-map').set('forged', value as never)));
    const wedge = marks.filter((mark) => mark.kind === 'insert' && mark.record === 'g');
    expect(wedge, 'one wedge, at the code block').toHaveLength(1);
    expect(wedge[0]!.place.offset).toBe(-1);
    expect(wedge[0]!.text).toContain('forged');
    expect(wedge[0]!.text).toContain(String(value));
  });

  it.each([
    ['a BigInt', '__forged', 10n],
    ['a field named __proto__', '__proto__', 'forged-value'],
    ['a BigInt named __proto__', '__proto__', 12n],
  ] as const)('a block attribute changed to %s: the block gets its dot, for that record', (_what, name, value) => {
    const live = seededBody();
    const marks = marksFor(live, opOn(live, 'body', (doc) => paragraph(doc).setAttribute(name, value as never)));
    const dots = marks.filter((mark) => mark.kind === 'attribute');
    expect(dots, 'the changed block is marked').toHaveLength(1);
    expect(dots[0]!.record).toBe('g');
    expect(dots[0]!.place.offset).toBe(-1);
  });

  it('a BigInt attribute a record leaves as it is marks nothing', () => {
    const live = seededBody();
    Y.transact(live, () => paragraph(live).setAttribute('__forged', 10n as never));
    const key = codeKey(live);
    const marks = marksFor(live, opOn(payloadDocsFor(live).get(key)!, key, (doc) => doc.getText('payload').insert(0, 'x')));
    expect(marks.filter((mark) => mark.kind === 'attribute')).toEqual([]);
  });
});

describe('T5.B3 strike membership cost (B287) @p:mean-2 @p:R17', () => {
  let highlights: Map<string, Set<Range>>;
  const saved: Record<string, unknown> = {};
  beforeEach(() => {
    highlights = new Map();
    const g = globalThis as Record<string, unknown>;
    saved.CSS = g.CSS;
    saved.Highlight = g.Highlight;
    g.CSS = { highlights };
    g.Highlight = class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    };
  });
  afterEach(() => {
    const g = globalThis as Record<string, unknown>;
    g.CSS = saved.CSS;
    g.Highlight = saved.Highlight;
  });

  /** A note of `chars` characters with every other one struck: `chars / 2` single-character spans in parts of 1000. */
  function struckNote(chars: number) {
    const live = seededBody('ab'.repeat(chars / 2));
    const view = forkOf(live, SUGGESTER, true);
    let ids: Y.ID[] = [];
    view.editor.getEditorState().read(() => {
      for (const key of view.binding.collabNodeMap.keys()) {
        const found = textIds(view.binding, key);
        if (found && found.length > ids.length) ids = found;
      }
    });
    expect(ids).toHaveLength(chars);
    const spans: IdSpan[] = ids.filter((_, i) => i % 2 === 0).map((id) => ({ client: id.client, clock: id.clock, len: 1 }));
    const parts: string[] = [];
    for (let at = 0; at < spans.length; at += 1000) parts.push(view.fork.proposeDelete(spans.slice(at, at + 1000))!);
    expect(parts.every(Boolean), 'every part is proposed').toBe(true);
    return { ...view, ids, spans, parts };
  }

  const painted = () => [...(highlights.get('suggest-delete') ?? [])];

  it('isStruck and the strike paint grow near-linearly as characters and spans each double', () => {
    const cost = (chars: number) => {
      const note = struckNote(chars);
      const owner = {};
      try {
        spanWork.steps = 0;
        for (const id of note.ids) note.fork.isStruck(id);
        const struck = spanWork.steps;
        spanWork.steps = 0;
        paintBound(owner, note.editor, note.binding, note.fork.ownClients(), note.fork.struck(), note.fork.body);
        const paint = spanWork.steps;
        expect(painted(), 'every struck character paints').toHaveLength(chars / 2);
        return { struck, paint };
      } finally {
        clearPaint(owner);
        note.dispose();
      }
    };
    const small = cost(4_000);
    const large = cost(8_000);
    expect(large.struck / small.struck, `isStruck: ${small.struck} then ${large.struck} comparisons`).toBeLessThan(3);
    expect(large.paint / small.paint, `paint: ${small.paint} then ${large.paint} comparisons`).toBeLessThan(3);
    // Near-linear in absolute terms too: a few comparisons per character, not one per span.
    expect(large.struck / 8_000).toBeLessThan(40);
  });

  it('a withdrawn part stops painting and reads unstruck; the other parts keep painting exactly their characters', () => {
    const note = struckNote(4_000);
    const owner = {};
    try {
      const paint = () => paintBound(owner, note.editor, note.binding, note.fork.ownClients(), note.fork.struck(), note.fork.body);
      paint();
      expect(painted()).toHaveLength(2_000);
      expect(painted().every((range) => range.toString() === 'a'), 'only the struck characters').toBe(true);
      expect(note.fork.withdrawPart(note.parts[1]!)).toBe(true);
      paint();
      expect(painted()).toHaveLength(1_000);
      expect(painted().every((range) => range.toString() === 'a')).toBe(true);
      const withdrawn = new Set(note.spans.slice(1_000, 2_000).map((span) => `${span.client}:${span.clock}`));
      for (const [i, id] of note.ids.entries()) {
        const expected = i % 2 === 0 && !withdrawn.has(`${id.client}:${id.clock}`);
        if (note.fork.isStruck(id) !== expected) throw new Error(`character ${i}: isStruck is ${!expected}`);
      }
      // A part added after the withdraw is struck at once.
      const again = note.spans.slice(1_000, 1_010);
      expect(note.fork.proposeDelete(again)).toBeTruthy();
      expect(note.fork.isStruck(again[0]!)).toBe(true);
      paint();
      expect(painted()).toHaveLength(1_010);
    } finally {
      clearPaint(owner);
      note.dispose();
    }
  });
});

describe('T9.55d a repaint keeps the element of every standing mark @p:mean-2 @p:R17', () => {
  const CLIENT_ONE = 0x7fff1001;
  const CLIENT_TWO = 0x7fff1002;

  /** One op holding what `write` does under `client` to a copy of `live`, `before` applied to the copy first. */
  function opAs(live: Y.Doc, client: number, write: (copy: Y.Doc) => void, before: Uint8Array[] = []) {
    const copy = new Y.Doc({ gc: false });
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(live));
    for (const update of before) Y.applyUpdate(copy, update);
    copy.clientID = client;
    const updates: Uint8Array[] = [];
    copy.on('update', (update: Uint8Array) => updates.push(update));
    write(copy);
    copy.destroy();
    return { doc: 'body', update: Y.mergeUpdates(updates) };
  }

  /** An open record by the suggester, made at `createdAt`, writing under `client`. */
  function suggest(live: Y.Doc, id: string, client: number, createdAt: number, op: ReturnType<typeof opAs>) {
    writeSuggestions(live, () => {
      createRecord(live, { v: 2, id, author: SUGGESTER.id, authorName: SUGGESTER.name, source: 'live', createdAt, updatedAt: createdAt, status: 'open', clients: [client] });
      opsOf(live, id).push([op]);
      partsOf(live, id).push([]);
    });
  }

  /** Inserts `text` into the `n`th paragraph after its first `at` characters (past the text node's map). */
  const insertIn = (n: number, at: number, text: string) => (doc: Y.Doc) =>
    (blocks(doc).filter((block) => block instanceof Y.XmlText)[n] as Y.XmlText).insert(1 + at, text);

  /** The owner's Edit mode: an editor bound to B itself, rendering into the page, and the overlay its marks go in. */
  function ownerView() {
    const live = new Y.Doc();
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    const editor = createEditor({ namespace: 'paint-test', nodes: MARKDOWN_EDITOR_NODES, onError: (error) => { throw error; } });
    editor.setRootElement(root);
    const bound = bindEditor(live, editor);
    Y.applyUpdate(live, Y.encodeStateAsUpdate(seededBody('Keep every original word.\n\nSecond paragraph here.')));
    editor.update(() => {}, { discrete: true });
    const opened: string[] = [];
    const draw = () => {
      editor.update(() => {}, { discrete: true });
      const built = new Composite(live).build();
      try {
        expect(built.valid.length, 'every open record is valid').toBe(openCount(live));
        drawMarks(editor, overlay, editMarks(live, built, bound.binding), (record) => opened.push(record));
      } finally {
        destroyView(built);
      }
    };
    const marks = (kind: string, record: string) => [...overlay.querySelectorAll<HTMLElement>(`[${SUGGEST_MARK_ATTR}="${kind}"][${SUGGESTION_ID_ATTR}="${record}"]`)];
    return {
      live, overlay, opened, draw,
      edit: (step: () => void) => editor.update(step, { discrete: true }),
      wedge: (record: string) => marks('insert', record),
      gutter: (record: string) => marks('gutter', record),
      dispose: () => {
        bound.dispose();
        root.remove();
        overlay.remove();
      },
    };
  }
  const openCount = (live: Y.Doc) => [...live.getMap('suggestions').values()].filter((map) => (map as Y.Map<string>).get('meta')?.includes('"status":"open"')).length;

  it('two standing suggestions keep their elements, each acting for its own record, while their places and order change; a closed one leaves', () => {
    const view = ownerView();
    try {
      const plus = opAs(view.live, CLIENT_ONE, insertIn(0, 'Keep every original'.length, ' plus'));
      suggest(view.live, 'r1', CLIENT_ONE, 10, plus);
      suggest(view.live, 'r2', CLIENT_TWO, 20, opAs(view.live, CLIENT_TWO, insertIn(1, 'Second'.length, ' extra')));
      view.draw();
      for (const record of ['r1', 'r2']) {
        expect(view.wedge(record), `one wedge for ${record}`).toHaveLength(1);
        expect(view.gutter(record), `one gutter bar for ${record}`).toHaveLength(1);
      }
      const [wedgeOne, barOne, wedgeTwo, barTwo] = [view.wedge('r1')[0]!, view.gutter('r1')[0]!, view.wedge('r2')[0]!, view.gutter('r2')[0]!];
      const same = (found: HTMLElement[], element: HTMLElement) => found.length === 1 && found[0] === element;
      const holds = (step: string, order: HTMLElement[]) => {
        expect(same(view.wedge('r1'), wedgeOne), `${step}: r1 keeps its wedge element`).toBe(true);
        expect(same(view.gutter('r1'), barOne), `${step}: r1 keeps its gutter bar element`).toBe(true);
        expect(same(view.wedge('r2'), wedgeTwo), `${step}: r2 keeps its wedge element`).toBe(true);
        expect(same(view.gutter('r2'), barTwo), `${step}: r2 keeps its gutter bar element`).toBe(true);
        const children = [...view.overlay.children];
        expect(children.length === order.length && children.every((child, i) => child === order[i]), `${step}: the overlay holds the marks in mark order`).toBe(true);
        view.opened.length = 0;
        for (const element of [wedgeOne, barOne, wedgeTwo, barTwo]) element.click();
        expect(view.opened, `${step}: each element opens its own suggestion`).toEqual(['r1', 'r1', 'r2', 'r2']);
        expect(wedgeOne.querySelector('[data-suggest-preview]')?.textContent, `${step}: r1 previews its own text`).toMatch(/^plus/);
        expect(wedgeTwo.querySelector('[data-suggest-preview]')?.textContent, `${step}: r2 previews its own text`).toBe('extra');
      };
      const inOrder = [wedgeOne, barOne, wedgeTwo, barTwo];
      const swapped = [wedgeTwo, barTwo, wedgeOne, barOne];

      view.draw();
      holds('drawn again with nothing changed', inOrder);

      // Someone types earlier in r1's own paragraph: the anchor's offset in its text node moves on every key.
      for (const [i, key] of [...'Ahead '].entries()) {
        view.edit(() => textNode(i ? 'Ahead '.slice(0, i) : 'Keep').spliceText(i, 0, key, false));
        view.draw();
        holds(`after "${key}" typed earlier in the same paragraph`, inOrder);
      }
      expect(wedgeOne.getAttribute('aria-label')).toBe('Suggested insert: plus');

      // A paragraph added above both: every block's index moves.
      view.edit(() => $getRoot().getFirstChildOrThrow().insertBefore($createParagraphNode().append($createTextNode('A new first block.'))));
      view.draw();
      holds('after a block is added above', inOrder);

      // r2 now comes first: the order of the marks changes while both stand.
      writeSuggestions(view.live, () => patchMeta(view.live, 'r2', { createdAt: 5 }));
      view.draw();
      holds('after the order changes', swapped);

      // r1 grows: its wedge reads and previews the longer text.
      writeSuggestions(view.live, () => opsOf(view.live, 'r1').push([opAs(view.live, CLIENT_ONE, insertIn(1, 'Ahead Keep every original plus'.length, ' more'), [plus.update])]));
      view.draw();
      holds('after r1 grows', swapped);
      expect(wedgeOne.getAttribute('aria-label')).toBe('Suggested insert: plus more');
      expect(wedgeOne.querySelector('[data-suggest-preview]')?.textContent).toBe('plus more');

      // r1 is withdrawn: its elements leave, r2's stay.
      closeRecord(view.live, 'r1', { status: 'withdrawn' });
      view.draw();
      expect(view.wedge('r1'), 'a closed suggestion has no wedge').toHaveLength(0);
      expect(view.gutter('r1'), 'nor a gutter bar').toHaveLength(0);
      expect(wedgeOne.isConnected || barOne.isConnected, 'its elements left the page').toBe(false);
      expect(same(view.wedge('r2'), wedgeTwo) && same(view.gutter('r2'), barTwo), "r2's elements stay").toBe(true);
      expect(view.overlay.children.length, 'nothing else is drawn').toBe(2);
    } finally {
      view.dispose();
    }
  });
});
