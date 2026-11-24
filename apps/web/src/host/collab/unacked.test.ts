// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { allowUnload, markKept, markSession, markUnacked } from './unacked.ts';

const unloadAsks = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

it('a reload or tab close asks first while an edit is unacked, and never once all are acked', () => {
  const session = {};
  expect(unloadAsks()).toBe(false);
  markUnacked(session, true);
  expect(unloadAsks(), 'buffered edits would be lost').toBe(true);
  markUnacked(session, false);
  expect(unloadAsks()).toBe(false);
});

it('text offered back after a closed suggestion holds the unload guard until it is dismissed (T5.S16)', async () => {
  const { dismissUnsaved, offerUnsaved } = await import('./suggest/mode.ts');
  offerUnsaved('doc-kept', ['Draft line one. Dd4']);
  expect(unloadAsks(), 'the offered text lives only in this window').toBe(true);
  dismissUnsaved('doc-kept');
  expect(unloadAsks()).toBe(false);
  offerUnsaved('doc-full', [], true);
  expect(unloadAsks(), 'a no-room notice with nothing offered back holds nothing').toBe(false);
  dismissUnsaved('doc-full');
});

it('a sign-out or an in-app leave with offered-back text undismissed asks first or stays (T5.S16)', async () => {
  const { answerSignOut, needsSignOutConfirmation, prepareSignOut } = await import('../sign-out-guard.ts');
  const { departTo, LEAVE_UNSYNCED } = await import('../navigation.ts');
  const { refusalMessage } = await import('../refusal.ts');
  markKept('suggest-unsaved:doc-leave', true);
  try {
    const signOut = prepareSignOut();
    await Promise.resolve();
    expect(needsSignOutConfirmation(), 'sign-out asks before discarding the offered text').toBe(true);
    answerSignOut(false);
    expect(await signOut).toBe(false);
    await departTo('/f/folder');
    expect(refusalMessage(), 'the page stays and says why').toBe(LEAVE_UNSYNCED);
  } finally {
    markKept('suggest-unsaved:doc-leave', false);
  }
  expect(await prepareSignOut(), 'once dismissed, sign-out goes ahead').toBe(true);
});

it('an app-initiated leave that already settled its edits does not ask again, until the page is shown again', () => {
  const session = {};
  markUnacked(session, true);
  try {
    allowUnload();
    expect(unloadAsks()).toBe(false);
    window.dispatchEvent(new Event('pageshow'));
    expect(unloadAsks(), 'a page restored from the back-forward cache guards again').toBe(true);
  } finally { markUnacked(session, false); }
});

// Round 3: every leave, reload or sign-out the app starts decides after its last await (docs/history/LEARNINGS.md).
const KEY = 'suggest-unsaved:doc-race';
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** What the session's reply handler does for a suggestion refused while it was the last one unacked: the fork
 * offers its text back, then the session owes nothing more. */
function refusedDuringWait(session: object): void {
  markKept(KEY, true);
  markUnacked(session, false);
}
function cleanUp(session: object): void {
  markKept(KEY, false);
  markUnacked(session, false);
  window.dispatchEvent(new Event('pageshow'));
}

it('a refusal answered while a sign-out waits for acks offers text back: the sign-out asks first (T5.S16)', async () => {
  const { answerSignOut, needsSignOutConfirmation, prepareSignOut } = await import('../sign-out-guard.ts');
  const session = {};
  try {
    markUnacked(session, true);
    const signOut = prepareSignOut();
    await tick();
    refusedDuringWait(session);
    await tick();
    expect(needsSignOutConfirmation(), 'the text offered back during the wait is asked about').toBe(true);
    expect(unloadAsks(), 'the browser guard is still armed').toBe(true);
    answerSignOut(false);
    expect(await signOut).toBe(false);
  } finally { cleanUp(session); }
});

it('a refusal answered while an in-app leave waits for acks offers text back: the page stays (T5.S16)', async () => {
  const { departTo, LEAVE_UNSYNCED } = await import('../navigation.ts');
  const { refusalMessage } = await import('../refusal.ts');
  const session = {};
  try {
    markUnacked(session, true);
    const leave = departTo('/f/folder');
    await tick();
    refusedDuringWait(session);
    await leave;
    expect(unloadAsks(), 'the page did not leave: the browser guard is still armed').toBe(true);
    expect(refusalMessage(), 'the page stays and says why').toBe(LEAVE_UNSYNCED);
  } finally { cleanUp(session); }
});

it("an app-started reload waits while offered-back text is undismissed, also once the note's last session is gone (T5.S16)", async () => {
  const { recoverChunk, reloadOnce } = await import('../ChunkReloadBoundary.tsx');
  const session = {};
  const reload = vi.fn();
  const version = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', version);
  try {
    markSession(session, true);
    markKept(KEY, true);
    // The pane is released: no session is open and none owes an ack, but the offered text is still here.
    markSession(session, false);
    expect(reloadOnce(20_000, null, reload), 'a stale-chunk reload is held back').toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(await recoverChunk(), 'chunk recovery does not reload either').toBe(false);
    expect(version, 'it says so instead of checking the version').not.toHaveBeenCalled();
    markKept(KEY, false);
    expect(reloadOnce(40_000, null, reload), 'once dismissed, the reload happens as before').toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
    markSession(session, false);
    cleanUp(session);
  }
});

it('a leave or reload the app starts with offered-back text undismissed keeps the browser guard armed, so the person is asked (T5.S16)', async () => {
  const { leaveTo, reloadDocument } = await import('../navigation.ts');
  const session = {};
  try {
    markKept(KEY, true);
    leaveTo('/login?next=%2F');
    expect(unloadAsks(), 'a leave the app starts asks first').toBe(true);
    reloadDocument();
    expect(unloadAsks(), 'a reload the app starts asks first').toBe(true);
  } finally { cleanUp(session); }
});

it('text the person chose to discard at the sign-out confirm is not asked about again; text offered back after it is (T5.S16)', async () => {
  const { answerSignOut, prepareSignOut } = await import('../sign-out-guard.ts');
  const { leaveTo } = await import('../navigation.ts');
  const session = {};
  try {
    markKept(KEY, true);
    const signOut = prepareSignOut();
    await tick();
    answerSignOut(true);
    expect(await signOut).toBe(true);
    leaveTo('/login');
    expect(unloadAsks(), 'the person already chose to discard it').toBe(false);
    window.dispatchEvent(new Event('pageshow'));
    markKept(`${KEY}-later`, true);
    leaveTo('/login');
    expect(unloadAsks(), 'text offered back since was never asked about').toBe(true);
  } finally {
    markKept(`${KEY}-later`, false);
    cleanUp(session);
  }
});

it('text offered back again on the same note after a discard at the sign-out confirm is asked about (T5.S16)', async () => {
  const { answerSignOut, prepareSignOut } = await import('../sign-out-guard.ts');
  const { leaveTo } = await import('../navigation.ts');
  const session = {};
  try {
    markKept(KEY, true);
    const signOut = prepareSignOut();
    await tick();
    answerSignOut(true);
    expect(await signOut).toBe(true);
    // A refusal during the sign-out's request offers more text back under the same note's key.
    markKept(KEY, true);
    leaveTo('/login');
    expect(unloadAsks(), 'the new text was never asked about').toBe(true);
  } finally { cleanUp(session); }
});
