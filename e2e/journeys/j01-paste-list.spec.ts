// j01-paste-list (T3.S6): one large list pasted lands whole. A 30,000-item list is a single top-level block of about
// 10 MB of Yjs state: the doc socket sent it as one frame, the DocDO closed the socket 1013 on every resend, and
// nothing reached the server; Chromium also held the tab for half a minute laying it out. Now the list lands in
// batches of items with the tab free between them, and goes out in frames within the client frame cap. A flat
// list between two paragraphs must land every item for the server and a collaborator, caret after the paste, one undo
// step that redoes whole, the socket never closing. The nested list is j01-paste-nested, on a stack of its own.
//
// The notes and the reference imports are created through POST /api/docs as declared setup.
import { MAX_STALL_MS, pasteAndCheck, setup } from '../lib/paste.ts';
import { flatList } from '../lib/large-notes.ts';
import { expect, test, ui } from '../lib/test.ts';

test('j01-paste-list: a 30,000-item list pasted between two paragraphs lands whole, in frames under the cap, without holding the tab, one undo step @p:col-1 @p:col-3', async ({ actors, stack }) => {
  test.setTimeout(900_000);
  const markdown = flatList(30_000);
  const { ada, ben, docId, wire, want } = await setup(actors, stack, 'Before.\n\nAfter.', {
    references: { whole: `Before.\n\n${markdown}\n\nAfter.`, typed: `Before.\n\n${markdown}Z\n\nAfter.` },
  });
  expect(want.whole.split('\n').filter((line) => line.startsWith('- item ')).length, 'the reference export holds every item').toBe(30_000);
  await ui.body(ada, docId).locator('p').filter({ hasText: /^Before\.$/ }).click();
  await ada.page.keyboard.press('End');
  await ada.page.keyboard.press('Enter');
  await pasteAndCheck({ ada, ben, docId, wire }, markdown, want, 300_000, { maxStallMs: MAX_STALL_MS });
});
