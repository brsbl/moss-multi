// j01-undo (M1): Cmd+Z undoes only your own edits. Ada and Ben type into the same paragraphs, inside each other's
// words, across a paragraph split and merge, and across a dropped socket; every Cmd+Z and Cmd+Shift+Z Ada presses
// leaves Ben's characters on both screens and both peers on the same text.
import type { LexicalEditor } from 'lexical';
import type { Actor, Actors } from '../lib/actors.ts';
import { SYNC_UNACKED_ATTR } from '../lib/contract.ts';
import { expect, test, ui } from '../lib/test.ts';

const PEER_TIMEOUT = 10_000;
/** Past the undo capture window (1 s), so the next edit is its own step. */
const NEW_STEP_MS = 1_500;
const UNDO = 'ControlOrMeta+z';
const REDO = 'ControlOrMeta+Shift+z';

async function setup(actors: Actors, baseUrl: string, markdown: string, { benLater = false, severable = false } = {}) {
  const ada = await actors.session(await actors.principal('ada'), { severable });
  const result = await ada.context.request.post('/api/docs', { headers: { origin: baseUrl }, data: { title: 'Undo', markdown } });
  expect(result.status()).toBe(201);
  const { doc: { id } } = await result.json() as { doc: { id: string } };
  const principal = await actors.principal('ben');
  expect((await ada.context.request.post(`/api/docs/${id}/members`, { headers: { origin: baseUrl }, data: { email: principal.email, role: 'editor' } })).status()).toBe(201);
  await ada.goto(`/d/${id}`);
  await ui.waitLive(ada, id); await ada.observeEditor(id);
  const openBen = async () => {
    const ben = await actors.open(principal, { path: `/d/${id}` });
    await ui.waitLive(ben, id); await ben.observeEditor(id);
    return ben;
  };
  return { ada, id, ben: benLater ? null : await openBen(), openBen };
}

/** The body as Lexical holds it: paragraphs joined by a blank line. */
const docText = (actor: Actor, id: string) => ui.body(actor, id).evaluate(element => {
  const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
  return editor.getEditorState().read(() => editor.getEditorState()._nodeMap.get('root')!.getTextContent());
});
const paragraph = (actor: Actor, id: string, start: string) => ui.body(actor, id).locator('p').filter({ hasText: new RegExp(`^${start}`) });
/** Concurrent typing interleaves in either order, so only the letters are compared. */
const letters = (text: string) => [...text.replace(/\s/g, '')].sort().join('');

/** Both peers show the same body; returns it. */
async function converged(ada: Actor, ben: Actor, id: string, message: string): Promise<string> {
  await expect.poll(async () => (await docText(ada, id)) === (await docText(ben, id)), { message: `${message}: the peers converge`, timeout: PEER_TIMEOUT }).toBe(true);
  return docText(ada, id);
}
/** Ada presses `key` `times` times; after each press both peers converge and still hold every one of Ben's strings. */
async function press(ada: Actor, ben: Actor, id: string, key: string, times: number, kept: string[]): Promise<string> {
  let text = '';
  for (let i = 1; i <= times; i++) {
    await ada.page.keyboard.press(key);
    text = await converged(ada, ben, id, `${key} ${i}`);
    for (const mine of kept) expect(text, `${key} ${i}: Ada's Cmd+Z must leave Ben's "${mine}"`).toContain(mine);
  }
  return text;
}
/** The caret at the end of the paragraph starting with `start`, then `left` characters back. */
async function caretAtEnd(actor: Actor, id: string, start: string, left = 0) {
  await paragraph(actor, id, start).click();
  const caretIn = () => actor.page.evaluate(() => {
    const node = window.getSelection()?.anchorNode;
    return (node instanceof Element ? node : node?.parentElement)?.closest('p')?.textContent ?? '';
  });
  await expect.poll(caretIn, { message: `${actor.label}: the caret is in "${start}"` }).toMatch(new RegExp(`^${start}`));
  await actor.page.keyboard.press('End');
  if (left === 0) return;
  // Arrow keys raced the editor's own selection handling in CI, so the caret moves through the editor.
  await ui.body(actor, id).evaluate((element, { start, left }) => {
    const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
    editor.update(() => {
      const nodes = [...editor.getEditorState()._nodeMap.values()];
      const block = nodes.find(node => node.getType() === 'paragraph' && new RegExp(`^${start}`).test(node.getTextContent()));
      const text = block && (block as unknown as { getLastDescendant(): { getTextContentSize(): number; select(a: number, b: number): void } | null }).getLastDescendant();
      if (!text) throw new Error(`no paragraph "${start}"`);
      const at = text.getTextContentSize() - left;
      text.select(at, at);
    }, { discrete: true });
  }, { start, left });
}

/** Selects the last `back` characters (`all`: every one) of the paragraph starting with `start` (collapsed: the caret before them), through the editor. */
async function selectEnd(actor: Actor, id: string, start: string, back: number | 'all', collapsed = false) {
  await ui.body(actor, id).evaluate((element, { start, back, collapsed }) => {
    const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
    editor.update(() => {
      const nodes = [...editor.getEditorState()._nodeMap.values()];
      const block = nodes.find(node => node.getType() === 'paragraph' && new RegExp(`^${start}`).test(node.getTextContent()));
      const text = block && (block as unknown as { getFirstChild(): { getTextContentSize(): number; select(a: number, b: number): void } | null }).getFirstChild();
      if (!text) throw new Error(`no paragraph "${start}"`);
      const size = text.getTextContentSize();
      const from = back === 'all' ? 0 : size - back;
      text.select(from, collapsed ? from : size);
    }, { discrete: true });
  }, { start, back, collapsed });
}

test('j01 undo: interleaved typing in one paragraph;Ada\'s Cmd+Z keeps Ben\'s words, redo restores hers @p:col-3', async ({ actors, stack }) => {
  const { ada, ben, id } = await setup(actors, stack.baseUrl, 'Intro line.');
  if (!ben) throw new Error('no ben');
  await caretAtEnd(ada, id, 'Intro line');
  await ada.page.keyboard.press('Enter'); await ada.page.keyboard.type('Alpha one');
  await expect(paragraph(ben, id, 'Alpha one')).toBeVisible({ timeout: PEER_TIMEOUT });
  await ada.page.waitForTimeout(NEW_STEP_MS);
  await caretAtEnd(ben, id, 'Alpha one'); await ben.page.keyboard.type(' BEN-TWO');
  await expect(paragraph(ada, id, 'Alpha one BEN-TWO')).toBeVisible({ timeout: PEER_TIMEOUT });
  await caretAtEnd(ada, id, 'Alpha one'); await ada.page.keyboard.type(' three');
  const full = await converged(ada, ben, id, 'typed');
  expect(full).toBe('Intro line.\n\nAlpha one BEN-TWO three');
  await ada.page.waitForTimeout(NEW_STEP_MS);
  const undone = await press(ada, ben, id, UNDO, 2, ['BEN-TWO']);
  expect(undone, 'both of Ada\'s steps are undone and nothing of Ben\'s').toBe('Intro line.\n\n BEN-TWO');
  const redone = await press(ada, ben, id, REDO, 2, ['BEN-TWO']);
  expect(redone, 'redo restores the text exactly').toBe(full);
  await actors.reloadAll();
  for (const actor of [ada, ben]) { await ui.waitLive(actor, id); expect(await docText(actor, id)).toBe(full); }
});

test('j01 undo: Ben joins mid-edit and types inside the word Ada is typing; her Cmd+Z keeps his letters @p:col-3', async ({ actors, stack }) => {
  const { ada, id, openBen } = await setup(actors, stack.baseUrl, 'Intro line.', { benLater: true });
  await caretAtEnd(ada, id, 'Intro line');
  await ada.page.keyboard.press('Enter'); await ada.page.keyboard.type('Words');
  await expect(ui.pane(ada, id)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: PEER_TIMEOUT });
  const ben = await openBen();
  await caretAtEnd(ben, id, 'Words', 3);
  await Promise.all([ada.page.keyboard.type('mith', { delay: 80 }), ben.page.keyboard.type('BEN', { delay: 80 })]);
  const full = await converged(ada, ben, id, 'typed');
  expect(letters(full)).toBe(letters('Intro line.WordsmithBEN'));
  await ada.page.waitForTimeout(NEW_STEP_MS);
  const undone = await press(ada, ben, id, UNDO, 3, ['BEN']);
  expect(undone, 'every letter Ada typed is undone, and only those').toBe('Intro line.\n\nBEN');
  const redone = await press(ada, ben, id, REDO, 3, ['BEN']);
  expect(redone, 'redo restores the text exactly').toBe(full);
});

test('j01 undo: a paragraph split and merge by one peer while the other types; Cmd+Z keeps the other\'s text @p:col-3', async ({ actors, stack }) => {
  const { ada, ben, id } = await setup(actors, stack.baseUrl, 'First half second half.\n\nOther para.');
  if (!ben) throw new Error('no ben');
  // Ada splits the paragraph; Ben types into the half she moved while she types into the other.
  await caretAtEnd(ada, id, 'First half', ' second half.'.length);
  await ada.page.keyboard.press('Enter');
  await expect(paragraph(ben, id, ' ?second half')).toBeVisible({ timeout: PEER_TIMEOUT });
  await caretAtEnd(ben, id, ' ?second half');
  await ada.page.waitForTimeout(NEW_STEP_MS);
  await caretAtEnd(ada, id, 'First half');
  await Promise.all([ada.page.keyboard.type(' ADA', { delay: 60 }), ben.page.keyboard.type(' BEN', { delay: 60 })]);
  await converged(ada, ben, id, 'typed after the split');
  await ada.page.waitForTimeout(NEW_STEP_MS);
  const unsplit = await press(ada, ben, id, UNDO, 2, ['BEN']);
  expect(unsplit, 'Ada\'s split and typing are undone').toContain('First half second half.');
  expect(unsplit).not.toContain('ADA');
  // Ben merges his paragraph into the one above while Ada types into another.
  await caretAtEnd(ada, id, 'Other para');
  await ada.page.waitForTimeout(NEW_STEP_MS);
  await caretAtEnd(ben, id, ' ?BEN', ' BEN'.length);
  await Promise.all([ada.page.keyboard.type(' MORE', { delay: 60 }), ben.page.keyboard.press('Backspace')]);
  const merged = await converged(ada, ben, id, 'merged');
  expect(merged).toContain('MORE');
  await ada.page.waitForTimeout(NEW_STEP_MS);
  const after = await press(ada, ben, id, UNDO, 1, ['BEN']);
  expect(after, 'Ada\'s typing is undone').not.toContain('MORE');
  expect(after.split('\n\n'), 'Ben\'s merge stays').toHaveLength(merged.split('\n\n').length);
  await press(ada, ben, id, REDO, 3, ['BEN']);
  await press(ada, ben, id, UNDO, 3, ['BEN']);
  await press(ada, ben, id, REDO, 3, ['BEN']);
});

test('j01 undo: after a dropped socket reconnects, Ada\'s Cmd+Z keeps what Ben typed into her line meanwhile @p:col-3 @p:col-4', async ({ actors, stack }) => {
  const { ada, ben, id } = await setup(actors, stack.baseUrl, 'Intro line.', { severable: true });
  if (!ben || !ada.sever) throw new Error('setup');
  await caretAtEnd(ada, id, 'Intro line');
  await ada.page.keyboard.press('Enter'); await ada.page.keyboard.type('Before drop');
  await expect(paragraph(ben, id, 'Before drop')).toBeVisible({ timeout: PEER_TIMEOUT });
  await expect(ui.pane(ada, id)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: PEER_TIMEOUT });
  await ada.page.waitForTimeout(NEW_STEP_MS);
  ada.expectReconnects(3, id);
  ada.sever.reset();
  await ada.page.keyboard.type(' offline');
  await caretAtEnd(ben, id, 'Before drop'); await ben.page.keyboard.type(' BEN-MEANWHILE');
  await expect(ui.pane(ada, id)).toHaveAttribute(SYNC_UNACKED_ATTR, '1');
  ada.sever.restore();
  await expect(ui.pane(ada, id)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: 20_000 });
  const full = await converged(ada, ben, id, 'reconnected');
  expect(full).toContain('BEN-MEANWHILE'); expect(full).toContain('offline');
  await ada.page.waitForTimeout(NEW_STEP_MS);
  const undone = await press(ada, ben, id, UNDO, 2, ['BEN-MEANWHILE']);
  expect(undone, 'Ada\'s typing before and during the drop is undone').toBe('Intro line.\n\n BEN-MEANWHILE');
  const redone = await press(ada, ben, id, REDO, 2, ['BEN-MEANWHILE']);
  expect(redone, 'redo restores the text exactly').toBe(full);
  await expect(ui.pane(ada, id)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: PEER_TIMEOUT });
  await actors.reloadAll();
  for (const actor of [ada, ben]) { await ui.waitLive(actor, id); expect(await docText(actor, id)).toBe(full); }
});

test('j01 undo: Ada deletes Ben\'s words, undoes that, then undoes her line; his words stay on both screens @p:col-3', async ({ actors, stack }) => {
  const { ada, ben, id } = await setup(actors, stack.baseUrl, 'Intro line.');
  if (!ben) throw new Error('no ben');
  await caretAtEnd(ada, id, 'Intro line');
  await ada.page.keyboard.press('Enter'); await ada.page.keyboard.type('Alpha');
  await expect(paragraph(ben, id, 'Alpha')).toBeVisible({ timeout: PEER_TIMEOUT });
  await caretAtEnd(ben, id, 'Alpha'); await ben.page.keyboard.type(' BEN');
  await expect(paragraph(ada, id, 'Alpha BEN')).toBeVisible({ timeout: PEER_TIMEOUT });
  await ada.page.waitForTimeout(NEW_STEP_MS);
  await caretAtEnd(ada, id, 'Alpha BEN');
  for (let i = 0; i < ' BEN'.length; i++) await ada.page.keyboard.press('Backspace');
  expect(await converged(ada, ben, id, 'deleted')).toBe('Intro line.\n\nAlpha');
  await ada.page.waitForTimeout(NEW_STEP_MS);
  // Undoing the delete restores Ben's words as copies made by Ada's client; they are still his.
  expect(await press(ada, ben, id, UNDO, 1, ['BEN']), 'undoing the delete restores Ben\'s words').toBe('Intro line.\n\nAlpha BEN');
  expect(await press(ada, ben, id, UNDO, 2, ['BEN']), 'only Ada\'s line is undone').toBe('Intro line.\n\n BEN');
  // Redo replays Ada's own delete of Ben's words last; a second round restores copies of the copies.
  expect(await press(ada, ben, id, REDO, 3, []), 'redo replays Ada\'s delete last').toBe('Intro line.\n\nAlpha');
  expect(await press(ada, ben, id, UNDO, 3, ['BEN'])).toBe('Intro line.\n\n BEN');
  await press(ada, ben, id, REDO, 3, []);
  expect(await converged(ada, ben, id, 'redone again')).toBe('Intro line.\n\nAlpha');
});

test('j01 undo: Ben opens cold, Ada deletes her whole line holding his words and undoes; his words survive a reload @p:col-3', async ({ actors, stack }) => {
  const { ada, id, openBen } = await setup(actors, stack.baseUrl, 'Intro line.', { benLater: true });
  await caretAtEnd(ada, id, 'Intro line');
  await ada.page.keyboard.press('Enter'); await ada.page.keyboard.type('Alpha line');
  await expect(ui.pane(ada, id)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: PEER_TIMEOUT });
  const ben = await openBen();
  await caretAtEnd(ben, id, 'Alpha line'); await ben.page.keyboard.type(' typed by Ben');
  await expect(paragraph(ada, id, 'Alpha line typed by Ben')).toBeVisible({ timeout: PEER_TIMEOUT });
  await ada.page.waitForTimeout(NEW_STEP_MS);
  // Backspace over the whole line deletes Ada's text node, Ben's words in it included.
  await caretAtEnd(ada, id, 'Alpha line');
  await selectEnd(ada, id, 'Alpha line', 'Alpha line typed by Ben'.length);
  await ada.page.keyboard.press('Backspace');
  expect(await converged(ada, ben, id, 'deleted')).toBe('Intro line.\n\n');
  await ada.page.waitForTimeout(NEW_STEP_MS);
  expect(await press(ada, ben, id, UNDO, 1, ['typed by Ben']), 'undoing the delete restores the line').toBe('Intro line.\n\nAlpha line typed by Ben');
  const undone = await press(ada, ben, id, UNDO, 2, ['typed by Ben']);
  expect(undone, 'only Ada\'s line is undone').toBe('Intro line.\n\n typed by Ben');
  await actors.reloadAll();
  for (const actor of [ada, ben]) { await ui.waitLive(actor, id); expect(await docText(actor, id), 'Ben\'s words survive a reload').toBe(undone); }
});

test('j01 undo: Ada creates a line and deletes Ben\'s words from it within one undo step; her Cmd+Z keeps them @p:col-3', async ({ actors, stack }) => {
  const { ada, ben, id } = await setup(actors, stack.baseUrl, 'Intro line.');
  if (!ben) throw new Error('no ben');
  await caretAtEnd(ada, id, 'Intro line');
  await ada.page.keyboard.press('Enter'); await ada.page.keyboard.type('Alpha');
  // Ada keeps typing at the start of her line, each key within the capture window (1 s), until Ben's words arrive.
  await selectEnd(ada, id, 'Alpha', 'Alpha'.length, true);
  const benTypes = (async () => {
    await expect(paragraph(ben, id, 'x*Alpha')).toBeVisible({ timeout: PEER_TIMEOUT });
    await caretAtEnd(ben, id, 'x*Alpha'); await ben.page.keyboard.type(' BEN');
  })();
  for (let i = 0; !(await docText(ada, id)).includes(' BEN'); i++) {
    expect(i, 'Ben\'s words reach Ada').toBeLessThan(80);
    await ada.page.keyboard.type('x');
    await ada.page.waitForTimeout(200);
  }
  await benTypes;
  await selectEnd(ada, id, 'x*Alpha', ' BEN'.length);
  await ada.page.keyboard.press('Backspace');
  const deleted = await converged(ada, ben, id, 'deleted');
  expect(deleted).toMatch(/^Intro line\.\n\nx+Alpha$/);
  await ada.page.waitForTimeout(NEW_STEP_MS);
  const undone = await press(ada, ben, id, UNDO, 2, ['BEN']);
  expect(undone, 'only Ada\'s line is undone').toBe('Intro line.\n\n BEN');
  const redone = await press(ada, ben, id, REDO, 2, []);
  expect(redone, 'redo replays Ada\'s line and her delete').toBe(deleted);
  await actors.reloadAll();
  for (const actor of [ada, ben]) { await ui.waitLive(actor, id); expect(await docText(actor, id)).toBe(deleted); }
});

/** Selects from the end of the paragraph starting with `from` through the end of the one starting with `to`, through the editor. */
async function selectAcross(actor: Actor, id: string, from: string, to: string) {
  await ui.body(actor, id).evaluate((element, { from, to }) => {
    type Text = { getKey(): string; getTextContentSize(): number; select(a: number, b: number): { focus: { set(key: string, offset: number, type: 'text'): void } } };
    const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
    editor.update(() => {
      const nodes = [...editor.getEditorState()._nodeMap.values()];
      const last = (start: string) => {
        const block = nodes.find(node => node.getType() === 'paragraph' && new RegExp(`^${start}`).test(node.getTextContent()));
        const text = block && (block as unknown as { getLastDescendant(): Text | null }).getLastDescendant();
        if (!text) throw new Error(`no paragraph "${start}"`);
        return text;
      };
      const anchor = last(from); const focus = last(to);
      anchor.select(anchor.getTextContentSize(), anchor.getTextContentSize()).focus.set(focus.getKey(), focus.getTextContentSize(), 'text');
    }, { discrete: true });
  }, { from, to });
}

for (const { what, select, deleted } of [
  // Selecting the whole line and pressing Backspace deletes Ada's text node, Ben's words in it included.
  { what: 'text node', select: (ada: Actor, id: string) => selectEnd(ada, id, 'BEN Alpha', 'all'), deleted: 'Intro line.\n\n' },
  // Selecting from the end of the line above through the end of hers deletes her paragraph, Ben's words in it included.
  { what: 'paragraph', select: (ada: Actor, id: string) => selectAcross(ada, id, 'Intro line', 'BEN Alpha'), deleted: 'Intro line.' },
]) {
  test(`j01 undo: Ada creates a line and deletes the whole ${what} holding Ben's words within one undo step; her Cmd+Z keeps them @p:col-3`, async ({ actors, stack }) => {
    const { ada, ben, id } = await setup(actors, stack.baseUrl, 'Intro line.');
    if (!ben) throw new Error('no ben');
    await caretAtEnd(ada, id, 'Intro line');
    await ada.page.keyboard.press('Enter'); await ada.page.keyboard.type('Alpha');
    // Ben types at the start of Ada's line while she keeps typing at its end within the capture window (1 s).
    const benTypes = (async () => {
      await expect(paragraph(ben, id, 'Alpha')).toBeVisible({ timeout: PEER_TIMEOUT });
      await selectEnd(ben, id, 'Alpha', 'all', true); await ben.page.keyboard.type('BEN ');
    })();
    for (let i = 0; !(await docText(ada, id)).includes('BEN '); i++) {
      expect(i, 'Ben\'s words reach Ada').toBeLessThan(80);
      await ada.page.keyboard.type('x');
      await ada.page.waitForTimeout(200);
    }
    await benTypes;
    await ada.page.keyboard.type('x');
    await select(ada, id);
    await ada.page.keyboard.press('Backspace');
    expect(await converged(ada, ben, id, 'deleted')).toBe(deleted);
    await ada.page.waitForTimeout(NEW_STEP_MS);
    const undone = await press(ada, ben, id, UNDO, 1, ['BEN']);
    expect(undone, 'only Ada\'s line is undone').toBe('Intro line.\n\nBEN ');
    expect(await press(ada, ben, id, REDO, 1, []), 'redo replays Ada\'s delete').toBe(deleted);
    expect(await press(ada, ben, id, UNDO, 1, ['BEN']), 'a second undo keeps Ben\'s words').toBe(undone);
    await expect(ui.pane(ada, id)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: PEER_TIMEOUT });
    await actors.reloadAll();
    for (const actor of [ada, ben]) { await ui.waitLive(actor, id); expect(await docText(actor, id), 'Ben\'s words survive a reload').toBe(undone); }
  });
}

for (const { what, select, deleted } of [
  { what: 'text node', select: (ada: Actor, id: string) => selectEnd(ada, id, 'Ben line', 'all'), deleted: 'Intro line.\n\n' },
  { what: 'paragraph', select: (ada: Actor, id: string) => selectAcross(ada, id, 'Intro line', 'Ben line'), deleted: 'Intro line.' },
]) {
  test(`j01 undo: Ben types into his ${what} after Ada undoes deleting it; her Cmd+Shift+Z keeps his new words @p:col-3`, async ({ actors, stack }) => {
    const { ada, ben, id } = await setup(actors, stack.baseUrl, 'Intro line.');
    if (!ben) throw new Error('no ben');
    await caretAtEnd(ben, id, 'Intro line');
    await ben.page.keyboard.press('Enter'); await ben.page.keyboard.type('Ben line');
    await expect(paragraph(ada, id, 'Ben line')).toBeVisible({ timeout: PEER_TIMEOUT });
    await caretAtEnd(ada, id, 'Ben line');
    await select(ada, id);
    await ada.page.keyboard.press('Backspace');
    expect(await converged(ada, ben, id, 'deleted')).toBe(deleted);
    await ada.page.waitForTimeout(NEW_STEP_MS);
    expect(await press(ada, ben, id, UNDO, 1, ['Ben line']), 'undo restores Ben\'s line').toBe('Intro line.\n\nBen line');
    await caretAtEnd(ben, id, 'Ben line'); await ben.page.keyboard.type(' NEW');
    expect(await converged(ada, ben, id, 'Ben typed')).toBe('Intro line.\n\nBen line NEW');
    const redone = await press(ada, ben, id, REDO, 1, ['NEW']);
    expect(redone, 'redo deletes only the words Ada deleted').toBe('Intro line.\n\n NEW');
    expect(await press(ada, ben, id, UNDO, 1, ['Ben line NEW'])).toBe('Intro line.\n\nBen line NEW');
    expect(await press(ada, ben, id, REDO, 1, ['NEW'])).toBe(redone);
    await expect(ui.pane(ada, id)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: PEER_TIMEOUT });
    await actors.reloadAll();
    for (const actor of [ada, ben]) { await ui.waitLive(actor, id); expect(await docText(actor, id), 'Ben\'s new words survive a reload').toBe(redone); }
  });
}
