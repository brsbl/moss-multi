// @vitest-environment jsdom
// T5.B3 (B283, B287): Edit-mode marks never throw on a stored BigInt and see a `__proto__` attribute; strike membership
// (the fork's isStruck and the paint over a binding) grows near-linearly as characters and strike spans double, and
// what paints follows a withdrawn part.
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import type { IdSpan, SuggestReply, SuggestRequest } from '@moss-multi/protocol/suggest';
import { createEditor, type LexicalEditor } from 'lexical';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MARKDOWN_EDITOR_NODES } from '../../../../../../packages/sync/src/converter/index.ts';
import { handleSuggest, SuggestIngest } from '../../../../../../packages/sync/src/doc/suggest.ts';
import { payloadDocsFor } from '../../../../../../packages/sync/src/payload-docs.ts';
import { Composite, destroyView, spanWork, SuggestFork } from '../../../../../../packages/sync/src/suggest/client.ts';
import { bindEditor } from '../../../../../../packages/sync/src/suggest/fork-shim.ts';
import { nodeRegistry } from '../../../../../../packages/sync/src/suggest/review.ts';
import { deterministicIds, forgeRecord, opOn, OTHER_SUGGESTER, seededBody, SUGGESTER } from '../../../../../../packages/sync/src/suggest/test-support.ts';
import { textIds } from './chars.ts';
import { clearPaint, editMarks, paintBound } from './paint.ts';

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
