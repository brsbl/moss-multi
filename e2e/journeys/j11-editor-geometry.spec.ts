// T9.44: two editor surfaces keep moss's geometry in a bound note. The HTML source editor on a short live preview
// shows its whole 96 px source viewport between its header and footer, and a formula draft is moss's padded,
// rounded chip, painted for the typist alone and never written to the shared note.
import type { LexicalEditor } from 'lexical';
import type { Actor, Actors } from '../lib/actors.ts';
import { grantDoc } from '../lib/grants.ts';
import { expect, test, ui } from '../lib/test.ts';

async function note(actors: Actors, baseUrl: string, title: string, markdown: string, withBen = false) {
  const ada = await actors.session(await actors.principal('ada'));
  const result = await ada.context.request.post('/api/docs', { headers: { origin: baseUrl }, data: { title, markdown } });
  expect(result.status()).toBe(201);
  const { doc: { id } } = await result.json() as { doc: { id: string } };
  const wire: Buffer[] = [];
  ada.page.on('websocket', socket => {
    if (!socket.url().includes(id)) return;
    socket.on('framesent', ({ payload }) => { if (typeof payload !== 'string') wire.push(payload); });
  });
  let ben: Actor | null = null;
  if (withBen) {
    const principal = await actors.principal('ben');
    await grantDoc(ada, id, principal);
    ben = await actors.open(principal, { path: `/d/${id}` });
  }
  await ada.goto(`/d/${id}`);
  for (const actor of ben ? [ada, ben] : [ada]) { await ui.waitLive(actor, id); await actor.observeEditor(id); }
  return { ada, ben, id, wire };
}

const surfaceHeight = (actor: Actor, id: string) => ui.body(actor, id).locator('.editor-block-surface').first()
  .evaluate(element => element.getBoundingClientRect().height);

test('j11 editor geometry: the HTML source editor of a short live preview shows its whole source viewport @p:note-2', async ({ actors, stack }) => {
  actors.solo('one editor opens the source of her own HTML block; the frame is local layout');
  const { ada, id } = await note(actors, stack.baseUrl, 'HTML source', 'Intro.\n\n```moss-html\n<p>An HTML block.</p>\n```\n\nLast line.');
  await expect(ui.body(ada, id).locator('[data-moss-html-preview-viewport]')).toBeVisible();
  await expect.poll(() => surfaceHeight(ada, id), { message: 'the live preview is shorter than the source editor needs' }).toBeLessThan(171);
  const preview = await surfaceHeight(ada, id);

  await ui.openHtmlSource(ada, id);
  const textarea = ui.body(ada, id).locator('textarea.moss-codeblock-textarea');
  await expect(textarea).toBeFocused();
  const measure = () => textarea.evaluate(element => {
    const viewport = element.parentElement!.getBoundingClientRect();
    const surface = element.closest('.editor-block-surface')!.getBoundingClientRect();
    return { viewport: viewport.height, surface: surface.height };
  });
  const open = await measure();
  expect(open.viewport, 'the source viewport is the textarea\'s 96 px minimum').toBeGreaterThanOrEqual(96);
  expect(open.surface, 'header 40 + source 96 + footer 33 + border 2').toBeGreaterThanOrEqual(171);
  await ada.page.keyboard.press('End');
  await ada.page.keyboard.type('<p>More.</p>');
  await expect(textarea).toHaveValue('<p>An HTML block.</p><p>More.</p>');
  expect((await measure()).viewport, 'typing keeps the source viewport').toBeGreaterThanOrEqual(96);

  await ada.page.keyboard.press('Escape');
  await expect(textarea).toHaveCount(0);
  await expect.poll(() => surfaceHeight(ada, id), { message: 'closing returns the frame to its live preview height' }).toBeLessThan(171);
  expect(preview).toBeGreaterThan(0);
});

/** The rects of the draft's text, its paragraph, its chip and the caret, in Ada's page. */
const draftGeometry = (actor: Actor, id: string, paragraphText: string, draft: string) => ui.body(actor, id).evaluate((root, [paragraphText, draft]) => {
  const paragraph = [...root.querySelectorAll('p')].find(p => p.textContent === paragraphText);
  if (!paragraph) return null;
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
  let text: Text | null = null;
  while (walker.nextNode()) if ((walker.currentNode.textContent ?? '').includes(draft)) text = walker.currentNode as Text;
  if (!text) return null;
  const start = text.data.lastIndexOf(draft);
  const range = document.createRange(); range.setStart(text, start); range.setEnd(text, start + draft.length);
  const before = document.createRange();
  if (start > 0) { before.setStart(text, start - 2); before.setEnd(text, start - 1); }
  const chip = document.querySelector('[data-formula-draft-chip]');
  const selection = getSelection()!.rangeCount ? getSelection()!.getRangeAt(0).getBoundingClientRect() : null;
  return {
    paragraph: paragraph.getBoundingClientRect().toJSON() as DOMRect,
    text: range.getBoundingClientRect().toJSON() as DOMRect,
    before: start > 0 ? before.getBoundingClientRect().toJSON() as DOMRect : null,
    chip: chip ? chip.getBoundingClientRect().toJSON() as DOMRect : null,
    radius: chip ? getComputedStyle(chip).borderRadius : null,
    lineHeight: parseFloat(getComputedStyle(text.parentElement!).lineHeight),
    caret: selection?.left ?? NaN,
  };
}, [paragraphText, draft] as const);

const textStyles = (actor: Actor, id: string) => ui.body(actor, id).evaluate(element => {
  const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
  return editor.read(() => [...editor.getEditorState()._nodeMap.values()]
    .filter(n => n.getType() === 'text' && n.isAttached())
    .map(n => (n as unknown as { getStyle(): string }).getStyle()).filter(Boolean));
});

test('j11 editor geometry: a formula draft is moss\'s padded, rounded chip for the typist only, and nothing of it is shared @p:note-2', async ({ actors, stack }) => {
  const { ada, ben, id, wire } = await note(actors, stack.baseUrl, 'Formula draft', 'Intro.\n\nTotal cost\n\nLast line.', true);
  await ui.body(ada, id).locator('p').filter({ hasText: /^Total cost$/ }).click();
  await ada.page.keyboard.press('End');
  await ada.page.keyboard.press('Enter');
  await ada.page.keyboard.type('=2+3', { delay: 40 });

  await expect.poll(async () => (await draftGeometry(ada, id, '=2+3', '=2+3'))?.chip ?? null, { message: 'Ada sees the draft chip' }).not.toBeNull();
  const own = (await draftGeometry(ada, id, '=2+3', '=2+3'))!;
  const chip = own.chip!;
  expect(own.text.left - own.paragraph.left, 'the draft text sits inside 8 px of chip padding').toBeCloseTo(8, 0);
  expect(chip.left).toBeCloseTo(own.paragraph.left, 0);
  expect(chip.width, 'the chip is the text plus 8 px a side').toBeCloseTo(own.text.width + 16, 0);
  expect(chip.height, 'the chip is the line plus 2 px above and below').toBeCloseTo(own.lineHeight + 4, 0);
  expect(chip.top + chip.height / 2).toBeCloseTo(own.text.top + own.text.height / 2, 0);
  expect(own.radius).toBe('6px');
  expect(Math.abs(own.caret - own.text.right), 'the caret stays at the end of the typed text').toBeLessThan(1.5);

  await expect.poll(() => ui.fieldText(ben!, id, 'body')).toContain('=2+3');
  await expect(ben!.page.locator('[data-formula-draft-chip]'), 'Ben is not drafting, so he sees no chip').toHaveCount(0);
  const theirs = (await draftGeometry(ben!, id, '=2+3', '=2+3'))!;
  expect(theirs.text.left - theirs.paragraph.left, "Ben's line is not padded").toBeCloseTo(0, 0);

  // A draft inside a longer text run pads only into the room the text leaves.
  await ui.body(ada, id).locator('p').filter({ hasText: /^Total cost$/ }).click();
  await ada.page.keyboard.press('End');
  await ada.page.keyboard.type(' =4*5', { delay: 40 });
  await expect.poll(async () => (await draftGeometry(ada, id, 'Total cost =4*5', '=4*5'))?.chip?.left ?? null).not.toBeNull();
  const inline = (await draftGeometry(ada, id, 'Total cost =4*5', '=4*5'))!;
  expect(inline.chip!.left, 'the chip does not cover the word before it').toBeGreaterThanOrEqual(inline.before!.right - 0.5);
  expect(inline.chip!.right).toBeCloseTo(inline.text.right + 8, 0);

  await ada.page.keyboard.press('ArrowUp');
  await expect(ada.page.locator('[data-formula-draft-chip]'), 'leaving the draft clears its chip').toHaveCount(0);
  await expect(ui.body(ada, id).locator('[data-lexical-text][style*="padding"]'), 'the padding goes with the chip').toHaveCount(0);

  expect(await textStyles(ada, id), 'no draft style is written to the note').toEqual([]);
  await ui.waitAcked(ada, id);
  const frames = Buffer.concat(wire).toString('utf8');
  for (const marker of ['--formula-draft-chip', 'padding-left', 'padding-right', 'border-radius']) expect(frames).not.toContain(marker);
});
