// j01-paste (T3.S6): a large markdown paste lands whole. Moss's plain-text paste split anything from 40,000 characters
// (or 800 lines) into chunks and dropped every chunk after the first, because the selection it inserted at was gone by
// the second. Pasting 40k, 200k and 2 MB of mixed markdown, into an empty note and between two paragraphs, must land
// every character (the doc's export equals the server's import of the same text, moss's normalization), leave the
// caret after the paste, make one undo step that redoes whole, and reach a collaborator in full. A second paste or a
// note switch while one lands, typing or an undo right after it, and a paste ending in a list lose nothing either.
//
// The notes and the reference imports are created through POST /api/docs as declared setup.
import { exported, fingerprint, NEW_STEP_MS, normalized, pasteAndCheck, pastePlain, setup, UNDO } from '../lib/paste.ts';
import { expect, test, ui } from '../lib/test.ts';

const LAST = 'Last line of the paste.';

const WORDS = ['moss', 'grows', 'on', 'the', 'north', 'side', 'of', 'old', 'stones', 'and', 'keeps', 'water', 'through', 'dry',
  'weeks', 'while', 'notes', 'collect', 'ideas', 'from', 'many', 'people', 'working', 'together', 'in', 'one', 'shared', 'document'];

/** A sentence of about `length` characters. */
function prose(seed: number, length: number): string {
  let out = '';
  for (let k = 0; out.length < length; k += 1) out += `${out ? ' ' : ''}${WORDS[(seed * 7 + k * 3) % WORDS.length]}`;
  return `${out[0].toUpperCase()}${out.slice(1)}.`;
}

/**
 * Mixed markdown of at least `size` characters, mostly prose as notes are: headings, inline formatting and links,
 * nested lists, checklists, ordered lists, quotes, tables and code. (Formatting every few words would encode past the
 * doc's state cap at 2 MB, A§5.1.)
 */
function mixedMarkdown(size: number): string {
  const parts = ['Pasted start.'];
  let length = parts[0].length;
  for (let i = 0; length < size; i += 1) {
    const section = [
      `## Section ${i}`,
      `${prose(i, 220)} It has **bold ${i}**, *italic ${i}* and \`code ${i}\`, then a [link ${i}](https://example.invalid/page/${i}). ${prose(i + 1, 220)}`,
      prose(i + 2, 420),
      `- ${prose(i + 3, 60)}\n- ${prose(i + 4, 60)}\n  - ${prose(i + 5, 40)}`,
      ...(i % 3 === 0 ? [`- [ ] open task ${i}\n- [x] done task ${i}`] : []),
      ...(i % 5 === 0 ? [`1. first ${i}\n2. second ${i}`] : []),
      `> ${prose(i + 6, 100)}`,
      ...(i % 4 === 0 ? [`| Name ${i} | Value ${i} |\n| --- | --- |\n| row ${i} | ${i * 7} |`] : []),
      ...(i % 10 === 0 ? [`\`\`\`js\nconst value${i} = ${i};\nconsole.log(value${i});\n\`\`\``] : []),
    ].join('\n\n');
    parts.push(section);
    length += section.length + 2;
  }
  parts.push(LAST);
  return parts.join('\n\n');
}

/** Bullet and numbered lists, alternating, of at least `size` characters, ending with a list of kind `last`. */
function listMarkdown(size: number, last: 'bullet' | 'numbered'): string {
  const parts: string[] = [];
  let length = 0;
  for (let i = 0; length < size || (parts.length % 2 === 0) !== (last === 'numbered'); i += 1) {
    const marker = (n: number) => (parts.length % 2 === 0 ? '-' : `${n}.`);
    const list = [0, 1, 2].map((n) => `${marker(n + 1)} ${prose(i + n, 50)} ${i}`).join('\n');
    parts.push(list);
    length += list.length + 2;
  }
  return parts.join('\n\n');
}


const SIZES: [string, number, number][] = [
  ['40k', 40_000, 60_000],
  ['200k', 200_000, 90_000],
  ['2 MB', 2_000_000, 240_000],
];

for (const [label, size, timeout] of SIZES) {
  test(`j01-paste: ${label} of mixed markdown pasted into an empty note lands whole, caret after it, one undo step, on both screens @p:col-1 @p:col-3`, async ({ actors, stack }) => {
    test.setTimeout(timeout * 3);
    const markdown = mixedMarkdown(size);
    const { ada, ben, docId } = await setup(actors, stack);
    const want = { whole: await normalized(ada, stack, markdown), typed: await normalized(ada, stack, `${markdown}Z`) };
    expect(want.whole.length, 'the reference export holds the paste').toBeGreaterThan(size * 0.8);
    await ui.body(ada, docId).click();
    await pasteAndCheck({ ada, ben, docId }, markdown, want, timeout);
  });
}

test('j01-paste: 200k of mixed markdown pasted between two paragraphs lands whole, caret after it, one undo step @p:col-1 @p:col-3', async ({ actors, stack }) => {
  test.setTimeout(300_000);
  const markdown = mixedMarkdown(200_000);
  const { ada, ben, docId } = await setup(actors, stack, 'Before.\n\nAfter.');
  const want = {
    whole: await normalized(ada, stack, `Before.\n\n${markdown}\n\nAfter.`),
    typed: await normalized(ada, stack, `Before.\n\n${markdown}Z\n\nAfter.`),
  };
  await ui.body(ada, docId).locator('p').filter({ hasText: /^Before\.$/ }).click();
  await ada.page.keyboard.press('End');
  await ada.page.keyboard.press('Enter');
  await pasteAndCheck({ ada, ben, docId }, markdown, want, 90_000);
});

test('j01-paste: a second large paste and a note switch while a 200k paste lands keep every character of both @p:col-1 @p:col-3', async ({ actors, stack }) => {
  test.setTimeout(300_000);
  const first = mixedMarkdown(200_000);
  const second = mixedMarkdown(45_000).replace('Pasted start.', 'Second paste.');
  const { ada, ben, docId, otherId } = await setup(actors, stack, undefined, { elsewhere: true });
  const whole = await normalized(ada, stack, `${first}${second}`);
  await ui.body(ada, docId).click();
  await pastePlain(ada, docId, first);
  await pastePlain(ada, docId, second);
  await ui.openNote(ada, otherId);
  await expect.poll(() => exported(ada, docId), { message: 'both pastes land whole after the pane closed', timeout: 90_000 }).toBe(whole);
  // Reopening the note is a second socket for it in this document.
  ada.expectReconnects(1, docId);
  await ui.openNote(ada, docId);
  // Both read again each time: the reopened pane loads its code blocks' payloads after it binds.
  await expect.poll(async () => {
    const [mine, theirs] = await Promise.all([fingerprint(ada, docId), fingerprint(ben, docId)]);
    return mine.length === theirs.length && mine.sum === theirs.sum;
  }, { message: 'the collaborator sees both pastes', timeout: 60_000 }).toBe(true);
});

test('j01-paste: a 200k paste ending in a list keeps its lists apart and in order @p:col-1', async ({ actors, stack }) => {
  test.setTimeout(300_000);
  for (const last of ['bullet', 'numbered'] as const) {
    const markdown = listMarkdown(200_000, last);
    const { ada, docId } = await setup(actors, stack);
    const whole = await normalized(ada, stack, markdown);
    await ui.body(ada, docId).click();
    await pastePlain(ada, docId, markdown);
    await ui.waitAcked(ada, docId, 90_000);
    await expect.poll(() => exported(ada, docId), { message: `a paste ending in a ${last} list lands as pasted`, timeout: 90_000 }).toBe(whole);
  }
});

test('j01-paste: typing right after a 200k paste is its own undo step @p:col-1 @p:col-3', async ({ actors, stack }) => {
  test.setTimeout(300_000);
  const markdown = mixedMarkdown(200_000);
  const { ada, ben, docId } = await setup(actors, stack);
  const want = { whole: await normalized(ada, stack, markdown), typed: await normalized(ada, stack, `${markdown}Q`) };
  const before = await exported(ada, docId);
  await ui.body(ada, docId).click();
  await pastePlain(ada, docId, markdown);
  await ada.page.keyboard.type('Q');
  await ui.waitAcked(ada, docId, 90_000);
  await expect.poll(() => exported(ada, docId), { message: 'the typing lands after the paste', timeout: 90_000 }).toBe(want.typed);
  await ada.page.waitForTimeout(NEW_STEP_MS);
  await ada.page.keyboard.press(UNDO);
  await ui.waitAcked(ada, docId, 90_000);
  await expect.poll(() => exported(ada, docId), { message: 'the first undo removes only the typing', timeout: 90_000 }).toBe(want.whole);
  await ada.page.keyboard.press(UNDO);
  await ui.waitAcked(ada, docId, 90_000);
  await expect.poll(() => exported(ada, docId), { message: 'the next undo removes the paste', timeout: 90_000 }).toBe(before);
  await ada.page.keyboard.type('R');
  await ui.waitAcked(ada, docId, 90_000);
  await ada.page.waitForTimeout(NEW_STEP_MS);
  await ada.page.keyboard.type('S');
  await ada.page.waitForTimeout(NEW_STEP_MS);
  await ada.page.keyboard.press(UNDO);
  await ui.waitAcked(ada, docId, 90_000);
  await expect.poll(() => exported(ada, docId), { message: 'later edits are separate undo steps again', timeout: 30_000 }).toBe(await normalized(ada, stack, 'R'));
  await expect.poll(() => fingerprint(ben, docId), { message: 'the collaborator agrees', timeout: 30_000 }).toEqual(await fingerprint(ada, docId));
});

test('j01-paste: an undo right after a 200k paste removes all of it, for good @p:col-1 @p:col-3', async ({ actors, stack }) => {
  test.setTimeout(300_000);
  const markdown = mixedMarkdown(200_000);
  const { ada, ben, docId } = await setup(actors, stack);
  const before = await exported(ada, docId);
  const empty = await fingerprint(ada, docId);
  await ui.body(ada, docId).click();
  await pastePlain(ada, docId, markdown);
  await ada.page.keyboard.press(UNDO);
  await ui.waitAcked(ada, docId, 90_000);
  await ada.page.waitForTimeout(5_000);
  await ui.waitAcked(ada, docId, 90_000);
  expect(await exported(ada, docId), 'nothing of the undone paste comes back').toBe(before);
  expect(await fingerprint(ada, docId), 'the editor holds nothing of it either').toEqual(empty);
  await expect.poll(() => fingerprint(ben, docId), { message: 'nor does the collaborator', timeout: 30_000 }).toEqual(empty);
});
