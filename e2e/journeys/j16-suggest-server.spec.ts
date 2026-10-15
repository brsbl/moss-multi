// j16-suggest-server (T5.2; docs/design/suggestions.md I1): a suggester never writes the body. A raw sync frame from
// a suggester's own doc socket that deletes original text, sent the way a client that ignores its binding would, is
// refused by role before Yjs applies it: the server export keeps every word, the owner's window never loses them,
// and the suggester's window says the change was refused in its notice band.
import * as Y from 'yjs';
import { APP_STATE_ATTR, BODY_BINDING_ATTR, EDIT_MODE_ATTR, INPUT_REFUSAL_ATTR, SYNC_UNACKED_ATTR } from '../lib/contract.ts';
import { cookieHeader, openDocClient } from '../lib/doc-client.ts';
import { grantDoc } from '../lib/grants.ts';
import { signIn } from '../lib/principals.ts';
import { expect, test, ui } from '../lib/test.ts';

const BOOT_TIMEOUT = 30_000;
const BIND_TIMEOUT = 15_000;
const ORIGINAL = 'Every original word stays put';

/** A y-protocols sync update frame (message 0, step 2, then the length-prefixed update), as the provider sends one. */
function syncUpdate(update: Uint8Array): Buffer {
  const length: number[] = [];
  let n = update.byteLength;
  while (n > 0x7f) {
    length.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  length.push(n);
  return Buffer.concat([Buffer.from([0, 2, ...length]), Buffer.from(update)]);
}

/** The update that deletes every character of the body's first paragraph, made on a copy of `doc`. */
function deleteOriginal(doc: Y.Doc): Uint8Array {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  const sv = Y.encodeStateVector(copy);
  const first = (copy.get('root', Y.XmlText).toDelta() as { insert: unknown }[]).map((op) => op.insert).find((insert) => insert instanceof Y.XmlText) as Y.XmlText;
  first.delete(0, first.length);
  const update = Y.encodeStateAsUpdate(copy, sv);
  copy.destroy();
  return update;
}

test('j16-suggest-server: a forged raw frame from a suggester deleting original text never lands, and the refusal shows in the band @p:mean-2 @p:tech-7 @p:R17', async ({ actors, stack }) => {
  const adaPrincipal = await actors.principal('ada');
  const ada = await actors.open(adaPrincipal);
  const docId = await ui.createNote(ada);
  await ui.typeTitle(ada, docId, 'Suggest refusal', { enter: true });
  await ui.typeBody(ada, docId, ORIGINAL);
  await expect(ui.pane(ada, docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });

  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, 'suggester');
  const ben = await actors.session(benPrincipal, { severable: true });
  await ben.goto(`/d/${docId}`);
  await ben.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  await actors.requireDistinct(2);
  // A suggester's window opens in Suggest mode, bound to a private fork; the forged frame bypasses it.
  await expect(ui.pane(ben, docId)).toHaveAttribute(EDIT_MODE_ATTR, 'suggest', { timeout: BIND_TIMEOUT });
  await expect(ui.body(ben, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'live', { timeout: BIND_TIMEOUT });
  await expect(ui.body(ben, docId)).toContainText(ORIGINAL);

  // Ben's own synced state, read over a protocol-level socket of his, makes the forged delete.
  const reader = await openDocClient(stack.baseUrl, docId, cookieHeader(await signIn(stack.baseUrl, benPrincipal)));
  let forged: Uint8Array;
  try {
    await reader.synced;
    expect(reader.text()).toContain(ORIGINAL);
    forged = deleteOriginal(reader.doc);
  } finally {
    reader.close();
  }
  expect(forged.byteLength, 'the frame deletes something').toBeGreaterThan(2);

  const sever = ben.sever;
  if (!sever) throw new Error('ben is not severable');
  // The 4403 sends the client to REST, which still says suggester: it rebinds read-only on a fresh socket (A§8).
  ben.expectReconnects(1, docId);
  sever.inject(syncUpdate(forged));

  await expect(ben.page.locator(`[${INPUT_REFUSAL_ATTR}]`), 'the refusal shows in the band').toContainText(/can.t edit this note|can view this note/, { timeout: BIND_TIMEOUT });
  await expect(ui.body(ben, docId), 'his window keeps the text').toContainText(ORIGINAL);
  await expect(ui.body(ada, docId), "the owner's window never loses it").toContainText(ORIGINAL);
  const exported = await (await ada.context.request.get(`/api/docs/${docId}/content`)).text();
  expect(exported, 'the server export keeps every word').toContain(ORIGINAL);
});
