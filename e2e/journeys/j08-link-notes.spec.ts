// j08-link-notes (T9.54): a share link to a note opens that note for a signed-in person who has notes of their own.
// Their listing does not carry the linked note, so none of their own notes may stand in for it: not in the pane at any
// moment, not in the address, not in the history; and the linked note gets no sidebar row at any moment. The legs:
// view, comment and edit links opened signed in; a stranger signing in from an edit link at both Tier A sizes; the
// wait while the listing is read, in which no note of his own is shown, and a note he then chooses stays; a first
// listing read that fails; a person with no notes; links the server refuses; and the link revoked while it is open.
import { randomBytes } from 'node:crypto';
import type { Route } from '@playwright/test';
import type { Actor, Actors, Viewport } from '../lib/actors.ts';
import {
  APP_STATE_ATTR, BODY_BINDING_ATTR, CONNECTION_BANNER_ATTR, DOC_STATE_ATTR, EDITOR_PANE_ATTR, NAMES, ROLE_ATTR,
  SIDEBAR_ROW_ATTR, TERMINAL_REASON_ATTR,
} from '../lib/contract.ts';
import { linkDoc } from '../lib/grants.ts';
import type { Principal } from '../lib/principals.ts';
import { unreachableControls } from '../lib/reach.js';
import { expect, test, ui } from '../lib/test.ts';

const BIND_TIMEOUT = 15_000;
const LIVE_TIMEOUT = 10_000;
const BOOT_TIMEOUT = 30_000;
const DENIAL = /doesn.t exist or you don.t have access/i;
const ACCESS_ASK = /\/api\/docs\/[^/]+\/access/;
const TEXT = 'Shared by link with someone who has notes of their own, café & “quotes”';

/** Soft checks, so a failed opening is recorded and the next one is still judged. */
const softly = expect.configure({ soft: true });

const TIER_A: (Viewport & { name: string })[] = [
  { name: '390x844', width: 390, height: 844, mobile: true },
  { name: '1440x1000', width: 1440, height: 1000 },
];

/**
 * Init script: every history write of the document, the history length it loaded with, every note that had a sidebar
 * row at any moment of the document, and every note that was in a pane at any moment of it.
 */
function recordAddress(names: { row: string; pane: string; doc: string }): void {
  const record = { loaded: window.history.length, writes: [] as string[], listed: [] as string[], paned: [] as string[] };
  (window as unknown as { __t954?: typeof record }).__t954 = record;
  for (const kind of ['pushState', 'replaceState'] as const) {
    const original = History.prototype[kind];
    History.prototype[kind] = function (this: History, data: unknown, unused: string, url?: string | URL | null): void {
      if (url != null) record.writes.push(`${kind} ${new URL(String(url), window.location.href).pathname}`);
      original.call(this, data, unused, url);
    };
  }
  new MutationObserver(() => {
    for (const [attr, seen] of [[names.row, record.listed], [names.pane, record.paned]] as const) {
      for (const element of document.querySelectorAll(`[${attr}][${names.doc}]`)) {
        const id = element.getAttribute(names.doc) ?? '';
        if (!seen.includes(id)) seen.push(id);
      }
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: [names.doc, names.row, names.pane] });
}

/** Records every later document of the actor's context (`recordAddress`). */
async function recordWindow(actor: Actor): Promise<void> {
  await actor.context.addInitScript(recordAddress, { row: SIDEBAR_ROW_ATTR, pane: NAMES.pane, doc: NAMES.docId });
}

const historyAdded = (actor: Actor): Promise<number> => actor.page.evaluate(() => {
  const record = (window as unknown as { __t954: { loaded: number } }).__t954;
  return window.history.length - record.loaded;
});

/** Every note that had a sidebar row at any moment of the current document. */
const everListed = (actor: Actor): Promise<string[]> =>
  actor.page.evaluate(() => (window as unknown as { __t954: { listed: string[] } }).__t954.listed);

/** Every note that was in a pane at any moment of the current document, in the order they came. */
const everPaned = (actor: Actor): Promise<string[]> =>
  actor.page.evaluate(() => (window as unknown as { __t954: { paned: string[] } }).__t954.paned);

/** Declared setup over the API: Ada's note with `TEXT`, in a window of hers that is on the shell. */
async function adaNote(actors: Actors, baseUrl: string): Promise<{ ada: Actor; docId: string }> {
  const ada = await actors.open(await actors.principal('ada'));
  const made = await ada.context.request.post('/api/docs', {
    headers: { origin: baseUrl },
    data: { title: `Linked ${randomBytes(2).toString('hex')}`, markdown: `${TEXT}\n` },
  });
  expect(made.status(), 'declared setup: Ada\'s note').toBe(201);
  return { ada, docId: ((await made.json()) as { doc: { id: string } }).doc.id };
}

/** Declared setup over the API: notes of Ben's own, made in this order (the last is his newest). */
async function ownNotes(actors: Actors, ben: Principal, baseUrl: string, titles: string[]): Promise<{ setup: Actor; own: string[] }> {
  const setup = await actors.session(ben, { label: 'ben-setup' });
  const headers = { origin: baseUrl };
  const { vault } = (await (await setup.context.request.get(`${baseUrl}/api/workspace`)).json()) as { vault: { id: string } };
  const own: string[] = [];
  for (const title of titles) {
    const made = await setup.context.request.post(`${baseUrl}/api/docs`, { headers, data: { folderId: vault.id, title, markdown: `${title}, a note of his own.\n` } });
    expect(made.status(), `declared setup: ${title}`).toBe(201);
    own.push(((await made.json()) as { doc: { id: string } }).doc.id);
  }
  return { setup, own };
}

const rowIds = (actor: Actor): Promise<string[]> =>
  actor.page.locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}]`).evaluateAll((rows, attr) => rows.map((row) => row.getAttribute(attr) ?? ''), NAMES.docId);

/** The premise: a note of his own has a sidebar row and the linked note has none (else a defect could pass). */
async function premise(actor: Actor, own: string[], docId: string, when: string): Promise<void> {
  await expect.poll(async () => (await rowIds(actor)).some((id) => own.includes(id)), { message: `${when}: the premise: a note of his own is listed`, timeout: BOOT_TIMEOUT }).toBe(true);
  expect(await rowIds(actor), `${when}: the premise: the linked note is not listed`).not.toContain(docId);
  expect(await everListed(actor), `${when}: the premise: the linked note never had a sidebar row`).not.toContain(docId);
}

/**
 * The linked note is the one pane, and no other note was in the pane at any moment of the document. Both soft, so a
 * failed opening is recorded and the next one is still judged; false when either failed.
 */
async function onlyTheLinkedNote(actor: Actor, docId: string, when: string): Promise<boolean> {
  const failed = test.info().errors.length;
  await softly.poll(() => ui.paneIds(actor), { message: `${when}: the linked note is the one pane`, timeout: BIND_TIMEOUT }).toEqual([docId]);
  softly(await everPaned(actor), `${when}: no other note was in the pane at any moment`).toEqual([docId]);
  return test.info().errors.length === failed;
}

const contentOf = async (actor: Actor, baseUrl: string, docId: string): Promise<string> =>
  (await actor.context.request.get(`${baseUrl}/api/docs/${docId}/content`, { headers: { accept: 'text/markdown' } })).text();

test('j08 link notes: a view, a comment and an edit link to a note each open that note for a signed-in person with notes of their own, at the link\'s role, and their typing reaches it (T9.54) @p:ppl-2@2', async ({ actors, stack }) => {
  const { ada, docId } = await adaNote(actors, stack.baseUrl);
  await ada.goto(`/d/${docId}`);
  await ui.waitOpen(ada, docId, 'live');
  const tokens = {
    viewer: await linkDoc(ada, docId, 'viewer'),
    commenter: await linkDoc(ada, docId, 'commenter'),
    editor: await linkDoc(ada, docId, 'editor'),
  };
  const benPrincipal = await actors.principal('ben');
  const { setup, own } = await ownNotes(actors, benPrincipal, stack.baseUrl, ['Ben older', 'Ben newer']);

  /** One opening: the premise, then the linked note as the only pane there ever was (soft, so every opening is judged). */
  const opens = async (actor: Actor, role: 'viewer' | 'commenter' | 'editor', when: string): Promise<boolean> => {
    await premise(actor, own, docId, when);
    if (!(await onlyTheLinkedNote(actor, docId, when))) return false;
    await ui.waitOpen(actor, docId, role === 'editor' ? 'live' : 'readonly');
    await expect(ui.pane(actor, docId), `${when}: at the link's role`).toHaveAttribute(ROLE_ATTR, role);
    await expect(actor.page, `${when}: the address names the linked note and keeps the token`)
      .toHaveURL((at) => at.pathname === `/d/${docId}` && at.searchParams.get('share') === tokens[role]);
    await expect.poll(() => ui.fieldText(actor, docId, 'body'), { message: `${when}: it is Ada's text`, timeout: BIND_TIMEOUT }).toContain(TEXT);
    expect(await historyAdded(actor), `${when}: no history entry added`).toBe(0);
    expect(await ui.paneIds(actor), `${when}: still the linked note`).toEqual([docId]);
    expect(await everListed(actor), `${when}: the linked note never had a sidebar row`).not.toContain(docId);
    expect(await everPaned(actor), `${when}: still no other note was ever in the pane`).toEqual([docId]);
    return true;
  };

  // The view link, in a window of his with every history write recorded before the app loads.
  const ben = await actors.session(benPrincipal, { label: 'ben' });
  await recordWindow(ben);
  await ben.goto(`/d/${docId}?share=${tokens.viewer}`);
  await opens(ben, 'viewer', 'the view link');

  // A reload keeps it: the linked note binds once more. On a build with the defect his newest note binds again instead.
  ben.expectReconnects(1, docId);
  ben.expectReconnects(1, own[1]);
  await ben.page.reload();
  await opens(ben, 'viewer', 'the view link, reloaded');

  const commenting = await actors.session(benPrincipal, { label: 'ben-comment' });
  await recordWindow(commenting);
  await commenting.goto(`/d/${docId}?share=${tokens.commenter}`);
  await opens(commenting, 'commenter', 'the comment link');

  // The edit link: what he types reaches Ada's note and none of his own, and her typing reaches his pane.
  const editing = await actors.session(benPrincipal, { label: 'ben-edit' });
  await recordWindow(editing);
  await editing.goto(`/d/${docId}?share=${tokens.editor}`);
  if (await opens(editing, 'editor', 'the edit link')) {
    const benText = ' and Ben, who has notes of his own, edits through the link';
    await ui.typeBody(editing, docId, benText);
    await expect.poll(() => ui.fieldText(ada, docId, 'body'), { message: 'Ada sees what he typed', timeout: LIVE_TIMEOUT }).toContain(benText);
    for (const id of own) {
      await expect.poll(() => contentOf(setup, stack.baseUrl, id), { message: 'his own note is readable' }).toContain('a note of his own');
      expect(await contentOf(setup, stack.baseUrl, id), 'none of his own notes took the text').not.toContain('edits through the link');
    }
    const adaText = ' and Ada answers';
    await ui.typeBody(ada, docId, adaText);
    await expect.poll(() => ui.fieldText(editing, docId, 'body'), { message: 'his pane shows what Ada typed', timeout: LIVE_TIMEOUT }).toContain(adaText);
    expect(await ui.paneIds(editing), 'after her edit, his pane is still the linked note').toEqual([docId]);
    expect(await everListed(editing), 'after her edit, the linked note still never had a sidebar row').not.toContain(docId);
    expect(await everPaned(editing), 'after her edit, still no other note was ever in the pane').toEqual([docId]);
  }
  await actors.requireDistinct(2);
});

for (const size of TIER_A) {
  test(`j08 link notes ${size.name}: a stranger opens an edit link, signs in to an account that has a note, and lands on the linked note at the link's role (T9.54) @tierA @p:ppl-2@2`, async ({ actors, stack }) => {
    const { ada, docId } = await adaNote(actors, stack.baseUrl);
    const link = `/d/${docId}?share=${await linkDoc(ada, docId, 'editor')}`;
    const benPrincipal = await actors.principal('ben');
    const { own } = await ownNotes(actors, benPrincipal, stack.baseUrl, ['Ben\'s own']);

    const stranger = await actors.anonymous(link, { label: 'stranger', viewport: size });
    await ui.waitOpen(stranger, docId, 'readonly');
    await expect(ui.pane(stranger, docId), 'signed out, an edit link reads at viewer').toHaveAttribute(ROLE_ATTR, 'viewer');
    await recordWindow(stranger); // for the landing after sign-in
    const signIn = stranger.page.getByRole('button', { name: 'Sign in to do more', exact: true });
    await signIn.click();
    await stranger.page.waitForURL((at) => at.pathname === '/login' && at.searchParams.get('next') === link);
    await ui.waitForLoginCard(stranger);
    await ui.signInThroughCard(stranger, benPrincipal);
    await stranger.page.waitForURL((at) => `${at.pathname}${at.search}` === link, { timeout: BOOT_TIMEOUT });
    await stranger.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });

    await premise(stranger, own, docId, 'signed in');
    expect(await onlyTheLinkedNote(stranger, docId, 'signed in'), 'signed in: the linked note opened, and only it').toBe(true);
    await ui.waitOpen(stranger, docId, 'live');
    await expect(ui.pane(stranger, docId), 'signed in, the link\'s role').toHaveAttribute(ROLE_ATTR, 'editor');
    await expect(ui.body(stranger, docId), 'and the body is live').toHaveAttribute(BODY_BINDING_ATTR, 'live');
    await expect.poll(() => ui.fieldText(stranger, docId, 'body'), { message: 'it is Ada\'s text', timeout: BIND_TIMEOUT }).toContain(TEXT);
    await expect(stranger.page, 'the address is the link').toHaveURL((at) => `${at.pathname}${at.search}` === link);
    expect(await historyAdded(stranger), 'no history entry added by the landing').toBe(0);
    await expect.poll(() => stranger.page.evaluate(unreachableControls, { scope: null }), { message: 'every control is reachable and tappable', timeout: 5_000 }).toEqual([]);
    expect(await ui.paneIds(stranger), 'still the linked note').toEqual([docId]);
    expect(await everListed(stranger), 'the linked note never had a sidebar row').not.toContain(docId);
    expect(await everPaned(stranger), 'still no other note was ever in the pane').toEqual([docId]);
    await actors.requireDistinct(2);
  });
}

test('j08 link notes: while the listing is being read no note of his own is shown, and a note he then chooses stays (T9.54) @p:ppl-2@2', async ({ actors, stack }) => {
  const { ada, docId } = await adaNote(actors, stack.baseUrl);
  const link = `/d/${docId}?share=${await linkDoc(ada, docId, 'editor')}`;
  const benPrincipal = await actors.principal('ben');
  const { own } = await ownNotes(actors, benPrincipal, stack.baseUrl, ['Ben older', 'Ben newer']);
  const [older] = own;

  // A window of his on the edit link whose listing reads are held until `release`: the gate has answered, and the
  // person's own notes are not known to the page yet.
  const actor = await actors.session(benPrincipal, { label: 'ben-held' });
  let asked = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  await actor.page.route((url) => url.pathname === '/api/workspace', async (route: Route) => {
    asked += 1;
    await released;
    await route.continue();
  });
  await recordWindow(actor);
  await actor.goto(link);
  await expect.poll(() => asked, { message: 'the listing is asked for after the gate', timeout: BOOT_TIMEOUT }).toBeGreaterThanOrEqual(1);
  await actor.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  softly(await everPaned(actor), 'while the listing is read, no note of his own is in the pane').toEqual(expect.not.arrayContaining(own));
  softly(await everListed(actor), 'while the listing is read, the linked note has no sidebar row').not.toContain(docId);
  release();

  await premise(actor, own, docId, 'the listing answered');
  if (await onlyTheLinkedNote(actor, docId, 'the listing answered')) {
    await ui.waitOpen(actor, docId, 'live');
    await expect(ui.pane(actor, docId), 'at the link\'s role').toHaveAttribute(ROLE_ATTR, 'editor');
    expect(await historyAdded(actor), 'no history entry added').toBe(0);
  }

  // A chosen note stays: he clicks his older note; it is the one pane, the address names it, and the next frames keep it.
  await actor.page.locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}="${older}"]`).click();
  await ui.waitLive(actor, older);
  await actor.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await ui.paneIds(actor), 'choosing: his older note is the one pane').toEqual([older]);
  await expect(actor.page, 'choosing: the address names it').toHaveURL((at) => at.pathname === `/d/${older}`);
  expect(await everListed(actor), 'choosing: the linked note never had a sidebar row').not.toContain(docId);
  await actors.requireDistinct(2);
});

test('j08 link notes: when the first listing read fails, the linked note still opens and no note of his own stands in for it (T9.54) @p:ppl-2@2', async ({ actors, stack }) => {
  const { ada, docId } = await adaNote(actors, stack.baseUrl);
  const token = await linkDoc(ada, docId, 'editor');
  const benPrincipal = await actors.principal('ben');
  const { own } = await ownNotes(actors, benPrincipal, stack.baseUrl, ['Ben older', 'Ben newer']);

  // The page's first listing read is refused and the rest go through. A 5xx or an aborted request would itself fail
  // invariant 1, so the refusal is a declared 429.
  const actor = await actors.session(benPrincipal, { label: 'ben-refused' });
  let asked = 0;
  await actor.page.route((url) => url.pathname === '/api/workspace', async (route: Route) => {
    asked += 1;
    if (asked === 1) await route.fulfill({ status: 429, contentType: 'text/plain', body: 'Too many requests' });
    else await route.continue();
  });
  actor.expectHttp(429, '/api/workspace');
  await recordWindow(actor);
  await actor.goto(`/d/${docId}?share=${token}`);

  await premise(actor, own, docId, 'after a failed listing');
  expect(asked, 'a second listing read was made').toBeGreaterThanOrEqual(2);
  if (await onlyTheLinkedNote(actor, docId, 'after a failed listing')) {
    await ui.waitOpen(actor, docId, 'live');
    await expect(ui.pane(actor, docId), 'at the link\'s role').toHaveAttribute(ROLE_ATTR, 'editor');
    await expect(actor.page, 'the address is the link')
      .toHaveURL((at) => at.pathname === `/d/${docId}` && at.searchParams.get('share') === token);
    expect(await historyAdded(actor), 'no history entry added').toBe(0);
    expect(await everListed(actor), 'the linked note never had a sidebar row').not.toContain(docId);
    expect(await everPaned(actor), 'still no other note was ever in the pane').toEqual([docId]);
  }
  await actors.requireDistinct(2);
});

test('j08 link notes: a signed-in person with no notes opens a view and an edit link, and no note has a sidebar row at any moment (T9.54) @p:ppl-2@2', async ({ actors, stack }) => {
  const { ada, docId } = await adaNote(actors, stack.baseUrl);
  const tokens = { viewer: await linkDoc(ada, docId, 'viewer'), editor: await linkDoc(ada, docId, 'editor') };
  const cyPrincipal = await actors.principal('cy');
  const setup = await actors.session(cyPrincipal, { label: 'cy-setup' });
  const listing = (await (await setup.context.request.get(`${stack.baseUrl}/api/workspace`)).json()) as { docs: { id: string }[] };
  expect(listing.docs.map((doc) => doc.id), 'the premise: Cy has no notes').toEqual([]);

  for (const role of ['viewer', 'editor'] as const) {
    const when = role === 'viewer' ? 'the view link' : 'the edit link';
    const cy = await actors.session(cyPrincipal, { label: `cy-${role}` });
    await recordWindow(cy);
    await cy.goto(`/d/${docId}?share=${tokens[role]}`);
    if (await onlyTheLinkedNote(cy, docId, when)) {
      await ui.waitOpen(cy, docId, role === 'editor' ? 'live' : 'readonly');
      await expect(ui.pane(cy, docId), `${when}: at the link's role`).toHaveAttribute(ROLE_ATTR, role);
      await expect.poll(() => ui.fieldText(cy, docId, 'body'), { message: `${when}: it is Ada's text`, timeout: BIND_TIMEOUT }).toContain(TEXT);
      expect(await everPaned(cy), `${when}: still no other note was ever in the pane`).toEqual([docId]);
    }
    softly(await everListed(cy), `${when}: no note had a sidebar row at any moment`).toEqual([]);
  }
  await actors.requireDistinct(2);
});

test('j08 link notes: a signed-in person with notes who presents a link to another note, or a revoked link, gets the denial page, with no pane and no row at any moment (T9.54) @p:ppl-2@2', async ({ actors, stack }) => {
  const { ada, docId: first } = await adaNote(actors, stack.baseUrl);
  const headers = { origin: stack.baseUrl };
  const made = await ada.context.request.post(`${stack.baseUrl}/api/docs`, { headers, data: { title: 'Ada\'s second', markdown: 'Her second note.\n' } });
  expect(made.status(), 'declared setup: Ada\'s second note').toBe(201);
  const second = ((await made.json()) as { doc: { id: string } }).doc.id;
  const elsewhere = await linkDoc(ada, second, 'editor');
  const revoked = await linkDoc(ada, first, 'editor');
  const revoking = await ada.context.request.delete(`${stack.baseUrl}/api/docs/${first}/links/${revoked}`, { headers });
  expect(revoking.status(), 'declared setup: the link is revoked').toBe(200);
  const benPrincipal = await actors.principal('ben');
  await ownNotes(actors, benPrincipal, stack.baseUrl, ['Ben older', 'Ben newer']);

  const ben = await actors.session(benPrincipal, { label: 'ben' });
  ben.expectHttp(404, `/api/docs/${first}`);
  await recordWindow(ben);
  for (const [when, token] of [['a live link to another note', elsewhere], ['a revoked link', revoked]] as const) {
    await ben.goto(`/d/${first}?share=${token}`);
    await ben.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
    await expect(ben.page.getByRole('heading', { name: DENIAL }), `${when}: the denial page`).toBeVisible();
    await expect(ben.page.getByRole('button', { name: 'Go to your notes', exact: true }), `${when}: signed in, it offers his notes`).toBeVisible();
    await expect(ben.page.locator(`[${EDITOR_PANE_ATTR}]`), `${when}: and opens no note`).toHaveCount(0);
    expect(await everPaned(ben), `${when}: no note was in a pane at any moment`).toEqual([]);
    expect(await everListed(ben), `${when}: no note had a sidebar row at any moment`).toEqual([]);
  }
  // The positive control: the other note's link opens the other note.
  expect((await ben.context.request.get(`${stack.baseUrl}/api/docs/${second}?share=${elsewhere}`)).status()).toBe(200);
  await actors.requireDistinct(2);
});

test('j08 link notes: the link is revoked while the linked note is open; the pane ends in place, his own notes stay and open, and the link then gets the denial page (T9.54) @p:ppl-2@2', async ({ actors, stack }) => {
  const { ada, docId } = await adaNote(actors, stack.baseUrl);
  const token = await linkDoc(ada, docId, 'editor');
  const link = `/d/${docId}?share=${token}`;
  const benPrincipal = await actors.principal('ben');
  const { own } = await ownNotes(actors, benPrincipal, stack.baseUrl, ['Ben older', 'Ben newer']);
  const [older] = own;

  const ben = await actors.session(benPrincipal, { label: 'ben' });
  await recordWindow(ben);
  await ben.goto(link);
  await premise(ben, own, docId, 'the edit link');
  expect(await onlyTheLinkedNote(ben, docId, 'the edit link'), 'the edit link: the linked note opened, and only it').toBe(true);
  await ui.waitOpen(ben, docId, 'live');
  await expect(ui.pane(ben, docId), 'at the link\'s role').toHaveAttribute(ROLE_ATTR, 'editor');
  ben.expectHttp(404, ACCESS_ASK);

  const revoking = await ada.context.request.delete(`${stack.baseUrl}/api/docs/${docId}/links/${token}`, { headers: { origin: stack.baseUrl } });
  expect(revoking.status(), 'Ada revokes the link').toBe(200);
  await expect(ui.pane(ben, docId), 'the note ends for him in place').toHaveAttribute(TERMINAL_REASON_ATTR, 'revoked', { timeout: LIVE_TIMEOUT });
  await expect(ui.pane(ben, docId)).toHaveAttribute(DOC_STATE_ATTR, 'terminal');
  await expect(ui.pane(ben, docId).locator(`[${CONNECTION_BANNER_ATTR}="revoked"]`), 'and says why').toHaveText(/Your access to this note has ended\./);
  await expect(ui.body(ben, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'terminal');
  for (const id of own) {
    await expect(ben.page.locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}="${id}"]`), 'his own notes are still listed').toHaveCount(1);
  }
  expect(await everListed(ben), 'after the revocation, the linked note never had a sidebar row').not.toContain(docId);
  expect(await everPaned(ben), 'after the revocation, no other note was ever in the pane').toEqual([docId]);

  await ben.page.locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}="${older}"]`).click();
  await ui.waitLive(ben, older);
  await expect(ui.pane(ben, older), 'his older note opens as his own').toHaveAttribute(ROLE_ATTR, 'owner');
  expect(await ui.paneIds(ben), 'his older note is the one pane').toEqual([older]);
  expect(await everListed(ben), 'the linked note never had a sidebar row').not.toContain(docId);

  ben.expectHttp(404, `/api/docs/${docId}`);
  await ben.goto(link);
  await ben.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  await expect(ben.page.getByRole('heading', { name: DENIAL }), 'the link again: the denial page').toBeVisible();
  await expect(ben.page.locator(`[${EDITOR_PANE_ATTR}]`), 'and no note').toHaveCount(0);
  expect(await everPaned(ben), 'the link again: no note was in a pane').toEqual([]);
  expect(await everListed(ben), 'the link again: no note had a sidebar row').toEqual([]);
  await actors.requireDistinct(2);
});
