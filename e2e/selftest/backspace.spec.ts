// SP15: the j02 leg "a bare Backspace with no editable focus never navigates" must be able to fail. WebKit's Unix
// editing behavior never navigates back on Backspace, so the CI engine (Linux WebKit) cannot fail it; the proof and
// the leg run in macOS WebKit (`@macos`, the macos CI lane). Chromium has no such binding at all.
import type { Actor, Actors } from '../lib/actors.ts';
import * as ui from '../lib/ui.ts';
import { expect, test } from './fixtures.ts';

const MACOS = process.platform === 'darwin';

/** A page the user touched, then a second page, so history has a real entry to go back to. */
async function secondPage(actors: Actors, base: string, second: string): Promise<Actor> {
  const actor = await actors.anonymous(`${base}/clean.html?step=1`, { label: second });
  await actor.page.locator('#rows').click();
  await actor.goto(`${base}/${second}`);
  return actor;
}

test.describe('bare Backspace (SP15)', () => {
  test.skip(({ browserName }) => browserName !== 'webkit', 'only WebKit binds a bare Backspace to history');

  test('without the guard, macOS WebKit navigates back, so the leg can fail @macos', async ({ actors, server }) => {
    test.skip(!MACOS, 'Linux WebKit never navigates on Backspace; this proof runs in the macos lane');
    const actor = await secondPage(actors, server.url, 'clean.html?step=2');
    const result = await ui.bareBackspaceNavigates(actor);
    expect(result.navigated, `the leg must fail with the guard removed (stayed at ${result.to})`).toBe(true);
    expect(result.to).toContain('step=1');
  });

  test('Linux WebKit never navigates on a bare Backspace, so the leg belongs to the macos lane', async ({ actors, server }) => {
    test.skip(MACOS, 'the macOS proof is the test above');
    const actor = await secondPage(actors, server.url, 'clean.html?step=2');
    const result = await ui.bareBackspaceNavigates(actor);
    expect(result.navigated, 'Linux WebKit now navigates on Backspace: move the @macos legs back to the Linux engine').toBe(false);
  });

  test('with the guard, the URL holds @macos', async ({ actors, server }) => {
    const actor = await secondPage(actors, server.url, 'backspace-guard.html');
    const result = await ui.bareBackspaceNavigates(actor);
    expect(result.navigated, `moved to ${result.to}`).toBe(false);
  });
});
