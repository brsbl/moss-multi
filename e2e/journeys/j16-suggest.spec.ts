// j16-suggest (T5.1; docs/design/suggestions.md §5, §7, §8, PRODUCT ruling 17): Suggest mode in the real app. A solo
// owner with nothing selected toggles Suggest in the docked toolbar; a principal shared as suggester through the
// dialog opens locked to the "Suggesting" chip; on a cold load a suggester's first delete leaves the text on the
// server and paints it struck; and every census operation, made through the real UI, is recorded with no refusal.
import type { Locator } from '@playwright/test';
import type { Actor } from '../lib/actors.ts';
import {
  APP_STATE_ATTR, BODY_BINDING_ATTR, EDIT_MODE_ATTR, FLOATING_TOOLBAR_ATTR, SUGGEST_CHIP_ATTR, SUGGEST_REFUSED_ATTR, SUGGEST_SENT_ATTR,
  SYNC_UNACKED_ATTR, TITLE_BINDING_ATTR,
} from '../lib/contract.ts';
import { grantDoc } from '../lib/grants.ts';
import { expect, test, ui } from '../lib/test.ts';

const BOOT_TIMEOUT = 30_000;
const BIND_TIMEOUT = 15_000;
const SUGGEST = { role: 'button', name: 'Suggest changes' } as const;

const content = async (actor: Actor, docId: string): Promise<string> => (await actor.context.request.get(`/api/docs/${docId}/content`)).text();

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
  await actor.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** Everything sent is acknowledged and nothing was refused. */
async function settled(actor: Actor, docId: string, what: string): Promise<void> {
  const pane = ui.pane(actor, docId);
  await expect(pane, `${what}: acknowledged`).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });
  await expect(pane, `${what}: never refused`).toHaveAttribute(SUGGEST_REFUSED_ATTR, '0');
}

/** Opens `docId` in a fresh page load and waits for Suggest mode to go live. */
async function openSuggesting(actor: Actor, docId: string): Promise<Locator> {
  await actor.goto(`/d/${docId}`);
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  const pane = ui.pane(actor, docId);
  await expect(pane).toHaveAttribute(EDIT_MODE_ATTR, 'suggest', { timeout: BIND_TIMEOUT });
  await expect(ui.body(actor, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'live', { timeout: BIND_TIMEOUT });
  return pane;
}

/** The ranges painted `::highlight(name)` in this page, as their text. */
const painted = (actor: Actor, name: string): Promise<string[]> =>
  actor.page.evaluate((highlight) => [...((CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights?.get(highlight) ?? [])].map((range) => range.toString()), name);

test('j16-suggest: a solo owner with nothing selected toggles Suggest in the docked toolbar @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner suggests on a note nobody else has open');
  const ada = await actors.open(await actors.principal('ada'));
  const docId = await ui.createNote(ada);
  await ui.typeTitle(ada, docId, 'Solo suggest', { enter: true });
  await ui.typeBody(ada, docId, 'Owner text kept');
  const pane = ui.pane(ada, docId);
  await expect(pane).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });
  await expect(pane).toHaveAttribute(EDIT_MODE_ATTR, 'edit');

  // The caret sits in the body with nothing selected, so moss's docked bottom toolbar shows.
  const docked = ada.page.locator(`[${FLOATING_TOOLBAR_ATTR}]`);
  const toggle = docked.getByRole(SUGGEST.role, { name: SUGGEST.name });
  await expect(toggle, 'the docked toolbar offers Suggest').toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  ada.expectReconnects(1, docId);
  await toggle.click();
  await expect(pane).toHaveAttribute(EDIT_MODE_ATTR, 'suggest', { timeout: BIND_TIMEOUT });
  await expect(ui.body(ada, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'live', { timeout: BIND_TIMEOUT });
  await expect(ui.title(ada, docId), 'the title is read-only while suggesting').toHaveAttribute(TITLE_BINDING_ATTR, 'readonly');
  await ada.declareRemount(docId);
  await expect(pane, 'entering Suggest sends nothing').toHaveAttribute(SUGGEST_SENT_ATTR, '0');

  await ui.body(ada, docId).click();
  await ada.page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await ada.page.keyboard.type(' plus a suggestion');
  await settled(ada, docId, 'the suggestion');
  await expect(ui.body(ada, docId)).toContainText('Owner text kept plus a suggestion');
  expect(await painted(ada, 'suggest-insert'), 'the suggestion paints as an insert').toContain(' plus a suggestion');
  const exported = await content(ada, docId);
  expect(exported).toContain('Owner text kept');
  expect(exported, 'a pending suggestion is not in the note').not.toContain('plus a suggestion');
});

test('j16-suggest: a principal shared as suggester through the dialog opens locked to the chip, and a cold first delete stays on the server, struck @p:mean-2 @p:tech-7 @p:R17', async ({ actors }) => {
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
  const pane = await openSuggesting(ben, docId);
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
  expect(await painted(ben, 'suggest-delete'), 'the deleted character paints struck').toEqual(['l']);
  expect(await content(ada, docId), 'the server keeps the text').toContain('Keep every original word');
  await expect(ui.body(ada, docId), "the owner's window keeps it").toContainText('Keep every original word');
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

/** A census note owned by ada, which ben opens as a suggester. */
async function censusNote(actors: Parameters<Parameters<typeof test>[2]>[0]['actors']) {
  const adaPrincipal = await actors.principal('ada');
  const ada = await actors.open(adaPrincipal);
  const response = await ada.context.request.post('/api/docs', { headers: { origin: new URL(ada.page.url()).origin }, data: { markdown: CENSUS_NOTE } });
  expect(response.status()).toBe(201);
  const docId = ((await response.json()) as { doc: { id: string } }).doc.id;
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, 'suggester');
  const ben = await actors.session(benPrincipal);
  await openSuggesting(ben, docId);
  await ben.observeEditor(docId);
  const before = await content(ada, docId);
  return { ada, ben, docId, before };
}

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test('j16-suggest census: inline edits through the real UI are recorded with no refusal @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner only seeds the note; one suggester makes every edit');
  const { ada, ben, docId, before } = await censusNote(actors);
  const { keyboard } = ben.page;
  const steps: [string, () => Promise<void>][] = [
    ['colliding prefix "the " before "the cat"', async () => { await caret(ben, docId, 'the cat', 0); await keyboard.type('the '); }],
    ['a duplicated word', async () => { await caret(ben, docId, 'Hello world', 6); await keyboard.type('world '); }],
    ['a sentence pasted before itself', async () => { await caret(ben, docId, 'Hello', 0); await keyboard.insertText('Hello world and the cat. '); }],
    ['Enter before an original link', async () => { await caret(ben, docId, 'Go to ', 6); await keyboard.press('Enter'); }],
    ['Enter before an original line break', async () => { await caret(ben, docId, 'First line', 10); await keyboard.press('Enter'); }],
    ['Enter before an inline formula', async () => { await caret(ben, docId, 'Total ', 6); await keyboard.press('Enter'); }],
    ['Enter in an indented paragraph', async () => { await caret(ben, docId, 'Indented', 0); await keyboard.press('Tab'); await caret(ben, docId, 'Indented', 9); await keyboard.press('Enter'); }],
    ['Enter in a quote', async () => { await caret(ben, docId, 'Quoted', 7); await keyboard.press('Enter'); }],
    ['Shift+Enter', async () => { await caret(ben, docId, 'Go to', 2); await keyboard.press('Shift+Enter'); }],
    ['bold of own and original text', async () => {
      await caret(ben, docId, 'items.', 6); await keyboard.type(' It sat.');
      await caret(ben, docId, 'items. It', 0, 9); await keyboard.press(`${mod}+b`);
    }],
    ['undo of a split', async () => {
      // Undo captures edits within 1 s as one step; end the step so only the split is undone.
      await ui.body(ben, docId).evaluate((root) => {
        const editor = (root as unknown as { __lexicalEditor?: Record<symbol, { stopCapturing(): void } | undefined> }).__lexicalEditor;
        editor?.[Symbol.for('@lexical/yjs/UndoManager')]?.stopCapturing();
      });
      await caret(ben, docId, 'join tail', 4); await keyboard.press('Enter'); await keyboard.press(`${mod}+z`);
    }],
    ['join', async () => { await caret(ben, docId, 'join tail', 0); await keyboard.press('Backspace'); }],
  ];
  for (const [name, step] of steps) {
    await step();
    await settled(ben, docId, name);
  }
  await expect(ui.body(ben, docId)).toContainText('the the cat');
  expect(Number(await ui.pane(ben, docId).getAttribute(SUGGEST_SENT_ATTR)), 'every operation reached the wire').toBeGreaterThanOrEqual(steps.length);
  expect(await content(ada, docId), 'no suggestion wrote the body').toBe(before);
});

test('j16-suggest census: lists, tables, checkboxes, new blocks and registers through the real UI are recorded with no refusal @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner only seeds the note; one suggester makes every edit');
  const { ada, ben, docId, before } = await censusNote(actors);
  const { keyboard } = ben.page;
  const body = ui.body(ben, docId);
  /** Explicit markdown on the clipboard, pasted at the caret, as moss's paste path takes it. */
  const paste = async (markdown: string) => {
    await caret(ben, docId, 'Join head.', 10);
    await keyboard.press('Enter');
    await body.evaluate((element, text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      data.setData('text/markdown', text);
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    }, markdown);
  };
  const steps: [string, () => Promise<void>][] = [
    ['list Enter mid-list', async () => { await caret(ben, docId, 'item a', 4); await keyboard.press('Enter'); }],
    ['Tab in a list', async () => { await caret(ben, docId, 'item b', 4); await keyboard.press('Tab'); }],
    ['typing in a table cell', async () => { await caret(ben, docId, 'cell one', 8); await keyboard.type('!'); }],
    ['checkbox', async () => {
      const item = body.locator('li', { hasText: 'task one' });
      const box = (await item.boundingBox())!;
      await ben.page.mouse.click(box.x + 4, box.y + box.height / 2);
    }],
    ['new code block', () => paste('```js\nnew code\n```')],
    ['new HTML block', () => paste('```moss-html\n<b>new</b>\n```')],
    ['new formula', () => paste('New {{3*3|9}} here.')],
    ['new chart block', () => paste('```moss-chart\n{"type":"bar","data":[{"label":"Mon","value":1}]}\n```')],
    ['new sketch block', () => paste('```moss-sketch\n.##.\n```')],
    ['an edit of an original code register', async () => {
      await body.getByText('seed', { exact: true }).click();
      await keyboard.press('End');
      await keyboard.type('!');
    }],
  ];
  for (const [name, step] of steps) {
    await step();
    await settled(ben, docId, name);
  }
  expect(Number(await ui.pane(ben, docId).getAttribute(SUGGEST_SENT_ATTR)), 'every operation reached the wire').toBeGreaterThanOrEqual(steps.length);
  expect(await content(ada, docId), 'no suggestion wrote the body').toBe(before);
});
