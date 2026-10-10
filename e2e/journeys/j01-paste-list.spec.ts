// j01-paste-list (T3.S6): one large list pasted lands whole. A 30,000-item list is a single top-level block of about
// 10 MB of Yjs state: the doc socket sent it as one frame, the DocDO closed the socket 1013 on every resend, and
// nothing reached the server; Chromium also held the tab for half a minute laying it out. Now the list lands in
// batches of items with the tab free between them, and goes out in frames within the client frame cap. A flat
// list between two paragraphs and a nested list in an empty note must land every item for the server and a
// collaborator, caret after the paste, one undo step that redoes whole, the socket never closing.
//
// The notes and the reference imports are created through POST /api/docs as declared setup.
import { MAX_STALL_MS, normalized, pasteAndCheck, setup } from '../lib/paste.ts';
import { expect, test, ui } from '../lib/test.ts';

/** `count` bullet items. */
function flatList(count: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) lines.push(`- item ${i}`);
  return lines.join('\n');
}

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

test('j01-paste-list: a 30,000-item list pasted between two paragraphs lands whole, in frames under the cap, without holding the tab, one undo step @p:col-1 @p:col-3', async ({ actors, stack }) => {
  test.setTimeout(900_000);
  const markdown = flatList(30_000);
  const { ada, ben, docId, wire } = await setup(actors, stack, 'Before.\n\nAfter.');
  const want = {
    whole: await normalized(ada, stack, `Before.\n\n${markdown}\n\nAfter.`),
    typed: await normalized(ada, stack, `Before.\n\n${markdown}Z\n\nAfter.`),
  };
  expect(want.whole.split('\n').filter((line) => line.startsWith('- item ')).length, 'the reference export holds every item').toBe(30_000);
  await ui.body(ada, docId).locator('p').filter({ hasText: /^Before\.$/ }).click();
  await ada.page.keyboard.press('End');
  await ada.page.keyboard.press('Enter');
  await pasteAndCheck({ ada, ben, docId, wire }, markdown, want, 300_000, { maxStallMs: MAX_STALL_MS });
});

test('j01-paste-list: a nested list of 22,800 items pasted into an empty note lands whole, in frames under the cap, without holding the tab, one undo step @p:col-1 @p:col-3', async ({ actors, stack }) => {
  test.setTimeout(900_000);
  const markdown = nestedList(1_200);
  const { ada, ben, docId, wire } = await setup(actors, stack);
  const want = { whole: await normalized(ada, stack, markdown), typed: await normalized(ada, stack, `${markdown}Z`) };
  expect(want.whole.split('\n').filter((line) => /^\s*- detail /.test(line)).length, 'the reference export holds every detail').toBe(14_400);
  await ui.body(ada, docId).click();
  await pasteAndCheck({ ada, ben, docId, wire }, markdown, want, 300_000, { maxStallMs: MAX_STALL_MS });
});
