// j16-suggest (T5.1; docs/design/suggestions.md §5, §7, §8, PRODUCT ruling 17): Suggest mode in the real app. A solo
// owner with nothing selected toggles Suggest in the docked toolbar and the caret stays where it was; a principal
// shared as suggester through the dialog opens locked to the "Suggesting" chip; on a cold load a suggester's first
// delete leaves the text on the server and paints it struck, and a viewer opens in Review and sees it; explicit
// deletes strike exactly the original characters (past an inline link, over mixed own and original text) and undo
// takes a strike back; two windows of one suggester show each other's suggestions live; an IME composition in a code
// register is recorded; suggestions typed offline reach the server after the suggester navigates away; and every
// census operation, made through the real UI, is recorded with no refusal.
import type { Locator } from '@playwright/test';
import type { Actor } from '../lib/actors.ts';
import {
  APP_STATE_ATTR, BODY_BINDING_ATTR, EDIT_MODE_ATTR, FLOATING_TOOLBAR_ATTR, NAMES, SUGGEST_CHIP_ATTR, SUGGEST_REFUSED_ATTR,
  SUGGEST_SENT_ATTR, SYNC_UNACKED_ATTR, TITLE_BINDING_ATTR,
} from '../lib/contract.ts';
import { grantDoc } from '../lib/grants.ts';
import { expect, test, ui } from '../lib/test.ts';

const BOOT_TIMEOUT = 30_000;
const BIND_TIMEOUT = 15_000;
const SUGGEST = { role: 'button', name: 'Suggest changes' } as const;
const REVIEW = { role: 'button', name: 'Review suggestions' } as const;
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

const content = async (actor: Actor, docId: string): Promise<string> => (await actor.context.request.get(`/api/docs/${docId}/content`)).text();

const frames = (actor: Actor) => actor.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

/** Puts the caret (or, with `length`, a selection) inside the first body text node holding `text`, at `offset`. */
async function caret(actor: Actor, docId: string, text: string, offset: number, length = 0): Promise<void> {
  const body = ui.body(actor, docId);
  await body.evaluate((root, { text, offset, length }) => {
    (root as HTMLElement).focus();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = (node.textContent ?? '').indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at + offset);
      range.setEnd(node, at + offset + length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw new Error(`no body text "${text}"`);
  }, { text, offset, length });
  // Lexical reads the selection on selectionchange.
  await frames(actor);
}

/** A real mouse click just inside the right edge of the character before `offset` in the body text holding `text`. */
async function clickAfter(actor: Actor, docId: string, text: string, offset: number): Promise<void> {
  const point = await ui.body(actor, docId).evaluate((root, { text, offset }) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = (node.textContent ?? '').indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at + offset - 1);
      range.setEnd(node, at + offset);
      const rect = range.getBoundingClientRect();
      return { x: rect.right - 1, y: rect.top + rect.height / 2 };
    }
    throw new Error(`no body text "${text}"`);
  }, { text, offset });
  await actor.page.mouse.click(point.x, point.y);
  await frames(actor);
}

/** Everything sent is acknowledged and nothing was refused. */
async function settled(actor: Actor, docId: string, what: string): Promise<void> {
  const pane = ui.pane(actor, docId);
  await expect(pane, `${what}: acknowledged`).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });
  await expect(pane, `${what}: never refused`).toHaveAttribute(SUGGEST_REFUSED_ATTR, '0');
}

/** Opens `docId` in a fresh page load and waits for `mode` to go live (or read-only for Review). */
async function openIn(actor: Actor, docId: string, mode: 'suggest' | 'review' | 'edit' = 'suggest'): Promise<Locator> {
  await actor.goto(`/d/${docId}`);
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  const pane = ui.pane(actor, docId);
  await expect(pane).toHaveAttribute(EDIT_MODE_ATTR, mode, { timeout: BIND_TIMEOUT });
  await expect(ui.body(actor, docId)).toHaveAttribute(BODY_BINDING_ATTR, mode === 'review' ? 'readonly' : 'live', { timeout: BIND_TIMEOUT });
  return pane;
}

/** The ranges painted `::highlight(name)` in this page, as their text. */
const painted = (actor: Actor, name: string): Promise<string[]> =>
  actor.page.evaluate((highlight) => [...((CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights?.get(highlight) ?? [])].map((range) => range.toString()), name);

const sentCount = async (actor: Actor, docId: string): Promise<number> => Number(await ui.pane(actor, docId).getAttribute(SUGGEST_SENT_ATTR));

test('j16-suggest: a solo owner with nothing selected toggles Suggest in the docked toolbar, and the caret stays where it was @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner suggests on a note nobody else has open');
  const ada = await actors.open(await actors.principal('ada'));
  const docId = await ui.createNote(ada);
  await ui.typeTitle(ada, docId, 'Solo suggest', { enter: true });
  await ui.typeBody(ada, docId, 'Owner text kept');
  const pane = ui.pane(ada, docId);
  const body = ui.body(ada, docId);
  await expect(pane).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });
  await expect(pane).toHaveAttribute(EDIT_MODE_ATTR, 'edit');

  // A real click puts the caret after "Owner" with nothing selected, so moss's docked bottom toolbar shows.
  await clickAfter(ada, docId, 'Owner text kept', 5);
  const docked = ada.page.locator(`[${FLOATING_TOOLBAR_ATTR}]`);
  const toggle = docked.getByRole(SUGGEST.role, { name: SUGGEST.name });
  await expect(toggle, 'the docked toolbar offers Suggest').toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  ada.expectReconnects(2, docId);
  await toggle.click();
  await expect(pane).toHaveAttribute(EDIT_MODE_ATTR, 'suggest', { timeout: BIND_TIMEOUT });
  await expect(body).toHaveAttribute(BODY_BINDING_ATTR, 'live', { timeout: BIND_TIMEOUT });
  await expect(ui.title(ada, docId), 'the title is read-only while suggesting').toHaveAttribute(TITLE_BINDING_ATTR, 'readonly');
  await ada.declareRemount(docId);
  await expect(pane, 'entering Suggest sends nothing').toHaveAttribute(SUGGEST_SENT_ATTR, '0');

  // No click: the caret came back after "Owner", so typing lands there.
  await expect(body, 'the caret is back in the body').toBeFocused({ timeout: BIND_TIMEOUT });
  await ada.page.keyboard.type(' plus');
  await settled(ada, docId, 'the suggestion');
  await expect(body).toContainText('Owner plus text kept');
  // Yjs's text diff may take the space on either side of the insert.
  await expect.poll(async () => (await painted(ada, 'suggest-insert')).map((text) => text.trim()), { message: 'the suggestion paints as an insert', timeout: BIND_TIMEOUT }).toContain('plus');
  const exported = await content(ada, docId);
  expect(exported).toContain('Owner text kept');
  expect(exported, 'a pending suggestion is not in the note').not.toContain('plus');

  // Back to Edit: the caret returns to the original text before the pending suggestion.
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(pane).toHaveAttribute(EDIT_MODE_ATTR, 'edit', { timeout: BIND_TIMEOUT });
  await expect(body).toHaveAttribute(BODY_BINDING_ATTR, 'live', { timeout: BIND_TIMEOUT });
  await ada.declareRemount(docId);
  await expect(body, 'the caret is back in the body').toBeFocused({ timeout: BIND_TIMEOUT });
  // Beside the body text the suggestion was typed at ("Owner" and its space, as Yjs placed the insert).
  await expect.poll(() => body.evaluate(() => {
    const selection = window.getSelection();
    return selection?.anchorNode ? `${selection.anchorNode.textContent}@${selection.anchorOffset}` : null;
  }), { message: 'the caret is where it was', timeout: BIND_TIMEOUT }).toMatch(/^Owner text kept@[56]$/);
});

test('j16-suggest: a principal shared as suggester through the dialog opens locked to the chip, a cold first delete stays on the server, struck, and a viewer opens in Review @p:mean-2 @p:tech-7 @p:R17', async ({ actors }) => {
  const adaPrincipal = await actors.principal('ada');
  const ada = await actors.open(adaPrincipal);
  const docId = await ui.createNote(ada);
  await ui.typeTitle(ada, docId, 'Shared to suggest', { enter: true });
  await ui.typeBody(ada, docId, 'Keep every original word');
  await expect(ui.pane(ada, docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });

  const benPrincipal = await actors.principal('ben');
  const dialog = await ui.shareWith(ada, docId, benPrincipal, 'Can suggest');
  await ada.page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  const ben = await actors.session(benPrincipal);
  const pane = await openIn(ben, docId);
  await actors.requireDistinct(2);
  await ben.observeEditor(docId);
  const chip = ben.page.locator(`[${SUGGEST_CHIP_ATTR}]`);
  await expect(chip, 'the chip says Suggesting').toHaveText('Suggesting');
  await expect(chip, 'a suggester cannot leave Suggest').toHaveAttribute(SUGGEST_CHIP_ATTR, 'locked');
  await expect(ben.page.getByRole(SUGGEST.role, { name: SUGGEST.name }), 'no toggle for a locked suggester').toHaveCount(0);
  await expect(ui.title(ben, docId)).toHaveAttribute(TITLE_BINDING_ATTR, 'readonly');
  await expect(pane).toHaveAttribute(SUGGEST_SENT_ATTR, '0');

  // Cold load: the first input is a delete of original text.
  await caret(ben, docId, 'original', 8);
  await ben.page.keyboard.press('Backspace');
  await settled(ben, docId, 'the delete');
  await expect(ui.body(ben, docId), 'the struck text stays in his window').toContainText('Keep every original word');
  await expect.poll(() => painted(ben, 'suggest-delete'), { message: 'the deleted character paints struck', timeout: BIND_TIMEOUT }).toEqual(['l']);
  expect(await content(ada, docId), 'the server keeps the text').toContain('Keep every original word');
  await expect(ui.body(ada, docId), "the owner's window keeps it").toContainText('Keep every original word');

  // A viewer opens in Review (ruling 17) and sees the pending delete struck inline.
  const carlPrincipal = await actors.principal('carl');
  await grantDoc(ada, docId, carlPrincipal, 'viewer');
  const carl = await actors.session(carlPrincipal);
  await openIn(carl, docId, 'review');
  await expect(ui.body(carl, docId)).toContainText('Keep every original word');
  await expect.poll(() => painted(carl, 'suggest-delete'), { message: 'Review paints the pending delete', timeout: BIND_TIMEOUT }).toEqual(['l']);
});

/** The census note, imported on the server (docs/design/suggestions.md §9). */
const CENSUS_NOTE = [
  'Hello world and the cat.',
  '',
  'Go to [the site](https://example.invalid) now.',
  '',
  'First line',
  'second line',
  '',
  'Total {{1+1|2}} items.',
  '',
  'Indented words here.',
  '',
  '> Quoted words here.',
  '',
  '- [ ] task one',
  '- [ ] task two',
  '',
  '- item a',
  '- item b',
  '  - nested item',
  '',
  '| A | B |',
  '|---|---|',
  '| cell one | cell two |',
  '',
  '```js',
  'seed',
  '```',
  '',
  'Join head.',
  '',
  'join tail.',
].join('\n');

type Actors = Parameters<Parameters<typeof test>[2]>[0]['actors'];

/** A note owned by ada, which ben opens as a suggester. */
async function sharedNote(actors: Actors, markdown: string, { severable = false } = {}) {
  const adaPrincipal = await actors.principal('ada');
  const ada = await actors.open(adaPrincipal);
  const response = await ada.context.request.post('/api/docs', { headers: { origin: new URL(ada.page.url()).origin }, data: { markdown } });
  expect(response.status()).toBe(201);
  const docId = ((await response.json()) as { doc: { id: string } }).doc.id;
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, 'suggester');
  const ben = await actors.session(benPrincipal, { severable });
  const before = await content(ada, docId);
  return { ada, ben, docId, before };
}

async function censusNote(actors: Actors) {
  const note = await sharedNote(actors, CENSUS_NOTE);
  await openIn(note.ben, note.docId);
  await note.ben.observeEditor(note.docId);
  return note;
}

type Step = [name: string, act: () => Promise<void>, check?: () => Promise<void>];

/** Each step reaches the wire, is acknowledged with no refusal, and changes the note in his window. */
async function runCensus(actor: Actor, docId: string, steps: Step[]): Promise<void> {
  const body = ui.body(actor, docId);
  for (const [name, act, check] of steps) {
    const sent = await sentCount(actor, docId);
    const html = await body.innerHTML();
    await act();
    await expect.poll(() => sentCount(actor, docId), { message: `${name}: reaches the wire`, timeout: BIND_TIMEOUT }).toBeGreaterThan(sent);
    await settled(actor, docId, name);
    if (check) await check();
    else await expect.poll(() => body.innerHTML(), { message: `${name}: changes the note`, timeout: BIND_TIMEOUT }).not.toBe(html);
  }
}

test('j16-suggest routed deletes: past an inline link, over own and original text, and undone @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner only seeds the note; one suggester makes every edit');
  const { ada, ben, docId, before } = await censusNote(actors);
  const { keyboard } = ben.page;
  const body = ui.body(ben, docId);

  // Backspace at the start of the text after an original link strikes the link's last character.
  await caret(ben, docId, ' now.', 0);
  await keyboard.press('Backspace');
  await settled(ben, docId, 'the delete after the link');
  await expect(body, 'the link text stays').toContainText('Go to the site now.');
  await expect.poll(() => painted(ben, 'suggest-delete'), { message: "the link's last character is struck", timeout: BIND_TIMEOUT }).toEqual(['e']);

  // A selection over his own pending text and original text: his own characters go, the original ones are struck.
  await caret(ben, docId, 'Hello world', 0);
  await keyboard.type('ABC');
  await settled(ben, docId, 'his own text');
  await caret(ben, docId, 'ABCHello', 1, 4);
  await keyboard.press('Backspace');
  await settled(ben, docId, 'the mixed delete');
  await expect(body, 'his own "BC" is gone; "He" stays').toContainText('AHello world');
  await expect.poll(() => painted(ben, 'suggest-delete'), { message: 'only the original characters are struck', timeout: BIND_TIMEOUT }).toContain('He');

  // Undo takes the whole delete back: the strike and his own characters.
  await keyboard.press(`${mod}+z`);
  await settled(ben, docId, 'the undo');
  await expect.poll(() => painted(ben, 'suggest-delete'), { message: 'the strike is taken back', timeout: BIND_TIMEOUT }).not.toContain('He');
  await expect(body).toContainText('ABCHello world');
  expect(await content(ada, docId), 'no suggestion wrote the body').toBe(before);
});

test('j16-suggest routed deletes: Backspace and Delete strike a whole emoji, never half of it @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner only seeds the note; one suggester makes every edit');
  const { ada, ben, docId, before } = await sharedNote(actors, 'Smile A\u{1F600}B here.\n\nNext:\u{1F600} line.');
  await openIn(ben, docId);
  await ben.observeEditor(docId);
  const { keyboard } = ben.page;
  const body = ui.body(ben, docId);

  // Backspace after an original emoji strikes both of its UTF-16 units, and the caret lands before it.
  await caret(ben, docId, 'B here.', 0);
  await keyboard.press('Backspace');
  await settled(ben, docId, 'the Backspace over the emoji');
  await expect.poll(() => painted(ben, 'suggest-delete'), { message: 'the whole emoji is struck', timeout: BIND_TIMEOUT }).toEqual(['\u{1F600}']);
  await keyboard.type('Z');
  await settled(ben, docId, 'typing after the strike');
  await expect(body, 'the caret sat before the emoji, not inside it').toContainText('Smile AZ\u{1F600}B here.');

  // Delete before an original emoji strikes it whole too, and the caret lands after it.
  await caret(ben, docId, 'Next:', 5);
  await keyboard.press('Delete');
  await settled(ben, docId, 'the Delete over the emoji');
  await expect.poll(() => painted(ben, 'suggest-delete'), { message: 'both emoji are struck whole', timeout: BIND_TIMEOUT }).toEqual(['\u{1F600}', '\u{1F600}']);
  await keyboard.type('Y');
  await settled(ben, docId, 'typing after the second strike');
  await expect(body, 'the caret sat after the emoji').toContainText('Next:\u{1F600}Y line.');
  await expect(body).not.toContainText('\u{FFFD}');
  expect(await content(ada, docId), 'no suggestion wrote the body').toBe(before);
});

test('j16-suggest two windows: each window of a suggester shows the other window\'s suggestions live @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner only seeds the note; one suggester edits in two windows');
  const { ada, ben, docId, before } = await sharedNote(actors, 'First window line.\n\nSecond window line.');
  await openIn(ben, docId);
  await ben.observeEditor(docId);
  const ben2 = await actors.sameAs(ben);
  await openIn(ben2, docId);
  await ben2.observeEditor(docId);

  await caret(ben, docId, 'First window line.', 18);
  await ben.page.keyboard.type(' Typed in one.');
  await settled(ben, docId, 'the first window');
  await expect(ui.body(ben2, docId), "the second window shows the first window's suggestion").toContainText('First window line. Typed in one.', { timeout: BIND_TIMEOUT });

  await caret(ben2, docId, 'Second window line.', 19);
  await ben2.page.keyboard.type(' Typed in two.');
  await settled(ben2, docId, 'the second window');
  await expect(ui.body(ben, docId), "the first window shows the second window's suggestion").toContainText('Second window line. Typed in two.', { timeout: BIND_TIMEOUT });

  await caret(ben, docId, 'window line.', 1);
  await ben.page.keyboard.press('Backspace');
  await settled(ben, docId, 'the strike');
  await expect.poll(() => painted(ben2, 'suggest-delete'), { message: "the second window paints the first window's strike", timeout: BIND_TIMEOUT }).toEqual(['w']);
  await settled(ben2, docId, 'the second window, after');
  expect(await content(ada, docId), 'no suggestion wrote the body').toBe(before);
});

test('j16-suggest IME: a composition in an original code block while suggesting is recorded with no refusal @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner only seeds the note; one suggester makes every edit');
  const { ada, ben, docId, before } = await sharedNote(actors, 'Code below.\n\n```js\nseed\n```');
  await openIn(ben, docId);
  await ben.observeEditor(docId);
  const body = ui.body(ben, docId);
  await body.locator('.moss-codeblock-pre').click();
  const field = body.getByPlaceholder('Enter code...');
  await expect(field).toBeVisible();
  const sent = await sentCount(ben, docId);
  await field.evaluate((input) => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await field.fill('seed漢');
  await field.evaluate((input) => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '漢' })));
  await expect.poll(() => sentCount(ben, docId), { message: 'the composition reaches the wire', timeout: BIND_TIMEOUT }).toBeGreaterThan(sent);
  await settled(ben, docId, 'the composition');
  await expect(field).toHaveValue('seed漢');
  expect(await content(ada, docId), 'no suggestion wrote the body').toBe(before);
});

test('j16-suggest offline:suggestions typed offline reach the server after the suggester navigates away @p:mean-2 @p:tech-7 @p:R17', async ({ actors }) => {
  const { ada, ben, docId, before } = await sharedNote(actors, 'Draft line one.\n\nDraft line two.', { severable: true });
  // His own note, to navigate to while the suggestion is still unsent.
  await ben.goto('/');
  await ben.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  const elsewhere = await ui.createNote(ben);
  await openIn(ben, docId);
  await ben.observeEditor(docId);
  await caret(ben, docId, 'Draft line one.', 15);
  await ben.page.keyboard.type(' Online words.');
  await settled(ben, docId, 'the online suggestion');

  const sever = ben.sever!;
  ben.expectReconnects(4);
  sever.reset();
  await caret(ben, docId, 'Draft line two.', 15);
  await ben.page.keyboard.type(' Offline words.');
  await expect(ui.pane(ben, docId), 'the offline suggestion is unacked').toHaveAttribute(SYNC_UNACKED_ATTR, '1');
  // He leaves the note before the network comes back; the doc's session keeps delivering without its pane.
  await ben.page.locator(`[${NAMES.sidebarRow}][${NAMES.docId}="${elsewhere}"]`).click();
  await expect(ui.pane(ben, docId)).toHaveCount(0, { timeout: BIND_TIMEOUT });
  sever.reset();
  sever.restore();
  await ui.waitLive(ben, elsewhere);
  await ben.declareRemount(elsewhere);

  // The owner reviews the note: both suggestions are there, and the body is unchanged.
  ada.expectReconnects(1, docId);
  await openIn(ada, docId, 'edit');
  await ada.page.getByRole(REVIEW.role, { name: REVIEW.name }).click();
  await expect(ui.pane(ada, docId)).toHaveAttribute(EDIT_MODE_ATTR, 'review', { timeout: BIND_TIMEOUT });
  await expect(ui.body(ada, docId)).toContainText('Online words.', { timeout: BIND_TIMEOUT });
  await expect(ui.body(ada, docId), 'the offline suggestion was delivered').toContainText('Offline words.', { timeout: 45_000 });
  expect(await content(ada, docId), 'no suggestion wrote the body').toBe(before);
});

test('j16-suggest census: inline edits through the real UI are each recorded with no refusal @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner only seeds the note; one suggester makes every edit');
  const { ada, ben, docId, before } = await censusNote(actors);
  const { keyboard } = ben.page;
  const body = ui.body(ben, docId);
  let beforeSplit = '';
  const steps: Step[] = [
    ['colliding prefix "the " before "the cat"', async () => { await caret(ben, docId, 'the cat', 0); await keyboard.type('the '); },
      () => expect(body).toContainText('and the the cat.')],
    ['a duplicated word', async () => { await caret(ben, docId, 'Hello world', 6); await keyboard.type('world '); },
      () => expect(body).toContainText('Hello world world and')],
    ['a sentence pasted before itself', async () => { await caret(ben, docId, 'Hello', 0); await keyboard.insertText('Hello world and the cat. '); },
      () => expect(body).toContainText('Hello world and the cat. Hello world world')],
    ['Enter before an original link', async () => { await caret(ben, docId, 'Go to ', 6); await keyboard.press('Enter'); }],
    ['Enter before an original line break', async () => { await caret(ben, docId, 'First line', 10); await keyboard.press('Enter'); }],
    ['Enter before an inline formula', async () => { await caret(ben, docId, 'Total ', 6); await keyboard.press('Enter'); }],
    // Moss never indents a plain paragraph (TabIndentPlugin indents list items only), so its indented block is a
    // nested list item.
    ['Enter in an indented block', async () => { await caret(ben, docId, 'nested item', 6); await keyboard.press('Enter'); }],
    ['Enter in a plain paragraph', async () => { await caret(ben, docId, 'Indented', 9); await keyboard.press('Enter'); }],
    ['Enter in a quote', async () => { await caret(ben, docId, 'Quoted', 7); await keyboard.press('Enter'); }],
    ['Shift+Enter', async () => { await caret(ben, docId, 'Go to', 2); await keyboard.press('Shift+Enter'); }],
    ['typing own text', async () => { await caret(ben, docId, 'items.', 6); await keyboard.type(' It sat.'); },
      () => expect(body).toContainText('items. It sat.')],
    ['bold of own and original text', async () => { await caret(ben, docId, 'items. It', 0, 9); await keyboard.press(`${mod}+b`); }],
    ['a split to undo', async () => {
      // Undo captures edits within 1 s as one step; end the step so only the split is undone.
      await body.evaluate((root) => {
        const editor = (root as unknown as { __lexicalEditor?: Record<symbol, { stopCapturing(): void } | undefined> }).__lexicalEditor;
        editor?.[Symbol.for('@lexical/yjs/UndoManager')]?.stopCapturing();
      });
      beforeSplit = await body.innerHTML();
      await caret(ben, docId, 'join tail', 4);
      await keyboard.press('Enter');
    }],
    ['undo of the split', async () => { await keyboard.press(`${mod}+z`); },
      async () => { await expect.poll(() => body.innerHTML(), { message: 'the split is undone' }).toBe(beforeSplit); }],
    ['join', async () => { await caret(ben, docId, 'join tail', 0); await keyboard.press('Backspace'); },
      () => expect(body).toContainText('Join head.join tail.')],
  ];
  await runCensus(ben, docId, steps);
  expect(await content(ada, docId), 'no suggestion wrote the body').toBe(before);

  // The owner, in Edit mode, sees original text the suggestion removes (the join's moved text) struck.
  await openIn(ada, docId, 'edit');
  await expect.poll(() => painted(ada, 'suggest-delete'), { message: "the record's removals paint struck in Edit mode", timeout: BIND_TIMEOUT }).toContain('join tail.');
});

test('j16-suggest census: lists, tables, checkboxes, new blocks and registers through the real UI are each recorded with no refusal @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner only seeds the note; one suggester makes every edit');
  const { ada, ben, docId, before } = await censusNote(actors);
  const { keyboard } = ben.page;
  const body = ui.body(ben, docId);
  const newLine: Step = ['a new line for the paste', async () => { await caret(ben, docId, 'Join head.', 10); await keyboard.press('Enter'); }];
  /** Explicit markdown on the clipboard, pasted at the caret, as moss's paste path takes it. */
  const paste = (markdown: string) => () => body.evaluate((element, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    data.setData('text/markdown', text);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, markdown);
  const taskOrder = () => body.locator('li', { hasText: /task (one|two)/ }).allInnerTexts();
  const steps: Step[] = [
    ['list Enter mid-list', async () => { await caret(ben, docId, 'item a', 4); await keyboard.press('Enter'); }],
    ['Tab in a list', async () => { await caret(ben, docId, 'item b', 4); await keyboard.press('Tab'); }],
    ['table row insert', async () => {
      await caret(ben, docId, 'cell one', 4);
      await ben.page.getByRole('button', { name: 'Table actions' }).click();
      await ben.page.getByRole('menuitem', { name: 'Insert below' }).click();
    }, () => expect(body.locator('tr'), 'a third row').toHaveCount(3)],
    ['typing in a table cell', async () => { await caret(ben, docId, 'cell one', 8); await keyboard.type('!'); },
      () => expect(body.locator('td', { hasText: 'cell one!' })).toHaveCount(1)],
    ['checkbox', async () => {
      const item = body.locator('li', { hasText: 'task two' });
      const box = (await item.boundingBox())!;
      await ben.page.mouse.click(box.x + 4, box.y + box.height / 2);
    }, async () => {
      await expect(body.locator('li[aria-checked="true"]', { hasText: 'task two' }), 'task two is checked').toHaveCount(1);
      // Background writers are off in Suggest: moss's checklist sort never moves the checked item.
      await ben.page.waitForTimeout(600);
      expect((await taskOrder()).map((text) => text.trim())).toEqual(['task one', 'task two']);
    }],
    newLine,
    ['new code block', paste('```js\nnew code\n```')],
    newLine,
    ['new HTML block', paste('```moss-html\n<b>new</b>\n```')],
    newLine,
    ['new formula', paste('New {{3*3|9}} here.')],
    newLine,
    ['new chart block', paste('```moss-chart\n{"type":"bar","data":[{"label":"Mon","value":1}]}\n```')],
    newLine,
    ['new sketch block', paste('```moss-sketch\n.##.\n```')],
    ['an edit of an original code register', async () => {
      await body.getByText('seed', { exact: true }).click();
      await keyboard.press('End');
      await keyboard.type('!');
    }, () => expect(body).toContainText('seed!')],
  ];
  await runCensus(ben, docId, steps);
  expect(await content(ada, docId), 'no suggestion wrote the body').toBe(before);
});
