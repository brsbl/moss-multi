// export (T3.7; R4; A§9 Export): moss's Electron-only note surfaces, web-adapted. "Open in New Window" opens a
// browser tab at the doc's URL; "Save as PDF" opens /pdf-export, which reaches data-pdf-export-status=ready and
// calls window.print (spied here); "Save as Markdown" downloads the server's export of the doc, byte for byte, with
// moss's content extensions kept and no comment or layout markers.
//
// The notes are imported through POST /api/docs as declared setup; import is not this journey's promise.
import { readFileSync } from 'node:fs';
import type { Actor, Actors } from '../lib/actors.ts';
import { BODY_BINDING_ATTR, NAMES, paneSelector, SIDEBAR_ROW_ATTR, SYNC_UNACKED_ATTR } from '../lib/contract.ts';
import { linkDoc } from '../lib/grants.ts';
import type { Stack } from '../lib/stack.ts';
import { expect, test, ui } from '../lib/test.ts';

const BIND_TIMEOUT = 30_000;
const SOLO = 'one person exports their own note; nothing here is shared';

async function openImported(actors: Actors, stack: Stack, title: string, markdown: string, severable = false): Promise<{ actor: Actor; docId: string }> {
  const actor = await actors.session(await actors.principal('ada'), { severable });
  const response = await actor.context.request.post('/api/docs', { headers: { origin: stack.baseUrl }, data: { title, markdown } });
  expect(response.status(), 'declared setup: the note is imported').toBe(201);
  const { doc } = (await response.json()) as { doc: { id: string } };
  await actor.goto(`/d/${doc.id}`);
  await ui.waitLive(actor, doc.id);
  await actor.observeEditor(doc.id);
  return { actor, docId: doc.id };
}

async function moreAction(actor: Actor, docId: string, item: string): Promise<void> {
  await ui.pane(actor, docId).getByRole('button', { name: 'More actions', exact: true }).click();
  await actor.page.getByRole('menuitem', { name: item, exact: true }).click();
}

test('export: Open in New Window opens the note in a browser tab at /d/<id> @p:R4 @p:note-2', async ({ actors, stack }) => {
  actors.solo(SOLO);
  const { actor, docId } = await openImported(actors, stack, 'Opened in a tab', 'A note that opens in its own tab.');
  const opened = actor.context.waitForEvent('page');
  await actor.page.locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}="${docId}"]`).click({ button: 'right' });
  await actor.page.getByRole('menuitem', { name: 'Open in New Window', exact: true }).click();
  const tab = await opened;
  await tab.waitForURL((url) => url.pathname === `/d/${docId}`);
  await expect(tab.locator(paneSelector(docId)), 'the new tab opens the note').toBeVisible({ timeout: BIND_TIMEOUT });
  await expect(tab.getByText('A note that opens in its own tab.'), 'with its body').toBeVisible({ timeout: BIND_TIMEOUT });
  await tab.close();
});

test('export: Save as PDF prints the note through /pdf-export @p:R4 @p:note-2 @evidence', async ({ actors, stack }) => {
  actors.solo(SOLO);
  const { actor, docId } = await openImported(actors, stack, 'Printed note', 'Printed through the browser.\n\n- one\n- two');
  // Every page of this context counts its print calls instead of opening the print dialog.
  await actor.context.addInitScript(() => {
    const page = window as unknown as { __printCalls: number };
    page.__printCalls = 0;
    window.print = () => { page.__printCalls += 1; };
  });
  const opened = actor.context.waitForEvent('page');
  await moreAction(actor, docId, 'Save as PDF');
  const print = await opened;
  await print.waitForURL((url) => url.pathname === '/pdf-export' && !!url.searchParams.get('pdfExportSessionId'));
  await expect(print.locator('body'), 'the print route renders the note').toHaveAttribute('data-pdf-export-status', 'ready', { timeout: BIND_TIMEOUT });
  await expect(print.locator('.pdf-export-content h1'), 'under its title').toHaveText('Printed note');
  await expect(print.locator('.pdf-export-content'), 'with its body').toContainText('Printed through the browser.');
  await expect.poll(() => print.evaluate(() => (window as unknown as { __printCalls: number }).__printCalls), { message: 'window.print is called once' }).toBe(1);
  await expect(print.locator('body')).not.toHaveAttribute('data-pdf-export-error', /.+/);
  await print.close();
});

test("export: a link-only reader's Save as PDF shows the note's uploaded image @p:R4 @p:note-2 @p:note-8", async ({ actors, stack }) => {
  // B171: the print tab reads the note's media through the reader's link, as the note's own tab does.
  const ada = await actors.session(await actors.principal('ada'));
  const made = await ada.context.request.post('/api/docs', { headers: { origin: stack.baseUrl }, data: { title: 'Printed media', markdown: 'Above the image.\n\n![pattern](assets/pattern.png)' } });
  expect(made.status(), 'declared setup: the note is imported').toBe(201);
  const { doc } = (await made.json()) as { doc: { id: string } };
  const uploaded = await ada.context.request.post(`/api/docs/${doc.id}/assets?filename=pattern.png`, {
    headers: { origin: stack.baseUrl, 'content-type': 'image/png' }, data: readFileSync(new URL('../fixtures/media/pattern.png', import.meta.url)),
  });
  expect(uploaded.status(), 'declared setup: its image is uploaded').toBe(201);
  await ada.goto(`/d/${doc.id}`);
  await ui.waitLive(ada, doc.id);
  const token = await linkDoc(ada, doc.id, 'viewer');

  const cy = await actors.session(await actors.principal('cy'));
  await cy.goto(`/d/${doc.id}?share=${encodeURIComponent(token)}`);
  await actors.requireDistinct(2);
  await expect(ui.body(cy, doc.id)).toHaveAttribute(BODY_BINDING_ATTR, 'readonly', { timeout: BIND_TIMEOUT });
  await expect(ui.body(cy, doc.id).locator('img[src*="/assets/pattern.png"]'), 'the reader sees the image through the link').toHaveCount(1);
  await cy.context.addInitScript(() => {
    window.print = () => undefined;
  });
  const opened = cy.context.waitForEvent('page');
  await moreAction(cy, doc.id, 'Save as PDF');
  const print = await opened;
  await print.waitForURL((url) => url.pathname === '/pdf-export' && !!url.searchParams.get('pdfExportSessionId'));
  expect(new URL(print.url()).searchParams.get('share'), 'the print tab carries the link').toBe(token);
  await expect(print.locator('body'), 'the print route renders the note').toHaveAttribute('data-pdf-export-status', 'ready', { timeout: BIND_TIMEOUT });
  const image = print.locator('.pdf-export-content img');
  await expect(image).toHaveCount(1);
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), {
    message: 'the image loads in the print preview', timeout: BIND_TIMEOUT,
  }).toBe(true);
  await print.close();
});

const EXPORTED = [
  'Totals {{2+2|4}} and a link to [[Launch Plan]].',
  '',
  'A %%m:c1:start%%commented phrase%%m:c1:end%% and a {%c:c2%}legacy marker{%/c%}.',
  '',
  '<!-- moss-table-column-widths: 120,240 -->',
  '| Wide | Narrow |',
  '| --- | --- |',
  '| 1 | 2 |',
].join('\n');
/** Comment markers, the comments footer and per-viewer table widths never leave the doc in an export (P:Notes). */
const MARKERS = /%%m:|\{%c:|\{%\/c%\}|<!--\s*moss:comments|moss-table-column-widths/;

test('export: Save as Markdown downloads the export, clean, with content extensions kept @p:note-3 @p:R4', async ({ actors, stack }) => {
  actors.solo(SOLO);
  const { actor, docId } = await openImported(actors, stack, 'Quarterly / plan', EXPORTED);
  const typed = ' Typed before saving.';
  await ui.typeBody(actor, docId, typed);
  await expect(ui.pane(actor, docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });

  const download = actor.page.waitForEvent('download');
  await moreAction(actor, docId, 'Save as Markdown');
  const file = await download;
  expect(file.suggestedFilename(), 'named by the title, without a path separator').toBe('Quarterly - plan.md');
  const path = await file.path();
  const bytes = readFileSync(path);

  const exported = await actor.context.request.get(`/api/docs/${docId}/content`);
  expect(exported.status()).toBe(200);
  expect(exported.headers()['content-type']).toMatch(/^text\/markdown/);
  expect(bytes.equals(await exported.body()), 'the download is the export, byte for byte').toBe(true);

  const text = bytes.toString('utf8');
  expect(text, 'no comment or layout markers').not.toMatch(MARKERS);
  expect(text, 'the commented text stays').toContain('commented phrase');
  expect(text, 'formulas stay content').toContain('{{2+2|4}}');
  expect(text, 'wiki links stay content').toContain('[[Launch Plan]]');
  expect(text, 'the title is the file name, never a body line').not.toMatch(/^# Quarterly/m);
  expect(text, 'the export holds what was typed').toContain(typed.trim());
});

test('export: Save as Markdown waits for unsynced edits and refuses rather than download a stale file @p:note-3 @p:R4', async ({ actors, stack }) => {
  actors.solo(SOLO);
  const { actor, docId } = await openImported(actors, stack, 'Held edits', 'Synced before the hold.', true);
  const sever = actor.sever;
  if (!sever) throw new Error('the window is not severable');
  const downloads: string[] = [];
  actor.page.on('download', (file) => downloads.push(file.suggestedFilename()));

  // Doc frames are held while HTTP still works: the server has not seen the typed text.
  // The hold may trip the 12 s heartbeat before the reset below, so up to two reconnects.
  actor.expectReconnects(2, docId);
  sever.blackhole();
  const typed = ' Typed while the socket is held.';
  await ui.typeBody(actor, docId, typed);
  await expect(ui.pane(actor, docId), 'the edit is unacked').toHaveAttribute(SYNC_UNACKED_ATTR, '1');
  await moreAction(actor, docId, 'Save as Markdown');
  await expect(actor.page.getByText(/haven’t synced yet/), 'the save is refused loudly').toBeVisible({ timeout: BIND_TIMEOUT });
  await expect(actor.page.getByText('Saved Markdown', { exact: true }), 'and never reported as saved').toHaveCount(0);
  expect(downloads, 'no stale file is downloaded').toEqual([]);

  // A save started while held completes once the socket reconnects and the DocDO acks the edit.
  const download = actor.page.waitForEvent('download', { timeout: BIND_TIMEOUT });
  await moreAction(actor, docId, 'Save as Markdown');
  sever.reset(1012);
  sever.restore();
  const file = await download;
  const text = readFileSync(await file.path()).toString('utf8');
  expect(text, 'the export holds what was typed during the hold').toContain(typed.trim());
  await expect(ui.pane(actor, docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });
});
