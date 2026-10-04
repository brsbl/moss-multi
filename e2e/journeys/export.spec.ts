// export (T3.7; R4; A§9 Export): moss's Electron-only note surfaces, web-adapted. "Open in New Window" opens a
// browser tab at the doc's URL; "Save as PDF" opens /pdf-export, which reaches data-pdf-export-status=ready and
// calls window.print (spied here); "Save as Markdown" downloads the server's export of the doc, byte for byte, with
// moss's content extensions kept and no comment or layout markers.
//
// The notes are imported through POST /api/docs as declared setup; import is not this journey's promise.
import { readFileSync } from 'node:fs';
import type { Actor, Actors } from '../lib/actors.ts';
import { NAMES, paneSelector, SIDEBAR_ROW_ATTR, SYNC_UNACKED_ATTR } from '../lib/contract.ts';
import type { Stack } from '../lib/stack.ts';
import { expect, test, ui } from '../lib/test.ts';

const BIND_TIMEOUT = 30_000;
const SOLO = 'one person exports their own note; nothing here is shared';

async function openImported(actors: Actors, stack: Stack, title: string, markdown: string): Promise<{ actor: Actor; docId: string }> {
  const actor = await actors.session(await actors.principal('ada'));
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
