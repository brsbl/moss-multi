// j08-link-notes (T9.54): a share link to a note opens that note for a signed-in person who has notes of their own.
// Their listing does not carry the linked note, and until startup selection ends moss shows their newest listed note,
// so that note must not stand in for the linked one: not in the pane, not in the address, not in the history. Three
// legs: view, comment and edit links opened signed in; a stranger signing in from an edit link at both Tier A sizes;
// and the wait while moss reads the linked note, in which typed text is kept and a note chosen stays.
import { randomBytes } from 'node:crypto';
import type { Route } from '@playwright/test';
import type { Actor, Actors, Viewport } from '../lib/actors.ts';
import { APP_STATE_ATTR, BODY_BINDING_ATTR, NAMES, ROLE_ATTR, SIDEBAR_ROW_ATTR } from '../lib/contract.ts';
import { linkDoc } from '../lib/grants.ts';
import type { Principal } from '../lib/principals.ts';
import { unreachableControls } from '../lib/reach.js';
import { expect, test, ui } from '../lib/test.ts';

const BIND_TIMEOUT = 15_000;
const LIVE_TIMEOUT = 10_000;
const BOOT_TIMEOUT = 30_000;
const TEXT = 'Shared by link with someone who has notes of their own, café & “quotes”';

/** Soft checks, so a failed opening is recorded and the next one is still judged. */
const softly = expect.configure({ soft: true });

const TIER_A: (Viewport & { name: string })[] = [
  { name: '390x844', width: 390, height: 844, mobile: true },
  { name: '1440x1000', width: 1440, height: 1000 },
];

/** Init script: every history write of the document, and the history length it loaded with. */
function recordAddress(): void {
  const record = { loaded: window.history.length, writes: [] as string[] };
  (window as unknown as { __t954?: typeof record }).__t954 = record;
  for (const kind of ['pushState', 'replaceState'] as const) {
    const original = History.prototype[kind];
    History.prototype[kind] = function (this: History, data: unknown, unused: string, url?: string | URL | null): void {
      if (url != null) record.writes.push(`${kind} ${new URL(String(url), window.location.href).pathname}`);
      original.call(this, data, unused, url);
    };
  }
}

const historyAdded = (actor: Actor): Promise<number> => actor.page.evaluate(() => {
  const record = (window as unknown as { __t954: { loaded: number } }).__t954;
  return window.history.length - record.loaded;
});

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

  /** One opening: the premise, then the linked note as the one pane (soft, so every opening is judged). */
  const opens = async (actor: Actor, role: 'viewer' | 'commenter' | 'editor', when: string): Promise<boolean> => {
    await premise(actor, own, docId, when);
    const failed = test.info().errors.length;
    await softly.poll(() => ui.paneIds(actor), { message: `${when}: the linked note is the one pane`, timeout: BIND_TIMEOUT }).toEqual([docId]);
    if (test.info().errors.length > failed) return false;
    await ui.waitOpen(actor, docId, role === 'editor' ? 'live' : 'readonly');
    await expect(ui.pane(actor, docId), `${when}: at the link's role`).toHaveAttribute(ROLE_ATTR, role);
    await expect(actor.page, `${when}: the address names the linked note and keeps the token`)
      .toHaveURL((at) => at.pathname === `/d/${docId}` && at.searchParams.get('share') === tokens[role]);
    await expect.poll(() => ui.fieldText(actor, docId, 'body'), { message: `${when}: it is Ada's text`, timeout: BIND_TIMEOUT }).toContain(TEXT);
    expect(await historyAdded(actor), `${when}: no history entry added`).toBe(0);
    expect(await ui.paneIds(actor), `${when}: still the linked note`).toEqual([docId]);
    return true;
  };

  // The view link, in a window of his with every history write recorded before the app loads.
  const ben = await actors.session(benPrincipal, { label: 'ben' });
  await ben.context.addInitScript(recordAddress);
  await ben.goto(`/d/${docId}?share=${tokens.viewer}`);
  await opens(ben, 'viewer', 'the view link');

  // A reload keeps it: the linked note binds once more; his newest note may also have opened while moss read it.
  ben.expectReconnects(1, docId);
  ben.expectReconnects(1, own[1]);
  await ben.page.reload();
  await opens(ben, 'viewer', 'the view link, reloaded');

  const commenting = await actors.session(benPrincipal, { label: 'ben-comment' });
  await commenting.context.addInitScript(recordAddress);
  await commenting.goto(`/d/${docId}?share=${tokens.commenter}`);
  await opens(commenting, 'commenter', 'the comment link');

  // The edit link: what he types reaches Ada's note and none of his own, and her typing reaches his pane.
  const editing = await actors.session(benPrincipal, { label: 'ben-edit' });
  await editing.context.addInitScript(recordAddress);
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
    await stranger.context.addInitScript(recordAddress); // for the landing after sign-in
    const signIn = stranger.page.getByRole('button', { name: 'Sign in to do more', exact: true });
    await signIn.click();
    await stranger.page.waitForURL((at) => at.pathname === '/login' && at.searchParams.get('next') === link);
    await ui.waitForLoginCard(stranger);
    await ui.signInThroughCard(stranger, benPrincipal);
    await stranger.page.waitForURL((at) => `${at.pathname}${at.search}` === link, { timeout: BOOT_TIMEOUT });
    await stranger.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });

    await premise(stranger, own, docId, 'signed in');
    await expect.poll(() => ui.paneIds(stranger), { message: 'signed in: the linked note is the one pane', timeout: BIND_TIMEOUT }).toEqual([docId]);
    await ui.waitOpen(stranger, docId, 'live');
    await expect(ui.pane(stranger, docId), 'signed in, the link\'s role').toHaveAttribute(ROLE_ATTR, 'editor');
    await expect(ui.body(stranger, docId), 'and the body is live').toHaveAttribute(BODY_BINDING_ATTR, 'live');
    await expect.poll(() => ui.fieldText(stranger, docId, 'body'), { message: 'it is Ada\'s text', timeout: BIND_TIMEOUT }).toContain(TEXT);
    await expect(stranger.page, 'the address is the link').toHaveURL((at) => `${at.pathname}${at.search}` === link);
    expect(await historyAdded(stranger), 'no history entry added by the landing').toBe(0);
    await expect.poll(() => stranger.page.evaluate(unreachableControls, { scope: null }), { message: 'every control is reachable and tappable', timeout: 5_000 }).toEqual([]);
    expect(await ui.paneIds(stranger), 'still the linked note').toEqual([docId]);
    await actors.requireDistinct(2);
  });
}

test('j08 link notes: while the linked note is being read, text typed into your own note is kept and a note you choose stays (T9.54) @p:ppl-2@2', async ({ actors, stack }) => {
  const { ada, docId } = await adaNote(actors, stack.baseUrl);
  const link = `/d/${docId}?share=${await linkDoc(ada, docId, 'editor')}`;
  const benPrincipal = await actors.principal('ben');
  const { setup, own } = await ownNotes(actors, benPrincipal, stack.baseUrl, ['Ben older', 'Ben newer']);

  /**
   * A window of his on the edit link whose second `GET /api/docs/<linked>` of the load (moss's read; the first is the
   * route's gate) is held until `release`.
   */
  const heldWindow = async (label: string) => {
    const actor = await actors.session(benPrincipal, { label });
    let seen = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    await actor.page.route(`**/api/docs/${docId}`, async (route: Route) => {
      seen += 1;
      if (seen === 2) await released;
      await route.continue();
    });
    await actor.goto(link);
    await expect.poll(() => seen, { message: `${label}: moss reads the linked note after the gate`, timeout: BOOT_TIMEOUT }).toBeGreaterThanOrEqual(2);
    await premise(actor, own, docId, label);
    // While the read is held, a note of his own is on screen and live.
    await expect.poll(async () => {
      const ids = await ui.paneIds(actor);
      return ids.length === 1 && own.includes(ids[0]);
    }, { message: `${label}: while moss reads the linked note, a note of his own is the pane`, timeout: BIND_TIMEOUT }).toBe(true);
    const [shown] = await ui.paneIds(actor);
    await ui.waitLive(actor, shown);
    return { actor, shown, release };
  };

  // Typed text is kept: he types into his own note while the read is held, and the read is released at once.
  {
    const { actor, shown, release } = await heldWindow('ben-typing');
    const marker = ` typed while the link loads ${randomBytes(3).toString('hex')}`;
    await ui.typeBody(actor, shown, marker);
    release();
    await softly.poll(() => ui.paneIds(actor), { message: 'typing: the linked note is the one pane', timeout: BIND_TIMEOUT }).toEqual([docId]);
    await expect.poll(() => contentOf(setup, stack.baseUrl, shown), { message: 'his own note holds the whole marker', timeout: LIVE_TIMEOUT }).toContain(marker);
    expect(await contentOf(ada, stack.baseUrl, docId), 'Ada\'s note does not hold it').not.toContain(marker.trim());
  }

  // A chosen note stays: he clicks his older note while the read is held; once the read answers, it is still there.
  {
    const { actor, release } = await heldWindow('ben-choosing');
    const older = own[0];
    await actor.page.locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}="${older}"]`).click();
    await ui.waitLive(actor, older);
    const answered = actor.page.waitForResponse((response) => new URL(response.url()).pathname === `/api/docs/${docId}`);
    release();
    expect((await answered).status(), 'the read answers').toBe(200);
    await actor.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await ui.paneIds(actor), 'choosing: his older note is still the one pane').toEqual([older]);
    await expect(actor.page, 'choosing: the address names it').toHaveURL((at) => at.pathname === `/d/${older}`);
  }
  await actors.requireDistinct(2);
});
