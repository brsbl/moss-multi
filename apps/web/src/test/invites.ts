// Redeeming email invites in API tests (T2.8, A§8): a share by email grants nothing until its invitee, signed in with
// the invite's email, follows the invite's link.
import { handleApi } from '../api/router.ts';
import { BASE } from './principals.ts';

type ApiEnv = Parameters<typeof handleApi>[1];

const call = (env: ApiEnv, method: string, path: string, cookie: string, body?: unknown) =>
  handleApi(new Request(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: BASE, cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);

/** The token of the open invite to `email` on `path` (`/api/docs/:id` or `/api/folders/:id`), as `owner` reads it. */
export async function inviteToken(env: ApiEnv, owner: { cookie: string }, path: string, email: string): Promise<string> {
  const response = await call(env, 'GET', `${path}/invites`, owner.cookie);
  if (response.status !== 200) throw new Error(`GET ${path}/invites: ${response.status}`);
  const { invites } = (await response.json()) as { invites: { email: string; url: string }[] };
  const invite = invites.find((i) => i.email === email.toLowerCase());
  if (!invite) throw new Error(`no open invite for ${email} on ${path}`);
  return new URL(invite.url).pathname.replace(/^\/invite\//, '');
}

/** `user` follows the open invite `owner` made for them on `path`, and must be admitted. */
export async function redeem(env: ApiEnv, owner: { cookie: string }, path: string, user: { cookie: string; email: string }): Promise<void> {
  const token = await inviteToken(env, owner, path, user.email);
  const response = await call(env, 'POST', `/api/invites/${token}/accept`, user.cookie);
  if (response.status !== 200) throw new Error(`redeeming ${user.email} on ${path}: ${response.status} ${await response.text()}`);
}

/** `owner` shares `path` with `user` at `role` and `user` redeems it: the whole of giving a person access. */
export async function shareAndRedeem(env: ApiEnv, owner: { cookie: string }, path: string, user: { cookie: string; email: string }, role: string): Promise<number> {
  const response = await call(env, 'POST', `${path}/members`, owner.cookie, { email: user.email, role });
  if (response.status >= 300) throw new Error(`sharing ${path} with ${user.email}: ${response.status} ${await response.text()}`);
  await redeem(env, owner, path, user);
  return response.status;
}
