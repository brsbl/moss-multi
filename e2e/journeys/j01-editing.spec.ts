import type { LexicalEditor } from 'lexical';
import type { TableNode } from '@lexical/table';
import { expect, test, ui } from '../lib/test.ts';
import type { Actor, Actors } from '../lib/actors.ts';

const fixture = 'Shared paragraph.\n\n| Original | Value |\n| --- | --- |\n| cell | 1 |\n\n:::tabs\n=== First\nFirst panel\n=== Second\nSecond panel\n:::\n\n## Fold me\n\nHidden paragraph.\n\n{{timeline|6 weeks}}';
async function setup(actors: Actors, baseUrl: string, markdown = fixture) {
  const ada = await actors.session(await actors.principal('ada'));
  const result = await ada.context.request.post('/api/docs', { headers: { origin: baseUrl }, data: { title: 'Editing', markdown } });
  expect(result.status()).toBe(201);
  const { doc: { id } } = await result.json() as { doc: { id: string } };
  const principal = await actors.principal('ben');
  expect((await ada.context.request.post(`/api/docs/${id}/members`, { headers: { origin: baseUrl }, data: { email: principal.email, role: 'editor' } })).status()).toBe(201);
  const wire: Buffer[] = [];
  ada.page.on('websocket', socket => {
    if (!socket.url().includes(id)) return;
    for (const event of ['framesent', 'framereceived'] as const) socket.on(event, ({ payload }) => { if (typeof payload !== 'string') wire.push(payload); });
  });
  await ada.goto(`/d/${id}`);
  const ben = await actors.open(principal, { path: `/d/${id}` });
  for (const actor of [ada, ben]) { await ui.waitLive(actor, id); await actor.observeEditor(id); }
  return { ada, ben, id, wire };
}
async function paragraphEnd(actor: Actor, id: string) {
  await ui.body(actor, id).locator('p').filter({ hasText: /^Shared paragraph/ }).click();
  await actor.page.keyboard.press('End');
}
async function paste(actor: Actor, id: string, markdown: string) {
  await ui.body(actor, id).evaluate((element, text) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text); clipboardData.setData('text/markdown', text);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  }, markdown);
}
async function widths(actor: Actor, id: string, write = false) {
  return ui.body(actor, id).evaluate((element, write) => {
    const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
    const read = () => [...editor.getEditorState()._nodeMap.values()].filter(n => n.getType() === 'table').map(n => ({ text: n.getTextContent(), widths: (n as TableNode).getColWidths() ?? [] }));
    if (write) editor.update(() => {
      for (const node of editor.getEditorState()._nodeMap.values()) {
        if (node.getType() === 'table') (node as TableNode).setColWidths([210, 170]);
        if (node.getType() === 'tab-group') (node as unknown as { setTabWidths(w: number[]): void; setActiveIndex(i: number): void }).setTabWidths([180, 200]);
      }
    }, { discrete: true, tag: 'table-column-resize' });
    return editor.getEditorState().read(read);
  }, write);
}
async function tabs(actor: Actor, id: string) {
  return ui.body(actor, id).evaluate(element => {
    const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
    return editor.getEditorState().read(() => [...editor.getEditorState()._nodeMap.values()].filter(n => n.getType() === 'tab-group').map(n => {
      const tab = n as unknown as { getTabWidths(): number[]; getActiveIndex(): number };
      return { widths: tab.getTabWidths(), active: tab.getActiveIndex() };
    }));
  });
}

test('j01 editing: concurrent typing, local undo and paste retain both authors @p:col-1 @p:col-3', async ({ actors, stack }) => {
  const { ada, ben, id } = await setup(actors, stack.baseUrl, 'Shared paragraph.');
  await Promise.all([paragraphEnd(ada, id), paragraphEnd(ben, id)]);
  await Promise.all([ada.page.keyboard.type(' AAA', { delay: 30 }), ben.page.keyboard.type(' BBB', { delay: 30 })]);
  await expect.poll(async () => ui.fieldText(ada, id, 'body')).toBe(await ui.fieldText(ben, id, 'body'));
  for (const actor of [ada, ben]) { await expect(ui.body(actor, id)).toContainText('AAA'); await expect(ui.body(actor, id)).toContainText('BBB'); }
  await ada.page.keyboard.press('ControlOrMeta+z');
  for (const actor of [ada, ben]) { await expect(ui.body(actor, id)).not.toContainText('AAA'); await expect(ui.body(actor, id)).toContainText('BBB'); }
  await paragraphEnd(ada, id); await paragraphEnd(ben, id);
  await Promise.all([paste(ada, id, '\n\n**Pasted content**'), ben.page.keyboard.type(' PEER')]);
  for (const actor of [ada, ben]) { await expect(ui.body(actor, id)).toContainText('Pasted content'); await expect(ui.body(actor, id)).toContainText('PEER'); }
});

test('j01 editing: title undo is local and redo preserves the peer @p:col-3', async ({ actors, stack }) => {
  const { ada, ben, id } = await setup(actors, stack.baseUrl);
  await ui.title(ada, id).click(); await ada.page.keyboard.press('End'); await ada.page.keyboard.type(' Ada');
  await expect(ui.title(ben, id)).toContainText('Ada');
  await ui.title(ben, id).click(); await ben.page.keyboard.press('End'); await ben.page.keyboard.type(' Ben');
  await expect(ui.title(ada, id)).toContainText('Ben');
  await ui.title(ada, id).click(); await ada.page.keyboard.press('ControlOrMeta+z');
  await expect(ui.title(ada, id)).toHaveText('Editing Ben'); await expect(ui.title(ben, id)).toHaveText('Editing Ben');
  await ada.page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(ui.title(ben, id)).toHaveText('Editing Ada Ben');
});

test('j01 editing: local layout survives reload and a peer table inserted above; frames exclude only viewer fields @p:R11 @p:col-1', async ({ actors, stack }) => {
  const { ada, ben, id, wire } = await setup(actors, stack.baseUrl);
  await widths(ada, id, true);
  await ui.body(ada, id).getByText('Second', { exact: true }).click();
  await expect.poll(() => tabs(ada, id)).toEqual([{ widths: [180, 200], active: 1 }]);
  expect((await widths(ben, id))[0].widths).toEqual([]);
  expect((await tabs(ben, id))[0]).toEqual({ widths: [], active: 0 });
  await ui.body(ada, id).getByRole('heading', { name: 'Fold me' }).hover();
  await ada.page.getByRole('button', { name: 'Collapse section', exact: true }).click();
  await expect(ui.body(ada, id).getByText('Hidden paragraph.', { exact: true })).toBeHidden();
  await expect(ui.body(ben, id).getByText('Hidden paragraph.', { exact: true })).toBeVisible();
  await ada.page.waitForTimeout(400);
  await actors.reloadAll();
  for (const actor of [ada, ben]) await ui.waitLive(actor, id);
  expect((await widths(ada, id))[0].widths).toEqual([210, 170]);
  expect((await tabs(ada, id))[0]).toEqual({ widths: [180, 200], active: 1 });
  await expect(ui.body(ada, id).getByText('Hidden paragraph.', { exact: true })).toBeHidden();
  await paragraphEnd(ben, id); await ben.page.keyboard.press('ControlOrMeta+Home');
  await paste(ben, id, '| Added | New |\n| --- | --- |\n| x | y |\n\n');
  await expect(ui.body(ada, id).locator('table')).toHaveCount(2);
  await actors.reloadAll();
  for (const actor of [ada, ben]) await ui.waitLive(actor, id);
  expect((await widths(ada, id)).find(t => t.text.includes('Original'))?.widths).toEqual([210, 170]);
  expect((await widths(ada, id)).find(t => t.text.includes('Added'))?.widths).toEqual([]);
  const frames = Buffer.concat(wire).toString('utf8');
  for (const key of ['__activeIndex', '__tabWidths', '__colWidths', '__resolutionState', '--formula-draft-chip', '--link-selection']) expect(frames).not.toContain(key);
  for (const key of ['__type', '__result', '__name']) expect(frames).toContain(key);
});

test('j01 editing: floating toolbar hides on blur and returns on selection @p:col-1', async ({ actors, stack }) => {
  const { ada, id } = await setup(actors, stack.baseUrl, 'Shared paragraph.');
  const toolbar = ada.page.locator('[data-floating-selection-toolbar]');
  await paragraphEnd(ada, id); await ada.page.keyboard.press('Shift+Home');
  await expect(toolbar).toBeVisible();
  await ui.title(ada, id).click(); await expect(toolbar).toHaveCount(0);
  await paragraphEnd(ada, id); await ada.page.keyboard.press('Shift+Home'); await expect(toolbar).toBeVisible();
});

test('j01 editing: 60 second concurrent typing soak has no cascade or lost text @slow @p:col-1', async ({ actors, stack }) => {
  test.setTimeout(120_000);
  const { ada, ben, id } = await setup(actors, stack.baseUrl, 'Shared paragraph.');
  await paragraphEnd(ada, id); await paragraphEnd(ben, id);
  const until = Date.now() + 60_000; let count = 0;
  while (Date.now() < until) {
    await Promise.all([ada.page.keyboard.type(` a${count} `), ben.page.keyboard.type(` b${count} `)]); count++;
    await ada.page.waitForTimeout(200);
  }
  await expect.poll(async () => ui.fieldText(ada, id, 'body')).toBe(await ui.fieldText(ben, id, 'body'));
  const text = await ui.fieldText(ada, id, 'body');
  for (let n = 0; n < count; n++) for (const author of ['a', 'b']) expect(text).toContain(`${author}${n}`);
});
