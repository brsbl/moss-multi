// j03-connection (T1.3; A§10.5, A§10.6): connection truth. A socket that stops delivering, whether black-holed by
// a routeWebSocket sever or stalled by a SIGSTOP of the whole stack, is caught by the client's own heartbeat (4408
// after 12 s of silence): the window's indicator and the banner in its notice band say so within 14 s, its edits
// keep buffering, and on reconnect both windows converge byte for byte. A healthy idle socket shows nothing. A late
// first sync shows `retrying` and binds in place, and a 51st connection is terminal `conn-limit` with a Retry.
//
// Until T1.1's members API is on m1, the peer is the owner's second window (each window is its own client, A§10.7);
// a second principal is signed in beside them (invariant 8).
import type { Locator } from '@playwright/test';
import type { Actor, Actors } from '../lib/actors.ts';
import {
  APP_STATE_ATTR, BODY_BINDING_ATTR, CONNECTION_ATTR, CONNECTION_BANNER_ATTR, DOC_ID_ATTR, DOC_SOCKET_PATH, DOC_STATE_ATTR,
  EDITOR_PANE_ATTR, NAMES, NOTICE_BAND_ATTR, SYNC_UNACKED_ATTR, TERMINAL_REASON_ATTR, TOP_BAR_ATTR, paneSelector,
} from '../lib/contract.ts';
import { remountSince } from '../lib/detectors.js';
import { cookieHeader, holdDocSockets } from '../lib/doc-client.ts';
import { signIn, type Principal } from '../lib/principals.ts';
import type { SocketEntry } from '../lib/telemetry.ts';
import { expect, test, ui } from '../lib/test.ts';

const BOOT_TIMEOUT = 30_000;
const BIND_TIMEOUT = 15_000;
const ACK_TIMEOUT = 15_000;
const RECOVER_TIMEOUT = 30_000;
/** BUILDPLAN T1.3: a sever or a SIGSTOP shows the banner within 14 s (12 s of silence, then the 1 s check). */
const BANNER_BUDGET_MS = 14_000;
const HEARTBEAT_CLOSE = 4408;
const CONN_LIMIT_CLOSE = 4429;

interface ConnEvent {
  kind: 'open' | 'close-call' | 'close' | 'connection' | 'banner';
  url?: string;
  code?: number;
  value?: string;
  at: number;
}

/**
 * Init script: a timeline of the page's doc sockets (open, the page's own close() calls with their codes, close
 * events with theirs) and of every change to the connection indicators and banners. Sockets are recorded only when
 * the page's sockets are real (an unrouted window).
 */
function recordConnection({ path, connection, banner, sockets }: { path: string; connection: string; banner: string; sockets: boolean }): void {
  const log: ConnEvent[] = [];
  (window as unknown as { __j03: ConnEvent[] }).__j03 = log;
  if (sockets) {
    const Native = window.WebSocket;
    const listen = Native.prototype.addEventListener;
    class Recorded extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (!new URL(this.url).pathname.startsWith(path)) return;
        // The native method: a subclass's override must not see these listeners.
        listen.call(this, 'open', () => log.push({ kind: 'open', url: this.url, at: Date.now() }));
        listen.call(this, 'close', (event) => log.push({ kind: 'close', url: this.url, code: (event as CloseEvent).code, at: Date.now() }));
      }

      close(code?: number, reason?: string): void {
        if (new URL(this.url).pathname.startsWith(path)) log.push({ kind: 'close-call', url: this.url, code, at: Date.now() });
        super.close(code, reason);
      }
    }
    window.WebSocket = Recorded;
  }
  let connections = '';
  let banners = '';
  const scan = () => {
    const nowConnections = [...document.querySelectorAll(`[${connection}]`)].map((el) => el.getAttribute(connection)).join(',');
    const nowBanners = [...document.querySelectorAll(`[${banner}]`)].map((el) => el.getAttribute(banner)).join(',');
    if (nowConnections !== connections) log.push({ kind: 'connection', value: (connections = nowConnections), at: Date.now() });
    if (nowBanners !== banners) log.push({ kind: 'banner', value: (banners = nowBanners), at: Date.now() });
  };
  new MutationObserver(scan).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: [connection, banner] });
}

const timeline = (actor: Actor): Promise<ConnEvent[]> => actor.page.evaluate(() => (window as unknown as { __j03?: ConnEvent[] }).__j03 ?? []);

/** A signed-in window for `principal` with the recorder installed, not navigated yet. */
async function windowFor(actors: Actors, principal: Principal, { label, severable = false }: { label: string; severable?: boolean }): Promise<Actor> {
  const actor = await actors.session(principal, { label, severable });
  await actor.context.addInitScript(recordConnection, { path: DOC_SOCKET_PATH, connection: CONNECTION_ATTR, banner: CONNECTION_BANNER_ATTR, sockets: !severable });
  return actor;
}

async function land(actor: Actor, path: string): Promise<void> {
  await actor.goto(path);
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
}

const paneIds = (actor: Actor): Promise<string[]> =>
  actor.page.locator(`[${EDITOR_PANE_ATTR}]`).evaluateAll((panes, attr) => panes.map((p) => p.getAttribute(attr) ?? ''), DOC_ID_ATTR);

/** "+ Note", then the new pane's doc id. */
async function newNote(actor: Actor): Promise<string> {
  const before = await paneIds(actor);
  await actor.page.getByRole(ui.NEW_NOTE.role, { name: ui.NEW_NOTE.name }).click();
  const fresh = async () => (await paneIds(actor)).filter((id) => id !== '' && !before.includes(id));
  await expect.poll(fresh, { message: 'the new note opens in an editor pane', timeout: BIND_TIMEOUT }).toHaveLength(1);
  const [docId] = await fresh();
  if (!docId) throw new Error(`${actor.label}: the pane has no ${DOC_ID_ATTR}`);
  return docId;
}

async function waitBodyLive(actor: Actor, docId: string, timeout = BIND_TIMEOUT): Promise<void> {
  await expect(actor.page.locator(paneSelector(docId)), `${actor.label}: the pane goes live`).toHaveAttribute(DOC_STATE_ATTR, 'live', { timeout });
  await expect(ui.body(actor, docId), `${actor.label}: the body binds`).toHaveAttribute(BODY_BINDING_ATTR, 'live', { timeout });
}

async function waitAcked(actor: Actor, docId: string, timeout = ACK_TIMEOUT): Promise<void> {
  await expect(ui.pane(actor, docId), `${actor.label}: the DocDO acks every edit`).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout });
}

/** The connection indicator in the pane's top bar. */
const indicator = (actor: Actor, docId: string): Locator => ui.pane(actor, docId).locator(`[${TOP_BAR_ATTR}] [${CONNECTION_ATTR}]`);
/** The banner in the pane's notice band. */
const banner = (actor: Actor, docId: string): Locator => ui.pane(actor, docId).locator(`[${NOTICE_BAND_ATTR}] [${CONNECTION_BANNER_ATTR}]`);
/** Polls without waiting: the band shows a visible banner of this kind now. */
const bannerShows = (actor: Actor, docId: string, kind: string) => (): Promise<boolean> =>
  ui.pane(actor, docId).locator(`[${NOTICE_BAND_ATTR}] [${CONNECTION_BANNER_ATTR}="${kind}"]`).isVisible();

const bodyText = (actor: Actor, docId: string): Promise<string> => ui.fieldText(actor, docId, 'body');

/** This document's doc sockets for the note. */
const socketsFor = (actor: Actor, docId: string): SocketEntry[] =>
  actor.telemetry.sockets.filter((socket) => socket.docId === docId && socket.epoch === actor.telemetry.epoch);

async function expectNoRemount(actor: Actor, docId: string, when: string): Promise<void> {
  const observed = actor.observations.get(docId);
  if (!observed) throw new Error(`${actor.label}: ${docId} is not observed`);
  expect(await actor.page.evaluate(remountSince, { names: NAMES, docId, ...observed }), `${when}: no editor remount`).toEqual([]);
}

interface Shared {
  owner: Principal;
  ada: Actor;
  docId: string;
}

/** Ada creates a note and types `opening`, acked; Ben, a second principal, signs in elsewhere (invariant 8). */
async function sharedNote(actors: Actors, opening: string): Promise<Shared> {
  const owner = await actors.principal('ada');
  const ada = await windowFor(actors, owner, { label: 'ada' });
  await land(ada, '/');
  const docId = await newNote(ada);
  await waitBodyLive(ada, docId);
  await ui.typeBody(ada, docId, opening);
  await waitAcked(ada, docId);
  await actors.open(await actors.principal('ben'));
  return { owner, ada, docId };
}

/** Ada's second window on the note. */
async function secondWindow(actors: Actors, { owner, docId }: Shared, severable = false): Promise<Actor> {
  const bea = await windowFor(actors, owner, { label: 'ada-2', severable });
  await land(bea, `/d/${docId}`);
  return bea;
}

const converged = async (windows: Actor[], docId: string): Promise<boolean> => {
  const texts = await Promise.all(windows.map((actor) => bodyText(actor, docId)));
  return texts.every((text) => text === texts[0]);
};

const OPENING_1 = 'Both windows see this before the blackout';
const LOST_ACK = ' then an edit whose ack went missing';
const OFFLINE_EDIT = ' plus words typed into the void';
const MEANWHILE = ' while the other window kept going';

test('j03-connection: a black-holed socket shows the banner within 14 s while the other window is unaffected, and the offline edits converge byte for byte @p:col-4 @evidence @tierA', async ({ actors, measure }) => {
  const shared = await sharedNote(actors, OPENING_1);
  const { ada, docId } = shared;
  const bea = await secondWindow(actors, shared, true);
  await actors.requireDistinct(2);
  const sever = bea.sever;
  if (!sever) throw new Error('the second window is not severable');
  await waitBodyLive(bea, docId);
  expect(await bodyText(bea, docId)).toBe(OPENING_1);
  for (const actor of [ada, bea]) await expect.soft(indicator(actor, docId), `${actor.label}: the indicator says online`).toHaveAttribute(CONNECTION_ATTR, 'online');
  await bea.observeEditor(docId);

  // An edit lands and its ack is lost in flight: only a later ack can settle it.
  sever.loseAcks();
  await ui.typeBody(bea, docId, LOST_ACK);
  await expect.poll(() => sever.census().acksLost, { message: 'the DocDO acked the edit, and the ack was lost', timeout: ACK_TIMEOUT }).toBeGreaterThan(0);
  await expect(ui.pane(bea, docId), 'the edit is unacked').toHaveAttribute(SYNC_UNACKED_ATTR, '1');

  sever.blackhole();
  await measure.until('banner after a black-hole', bannerShows(bea, docId, 'offline'), { budgetMs: BANNER_BUDGET_MS, timeoutMs: 25_000 });
  await expect(indicator(bea, docId), 'the indicator says offline').toHaveAttribute(CONNECTION_ATTR, 'offline');
  await expect(indicator(bea, docId)).toBeVisible();
  await expect(ui.pane(bea, docId)).toHaveAttribute(DOC_STATE_ATTR, 'offline');
  await expect(indicator(ada, docId), 'the other window is unaffected').toHaveAttribute(CONNECTION_ATTR, 'online');
  await expect(banner(ada, docId), 'the other window shows no banner').toHaveCount(0);

  // Edits keep buffering behind the banner, while the other window keeps landing its own.
  await ui.typeBody(bea, docId, OFFLINE_EDIT);
  await ui.typeBody(ada, docId, MEANWHILE);
  await waitAcked(ada, docId);
  await expect(ui.pane(bea, docId), 'the offline edit waits in the window').toHaveAttribute(SYNC_UNACKED_ATTR, '1');
  await expect(ui.pane(bea, docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '1');
  await actors.checkpoint('black-hole-banner');
  await bea.page.setViewportSize({ width: 390, height: 844 });
  await bea.page.getByRole('button', { name: 'Hide notes panel', exact: true }).click();
  await expect(indicator(bea, docId)).toBeInViewport();
  await expect(banner(bea, docId)).toBeInViewport();
  await actors.checkpoint('black-hole-mobile');
  await bea.page.setViewportSize({ width: 1440, height: 1000 });
  await bea.page.getByRole('button', { name: 'Show notes panel', exact: true }).click();
  // The first socket, its heartbeat reconnect into the black hole, and at most one more before the restore.
  bea.expectReconnects(2, docId);
  sever.restore();

  await expect(banner(bea, docId), 'the banner clears on reconnect').toHaveCount(0, { timeout: RECOVER_TIMEOUT });
  await expect(indicator(bea, docId)).toHaveAttribute(CONNECTION_ATTR, 'online');
  await waitAcked(bea, docId, RECOVER_TIMEOUT);
  await expect.poll(() => converged([ada, bea], docId), { message: 'both windows converge', timeout: RECOVER_TIMEOUT }).toBe(true);
  for (const text of [OPENING_1, LOST_ACK, OFFLINE_EDIT, MEANWHILE]) expect(await bodyText(ada, docId), `the merged body holds "${text}"`).toContain(text);
  await expectNoRemount(bea, docId, 'through the outage');
  expect(ada.telemetry.sockets.filter((s) => s.docId === docId), 'the other window kept its one socket').toHaveLength(1);

  await actors.reloadAll();
  for (const actor of [ada, bea]) await waitBodyLive(actor, docId);
  expect(await converged([ada, bea], docId), 'the server kept every byte').toBe(true);
});

const OPENING_2 = 'Typed before the stack stopped';
const PAUSED_A = ' and Ada kept typing through the stall';
const PAUSED_B = ' and her other window did too';

test('j03-connection: with the stack stopped every window shows the banner within 14 s on its own 4408, before any close frame, and resumes losing nothing @p:col-4', async ({ actors, stack, measure }) => {
  test.setTimeout(180_000);
  const shared = await sharedNote(actors, OPENING_2);
  const { ada, docId } = shared;
  const bea = await secondWindow(actors, shared);
  await actors.requireDistinct(2);
  await waitBodyLive(bea, docId);
  const windows = [ada, bea];
  for (const actor of windows) await expect.soft(indicator(actor, docId), `${actor.label}: the indicator says online`).toHaveAttribute(CONNECTION_ATTR, 'online');
  const held = await Promise.all(
    windows.map(async (actor) => {
      const opened = (await timeline(actor)).filter((e) => e.kind === 'open' && e.url?.includes(docId));
      const url = opened[opened.length - 1]?.url;
      if (!url) throw new Error(`${actor.label}: the recorder saw no doc socket open`);
      return url;
    }),
  );
  // Each window: the stalled socket, then a reconnect that waits on the stopped stack.
  for (const actor of windows) actor.expectReconnects(2, docId);

  await stack.pause();
  try {
    await Promise.all(
      windows.map((actor) =>
        measure.until(`banner on ${actor.label} with the stack stopped`, bannerShows(actor, docId, 'offline'), { budgetMs: BANNER_BUDGET_MS, timeoutMs: 25_000 }),
      ),
    );
    await ui.typeBody(ada, docId, PAUSED_A);
    await ui.typeBody(bea, docId, PAUSED_B);
  } finally {
    await stack.resume();
  }

  for (const actor of windows) {
    await expect(banner(actor, docId), `${actor.label}: the banner clears after resume`).toHaveCount(0, { timeout: RECOVER_TIMEOUT });
    await expect(indicator(actor, docId)).toHaveAttribute(CONNECTION_ATTR, 'online');
    await waitAcked(actor, docId, RECOVER_TIMEOUT);
  }
  await expect.poll(() => converged(windows, docId), { message: 'both windows converge', timeout: RECOVER_TIMEOUT }).toBe(true);
  for (const text of [OPENING_2, PAUSED_A, PAUSED_B]) expect(await bodyText(ada, docId)).toContain(text);

  // The heartbeat, not the server, ended each stalled socket.
  for (const [i, actor] of windows.entries()) {
    const log = (await timeline(actor)).filter((e) => e.url === held[i]);
    const call = log.find((e) => e.kind === 'close-call');
    expect(call?.code, `${actor.label}: the client closed its stalled socket with ${HEARTBEAT_CLOSE}`).toBe(HEARTBEAT_CLOSE);
    expect(log.filter((e) => e.kind === 'close' && e.at < (call?.at ?? Number.POSITIVE_INFINITY)), `${actor.label}: no close frame arrived before the ${HEARTBEAT_CLOSE}`).toEqual([]);
  }
});

const OPENING_3 = 'A quiet note left alone';

test('j03-connection: a healthy socket idle for 20 s shows no banner and opens no second socket @p:col-4', async ({ actors }) => {
  const shared = await sharedNote(actors, OPENING_3);
  const { ada, docId } = shared;
  const bea = await secondWindow(actors, shared);
  await actors.requireDistinct(2);
  await waitBodyLive(bea, docId);
  const windows = [ada, bea];
  for (const actor of windows) await expect(indicator(actor, docId)).toHaveAttribute(CONNECTION_ATTR, 'online');
  const marks = await Promise.all(windows.map(async (actor) => (await timeline(actor)).length));
  for (const actor of windows) {
    // The recorder's positive control: it saw this window's socket open and its indicator reach online.
    const before = await timeline(actor);
    expect(before.some((e) => e.kind === 'open'), `${actor.label}: the recorder sees socket opens`).toBe(true);
    expect(before.some((e) => e.kind === 'connection' && e.value === 'online'), `${actor.label}: the recorder sees the indicator`).toBe(true);
  }

  await ada.page.waitForTimeout(20_000);

  for (const [i, actor] of windows.entries()) {
    const since = (await timeline(actor)).slice(marks[i]);
    expect(since.filter((e) => e.kind === 'connection' || e.kind === 'banner'), `${actor.label}: the indicator stayed online and no banner showed`).toEqual([]);
    expect(since.filter((e) => e.kind !== 'connection' && e.kind !== 'banner'), `${actor.label}: no socket closed or opened`).toEqual([]);
    expect(socketsFor(actor, docId).map((s) => s.closedAt), `${actor.label}: one doc socket, still open`).toEqual([null]);
    await expect(indicator(actor, docId)).toHaveAttribute(CONNECTION_ATTR, 'online');
  }
});

const OPENING_4 = 'Waiting on a slow first sync';
const FIRST_SYNC_HOLD_MS = 10_000;

test('j03-connection: a first sync held back 10 s shows retrying and still connecting, then binds in place with no remount @p:R10', async ({ actors }) => {
  const shared = await sharedNote(actors, OPENING_4);
  const { docId } = shared;
  const bea = await windowFor(actors, shared.owner, { label: 'ada-2', severable: true });
  await actors.requireDistinct(2);
  const sever = bea.sever;
  if (!sever) throw new Error('the second window is not severable');
  sever.blackhole();
  await land(bea, `/d/${docId}`);
  await expect.poll(() => socketsFor(bea, docId).length, { message: 'the doc socket opens into the hold', timeout: BIND_TIMEOUT }).toBe(1);
  const openedAt = socketsFor(bea, docId)[0].openedAt;

  await expect(ui.pane(bea, docId), 'the pane says its first sync is late').toHaveAttribute(DOC_STATE_ATTR, 'retrying', { timeout: FIRST_SYNC_HOLD_MS });
  await expect(banner(bea, docId)).toHaveAttribute(CONNECTION_BANNER_ATTR, 'retrying');
  await expect(banner(bea, docId), 'the banner says it is still connecting').toContainText(/still connecting/i);
  await expect(ui.body(bea, docId), 'the body stays closed until it binds').toHaveAttribute(BODY_BINDING_ATTR, 'unbound');
  await bea.observeEditor(docId);
  await actors.checkpoint('retrying');

  await bea.page.waitForTimeout(Math.max(0, openedAt + FIRST_SYNC_HOLD_MS - Date.now()));
  sever.restore();
  await waitBodyLive(bea, docId, RECOVER_TIMEOUT);
  await expect(banner(bea, docId), 'the banner clears').toHaveCount(0);
  expect(await bodyText(bea, docId), 'the doc arrives in place').toBe(OPENING_4);
  await expectNoRemount(bea, docId, 'from retrying to live');
  expect(socketsFor(bea, docId), 'the same socket recovered').toHaveLength(1);
});

const OPENING_5 = 'Fifty clients already hold this note';

test('j03-connection: a 51st connection goes terminal conn-limit with a Retry that binds once a slot frees @p:tech-8 @evidence', async ({ actors, stack }) => {
  const shared = await sharedNote(actors, OPENING_5);
  const { docId } = shared;
  // Ada's window holds one connection; 49 protocol-level sockets fill the doc to its 50.
  const held = await holdDocSockets(stack.baseUrl, docId, cookieHeader(await signIn(stack.baseUrl, shared.owner)), 49);
  try {
    const bea = await secondWindow(actors, shared);
    await actors.requireDistinct(2);
    await expect(ui.pane(bea, docId), 'the 51st connection is terminal').toHaveAttribute(TERMINAL_REASON_ATTR, 'conn-limit', { timeout: BIND_TIMEOUT });
    await expect(ui.pane(bea, docId)).toHaveAttribute(DOC_STATE_ATTR, 'terminal');
    await expect(banner(bea, docId)).toHaveAttribute(CONNECTION_BANNER_ATTR, 'conn-limit');
    const retry = banner(bea, docId).getByRole('button', { name: 'Retry', exact: true });
    await expect(retry, 'the banner offers a retry').toBeVisible();
    const closes = (await timeline(bea)).filter((e) => e.kind === 'close');
    expect(closes.map((e) => e.code), 'the DocDO closed the socket 4429').toEqual([CONN_LIMIT_CLOSE]);
    await bea.observeEditor(docId);
    await bea.page.waitForTimeout(3_000);
    expect(socketsFor(bea, docId), 'a terminal close is never retried on its own').toHaveLength(1);
    await actors.checkpoint('conn-limit');

    await held.close();
    expect(held.open()).toBe(0);
    // The refused socket, then the one Retry opens.
    bea.expectReconnects(1, docId);
    await retry.click();
    await waitBodyLive(bea, docId);
    await expect(ui.pane(bea, docId), 'the terminal reason clears').not.toHaveAttribute(TERMINAL_REASON_ATTR, /./);
    await expect(banner(bea, docId)).toHaveCount(0);
    expect(await bodyText(bea, docId), 'the note arrives in place').toBe(OPENING_5);
    await expectNoRemount(bea, docId, 'from conn-limit to live');
  } finally {
    await held.close();
  }
});


test('j03-connection: a refused write rebinds fresh and a deleted doc locks in place @p:col-4', async ({ actors }) => {
  const shared = await sharedNote(actors, 'The server keeps this sentence');
  const { docId } = shared;
  const bea = await secondWindow(actors, shared, true);
  await actors.requireDistinct(2);
  await waitBodyLive(bea, docId);
  await bea.observeEditor(docId);
  const sever = bea.sever;
  if (!sever) throw new Error('missing sever');
  sever.blackhole();
  // Intentionally rejected text is not registered as a durability promise.
  const body = ui.body(bea, docId);
  await body.click();
  await body.press('End');
  await body.pressSequentially(' rejected change');
  await expect(body).toContainText('rejected change');
  bea.expectReconnects(1, docId);
  sever.reset(4409);
  sever.restore();
  await expect.poll(() => bodyText(bea, docId), { timeout: RECOVER_TIMEOUT }).toBe('The server keeps this sentence');
  await waitBodyLive(bea, docId);
  await expectNoRemount(bea, docId, 'refusal replaces the binding, not the editor');
  await ui.typeBody(bea, docId, ' and writing works again');
  await waitAcked(bea, docId);
  await expect.poll(() => bodyText(shared.ada, docId)).toBe('The server keeps this sentence and writing works again');
  sever.reset(4410);
  await expect(ui.pane(bea, docId)).toHaveAttribute(TERMINAL_REASON_ATTR, 'deleted');
  await expect(body).toHaveAttribute(BODY_BINDING_ATTR, 'terminal');
  await expect(body).toHaveAttribute('contenteditable', 'false');
  await expect(banner(bea, docId)).toHaveAttribute(CONNECTION_BANNER_ATTR, 'deleted');
  await expectNoRemount(bea, docId, 'terminal state keeps the content in place');
});


test('j03-connection: failed sign-out preserves offline edits and cancelling unsynced sign-out keeps the session @p:col-4', async ({ actors }) => {
  const shared = await sharedNote(actors, 'Sign-out must preserve this note');
  const { ada, docId } = shared;
  const bea = await secondWindow(actors, shared, true);
  await actors.requireDistinct(2);
  await waitBodyLive(bea, docId);
  await bea.observeEditor(docId);
  // Load Settings while connected, then return to the editor.
  await ui.openSettings(bea);
  await bea.page.keyboard.press('Escape');
  const sever = bea.sever!;
  sever.blackhole();
  await ui.typeBody(bea, docId, ' buffered through a failed sign-out');
  await expect(ui.pane(bea, docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '1');
  let requests = 0;
  bea.expectHttp(409, '/api/auth/sign-out');
  await bea.page.route('**/api/auth/sign-out', async route => {
    requests += 1;
    await route.fulfill({ status: 409, contentType: 'application/json', body: '{}' });
  });
  await ui.signOutThroughSettings(bea);
  const confirmation = bea.page.getByRole('alertdialog');
  await expect(confirmation).toBeVisible({ timeout: 8000 });
  expect(requests).toBe(0);
  await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await bea.page.keyboard.press('Escape');
  await expect(ui.body(bea, docId)).toHaveAttribute('contenteditable', 'true');
  await ui.signOutThroughSettings(bea);
  await expect(confirmation).toBeVisible({ timeout: 8000 });
  await confirmation.getByRole('button', { name: 'Sign out anyway', exact: true }).click();
  await expect(bea.page.getByRole('alert')).toContainText('Couldn’t sign you out');
  expect(requests).toBe(1);
  await bea.page.keyboard.press('Escape');
  await expect(ui.pane(bea, docId)).not.toHaveAttribute(TERMINAL_REASON_ATTR, /./);
  await expect(ui.body(bea, docId)).toHaveAttribute('contenteditable', 'true');
  bea.expectReconnects(2, docId);
  sever.restore();
  await waitAcked(bea, docId, RECOVER_TIMEOUT);
  await expect.poll(() => bodyText(ada, docId)).toBe('Sign-out must preserve this note buffered through a failed sign-out');
  await expectNoRemount(bea, docId, 'failed sign-out');
});

test('j03-connection: a real Settings chunk load failure preserves the shell and offline edits @p:R10', async ({ actors }) => {
  const shared = await sharedNote(actors, 'A failed import leaves the editor here');
  const { ada, docId } = shared;
  const bea = await secondWindow(actors, shared, true);
  await actors.requireDistinct(2);
  await waitBodyLive(bea, docId);
  await bea.observeEditor(docId);
  let failures = 0;
  bea.expectHttp(404, /\/assets\/SettingsModal-.*\.js$/);
  await bea.page.route('**/assets/SettingsModal-*.js', async route => {
    failures += 1;
    await route.fulfill({ status: 404, contentType: 'text/javascript', body: '' });
  });
  bea.sever!.blackhole();
  await ui.typeBody(bea, docId, ' with an unsynced addition');
  await bea.page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect.poll(() => failures).toBeGreaterThan(0);
  await expect(bea.page.locator('[data-input-refusal]')).toContainText('could not load');
  await expect(bea.page.locator('[data-moss-app-shell]')).toBeVisible();
  await expect(ui.pane(bea, docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '1');
  await ui.typeBody(bea, docId, ' and more after the failure');
  bea.expectReconnects(2, docId);
  bea.sever!.restore();
  await waitAcked(bea, docId, RECOVER_TIMEOUT);
  await expect.poll(() => bodyText(ada, docId)).toBe('A failed import leaves the editor here with an unsynced addition and more after the failure');
  await expectNoRemount(bea, docId, 'a failed lazy import');
});

test('j03-connection: the online indicator is sanctioned chrome with a visible mobile dot @p:col-4', async ({ actors }) => {
  const { ada, docId } = await sharedNote(actors, 'An online dot');
  await actors.requireDistinct(2);
  await expect(indicator(ada, docId)).toHaveAttribute('data-collab-chrome', '');
  await ada.page.setViewportSize({ width: 390, height: 844 });
  const color = await indicator(ada, docId).locator('[aria-hidden]').evaluate(el => getComputedStyle(el).backgroundColor);
  expect(color).not.toBe('rgba(0, 0, 0, 0)');
});
