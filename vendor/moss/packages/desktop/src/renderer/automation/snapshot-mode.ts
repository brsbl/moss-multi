// ported-from: packages/desktop/src/renderer/automation/snapshot-mode.ts @ 762abb777
// Visual-snapshot harness support. None of this code runs in production:
// every entry point is gated on `window.__MOSS_AUTOMATION_ENABLED__`.
//
// The harness toggles `data-moss-snapshot="true"` on <html> + injects a global
// determinism stylesheet. Editor plugins observe this flag to short-circuit
// non-deterministic paths (typeahead debounce, IPC-driven file-link title
// resolution). When the last visible CodeBlockNode finishes its initial
// Prism highlight pass, it fires a `moss:codeblock-ready` event the harness
// can wait on before capturing.

import type {
  SnapshotFileLinkFixtureEntry,
  SnapshotFixtureData
} from '../../common/automation';

const SNAPSHOT_ATTR = 'data-moss-snapshot';
const SNAPSHOT_STYLE_ID = 'moss-snapshot-determinism-style';
const SNAPSHOT_FIXTURE_KEY = '__MOSS_SNAPSHOT_FIXTURE__';
const SNAPSHOT_EVENT_READY = 'moss:codeblock-ready';

// Global CSS injected when snapshot mode is on. Hides caret, freezes all
// blink/animations/transitions, and hides webkit scrollbars (overlay
// scrollbars on macOS are non-deterministic across runs).
const DETERMINISM_CSS = `
*, *::before, *::after {
  animation-play-state: paused !important;
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition: none !important;
  caret-color: transparent !important;
}
::-webkit-scrollbar { display: none !important; }
html, body { scrollbar-width: none !important; }
`;

type SnapshotState = {
  enabled: boolean;
  fixture: SnapshotFixtureData;
};

const state: SnapshotState = {
  enabled: false,
  fixture: {},
};

const fileLinkIndex = new Map<string, SnapshotFileLinkFixtureEntry>();

const rebuildFileLinkIndex = (fixture: SnapshotFixtureData): void => {
  fileLinkIndex.clear();
  for (const entry of fixture.fileLinks ?? []) {
    if (entry?.href) {
      fileLinkIndex.set(entry.href, entry);
    }
  }
};

export const isSnapshotModeEnabled = (): boolean => state.enabled;

export const getSnapshotFileLinkFixture = (
  href: string
): SnapshotFileLinkFixtureEntry | null => {
  return fileLinkIndex.get(href) ?? null;
};

/**
 * Mark a CodeBlock as ready (initial highlight applied). The harness uses
 * `waitForCodeblocksReady` to wait until every mounted code block has fired
 * this event at least once. Cheap when snapshot mode is off (caller short-
 * circuits via isSnapshotModeEnabled).
 */
export const markCodeblockReady = (key: string): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(SNAPSHOT_EVENT_READY, { detail: { key } })
  );
};

export const enableSnapshotMode = (fixture?: SnapshotFixtureData): void => {
  if (typeof document === 'undefined') return;
  state.enabled = true;
  state.fixture = fixture ?? {};
  rebuildFileLinkIndex(state.fixture);
  document.documentElement.setAttribute(SNAPSHOT_ATTR, 'true');
  const existing = document.getElementById(SNAPSHOT_STYLE_ID);
  if (!existing) {
    const style = document.createElement('style');
    style.id = SNAPSHOT_STYLE_ID;
    style.textContent = DETERMINISM_CSS;
    document.head.appendChild(style);
  }
  // Make the fixture available to non-React modules that prefer reading
  // from a global rather than threading the controller down.
  (window as unknown as Record<string, unknown>)[SNAPSHOT_FIXTURE_KEY] =
    state.fixture;
};

export const disableSnapshotMode = (): void => {
  if (typeof document === 'undefined') return;
  state.enabled = false;
  state.fixture = {};
  fileLinkIndex.clear();
  document.documentElement.removeAttribute(SNAPSHOT_ATTR);
  document.getElementById(SNAPSHOT_STYLE_ID)?.remove();
  delete (window as unknown as Record<string, unknown>)[SNAPSHOT_FIXTURE_KEY];
};

/**
 * Resolves when every DOM-attached CodeBlock has finished its initial
 * highlight pass. The invariant: each rendered code block carries
 * `data-codeblock` (its lexical node key) and, in snapshot mode, the same
 * element carries `data-codeblock-pending="true"` until the highlighted
 * HTML lands in the DOM, at which point CodeBlockNode swaps it for
 * `data-codeblock-ready="true"`. We wait for two consecutive frames where
 * no `data-codeblock` element is still pending. Two stable frames cover the
 * case where a block has just mounted but not yet run its effect.
 */
export const waitForCodeblocksReady = (timeoutMs = 5000): Promise<boolean> => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const startedAt = performance.now();
    let stableFrames = 0;
    const tick = () => {
      const blocks = document.querySelectorAll('[data-codeblock]');
      let pending = 0;
      for (const block of Array.from(blocks)) {
        if (block.getAttribute('data-codeblock-ready') !== 'true') {
          pending += 1;
        }
      }
      if (pending === 0) {
        stableFrames += 1;
        if (stableFrames >= 2) {
          resolve(true);
          return;
        }
      } else {
        stableFrames = 0;
      }
      if (performance.now() - startedAt > timeoutMs) {
        resolve(false);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

export const SNAPSHOT_INTERNALS = {
  SNAPSHOT_ATTR,
  SNAPSHOT_STYLE_ID,
  SNAPSHOT_EVENT_READY,
} as const;
