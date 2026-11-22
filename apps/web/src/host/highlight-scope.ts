// T9.48b: the app's `::highlight()` rules (comments, suggestions; styles.css) name the editor root. Chromium resolves
// an unscoped rule's highlight style on every element, which made restyling a 10,000-item check list three times as
// slow; on the root alone, the text inside inherits it (highlight inheritance). WebKit has no highlight inheritance
// and paints only rules that match the text's own element, so there `html[data-highlight-each]` turns on the same
// rules for every element in the editor, which it resolves only where a highlight paints.

/** On `<html>` when the engine paints a highlight only from rules that match the text's own element. */
export const HIGHLIGHT_EACH_ATTR = 'data-highlight-each';

let checked = false;

/** Whether a highlight style set on an element reaches its descendants' text. */
function inheritsHighlights(): boolean {
  const style = document.createElement('style');
  style.textContent = '[data-highlight-probe]::highlight(moss-highlight-probe) { background-color: rgb(1, 2, 3); }';
  const host = document.createElement('div');
  host.setAttribute('data-highlight-probe', '');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden';
  const child = document.createElement('span');
  child.textContent = 'x';
  host.appendChild(child);
  document.head.appendChild(style);
  document.body.appendChild(host);
  try {
    return getComputedStyle(child, '::highlight(moss-highlight-probe)').backgroundColor === 'rgb(1, 2, 3)';
  } catch {
    return false;
  } finally {
    host.remove();
    style.remove();
  }
}

/** Sets HIGHLIGHT_EACH_ATTR once, before the first highlight is painted, where the engine needs it. */
export function scopeHighlights(): void {
  if (checked || typeof document === 'undefined' || !document.body) return;
  checked = true;
  if (!inheritsHighlights()) document.documentElement.setAttribute(HIGHLIGHT_EACH_ATTR, '');
}
