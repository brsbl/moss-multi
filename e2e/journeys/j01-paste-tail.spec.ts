// j01-paste-tail (T3.B4, T3.B32): near one of the note's limits (here the structure guard, A§5.1) the DocDO admits
// each frame of a large paste on its own. A paste that fit when it was checked is cut short when another writer fills
// the room while its later frames are still on the way. Ada's tab then rolls the paste back: it stops sending it, binds
// the server's copy and deletes the part that landed before the note shows again, and says "The paste didn't fit, so
// nothing was pasted." She and Ben converge on the note as it was before the paste plus Ben's lines, the line her
// paste replaced included (the paste's deletes go only once all of it has landed), nothing of the paste shows at any
// settled point, and an undo cannot bring it back. Ben also has the note open in a browser: his editor shows the part
// that landed, then follows the rollback's whole-block deletes with no page error, until it shows what the server
// exports. A rollback cut off by the tab closing resumes when the note is opened again in the same browser profile.
// Ben's writes come from a protocol-level client (doc-client.ts); Ada's doc socket runs through a sever proxy that
// holds the rest of her paste.
//
// The note is created through POST /api/docs as declared setup.
import * as Y from 'yjs';
import { STRUCT_CAP } from '../../packages/protocol/src/limits.ts';
import type { Actor, Actors } from '../lib/actors.ts';
import { DOC_STATE_ATTR, INPUT_REFUSAL_ATTR, paneSelector } from '../lib/contract.ts';
import { cookieHeader, openDocClient, type DocClient } from '../lib/doc-client.ts';
import { grantDoc } from '../lib/grants.ts';
import { exported, fingerprint, importNote, PASTE_ROLLED_BACK_NOTICE, pastePlain, UNDO } from '../lib/paste.ts';
import { signIn } from '../lib/principals.ts';
import type { Stack } from '../lib/stack.ts';
import { expect, test, ui } from '../lib/test.ts';

/** 20,000 short paragraphs, about 100,000 structs and 3 MB of state: past the 1.5 MB an outbox sends unacked, so a part of it waits for acks. */
const A = Array.from({ length: 20_000 }, (_, i) => `Alpha ${i}.`).join('\n\n');
const ROLLBACK_KEY = 'moss-multi:paste-rollback:';

const count = (text: string, word: string) => text.split(`${word} `).length - 1;
const stateBytes = (client: DocClient) => Y.encodeStateAsUpdate(client.doc).byteLength;
/** The note's structs, as Ben's copy holds them: the DocDO's count for a note with no payloads. */
const structs = (client: DocClient) => [...client.doc.store.clients.values()].reduce((sum, list) => sum + list.length, 0);

/** fingerprint()'s length and hash, of Ben's text. */
function print(text: string): { length: number; sum: number } {
  let sum = 0;
  for (let i = 0; i < text.length; i += 1) sum = (sum * 31 + text.charCodeAt(i)) >>> 0;
  return { length: text.length, sum };
}

/** The structs the latest paste's admission measured it adds (`moss-paste-admission`). */
const lastAdds = (actor: Actor) => actor.page.evaluate(() => {
  const marks = performance.getEntriesByName('moss-paste-admission');
  return ((marks.at(-1) as PerformanceMark | undefined)?.detail as { structs: number } | undefined)?.structs ?? 0;
});

/** Ben appends short paragraphs, each batch acked and well under the frame cap, until the note's structs reach `target`; returns how many. */
async function fillTo(ben: DocClient, target: number, label: string): Promise<number> {
  let perParagraph = 5;
  let n = 0;
  for (let count = structs(ben); count < target; ) {
    const batch = Math.max(1, Math.min(1_000, Math.floor(((target - count) / perParagraph) * 0.9)));
    ben.paragraphs(Array.from({ length: batch }, () => `${label} ${n++}`));
    await ben.acked();
    const after = structs(ben);
    perParagraph = Math.max(1, (after - count) / batch);
    count = after;
  }
  return n;
}

/**
 * Watches Ada's pane from the moment the cut is announced and her pane leaves `live`: whenever it is live again, its
 * body must hold nothing of the paste.
 */
async function watchSettled(ada: Actor, docId: string): Promise<void> {
  await ada.page.evaluate(({ pane, stateAttr, refusalAttr, notice }) => {
    const watch = { armed: false, noticed: false, leaked: '' };
    (window as unknown as { __pasteWatch: typeof watch }).__pasteWatch = watch;
    const check = () => {
      if (document.querySelector(`[${refusalAttr}]`)?.textContent?.includes(notice)) watch.noticed = true;
      const element = document.querySelector(pane);
      const live = element?.getAttribute(stateAttr) === 'live';
      if (watch.noticed && !live) watch.armed = true;
      if (watch.armed && live && !watch.leaked) {
        const text = element?.querySelector('[data-body-binding]')?.textContent ?? '';
        const at = text.indexOf('Alpha ');
        if (at >= 0) watch.leaked = text.slice(at, at + 40);
      }
    };
    new MutationObserver(check).observe(document.body, { subtree: true, attributes: true, attributeFilter: [stateAttr, refusalAttr], childList: true });
    setInterval(check, 250);
  }, { pane: paneSelector(docId), stateAttr: DOC_STATE_ATTR, refusalAttr: INPUT_REFUSAL_ATTR, notice: PASTE_ROLLED_BACK_NOTICE });
}

/** What of the paste the watch saw (after a reload no watch runs: the pane binds only once its rollback is applied). */
const leaked = (ada: Actor) => ada.page.evaluate(() => (window as unknown as { __pasteWatch?: { leaked: string } }).__pasteWatch?.leaked ?? '');
/** A page's rendered note, one entry per top-level block with text; null while the page is too busy to answer. */
const rendered = (actor: Actor, docId: string) => ui.body(actor, docId)
  .evaluate((element) => [...element.children].map((block) => block.textContent ?? '').filter(Boolean), undefined, { timeout: 10_000 })
  .catch((error: Error) => {
    if (error.name === 'TimeoutError') return null;
    throw error;
  });
/** The export's blocks, as `rendered` reads a note of plain lines. */
const blocks = (markdown: string) => markdown.split(/\n{2,}/).map((line) => line.trim()).filter(Boolean);
const storedRollbacks = (ada: Actor) => ada.page.evaluate((prefix) => Object.keys(localStorage).filter((key) => key.startsWith(prefix)).length, ROLLBACK_KEY);

interface Cut {
  ada: Actor;
  ben: DocClient;
  /** Ben's browser page on the note, when the leg opens one. */
  peer: Actor | null;
  docId: string;
  /** The server's export before the paste. */
  before: string;
  /** Ben's lines written while the paste was on its way. */
  bravos: number;
}

/**
 * Ada opens a note 110,000 structs under the guard and pastes A with her acks lost: a part goes out and lands, then
 * her socket goes dark with the rest to send. Ben fills the room, and her socket comes back: the rest is refused.
 * With `select`, her paste replaces the line 'Kept.'; otherwise it goes at the end of it. With `peer`, Ben also has
 * the note open in a browser page while it happens.
 */
async function cutPaste(actors: Actors, stack: Stack, select: boolean, before?: (ada: Actor, docId: string) => void, peer = false): Promise<Cut> {
  const ada = await actors.session(await actors.principal('ada'), { severable: true });
  const docId = await importNote(ada, stack, 'Paste target', 'Kept.');
  const principal = await actors.principal('ben');
  await grantDoc(ada, docId, principal);
  const ben = await openDocClient(stack.baseUrl, docId, cookieHeader(await signIn(stack.baseUrl, principal)));
  // Acks lost or black-holed, Ada's socket reads as stalled or silent and reconnects; the refusal closes it (4409) and
  // her pane binds again.
  ada.expectReconnects(16, docId);
  await ben.synced;
  await fillTo(ben, STRUCT_CAP - 110_000, 'Filler');
  await ada.goto(`/d/${docId}`);
  await ui.waitBodyLive(ada, docId, 180_000);
  const exportBefore = await exported(ada, docId);
  let page: Actor | null = null;
  if (peer) {
    page = await actors.open(principal, { label: 'ben-page', path: `/d/${docId}` });
    // A page applying a large paste can read its socket as silent and reconnect.
    page.expectReconnects(2, docId);
    await ui.waitBodyLive(page, docId, 180_000);
  }
  await ui.body(ada, docId).locator('p').filter({ hasText: /^Kept\.$/ }).click();
  await ada.page.keyboard.press('End');
  if (select) {
    await ada.page.keyboard.press('Shift+Home');
    expect(await ada.page.evaluate(() => window.getSelection()?.toString()), 'the line the paste replaces').toBe('Kept.');
  }

  const bytes = stateBytes(ben);
  const beforeStructs = structs(ben);
  ada.sever!.loseAcks();
  await pastePlain(ada, docId, A);
  await expect.poll(() => stateBytes(ben) - bytes, { message: 'part of the paste lands', timeout: 180_000 }).toBeGreaterThan(500_000);
  ada.sever!.blackhole();
  // Frames that crossed before the blackhole may still be queued at the DocDO (off loopback each takes seconds): what
  // is still to come is measured once Ben's copy has stopped growing.
  for (let seen = -1, until = Date.now() + 120_000; structs(ben) !== seen && Date.now() < until; ) {
    seen = structs(ben);
    await ada.page.waitForTimeout(3_000);
  }
  const rest = (await lastAdds(ada)) - (structs(ben) - beforeStructs);
  expect(rest, 'part of the paste is still to come').toBeGreaterThan(10_000);
  expect(count(ben.text(), 'Alpha'), 'Ben sees the part that landed').toBeGreaterThan(0);
  if (page) {
    const shown = page;
    await expect.poll(async () => (await rendered(shown, docId))?.filter((line) => line.startsWith('Alpha ')).length ?? 0, {
      message: "Ben's open note shows the part that landed", timeout: 180_000,
    }).toBeGreaterThan(0);
  }

  // Ben fills the room: his writes fit beside what landed, the rest of the paste no longer does.
  const bravos = await fillTo(ben, STRUCT_CAP - Math.floor(rest / 2), 'Bravo');
  await watchSettled(ada, docId);
  before?.(ada, docId);
  ada.sever!.restore();
  await expect(ada.page.locator(`[${INPUT_REFUSAL_ATTR}]`), 'the cut is announced').toContainText(PASTE_ROLLED_BACK_NOTICE, { timeout: 240_000 });
  return { ada, ben, peer: page, docId, before: exportBefore, bravos };
}

/** Ada and Ben hold the same note: the one before the paste with Ben's lines after it, nothing of the paste. */
async function expectRolledBack({ ada, ben, docId, before, bravos }: Cut): Promise<string> {
  await expect.poll(() => count(ben.text(), 'Alpha'), { message: 'nothing of the paste stays on the server', timeout: 240_000 }).toBe(0);
  await expect.poll(async () => JSON.stringify(await fingerprint(ada, docId)) === JSON.stringify(print(ben.text())), {
    message: 'Ada and Ben converge', timeout: 240_000,
  }).toBe(true);
  const server = await exported(ada, docId);
  expect(count(server, 'Alpha'), 'the part that landed is gone').toBe(0);
  const head = before.trimEnd();
  expect(server.startsWith(head), 'the note as it was before the paste').toBe(true);
  const tail = server.slice(head.length).split('\n').filter(Boolean);
  expect(tail.every((line) => /^Bravo \d+$/.test(line)), "then Ben's lines, and nothing else").toBe(true);
  expect(tail, "every one of Ben's lines").toHaveLength(bravos);
  expect(await leaked(ada), 'nothing of the paste showed once the cut was announced').toBe('');
  return server;
}

/** Ben's open editor followed the rollback: it shows what the server exports, nothing of the paste, and no page error. */
async function expectPeerFollows({ ben, peer, docId }: Cut, server: string): Promise<void> {
  if (!peer) throw new Error('this leg has no peer page');
  const expected = JSON.stringify(blocks(server));
  await expect.poll(async () => JSON.stringify(await rendered(peer, docId)) === expected, {
    message: "Ben's open note equals the server's export", timeout: 240_000,
  }).toBe(true);
  await expect.poll(async () => JSON.stringify(await fingerprint(peer, docId)) === JSON.stringify(print(ben.text())), {
    message: "Ben's editor holds what his doc holds", timeout: 60_000,
  }).toBe(true);
  expect(peer.telemetry.pageErrors.map((error) => error.message), "no page error on Ben's page").toEqual([]);
}

test('j01-paste-tail: a paste that replaced a line, cut short near the cap by another writer, is rolled back, says so, both peers converge on the note as it was, that line included, the other writer\'s open editor too, and an undo cannot bring it back @p:col-1', async ({ actors, stack }) => {
  test.setTimeout(900_000);
  let ben: DocClient | null = null;
  try {
    const cut = await cutPaste(actors, stack, true, undefined, true);
    ben = cut.ben;
    const { ada, docId } = cut;
    await ui.waitBodyLive(ada, docId, 180_000);
    const server = await expectRolledBack(cut);
    await expectPeerFollows(cut, server);
    await expect.poll(() => storedRollbacks(ada), { message: 'the acked rollback leaves nothing stored', timeout: 60_000 }).toBe(0);

    // The rollback is no undo step and the binding started a fresh history: an undo brings nothing back.
    const settled = await fingerprint(ada, docId);
    await ui.body(ada, docId).locator('p').filter({ hasText: /^Kept\./ }).click();
    await ada.page.keyboard.press(UNDO);
    await ada.page.waitForTimeout(3_000);
    expect(await fingerprint(ada, docId), 'an undo changes nothing').toEqual(settled);
    expect(await exported(ada, docId), 'nor the server').toBe(server);
  } finally {
    ben?.close();
  }
});

test('j01-paste-tail: a rollback cut off by the tab closing resumes when the note is opened again in the same profile @p:col-1', async ({ actors, stack }) => {
  test.setTimeout(900_000);
  let ben: DocClient | null = null;
  try {
    // Ada's writes after the refusal never reach the DocDO: her tab rolls the paste back, and its deletes wait.
    const cut = await cutPaste(actors, stack, false, (ada, docId) => ada.sever!.holdWritesAfterRefusal(docId), true);
    ben = cut.ben;
    const { ada, docId } = cut;
    await ui.waitBodyLive(ada, docId, 180_000);
    await expect.poll(async () => (await fingerprint(ada, docId))?.length ?? -1, { message: 'her tab no longer shows the paste', timeout: 60_000 })
      .toBeLessThan(print(ben.text()).length);
    expect(await leaked(ada), 'nothing of the paste showed').toBe('');
    expect(await storedRollbacks(ada), 'the rollback is kept until acked').toBe(1);
    await ada.page.waitForTimeout(3_000);
    expect(count(ben.text(), 'Alpha'), 'the deletes have not landed').toBeGreaterThan(0);

    // The tab closes with the deletes unsent; the note opened again in the same profile finishes the rollback.
    ada.sever!.dropHeld();
    ada.page.once('dialog', (dialog) => void dialog.accept());
    await ada.page.reload();
    await ui.waitBodyLive(ada, docId, 180_000);
    const shown = await ui.body(ada, docId).evaluate((element) => element.textContent ?? '');
    expect(count(shown, 'Alpha'), 'the reopened note never shows the paste').toBe(0);
    await expectPeerFollows(cut, await expectRolledBack(cut));
    await expect.poll(() => storedRollbacks(ada), { message: 'acked: nothing stored', timeout: 60_000 }).toBe(0);
  } finally {
    ben?.close();
  }
});
