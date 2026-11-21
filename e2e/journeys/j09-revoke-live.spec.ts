// j09-revoke-live (T2.5): access taken away reaches open windows at once, through the one kick path. Ada lowers Ben
// from edit to view and his socket closes 4403 within a second, his note turning read-only with a message; removing
// him ends the note for him (`revoked`). Revoking a link closes everyone who opened the note through it, signed in or
// not. Signing out in one window ends the same session's other window (`session-ended`). A raise reaches the open
// note without a reload (T9.12): it asks for its new role, reconnects at it and says so in moss's feedback pill. Cold: in the idle window a
// DocDO hibernates in, a revoked doc link's and a revoked folder link's holders land no frame after the wake.
import { randomBytes } from 'node:crypto';
import type { BrowserContext, Locator, Page, Route } from '@playwright/test';
import type { Actor, Actors } from '../lib/actors.ts';
import {
  ACTION_FEEDBACK_ATTR, APP_STATE_ATTR, BODY_BINDING_ATTR, CONNECTION_BANNER_ATTR, DOC_STATE_ATTR, EDIT_MODE_ATTR, ROLE_ATTR,
  ROLE_BAND_ATTR, SYNC_UNACKED_ATTR, TERMINAL_REASON_ATTR, paneSelector,
} from '../lib/contract.ts';
import { grantDoc } from '../lib/grants.ts';
import { IDLE_MS, inductionProblems } from '../lib/hibernate.ts';
import { visibility } from '../lib/idle.ts';
import type { Principal } from '../lib/principals.ts';
import { expect, test, ui } from '../lib/test.ts';

const BIND_TIMEOUT = 15_000;
const LIVE_TIMEOUT = 10_000;
const TEXT = 'Before anything changed, café';
const VIEW_ONLY = 'You can view this note but can no longer edit it.';
const ACCESS_ASK = /\/api\/docs\/[^/]+\/access/;

/** Every doc-socket close the page sees, with its code and the wall clock (A§10.5). Installed before the app loads. */
async function recordCloses(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const closes: { url: string; code: number; at: number }[] = [];
    (window as unknown as { __closes: typeof closes }).__closes = closes;
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('close', (event) => closes.push({ url: String(url), code: event.code, at: Date.now() }));
      }
    };
  });
}

const closes = (page: Page) => page.evaluate(() => (window as unknown as { __closes: { url: string; code: number; at: number }[] }).__closes);

async function openShell(actors: Actors, label: string): Promise<Actor> {
  const actor = await actors.open(await actors.principal(label));
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  return actor;
}

/** "+ Note" with text the DocDO has acked. */
async function noteWithText(ada: Actor): Promise<string> {
  const docId = await ui.createNote(ada);
  await ui.typeBody(ada, docId, TEXT);
  await expect(ui.pane(ada, docId), 'the DocDO acks the text').toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: LIVE_TIMEOUT });
  return docId;
}

/** A person's (or an invite's) access in the owner's Share dialog: a role menu whose last item is Remove access (T9.36). */
const accessSelect = (dialog: Locator, who: string): Locator => ui.roleMenu(dialog, `Access for ${who}`);

async function chooseAccess(dialog: Locator, who: string, choice: ui.Access | 'Remove access'): Promise<void> {
  await ui.chooseRole(dialog, `Access for ${who}`, choice);
}

/** Opens `path` as a signed-in principal with doc-socket closes recorded. */
async function openRecorded(actors: Actors, principal: Principal, path: string, label?: string): Promise<Actor> {
  const actor = await actors.session(principal, { label });
  await recordCloses(actor.context);
  await actor.goto(path);
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  return actor;
}

async function expectRevoked(actor: Actor, docId: string): Promise<void> {
  await expect(ui.pane(actor, docId), `${actor.label}: the note ends for them in place`).toHaveAttribute(TERMINAL_REASON_ATTR, 'revoked', { timeout: LIVE_TIMEOUT });
  await expect(ui.pane(actor, docId)).toHaveAttribute(DOC_STATE_ATTR, 'terminal');
  await expect(ui.pane(actor, docId).locator(`[${CONNECTION_BANNER_ATTR}="revoked"]`), `${actor.label}: and says why`).toHaveText(/Your access to this note has ended\./);
  await expect(ui.body(actor, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'terminal');
}

test('j09 demotion: Ada lowers Ben from edit to view; his socket closes 4403 within 1 s and the note turns read-only with a message @p:ppl-2 @evidence', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const docId = await noteWithText(ada);
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, 'editor');
  const ben = await openRecorded(actors, benPrincipal, `/d/${docId}`);
  await ui.waitOpen(ben, docId, 'live');
  await expect(ui.pane(ben, docId)).toHaveAttribute(ROLE_ATTR, 'editor');
  await actors.requireDistinct(2);
  // The read-only rebind opens one fresh socket after the 4403.
  ben.expectReconnects(1, docId);

  const dialog = await ui.openShare(ada, docId);
  await expect(accessSelect(dialog, benPrincipal.name), 'Ben is listed with his access').toHaveText('Can edit');
  const patched = ada.page.waitForResponse((response) => response.url().endsWith(`/api/docs/${docId}/members`) && response.request().method() === 'PATCH');
  // The clock starts at the choice itself, once the role menu is open.
  await accessSelect(dialog, benPrincipal.name).click();
  const choice = ui.openRoleMenu(dialog).getByRole('menuitemradio', { name: 'Can view', exact: true });
  await expect(choice).toBeVisible();
  const sentAt = Date.now();
  await choice.click();
  expect((await patched).status(), 'the demotion is saved').toBe(200);
  await expect(accessSelect(dialog, benPrincipal.name), "Ada's list shows the new access").toHaveText('Can view');
  await expect(dialog.getByRole('status'), 'and says so').toContainText('Can view');

  await expect.poll(async () => (await closes(ben.page)).filter((c) => c.url.includes(`/parties/doc-d-o/${docId}`)).map((c) => c.code),
    { message: "Ben's doc socket closes 4403", timeout: LIVE_TIMEOUT }).toContain(4403);
  const kick = (await closes(ben.page)).find((c) => c.code === 4403);
  expect(kick!.at - sentAt, 'within 1 s of the demotion').toBeLessThan(1_000);

  await expect(ui.pane(ben, docId).locator('[data-input-refusal]'), 'Ben is told why he can no longer type').toHaveText(VIEW_ONLY, { timeout: LIVE_TIMEOUT });
  await ui.waitOpen(ben, docId, 'readonly');
  await expect(ui.pane(ben, docId), 'his pane reads at view').toHaveAttribute(ROLE_ATTR, 'viewer');
  expect(await ui.fieldText(ben, docId, 'body'), 'the content stays').toBe(TEXT);
  await actors.checkpoint('demoted');
  await ui.body(ben, docId).click({ force: true });
  await ben.page.keyboard.type('blocked');
  expect(await ui.fieldText(ben, docId, 'body'), 'a keystroke changes nothing').toBe(TEXT);
  expect(await ui.fieldText(ada, docId, 'body'), 'and nothing reaches Ada').toBe(TEXT);

  // T9.10: the band says so and stays; once the notice clears, a later key is refused out loud again.
  const band = ui.pane(ben, docId).locator(`[${ROLE_BAND_ATTR}]`);
  await expect(band, 'the band says he can view only').toHaveText('View only');
  const refusal = ui.pane(ben, docId).locator('[data-input-refusal]');
  await expect(refusal, 'the demotion notice clears').toHaveText('', { timeout: LIVE_TIMEOUT });
  await expect(band, 'and the band stays').toBeVisible();
  await ui.body(ben, docId).click({ force: true });
  await ben.page.keyboard.type('again');
  await expect(refusal, 'a later key is refused out loud').toHaveText("You can view this note, but you can't edit it.");
  await actors.checkpoint('demoted-typing');
  expect(await ui.fieldText(ada, docId, 'body'), 'and still nothing reaches Ada').toBe(TEXT);
});

const CAN_EDIT_NOW = 'You can now edit this note.';
const VIEW_BAND = 'View only';

/**
 * The workspace channel, held down on demand: while down, each new channel socket closes before it opens, as on a dead
 * network, and the live one is closed. Installed before the app loads.
 */
async function holdableChannel(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const live: WebSocket[] = [];
    const state = { down: false };
    (window as unknown as { __channelDown: (down: boolean) => void }).__channelDown = (down: boolean) => {
      state.down = down;
      if (down) for (const socket of live.splice(0)) socket.close(3000, 'held down');
    };
    const Native = window.WebSocket;
    class Unreachable extends EventTarget {
      readyState = 0;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      constructor() {
        super();
        setTimeout(() => {
          this.readyState = 3;
          this.onclose?.(new CloseEvent('close', { code: 1006 }));
        }, 50);
      }
      send(): void {}
      close(): void { this.readyState = 3; }
    }
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        const channel = String(url).includes('/api/workspace/ws');
        if (channel && state.down) return new Unreachable() as never;
        super(url, protocols);
        if (channel) live.push(this);
      }
    } as typeof WebSocket;
  });
}

const setChannelDown = (actor: Actor, down: boolean) =>
  actor.page.evaluate((value) => (window as unknown as { __channelDown: (down: boolean) => void }).__channelDown(value), down);

/** Ben's open note took the raise to edit: live, in Edit, the band gone, and the pill says so. */
async function expectRaisedToEdit(ben: Actor, docId: string, timeout: number): Promise<void> {
  await expect(ui.body(ben, docId), 'his open note takes typing').toHaveAttribute(BODY_BINDING_ATTR, 'live', { timeout });
  await expect(ui.pane(ben, docId)).toHaveAttribute(ROLE_ATTR, 'editor');
  await expect(ui.pane(ben, docId), 'in Edit, not left in Review').toHaveAttribute(EDIT_MODE_ATTR, 'edit');
  await expect(ben.page.locator(`[${ACTION_FEEDBACK_ATTR}]`), 'and says so').toHaveText(CAN_EDIT_NOW, { timeout });
  await expect(ui.pane(ben, docId).locator(`[${ROLE_BAND_ATTR}]`), 'the role band goes').toHaveCount(0);
}

test('j09 raise: Ada raises Ben from view to edit and his open note takes typing within 2 s and says so; lowered and raised again, it does again @p:ppl-2 @evidence', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const docId = await noteWithText(ada);
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, 'viewer');
  const ben = await openRecorded(actors, benPrincipal, `/d/${docId}`);
  await ui.waitOpen(ben, docId, 'readonly');
  await expect(ui.pane(ben, docId)).toHaveAttribute(ROLE_ATTR, 'viewer');
  await expect(ui.pane(ben, docId).locator(`[${ROLE_BAND_ATTR}]`)).toHaveText(VIEW_BAND);
  await actors.requireDistinct(2);
  // Each raise reconnects at the new role once his edits are acked; the lowering between rebinds read-only once.
  ben.expectReconnects(3, docId);
  await actors.checkpoint('raise-before');

  const dialog = await ui.openShare(ada, docId);
  await chooseAccess(dialog, benPrincipal.name, 'Can edit');
  await expect(accessSelect(dialog, benPrincipal.name), "Ada's list shows the raise").toHaveText('Can edit');
  await expectRaisedToEdit(ben, docId, 2_000);
  await actors.checkpoint('raise-after-2s');
  expect((await closes(ben.page)).filter((c) => c.code === 4403), 'a raise closes nothing from the server').toEqual([]);
  const first = ' and Ben edits after the raise';
  await ui.typeBody(ben, docId, first);
  await expect.poll(() => ui.fieldText(ada, docId, 'body'), { message: 'his typing reaches Ada', timeout: LIVE_TIMEOUT }).toBe(`${TEXT}${first}`);
  await actors.checkpoint('raise-typed');

  // Lowered, then raised again: the note he holds after the lowering takes the second raise too.
  await ui.waitAcked(ben, docId);
  await chooseAccess(dialog, benPrincipal.name, 'Can view');
  await ui.waitOpen(ben, docId, 'readonly');
  await expect(ui.pane(ben, docId)).toHaveAttribute(ROLE_ATTR, 'viewer');
  await expect(ben.page.locator(`[${ACTION_FEEDBACK_ATTR}]`), 'the first pill has gone').toHaveCount(0, { timeout: LIVE_TIMEOUT });
  await chooseAccess(dialog, benPrincipal.name, 'Can edit');
  await expectRaisedToEdit(ben, docId, 2_000);
  const second = ' and again';
  await ui.typeBody(ben, docId, second);
  await expect.poll(() => ui.fieldText(ada, docId, 'body'), { message: 'his typing reaches Ada again', timeout: LIVE_TIMEOUT }).toBe(`${TEXT}${first}${second}`);
});

test('j09 raise offline: a raise Ben misses while his workspace channel is down applies when it reconnects @p:ppl-2', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const docId = await noteWithText(ada);
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, 'viewer');
  const ben = await actors.session(benPrincipal);
  await holdableChannel(ben.context);
  await ben.goto(`/d/${docId}`);
  await ben.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await ui.waitOpen(ben, docId, 'readonly');
  await actors.requireDistinct(2);
  ben.expectReconnects(1, docId);

  await setChannelDown(ben, true);
  const origin = new URL(ada.page.url()).origin;
  const raised = await ada.context.request.patch(`${origin}/api/docs/${docId}/members`,
    { headers: { origin }, data: { principalId: benPrincipal.id!, role: 'editor' } });
  expect(raised.status(), 'the raise is saved').toBe(200);
  await ben.page.waitForTimeout(3_000);
  await expect(ui.body(ben, docId), 'not heard while the channel is down').toHaveAttribute(BODY_BINDING_ATTR, 'readonly');
  await expect(ui.pane(ben, docId)).toHaveAttribute(ROLE_ATTR, 'viewer');

  await setChannelDown(ben, false);
  await expectRaisedToEdit(ben, docId, 20_000);
  const typed = ' typed after the reconnect';
  await ui.typeBody(ben, docId, typed);
  await expect.poll(() => ui.fieldText(ada, docId, 'body'), { message: 'his typing reaches Ada', timeout: LIVE_TIMEOUT }).toBe(`${TEXT}${typed}`);
});

test('j09 raise then lower: a raise whose answers reach Ben only after Ada has lowered him again leaves his note read-only, with no pill and no typing @p:ppl-2', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const docId = await noteWithText(ada);
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, 'viewer');
  const ben = await openRecorded(actors, benPrincipal, `/d/${docId}`);
  await ui.waitOpen(ben, docId, 'readonly');
  await actors.requireDistinct(2);
  // The lowering's kick rebinds read-only once.
  ben.expectReconnects(1, docId);

  // Reads Ben starts while he is an editor get the server's answer at once, delivered only once the lowering reached him.
  let holding = true;
  let heldAccess = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  await ben.context.route((url) => ACCESS_ASK.test(url.pathname) || url.pathname === '/api/workspace', async (route) => {
    if (!holding || route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    if (ACCESS_ASK.test(new URL(route.request().url()).pathname)) heldAccess += 1;
    await released;
    await route.fulfill({ response });
  });
  // From here on: whether his body is ever live, or the pill ever says he can edit.
  await ben.page.evaluate(({ pane, bodyAttr, feedbackAttr, text }) => {
    const seen = { live: false, pill: false };
    (window as unknown as { __seen: typeof seen }).__seen = seen;
    setInterval(() => {
      if (document.querySelector(`${pane} [${bodyAttr}="live"]`)) seen.live = true;
      if ([...document.querySelectorAll(`[${feedbackAttr}]`)].some((el) => el.textContent?.includes(text))) seen.pill = true;
    }, 10);
  }, { pane: paneSelector(docId), bodyAttr: BODY_BINDING_ATTR, feedbackAttr: ACTION_FEEDBACK_ATTR, text: CAN_EDIT_NOW });

  const origin = new URL(ada.page.url()).origin;
  const setBen = (role: string) => ada.context.request.patch(`${origin}/api/docs/${docId}/members`,
    { headers: { origin }, data: { principalId: benPrincipal.id!, role } });
  expect((await setBen('editor')).status(), 'the raise is saved').toBe(200);
  await expect.poll(() => heldAccess, { message: 'Ben asks for his raised role', timeout: LIVE_TIMEOUT }).toBeGreaterThan(0);
  holding = false;
  const reasked = ben.page.waitForResponse((response) => ACCESS_ASK.test(new URL(response.url()).pathname), { timeout: LIVE_TIMEOUT });
  expect((await setBen('viewer')).status(), 'the lowering is saved').toBe(200);
  await reasked;
  await ben.page.waitForTimeout(500);
  release();

  await ben.page.waitForTimeout(3_000);
  const seen = await ben.page.evaluate(() => (window as unknown as { __seen: { live: boolean; pill: boolean } }).__seen);
  expect(seen.pill, 'the pill never says he can edit').toBe(false);
  expect(seen.live, 'his note never takes typing').toBe(false);
  await expect(ui.pane(ben, docId)).toHaveAttribute(ROLE_ATTR, 'viewer');
  await expect(ui.body(ben, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'readonly');
  await ui.body(ben, docId).click({ force: true });
  await ben.page.keyboard.type('blocked');
  expect(await ui.fieldText(ben, docId, 'body'), 'a keystroke changes nothing').toBe(TEXT);
  await ben.page.waitForTimeout(1_000);
  expect(await ui.fieldText(ada, docId, 'body'), 'and nothing reaches Ada').toBe(TEXT);
});

test('j09 raise then quick lower: lowered while the pill says he can edit, the pill goes at once @p:ppl-2', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const docId = await noteWithText(ada);
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, 'viewer');
  const ben = await openRecorded(actors, benPrincipal, `/d/${docId}`);
  await ui.waitOpen(ben, docId, 'readonly');
  await actors.requireDistinct(2);
  // The raise reconnects at edit; the lowering's kick rebinds read-only once.
  ben.expectReconnects(2, docId);

  const origin = new URL(ada.page.url()).origin;
  const setBen = (role: string) => ada.context.request.patch(`${origin}/api/docs/${docId}/members`,
    { headers: { origin }, data: { principalId: benPrincipal.id!, role } });
  expect((await setBen('editor')).status(), 'the raise is saved').toBe(200);
  const pill = ben.page.locator(`[${ACTION_FEEDBACK_ATTR}]`);
  await expect(pill, 'the pill says he can edit').toHaveText(CAN_EDIT_NOW, { timeout: LIVE_TIMEOUT });
  expect((await setBen('viewer')).status(), 'the lowering is saved').toBe(200);
  // The pill would stay 2.4 s on its own.
  await expect(pill, 'the pill goes with the lowering').toHaveCount(0, { timeout: 1_500 });
  await ui.waitOpen(ben, docId, 'readonly');
  await expect(ui.pane(ben, docId)).toHaveAttribute(ROLE_ATTR, 'viewer');
});

test('j09 lower then raise: a lowering whose answers reach Ben only after Ada has raised him back leaves his note taking typing @p:ppl-2', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const docId = await noteWithText(ada);
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, 'editor');
  const ben = await openRecorded(actors, benPrincipal, `/d/${docId}`);
  await ui.waitOpen(ben, docId, 'live');
  await actors.requireDistinct(2);
  // The lowering's kick closes his socket 4403 and he reconnects once.
  ben.expectReconnects(1, docId);

  // Reads Ben starts while he is a viewer get the server's answer at once, delivered only once the raise reached him.
  let holding = true;
  let heldAccess = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  await ben.context.route((url) => ACCESS_ASK.test(url.pathname) || url.pathname === '/api/workspace', async (route) => {
    if (!holding || route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    if (ACCESS_ASK.test(new URL(route.request().url()).pathname)) heldAccess += 1;
    await released;
    await route.fulfill({ response });
  });

  const origin = new URL(ada.page.url()).origin;
  const setBen = (role: string) => ada.context.request.patch(`${origin}/api/docs/${docId}/members`,
    { headers: { origin }, data: { principalId: benPrincipal.id!, role } });
  expect((await setBen('viewer')).status(), 'the lowering is saved').toBe(200);
  await expect.poll(async () => (await closes(ben.page)).map((c) => c.code), { message: "Ben's doc socket closes 4403", timeout: LIVE_TIMEOUT }).toContain(4403);
  await expect.poll(() => heldAccess, { message: 'Ben asks for his lowered role', timeout: LIVE_TIMEOUT }).toBeGreaterThan(0);
  expect((await setBen('editor')).status(), 'the raise back is saved').toBe(200);
  await ben.page.waitForTimeout(1_000);
  holding = false;
  release();
  // His socket closed with the lowering while his body stayed open to offline typing: the held answers land first.
  await ben.page.waitForTimeout(3_000);

  await expect(ui.body(ben, docId), 'his note takes typing again').toHaveAttribute(BODY_BINDING_ATTR, 'live', { timeout: LIVE_TIMEOUT });
  await expect(ui.pane(ben, docId)).toHaveAttribute(ROLE_ATTR, 'editor');
  await expect(ui.pane(ben, docId).locator(`[${ROLE_BAND_ATTR}]`), 'no role band').toHaveCount(0);
  const typed = ' typed after the raise back';
  await ui.typeBody(ben, docId, typed);
  await expect.poll(() => ui.fieldText(ada, docId, 'body'), { message: 'his typing reaches Ada', timeout: LIVE_TIMEOUT }).toBe(`${TEXT}${typed}`);
});

test('j09 removal: removing a member ends the note for them in place (revoked) @p:ppl-2 @evidence', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const docId = await noteWithText(ada);
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, 'editor');
  const ben = await openRecorded(actors, benPrincipal, `/d/${docId}`);
  await ui.waitOpen(ben, docId, 'live');
  await actors.requireDistinct(2);
  ben.expectHttp(404, ACCESS_ASK);

  const dialog = await ui.openShare(ada, docId);
  await chooseAccess(dialog, benPrincipal.name, 'Remove access');
  await expect(accessSelect(dialog, benPrincipal.name), 'Ben leaves the list').toHaveCount(0);
  await expectRevoked(ben, docId);
  expect(await ui.fieldText(ben, docId, 'body'), 'what he had read stays on screen').toBe(TEXT);
  await actors.checkpoint('removed');
  await expect(ben.page.locator(`[data-sidebar-row][data-doc-id="${docId}"]`), 'and the note leaves his list').toHaveCount(0, { timeout: LIVE_TIMEOUT });

  // Terminal: nothing reconnects.
  const opened = ben.telemetry.sockets.filter((s) => s.docId === docId).length;
  await ben.page.waitForTimeout(3_000);
  expect(ben.telemetry.sockets.filter((s) => s.docId === docId), 'no reconnect after revoked').toHaveLength(opened);
});

// WebKit logs a fetch a navigation cancels as "…due to access control checks", a page error: the note's access read
// is aborted as the page leaves (host/leave.ts).
test('j09 reload: reloading while the note’s access read is in flight logs no page error @p:ppl-2', async ({ actors }) => {
  actors.solo('one window reloading over its own note');
  const ada = await openShell(actors, 'ada');
  const docId = await noteWithText(ada);
  // The reload goes out as soon as the route's access read (GET /api/docs/:id) does, on the real network, a few times.
  const accessRead = (request: { url: () => string; method: () => string }) => request.method() === 'GET' && new URL(request.url()).pathname === `/api/docs/${docId}`;
  for (let round = 0; round < 6; round += 1) {
    const asked = ada.page.waitForRequest(accessRead, { timeout: 30_000 });
    if (round === 0) await ada.page.goto(`/d/${docId}`, { waitUntil: 'commit' });
    else await ada.page.reload({ waitUntil: 'commit' });
    await asked;
  }
  // Held: the server's answer waits until the page has left, so each reload finds the route's read in flight. The page
  // records, as it hides, every access read still unanswered and whether the page's leave had aborted it.
  const accessPath = `/api/docs/${docId}`;
  await ada.page.context().addInitScript((path: string) => {
    const reads: { aborted: boolean; answered: boolean }[] = [];
    const native = window.fetch;
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname !== path || (init?.method ?? 'GET') !== 'GET') return native.call(window, input, init);
      const read = { aborted: Boolean(init?.signal?.aborted), answered: false };
      reads.push(read);
      init?.signal?.addEventListener('abort', () => { read.aborted = true; });
      const answer = native.call(window, input, init);
      answer.then(() => { read.answered = true; }, () => undefined);
      return answer;
    };
    window.addEventListener('pagehide', () => {
      const cut = JSON.parse(sessionStorage.getItem('j09-cut') ?? '[]') as boolean[];
      for (const read of reads) if (!read.answered) cut.push(read.aborted);
      sessionStorage.setItem('j09-cut', JSON.stringify(cut));
    });
  }, accessPath);
  const held: Route[] = [];
  const heldPath = (url: URL) => url.pathname === accessPath;
  // The route stays installed: unrouting the last route while the next page loads can leave its module fetches
  // paused for good in Chromium. Releasing switches it to pass-through instead.
  let holding = true;
  const hold = (route: Route) => { if (holding) held.push(route); else void route.continue().catch(() => undefined); };
  await ada.page.route(heldPath, hold);
  for (let round = 0; round < 3; round += 1) {
    const asked = ada.page.waitForRequest(accessRead, { timeout: 30_000 });
    await ada.page.reload({ waitUntil: 'commit' });
    await asked;
    await expect.poll(() => held.length, { message: 'the route read is held' }).toBeGreaterThan(round);
  }
  // Released only once the last held page has left (Chromium sends a paused request on as its route goes).
  await ada.page.reload({ waitUntil: 'commit' });
  holding = false;
  for (const route of held) await route.continue().catch(() => undefined);
  const cut = await ada.page.evaluate(() => JSON.parse(sessionStorage.getItem('j09-cut') ?? '[]') as boolean[]);
  expect(cut.length, 'each held round left a read in flight').toBeGreaterThanOrEqual(3);
  expect(cut, "the page's leave aborted every access read the reload found in flight").toEqual(cut.map(() => true));
  ada.observations.delete(docId);
  await ada.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await ui.waitOpen(ada, docId, 'live');
  expect(ada.telemetry.pageErrors.map((error) => error.message), 'no page error from a read the reload cut off').toEqual([]);
});

test('j09 demote then remove: removing Ben within 4 s of a demotion leaves only the ended notice (T3.S20) @p:ppl-2', async ({ actors, stack }) => {
  const ada = await openShell(actors, 'ada');
  const docId = await noteWithText(ada);
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, 'editor');
  const ben = await openRecorded(actors, benPrincipal, `/d/${docId}`);
  await ui.waitOpen(ben, docId, 'live');
  await actors.requireDistinct(2);
  ben.expectReconnects(1, docId);
  ben.expectHttp(404, ACCESS_ASK);
  const refusal = ui.pane(ben, docId).locator('[data-input-refusal]');

  const dialog = await ui.openShare(ada, docId);
  await chooseAccess(dialog, benPrincipal.name, 'Can view');
  await expect(refusal, 'the demotion alone says the note is view-only').toHaveText(VIEW_ONLY, { timeout: LIVE_TIMEOUT });
  const shownAt = Date.now();
  await ui.waitOpen(ben, docId, 'readonly');
  // Removed at once through the members API (the dialog's clicks take too long in WebKit): the view-only notice
  // would otherwise still show for its 4 s.
  const removed = await ada.context.request.delete(`/api/docs/${docId}/members`, { headers: { origin: stack.baseUrl }, data: { principalId: ben.principal!.id } });
  expect(removed.status(), 'the removal is saved').toBe(200);
  await expect(ui.pane(ben, docId), 'the note ends for him').toHaveAttribute(TERMINAL_REASON_ATTR, 'revoked', { timeout: LIVE_TIMEOUT });
  await expect(refusal, 'and no longer says he can view it').not.toHaveText(VIEW_ONLY, { timeout: 500 });
  expect(Date.now() - shownAt, 'checked while the view-only notice would still show').toBeLessThan(3_800);
  await expect(ui.pane(ben, docId).locator(`[${CONNECTION_BANNER_ATTR}="revoked"]`)).toHaveText(/Your access to this note has ended\./);
  await actors.checkpoint('demoted-then-removed');
});

test('j09 link: revoking a link closes everyone who opened the note through it, signed in or not @p:ppl-2', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const docId = await noteWithText(ada);
  const dialog = await ui.openShare(ada, docId);
  const path = ui.pathOf(await ui.createLink(dialog, 'Can edit'));
  await ada.page.keyboard.press('Escape');

  const cy = await openRecorded(actors, await actors.principal('cy'), path);
  await ui.waitOpen(cy, docId, 'live');
  await expect(ui.pane(cy, docId), 'signed in without a grant, Cy rides the link at edit').toHaveAttribute(ROLE_ATTR, 'editor');
  const stranger = await actors.anonymous(path, { label: 'stranger' });
  await ui.waitOpen(stranger, docId, 'readonly');
  await actors.requireDistinct(2);
  for (const holder of [cy, stranger]) holder.expectHttp(404, ACCESS_ASK);

  const again = await ui.openShare(ada, docId);
  await ui.linkRow(again, 'Can edit').getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(ui.linkField(again, 'Can edit')).toHaveCount(0);
  await expectRevoked(cy, docId);
  await expectRevoked(stranger, docId);
  expect((await closes(cy.page)).map((c) => c.code), 'the link rider was closed 4403').toContain(4403);
  await actors.checkpoint('link-revoked');
});

test('j09 sign-out: signing out in one window ends the same session in the other (session-ended) @p:ppl-2 @p:ppl-1@2', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const docId = await noteWithText(ada);
  const ben = await openShell(actors, 'ben');
  await actors.requireDistinct(2);

  // Window B: a second tab of Ada's session, on the same note.
  const windowB = await ada.context.newPage();
  const workspaceClosed = new Promise<void>((resolve) => {
    windowB.on('websocket', (socket) => {
      if (new URL(socket.url()).pathname === '/api/workspace/ws') socket.on('close', () => resolve());
    });
  });
  await windowB.goto(`/d/${docId}`);
  await expect(windowB.locator(paneSelector(docId)), 'window B opens the note').toHaveAttribute(DOC_STATE_ATTR, 'live', { timeout: BIND_TIMEOUT });
  await expect(windowB.locator(`${paneSelector(docId)} [${BODY_BINDING_ATTR}]`)).toHaveAttribute(BODY_BINDING_ATTR, 'live');

  await ui.signOutThroughSettings(ada);
  await ada.page.waitForURL((at) => at.pathname === '/login', { timeout: 30_000 });

  const paneB = windowB.locator(paneSelector(docId));
  await expect(paneB, 'window B ends in place').toHaveAttribute(TERMINAL_REASON_ATTR, 'session-ended', { timeout: LIVE_TIMEOUT });
  await expect(paneB.locator(`[${CONNECTION_BANNER_ATTR}="session-ended"]`)).toContainText('Your session has ended.');
  await expect(paneB.getByRole('button', { name: 'Sign in', exact: true }), 'and offers sign-in').toBeVisible();
  await expect(paneB.locator(`[${BODY_BINDING_ATTR}]`)).toHaveAttribute(BODY_BINDING_ATTR, 'terminal');
  await workspaceClosed;
  await windowB.close();

  // Ben's session is untouched.
  await expect(ben.page.locator(`html[${APP_STATE_ATTR}="ready"]`)).toBeAttached();
  expect((await ben.context.request.get('/api/me')).status()).toBe(200);
});

test('j09 cold: after an idle wake, a revoked doc link and a revoked folder link land no frame @hibernate @slow @p:ppl-2 @p:tech-6', async ({ actors, stack }, info) => {
  test.setTimeout(300_000);
  // Ada works over the API only: an open shell shows the most recently edited note, so the holders' typing would
  // switch her window between their notes and keep their DOs awake.
  const ada = await actors.session(await actors.principal('ada'));
  const headers = { origin: stack.baseUrl };
  // Declared setup over the API: a note with an editor link, and a folder holding a subfolder note with an editor
  // folder link. The links' revocation is what this leg proves, so it is the decisive action.
  const { vault } = (await (await ada.context.request.get('/api/workspace')).json()) as { vault: { id: string } };
  const made = await ada.context.request.post('/api/folders', { headers, data: { name: `Cold ${randomBytes(2).toString('hex')}`, parentId: vault.id } });
  const folderId = ((await made.json()) as { folder: { id: string } }).folder.id;
  const sub = await ada.context.request.post('/api/folders', { headers, data: { name: 'Inner', parentId: folderId } });
  const subId = ((await sub.json()) as { folder: { id: string } }).folder.id;
  const docNote = await ada.context.request.post('/api/docs', { headers, data: { title: 'Doc-linked' } });
  const folderNote = await ada.context.request.post('/api/docs', { headers, data: { folderId: subId, title: 'Folder-linked' } });
  const docId = ((await docNote.json()) as { doc: { id: string } }).doc.id;
  const deepId = ((await folderNote.json()) as { doc: { id: string } }).doc.id;
  const link = async (path: string) => ((await (await ada.context.request.post(path, { headers, data: { role: 'editor' } })).json()) as { link: { token: string } }).link.token;
  const docToken = await link(`/api/docs/${docId}/links`);
  const folderToken = await link(`/api/folders/${folderId}/links`);

  const cy = await actors.principal('cy');
  const holders = [
    { docId, actor: await openRecorded(actors, cy, `/d/${docId}?share=${docToken}`, 'cy-doc'), text: ' doc-holder before' },
    { docId: deepId, actor: await openRecorded(actors, cy, `/d/${deepId}?share=${folderToken}`, 'cy-folder'), text: ' folder-holder before' },
  ];
  for (const holder of holders) {
    await ui.waitOpen(holder.actor, holder.docId, 'live');
    await ui.typeBody(holder.actor, holder.docId, holder.text);
    await expect(ui.pane(holder.actor, holder.docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: LIVE_TIMEOUT });
    holder.actor.expectHttp(404, ACCESS_ASK);
  }
  await actors.requireDistinct(2);

  const baseline = await Promise.all(holders.map((h) => stack.docInstance(h.docId)));
  // Every window goes quiet: a visible tab's resync keeps its DO awake.
  for (const holder of holders) await visibility(holder.actor, true);
  await new Promise((resolve) => setTimeout(resolve, IDLE_MS));

  const decisiveAt = Date.now();
  expect((await ada.context.request.delete(`/api/docs/${docId}/links/${docToken}`, { headers })).status()).toBe(200);
  expect((await ada.context.request.delete(`/api/folders/${folderId}/links/${folderToken}`, { headers })).status()).toBe(200);
  for (const [index, holder] of holders.entries()) {
    const after = await stack.docInstance(holder.docId);
    await info.attach(`cold-${index}-instance.json`, { body: JSON.stringify({ base: baseline[index], after, decisiveAt }), contentType: 'application/json' });
    expect(inductionProblems(baseline[index], after, decisiveAt), 'the revocation met a woken DO').toEqual([]);
  }

  for (const holder of holders) {
    await visibility(holder.actor, false);
    await holder.actor.page.keyboard.type(' after the wake');
    await expectRevoked(holder.actor, holder.docId);
  }
  // The owner reads both notes fresh: nothing typed after the revocation landed.
  for (const holder of holders) {
    const reader = await actors.session(ada.principal as Principal, { label: `reader-${holder.docId.slice(0, 4)}` });
    await reader.goto(`/d/${holder.docId}`);
    await ui.waitOpen(reader, holder.docId, 'live');
    const text = await ui.fieldText(reader, holder.docId, 'body');
    expect(text, 'what the holder typed before the revocation is there').toContain(holder.text.trim());
    expect(text, 'nothing typed after it landed').not.toContain('after the wake');
  }
});
