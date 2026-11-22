// T9.48b: the app's `::highlight()` rules (comments, suggestions; styles.css) name the editor root. Chromium resolves
// an unscoped rule's highlight style on every element, which made restyling a 10,000-item check list three times as
// slow; on the root alone, the text inside inherits it (highlight inheritance). WebKit has no highlight inheritance
// and paints only rules that match the text's own element, so there each of those rules is added again for every
// element in the editor, which WebKit resolves only where a highlight paints.

const ROOT = '[data-lexical-editor]::highlight(';
const EACH = '[data-lexical-editor] *::highlight(';

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

/** Every rule of the page's stylesheets that styles a highlight on the editor root, again for each element in it. */
function rulesForEachElement(): string[] {
  const out: string[] = [];
  const visit = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        if (rule.selectorText.includes(ROOT)) out.push(`${rule.selectorText.split(ROOT).join(EACH)} { ${rule.style.cssText} }`);
      } else if ('cssRules' in rule) {
        visit((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      visit(sheet.cssRules);
    } catch {
      // a cross-origin sheet: none of the app's rules are in it
    }
  }
  return out;
}

/** Once, before the first highlight is painted: where the engine needs them, the rules for each element. */
export function scopeHighlights(): void {
  if (checked || typeof document === 'undefined' || !document.body) return;
  checked = true;
  if (inheritsHighlights()) return;
  const style = document.createElement('style');
  style.setAttribute('data-highlight-each', '');
  style.textContent = rulesForEachElement().join('\n');
  document.head.appendChild(style);
}
