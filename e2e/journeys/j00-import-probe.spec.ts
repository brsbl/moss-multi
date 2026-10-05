// T0.9d diagnostic probe (temporary): does a fetch in flight across a reload log WebKit's "Fetch API cannot load
// ... due to access control checks", and does aborting it at pagehide or beforeunload prevent that?
import { test } from '../lib/test.ts';

for (const mode of ['none', 'pagehide', 'beforeunload']) {
  test(`probe: fetch across a reload, abort on ${mode}`, async ({ actors }) => {
    actors.solo('diagnostic probe');
    const actor = await actors.open(await actors.principal('probe'));
    const errors: string[] = [];
    actor.page.on('pageerror', (error) => errors.push(error.message));
    const consoleErrors: string[] = [];
    actor.page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    for (let i = 0; i < 15; i++) {
      await actor.page.evaluate((mode) => {
        const controller = new AbortController();
        if (mode !== 'none') addEventListener(mode, () => controller.abort(), { once: true });
        for (let n = 0; n < 8; n++) fetch(`/api/workspace?probe=${n}`, { signal: controller.signal }).catch(() => undefined);
      }, mode);
      await actor.page.reload();
      await actor.page.locator('html[data-app-state="ready"]').waitFor({ state: 'attached' });
    }
    test.info().annotations.push({ type: 'probe', description: `mode=${mode} pageerrors=${errors.length} consoleErrors=${consoleErrors.length} ${JSON.stringify(errors.slice(0, 2))} ${JSON.stringify(consoleErrors.slice(0, 2))}` });
    // The census is a diagnostic here; clear what this probe induced so the run reports its numbers.
    for (const a of actors.list) { a.telemetry.pageErrors.length = 0; a.telemetry.console.length = 0; a.telemetry.failed.length = 0; }
  });
}
