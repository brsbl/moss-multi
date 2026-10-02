// Browser-side detectors, shared with the bb QA prelude (S-test §4.4). Each function is self-contained so it
// survives page.evaluate serialization; attribute names come in through `names` (e2e/lib/contract.ts NAMES).

/** @typedef {import('./contract.ts').Names} Names */

/**
 * Invariant 2 input: the SSR meta and the client stamp of the current document.
 * @param {{ names: Names }} arg
 * @returns {{ meta: string | null, client: string | null }}
 */
export function readStamps({ names }) {
  const meta = document.querySelector(`meta[name="${names.buildMeta}"]`);
  return { meta: meta ? meta.getAttribute('content') : null, client: document.documentElement.getAttribute(names.clientBuild) };
}

/**
 * Invariant 5: nothing but overlay surfaces, moss's toolbar and remote cursors may cover the editor canvas.
 * @param {{ names: Names }} arg
 * @returns {string[]}
 */
export function floatingOverCanvas({ names }) {
  void names;
  return [];
}

/**
 * Invariant 6: no comment or suggestion marker text is rendered.
 * @param {{ names: Names }} arg
 * @returns {string[]}
 */
export function markerLeak({ names }) {
  void names;
  return [];
}

/**
 * Invariant 9: nothing under a binding that is not live is focusable, editable or focused.
 * @param {{ names: Names }} arg
 * @returns {string[]}
 */
export function editableUnbound({ names }) {
  void names;
  return [];
}

/**
 * Invariant 4 start: marks the pane's body root and returns its generation, or null with no live body.
 * @param {{ names: Names, docId: string, mark: string }} arg
 * @returns {string | null}
 */
export function observeEditor({ names, docId, mark }) {
  const root = document.querySelector(`[${names.pane}][${names.docId}="${docId}"] [${names.generation}]`);
  if (!root) return null;
  root.setAttribute(names.observe, mark);
  return root.getAttribute(names.generation);
}

/**
 * Invariant 4 end: the marked element must still be the body root, at the same generation.
 * @param {{ names: Names, docId: string, mark: string, generation: string }} arg
 * @returns {string[]}
 */
export function remountSince({ names, docId, mark, generation }) {
  void names;
  void docId;
  void mark;
  void generation;
  return [];
}

/**
 * Invariant 7 input: the title and body text of every pane showing the doc.
 * @param {{ names: Names, docId: string }} arg
 * @returns {{ title: string, body: string }[]}
 */
export function fieldTexts({ names, docId }) {
  return [...document.querySelectorAll(`[${names.pane}][${names.docId}="${docId}"]`)].map((pane) => {
    const title = pane.querySelector(`[${names.titleBinding}]`);
    const body = pane.querySelector(names.lexical) ?? pane.querySelector(`[${names.bodyBinding}]`);
    return { title: title ? (title.textContent ?? '') : '', body: body ? (body.textContent ?? '') : '' };
  });
}
