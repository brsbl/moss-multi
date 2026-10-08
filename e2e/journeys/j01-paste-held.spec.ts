// j01-paste-held (T3.S6): the cap check counts the payloads the DocDO keeps that this tab does not hold. Deleting a
// code or HTML block leaves its text on the server (withheld, for an undo) and still counted against the note's size
// cap (A§5.1), but a tab that opens the note afterwards holds only the payloads its blocks name. A paste that fits
// beside what the tab holds, but not beside what the server counts, would land in part: its first batches persist and
// a later one is refused. It must be refused whole before anything is applied, as a paste past the cap is.
//
// The notes and the reference imports are created through POST /api/docs as declared setup.
import type { LexicalEditor, LexicalNode } from 'lexical';
import { INPUT_REFUSAL_ATTR } from '../lib/contract.ts';
import { grantDoc } from '../lib/grants.ts';
import { exported, expectWire, fingerprint, longestStall, MAX_STALL_MS, normalized, pastePlain, setup, watchStalls } from '../lib/paste.ts';
import { expect, test, ui } from '../lib/test.ts';

/** A fenced block of `language` holding about `bytes` of `line(i)` lines. */
function fence(language: string, bytes: number, line: (i: number) => string): string {
  const lines: string[] = [];
  for (let size = 0, i = 0; size < bytes; i += 1) {
    const next = line(i);
    lines.push(next);
    size += next.length + 1;
  }
  return `\`\`\`${language}\n${lines.join('\n')}\n\`\`\``;
}

// Ten code and HTML blocks of 190 KB: about 1.9 MB of payload docs, under the import's 2 MB of markdown.
const BLOCKS = Array.from({ length: 10 }, (_, b) => b % 2
  ? fence('moss-html', 190_000, (i) => `<p>block ${b} line ${i}</p>`)
  : fence('js', 190_000, (i) => `const value${b}_${i} = ${i};`));

test('j01-paste-held: a paste that fits beside the payloads a tab holds, but not beside the deleted ones the server still counts, is refused whole @p:col-1', async ({ actors, stack }) => {
  test.setTimeout(400_000);
  // Before Ada or Ben open the note, Cy deletes its blocks: the DocDO keeps their 1.9 MB withheld and counts it.
  const { ada, ben, docId, wire } = await setup(actors, stack, ['Kept.', ...BLOCKS].join('\n\n'), {
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
  await ui.waitAcked(ada, docId, 30_000);
  const before = await exported(ada, docId);
  expect(before, 'only the paragraph is left').toBe(await normalized(ada, stack, 'Kept.'));
  const print = await fingerprint(ada, docId);

  // 52,000 short paragraphs are about 25.8 MB of note state: under the cap beside the note Ada holds, past it with
  // the 1.9 MB the server keeps.
  const lines: string[] = [];
  for (let i = 0; i < 52_000; i += 1) lines.push(`p${i}`);
  lines.push('Last line of the paste.');
  await ui.body(ada, docId).locator('p').filter({ hasText: /^Kept\.$/ }).click();
  await ada.page.keyboard.press('End');
  await watchStalls(ada);
  await pastePlain(ada, docId, lines.join('\n\n'));
  await expect(ada.page.locator(`[${INPUT_REFUSAL_ATTR}]`), 'the refusal is announced').toContainText('size limit', { timeout: 120_000 });
  const stall = await longestStall(ada);
  expect(stall.ms, `the refused paste never holds the tab longer than ${MAX_STALL_MS} ms at a time (during: ${stall.during})`).toBeLessThanOrEqual(MAX_STALL_MS);
  await ui.waitAcked(ada, docId, 30_000);
  expect(await fingerprint(ada, docId), 'nothing of the paste is in the editor').toEqual(print);
  await ada.page.waitForTimeout(3_000);
  expect(await exported(ada, docId), 'nothing of the paste reached the server').toBe(before);
  expect(await fingerprint(ben, docId), 'nor the collaborator').toEqual(print);
  await ui.typeBody(ada, docId, ' Still typing.');
  await ui.waitAcked(ada, docId, 30_000);
  await expect.poll(() => exported(ada, docId), { message: 'the note stays editable', timeout: 30_000 }).toBe(await normalized(ada, stack, 'Kept. Still typing.'));
  expectWire(wire);
});
