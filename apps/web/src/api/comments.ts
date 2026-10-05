// POST /api/docs/:id/comments (docs/design/comments.md §4, §12): a commenter or above creates a comment or a reply.
// The author is the server principal, never the body; the PrincipalDO counts 60 comment operations a minute per
// principal; the DocDO validates the anchor, computes the quote and writes the records through writeComments.
import { getServerByName } from 'partyserver';
import { COMMENT_OP_RATE } from '@moss-multi/protocol/limits';
import type { CommentResult } from '@moss-multi/sync';
import { roleAtLeast } from '@moss-multi/protocol/roles';
import { resolvePrincipal, shareTokenOf } from '../auth/principal.ts';
import { createDb } from '../db/client.ts';
import { json } from '../worker/route.ts';
import { resolveDocAccess } from './access.ts';
import type { DocsEnv } from './docs.ts';
import { NO_STORE, notFound, readJsonObject } from './respond.ts';

/** Moss's marker ids, which the client proposes so its composer can show the comment before the record arrives. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function createComment(request: Request, env: DocsEnv, docId: string): Promise<Response> {
  const principal = await resolvePrincipal(request, env);
  if (!principal || principal.type === 'anonymous') return json({ error: 'unauthenticated', message: 'Sign in to comment' }, 401, NO_STORE);
  const access = await resolveDocAccess(createDb(env.DB), principal, docId, shareTokenOf(request));
  if (!access || access.deleted) return notFound();
  if (!roleAtLeast(access.role, 'commenter')) return json({ error: 'forbidden', message: "You can't comment on this note." }, 403, NO_STORE);
  const body: Record<string, unknown> = (await readJsonObject(request)) ?? {};
  const { id, text, parentId, anchor } = body;
  const bad = () => json({ error: 'bad-request' }, 400, NO_STORE);
  if (typeof id !== 'string' || !ID.test(id) || typeof text !== 'string') return bad();
  if (parentId !== undefined && (typeof parentId !== 'string' || !ID.test(parentId))) return bad();
  if (anchor !== undefined && (typeof anchor !== 'object' || anchor === null || Array.isArray(anchor))) return bad();
  const principalDO = await getServerByName(env.PrincipalDO, principal.id);
  if (!(await principalDO.takeCommentToken())) {
    return json({ error: 'rate-limited' }, 429, { ...NO_STORE, 'retry-after': String(COMMENT_OP_RATE.windowMs / 1000) });
  }
  const stub = await getServerByName(env.DocDO, docId);
  const result = (await stub.createComment({
    author: principal.id,
    source: principal.type === 'agent' ? 'external' : 'user',
    id,
    text,
    ...(parentId !== undefined ? { parentId: parentId as string } : {}),
    ...(anchor !== undefined ? { anchor: anchor as never } : {}),
  })) as CommentResult;
  if (!result.ok) return json({ error: result.error }, result.status, NO_STORE);
  return json({ comment: { id: result.id, quote: result.quote } }, 201, NO_STORE);
}
