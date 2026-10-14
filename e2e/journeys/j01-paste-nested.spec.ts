// j01-paste-nested (T3.S6): the nested half of j01-paste-list, on a stack of its own. A 22,800-item nested list pasted
// into an empty note lands every item for the server and a collaborator, in frames under the cap, without holding the
// tab, one undo step that redoes whole. Its own file keeps it off the stack that just held j01-paste-list's 10 MB note.
//
// The note and the reference imports are created through POST /api/docs as declared setup.
import { MAX_STALL_MS, pasteAndCheck, setup } from '../lib/paste.ts';
import { expect, test, ui } from '../lib/test.ts';

/** `count` bullet items, each with six points of two details each: 19 items per top-level item. */
function nestedList(count: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(`- topic ${i}`);
    for (let j = 0; j < 6; j += 1) {
      lines.push(`  - point ${i}.${j}`);
      for (let k = 0; k < 2; k += 1) lines.push(`    - detail ${i}.${j}.${k}`);
    }
  }
  return lines.join('\n');
}

test('j01-paste-nested: a nested list of 22,800 items pasted into an empty note lands whole, in frames under the cap, without holding the tab, one undo step @p:col-1 @p:col-3', async ({ actors, stack }) => {
  test.setTimeout(900_000);
  const markdown = nestedList(1_200);
  const { ada, ben, docId, wire, want } = await setup(actors, stack, undefined, { references: { whole: markdown, typed: `${markdown}Z` } });
  expect(want.whole.split('\n').filter((line) => /^\s*- detail /.test(line)).length, 'the reference export holds every detail').toBe(14_400);
  await ui.body(ada, docId).click();
  await pasteAndCheck({ ada, ben, docId, wire }, markdown, want, 300_000, { maxStallMs: MAX_STALL_MS });
});
