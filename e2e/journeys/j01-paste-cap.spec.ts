// j01-paste-cap (T3.S6): a paste just past the note's size cap (A§5.1) is refused whole, before any of it is applied.
// The DocDO counts a note's state and its payload docs (code, HTML, formula, chart and sketch fields) against the cap
// and refuses the write that crosses it; a paste sent in pieces would land up to there and lose the rest. As plain
// text, 59,000 short paragraphs and the empty lines between them are just over the cap. As markdown, 44,000 short
// paragraphs encode to about 13 MB, under it, but with 76 code and HTML blocks whose payloads add about 15 MB the paste
// is over too. A chart whose payload needs a frame past the frame cap cannot be sent at all. Each is refused visibly:
// nothing in the editor, the server or the collaborator's screen, the socket never closed, and the note stays editable.
//
// The notes and the reference imports are created through POST /api/docs as declared setup.
import { expectRefusedPaste, fence, setup } from '../lib/paste.ts';
import { test } from '../lib/test.ts';

function shortParagraphs(count: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) lines.push(`p${i}`);
  return lines;
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

// A chart's payload is a Y.Map of one key per position, key list and leaf, several times its JSON, and it goes out as
// one frame: a bar chart of 30,000 points is about 720 KB of JSON and over 4 MB of keys, past the frame cap.
test('j01-paste-cap: a chart whose payload cannot go in one frame is refused whole and visibly, nothing applied @p:col-1', async ({ actors, stack }) => {
  test.setTimeout(300_000);
  const data = Array.from({ length: 30_000 }, () => ({ label: 'x', value: 1 }));
  await expectRefusedPaste(await setup(actors, stack, 'Kept.'), stack, `Before the chart.\n\n\`\`\`moss-chart\n${JSON.stringify({ type: 'bar', data })}\n\`\`\`\n\nAfter the chart.`);
});

for (const [label, make] of PASTES) {
  test(`j01-paste-cap: ${label}, just past the note’s size cap, are refused whole and visibly, nothing applied @p:col-1`, async ({ actors, stack }) => {
    test.setTimeout(300_000);
    await expectRefusedPaste(await setup(actors, stack, 'Kept.'), stack, make());
  });
}
