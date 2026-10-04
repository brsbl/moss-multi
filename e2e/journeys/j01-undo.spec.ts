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
  for (let i = 0; i < left; i++) await actor.page.keyboard.press('ArrowLeft');
}

test('j01 undo: interleaved typing in one paragraph; Ada\'s Cmd+Z keeps Ben\'s words, redo restores hers @p:col-3', async ({ actors, stack }) => {
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
  expect(letters(redone)).toBe(letters(full));
  await actors.reloadAll();
  for (const actor of [ada, ben]) { await ui.waitLive(actor, id); expect(letters(await docText(actor, id))).toBe(letters(full)); }
});

test('j01 undo: Ben joins mid-edit and types inside the word Ada is typing; her Cmd+Z keeps his letters @p:col-3', async ({ actors, stack }) => {
  const { ada, id, openBen } = await setup(actors, stack.baseUrl, 'Intro line.', { benLater: true });
  await caretAtEnd(ada, id, 'Intro line');
  await ada.page.keyboard.press('Enter'); await ada.page.keyboard.type('Words');
  await expect(ui.pane(ada, id)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: PEER_TIMEOUT });
  const ben = await openBen();
  await caretAtEnd(ben, id, 'Words');
  for (let i = 0; i < 3; i++) await ben.page.keyboard.press('ArrowLeft');
  await Promise.all([ada.page.keyboard.type('mith', { delay: 80 }), ben.page.keyboard.type('BEN', { delay: 80 })]);
  const full = await converged(ada, ben, id, 'typed');
  expect(letters(full)).toBe(letters('Intro line.WordsmithBEN'));
  await ada.page.waitForTimeout(NEW_STEP_MS);
  const undone = await press(ada, ben, id, UNDO, 3, ['BEN']);
  expect(undone, 'every letter Ada typed is undone, and only those').toBe('Intro line.\n\nBEN');
  const redone = await press(ada, ben, id, REDO, 3, ['BEN']);
  expect(letters(redone)).toBe(letters(full));
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
  expect(letters(redone)).toBe(letters(full));
  await expect(ui.pane(ada, id)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: PEER_TIMEOUT });
  await actors.reloadAll();
  for (const actor of [ada, ben]) { await ui.waitLive(actor, id); expect(letters(await docText(actor, id))).toBe(letters(full)); }
});
