// j01-paste-held (T3.S6): the cap check counts the payloads the DocDO keeps that this tab does not hold. Deleting a
// code or HTML block leaves its text on the server (withheld, for an undo) and still counted against the note's size
// cap (A§5.1), but a tab that opens the note afterwards holds only the payloads its blocks name. A paste that fits
// beside what the tab holds, but not beside what the server counts, would land in part: its first batches persist and
// a later one is refused. It must be refused whole before anything is applied, as a paste past the cap is.
//
// The notes and the reference imports are created through POST /api/docs as declared setup.
import type { LexicalEditor, LexicalNode } from 'lexical';
import type * as Y from 'yjs';
import { grantDoc } from '../lib/grants.ts';
import { expectRefusedPaste, exported, fence, normalized, setup } from '../lib/paste.ts';
import { expect, test, ui } from '../lib/test.ts';

// Ten code and HTML blocks of 190 KB: about 1.9 MB of payload docs, under the import's 2 MB of markdown.
const BLOCKS = Array.from({ length: 10 }, (_, b) => b % 2
  ? fence('moss-html', 190_000, (i) => `<p>block ${b} line ${i}</p>`)
  : fence('js', 190_000, (i) => `const value${b}_${i} = ${i};`));

test('j01-paste-held: a paste that fits beside the payloads a tab holds, but not beside the deleted ones the server still counts, is refused whole @p:col-1', async ({ actors, stack }) => {
  test.setTimeout(400_000);
  // Before Ada or Ben open the note, Cy deletes its blocks: the DocDO keeps their 1.9 MB withheld and counts it.
  const refused = await setup(actors, stack, ['Kept.', ...BLOCKS].join('\n\n'), {
    prepare: async (owner, id) => {
      const principal = await actors.principal('cy');
      await grantDoc(owner, id, principal);
      const cy = await actors.session(principal);
      await cy.goto(`/d/${id}`);
      await ui.waitLive(cy, id);
      const removed = await ui.body(cy, id).evaluate((element) => {
        const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
        let count = 0;
        editor.update(() => {
          const root = editor._pendingEditorState!._nodeMap.get('root') as LexicalNode & { getChildren(): LexicalNode[] };
          for (const child of root.getChildren()) {
            if (child.getType() === 'paragraph') continue;
            child.remove();
            count += 1;
          }
        }, { discrete: true });
        return count;
      });
      expect(removed, 'declared setup: the blocks are deleted').toBe(10);
      await ui.waitAcked(cy, id, 60_000);
      await cy.goto('/');
    },
  });
  const { ada, docId } = refused;
  await ui.waitAcked(ada, docId, 30_000);
  expect(await exported(ada, docId), 'only the paragraph is left').toBe(await normalized(ada, stack, 'Kept.'));

  // The DocDO's own figure for the payloads it counts, as Ada's session heard it on connect (moss-payload-usage).
  let usage: { pb: number; limit: number } | undefined;
  await expect.poll(async () => {
    usage = await ada.page.evaluate(() => performance.getEntriesByName('moss-payload-usage').map((mark) => (mark as PerformanceMark).detail as { pb: number; limit: number }).at(-1));
    return usage?.pb ?? 0;
  }, { message: 'the DocDO reports the withheld payloads it counts', timeout: 30_000 }).toBeGreaterThan(1_500_000);
  const { pb, limit } = usage!;

  // A paste of about the limit less half the server's payloads: under the limit beside the note Ada holds, past it
  // with what the server keeps. A short paragraph's state names Ada's client id about 25 times, a varint of 1 to 5
  // bytes: 52,001 paragraphs were 25,765,966 bytes with a 5-byte id, 24,466,033 with a 4-byte one.
  const idBytes = await ui.body(ada, docId).evaluate((element) => {
    const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
    const undo = (editor as unknown as Record<symbol, { root?: { doc: Y.Doc }; doc?: Y.Doc }>)[Symbol.for('@lexical/yjs/UndoManager')];
    let id = (undo.root?.doc ?? undo.doc)!.clientID;
    let bytes = 1;
    for (; id > 0x7f; id = Math.floor(id / 0x80)) bytes += 1;
    return bytes;
  });
  const count = Math.round((limit - pb / 2) / (495.5 - 25 * (5 - idBytes)));
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) lines.push(`p${i}`);
  lines.push('Last line of the paste.');
  // The admission's measured figures put the paste between the two counts, with room either side, before the refusal
  // is demanded: one that ignored the server's count would admit it.
  await expectRefusedPaste(refused, stack, lines.join('\n\n'), {
    admission: ({ adds, heldLocal, heldServer, limit: cap, fit }) => {
      expect(fit, 'the tab\'s own admission refuses it, before any reserve').toBe(false);
      const margin = Math.min(250_000, pb / 8);
      expect(heldLocal + adds, `beside what Ada holds, the paste fits (adds ${adds}, held ${heldLocal}, limit ${cap})`).toBeLessThan(cap - margin);
      expect(heldServer + adds, `beside what the server counts, it does not (adds ${adds}, held ${heldServer}, limit ${cap})`).toBeGreaterThan(cap + margin);
    },
  });
});
