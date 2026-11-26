// j16-readouts (T9.50f; packages/protocol/src/dom-contract.ts): a Suggest pane's test readouts, data-suggest-sent and
// data-suggest-refused, are current at every moment data-sync-unacked goes from "1" to "0", after a typed character and
// after its native undo, and leave the pane with Suggest.
import type { Actor } from '../lib/actors.ts';
import { BODY_BINDING_ATTR, EDIT_MODE_ATTR, MODE_ROW_ATTR, SUGGEST_REFUSED_ATTR, SUGGEST_SENT_ATTR, SYNC_UNACKED_ATTR } from '../lib/contract.ts';
import { BIND_TIMEOUT, mod, settled } from '../lib/suggest.ts';
import { expect, test, ui } from '../lib/test.ts';

const SUGGEST = 'Suggest changes';

type Readouts = { sent: string | null; refused: string | null };
type ReadoutWatch = { settles: Readouts[]; changedAt: number };

/**
 * Records, on `docId`'s pane, the suggest readouts at each moment `data-sync-unacked` goes from "1" to "0", and when
 * a readout last changed. Records of one batch are replayed in order: a readout's value at a record is the old value
 * of its next change in the batch, or its value now.
 */
async function watchReadouts(actor: Actor, docId: string): Promise<void> {
  await ui.pane(actor, docId).evaluate((pane, names) => {
    const watch: ReadoutWatch = { settles: [], changedAt: performance.now() };
    (window as unknown as { readoutWatch: ReadoutWatch }).readoutWatch = watch;
    new MutationObserver((records) => {
      const after = (index: number, name: string) => records.slice(index + 1).find((record) => record.attributeName === name)?.oldValue ?? pane.getAttribute(name);
      records.forEach((record, index) => {
        if (record.attributeName !== names.unacked) {
          watch.changedAt = performance.now();
          return;
        }
        if (record.oldValue === '1' && after(index, names.unacked) === '0') watch.settles.push({ sent: after(index, names.sent), refused: after(index, names.refused) });
      });
    }).observe(pane, { attributes: true, attributeOldValue: true, attributeFilter: [names.unacked, names.sent, names.refused] });
  }, { unacked: SYNC_UNACKED_ATTR, sent: SUGGEST_SENT_ATTR, refused: SUGGEST_REFUSED_ATTR });
}

const readoutWatch = (actor: Actor): Promise<ReadoutWatch> => actor.page.evaluate(() => (window as unknown as { readoutWatch: ReadoutWatch }).readoutWatch);

/** After `act`, the pane settles once more, and the readouts it held then are the ones it keeps. */
async function settlesCurrent(actor: Actor, docId: string, what: string, act: () => Promise<void>): Promise<Readouts> {
  const seen = (await readoutWatch(actor)).settles.length;
  await act();
  await settled(actor, docId, what);
  // The readouts stop changing: none changed for 300 ms.
  await expect.poll(async () => actor.page.evaluate(() => performance.now() - (window as unknown as { readoutWatch: ReadoutWatch }).readoutWatch.changedAt), { message: `${what}: the readouts stop changing` }).toBeGreaterThan(300);
  const pane = ui.pane(actor, docId);
  const now: Readouts = { sent: await pane.getAttribute(SUGGEST_SENT_ATTR), refused: await pane.getAttribute(SUGGEST_REFUSED_ATTR) };
  const { settles } = await readoutWatch(actor);
  expect(settles.length, `${what}: the pane settled after it`).toBeGreaterThan(seen);
  expect(settles.at(-1), `${what}: the readouts were current when the pane settled`).toEqual(now);
  return now;
}

test('j16-suggest readouts: the sent and refused counts are current when the pane settles, and leave with Suggest @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner suggests on a note nobody else has open');
  const ada = await actors.open(await actors.principal('ada'));
  const docId = await ui.createNote(ada);
  await ui.typeTitle(ada, docId, 'Suggest readouts', { enter: true });
  await ui.typeBody(ada, docId, 'Owner text kept');
  const pane = ui.pane(ada, docId);
  const body = ui.body(ada, docId);
  await expect(pane).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });
  ada.expectReconnects(2, docId);
  await (await ui.openNoteMenu(ada, docId)).getByRole('menuitem', { name: SUGGEST, exact: true }).click();
  await expect(pane).toHaveAttribute(EDIT_MODE_ATTR, 'suggest', { timeout: BIND_TIMEOUT });
  await expect(body).toHaveAttribute(BODY_BINDING_ATTR, 'live', { timeout: BIND_TIMEOUT });
  await ada.declareRemount(docId);
  await expect(pane).toHaveAttribute(SUGGEST_SENT_ATTR, '0');
  await expect(body, 'the caret is back in the body').toBeFocused({ timeout: BIND_TIMEOUT });
  await watchReadouts(ada, docId);

  const typed = await settlesCurrent(ada, docId, 'one typed character', () => ada.page.keyboard.type('q'));
  expect(Number(typed.sent), 'the character is sent').toBeGreaterThan(0);
  await expect(body).toContainText('q');
  const undone = await settlesCurrent(ada, docId, 'its native undo', () => ada.page.keyboard.press(`${mod}+z`));
  expect(Number(undone.sent), 'the undo is sent').toBeGreaterThan(Number(typed.sent));
  await expect(body).toHaveText('Owner text kept');

  // Leaving Suggest takes both readouts off the pane.
  await ada.page.locator(`[${MODE_ROW_ATTR}]`).getByRole('button', { name: 'Stop suggesting', exact: true }).click();
  await expect(pane).toHaveAttribute(EDIT_MODE_ATTR, 'edit', { timeout: BIND_TIMEOUT });
  await expect(body).toHaveAttribute(BODY_BINDING_ATTR, 'live', { timeout: BIND_TIMEOUT });
  await ada.declareRemount(docId);
  await expect(pane).not.toHaveAttribute(SUGGEST_SENT_ATTR);
  await expect(pane).not.toHaveAttribute(SUGGEST_REFUSED_ATTR);
});
