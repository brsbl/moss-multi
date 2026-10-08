// j01-paste-race (T3.S6): a large paste is checked against the note's cap before any of it lands, which takes a
// while, and a collaborator's edits keep arriving meanwhile. The paste lands where the caret is when it lands, moved
// by those edits, never at the caret's old offsets: a peer's "XY" typed before the caret's paragraph during the check
// split the word before the caret. Its redo then lands where the paste was, after a peer added a block above it,
// never at the old block index.
//
// The note and the reference imports are created through POST /api/docs as declared setup.
import type { LexicalEditor } from 'lexical';
import { exported, NEW_STEP_MS, normalized, pastePlain, REDO, setup, UNDO } from '../lib/paste.ts';
import { expect, test, ui } from '../lib/test.ts';

test('j01-paste-race: a peer’s edit during a large paste’s check moves the paste with the caret, and its redo lands where it was after a block is added above @p:col-1 @p:col-3', async ({ actors, stack }) => {
  test.setTimeout(600_000);
  const lines = Array.from({ length: 20_000 }, (_, i) => `Race line ${i}.`);
  const { ada, ben, docId } = await setup(actors, stack, 'Top.\n\nHello world here.\n\nTail.', { severablePeer: true });
  const pasted = lines.join('\n\n');
  const want = {
    whole: await normalized(ada, stack, `Top.\n\nXYHello world here.${pasted}\n\nTail.`),
    undone: await normalized(ada, stack, 'Top.\n\nXYHello world here.\n\nTail.'),
    redone: await normalized(ada, stack, `Top.\n\nBen’s line.\n\nXYHello world here.${pasted}\n\nTail.`),
  };

  // Ben's "XY" at the start of the paragraph waits in flight until Ada has pasted at its end.
  await ui.body(ben, docId).locator('p').filter({ hasText: /^Hello world here\.$/ }).click();
  await ben.page.keyboard.press('Home');
  ben.sever!.hold(docId);
  await ben.page.keyboard.type('XY');
  await ui.body(ada, docId).locator('p').filter({ hasText: /^Hello world here\.$/ }).click();
  await ada.page.keyboard.press('End');
  // How many of the paste's batches were placed when Ben's edit reached Ada's editor.
  await ui.body(ada, docId).evaluate((element) => {
    const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
    const probe = window as unknown as { __peerSeenAt: number | null };
    probe.__peerSeenAt = null;
    const stop = editor.registerUpdateListener(({ editorState }) => {
      const first = editorState.read(() => editorState._nodeMap.get('root')!.getTextContent().slice(0, 64));
      if (!first.includes('XYHello')) return;
      probe.__peerSeenAt = performance.getEntriesByType('measure').filter((entry) => entry.name === 'moss-paste-batch').length;
      stop();
    });
  });
  await pastePlain(ada, docId, lines.join('\n'));
  ben.sever!.deliverHeld();
  await ada.page.waitForFunction(() => (window as unknown as { __peerSeenAt: number | null }).__peerSeenAt !== null, undefined, { timeout: 120_000 });
  const seen = await ada.page.evaluate(() => (window as unknown as { __peerSeenAt: number }).__peerSeenAt);
  expect(seen, 'Ben’s edit reached Ada before any of the paste was placed').toBe(0);

  await ui.waitAcked(ben, docId, 120_000);
  await ui.waitAcked(ada, docId, 300_000);
  await expect.poll(() => exported(ada, docId), { message: 'the paste lands where the caret was moved to, Ben’s edit kept', timeout: 120_000 }).toBe(want.whole);

  await ada.page.waitForTimeout(NEW_STEP_MS);
  await ada.page.keyboard.press(UNDO);
  await ui.waitAcked(ada, docId, 120_000);
  await expect.poll(() => exported(ada, docId), { message: 'one undo removes the paste and keeps Ben’s edit', timeout: 120_000 }).toBe(want.undone);

  // Ben adds a block above the paste's paragraph; Ada's redo still lands in that paragraph.
  await ui.body(ben, docId).locator('p').filter({ hasText: /^Top\.$/ }).click();
  await ben.page.keyboard.press('End');
  await ben.page.keyboard.press('Enter');
  await ben.page.keyboard.type('Ben’s line.');
  await ui.waitAcked(ben, docId, 60_000);
  await expect(ui.body(ada, docId).locator('p').filter({ hasText: /^Ben’s line\.$/ }), 'Ada has Ben’s new block').toHaveCount(1, { timeout: 60_000 });
  await ada.page.keyboard.press(REDO);
  await ui.waitAcked(ada, docId, 300_000);
  await expect.poll(() => exported(ada, docId), { message: 'the redo lands where the paste was, below Ben’s new block', timeout: 120_000 }).toBe(want.redone);
});
