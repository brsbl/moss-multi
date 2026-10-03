// j07-auth (T0.10): email and password on the moss-styled login card. Sign-up lands in the Home vault shell,
// sign-out from Settings goes to the card, sign-in returns to the doc `next` names (and never off the site), a wrong
// password says so, no OAuth button renders, the card works at both Tier A widths, and a session lookup that fails
// or hangs degrades in place (R10).
import { randomBytes } from 'node:crypto';
import type { Page, Request, Route } from '@playwright/test';
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

type Fulfilment = Parameters<Route['fulfill']>[0];

/**
 * The stack's own answer to this session lookup sent with no cookie: Start's serialized `{kind:'signed-out'}`
 * (`x-tss-serialized`), which the page decodes like any real answer; Start decodes a bare JSON body as undefined.
 * `unavailable` swaps the kind, giving what the server sends when D1 fails under it.
 */
async function serverAnswer(request: Request, kind: 'signed-out' | 'unavailable'): Promise<Fulfilment> {
  const response = await fetch(request.url(), {
    headers: { 'x-tsr-serverfn': 'true', accept: request.headers().accept ?? 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.text();
  if (!response.ok || response.headers.get('x-tss-serialized') !== 'true' || body.split('"signed-out"').length !== 2) {
    throw new Error(`no serialized signed-out answer from ${request.url()}: ${response.status} ${body.slice(0, 300)}`);
  }
  return {
    status: 200,
    headers: { 'content-type': response.headers.get('content-type') ?? 'application/json', 'x-tss-serialized': 'true' },
    body: body.replace('"signed-out"', JSON.stringify(kind)),
  };
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

// `next` values that pass a same-origin check but normalize to a protocol-relative `//host` once their dot segments
// go (a backslash is a slash): returning to one would leave the site.
const ESCAPING_NEXT = ['/x/..//example.invalid/phish', '/.//example.invalid/phish', '/%2e%2e//example.invalid/phish', '/a/../\\example.invalid/phish'];

test('a next that would leave the site returns to / instead, after sign-in and when already signed in @p:ppl-1', async ({ actors, stack }) => {
  const home = new URL('/', stack.baseUrl).href;
  const [adaPerson, benPerson] = [await actors.principal('ada'), await actors.principal('ben')];

  const ada = await actors.anonymous(`/login?next=${encodeURIComponent(ESCAPING_NEXT[0])}`, { label: 'ada' });
  await ui.waitForLoginCard(ada);
  await ui.signInThroughCard(ada, adaPerson);
  await expect(ada.page, 'sign-in returns to / on this site, not to another host').toHaveURL(home, { timeout: BOOT_TIMEOUT });
  await waitForShell(ada);

  const ben = await actors.open(benPerson);
  for (const next of ESCAPING_NEXT) {
    // A redirect off the site fails to load and goto rejects; where it went is the evidence either way.
    const landed = await ben.page.goto(`/login?next=${encodeURIComponent(next)}`).then(
      (response) => response?.url() ?? null,
      (error: Error) => error.message,
    );
    expect(landed, `${next}: someone already signed in is sent to / on this site`).toBe(home);
    await waitForShell(ben);
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
    // moss's Button fades in from disabled:opacity-50 as the card hydrates; the evidence shot waits it out.
    await expect(ui.loginForm(actor).getByRole('button', { name: 'Sign in', exact: true })).toHaveCSS('opacity', '1');
    await expect(actor.page.getByRole('button', { name: 'Create an account', exact: true })).toHaveCSS('opacity', '1');
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

  // Each lookup fails a different way, in turn: a refused request (Start's fetcher throws), an error page served as
  // 200, and the server's own answer when D1 fails under it. A 5xx or a network abort would itself fail invariant 1.
  const FAILURES: ((route: Route) => Promise<Fulfilment>)[] = [
    async () => ({ status: 429, contentType: 'text/plain', body: 'Too many requests' }),
    async () => ({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Error</title><p>Something went wrong.</p>' }),
    (route) => serverAnswer(route.request(), 'unavailable'),
  ];
  ada.expectHttp(429, /^\/_serverFn\//);
  let failed = 0;
  await ada.page.route(SERVER_FNS, async (route) => {
    await route.fulfill(await FAILURES[failed % FAILURES.length](route));
    failed += 1;
  });
  const navigations = recordNavigations(ada.page);
  const path = docPath();
  await ada.goto(path);

  const html = ada.page.locator('html');
  await expect(html, 'a failed lookup degrades the app').toHaveAttribute(APP_STATE_ATTR, 'degraded', { timeout: BOOT_TIMEOUT });
  await expect(ada.page.getByRole('status'), 'and says so').toContainText(/can.t reach/i);
  await expect
    .poll(() => failed, { message: 'the lookup retries on its own through every kind of failure', timeout: BOOT_TIMEOUT })
    .toBeGreaterThanOrEqual(FAILURES.length);
  await expect(html, 'still degraded in place').toHaveAttribute(APP_STATE_ATTR, 'degraded');
  expect(new URL(ada.page.url()).pathname, 'no bounce to /login while degraded').toBe(path);

  // "Try again" asks at once; the automatic retry after the third failure waits 4 s and after the fourth 8 s.
  const tryAgain = ada.page.getByRole('status').getByRole('button', { name: 'Try again', exact: true });
  const before = failed;
  await tryAgain.click();
  await expect.poll(() => failed, { message: 'Try again retries the lookup at once', timeout: 2_000 }).toBeGreaterThan(before);
  await expect(html, 'and stays degraded while it fails').toHaveAttribute(APP_STATE_ATTR, 'degraded');

  await ada.page.unroute(SERVER_FNS);
  await tryAgain.click();
  await waitForShell(ada);
  expect(new URL(ada.page.url()).pathname, 'the retry boots the same doc').toBe(path);
  expect([...new Set(navigations.map((url) => new URL(url).pathname))], 'every commit stayed on the doc: never redirected').toEqual([path]);
  await waitForShell(ben);
});

test('a session lookup that never answers degrades in place, asks again and boots the same doc @p:R10', async ({ actors }) => {
  const ben = await actors.open(await actors.principal('ben'));
  const adaPerson = await actors.principal('ada');
  const ada = await actors.session(adaPerson);
  await actors.requireDistinct(2);

  // The first lookup hangs (a stalled Worker or D1 read). Later ones fail until the leg lets them through, and the
  // hung one is answered last with a stale "signed out" that must not undo the boot.
  let hung: Route | null = null;
  let failing = true;
  let asked = 0;
  await ada.page.route(SERVER_FNS, async (route) => {
    asked += 1;
    if (!hung) {
      hung = route;
      return;
    }
    if (failing) await route.fulfill(await serverAnswer(route.request(), 'unavailable'));
    else await route.continue();
  });
  const navigations = recordNavigations(ada.page);
  const path = docPath();
  await ada.goto(path);

  const html = ada.page.locator('html');
  await expect(html, 'a lookup that never answers degrades the app').toHaveAttribute(APP_STATE_ATTR, 'degraded', { timeout: BOOT_TIMEOUT });
  await expect(ada.page.getByRole('status'), 'and says so').toContainText(/can.t reach/i);
  await expect
    .poll(() => asked, { message: 'it asks again with a new request while the first still hangs', timeout: BOOT_TIMEOUT })
    .toBeGreaterThanOrEqual(2);
  expect(new URL(ada.page.url()).pathname, 'no bounce to /login while degraded').toBe(path);

  failing = false;
  await ada.page.getByRole('status').getByRole('button', { name: 'Try again', exact: true }).click();
  await waitForShell(ada);
  expect(new URL(ada.page.url()).pathname, 'the retry boots the same doc').toBe(path);

  const stale = hung as Route | null;
  if (!stale) throw new Error('the first lookup was never held');
  const request: Request = stale.request();
  const finished = ada.page.waitForEvent('requestfinished', { predicate: (r) => r === request, timeout: 10_000 });
  await stale.fulfill(await serverAnswer(request, 'signed-out'));
  await finished;
  await ada.page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await expect(html, 'the stale answer changes nothing').toHaveAttribute(APP_STATE_ATTR, 'ready');
  expect(new URL(ada.page.url()).pathname).toBe(path);
  const settings = await ui.openSettings(ada);
  await expect(settings.getByText(adaPerson.email, { exact: true }), 'the stale "signed out" leaves ada signed in').toBeVisible();
  expect([...new Set(navigations.map((url) => new URL(url).pathname))], 'every commit stayed on the doc: never redirected').toEqual([path]);
  await waitForShell(ben);
});
