// j01-caret (T9.47): Ada turns the paragraph Ben's caret waits in into a heading, a bullet, a checkbox or a quote, or
// presses Enter before his caret, and his next key lands beside the words his caret was on, in both windows. A word
// Ben selected stays selected. Enter at or after his caret leaves it where it was, as before.
import type { Locator } from '@playwright/test';
import type { Actor } from '../lib/actors.ts';
import { between, caretNote, converged, lines, park, pick, PEER_TIMEOUT, PREVIOUS, TARGET } from '../lib/caret-note.ts';
import { expect, test, ui } from '../lib/test.ts';

/** Ben's key `X`, then the lines from just after `after` up to `before`, exactly, in both windows. */
async function typeAndExpect(ada: Actor, ben: Actor, id: string, after: string, before: string | null, want: string[]) {
  await ben.page.keyboard.type('X');
  await expect.poll(() => between(ben, id, after, before), { message: "Ben's key lands beside the words his caret was on", timeout: PEER_TIMEOUT }).toEqual(want);
  await converged(ada, ben, id);
  expect(await between(ada, id, after, before), 'Ada sees it there too').toEqual(want);
  for (const actor of [ada, ben]) expect((await lines(actor, id))[0], 'the paragraph above is untouched').toBe(PREVIOUS);
}

interface Conversion { name: string; act: (ada: Actor, id: string) => Promise<void>; seen: (body: Locator) => Locator }
const item = (body: Locator) => body.locator('li').filter({ hasText: 'Target paragraph' });
const CONVERSIONS: Conversion[] = [
  { name: 'J1 Heading 2', act: (ada) => pick(ada, 'Heading level', 'Heading 2'), seen: (body) => body.locator('h2').filter({ hasText: 'Target paragraph' }) },
  { name: 'J2 Bullet', act: (ada) => pick(ada, 'List type', 'Bullet'), seen: item },
  { name: 'J3 Insert checkbox', act: (ada) => ada.page.getByRole('button', { name: 'Insert checkbox', exact: true }).click(), seen: item },
  {
    name: 'J4 "> " typed at the start',
    act: async (ada, id) => { await park(ada, id, TARGET, TARGET.length); await ada.page.keyboard.type('> '); },
    seen: (body) => body.locator('blockquote').filter({ hasText: 'Target paragraph' }),
  },
];

for (const c of CONVERSIONS) {
  test(`j01 caret: ${c.name} under Ben's idle caret keeps his next key beside its words @p:col-1`, async ({ actors, stack }) => {
    const { ada, ben, id } = await caretNote(actors, stack.baseUrl);
    await park(ben, id, TARGET, 7);
    await park(ada, id, TARGET, 27);
    await c.act(ada, id);
    await expect(c.seen(ui.body(ben, id)), "Ada's change reaches Ben").toHaveCount(1, { timeout: PEER_TIMEOUT });
    await typeAndExpect(ada, ben, id, PREVIOUS, 'First item', ['Target paragraph where BenX waits.']);
    await expect(c.seen(ui.body(ben, id)), 'in the new block').toHaveText('Target paragraph where BenX waits.');
  });
}

const ENTERS: { name: string; block: string; ben: number; ada: number; after: string; before: string | null; want: string[] }[] = [
  { name: "J5 Ada's Enter after \"Target\"", block: TARGET, ben: 7, ada: 27, after: PREVIOUS, before: 'First item', want: ['Target', ' paragraph where BenX waits.'] },
  { name: "J6 Ada's Enter in a list item", block: 'Item where Ben waits too', ben: 10, ada: 20, after: 'First item', before: 'Head', want: ['Item', ' where BenX waits too'] },
  { name: "J7 Ada's Enter in a table cell", block: 'Cell where Ben waits', ben: 6, ada: 16, after: 'More', before: 'x', want: ['Cell', ' where BenX waits'] },
  { name: "J8 Ada's Enter exactly at Ben's caret (as before)", block: TARGET, ben: 7, ada: 7, after: PREVIOUS, before: 'First item', want: ['Target paragraph where BenX', ' waits.'] },
  { name: "J8b Ada's Enter after Ben's caret (as before)", block: TARGET, ben: 7, ada: 3, after: PREVIOUS, before: 'First item', want: ['Target paragraph where BenX wai', 'ts.'] },
];
for (const c of ENTERS) {
  test(`j01 caret: ${c.name}, and Ben's next key lands beside his words @p:col-1`, async ({ actors, stack }) => {
    const { ada, ben, id } = await caretNote(actors, stack.baseUrl);
    await park(ben, id, c.block, c.ben);
    await park(ada, id, c.block, c.ada);
    const count = (await lines(ben, id)).length;
    await ada.page.keyboard.press('Enter');
    await expect.poll(async () => (await lines(ben, id)).length, { message: "Ada's Enter reaches Ben", timeout: PEER_TIMEOUT }).toBe(count + 1);
    await typeAndExpect(ada, ben, id, c.after, c.before, c.want);
    // A caret in a table shows its column handles; leave it, as the editing journeys do.
    for (const actor of [ada, ben]) await ui.title(actor, id).click();
  });
}

test("j01 caret: J9 Ada's window draws Ben's caret in the new heading, and her next keystroke elsewhere leaves it there @p:col-1", async ({ actors, stack }) => {
  const { ada, ben, id } = await caretNote(actors, stack.baseUrl);
  await park(ben, id, TARGET, 7);
  await park(ada, id, TARGET, 27);
  await pick(ada, 'Heading level', 'Heading 2');
  const h2 = (actor: Actor) => ui.body(actor, id).locator('h2').filter({ hasText: 'Target paragraph' });
  await expect(h2(ben)).toHaveCount(1, { timeout: PEER_TIMEOUT });
  const remote = ada.page.locator('[data-remote-caret]').filter({ has: ada.page.locator('[data-cursor-label]', { hasText: ben.principal!.name }) });
  await expect.poll(async () => {
    const [caret, block] = [await remote.boundingBox(), await h2(ada).boundingBox()];
    return !!caret && !!block && caret.y + caret.height / 2 > block.y && caret.y + caret.height / 2 < block.y + block.height;
  }, { message: "Ben's caret is drawn inside the heading in Ada's window", timeout: PEER_TIMEOUT }).toBe(true);
  // Ada's key reaches Ben before his own first key: the binding re-reads his caret from awareness then.
  await park(ada, id, PREVIOUS, 0);
  await ada.page.keyboard.type('q');
  await expect.poll(async () => (await lines(ben, id))[0], { timeout: PEER_TIMEOUT }).toBe(`${PREVIOUS}q`);
  await ben.page.keyboard.type('X');
  await expect(h2(ben)).toHaveText('Target paragraph where BenX waits.');
  await converged(ada, ben, id);
  await expect(h2(ada)).toHaveText('Target paragraph where BenX waits.');
});

test("j01 caret: J10 a word Ben selected stays selected through Ada's Heading 2, and his key replaces it @p:col-1", async ({ actors, stack }) => {
  const { ada, ben, id } = await caretNote(actors, stack.baseUrl);
  await park(ben, id, TARGET, 10, 7);
  await park(ada, id, TARGET, 27);
  await pick(ada, 'Heading level', 'Heading 2');
  await expect(ui.body(ben, id).locator('h2'), "Ada's change reaches Ben").toHaveCount(1, { timeout: PEER_TIMEOUT });
  await typeAndExpect(ada, ben, id, PREVIOUS, 'First item', ['Target paragraph where X waits.']);
});

test("j01 caret: J11 a word Ben selected stays selected through Ada's Enter directly before it, and her break stays @p:col-1", async ({ actors, stack }) => {
  const { ada, ben, id } = await caretNote(actors, stack.baseUrl);
  await park(ben, id, TARGET, 10, 7);
  await park(ada, id, TARGET, 10);
  const count = (await lines(ben, id)).length;
  await ada.page.keyboard.press('Enter');
  await expect.poll(async () => (await lines(ben, id)).length, { message: "Ada's Enter reaches Ben", timeout: PEER_TIMEOUT }).toBe(count + 1);
  await typeAndExpect(ada, ben, id, PREVIOUS, 'First item', ['Target paragraph where ', 'X waits.']);
});
