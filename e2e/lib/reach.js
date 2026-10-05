// Tier A and Tier B reach (PRODUCT Viewports; T2.7): every control a person can see must be reachable and tappable.
// Self-contained so it survives page.evaluate serialization.

/**
 * Every visible control inside `scope` (the whole page when null) whose centre, once scrolled into view through the
 * scroll containers a person can scroll, lies outside the viewport or is covered by something else
 * (`elementFromPoint`, so a visible control that ignores pointer events counts as covered). Inert, aria-hidden, disabled,
 * invisible, fully transparent and sub-3px controls are skipped.
 * @param {{ scope: string | null }} arg
 * @returns {string[]}
 */
export function unreachableControls({ scope }) {
  const CONTROLS = [
    'button', 'a[href]', 'input:not([type=hidden])', 'select', 'textarea', '[role=button]', '[role=link]',
    '[role=menuitem]', '[role=menuitemradio]', '[role=menuitemcheckbox]', '[role=radio]', '[role=tab]',
    '[role=option]', '[role=switch]', '[role=checkbox]', '[role=combobox]',
  ].join(', ');
  /** @param {Element} el */
  const describe = (el) => {
    const name = el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 40);
    return `<${el.tagName.toLowerCase()}${el.getAttribute('role') ? ` role=${el.getAttribute('role')}` : ''}> "${name}"`;
  };
  /** @param {Element} el @param {'x' | 'y'} axis */
  const scrolls = (el, axis) => {
    const style = getComputedStyle(el);
    const overflow = axis === 'y' ? style.overflowY : style.overflowX;
    const room = axis === 'y' ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
    return /auto|scroll/.test(overflow) && room > 1;
  };
  /** Fully transparent, by itself or through an ancestor: not something a person sees. */
  const faded = (/** @type {Element} */ el) => {
    for (let at = /** @type {Element | null} */ (el); at; at = at.parentElement) if (getComputedStyle(at).opacity === '0') return true;
    return false;
  };
  /** Brings `el` to the middle of each ancestor a person can scroll; never scrolls an overflow:hidden clip. */
  const reveal = (/** @type {Element} */ el) => {
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      const scroller = parent === document.body || parent === document.documentElement ? null : parent;
      if (!scroller) continue;
      const box = scroller.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (scrolls(scroller, 'y')) scroller.scrollTop += r.top + r.height / 2 - (box.top + box.height / 2);
      if (scrolls(scroller, 'x')) scroller.scrollLeft += r.left + r.width / 2 - (box.left + box.width / 2);
    }
    const page = document.scrollingElement;
    if (page && getComputedStyle(document.body).overflow !== 'hidden' && getComputedStyle(document.documentElement).overflow !== 'hidden') {
      const r = el.getBoundingClientRect();
      window.scrollBy(r.left + r.width / 2 - window.innerWidth / 2, r.top + r.height / 2 - window.innerHeight / 2);
    }
  };
  const roots = scope ? [...document.querySelectorAll(scope)] : [document.body];
  if (roots.length === 0) return [`nothing matches ${scope}`];
  /** @type {string[]} */
  const found = [];
  const seen = new Set();
  for (const root of roots) {
    const candidates = [...(root.matches(CONTROLS) ? [root] : []), ...root.querySelectorAll(CONTROLS)];
    for (const el of candidates) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (el.closest('[inert], [aria-hidden="true"]') || el.matches(':disabled, [aria-disabled="true"]')) continue;
      if (getComputedStyle(el).visibility === 'hidden' || el.getClientRects().length === 0 || faded(el)) continue;
      const before = el.getBoundingClientRect();
      if (before.width < 3 || before.height < 3) continue;
      reveal(el);
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
        found.push(`${describe(el)} has its centre off-screen at (${Math.round(x)}, ${Math.round(y)})`);
        continue;
      }
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(el === hit || el.contains(hit))) {
        found.push(`${describe(el)} is covered at (${Math.round(x)}, ${Math.round(y)}) by ${hit ? describe(hit) : 'nothing'}`);
      }
    }
  }
  return found;
}

/**
 * Horizontal overflow of the page, and whether `selector`'s text fits its box (a label that is legible, not clipped).
 * @param {{ selector: string | null }} arg
 * @returns {{ overflowX: number, clipped: string[] }}
 */
export function layoutFit({ selector }) {
  const clipped = selector
    ? [...document.querySelectorAll(selector)]
        .filter((el) => el.getClientRects().length > 0 && el.scrollWidth > el.clientWidth + 1)
        .map((el) => (el.textContent ?? '').trim().slice(0, 40))
    : [];
  return { overflowX: document.documentElement.scrollWidth - window.innerWidth, clipped };
}
