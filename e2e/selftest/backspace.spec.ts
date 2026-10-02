// SP15: the j02 leg "a bare Backspace with no editable focus never navigates" must be able to fail on the CI
// engine. With the guard removed WebKit goes back in history; with it the URL holds. Chromium has no such binding.
import * as ui from '../lib/ui.ts';
import { expect, test } from './fixtures.ts';

test.describe('bare Backspace (SP15)', () => {
  test.skip(({ browserName }) => browserName !== 'webkit', 'only WebKit binds a bare Backspace to history');

  test('without the guard, WebKit navigates back and the leg fails', async ({ actors, server }) => {
    const actor = await actors.anonymous(`${server.url}/clean.html?step=1`, { label: 'unguarded' });
    await actor.goto(`${server.url}/clean.html?step=2`);
    const result = await ui.bareBackspaceNavigates(actor);
    expect(result.navigated, `the leg must fail with the guard removed (stayed at ${result.to})`).toBe(true);
    expect(result.to).toContain('step=1');
  });

  test('with the guard, the URL holds', async ({ actors, server }) => {
    const actor = await actors.anonymous(`${server.url}/clean.html?step=1`, { label: 'guarded' });
    await actor.goto(`${server.url}/backspace-guard.html`);
    const result = await ui.bareBackspaceNavigates(actor);
    expect(result.navigated, `moved to ${result.to}`).toBe(false);
  });
});
