// Declared-setup grants (BUILDPLAN conventions): a journey whose promise is not sharing gives a second principal a
// role on a doc through the members API, as its owner, never through the UI. Sharing journeys use the ShareDialog.
import type { Actor } from './actors.ts';
import type { Principal } from './principals.ts';

export type GrantRole = 'viewer' | 'commenter' | 'suggester' | 'editor';

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

/** `owner` makes a live share link on the doc at `role` through `POST /api/docs/:id/links`, and returns its token. */
export async function linkDoc(owner: Actor, docId: string, role: GrantRole = 'viewer'): Promise<string> {
  const origin = new URL(owner.page.url()).origin;
  const response = await owner.context.request.post(`${origin}/api/docs/${encodeURIComponent(docId)}/links`, {
    headers: { origin, 'content-type': 'application/json' },
    data: { role },
    timeout: 15_000,
  });
  if (!response.ok()) throw new Error(`${owner.label} linking ${docId} at ${role}: ${response.status()} ${(await response.text()).slice(0, 200)}`);
  return ((await response.json()) as { link: { token: string } }).link.token;
}
