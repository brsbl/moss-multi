// G1: each converter fixture takes both production paths: POST markdown and a browser clipboard paste.
import { readdirSync, readFileSync } from 'node:fs';
import { expect, test, ui } from '../lib/test.ts';
import { pasteMarkdown, renderedBody } from '../lib/import-parity.ts';

const fixtures = new URL('../../packages/sync/src/converter/fixtures/', import.meta.url);
for (const mime of ['text/markdown', 'text/plain']) {
  for (const source of ['paste', 'import']) {
    test(`j00 formula paste: ${mime} after ${source} keeps independent ids @p:tech-4`, async ({ actors, stack }) => {
      actors.solo('formula identity is local to one note; both import and paste seed paths are covered');
      const actor = await actors.session(await actors.principal('author'));
      const markdown = '- Total {{2+2|4}}';
      const response = await actor.context.request.post('/api/docs', {
        headers: { origin: stack.baseUrl }, data: source === 'import' ? { markdown } : {},
      });
      expect(response.status()).toBe(201);
      const { doc } = await response.json();
      await actor.goto(`/d/${doc.id}`);
      const body = ui.body(actor, doc.id);
      await expect(body).toHaveAttribute('data-body-binding', 'live', { timeout: 30_000 });
      const paste = async () => {
        await body.click();
        await actor.page.keyboard.press('ControlOrMeta+End');
        await body.evaluate((element, payload) => {
          const data = new DataTransfer();
          data.setData('text/plain', payload.markdown);
          if (payload.mime === 'text/markdown') data.setData(payload.mime, payload.markdown);
          element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
        }, { markdown, mime });
      };
      if (source === 'paste') await paste();
      const formulas = body.locator('[data-formula-id]');
      await expect(formulas).toHaveCount(1);
      const original = await formulas.getAttribute('data-formula-id');
      await paste();
      await expect(formulas).toHaveCount(2);
      const ids = await formulas.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-formula-id')));
      expect(ids).toContain(original);
      expect(new Set(ids).size, 'each formula owns an independent workspace key').toBe(2);
      await expect(ui.pane(actor, doc.id)).toHaveAttribute('data-sync-unacked', '0');
      await actor.page.reload();
      await expect(body).toHaveAttribute('data-body-binding', 'live', { timeout: 30_000 });
      expect(await formulas.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-formula-id')).sort())).toEqual(ids.sort());
    });
  }
}

for (const name of readdirSync(fixtures).filter((name) => name.endsWith('.md')).sort()) {
  test(`j00 G1: ${name} server import equals UI paste @p:tech-4@1 @p:note-1`, async ({ actors, stack }) => {
    const markdown = readFileSync(new URL(name, fixtures), 'utf8');
    const imported = await actors.session(await actors.principal('imported'));
    const pasted = await actors.session(await actors.principal('pasted'));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=', 'base64');
    for (const actor of [imported, pasted]) {
      // Fixture media is synthetic. Keep the renderer's resource path while answering it deterministically.
      await actor.page.route('https://**/*', (route) => route.request().resourceType() === 'image'
        ? route.fulfill({ status: 200, contentType: 'image/png', body: png })
        : route.fulfill({ status: 200, contentType: 'text/html', body: '' }));
      // The fixtures' local `assets/` media was never uploaded; its asset route (T3.1) is answered the same way.
      await actor.page.route((url) => /^\/api\/docs\/[^/]+\/assets\/[^/]+$/.test(url.pathname),
        (route) => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
    }
    const create = async (actor: typeof imported, content?: string) => {
      const response = await actor.context.request.post('/api/docs', {
        headers: { origin: stack.baseUrl }, data: { title: name, ...(content === undefined ? {} : { markdown: content }) },
      });
      expect(response.status()).toBe(201);
      const { doc } = await response.json();
      await actor.goto(`/d/${doc.id}`);
      await expect(ui.body(actor, doc.id)).toHaveAttribute('data-body-binding', 'live', { timeout: 30_000 });
      return doc.id as string;
    };
    const importedId = await create(imported, markdown);
    const pastedId = await create(pasted);
    const empty = await renderedBody(pasted, pastedId);
    await pasteMarkdown(pasted, pastedId, markdown);
    await expect(ui.pane(pasted, pastedId)).toHaveAttribute('data-sync-unacked', '0');
    const authored = await renderedBody(pasted, pastedId);
    expect(authored, 'the paste changes the empty document (positive control)').not.toEqual(empty);
    await expect(async () => {
      expect(await renderedBody(imported, importedId)).toEqual(await renderedBody(pasted, pastedId));
    }).toPass({ timeout: 10_000 });
  });
}
