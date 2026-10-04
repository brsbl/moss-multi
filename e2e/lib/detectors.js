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
  /** @param {Element} el */
  const describe = (el) =>
    `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${[...el.attributes].filter((a) => a.name !== 'style').map((a) => ` ${a.name}${a.value ? `="${a.value.slice(0, 40)}"` : ''}`).join('')}> "${(el.textContent ?? '').trim().slice(0, 40)}"`;
  const allowed = [names.overlay, names.toolbar, ...names.remote].map((name) => `[${name}]`).join(', ');
  const found = new Set();
  for (const canvas of document.querySelectorAll(`[${names.canvas}]`)) {
    const r = canvas.getBoundingClientRect();
    const left = Math.max(r.left, 0);
    const top = Math.max(r.top, 0);
    const right = Math.min(r.right, window.innerWidth);
    const bottom = Math.min(r.bottom, window.innerHeight);
    if (right - left < 2 || bottom - top < 2) continue;
    for (let i = 0; i < 9; i += 1) {
      for (let j = 0; j < 9; j += 1) {
        const x = left + ((right - left) * (i + 0.5)) / 9;
        const y = top + ((bottom - top) * (j + 0.5)) / 9;
        const hit = document.elementFromPoint(x, y);
        if (!hit || canvas.contains(hit) || hit.closest(allowed)) continue;
        found.add(`${describe(hit)} covers the canvas at (${Math.round(x)}, ${Math.round(y)})`);
      }
    }
    for (const chrome of document.querySelectorAll(`[${names.collabChrome}]`)) {
      const c = chrome.getBoundingClientRect();
      if (c.width === 0 || c.height === 0) continue;
      if (c.left < r.right && c.right > r.left && c.top < r.bottom && c.bottom > r.top) {
        found.add(`collab chrome ${describe(chrome)} intersects the canvas`);
      }
    }
  }
  return [...found];
}

/**
 * Invariant 6: no comment or suggestion marker text is rendered.
 * @param {{ names: Names }} arg
 * @returns {string[]}
 */
export function markerLeak({ names }) {
  const marker = /%%?m:[^%\s]{1,64}:(start|end)%%?/;
  const texts = [['the page', document.body.innerText]];
  for (const el of document.querySelectorAll(`[${names.titleBinding}]`)) texts.push(['a title', el.textContent ?? '']);
  for (const el of document.querySelectorAll(`[${names.sidebarRow}]`)) texts.push(['a sidebar row', el.textContent ?? '']);
  return texts.flatMap(([where, text]) => {
    const match = marker.exec(text);
    return match ? [`marker "${match[0]}" rendered in ${where}`] : [];
  });
}

/**
 * Invariant 9: nothing under a binding that is not live is focusable, editable or focused.
 * @param {{ names: Names }} arg
 * @returns {string[]}
 */
export function editableUnbound({ names }) {
  const focusable = 'a[href], button, input, select, textarea, iframe, summary, [tabindex]';
  const found = [];
  for (const attr of [names.titleBinding, names.bodyBinding]) {
    for (const field of document.querySelectorAll(`[${attr}]`)) {
      const state = field.getAttribute(attr);
      if (state === 'live') continue;
      const where = `[${attr}="${state}"]`;
      for (const el of [field, ...field.querySelectorAll('*')]) {
        const html = /** @type {HTMLElement} */ (el);
        if (html.isContentEditable) found.push(`${where}: <${el.tagName.toLowerCase()}> is editable`);
        else if (el.matches(focusable) && !el.matches(':disabled')) {
          found.push(`${where}: <${el.tagName.toLowerCase()}> is focusable`);
        }
      }
      if (document.activeElement && field.contains(document.activeElement)) found.push(`${where}: holds focus`);
    }
  }
  return found;
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
 * Invariant 4 end: while the pane is open, the marked element must still be its body root, at the same generation.
 * @param {{ names: Names, docId: string, mark: string, generation: string }} arg
 * @returns {string[]}
 */
export function remountSince({ names, docId, mark, generation }) {
  const pane = document.querySelector(`[${names.pane}][${names.docId}="${docId}"]`);
  if (!pane) return []; // the pane closed (a note switch); a pane that comes back has no mark
  const root = pane.querySelector(`[${names.generation}]`);
  if (!root) return [`${docId}: the body root is gone`];
  const found = [];
  if (root.getAttribute(names.observe) !== mark) found.push(`${docId}: the body root is a new element (React remount)`);
  const now = root.getAttribute(names.generation);
  if (now !== generation) found.push(`${docId}: editor generation ${generation} -> ${now}`);
  return found;
}

/**
 * Invariant 7 input: the title and body text of every pane showing the doc.
 * @param {{ names: Names, docId: string }} arg
 * @returns {{ title: string, body: string }[]}
 */
export function fieldTexts({ names, docId }) {
  return [...document.querySelectorAll(`[${names.pane}][${names.docId}="${docId}"]`)].map((pane) => {
    const title = pane.querySelector(`[${names.titleBinding}]`);
    // The bound root carries the binding attribute; moss also marks its editor wrapper `data-lexical-editor`.
    const body = pane.querySelector(`[${names.bodyBinding}]`) ?? pane.querySelector(names.lexical);
    return { title: title ? (title.textContent ?? '') : '', body: body ? (body.textContent ?? '') : '' };
  });
}
