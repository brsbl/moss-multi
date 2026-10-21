// j16-paste-undo (T5.S10; docs/design/suggestions.md §4.4, §4.7): the undo of a paste that split a paragraph, and of
// an Enter, restores the paragraph's rest as copies. The record then reads as the body: nothing is painted for either
// side, and the idle check rejects it.
import type { Actor } from '../lib/actors.ts';
import { BODY_BINDING_ATTR, SUGGEST_MARK_ATTR, SUGGESTIONS_BUTTON_ATTR } from '../lib/contract.ts';
import { suggesting } from '../lib/suggest-paste.ts';
import { BIND_TIMEOUT, caret, mod, openIn, painted, settled } from '../lib/suggest.ts';
import { expect, test, ui } from '../lib/test.ts';

/** A real clipboard paste of HTML with its plain-text flavor, as from a browser page. */
const pasteRich = (actor: Actor, docId: string, html: string, plain: string) =>
  ui.body(actor, docId).evaluate((element, [h, p]) => {
    const data = new DataTransfer();
    data.setData('text/html', h);
    data.setData('text/plain', p);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, [html, plain] as const);

test('j16-paste-undo: an undone paste inside a paragraph, and an undone Enter, leave nothing suggested: nothing painted for either side, and no pending suggestion once idle @p:mean-2 @p:R17', async ({ actors }) => {
  test.setTimeout(240_000);
  actors.solo('the owner seeds the note and reviews; one suggester pastes');
  const { ada, ben, docId } = await suggesting(actors, 'Ada original line.\n\nSecond line here.');
  const body = ui.body(ben, docId);
  await caret(ben, docId, 'original', 0, 8);
  // About 9 KB of rich HTML in two paragraphs: the paste splits "Ada original line." after the struck word.
  const plain = `Rich one ${'r'.repeat(4_000)}\nRich two ${'s'.repeat(4_000)}`;
  await pasteRich(ben, docId, `<p>Rich one <b>${'r'.repeat(4_000)}</b></p><p>Rich two ${'s'.repeat(4_000)}</p>`, plain);
  await settled(ben, docId, 'the paste');
  await expect.poll(() => painted(ben, 'suggest-delete'), { message: 'the selection is struck' }).toEqual(['original']);
  await expect(body).toContainText('Rich two sss');

  await ben.page.keyboard.press(`${mod}+z`);
  await settled(ben, docId, 'the undo');
  await expect(body, 'one undo takes the paste back').not.toContainText('Rich');
  await expect(body).toContainText('Ada original line.');
  await expect.poll(() => painted(ben, 'suggest-delete'), { message: 'and the strike' }).toEqual([]);
  await expect.poll(() => painted(ben, 'suggest-insert'), { message: 'the paragraph\'s rest is not painted as inserted' }).toEqual([]);

  await ben.page.keyboard.press(`${mod}+Shift+z`);
  await settled(ben, docId, 'the redo');
  await expect(body, 'one redo brings the paste back').toContainText('Rich two sss');
  await expect.poll(() => painted(ben, 'suggest-delete'), { message: 'and the strike' }).toEqual(['original']);
  await ben.page.keyboard.press(`${mod}+z`);
  await settled(ben, docId, 'the second undo');
  await expect(body).not.toContainText('Rich');
  await expect.poll(() => painted(ben, 'suggest-insert'), { message: 'nothing painted after the second undo' }).toEqual([]);

  // The control: Enter mid-paragraph, then its undo.
  await caret(ben, docId, 'Second line here.', 6);
  await ben.page.keyboard.press('Enter');
  await settled(ben, docId, 'the Enter');
  await ben.page.keyboard.press(`${mod}+z`);
  await settled(ben, docId, 'the undo of Enter');
  await expect(body).toContainText('Second line here.');
  await expect.poll(() => painted(ben, 'suggest-insert'), { message: 'nothing painted after the undo of Enter' }).toEqual([]);
  await expect.poll(() => painted(ben, 'suggest-delete')).toEqual([]);

  // When the system closes his records, his pane rebuilds F from the body (a closed record leaves the fork): a new
  // session and a new body root, declared.
  ben.expectReconnects(2, docId);
  // The owner, in Edit mode, sees none of her words struck and no insert marks.
  await openIn(ada, docId, 'edit');
  await expect(ui.body(ada, docId)).toContainText('Ada original line.');
  await expect.poll(() => painted(ada, 'suggest-delete'), { message: 'nothing struck for the owner' }).toEqual([]);
  await expect(ui.pane(ada, docId).locator(`[${SUGGEST_MARK_ATTR}]`), 'no insert marks').toHaveCount(0);
  // A record that changes nothing is rejected by the system once idle: no pending suggestion is left.
  await expect(ada.page.locator(`[${SUGGESTIONS_BUTTON_ATTR}]`), 'no pending suggestion').toHaveAttribute('aria-label', 'Suggestions', { timeout: 120_000 });
  await expect(ben.page.locator(`[${SUGGESTIONS_BUTTON_ATTR}]`)).toHaveAttribute('aria-label', 'Suggestions', { timeout: BIND_TIMEOUT });
  await expect(ui.body(ben, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'live', { timeout: BIND_TIMEOUT });
  await expect(body).toContainText('Ada original line.');
  await expect.poll(() => painted(ben, 'suggest-insert')).toEqual([]);
  await ben.declareRemount(docId);
});


test('j16-paste-undo: after an undone Enter, typing in the restored rest suggests only what was typed: neither side sees the rest painted or struck @p:mean-2 @p:R17', async ({ actors }) => {
  test.setTimeout(180_000);
  actors.solo('the owner seeds the note and reviews; one suggester types');
  const { ada, ben, docId } = await suggesting(actors, 'Ada original line.\n\nSecond line here.');
  const body = ui.body(ben, docId);
  await caret(ben, docId, 'Ada original line.', 4);
  await ben.page.keyboard.press('Enter');
  await settled(ben, docId, 'the Enter');
  await ben.page.keyboard.press(`${mod}+z`);
  await settled(ben, docId, 'the undo of Enter');
  await expect(body).toContainText('Ada original line.');
  await caret(ben, docId, 'line.', 5);
  await ben.page.keyboard.type('!');
  await settled(ben, docId, 'the typed character');
  await expect(body).toContainText('Ada original line.!');
  await expect.poll(() => painted(ben, 'suggest-insert'), { message: 'only what he typed is painted' }).toEqual(['!']);
  await expect.poll(() => painted(ben, 'suggest-delete')).toEqual([]);

  await openIn(ada, docId, 'edit');
  await expect(ui.body(ada, docId)).toContainText('Ada original line.');
  await expect(ui.pane(ada, docId).locator(`[${SUGGEST_MARK_ATTR}="insert"]`), 'one insert mark').toHaveCount(1);
  await expect(ui.pane(ada, docId).locator(`[${SUGGEST_MARK_ATTR}="insert"]`), 'for what he typed').toHaveAttribute('aria-label', 'Suggested insert: !');
  await expect.poll(() => painted(ada, 'suggest-delete'), { message: 'none of her words struck' }).toEqual([]);
});
