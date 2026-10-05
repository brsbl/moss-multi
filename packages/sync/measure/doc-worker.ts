// T1.F2 bounded-work measurement Worker (A§10.10): the real DocDO in workerd, driven by scripts/measure-converter.mjs
// over real sockets. Test-only: it sets the trusted principal headers itself from the query string.
import { getServerByName, routePartykitRequest } from 'partyserver';
import * as Y from 'yjs';
import { encodePartyPrincipal, TRUSTED } from '@moss-multi/protocol/sync';
import { DocDO } from '../src/doc-do.ts';
import type { PayloadWork } from '../src/payloads.ts';

/** The DocDO, plus a method that reports its payload work (a getter is not an RPC method). */
export class MeasuredDocDO extends DocDO {
  work(): PayloadWork {
    return { ...this.payloadWork };
  }
}

interface Env {
  DocDO: DurableObjectNamespace<MeasuredDocDO>;
}

/** The payload ids a note's top-level blocks name. */
function namedIds(state: Uint8Array): string[] {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return (doc.get('root', Y.XmlText).toDelta() as { insert: unknown }[])
      .map((op) => (op.insert instanceof Y.XmlElement ? op.insert.getAttribute('__regId') : undefined))
      .filter((id): id is string => typeof id === 'string');
  } finally {
    doc.destroy();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ping') return new Response('ok');
    const docId = url.searchParams.get('doc') ?? '';
    if (url.pathname === '/create') {
      // The body is the note's markdown.
      const stub = await getServerByName(env.DocDO, docId);
      await stub.create({ folderId: 'measure', ownerId: 'measure-owner', markdown: await request.text() });
      const { state } = await stub.snapshotForDuplicate();
      return Response.json({ ids: namedIds(state) });
    }
    if (url.pathname === '/work') {
      const stub = await getServerByName(env.DocDO, docId);
      return Response.json(await stub.work());
    }
    if (url.pathname.startsWith('/parties/')) {
      const forwarded = new Request(request);
      const principal = url.searchParams.get('principal') ?? 'measure';
      forwarded.headers.set(TRUSTED.principal, encodePartyPrincipal({ id: principal, kind: 'user', name: principal }));
      forwarded.headers.set(TRUSTED.role, 'editor');
      forwarded.headers.set(TRUSTED.session, `session-${principal}`);
      return (await routePartykitRequest(forwarded, env as never)) ?? new Response('not found', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  },
};
