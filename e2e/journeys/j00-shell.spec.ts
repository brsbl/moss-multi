// j00-shell (T0.5a): the real moss shell from the built Worker. Two principals boot it clean under the page CSP,
// every navigation carries the served build, light and dark switch through moss's own Settings, the floating
// detector bites on the live canvas, an HTML block frame's script runs under the CSP (SP13), and test-hook and
// playground paths are the unknown-route 404 (R7).
import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { Actor, Actors } from '../lib/actors.ts';
import { APP_STATE_ATTR, BUILD_META, CLIENT_BUILD_ATTR, EDITOR_CANVAS_ATTR } from '../lib/contract.ts';
import type { Principal } from '../lib/principals.ts';
import { expect, test } from '../lib/test.ts';

const SHELL = '[data-moss-app-shell]';
const BOOT_TIMEOUT = 30_000;

interface CspRecord { violations: { directive: string; blocked: string; source: string; sample: string }[]; themeAtDomReady: string | null }

/** Init script: records every securitypolicyviolation, and the theme the inline script set before hydration. */
function recordCsp(): void {
  const record: CspRecord = { violations: [], themeAtDomReady: null };
  (window as unknown as { __mossCsp: CspRecord }).__mossCsp = record;
  document.addEventListener(
    'securitypolicyviolation',
    (event) => record.violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI, source: event.sourceFile, sample: event.sample }),
    true,
  );
  document.addEventListener('DOMContentLoaded', () => {
    record.themeAtDomReady = document.documentElement.getAttribute('data-theme');
  });
}

const cspRecord = (page: Page): Promise<CspRecord | null> =>
  page.evaluate(() => (window as unknown as { __mossCsp?: CspRecord }).__mossCsp ?? null);

async function expectNoCspViolations(actor: Actor): Promise<void> {
  const record = await cspRecord(actor.page);
  expect(record, `${actor.label}: the CSP recorder is installed`).not.toBeNull();
  expect(record?.violations, `${actor.label}: securitypolicyviolation events`).toEqual([]);
}

async function waitForShell(actor: Actor): Promise<void> {
  await expect(actor.page.locator('html'), `${actor.label}: the moss shell boots`).toHaveAttribute(APP_STATE_ATTR, 'ready', { timeout: BOOT_TIMEOUT });
  await expect(actor.page.locator(SHELL), `${actor.label}: moss's AppShell renders`).toBeVisible();
}

/** A signed-in actor on a ready moss shell, with the CSP recorder installed before the first document. */
async function openShell(actors: Actors, principal: Principal, path = '/'): Promise<Actor> {
  const actor = await actors.session(principal);
  await actor.context.addInitScript(recordCsp);
  await actor.goto(path);
  await waitForShell(actor);
  return actor;
}

async function twoShells(actors: Actors): Promise<[Actor, Actor]> {
  const ada = await openShell(actors, await actors.principal('ada'));
  const ben = await openShell(actors, await actors.principal('ben'));
  await actors.requireDistinct(2);
  return [ada, ben];
}

const bodyBackground = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test('two principals boot the moss shell with no console errors, page errors or CSP violations', async ({ actors }) => {
  for (const actor of await twoShells(actors)) {
    const sheets = await actor.page.locator('head link[rel="stylesheet"]').evaluateAll((links) => links.map((link) => (link as HTMLLinkElement).href));
    expect(sheets.length, `${actor.label}: the SSR document links a stylesheet`).toBeGreaterThan(0);
    for (const href of sheets) {
      const response = await actor.page.request.get(href);
      expect(response.status(), href).toBe(200);
      expect(response.headers()['content-type'], href).toMatch(/^text\/css/);
    }
    expect(await bodyBackground(actor.page), `${actor.label}: moss's surface tokens style the body`).not.toBe('rgba(0, 0, 0, 0)');
    const inter = await actor.page.evaluate(async () => (await document.fonts.load('400 15px "Inter Variable"', 'Aa')).length);
    expect(inter, `${actor.label}: moss's Inter Variable face loads`).toBeGreaterThan(0);
    await expectNoCspViolations(actor);
  }
});

test('the build stamps equal /api/version on every navigation', async ({ actors, stack }) => {
  const version = await stack.assertProvenance();
  const expected = { meta: `${version.commit}:${version.bundleHash}`, client: `${version.commit}:${version.clientHash}` };
  const stamps = (page: Page) =>
    page.evaluate(
      ({ meta, client }) => ({
        meta: document.querySelector(`meta[name="${meta}"]`)?.getAttribute('content') ?? null,
        client: document.documentElement.getAttribute(client),
      }),
      { meta: BUILD_META, client: CLIENT_BUILD_ATTR },
    );
  for (const actor of await twoShells(actors)) {
    expect(await stamps(actor.page), `${actor.label} /`).toEqual(expected);
    await actor.page.reload();
    await waitForShell(actor);
    expect(await stamps(actor.page), `${actor.label} / after reload`).toEqual(expected);
    await actor.goto(`/d/${randomBytes(8).toString('hex')}`);
    await waitForShell(actor);
    expect(await stamps(actor.page), `${actor.label} /d/$docId`).toEqual(expected);
    await expectNoCspViolations(actor);
  }
});

test('light and dark switch through moss Settings and persist for that viewer only', async ({ actors }) => {
  const [ada, ben] = await twoShells(actors);
  const html = ada.page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'light');
  const light = await bodyBackground(ada.page);

  const choose = async (label: 'Light' | 'Dark') => {
    await ada.page.getByRole('button', { name: 'Settings', exact: true }).click();
    await ada.page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: label, exact: true }).click();
    await expect(html).toHaveAttribute('data-theme', label.toLowerCase());
    await ada.page.keyboard.press('Escape');
    await expect(ada.page.getByRole('radiogroup', { name: 'Theme' })).toBeHidden();
  };

  await choose('Dark');
  await expect.poll(() => bodyBackground(ada.page), { message: 'dark changes the surface' }).not.toBe(light);

  await ada.page.reload();
  await waitForShell(ada);
  await expect(html).toHaveAttribute('data-theme', 'dark');
  const record = await cspRecord(ada.page);
  expect(record?.themeAtDomReady, 'the inline theme script set dark before hydration, under the CSP').toBe('dark');
  await expect(ben.page.locator('html'), 'the other viewer keeps light').toHaveAttribute('data-theme', 'light');

  await choose('Light');
  await expect.poll(() => bodyBackground(ada.page), { message: 'light restores the surface' }).toBe(light);
  for (const actor of [ada, ben]) await expectNoCspViolations(actor);
});

test('the floating-chrome detector flags an overlay on the live canvas, then passes', async ({ actors }) => {
  const [ada] = await twoShells(actors);
  const canvases = ada.page.locator(`[${EDITOR_CANVAS_ATTR}]`);
  expect(await canvases.count(), 'the shell publishes its editor canvas').toBeGreaterThan(0);
  await expect(canvases.nth(0)).toBeVisible();
  await actors.checkpoint('before-overlay');

  await ada.page.evaluate(() => {
    const overlay = document.createElement('div');
    overlay.id = 'floating-control';
    overlay.textContent = 'floating control';
    Object.assign(overlay.style, { position: 'fixed', left: '45%', top: '40%', width: '25%', height: '25%', zIndex: '9999', background: 'gray' });
    document.body.append(overlay);
  });
  await expect(actors.checkpoint('overlay'), 'invariant 5 bites on the real canvas').rejects.toThrow(/invariant 5 \[ada\].*floating control/);

  await ada.page.evaluate(() => document.getElementById('floating-control')?.remove());
  await actors.checkpoint('after-overlay');
});

// SP13 settled no: a data: iframe inherits the page CSP, so its inline script is refused under the nonce policy.
// HTML blocks therefore load apps/web's /frame/html (A§22's default), whose own policy is only the sandbox.
const HTML_FRAME = { path: '/frame/html', ready: 'moss-html-frame-ready', content: 'moss-html-frame-content' };

test('SP13: an HTML block frame injected into the page runs its script under the page CSP', async ({ actors }) => {
  const [ada, ben] = await twoShells(actors);
  const response = await ada.page.reload();
  await waitForShell(ada);
  const policy = response?.headers()['content-security-policy'] ?? '';
  expect(policy, 'the document carries a per-request nonce').toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/_-]{16,}={0,2}'/);
  expect(policy, 'HTML block frames are same-origin documents').toMatch(/frame-src 'self'/);
  const frame = await ada.page.request.get(HTML_FRAME.path);
  expect(frame.headers()['content-security-policy'], 'the frame is an opaque-origin sandbox').toBe('sandbox allow-scripts');

  const ran = await ada.page.evaluate(
    ({ path, ready, content }) =>
      new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('timeout: the frame script never ran'), 5_000);
        const iframe = document.createElement('iframe');
        window.addEventListener('message', (event) => {
          if (event.source !== iframe.contentWindow) return;
          if (event.data?.type === ready) {
            const html = '<p>block</p><script>parent.postMessage("sp13:" + (6 * 7), "*")</script>';
            iframe.contentWindow?.postMessage({ type: content, html }, '*');
          } else if (typeof event.data === 'string' && event.data.startsWith('sp13:')) {
            clearTimeout(timer);
            resolve(event.data);
          }
        });
        iframe.id = 'sp13-frame';
        iframe.setAttribute('sandbox', 'allow-scripts');
        Object.assign(iframe.style, { position: 'absolute', left: '-9999px', width: '10px', height: '10px' });
        iframe.src = path;
        document.body.append(iframe);
      }),
    HTML_FRAME,
  );
  expect(ran, 'the block script ran').toBe('sp13:42');
  await ada.page.evaluate(() => document.getElementById('sp13-frame')?.remove());
  for (const actor of [ada, ben]) await expectNoCspViolations(actor);
});

test('test-hook and playground paths answer as the unknown route, a 404 @p:R7', async ({ actors }) => {
  const [ada] = await twoShells(actors);
  const paths = [`/no-such-route-${randomBytes(4).toString('hex')}`, '/__test/docs/doc-x/instance', '/__test/docs/doc-x/reset', '/playground'];
  const pages: string[] = [];
  for (const path of paths) {
    ada.expectHttp(404, path);
    const response = await ada.page.goto(path);
    expect(response?.status(), path).toBe(404);
    const contentType = response?.headers()['content-type'] ?? '';
    pages.push(JSON.stringify({ contentType, title: await ada.page.title(), text: await ada.page.locator('body').innerText() }));
  }
  expect(new Set(pages).size, `one 404 for ${paths.join(', ')}:\n${[...new Set(pages)].join('\n')}`).toBe(1);
});
