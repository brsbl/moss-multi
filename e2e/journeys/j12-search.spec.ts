// j12-search (T3.4; A§5.3, A§15): search and links across everything a person can access, through moss's own UI.
// Ben finds a note Ada shared with him by a word in its body, from moss's sidebar search, and the result shows a
// text snippet around that word, never "[object Object]" (L§4.14). A note of Ada's he has no access to never
// appears, while his own note matching the same word does. Wiki links typed into a note resolve by title and by
// filename stem, and one that names no note shows moss's unresolved (broken) pill. The target note's Backlinks list
// the linking note, and still do after that note is edited and the page reloads; a reader of the target who cannot
// see the linking note gets no backlink.
//
// Doc grants are declared setup through the members API; sharing is not this journey's promise.
import { randomBytes } from 'node:crypto';
import type { Actor, Actors } from '../lib/actors.ts';
import { APP_STATE_ATTR, BODY_BINDING_ATTR, NAMES, SIDEBAR_ROW_ATTR, SYNC_UNACKED_ATTR } from '../lib/contract.ts';
import { grantDoc } from '../lib/grants.ts';
import { expect, test, ui } from '../lib/test.ts';

const BOOT_TIMEOUT = 30_000;
const BIND_TIMEOUT = 15_000;
/** The DocDO feeds search on its save, debounced 2 s (at most 10 s) after the last edit. */
const INDEX_TIMEOUT = 20_000;

const token = () => randomBytes(3).toString('hex');

async function openShell(actors: Actors, label: string, path = '/'): Promise<Actor> {
  const actor = await actors.open(await actors.principal(label), { path });
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  return actor;
}

/** "+ Note", a title, Enter, and a plain body; returns once the server acked it. */
async function writeNote(actor: Actor, title: string, body: string): Promise<string> {
  const docId = await ui.createNote(actor);
  await ui.typeTitle(actor, docId, title, { enter: true });
  await ui.typeBody(actor, docId, body);
  await acked(actor, docId);
  return docId;
}

const acked = (actor: Actor, docId: string) =>
  expect(ui.pane(actor, docId), `${actor.label}: the server holds the edit`).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });

/** Setup wait, not the promise under test: the caller's own search API answers `docId` for `word`. */
async function indexed(actor: Actor, word: string, docId: string): Promise<void> {
  const origin = new URL(actor.page.url()).origin;
  await expect.poll(async () => {
    const response = await actor.context.request.get(`${origin}/api/search?q=${encodeURIComponent(word)}`);
    const { results = [] } = (await response.json()) as { results?: { id: string }[] };
    return results.map((hit) => hit.id);
  }, { message: `${actor.label}: the index answers "${word}"`, timeout: INDEX_TIMEOUT }).toContain(docId);
}

/** moss's sidebar search: the magnifier, then the query. */
async function sidebarSearch(actor: Actor, query: string): Promise<void> {
  const field = actor.page.getByRole('textbox', { name: 'Search notes' });
  if (!(await field.isVisible())) await actor.page.getByRole('button', { name: 'Search notes', exact: true }).click();
  await field.fill(query);
}

const row = (actor: Actor, docId: string) => actor.page.locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}="${docId}"]`);

/** A wiki-link pill in the doc's body, by the text it shows. */
const pill = (actor: Actor, docId: string, text: string) =>
  ui.pane(actor, docId).locator('[data-file-link-node-key]', { hasText: text });

/** moss's broken pill (InlinePill `file-link-broken`): the unresolved state. */
const BROKEN = /cursor-not-allowed/;

/** The actions panel's LinksSection (moss puts Backlinks under it); opened if it is hidden. */
async function backlinks(actor: Actor) {
  const show = actor.page.getByRole('button', { name: 'Show actions panel', exact: true });
  if (await show.isVisible()) await show.click();
  return actor.page.locator('div.flex.flex-col').filter({ has: actor.page.getByText('Backlinks', { exact: true }) }).last();
}

test('j12-search: Ben finds a note shared with him by its body text, with a text snippet; a note he cannot access never appears @p:note-7 @evidence', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const ben = await openShell(actors, 'ben');
  await actors.requireDistinct(2);
  const shared = `quokka${token()}`;
  const secret = `tamarin${token()}`;

  const sharedId = await writeNote(ada, `Field notes ${token()}`, `Seen near the river: a ${shared} grazing at dusk.`);
  const privateId = await writeNote(ada, `Private diary ${token()}`, `Only Ada reads about the ${secret} here.`);
  await grantDoc(ada, sharedId, ben.principal!, 'viewer');
  const benOwnId = await writeNote(ben, `Ben's list ${token()}`, `My own note also names the ${secret} once.`);

  // The index has both of Ada's notes (a positive control for the negative below) before Ben looks.
  await indexed(ada, shared, sharedId);
  await indexed(ada, secret, privateId);
  await indexed(ben, secret, benOwnId);

  await sidebarSearch(ben, shared);
  const hit = row(ben, sharedId);
  await expect(hit, 'Ben finds the shared note by a word only its body holds').toBeVisible({ timeout: BIND_TIMEOUT });
  await expect(hit, 'the result shows a text snippet around the word').toContainText(`a ${shared} grazing`);
  await expect(hit).not.toContainText('[object Object]');
  await expect(ben.page.getByText('[object Object]'), 'no snippet anywhere reads [object Object]').toHaveCount(0);
  await actors.checkpoint('shared-found');

  await sidebarSearch(ben, secret);
  await expect(row(ben, benOwnId), "Ben's own note answers the same word").toBeVisible({ timeout: BIND_TIMEOUT });
  await expect(row(ben, privateId), "Ada's private note never appears for Ben").toHaveCount(0);
  const origin = new URL(ben.page.url()).origin;
  const raw = await (await ben.context.request.get(`${origin}/api/search?q=${secret}`)).json() as { results: { id: string }[] };
  expect(raw.results.map((r) => r.id), 'nor does the API name it').not.toContain(privateId);
  await actors.checkpoint('private-hidden');
});

test('j12-search: wiki links resolve by title and stem, an unresolved one shows its state, and backlinks survive an edit @p:note-7 @p:note-1@3 @p:R3@3 @evidence', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const ben = await actors.principal('ben');
  const run = token();
  const targetTitle = `Launch Plan ${run}`;
  const missing = `Nowhere ${run}`;
  const targetId = await writeNote(ada, targetTitle, 'The plan itself.');

  const sourceId = await ui.createNote(ada);
  const sourceTitle = `Kickoff ${run}`;
  await ui.typeTitle(ada, sourceId, sourceTitle, { enter: true });
  await ui.typeBody(ada, sourceId, 'Read ');
  await ada.page.keyboard.type(`[[${targetTitle}]] and [[launch-plan-${run}]] and [[${missing}]] `);
  await acked(ada, sourceId);

  await expect(pill(ada, sourceId, missing), 'a link to no note shows moss’s unresolved pill').toHaveClass(BROKEN, { timeout: BIND_TIMEOUT });
  await expect(pill(ada, sourceId, targetTitle), 'links by title and by filename stem both resolve').toHaveCount(2);
  for (const resolved of await pill(ada, sourceId, targetTitle).all()) await expect(resolved).not.toHaveClass(BROKEN);
  await actors.checkpoint('links');

  await ui.openNote(ada, targetId);
  const panel = await backlinks(ada);
  await expect(panel.getByRole('button', { name: sourceTitle }), 'the target lists the linking note').toBeVisible({ timeout: INDEX_TIMEOUT });

  // Edit the linking note, wait until the index holds the edit, then reload: the backlink came through the re-feed.
  ada.expectReconnects(1, sourceId);
  await ui.openNote(ada, sourceId);
  const edited = `edited${token()}`;
  await ui.typeBody(ada, sourceId, ` ${edited}`);
  await acked(ada, sourceId);
  await indexed(ada, edited, sourceId);
  ada.expectReconnects(1, targetId);
  await ada.goto(`/d/${targetId}`);
  await ui.waitLive(ada, targetId);
  await ada.declareRemount(targetId);
  await expect((await backlinks(ada)).getByRole('button', { name: sourceTitle }), 'the backlink survives the edit').toBeVisible({ timeout: BIND_TIMEOUT });
  await actors.checkpoint('backlinks-after-edit');

  // Ben reads the target but not the linking note: no backlink reaches him.
  await grantDoc(ada, targetId, ben, 'viewer');
  const benActor = await actors.open(ben, { path: `/d/${targetId}` });
  await expect(ui.body(benActor, targetId), 'Ben reads the target').toHaveAttribute(BODY_BINDING_ATTR, 'readonly', { timeout: BIND_TIMEOUT });
  await actors.requireDistinct(2);
  const origin = new URL(benActor.page.url()).origin;
  const answer = await (await benActor.context.request.get(`${origin}/api/docs/${targetId}/backlinks`)).json() as { backlinks: { id: string }[] };
  expect(answer.backlinks, 'Ben is told of no backlink he cannot open').toEqual([]);
  const own = await (await ada.context.request.get(`${origin}/api/docs/${targetId}/backlinks`)).json() as { backlinks: { id: string }[] };
  expect(own.backlinks.map((b) => b.id), 'while Ada, who can open it, is').toContain(sourceId);
  await backlinks(benActor);
  await expect(benActor.page.getByRole('button', { name: sourceTitle }), "Ben's panel shows no backlink").toHaveCount(0);
});

test('j12-search: an edit only inside a code block reaches the index without another note edit @p:note-7', async ({ actors, stack }) => {
  actors.solo('the promise is the server feeding search after one author edits a code block');
  const ada = await actors.session(await actors.principal('ada'));
  const first = `ibis${token()}`;
  const created = await ada.context.request.post('/api/docs', { headers: { origin: stack.baseUrl }, data: { title: `Snippets ${token()}`, markdown: `Intro ${first}.\n\n\`\`\`js\nseed\n\`\`\`` } });
  expect(created.status()).toBe(201);
  const { doc: { id } } = await created.json() as { doc: { id: string } };
  await ada.goto(`/d/${id}`);
  await ui.waitLive(ada, id);
  await indexed(ada, first, id);
  await ui.body(ada, id).locator('.moss-codeblock-pre').click();
  const field = ui.body(ada, id).getByPlaceholder('Enter code...');
  await expect(field).toHaveJSProperty('readOnly', false, { timeout: BIND_TIMEOUT });
  await field.press('ControlOrMeta+End');
  const word = `narwhal${token()}`;
  await ada.page.keyboard.type(` ${word}`);
  await expect(field).toHaveValue(`seed ${word}`);
  await acked(ada, id);
  await indexed(ada, word, id);
});
