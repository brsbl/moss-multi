// G1: each converter fixture takes both production paths: POST markdown and a browser clipboard paste.
import { readdirSync, readFileSync } from 'node:fs';
import { expect, test, ui } from '../lib/test.ts';
import { pasteMarkdown, renderedBody } from '../lib/import-parity.ts';

const fixtures = new URL('../../packages/sync/src/converter/fixtures/', import.meta.url);
for (const name of readdirSync(fixtures).filter((name) => name.endsWith('.md')).sort()) {
  test(`j00 G1: ${name} server import equals UI paste @p:tech-4 @p:note-1`, async ({ actors, stack }) => {
    const markdown = readFileSync(new URL(name, fixtures), 'utf8');
    const imported = await actors.session(await actors.principal('imported'));
    const pasted = await actors.session(await actors.principal('pasted'));
    for (const actor of [imported, pasted]) {
      // Fixture media is synthetic. Keep the renderer's resource path while answering it deterministically.
      await actor.page.route('https://**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '' }));
    }
    const create = async (actor: typeof imported, content?: string) => {
      const response = await actor.context.request.post('/api/docs', {
        headers: { origin: stack.baseUrl }, data: { title: name, ...(content === undefined ? {} : { markdown: content }) },
      });
      expect(response.status()).toBe(201);
      const { doc } = await response.json();
      await actor.goto(`/d/${doc.id}`);
      await expect(ui.body(actor, doc.id)).toHaveAttribute('data-body-binding', 'live');
      return doc.id as string;
    };
    const importedId = await create(imported, markdown);
    const pastedId = await create(pasted);
    const empty = await renderedBody(pasted, pastedId);
    await pasteMarkdown(pasted, pastedId, markdown);
    await expect(ui.pane(pasted, pastedId)).toHaveAttribute('data-sync-unacked', '0');
    const authored = await renderedBody(pasted, pastedId);
    expect(authored, 'the paste changes the empty document (positive control)').not.toEqual(empty);
    await expect.poll(() => renderedBody(imported, importedId), { timeout: 15_000 }).toEqual(authored);
  });
}
