// j01-paste-cap (T3.S6): a paste just past the note's size cap (A§5.1) is refused whole, before any of it is applied.
// The DocDO counts a note's state and its payload docs (code, HTML, formula, chart and sketch fields) against the cap
// and refuses the write that crosses it; a paste sent in pieces would land up to there and lose the rest. As plain
// text, 59,000 short paragraphs and the empty lines between them are just over the cap. As markdown, 44,000 short
// paragraphs encode to about 13 MB, under it, but with 76 code and HTML blocks whose payloads add about 15 MB the paste
// is over too. Both are refused visibly: nothing in the editor, the server or the collaborator's screen, the socket
// never closed, and the note stays editable.
//
// The notes and the reference imports are created through POST /api/docs as declared setup.
import { INPUT_REFUSAL_ATTR } from '../lib/contract.ts';
import { expectWire, exported, fingerprint, normalized, pastePlain, setup } from '../lib/paste.ts';
import { expect, test, ui } from '../lib/test.ts';

function shortParagraphs(count: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) lines.push(`p${i}`);
  return lines;
}

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

const PASTES: [string, () => string][] = [
  ['59,000 short paragraphs', () => [...shortParagraphs(59_000), 'Last line of the paste.'].join('\n\n')],
  ['44,000 short paragraphs with 76 code and HTML blocks of 200 KB each', () => {
    const blocks: string[] = [];
    for (let b = 0; b < 38; b += 1) {
      blocks.push(fence('js', 200_000, (i) => `const value${b}_${i} = ${i};`));
      blocks.push(fence('moss-html', 200_000, (i) => `<p>block ${b} line ${i}</p>`));
    }
    return [...shortParagraphs(44_000), ...blocks, 'Last line of the paste.'].join('\n\n');
  }],
];

for (const [label, make] of PASTES) {
  test(`j01-paste-cap: ${label}, just past the note’s size cap, are refused whole and visibly, nothing applied @p:col-1`, async ({ actors, stack }) => {
    test.setTimeout(300_000);
    const { ada, ben, docId, wire } = await setup(actors, stack, 'Kept.');
    await ui.waitAcked(ada, docId, 30_000);
    const before = await exported(ada, docId);
    const print = await fingerprint(ada, docId);
    await ui.body(ada, docId).locator('p').filter({ hasText: /^Kept\.$/ }).click();
    await ada.page.keyboard.press('End');
    await pastePlain(ada, docId, make());
    await expect(ada.page.locator(`[${INPUT_REFUSAL_ATTR}]`), 'the refusal is announced').toContainText('size limit', { timeout: 120_000 });
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
}
