// j01-paste-tail (T3.B4, B209, a known limitation recorded in docs/METHOD.md): near the note's size cap the DocDO admits
// each frame of a large paste on its own. A paste that fit when it was checked is cut short when another writer fills
// the room while its later frames are still on the way: the frames that landed stay and the rest is refused (doc-cap).
// Ada's tab says so, discards what it held and binds the server's copy afresh, so she and Ben converge on what landed.
// Her undo history starts again with that binding, so an undo does not take the landed part back. Ben is a
// protocol-level client (doc-client.ts); Ada's doc socket runs through a sever proxy that holds the rest of her paste.
//
// The note is created through POST /api/docs as declared setup.
import * as Y from 'yjs';
import { STATE_CAP_BYTES } from '../../packages/protocol/src/limits.ts';
import type { Actor } from '../lib/actors.ts';
import { INPUT_REFUSAL_ATTR } from '../lib/contract.ts';
import { cookieHeader, openDocClient, type DocClient } from '../lib/doc-client.ts';
import { grantDoc } from '../lib/grants.ts';
import { exported, fingerprint, importNote, pastePlain, UNDO } from '../lib/paste.ts';
import { signIn } from '../lib/principals.ts';
import { expect, test, ui } from '../lib/test.ts';

/** About 3 MB of state: past the 1.5 MB an outbox sends unacked, so a part of it waits for acks. */
const A = Array.from({ length: 2_000 }, (_, i) => `Alpha ${i} ${'a'.repeat(990)}.`).join('\n\n');

const count = (text: string, word: string) => text.split(`${word} `).length - 1;
const stateBytes = (client: DocClient) => Y.encodeStateAsUpdate(client.doc).byteLength;

/** fingerprint()'s length and hash, of Ben's text. */
function print(text: string): { length: number; sum: number } {
  let sum = 0;
  for (let i = 0; i < text.length; i += 1) sum = (sum * 31 + text.charCodeAt(i)) >>> 0;
  return { length: text.length, sum };
}

/** What the latest paste's admission measured it adds (`moss-paste-admission`). */
const lastAdds = (actor: Actor) => actor.page.evaluate(() => {
  const marks = performance.getEntriesByName('moss-paste-admission');
  return ((marks.at(-1) as PerformanceMark | undefined)?.detail as { adds: number } | undefined)?.adds ?? 0;
});

/** Ben appends short paragraphs, each batch acked and well under the frame cap, until the note's state reaches `target`. */
async function fillTo(ben: DocClient, target: number, label: string): Promise<void> {
  let perParagraph = 2_000;
  let n = 0;
  for (let bytes = stateBytes(ben); bytes < target; ) {
    const batch = Math.max(1, Math.min(1_000, Math.floor(((target - bytes) / perParagraph) * 0.9)));
    ben.paragraphs(Array.from({ length: batch }, () => `${label} ${n++} ${'filler '.repeat(60)}`));
    await ben.acked();
    const after = stateBytes(ben);
    perParagraph = Math.max(1, (after - bytes) / batch);
    bytes = after;
  }
}

test('j01-paste-tail: a paste cut short near the cap by another writer keeps what landed, says so, and both peers converge; an undo leaves it @p:col-1', async ({ actors, stack }) => {
  test.setTimeout(900_000);
  const ada = await actors.session(await actors.principal('ada'), { severable: true });
  const docId = await importNote(ada, stack, 'Paste target', 'Kept.');
  const principal = await actors.principal('ben');
  await grantDoc(ada, docId, principal);
  const ben = await openDocClient(stack.baseUrl, docId, cookieHeader(await signIn(stack.baseUrl, principal)));
  // Acks lost or black-holed, Ada's socket reads as stalled or silent and reconnects; the refusal closes it (4409) and
  // her pane binds again.
  ada.expectReconnects(16, docId);
  try {
    await ben.synced;
    // The note 6 MB under the cap before Ada opens it: A still fits beside it.
    await fillTo(ben, STATE_CAP_BYTES - 6_000_000, 'Filler');
    await ada.goto(`/d/${docId}`);
    await ui.waitBodyLive(ada, docId, 180_000);
    await ui.body(ada, docId).locator('p').filter({ hasText: /^Kept\.$/ }).click();
    await ada.page.keyboard.press('End');

    // Ada pastes A with her acks lost: a part goes out and lands, then her socket goes dark with the rest to send.
    const before = stateBytes(ben);
    ada.sever!.loseAcks();
    await pastePlain(ada, docId, A);
    await expect.poll(() => stateBytes(ben) - before, { message: 'part of the paste lands', timeout: 180_000 }).toBeGreaterThan(500_000);
    ada.sever!.blackhole();
    await ada.page.waitForTimeout(3_000);
    const landed = stateBytes(ben);
    const rest = (await lastAdds(ada)) - (landed - before);
    expect(rest, 'part of the paste is still to come').toBeGreaterThan(500_000);

    // Ben fills the room: his writes fit beside what landed, the rest of the paste no longer does.
    await fillTo(ben, STATE_CAP_BYTES - Math.floor(rest / 2), 'Bravo');
    ada.sever!.restore();
    await expect(ada.page.locator(`[${INPUT_REFUSAL_ATTR}]`), 'the cut is announced').toContainText('size limit', { timeout: 240_000 });

    // Ada's pane binds the server's copy: she and Ben hold the same note, with the part of A that landed.
    await ui.waitBodyLive(ada, docId, 180_000);
    await expect.poll(async () => JSON.stringify(await fingerprint(ada, docId)) === JSON.stringify(print(ben.text())), {
      message: 'Ada and Ben converge', timeout: 240_000,
    }).toBe(true);
    const server = await exported(ada, docId);
    const kept = count(server, 'Alpha');
    expect(kept, 'the part that landed stays').toBeGreaterThan(0);
    expect(kept, 'the rest was refused').toBeLessThan(2_000);
    expect(count(ben.text(), 'Alpha'), 'Ben holds the same part').toBe(kept);
    expect(count(server, 'Bravo'), "Ben's writes all landed").toBeGreaterThan(0);

    // The binding starts a fresh undo history: an undo takes nothing back, and the landed part stays.
    const settled = await fingerprint(ada, docId);
    await ui.body(ada, docId).locator('p').filter({ hasText: /^Kept\./ }).click();
    await ada.page.keyboard.press(UNDO);
    await ada.page.waitForTimeout(3_000);
    expect(await fingerprint(ada, docId), 'an undo changes nothing').toEqual(settled);
    expect(await exported(ada, docId), 'nor the server').toBe(server);
  } finally {
    ben.close();
  }
});
