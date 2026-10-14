// Node-family selectors and the computed-style properties compared per family (A§20), shared by the oracle parity
// (families.spec.ts) and the viewer's parity with the editor's read-only view (viewer.spec.ts).

/**
 * One selector per family (and per styled part of a compound family), matched inside the editor root. No H1: moss
 * lifts a note's first H1 into its title (A§12 keeps it as content), so the oracle's body has none to compare.
 */
export const FAMILY_SELECTORS: Record<string, string> = {
  paragraph: ':scope > p',
  'heading 2': 'h2',
  'heading 3': 'h3',
  'heading 4': 'h4',
  'bulleted list': 'ul.list-disc',
  'bulleted item': 'ul.list-disc > li:not([role])',
  'numbered list': 'ol',
  'numbered item': 'ol > li',
  'checklist item': 'li[role="checkbox"][aria-checked="false"]',
  'checked item': 'li[role="checkbox"][aria-checked="true"]',
  bold: 'p strong',
  italic: 'p em',
  underline: 'p .underline',
  strikethrough: 'p .line-through',
  'inline code': 'p code',
  link: 'p a[href]',
  quote: 'blockquote',
  table: 'table.moss-table',
  'table header cell': 'th.moss-table-cell-header',
  'table cell': 'td.moss-table-cell',
  callout: '.moss-callout',
  'callout header': '.moss-callout-header',
  tabs: '.moss-tab-group',
  'tab bar': '.moss-tab-bar',
  formula: '[data-formula-node-key]',
  'wiki link': '[data-file-link-node-key]',
  'embed pill': '[data-embed-pill-node-key]',
  'color code': '[data-color-node-key]',
  'code block': '.moss-codeblock-pre',
  chart: '[data-block-decorator-key]:has(> [aria-label="Insert paragraph before chart"]) > .editor-block-surface',
  canvas: '[data-block-decorator-key]:has(> [aria-label="Insert paragraph before canvas"]) > .editor-block-surface',
  'HTML block': '[data-lexical-decorator]:has([data-moss-html-preview-viewport])',
  divider: 'hr',
};

export const PROPERTIES = [
  'display', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
  'letter-spacing', 'text-decoration-line', 'text-transform', 'list-style-type', 'margin-top', 'margin-bottom',
  'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-width', 'border-top-style',
  'border-top-color', 'border-left-width', 'border-left-style', 'border-left-color', 'border-radius', 'opacity',
];

/**
 * The same families in a read-only render, which offers no insert-paragraph gaps (the read-only-media seam), so the
 * chart and canvas are found by what they hold.
 */
export const READ_ONLY_FAMILY_SELECTORS: Record<string, string> = {
  ...FAMILY_SELECTORS,
  chart: '[data-block-decorator-key]:not(:has(canvas)) > .editor-block-surface:has(> .editor-block-header)',
  canvas: '[data-block-decorator-key]:has(canvas)',
};
