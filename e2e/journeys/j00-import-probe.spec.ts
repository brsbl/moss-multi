// T0.9d diagnostic probe (temporary): what keeps WebKit's web process busy on a settled note with charts and HTML.
import { readFileSync } from 'node:fs';
import { test, ui } from '../lib/test.ts';

const fixtures = new URL('../../packages/sync/src/converter/fixtures/', import.meta.url);

for (const name of ['charts.md', 'composition.md', 'onboarding-getting-started.md', 'paragraphs.md']) {
  test(`probe: busy work on a settled ${name}`, async ({ actors, stack }) => {
    actors.solo('diagnostic probe');
    const actor = await actors.session(await actors.principal('probe'));
    await actor.page.addInitScript(() => {
      const counts = { raf: 0, resize: 0, mutation: 0, timeouts: 0 };
      (window as unknown as { __probe: typeof counts }).__probe = counts;
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => raf((time) => { counts.raf++; callback(time); });
      const RO = window.ResizeObserver;
      window.ResizeObserver = class extends RO { constructor(callback: ResizeObserverCallback) { super((entries, observer) => { counts.resize++; callback(entries, observer); }); } };
      const st = window.setTimeout.bind(window);
      window.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => { counts.timeouts++; return st(handler, ms, ...args); }) as typeof window.setTimeout;
    });
    await actor.page.route('https://**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '' }));
    const markdown = readFileSync(new URL(name, fixtures), 'utf8');
    const response = await actor.context.request.post('/api/docs', { headers: { origin: stack.baseUrl }, data: { title: name, markdown } });
    const { doc } = await response.json();
    await actor.goto(`/d/${doc.id}`);
    await ui.waitLive(actor, doc.id);
    await actor.page.waitForTimeout(5_000);
    const sample = async () => {
      const before = await actor.page.evaluate(() => ({ ...(window as unknown as { __probe: Record<string, number> }).__probe }));
      await actor.page.waitForTimeout(3_000);
      const after = await actor.page.evaluate(() => ({ ...(window as unknown as { __probe: Record<string, number> }).__probe }));
      return Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]));
    };
    const rates = await sample();
    const animations = await actor.page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').map((a) => {
      const target = (a.effect as KeyframeEffect | null)?.target as Element | null;
      const name = (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? a.id;
      return `${a.constructor.name}:${name} on ${target?.tagName.toLowerCase()}.${String(target?.className ?? '').slice(0, 60)} [${(target?.closest('[data-lexical-decorator], iframe, [class*="chart"]') as HTMLElement | null)?.className?.toString().slice(0, 40) ?? ''}]`;
    }));
    const iframes = await actor.page.evaluate(() => [...document.querySelectorAll('iframe')].map((f) => f.src.slice(0, 60)));
    test.info().annotations.push({ type: 'probe', description: `${name} per3s=${JSON.stringify(rates)} animations=${animations.length} ${JSON.stringify(animations.slice(0, 12))} iframes=${JSON.stringify(iframes)}` });
    for (const a of actors.list) { a.telemetry.pageErrors.length = 0; a.telemetry.console.length = 0; a.telemetry.failed.length = 0; a.telemetry.http.length = 0; }
  });
}
