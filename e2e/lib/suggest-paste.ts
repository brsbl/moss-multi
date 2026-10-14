// j16-paste helpers (T5.R2, T5.S10): a note owned by ada open in ben's window as a suggester, and the check that a
// Suggest-mode paste is stored whole or refused whole, never admitted and then dropped.
import type { Actor } from './actors.ts';
import { INPUT_REFUSAL_ATTR, SUGGEST_SENT_ATTR } from './contract.ts';
import { grantDoc } from './grants.ts';
import { content, openIn, settled } from './suggest.ts';
import { expect, type test, ui } from './test.ts';

type Actors = Parameters<Parameters<typeof test>[2]>[0]['actors'];

/** A note owned by ada, open in ben's window as a suggester. */
export async function suggesting(actors: Actors, markdown: string) {
  const ada = await actors.open(await actors.principal('ada'));
  const response = await ada.context.request.post('/api/docs', { headers: { origin: new URL(ada.page.url()).origin }, data: { markdown } });
  expect(response.status()).toBe(201);
  const docId = ((await response.json()) as { doc: { id: string } }).doc.id;
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, 'suggester');
  const ben = await actors.session(benPrincipal);
  await openIn(ben, docId);
  await ben.observeEditor(docId);
  return { ada, ben, docId };
}

export const sent = async (actor: Actor, docId: string): Promise<number> => Number(await ui.pane(actor, docId).getAttribute(SUGGEST_SENT_ATTR));

/** The notice of a suggestion the DocDO closed after a refused frame. */
export const FORK_CLOSED = 'This suggestion was closed while you typed';

/** A real clipboard paste of HTML alone, as from a page that offers no plain-text flavor. */
export const pasteHtml = (actor: Actor, docId: string, html: string) =>
  ui.body(actor, docId).evaluate((element, h) => {
    const data = new DataTransfer();
    data.setData('text/html', h);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, html);

/**
 * A paste is never admitted and then dropped: it is refused whole, visibly, with nothing sent or changed, or it is one
 * frame the DocDO stores and acknowledges.
 */
export async function storedOrRefused(actor: Actor, ada: Actor, docId: string, paste: () => Promise<unknown>, expected?: string): Promise<'stored' | 'refused'> {
  const refusal = actor.page.locator(`[${INPUT_REFUSAL_ATTR}]`);
  const working = await content(ada, docId, 'working');
  const text = await ui.body(actor, docId).textContent();
  const before = await sent(actor, docId);
  await paste();
  await expect.poll(async () => ((await refusal.textContent()) ?? '').includes(' was added') || (await sent(actor, docId)) > before, { timeout: 60_000 }).toBe(true);
  if ((await sent(actor, docId)) === before) {
    await settled(actor, docId, 'the refused paste');
    expect(await sent(actor, docId), 'nothing was sent').toBe(before);
    expect(await ui.body(actor, docId).textContent(), 'nothing changed').toBe(text);
    expect(await content(ada, docId, 'working'), 'no suggestion was made').toBe(working);
    return 'refused';
  }
  await settled(actor, docId, 'the paste');
  await expect(actor.page.getByText(FORK_CLOSED), 'the suggestion stays open').toHaveCount(0);
  await expect.poll(() => content(ada, docId, 'working'), { message: 'the paste is a pending suggestion' }).not.toBe(working);
  if (expected !== undefined) expect(await content(ada, docId, 'working'), 'the whole paste is stored').toContain(expected);
  return 'stored';
}
