// j01-paste-held (T3.S6): the cap check counts the payloads the DocDO keeps that this tab does not hold. Deleting a
// code or HTML block leaves its text on the server (withheld, for an undo) and still counted against the note's size
// cap (A§5.1), but a tab that opens the note afterwards holds only the payloads its blocks name. A paste that fits
// beside what the tab holds, but not beside what the server counts, would land in part: its first batches persist and
// a later one is refused. It must be refused whole before anything is applied, as a paste past the cap is.
//
// The notes and the reference imports are created through POST /api/docs as declared setup.
import { CLIENT_FRAME_MAX_BYTES } from '../../packages/protocol/src/limits.ts';
import { INPUT_REFUSAL_ATTR } from '../lib/contract.ts';
import {
  exported, fingerprint, longestStall, MAX_STALL_MS, NEW_STEP_MS, normalized, pastePlain, setup, UNDO, watchStalls,
} from '../lib/paste.ts';
import { expect, test, ui } from '../lib/test.ts';

/** A fenced block of `language` holding about `bytes` of `line(i)` lines. */
function fence(language: string, bytes: number, line: (i: number) => string): string {
  const lines: string[] = [];
  for (let size = 0, i = 0; size < bytes; i += 1) {
    const next = line(i);
    lines.push(next);
    size += next.length + 1;
  }
  return `\`\`\`${language}\n${lines.join('\n')}\n\`\`\``;
}

test('j01-paste-held: a paste that fits beside the payloads this tab holds, but not beside the deleted ones the server still counts, is refused whole @p:col-1', async ({ actors, stack }) => {
  test.setTimeout(600_000);
  const { ada, ben, docId, wire } = await setup(actors, stack, 'Kept.');
  await ui.waitAcked(ada, docId, 30_000);
  const before = await exported(ada, docId);
  const print = await fingerprint(ada, docId);

  // 76 code and HTML blocks of 200 KB each: about 15 MB of payload docs, which land, then leave in one undo. The
  // DocDO keeps their text for a redo and counts it against the cap.
  const blocks: string[] = [];
  for (let b = 0; b < 38; b += 1) {
    blocks.push(fence('js', 200_000, (i) => `const value${b}_${i} = ${i};`));
    blocks.push(fence('moss-html', 200_000, (i) => `<p>block ${b} line ${i}</p>`));
  }
  await ui.body(ada, docId).locator('p').filter({ hasText: /^Kept\.$/ }).click();
  await ada.page.keyboard.press('End');
  await ada.page.waitForTimeout(NEW_STEP_MS);
  await pastePlain(ada, docId, blocks.join('\n\n'));
  await ui.waitAcked(ada, docId, 300_000);
  await expect.poll(() => exported(ada, docId), { message: 'the blocks land', timeout: 60_000 }).toContain('const value37_0 = 0;');
  await ada.page.waitForTimeout(NEW_STEP_MS);
  await ada.page.keyboard.press(UNDO);
  await ui.waitAcked(ada, docId, 60_000);
  await expect.poll(() => exported(ada, docId), { message: 'one undo removes them', timeout: 60_000 }).toBe(before);

  // Opened afresh, the tab holds none of their payloads.
  await ada.page.reload();
  await ui.waitLive(ada, docId);
  await ada.declareRemount(docId);
  await ui.waitAcked(ada, docId, 30_000);
  expect(await fingerprint(ada, docId)).toEqual(print);
  const sockets = wire.opened;

  // 44,000 short paragraphs are about 13 MB of note state: under the cap alone, past it with the 15 MB kept.
  const lines: string[] = [];
  for (let i = 0; i < 44_000; i += 1) lines.push(`p${i}`);
  lines.push('Last line of the paste.');
  await ui.body(ada, docId).locator('p').filter({ hasText: /^Kept\.$/ }).click();
  await ada.page.keyboard.press('End');
  await watchStalls(ada);
  await pastePlain(ada, docId, lines.join('\n\n'));
  await expect(ada.page.locator(`[${INPUT_REFUSAL_ATTR}]`), 'the refusal is announced').toContainText('size limit', { timeout: 120_000 });
  const stall = await longestStall(ada);
  expect(stall.ms, `the refused paste never holds the tab longer than ${MAX_STALL_MS} ms at a time (during: ${stall.during})`).toBeLessThanOrEqual(MAX_STALL_MS);
  await ui.waitAcked(ada, docId, 30_000);
  expect(await fingerprint(ada, docId), 'nothing of the paste is in the editor').toEqual(print);
  await ada.page.waitForTimeout(3_000);
  expect(await exported(ada, docId), 'nothing of the paste reached the server').toBe(before);
  expect(await fingerprint(ben, docId), 'nor the collaborator').toEqual(print);
  await ui.typeBody(ada, docId, ' Still typing.');
  await ui.waitAcked(ada, docId, 30_000);
  await expect.poll(() => exported(ada, docId), { message: 'the note stays editable', timeout: 30_000 }).toBe(await normalized(ada, stack, 'Kept. Still typing.'));
  expect(wire.largestFrame, 'no frame the client sends exceeds the frame cap').toBeLessThanOrEqual(CLIENT_FRAME_MAX_BYTES);
  expect(wire.opened, `the doc socket never closed and reopened after the reload (closes: ${wire.closes.join('; ') || 'none seen'})`).toBe(sockets);
});
