// Declared-setup grants (BUILDPLAN conventions): a journey whose promise is not sharing gives a second principal a
// role through the members API, as the owner, never through the UI. Sharing journeys use the ShareDialog. A share by
// email is an invite bound to the email (A§8, T2.8): it grants nothing until the invitee, signed in with that email,
// redeems it, so declared setup redeems it as following its link would.
import type { Actor } from './actors.ts';
import { signIn, type Principal } from './principals.ts';

export type GrantRole = 'viewer' | 'commenter' | 'editor';
export type InviteTarget = { docId: string } | { folderId: string };

const pathOf = (target: InviteTarget): string =>
  'docId' in target ? `/api/docs/${encodeURIComponent(target.docId)}` : `/api/folders/${encodeURIComponent(target.folderId)}`;

/** The stack's origin, as the actor's context resolves its relative API paths (a session may not have navigated). */
async function originOf(actor: Actor): Promise<string> {
  return new URL((await actor.context.request.get('/api/me', { timeout: 15_000 })).url()).origin;
}

/** `member` redeems the open invite `owner` made them on `target`, in a session of their own. */
export async function acceptInvite(owner: Actor, target: InviteTarget, member: Principal): Promise<void> {
  const listed = await owner.context.request.get(`${pathOf(target)}/invites`, { timeout: 15_000 });
  if (!listed.ok()) throw new Error(`${owner.label} reading invite links: ${listed.status()} ${(await listed.text()).slice(0, 200)}`);
  const origin = new URL(listed.url()).origin;
  const { invites } = (await listed.json()) as { invites: { email: string; url: string }[] };
  const invite = invites.find((i) => i.email === member.email.toLowerCase());
  if (!invite) throw new Error(`no open invite for ${member.email} on ${pathOf(target)}`);
  const token = new URL(invite.url).pathname.replace(/^\/invite\//, '');
  const cookie = (await signIn(origin, member)).map(({ name, value }) => `${name}=${value}`).join('; ');
  const response = await fetch(`${origin}/api/invites/${token}/accept`, {
    method: 'POST',
    headers: { origin, cookie, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${member.email} redeeming ${pathOf(target)}: ${response.status} ${(await response.text()).slice(0, 200)}`);
}

/** `owner` shares `target` with `member` at `role` through the members API, and `member` redeems the invite. */
export async function grant(owner: Actor, target: InviteTarget, member: Principal, role: GrantRole | 'owner' = 'editor'): Promise<void> {
  const response = await owner.context.request.post(`${pathOf(target)}/members`, {
    headers: { origin: await originOf(owner), 'content-type': 'application/json' },
    data: { email: member.email, role },
    timeout: 15_000,
  });
  if (!response.ok()) throw new Error(`${owner.label} sharing ${pathOf(target)} with ${member.email} at ${role}: ${response.status()} ${(await response.text()).slice(0, 200)}`);
  await acceptInvite(owner, target, member);
}

/** `owner` grants `member` a role on the doc. */
export async function grantDoc(owner: Actor, docId: string, member: Principal, role: GrantRole = 'editor'): Promise<void> {
  await grant(owner, { docId }, member, role);
}
