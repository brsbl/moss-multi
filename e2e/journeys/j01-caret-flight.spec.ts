// j01-caret-flight (T9.47): Ben's keys are still on their way to the server when Ada's block change reaches him. His
// caret stays on his words; keys the stored layout cannot keep are absent in both windows, exactly as before
// (storage limit, PROGRESS.md T9.47). Ben's frames are held with sever.hold and delivered after, never raced.
import type { Locator } from '@playwright/test';
import type { Actor } from '../lib/actors.ts';
import { between, caretNote, converged, lines, park, pick, PEER_TIMEOUT, PREVIOUS, TARGET } from '../lib/caret-note.ts';
import { expect, test, ui } from '../lib/test.ts';

const item = (body: Locator) => body.locator('li').filter({ hasText: 'Target paragraph' });
const h2 = (body: Locator) => body.locator('h2').filter({ hasText: 'Target paragraph' });
const checkbox = (ada: Actor) => ada.page.getByRole('button', { name: 'Insert checkbox', exact: true }).click();

/** Lines from just after the paragraph above to the list, exactly, in both windows once they converge. */
async function expectTarget(ada: Actor, ben: Actor, id: string, want: string[]) {
  await expect.poll(() => between(ben, id, PREVIOUS, 'First item'), { message: 'Ben\'s window', timeout: PEER_TIMEOUT }).toEqual(want);
  await converged(ada, ben, id);
  expect(await between(ada, id, PREVIOUS, 'First item'), "Ada's window").toEqual(want);
  for (const actor of [ada, ben]) expect((await lines(actor, id))[0], 'the paragraph above is untouched').toBe(PREVIOUS);
}

interface Flight {
  name: string; back: number;
  keys: (ben: Actor) => Promise<void>;
  act: (ada: Actor) => Promise<void>;
  seen: (ben: Actor, id: string) => Promise<void>;
  want: string[];
}
const reaches = (block: (body: Locator) => Locator) => async (ben: Actor, id: string) => {
  await expect(block(ui.body(ben, id)), "Ada's change reaches Ben").toHaveCount(1, { timeout: PEER_TIMEOUT });
};
const split = async (ben: Actor, id: string) => {
  await expect.poll(() => between(ben, id, PREVIOUS, 'First item'), { message: "Ada's Enter reaches Ben", timeout: PEER_TIMEOUT }).toHaveLength(2);
};
const FLIGHTS: Flight[] = [
  // storage limit, PROGRESS.md T9.47: abc is absent.
  { name: 'K1 abc unsent when Ada\'s checkbox arrives', back: 7, keys: (ben) => ben.page.keyboard.type('abc'), act: checkbox, seen: reaches(item), want: ['Target paragraph where BenX waits.'] },
  // storage limit, PROGRESS.md T9.47: the twelve keys are absent.
  {
    name: 'K2 twelve keys unsent when Ada\'s Heading 2 arrives', back: 7, keys: (ben) => ben.page.keyboard.type('abcdefghijkl'),
    act: (ada) => pick(ada, 'Heading level', 'Heading 2'), seen: reaches(h2), want: ['Target paragraph where BenX waits.'],
  },
  // storage limit, PROGRESS.md T9.47: the deleted characters are back.
  {
    name: 'K3 two Backspaces unsent when Ada\'s checkbox arrives', back: 7,
    keys: async (ben) => { await ben.page.keyboard.press('Backspace'); await ben.page.keyboard.press('Backspace'); },
    act: checkbox, seen: reaches(item), want: ['Target paragraph where BenX waits.'],
  },
  // storage limit, PROGRESS.md T9.47: abc stays at the end of the first block.
  { name: 'K4 abc unsent when Ada\'s Enter after "Target" arrives', back: 7, keys: (ben) => ben.page.keyboard.type('abc'), act: (ada) => ada.page.keyboard.press('Enter'), seen: split, want: ['Targetabc', ' paragraph where BenX waits.'] },
  // storage limit, PROGRESS.md T9.47: " and" is absent.
  {
    name: 'K5 " and" unsent at the end of the line when Ada\'s Heading 2 arrives', back: 0, keys: (ben) => ben.page.keyboard.type(' and'),
    act: (ada) => pick(ada, 'Heading level', 'Heading 2'), seen: reaches(h2), want: ['Target paragraph where Ben waits.X'],
  },
  { name: 'K6 abc unsent at the end of the line when Ada\'s Enter after "Target" arrives (as before)', back: 0, keys: (ben) => ben.page.keyboard.type('abc'), act: (ada) => ada.page.keyboard.press('Enter'), seen: split, want: ['TargetabcX', ' paragraph where Ben waits.'] },
];

for (const c of FLIGHTS) {
  test(`j01 caret flight: ${c.name}: Ben's next key lands on his words @p:col-1`, async ({ actors, stack }) => {
    const { ada, ben, id } = await caretNote(actors, stack.baseUrl, { severable: true });
    const sever = ben.sever;
    if (!sever) throw new Error('declared setup: Ben is severable');
    await park(ben, id, TARGET, c.back);
    await park(ada, id, TARGET, 27);
    sever.hold(id);
    await c.keys(ben);
    await c.act(ada);
    await c.seen(ben, id);
    sever.deliverHeld();
    await ben.page.keyboard.type('X');
    await expectTarget(ada, ben, id, c.want);
  });
}

test("j01 caret flight: K7 Ada types \"- \" at Ben's idle caret at the start of his line, and his key starts the new bullet @p:col-1", async ({ actors, stack }) => {
  const { ada, ben, id } = await caretNote(actors, stack.baseUrl);
  await park(ben, id, TARGET, TARGET.length);
  await park(ada, id, TARGET, TARGET.length);
  await ada.page.keyboard.type('- ');
  await expect(item(ui.body(ben, id)), "Ada's bullet reaches Ben").toHaveCount(1, { timeout: PEER_TIMEOUT });
  await ben.page.keyboard.type('X');
  await expectTarget(ada, ben, id, ['XTarget paragraph where Ben waits.']);
  for (const actor of [ada, ben]) expect((await lines(actor, id)).some(line => line.includes('- ')), 'no "- " anywhere').toBe(false);
});

test("j01 caret flight: K8 Ben's socket goes dark while Ada types zz at his caret and makes a checkbox; on reconnect his key follows zz @p:col-1", async ({ actors, stack }) => {
  const { ada, ben, id } = await caretNote(actors, stack.baseUrl, { severable: true });
  const sever = ben.sever;
  if (!sever) throw new Error('declared setup: Ben is severable');
  await park(ben, id, TARGET, 7);
  await park(ada, id, TARGET, 7);
  sever.blackhole();
  await ada.page.keyboard.type('zz');
  await checkbox(ada);
  await expect(item(ui.body(ada, id))).toHaveText('Target paragraph where Benzz waits.');
  // The reconnect brings both of Ada's changes in one sync.
  sever.reset();
  sever.restore();
  await expect(item(ui.body(ben, id)), "Ada's changes reach Ben on reconnect").toHaveCount(1, { timeout: 30_000 });
  await ben.page.keyboard.type('X');
  await expectTarget(ada, ben, id, ['Target paragraph where BenzzX waits.']);
});
