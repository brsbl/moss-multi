// Search measurement Worker (A§5.3): the real SearchDO in workerd, driven by scripts/measure-converter.mjs.
import { getServerByName } from 'partyserver';
import { parseHeadings, SEARCH_DO_NAME } from '../src/search-core.ts';
import { SearchDO } from '../src/search-do.ts';

export { SearchDO };

interface Env {
  SearchDO: DurableObjectNamespace<SearchDO>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ping') return new Response('ok');
    const docId = url.searchParams.get('doc') ?? 'measure';
    if (url.pathname === '/index') {
      // The body is the doc's exported markdown, as the DocDO feeds it.
      const stub = await getServerByName(env.SearchDO, SEARCH_DO_NAME);
      return Response.json(await stub.index({ docId, title: 'Measure', body: await request.text() }));
    }
    if (url.pathname === '/search') {
      const stub = await getServerByName(env.SearchDO, SEARCH_DO_NAME);
      const { results } = await stub.search({ query: url.searchParams.get('q') ?? '', allowedDocIds: [docId] });
      return results.length === 1 ? Response.json({ snippet: results[0].snippet }) : new Response(`${results.length} hits`, { status: 500 });
    }
    if (url.pathname === '/headings') {
      // The headings route parses the doc's export in the Worker.
      return Response.json({ headings: parseHeadings(await request.text()).length });
    }
    return new Response('not found', { status: 404 });
  },
};
