// T0.9d diagnostic probe (temporary): which fetches log WebKit's "Fetch API cannot load ... due to access control
// checks" across a reload, and does stopping new requests at beforeunload or pagehide prevent it?
import { test } from '../lib/test.ts';

for (const mode of ['inflight', 'polling', 'polling-beforeunload', 'polling-pagehide']) {
  test(`probe: fetch across a reload, ${mode}`, async ({ actors }) => {
    actors.solo('diagnostic probe');
    const actor = await actors.open(await actors.principal('probe'));
    const errors: string[] = [];
    actor.page.on('pageerror', (error) => errors.push(error.message));
    const consoleErrors: string[] = [];
    actor.page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    for (let i = 0; i < 15; i++) {
      await actor.page.evaluate((mode) => {
        let stopped = false;
        if (mode.endsWith('beforeunload')) addEventListener('beforeunload', () => { stopped = true; });
        if (mode.endsWith('pagehide')) addEventListener('pagehide', () => { stopped = true; });
        const go = () => { if (!stopped) void fetch(`/api/workspace?probe=${Math.random()}`).catch(() => undefined); };
        if (mode === 'inflight') for (let n = 0; n < 8; n++) go();
        else setInterval(go, 5);
      }, mode);
      await actor.page.waitForTimeout(50);
      await actor.page.reload();
      await actor.page.locator('html[data-app-state="ready"]').waitFor({ state: 'attached' });
    }
    test.info().annotations.push({ type: 'probe', description: `mode=${mode} pageerrors=${errors.length} consoleErrors=${consoleErrors.length} ${JSON.stringify(errors.slice(0, 2))} ${JSON.stringify(consoleErrors.slice(0, 2))}` });
    // The census is a diagnostic here; clear what this probe induced so the run reports its numbers.
    for (const a of actors.list) { a.telemetry.pageErrors.length = 0; a.telemetry.console.length = 0; a.telemetry.failed.length = 0; }
  });
}
