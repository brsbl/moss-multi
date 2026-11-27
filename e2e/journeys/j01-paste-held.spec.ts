// j01-paste-held (T3.S6, T3.B31c): the paste check counts what the DocDO counts. Deleting a code or HTML block leaves
// its text on the server (withheld, for an undo), but the note's text limit (A§5.1) counts only the payloads the note
// names, and a tab that opens the note afterwards holds exactly those. So deleting blocks frees their characters: a
// paste that fits beside the text the note still names lands whole, though the server keeps the deleted blocks' text,
// and the tab's own admission agrees with the DocDO's, so nothing is refused part way.
//
// The notes and the reference imports are created through POST /api/docs as declared setup.
import type { LexicalEditor, LexicalNode } from 'lexical';
import { grantDoc } from '../lib/grants.ts';
import { exported, fence, fingerprint, normalized, pastePlain, setup, type Admission } from '../lib/paste.ts';
import { expect, test, ui } from '../lib/test.ts';

// Five code and HTML blocks of 190 KB: about 950,000 characters, under the text limit beside the paragraph.
const BLOCKS = Array.from({ length: 5 }, (_, b) => b % 2
  ? fence('moss-html', 190_000, (i) => `<p>block ${b} line ${i}</p>`)
  : fence('js', 190_000, (i) => `const value${b}_${i} = ${i};`));

// 900 paragraphs of 1,000 characters: past the limit beside the deleted blocks' text, well within it without.
const PASTED = Array.from({ length: 900 }, (_, i) => `Pasted ${String(i).padStart(4, '0')} ${'w'.repeat(988)}`);

test('j01-paste-held: deleted blocks free their characters, so a paste that fits beside the text the note still names lands whole @p:col-1', async ({ actors, stack }) => {
  test.setTimeout(400_000);
  // Before Ada or Ben open the note, Cy deletes its blocks: the DocDO keeps their 950,000 characters withheld.
  const { ada, ben, docId } = await setup(actors, stack, ['Kept.', ...BLOCKS].join('\n\n'), {
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
      expect(removed, 'declared setup: the blocks are deleted').toBe(5);
      await ui.waitAcked(cy, id, 60_000);
      await cy.goto('/');
    },
  });
  await ui.waitAcked(ada, docId, 30_000);
  expect(await exported(ada, docId), 'only the paragraph is left').toBe(await normalized(ada, stack, 'Kept.'));

  await ui.body(ada, docId).locator('p').filter({ hasText: /^Kept\.$/ }).click();
  await ada.page.keyboard.press('End');
  await pastePlain(ada, docId, PASTED.join('\n\n'));
  const admission = () => ada.page.evaluate(() => performance.getEntriesByName('moss-paste-admission').map((mark) => (mark as PerformanceMark).detail as Admission).at(-1));
  let figures: Admission | undefined;
  await expect.poll(async () => (figures = await admission()) !== undefined, { message: 'the paste is measured', timeout: 120_000 }).toBe(true);
  expect(figures!.met, `the tab admits it (${JSON.stringify(figures)})`).toBeNull();
  expect(figures!.heldChars, 'the tab counts only the text the note names').toBeLessThan(100);
  expect(figures!.heldChars + figures!.chars + 950_000, 'beside the deleted blocks it would not fit').toBeGreaterThan(1_020_000);
  await ui.waitAcked(ada, docId, 240_000);
  const landed = await exported(ada, docId);
  for (const line of [PASTED[0], PASTED[899]]) expect(landed, 'the whole paste lands').toContain(line);
  const print = await fingerprint(ada, docId);
  await expect.poll(() => fingerprint(ben, docId), { message: 'and reaches the collaborator', timeout: 120_000 }).toEqual(print);
});
