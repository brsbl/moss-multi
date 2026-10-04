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
    const record = ({ payload }: { payload: string | Buffer }) => { if (typeof payload !== 'string') wire.push(payload); };
    socket.on('framesent', record); socket.on('framereceived', record);
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
  await expect.poll(async () => (await ui.fieldText(ada, id, 'body')) === (await ui.fieldText(ben, id, 'body'))).toBe(true);
  for (const actor of [ada, ben]) { const text = await ui.fieldText(actor, id, 'body'); expect(text.match(/A/g)).toHaveLength(3); expect(text.match(/B/g)).toHaveLength(3); }
  await ada.page.keyboard.press('ControlOrMeta+z');
  for (const actor of [ada, ben]) { await expect.poll(async () => (await ui.fieldText(actor, id, 'body')).match(/A/g)?.length ?? 0).toBe(0); expect((await ui.fieldText(actor, id, 'body')).match(/B/g)).toHaveLength(3); }
  await paragraphEnd(ada, id); await paragraphEnd(ben, id);
  await Promise.all([paste(ada, id, '\n\n**Pasted content**'), ben.page.keyboard.type(' PEER')]);
  for (const actor of [ada, ben]) { await expect(ui.body(actor, id)).toContainText('Pasted content'); await expect.poll(async () => (await ui.fieldText(actor, id, 'body')).replace('Pasted content', '')).toContain('PEER'); }
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
  await expect.poll(() => ada.page.evaluate(id => JSON.parse(localStorage.getItem(`moss-multi:collapsed-headings:${id}`) ?? '[]').length, id)).toBe(1);
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
    await Promise.all([ada.page.keyboard.type('A'), ben.page.keyboard.type('B')]); count++;
    await ada.page.waitForTimeout(200);
  }
  await expect.poll(async () => (await ui.fieldText(ada, id, 'body')) === (await ui.fieldText(ben, id, 'body'))).toBe(true);
  const text = await ui.fieldText(ada, id, 'body');
  expect(text.match(/A/g)).toHaveLength(count); expect(text.match(/B/g)).toHaveLength(count);
});

test('j01 editing: Insert row adds exactly one row to both peers @p:col-1', async ({ actors, stack }) => {
  const { ada, ben, id } = await setup(actors, stack.baseUrl);
  await ui.body(ada, id).getByRole('cell', { name: 'cell', exact: true }).click();
  await ada.page.getByRole('button', { name: 'Table actions', exact: true }).click();
  await ada.page.getByRole('menuitem', { name: 'Insert below', exact: true }).click();
  for (const actor of [ada, ben]) await expect(ui.body(actor, id).locator('table tr')).toHaveCount(3);
  await ada.page.waitForTimeout(300);
  for (const actor of [ada, ben]) await expect(ui.body(actor, id).locator('table tr')).toHaveCount(3);
  await ui.title(ada, id).click();
});

test('j01 editing: split panes own one socket each and never show the same doc twice @p:col-1', async ({ actors, stack }) => {
  const { ada, id } = await setup(actors, stack.baseUrl);
  const response = await ada.context.request.post('/api/docs', { headers: { origin: stack.baseUrl }, data: { title: 'Second note', markdown: 'Second body' } });
  const { doc: { id: second } } = await response.json();
  await expect(ada.page.locator(`[data-sidebar-row][data-doc-id="${second}"]`)).toBeVisible();
  await ada.page.locator(`[data-sidebar-row][data-doc-id="${second}"]`).click({ button: 'right' });
  await ada.page.getByRole('menuitem', { name: 'Open in Split Tab', exact: true }).click();
  await ui.waitLive(ada, second);
  await expect(ada.page.locator('[data-editor-pane]')).toHaveCount(2);
  for (const docId of [id, second]) expect(ada.telemetry.sockets.filter(s => s.docId === docId && s.closedAt === null)).toHaveLength(1);
  await ui.body(ada, second).click(); await ada.page.keyboard.press('End'); await ada.page.keyboard.type(' changed');
  await expect(ui.body(ada, second)).toContainText('changed');
  await expect(ui.pane(ada, second)).toHaveAttribute('data-sync-unacked', '0');
  await ui.body(ada, id).click();
  ada.observations.delete(id);
  ada.expectReconnects(1, second);
  await ada.page.locator(`[data-sidebar-row][data-doc-id="${second}"]`).click();
  await expect(ada.page.locator('[data-editor-pane]')).toHaveCount(1);
  await ui.waitLive(ada, second);
});

test('j01 editing: derived writes replicate without consuming a local undo step @p:col-3', async ({ actors, stack }) => {
  const { ada, ben, id } = await setup(actors, stack.baseUrl, 'Shared paragraph.');
  await paragraphEnd(ada, id); await ada.page.keyboard.type(' local');
  await expect(ui.body(ben, id)).toContainText('local');
  await ui.body(ada, id).evaluate(element => {
    const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
    editor.update(() => {
      for (const node of editor.getEditorState()._nodeMap.values()) {
        if (node.getType() === 'paragraph') { (node as unknown as { setFormat(f: string): void }).setFormat('center'); break; }
      }
    }, { discrete: true, tag: 'formula-workspace-refresh' });
  });
  await expect(ui.body(ben, id).locator('p')).toHaveCSS('text-align', 'center');
  await ada.page.keyboard.press('ControlOrMeta+z');
  for (const actor of [ada, ben]) { await expect(ui.body(actor, id)).not.toContainText('local'); await expect(ui.body(actor, id).locator('p')).toHaveCSS('text-align', 'center'); }
});

test('j01 editing: formula drafts and background conversions stay out of shared presentation fields @p:col-1 @p:col-3', async ({ actors, stack }) => {
  const { ada, ben, id, wire } = await setup(actors, stack.baseUrl, 'Shared paragraph.');
  await paragraphEnd(ada, id); await ada.page.keyboard.press('Enter'); await ada.page.keyboard.type('=2+3');
  await expect(ui.body(ben, id)).toContainText('=2+3');
  expect(ada.telemetry.pageErrors, 'draft typing').toEqual([]);
  await ada.page.keyboard.press('Enter');
  for (const actor of [ada, ben]) await expect(ui.body(actor, id).locator('[data-formula-id]')).toHaveCount(1);
  expect(ada.telemetry.pageErrors, 'formula commit').toEqual([]);
  await ada.page.keyboard.press('Enter'); await ada.page.keyboard.type('#aabbcc ');
  for (const actor of [ada, ben]) await expect(ui.body(actor, id).locator('[data-color-value="#aabbcc"]')).toHaveCount(1);
  await expect(ui.pane(ada, id)).toHaveAttribute('data-sync-unacked', '0');
  const frames = Buffer.concat(wire).toString('utf8');
  expect(ada.telemetry.pageErrors, 'color conversion').toEqual([]);
  for (const marker of ['--formula-draft-chip', '--formula-edit-id', '--formula-ref-note-id']) expect(frames).not.toContain(marker);
  await actors.reloadAll();
  for (const actor of [ada, ben]) { await ui.waitLive(actor, id); await expect(ui.body(actor, id).locator('[data-formula-id]')).toHaveCount(1); await expect(ui.body(actor, id).locator('[data-color-value="#aabbcc"]')).toHaveCount(1); }
});

