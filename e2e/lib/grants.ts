// Declared-setup grants (BUILDPLAN conventions): a journey whose promise is not sharing gives a second principal a
// role on a doc through the members API, as its owner, never through the UI. Sharing journeys use the ShareDialog.
import type { Actor } from './actors.ts';
import type { Principal } from './principals.ts';

export type GrantRole = 'viewer' | 'commenter' | 'editor';

/** `owner` grants `member` a role on the doc through `POST /api/docs/:id/members`. */
export async function grantDoc(owner: Actor, docId: string, member: Principal, role: GrantRole = 'editor'): Promise<void> {
  const origin = new URL(owner.page.url()).origin;
  const response = await owner.context.request.post(`${origin}/api/docs/${encodeURIComponent(docId)}/members`, {
    headers: { origin, 'content-type': 'application/json' },
    data: { email: member.email, role },
    timeout: 15_000,
  });
  if (!response.ok()) throw new Error(`${owner.label} granting ${member.email} ${role} on ${docId}: ${response.status()} ${(await response.text()).slice(0, 200)}`);
}
