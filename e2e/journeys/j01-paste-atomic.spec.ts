// j01-paste-atomic (T3.B4, B209): a large paste is wholly committed or wholly refused beside other writers. Its
// reserve holds room at the DocDO for all of it before any of it lands; the reservation belongs to the paste, so it
// outlives the socket that made it and the DocDO instance that took it, and a reserve refused beside it closes
// nothing. Ben is a protocol-level client (doc-client.ts) holding room with a reserve of his own, a writer Ada's
// preflight cannot see. Ada's doc socket runs through a sever proxy that loses her acks, so her paste's frames go out
// a part at a time, and can black-hole her socket while she reconnects.
//
// The note is created through POST /api/docs as declared setup.
import type { LexicalEditor } from 'lexical';
import * as Y from 'yjs';
import { STATE_CAP_BYTES } from '../../packages/protocol/src/limits.ts';
import type { ServerEvent } from '../../packages/protocol/src/sync.ts';
import type { Actor, Actors } from '../lib/actors.ts';
import { INPUT_REFUSAL_ATTR } from '../lib/contract.ts';
import { cookieHeader, openDocClient, type DocClient } from '../lib/doc-client.ts';
import { grantDoc } from '../lib/grants.ts';
import { exported, importNote, normalized, pastePlain } from '../lib/paste.ts';
import { signIn } from '../lib/principals.ts';
import type { Stack } from '../lib/stack.ts';
import { expect, test, ui } from '../lib/test.ts';

/** About 3 MB of state: past the 1.5 MB an outbox sends unacked, so a part of it waits for acks. */
const A = Array.from({ length: 2_000 }, (_, i) => `Alpha ${i} ${'a'.repeat(990)}.`).join('\n\n');
/** About 1 MB of state. */
const B = Array.from({ length: 700 }, (_, i) => `Bravo ${i} ${'b'.repeat(990)}.`).join('\n\n');
/** A paste's reserve holds this much more than its measured bytes (doc-session.ts RESERVE_SLACK). */
const SLACK = 1.03;

const count = (text: string, word: string) => text.split(`${word} `).length - 1;
const stateBytes = (client: DocClient) => Y.encodeStateAsUpdate(client.doc).byteLength;

/** The body text Ada's editor holds includes `text`. */
const holds = (actor: Actor, docId: string, text: string) => ui.body(actor, docId).evaluate((element, wanted) => {
  const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
  return editor.getEditorState().read(() => editor.getEditorState()._nodeMap.get('root')!.getTextContent().includes(wanted));
}, text).catch(() => false);

/** The body text Ada's editor holds, its paragraphs a blank line apart. */
const rootText = (actor: Actor, docId: string) => ui.body(actor, docId).evaluate((element) => {
  const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
  return editor.getEditorState().read(() => editor.getEditorState()._nodeMap.get('root')!.getTextContent());
}).catch(() => null);

/** What the latest paste's admission measured it adds (`moss-paste-admission`). */
const lastAdds = (actor: Actor) => actor.page.evaluate(() => {
  const marks = performance.getEntriesByName('moss-paste-admission');
  return ((marks.at(-1) as PerformanceMark | undefined)?.detail as { adds: number } | undefined)?.adds ?? 0;
});

/**
 * Ben reserves `b` bytes as paste `p` and returns the DocDO's answer, or null when none came in `ms`. Sent again every
 * 2 s until answered: a socket that a reset is still closing loses it, and a reserve sent again is answered the same.
 */
async function reserve(ben: DocClient, p: string, b: number, ms = 20_000): Promise<string | null> {
  const deadline = Date.now() + ms;
  for (let sent = 0; ; ) {
    const found = ben.events.find((event) => (event as { p?: unknown }).p === p) as (ServerEvent & { t: string }) | undefined;
    if (found || Date.now() > deadline) return found?.t ?? null;
    if (Date.now() - sent >= 2_000) {
      ben.custom({ t: 'reserve', p, b });
      sent = Date.now();
    }
    await new Promise((done) => setTimeout(done, 200));
  }
}

async function open(actors: Actors, stack: Stack) {
  const ada = await actors.session(await actors.principal('ada'), { severable: true });
  const docId = await importNote(ada, stack, 'Paste target', 'Kept.');
  const principal = await actors.principal('ben');
  await grantDoc(ada, docId, principal);
  await ada.goto(`/d/${docId}`);
  await ui.waitLive(ada, docId);
  await ada.observeEditor(docId);
  const ben = await openDocClient(stack.baseUrl, docId, cookieHeader(await signIn(stack.baseUrl, principal)));
  await ben.synced;
  await ui.body(ada, docId).locator('p').filter({ hasText: /^Kept\.$/ }).click();
  await ada.page.keyboard.press('End');
  return { ada, ben, docId };
}

/** Ada pastes A with her acks lost: the part the outbox may send unacked goes out, the rest waits. */
async function pasteHeld(ada: Actor, docId: string): Promise<number> {
  ada.sever!.loseAcks();
  await pastePlain(ada, docId, A);
  await expect.poll(() => holds(ada, docId, 'Alpha 1999 '), { message: 'A lands in Ada\'s editor', timeout: 180_000 }).toBe(true);
  return Math.ceil((await lastAdds(ada)) * SLACK);
}

/** Every line of A on the server and in Ada's editor, none of B, and the note still takes typing. */
async function expectWhole(ada: Actor, docId: string): Promise<void> {
  await ui.waitAcked(ada, docId, 240_000);
  const text = await exported(ada, docId);
  expect(count(text, 'Alpha'), 'every line of the paste reached the server').toBe(2_000);
  expect(count(text, 'Bravo'), 'nothing of a refused paste did').toBe(0);
  expect(await holds(ada, docId, 'Bravo 0 '), 'nor Ada\'s editor').toBe(false);
  await ui.typeBody(ada, docId, ' Still typing.');
  await ui.waitAcked(ada, docId, 60_000);
  await expect.poll(async () => (await exported(ada, docId)).includes('Still typing.'), { message: 'the note stays editable', timeout: 60_000 }).toBe(true);
}

test('j01-paste-atomic: a paste refused at its reserve beside another writer’s room closes nothing, and the earlier paste still landing lands whole @p:col-1', async ({ actors, stack }) => {
  test.setTimeout(480_000);
  const { ada, ben, docId } = await open(actors, stack);
  // Each stall at the outbox's budget reconnects and replays (STUCK_MS) while the acks are lost.
  ada.expectReconnects(6, docId);
  try {
    const before = stateBytes(ben);
    const reserved = await pasteHeld(ada, docId);
    // Ben holds room that fits beside all of A, but not beside A and B; Ada's preflight cannot see it.
    const bens = await reserve(ben, 'ben-room', STATE_CAP_BYTES - before - reserved - 200_000);
    await pastePlain(ada, docId, B);
    await expect(ada.page.locator(`[${INPUT_REFUSAL_ATTR}]`), 'B is refused, visibly').toContainText('size limit', { timeout: 120_000 });
    ada.sever!.restore();
    await expectWhole(ada, docId);
    expect(bens, 'Ben\'s room was held').toBe('reserved');
  } finally {
    ben.close();
  }
});

test('j01-paste-atomic: typing right after a paste whose reserve is refused is kept, and the pane stays bound @p:col-1', async ({ actors, stack }) => {
  test.setTimeout(300_000);
  const { ada, ben, docId } = await open(actors, stack);
  try {
    // Ben holds all the room but 300 KB; B (about 1 MB) does not fit beside it, and Ada's preflight cannot see it.
    expect(await reserve(ben, 'ben-room', STATE_CAP_BYTES - stateBytes(ben) - 300_000), 'Ben\'s room is held').toBe('reserved');
    // Ada types at once: her keys arrive while the paste is still checked, or while its reserve is unanswered.
    await pastePlain(ada, docId, B);
    await ada.page.keyboard.type(' ZQX');
    ada.typed({ docId, field: 'body', text: ' ZQX', ordered: true });
    await expect(ada.page.locator(`[${INPUT_REFUSAL_ATTR}]`), 'B is refused, visibly').toContainText('size limit', { timeout: 120_000 });
    await expect.poll(() => holds(ada, docId, 'Kept. ZQX'), { message: 'the typing stays in Ada\'s editor, where she typed it', timeout: 60_000 }).toBe(true);
    await ui.waitAcked(ada, docId, 60_000);
    const want = await normalized(ada, stack, 'Kept. ZQX');
    await expect.poll(() => exported(ada, docId), { message: 'and reaches the server, without any of B', timeout: 60_000 }).toBe(want);
    expect(await holds(ada, docId, 'Bravo 0 '), 'nothing of B is in Ada\'s editor').toBe(false);
    await ui.typeBody(ada, docId, ' Still typing.');
    await ui.waitAcked(ada, docId, 60_000);
    await expect.poll(async () => (await exported(ada, docId)).includes('Kept. ZQX Still typing.'), { message: 'the note stays editable', timeout: 60_000 }).toBe(true);
  } finally {
    ben.close();
  }
});

test('j01-paste-atomic: a keyboard paste made while a paste waits for its reserve\'s answer lands after it @p:col-1', async ({ actors, stack }) => {
  test.setTimeout(300_000);
  const { ada, ben, docId } = await open(actors, stack);
  ada.expectReconnects(1, docId);
  try {
    // A real copy, so the second paste is the browser's own, from the keyboard.
    await ada.page.evaluate(() => {
      const area = document.createElement('textarea');
      area.id = 'j01-clipboard';
      area.value = ' ZQX';
      document.body.append(area);
      area.select();
    });
    await ada.page.keyboard.press('ControlOrMeta+C');
    await ada.page.evaluate(() => document.getElementById('j01-clipboard')?.remove());
    await ui.body(ada, docId).locator('p').filter({ hasText: /^Kept\.$/ }).click();
    await ada.page.keyboard.press('End');
    // The black hole leaves B's reserve unanswered: the paste waits for it, then gives up after 4 s.
    ada.sever!.blackhole();
    await pastePlain(ada, docId, B);
    await ada.page.keyboard.press('ControlOrMeta+V');
    await expect(ada.page.locator(`[${INPUT_REFUSAL_ATTR}]`), 'B is refused, visibly').toContainText('could not confirm room', { timeout: 60_000 });
    ada.sever!.restore();
    await expect.poll(() => holds(ada, docId, 'Kept. ZQX'), { message: 'the keyboard paste lands where Ada made it', timeout: 60_000 }).toBe(true);
    await ui.waitAcked(ada, docId, 120_000);
    const want = await normalized(ada, stack, 'Kept. ZQX');
    await expect.poll(() => exported(ada, docId), { message: 'and reaches the server, without any of B', timeout: 60_000 }).toBe(want);
  } finally {
    ben.close();
  }
});

test('j01-paste-atomic: Enter and Shift+Enter pressed while a paste waits for its reserve\'s answer land in order @p:col-1', async ({ actors, stack }) => {
  test.setTimeout(300_000);
  const { ada, ben, docId } = await open(actors, stack);
  ada.expectReconnects(1, docId);
  try {
    // The black hole leaves B's reserve unanswered: the keys wait for it, and are replayed once the paste gives up.
    // WebKit's Lexical leaves Enter to the native beforeinput, which a held (cancelled) keydown never gets.
    ada.sever!.blackhole();
    await pastePlain(ada, docId, B);
    await ada.page.keyboard.press('Enter');
    await ada.page.keyboard.type('ZQX');
    await ada.page.keyboard.press('Shift+Enter');
    await ada.page.keyboard.type('QZ');
    await expect(ada.page.locator(`[${INPUT_REFUSAL_ATTR}]`), 'B is refused, visibly').toContainText('could not confirm room', { timeout: 60_000 });
    ada.sever!.restore();
    await expect.poll(() => rootText(ada, docId), { message: 'a new paragraph, then a line break, where Ada pressed them', timeout: 60_000 }).toBe('Kept.\n\nZQX\nQZ');
    await ui.waitAcked(ada, docId, 120_000);
    await expect.poll(async () => (await exported(ada, docId)).includes('Kept.\n\nZQX'), { message: 'and reaches the server, without any of B', timeout: 60_000 }).toBe(true);
    expect(await holds(ada, docId, 'Bravo 0 '), 'nothing of B is in Ada\'s editor').toBe(false);
  } finally {
    ben.close();
  }
});

for (const cut of ['reconnect', 'wake'] as const) {
  test(`j01-paste-atomic: a paste whose socket ${cut === 'wake' ? 'and DocDO instance end' : 'reconnects'} partway keeps its room, so a writer in between is refused and the paste lands whole @p:col-1`, async ({ actors, stack }) => {
    test.setTimeout(480_000);
    const { ada, ben, docId } = await open(actors, stack);
    // Black-holed, Ada's socket reads as silent and reconnects (4408) every 12 s; so do the replays while acks are lost.
    ada.expectReconnects(10, docId);
    try {
      const before = stateBytes(ben);
      const reserved = await pasteHeld(ada, docId);
      ada.sever!.blackhole();
      const base = await stack.docInstance(docId);
      if (cut === 'wake') {
        // The DocDO serving the paste ends; Ada reconnects into the black hole, and Ben wakes a new instance.
        await stack.resetDoc(docId);
        await ben.online(60_000);
      } else {
        // Ada's half-open socket reads as silent (12 s) and reconnects, into the black hole.
        await ada.page.waitForTimeout(16_000);
      }
      const landed = stateBytes(ben);
      const rest = reserved - (landed - before);
      expect(rest, 'part of the paste is still to come').toBeGreaterThan(500_000);
      // Room that fits beside what landed, but not beside the rest of the paste.
      const bens = await reserve(ben, 'ben-room', STATE_CAP_BYTES - landed - Math.floor(rest / 2));
      if (cut === 'wake') expect((await stack.docInstance(docId)).instanceId, 'a new DocDO instance answered').not.toBe(base.instanceId);
      ada.sever!.restore();
      await expectWhole(ada, docId);
      expect(bens, 'Ben\'s reserve was refused beside the paste\'s room').toBe('reserve-refused');
    } finally {
      ben.close();
    }
  });
}
