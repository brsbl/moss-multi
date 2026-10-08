// T7.2: the structural push merge (A§17). A pushed `.md` file is merged three ways against the pulled base and the
// live doc, then landed through the identity-preserving reconcile: untouched blocks keep their Yjs items, duplicate
// blocks keep their positions, a `:::tabs` block stays one block whose panels merge, a peer's concurrent typing in
// the same paragraph survives, and a degenerate push is refused unless forced. @p:agt-1 @p:tech-5 @p:tech-7
import { $getRoot, $isElementNode, $isTextNode, type LexicalNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { liveUnits } from '@moss-multi/core/anchor-frame';
import { readFrontmatter } from '@moss-multi/core/frontmatter';
import { computeMergedTarget, mergeBudget } from '@moss-multi/core/merge';
import { landPush } from './push.ts';
import { bodyState, ReconcileRefused } from './reconcile.ts';
import { exportDocMarkdown, importBody, serverWrite } from './server-doc.ts';

const PUSH = 'test-push';
const NOTE = 'note-1';

function docOf(markdown: string): Y.Doc {
  const doc = new Y.Doc();
  importBody(doc, markdown);
  return doc;
}

const exported = (doc: Y.Doc): string => exportDocMarkdown(doc, NOTE);

function fork(live: Y.Doc): Y.Doc {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(live), 'remote');
  return peer;
}

function share(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), 'remote');
}

/** The live root's block items, in order, as `client:clock` ids. */
function blockIds(doc: Y.Doc): string[] {
  const ids: string[] = [];
  for (let item = doc.get('root', Y.XmlText)._start; item; item = item.right) {
    if (!item.deleted && item.content instanceof Y.ContentType) ids.push(`${item.id.client}:${item.id.clock}`);
  }
  return ids;
}

/** The Yjs id of each character of `quote`'s first occurrence in the body's units. */
function charIds(doc: Y.Doc, quote: string): string[] {
  const { text, units } = liveUnits(doc);
  const at = text.indexOf(quote);
  expect(at, `"${quote}" is in the body`).toBeGreaterThanOrEqual(0);
  return units.slice(at, at + quote.length).map(({ item, off }) => `${item.id.client}:${item.id.clock + off}`);
}

/** Types `text` into `doc` right after the first occurrence of `after`, as a person in the editor would. */
function typeAfter(doc: Y.Doc, after: string, text: string): void {
  let found = false;
  serverWrite(doc, 'peer', () => {
    const visit = (node: LexicalNode): boolean => {
      if ($isTextNode(node) && node.getTextContent().includes(after)) {
        node.setTextContent(node.getTextContent().replace(after, `${after}${text}`));
        return true;
      }
      return $isElementNode(node) && node.getChildren().some(visit);
    };
    found = visit($getRoot());
  });
  expect(found, `"${after}" is in the doc`).toBe(true);
}

const BODY = ['Alpha one stays.', 'Bravo two stays.', 'Charlie three changes.', 'Delta four stays.', 'Echo five stays.'].join('\n\n');

describe('T7.2 structural push merge @p:agt-1 @p:tech-5', () => {
  it('lands an undrifted push exactly, and every untouched block keeps its Yjs item', () => {
    const live = docOf(BODY);
    const base = exported(live);
    const before = blockIds(live);
    const next = base.replace('Charlie three changes.', 'Charlie three has changed.');
    const result = landPush(live, NOTE, { base, newText: next, force: false }, PUSH);
    expect(result).toMatchObject({ ok: true, failedHunks: [] });
    expect(exported(live)).toBe(next);
    const after = blockIds(live);
    expect(after).toHaveLength(5);
    for (const index of [0, 1, 3, 4]) expect(after[index], `block ${index} keeps its item`).toBe(before[index]);
  });

  it('merges a drifted doc: a peer\'s edit to another block and the push both land', () => {
    const live = docOf(BODY);
    const base = exported(live);
    const peer = fork(live);
    typeAfter(peer, 'Alpha one', ' (peer)');
    share(peer, live);
    const next = base.replace('Delta four stays.', 'Delta four was pushed.');
    const result = landPush(live, NOTE, { base, newText: next, force: false }, PUSH);
    expect(result).toMatchObject({ ok: true, failedHunks: [] });
    const text = exported(live);
    expect(text).toContain('Alpha one (peer) stays.');
    expect(text).toContain('Delta four was pushed.');
  });

  it('keeps a peer\'s concurrent typing in the same paragraph: both the push and the typing survive', () => {
    const live = docOf(BODY);
    const base = exported(live);
    const peer = fork(live);
    const kept = charIds(live, 'three');
    // The push edits the start of the paragraph while the peer types at its end, concurrently.
    const next = base.replace('Charlie three changes.', 'Charles three changes.');
    typeAfter(peer, 'three changes', ' while typing');
    expect(landPush(live, NOTE, { base, newText: next, force: false }, PUSH)).toMatchObject({ ok: true });
    share(peer, live);
    share(live, peer);
    expect(exported(live)).toContain('Charles three changes while typing.');
    expect(exported(peer)).toBe(exported(live));
    expect(charIds(live, 'three'), 'the untouched characters keep their items').toEqual(kept);
  });

  it('keeps a peer\'s typing inside a span the push deletes, and returns that hunk as failed', () => {
    const live = docOf(BODY);
    const base = exported(live);
    const peer = fork(live);
    typeAfter(peer, 'Charlie three', ' (peer)');
    share(peer, live);
    const next = base.replace('Charlie three changes.', 'Charlie.').replace('Echo five stays.', 'Echo five was pushed.');
    const result = landPush(live, NOTE, { base, newText: next, force: false }, PUSH);
    expect(result.ok).toBe(true);
    expect((result as { failedHunks: string[] }).failedHunks).toHaveLength(1);
    expect(exported(live)).toContain('Charlie three (peer) changes.');
    expect(exported(live)).toContain('Echo five was pushed.');
  });

  it('keeps duplicate blocks in their positions: an edit to the second of three equal paragraphs lands on the second', () => {
    const live = docOf(['Same line.', 'Same line.', 'Same line.', 'Tail.'].join('\n\n'));
    const base = exported(live);
    const before = blockIds(live);
    const next = ['Same line.', 'Same line, edited.', 'Same line.', 'Tail.'].join('\n\n');
    expect(landPush(live, NOTE, { base, newText: next, force: false }, PUSH)).toMatchObject({ ok: true });
    expect(exported(live)).toBe(next);
    const after = blockIds(live);
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    expect(after[3]).toBe(before[3]);
  });

  it('keeps duplicate blocks in their positions when the doc drifted above them', () => {
    const live = docOf(['Same line.', 'Same line.', 'Same line.', 'Tail.'].join('\n\n'));
    const base = exported(live);
    const peer = fork(live);
    typeAfter(peer, 'Tail', ' end');
    share(peer, live);
    const next = ['Same line.', 'Same line.', 'Same line, third.', 'Tail.'].join('\n\n');
    expect(landPush(live, NOTE, { base, newText: next, force: false }, PUSH)).toMatchObject({ ok: true, failedHunks: [] });
    expect(exported(live)).toBe(['Same line.', 'Same line.', 'Same line, third.', 'Tail end.'].join('\n\n'));
  });

  it('splits :::tabs correctly: an edit inside a panel keeps the tabs one block, and the blocks around it keep their items', () => {
    const tabs = [':::tabs', '=== Option A', 'Content for A.', '', '=== Option B', 'Content for B.', '', ':::'].join('\n');
    const live = docOf(['Before the tabs.', tabs, 'After the tabs.'].join('\n\n'));
    const base = exported(live);
    expect(base).toContain('=== Option B');
    const before = blockIds(live);
    expect(before).toHaveLength(3);
    const peer = fork(live);
    typeAfter(peer, 'Before the', ' shared');
    share(peer, live);
    const next = base.replace('Content for B.', 'Content for B, pushed.').replace('After the tabs.', 'After the tabs, pushed.');
    expect(landPush(live, NOTE, { base, newText: next, force: false }, PUSH)).toMatchObject({ ok: true, failedHunks: [] });
    const text = exported(live);
    expect(text).toContain('Before the shared tabs.');
    expect(text).toContain('=== Option A\nContent for A.');
    expect(text).toContain('=== Option B\nContent for B, pushed.');
    expect(text).toContain('After the tabs, pushed.');
    const after = blockIds(live);
    expect(after, 'still three blocks: the tabs did not fragment').toHaveLength(3);
    expect(after[0]).toBe(before[0]);
  });

  it('refuses a degenerate push unless forced, drifted or not, and an empty file is degenerate', () => {
    const live = docOf(BODY);
    const base = exported(live);
    const kept = exported(live);
    const most = 'Alpha one stays.';
    const refused = landPush(live, NOTE, { base, newText: most, force: false }, PUSH);
    expect(refused).toMatchObject({ ok: false, reason: 'degenerate' });
    expect((refused as { deletedRatio: number }).deletedRatio).toBeGreaterThan(0.6);
    expect(exported(live), 'nothing landed').toBe(kept);
    expect(landPush(live, NOTE, { base, newText: '', force: false }, PUSH)).toMatchObject({ ok: false, reason: 'degenerate' });
    expect(exported(live)).toBe(kept);
    expect(landPush(live, NOTE, { base, newText: most, force: true }, PUSH)).toMatchObject({ ok: true });
    expect(exported(live)).toBe(most);
  });

  it('refuses a drifted push whose merge runs out of budget midway: 409, nothing lands, forced or suggested (T7.S2)', () => {
    // Twelve paragraphs each changed in many places: diffing them costs more than the small budget below.
    let seed = 11;
    const next = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 4294967296;
    };
    const letters = (n: number): string => Array.from({ length: n }, () => 'abcd'[Math.floor(next() * 4)]).join('');
    const live = docOf(['Intro stays.', ...Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${letters(1_000)}`)].join('\n\n'));
    const base = exported(live);
    const pushed = base.split('\n\n').map((text, p) => (p === 0 ? text : [...text].map((c, i) => (i > 12 && i % 5 === 0 ? 'abcd'[Math.floor(next() * 4)] : c)).join(''))).join('\n\n');
    typeAfter(live, 'Intro', ' (typed)');
    const kept = exported(live);
    const refusal = (input: Partial<Parameters<typeof landPush>[2]>): ReconcileRefused => {
      const budget = mergeBudget(500_000);
      let error: unknown;
      try {
        landPush(live, NOTE, { base, newText: pushed, force: false, budget, ...input }, PUSH);
      } catch (thrown) {
        error = thrown;
      }
      expect(budget.work, 'refused midway, once diffs had drawn on the budget').toBeLessThan(500_000);
      expect(error).toBeInstanceOf(ReconcileRefused);
      expect(exported(live), 'a refused push changes nothing').toBe(kept);
      return error as ReconcileRefused;
    };
    const refused = refusal({});
    expect(refused.status).toBe(409);
    expect(refused.reason).toBe('unverified');
    expect(refused.message).toMatch(/too many places.*nothing changed/);
    expect(refusal({ force: true }).status, '--force does not skip the budget').toBe(409);
    const fork = { client: 424242, ops: [] as { doc: string; update: Uint8Array }[] };
    expect(refusal({ fork }).status, '--suggest is refused the same way').toBe(409);
    expect(fork.ops, 'no suggestion op was collected').toEqual([]);
    expect(landPush(live, NOTE, { base, newText: pushed, force: false }, PUSH), 'the default budget lands it').toMatchObject({ ok: true, failedHunks: [] });
    expect(exported(live)).toBe(pushed.replace('Intro stays.', 'Intro (typed) stays.'));
  });

  it('lands an undrifted push even with its budget spent: its edits need not be exact (T7.S2)', () => {
    const live = docOf(BODY);
    const base = exported(live);
    const next = base.replace('Charlie three changes.', 'Charlie three has changed.');
    expect(landPush(live, NOTE, { base, newText: next, force: false, budget: mergeBudget(0) }, PUSH)).toMatchObject({ ok: true, failedHunks: [] });
    expect(exported(live)).toBe(next);
  });

  it('returns a hunk it cannot place and lands the rest', () => {
    const body = BODY.replace('Charlie three changes.', 'Charlie wrote a long and quite distinctive sentence about winter squash.');
    const live = docOf(body);
    const base = exported(live);
    // A person deleted the paragraph the push edits, so the push's hunk has nowhere to go.
    const deleted = docOf(body.replace('Charlie wrote a long and quite distinctive sentence about winter squash.\n\n', ''));
    expect(landPush(live, NOTE, { base, newText: exported(deleted), force: true }, 'setup')).toMatchObject({ ok: true });
    const next = base.replace('quite distinctive sentence', 'rather peculiar sentence').replace('Echo five stays.', 'Echo five was pushed.');
    const result = landPush(live, NOTE, { base, newText: next, force: false }, PUSH);
    expect(result.ok).toBe(true);
    expect((result as { failedHunks: string[] }).failedHunks.length).toBeGreaterThan(0);
    expect(exported(live)).toContain('Echo five was pushed.');
    expect(exported(live)).not.toContain('peculiar');
  });

  it('normalizes CRLF and lands frontmatter changes with the body', () => {
    const live = docOf('Body text.');
    const base = exported(live);
    const next = '---\r\nstatus: draft\r\n---\r\nBody text, pushed.';
    expect(landPush(live, NOTE, { base, newText: next, force: false }, PUSH)).toMatchObject({ ok: true });
    expect(readFrontmatter(live)).toEqual({ status: 'draft' });
    expect(exported(live)).toContain('Body text, pushed.');
    expect(exported(live)).not.toContain('\r');
  });

  it('a no-op push writes nothing', () => {
    const live = docOf(BODY);
    const base = exported(live);
    const vector = Y.encodeStateVector(live);
    expect(landPush(live, NOTE, { base, newText: base, force: false }, PUSH)).toMatchObject({ ok: true, applied: 0 });
    expect(Y.encodeStateVector(live)).toEqual(vector);
  });

  it('a refused admission writes nothing', () => {
    const live = docOf(BODY);
    const base = exported(live);
    const vector = Y.encodeStateVector(live);
    expect(() => landPush(live, NOTE, { base, newText: `${base}\n\nMore.`, force: false }, PUSH, () => {
      throw new Error('doc-cap');
    })).toThrow('doc-cap');
    expect(Y.encodeStateVector(live)).toEqual(vector);
  });

  it('keeps typing at the end of the last paragraph in that paragraph when the pushed file ends with a newline', () => {
    const live = docOf(BODY);
    const base = exported(live);
    const peer = fork(live);
    typeAfter(peer, 'Echo five stays', ' and more');
    share(peer, live);
    const next = `${base.replace('Echo five stays.', 'Echo five still stays.')}\n`;
    expect(landPush(live, NOTE, { base, newText: next, force: false }, PUSH)).toMatchObject({ ok: true, failedHunks: [] });
    expect(exported(live).endsWith('\n\nEcho five still stays and more.')).toBe(true);
  });

  // The converter's NOT_IDEMPOTENT fixtures: a re-import of their export differs from the first import.
  const LOSSY: Record<string, string> = {
    'code-blocks': 'Intro.\n\n````markdown\n```js\ninner fence\n```\n````\n\nOutro.',
    entities: 'Entities stay literal: &#160; and &amp; and &lt;tag&gt;.\n\nA non-breaking space between words.',
  };
  for (const [name, markdown] of Object.entries(LOSSY)) {
    it(`leaves untouched blocks the converter would not re-import exactly alone (${name})`, () => {
      const live = docOf(markdown);
      const base = exported(live);
      const before = bodyState(live).root.children;
      const ids = blockIds(live);
      const next = `${base}\n\nA pushed paragraph.`;
      expect(landPush(live, NOTE, { base, newText: next, force: false }, PUSH)).toMatchObject({ ok: true, failedHunks: [] });
      const after = bodyState(live).root.children;
      expect(after).toHaveLength(before.length + 1);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(blockIds(live).slice(0, ids.length)).toEqual(ids);
      expect(exported(live)).toBe(next);
    });
  }

  it('edits the paragraph after a block the converter would not re-import exactly, and leaves that block alone', () => {
    const live = docOf(`Water at dawn.\n\n${LOSSY['code-blocks']!.split('\n\n')[1]}\n\nHarvest in autumn.`);
    const base = exported(live);
    const before = bodyState(live).root.children;
    const ids = blockIds(live);
    const peer = fork(live);
    typeAfter(peer, 'Harvest in autumn.', ' Pick squash');
    share(peer, live);
    const next = `${base.replace('Harvest in autumn.', 'Harvest in late autumn.')}\n`;
    expect(landPush(live, NOTE, { base, newText: next, force: false }, PUSH)).toMatchObject({ ok: true, failedHunks: [] });
    const after = bodyState(live).root.children;
    expect(after).toHaveLength(3);
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    expect(blockIds(live)).toEqual(ids);
    expect(exported(live)).toBe(base.replace('Harvest in autumn.', 'Harvest in late autumn. Pick squash'));
  });
});

// Constructs the converter does not re-import exactly (nested and four-backtick fences, no-break spaces from &#160;
// inside containers, tables, tabs, callouts, raw HTML). Each sits between two plain paragraphs.
const CORPUS: Record<string, string> = {
  'nested fence': '````markdown\n```js\ninner fence\n```\n````',
  'four-backtick fence': '````\nplain ``` inside\n````',
  'list with a no-break space': '- first&#160;item\n- second item\n- third item',
  'nested list': '- outer&#160;one\n  - inner one\n  - inner two\n- outer two',
  'quote with a no-break space': '> quoted&#160;line one\n>\n> quoted line two',
  'table with a no-break space': '| A | B |\n| --- | --- |\n| x&#160;y | plain |\n| row two | cell |',
  callout: '```moss-callout\ninfo\nInside&#160;a callout.\n```',
  'tabs holding a nested fence': ':::tabs\n=== Option A\n````markdown\n```js\ninner\n```\n````\n=== Option B\nContent for B.\n:::',
  'tabs with a no-break space': ':::tabs\n=== One\nWord&#160;gap here.\n=== Two\nSecond panel.\n:::',
  html: '<div class="note">\n<b>bold</b> text\n</div>',
  entities: 'Entities stay literal: &#160; and &amp; and &lt;tag&gt;.',
};

/** `line` with `Zq` inserted after its first run of letters, or null when it has none. */
function editLine(line: string): string | null {
  const match = /[A-Za-z]+/.exec(line);
  return match ? `${line.slice(0, match.index + match[0].length)}Zq${line.slice(match.index + match[0].length)}` : null;
}

type Landed = 'landed' | 'refused';

/** Pushes `next` and checks the rule: the doc becomes exactly the merged target, or is refused (409) and unchanged. */
function pushChecked(live: Y.Doc, base: string, next: string, label: string): Landed {
  const before = exported(live);
  const { target } = computeMergedTarget(before, base, next);
  try {
    landPush(live, NOTE, { base, newText: next, force: true }, PUSH);
  } catch (error) {
    expect(error, label).toBeInstanceOf(ReconcileRefused);
    expect((error as ReconcileRefused).status, label).toBe(409);
    expect((error as Error).message, `${label}: the refusal names the block`).toMatch(/block/);
    expect(exported(live), `${label}: a refused push changes nothing`).toBe(before);
    return 'refused';
  }
  expect(exported(live), `${label}: lands exactly the merged target`).toBe(target);
  return 'landed';
}

describe('a push never silently changes content it did not edit @p:agt-1 @p:tech-5', () => {
  for (const [name, construct] of Object.entries(CORPUS)) {
    it(`editing any one line next to or inside ${name} lands exactly the target or is refused`, () => {
      const markdown = `Lead paragraph.\n\n${construct}\n\nTail paragraph.`;
      const base = exported(docOf(markdown));
      const lines = base.split('\n');
      const outcomes: Record<string, Landed> = {};
      for (let i = 0; i < lines.length; i++) {
        const edited = editLine(lines[i]!);
        if (edited === null) continue;
        const next = [...lines.slice(0, i), edited, ...lines.slice(i + 1)].join('\n');
        outcomes[lines[i]!] = pushChecked(docOf(markdown), base, next, `${name}, line ${i + 1}`);
        // The same edit while a person types in the lead paragraph.
        if (!lines[i]!.startsWith('Lead')) {
          const live = docOf(markdown);
          const peer = fork(live);
          typeAfter(peer, 'Lead paragraph', ' typed');
          share(peer, live);
          pushChecked(live, base, next, `${name}, line ${i + 1}, drifted`);
        }
      }
      expect(outcomes['Tail paragraph.'], 'an edit beside the construct always lands').toBe('landed');
      expect(outcomes['Lead paragraph.'], 'an edit beside the construct always lands').toBe('landed');
    }, 60_000);
  }

  it('lands an edit to one item of a list or one row of a table, keeping a sibling that would not re-import exactly', () => {
    for (const [construct, line] of [
      [CORPUS['list with a no-break space']!, '- second item'],
      [CORPUS['table with a no-break space']!, '| row two | cell |'],
    ] as const) {
      const live = docOf(`Lead paragraph.\n\n${construct}\n\nTail paragraph.`);
      const base = exported(live);
      expect(base).toContain(line);
      expect(pushChecked(live, base, base.replace(line, editLine(line)!), line)).toBe('landed');
      expect(exported(live)).toContain(' ');
    }
  });

  it('refuses an edit to a paragraph whose untouched words would not re-import exactly, naming the block', () => {
    const live = docOf('Lead paragraph.\n\nWord&#160;gap here and more.\n\nTail paragraph.');
    const base = exported(live);
    const before = exported(live);
    expect(() => landPush(live, NOTE, { base, newText: base.replace('and more', 'and more still'), force: false }, PUSH))
      .toThrow(/block 2/);
    expect(exported(live)).toBe(before);
  });

  it('a refused block the push wrote itself is named as stored differently, never as one the pull wrote', () => {
    const live = docOf('Lead paragraph.\n\nTail paragraph.');
    const base = exported(live);
    const before = exported(live);
    let message = '';
    try {
      landPush(live, NOTE, { base, newText: `${base.trimEnd()}\n\nSome _emphasis_ text.\n`, force: false }, PUSH);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/block 3 \("Some _emphasis_ text\."\) would be stored differently \(as "Some \*emphasis\* text\."\)/);
    expect(message).not.toMatch(/as the pull wrote it/);
    expect(exported(live)).toBe(before);
  });

  it('a push that edits only a code block\'s code reports a change, so it is versioned and attributed', () => {
    const live = docOf('Lead paragraph.\n\n```javascript\nconst a = 1;\n```\n\nTail paragraph.');
    const base = exported(live);
    const next = base.replace('const a = 1;', 'const a = 2;');
    expect(landPush(live, NOTE, { base, newText: next, force: false }, PUSH)).toMatchObject({ ok: true, changed: true });
    expect(exported(live)).toBe(next);
  });
});
