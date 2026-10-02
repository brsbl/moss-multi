// j07-auth (T0.10): email and password on the moss-styled login card. Sign-up lands in the Home vault shell,
// sign-out from Settings goes to the card, sign-in returns to the doc `next` names, a wrong password says so, no
// OAuth button renders, the card works at both Tier A widths, and a failed session lookup degrades in place (R10).
import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { Actor } from '../lib/actors.ts';
import { APP_STATE_ATTR } from '../lib/contract.ts';
import { expect, test, ui } from '../lib/test.ts';

const SHELL = '[data-moss-app-shell]';
const BOOT_TIMEOUT = 30_000;
const SERVER_FNS = '**/_serverFn/**';

const docPath = () => `/d/${randomBytes(8).toString('hex')}`;

/** `/login?next=<path>`, however the router encodes it. */
const atLogin = (next: string | null) => (url: URL) => url.pathname === '/login' && url.searchParams.get('next') === next;
const atPath = (path: string) => (url: URL) => url.pathname === path;

async function waitForShell(actor: Actor): Promise<void> {
  await expect(actor.page.locator('html'), `${actor.label}: the moss shell boots`).toHaveAttribute(APP_STATE_ATTR, 'ready', { timeout: BOOT_TIMEOUT });
  await expect(actor.page.locator(SHELL), `${actor.label}: moss's AppShell renders`).toBeVisible();
}

/** `/api/me` through the actor's own cookies (not page traffic, so a 401 here is not an invariant-1 event). */
async function me(actor: Actor, baseUrl: string): Promise<{ status: number; id: string | null; email: string | null }> {
  const response = await actor.context.request.get(new URL('/api/me', baseUrl).href);
  const body = (await response.json().catch(() => ({}))) as { principal?: { id?: string; email?: string } };
  return { status: response.status(), id: body.principal?.id ?? null, email: body.principal?.email ?? null };
}

async function expectNoOAuth(actor: Actor): Promise<void> {
  const oauth = actor.page.getByRole('button', { name: /github|google|oauth|continue with/i });
  await expect(oauth, `${actor.label}: no OAuth provider is configured, so none renders`).toHaveCount(0);
  await expect(actor.page.getByRole('link', { name: /github|google|oauth|continue with/i })).toHaveCount(0);
}

/** Every main-frame URL the page commits, to prove a leg never left its path. */
function recordNavigations(page: Page): string[] {
  const urls: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) urls.push(frame.url());
  });
  return urls;
}

test('sign-up on the login card lands in the Home vault shell, with no OAuth button @p:ppl-1', async ({ actors, stack }) => {
  for (const label of ['ada', 'ben']) {
    const person = actors.credentials(label);
    const actor = await actors.anonymous('/', { label });
    await expect(actor.page, `${label}: / sends a signed-out visitor to the login card`).toHaveURL(atLogin('/'));
    await ui.waitForLoginCard(actor);
    await expectNoOAuth(actor);

    await ui.signUpThroughCard(actor, person);
    await expect(actor.page, `${label}: sign-up returns to /`).toHaveURL(atPath('/'), { timeout: BOOT_TIMEOUT });
    await waitForShell(actor);
    const who = await me(actor, stack.baseUrl);
    expect(who, `${label}: the new account is the session`).toMatchObject({ status: 200, email: person.email });
    person.id = who.id;

    const workspace = await actor.context.request.get(new URL('/api/workspace', stack.baseUrl).href);
    expect(workspace.status()).toBe(200);
    expect(((await workspace.json()) as { vault: { name: string } }).vault.name, `${label}: the shell is the Home vault`).toBe('Home');
  }
  const ids = actors.principals.map((p) => p.id);
  expect(new Set(ids).size, 'two distinct accounts').toBe(2);
});

test('sign-out from moss Settings posts JSON {} and goes to the login card, ending only that session @p:ppl-1', async ({ actors, stack }) => {
  const ada = await actors.open(await actors.principal('ada'));
  const ben = await actors.open(await actors.principal('ben'));
  await actors.requireDistinct(2);
  for (const actor of [ada, ben]) await waitForShell(actor);

  const signOut = ada.page.waitForRequest((request) => new URL(request.url()).pathname === '/api/auth/sign-out');
  await ui.signOutThroughSettings(ada);
  const request = await signOut;
  expect(request.method()).toBe('POST');
  expect(request.headers()['content-type'] ?? '', 'sign-out declares JSON (better-auth 415s otherwise)').toMatch(/^application\/json/);
  expect(request.postData(), 'sign-out carries the JSON body {}').toBe('{}');

  await expect(ada.page, 'sign-out lands on the login card').toHaveURL(atLogin(null), { timeout: BOOT_TIMEOUT });
  await ui.waitForLoginCard(ada);
  expect((await me(ada, stack.baseUrl)).status, 'the session is gone on the server').toBe(401);

  await ada.goto('/');
  await expect(ada.page, 'the app sends the signed-out person back to the card').toHaveURL(atLogin('/'));

  await ben.page.reload();
  await waitForShell(ben);
  expect((await me(ben, stack.baseUrl)).status, "the other person's session is untouched").toBe(200);
});

test('sign-in on the card returns to the doc next names; a wrong password shows a message @p:ppl-1', async ({ actors, stack }) => {
  const people = [await actors.principal('ada'), await actors.principal('ben')];
  for (const person of people) {
    const path = docPath();
    const actor = await actors.anonymous(path, { label: person.label });
    await expect(actor.page, `${person.label}: a signed-out doc link goes to the card with next`).toHaveURL(atLogin(path));
    await ui.waitForLoginCard(actor);
    await expectNoOAuth(actor);

    if (person === people[0]) {
      actor.expectHttp(401, '/api/auth/sign-in/email');
      await ui.signInThroughCard(actor, person, { password: `${person.password}-wrong` });
      await expect(ui.loginForm(actor).getByRole('alert'), 'a wrong password says so').toContainText(/don.t match an account/);
      await expect(actor.page, 'and stays on the card').toHaveURL(atLogin(path));
      expect((await me(actor, stack.baseUrl)).status, 'nobody is signed in').toBe(401);
    }

    await ui.signInThroughCard(actor, person);
    await expect(actor.page, `${person.label}: sign-in returns to ${path}`).toHaveURL(atPath(path), { timeout: BOOT_TIMEOUT });
    await waitForShell(actor);
    expect((await me(actor, stack.baseUrl)).id, `${person.label}: signed in as themself`).toBe(person.id);
  }
});

const TIER_A = [
  { width: 390, height: 844 },
  { width: 1440, height: 1000 },
];

test('the login card works at 390x844 and 1440x1000 @p:tech-9 @tierA @evidence', async ({ actors, stack }) => {
  for (const [i, size] of TIER_A.entries()) {
    const person = await actors.principal(i === 0 ? 'ada' : 'ben');
    const actor = await actors.anonymous('/login', { label: `${person.label}-${size.width}` });
    await actor.page.setViewportSize(size);
    await ui.waitForLoginCard(actor);
    await expectNoOAuth(actor);

    const fit = await actor.page.evaluate(() => {
      const form = document.querySelector('form[aria-label="Sign in"]');
      const submit = form?.querySelector('button[type="submit"]');
      const card = form?.closest('[data-login-card]');
      if (!form || !submit || !card) return null;
      const c = card.getBoundingClientRect();
      const s = submit.getBoundingClientRect();
      const hit = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
      return {
        overflowX: document.documentElement.scrollWidth - window.innerWidth,
        cardInside: c.left >= 0 && c.right <= window.innerWidth && c.top >= 0,
        submitTappable: !!hit && submit.contains(hit),
        submitBelowFold: s.bottom > window.innerHeight,
      };
    });
    expect(fit, `${size.width}x${size.height}: the card renders`).not.toBeNull();
    expect(fit, `${size.width}x${size.height}: the card fits and its submit is tappable`).toEqual({
      overflowX: 0,
      cardInside: true,
      submitTappable: true,
      submitBelowFold: false,
    });
    await actors.checkpoint(`login-card-${size.width}x${size.height}`);

    await ui.signInThroughCard(actor, person);
    await expect(actor.page, `${size.width}x${size.height}: sign-in completes`).toHaveURL(atPath('/'), { timeout: BOOT_TIMEOUT });
    await waitForShell(actor);
    expect((await me(actor, stack.baseUrl)).id).toBe(person.id);
  }
});

test('a failed session lookup shows data-app-state=degraded and retries in place, never redirecting @p:R10', async ({ actors }) => {
  const ben = await actors.open(await actors.principal('ben'));
  const ada = await actors.session(await actors.principal('ada'));
  await actors.requireDistinct(2);

  // The lookup answers the way the server does when D1 fails under it.
  let failed = 0;
  await ada.page.route(SERVER_FNS, async (route) => {
    failed += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ kind: 'unavailable' }) });
  });
  const navigations = recordNavigations(ada.page);
  const path = docPath();
  await ada.goto(path);

  const html = ada.page.locator('html');
  await expect(html, 'a failed lookup degrades the app').toHaveAttribute(APP_STATE_ATTR, 'degraded', { timeout: BOOT_TIMEOUT });
  await expect(ada.page.getByRole('status'), 'and says so').toContainText(/can.t reach/i);
  await expect.poll(() => failed, { message: 'the lookup retries on its own', timeout: BOOT_TIMEOUT }).toBeGreaterThanOrEqual(2);
  await expect(html, 'still degraded in place').toHaveAttribute(APP_STATE_ATTR, 'degraded');
  expect(new URL(ada.page.url()).pathname, 'no bounce to /login while degraded').toBe(path);

  await ada.page.unroute(SERVER_FNS);
  await waitForShell(ada);
  expect(new URL(ada.page.url()).pathname, 'the retry boots the same doc').toBe(path);
  expect([...new Set(navigations.map((url) => new URL(url).pathname))], 'every commit stayed on the doc: never redirected').toEqual([path]);
  await waitForShell(ben);
});
