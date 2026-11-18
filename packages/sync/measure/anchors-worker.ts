// T4.2 measurement Worker: the DocDO's comment-anchor frame work in workerd (measure/anchors.ts), driven by
// scripts/measure-converter.mjs. Its own bundle, since the DocDO's modules are typechecked against the Workers types.
import * as anchors from './anchors.ts';

const steps: Record<string, () => unknown> = { setup: anchors.setup, keys: anchors.keys, shared: anchors.shared, forged: anchors.forged, lift: anchors.lift, lifted: anchors.lifted };

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/ping') return new Response('ok');
    const step = pathname.startsWith('/anchors/') ? steps[pathname.slice('/anchors/'.length)] : undefined;
    return step ? Response.json(step()) : new Response('not found', { status: 404 });
  },
};
