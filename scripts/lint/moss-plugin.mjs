// Repo lint rules (scoped in eslint.config.mjs).
//   no-raw-color             packages/ui uses moss tokens, never color literals
//   no-contenteditable-pick  e2e never picks an editable by position; [contenteditable=true].first() is the title
//   no-historic-tag          @lexical/yjs drops HISTORIC_TAG updates without replicating them

const RAW_COLOR = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix|color)\(/i;
const CONTENTEDITABLE = /contenteditable/i;
const PICKS = new Set(['first', 'last', 'nth']);

const stringValue = (node) => {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('');
  return null;
};

const noRawColor = {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid raw color literals; use moss tokens (surface, ink, accent, border, highlight)' },
    messages: { raw: 'Raw color "{{ text }}"; use a moss token class or variable instead.' },
    schema: [],
  },
  create(context) {
    const check = (node, text) => {
      const match = typeof text === 'string' ? RAW_COLOR.exec(text) : null;
      if (match) context.report({ node, messageId: 'raw', data: { text: match[0] } });
    };
    return {
      Literal: (node) => check(node, node.value),
      TemplateElement: (node) => check(node, node.value.cooked ?? node.value.raw),
    };
  },
};

const noContenteditablePick = {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid positional picks among contenteditable elements in e2e' },
    messages: {
      pick: 'Positional pick on a contenteditable locator; the first one is the title. Target a DOM-contract attribute (data-body-binding, data-title-binding).',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== 'MemberExpression' || callee.property.type !== 'Identifier') return;
        if (!PICKS.has(callee.property.name) || callee.object.type !== 'CallExpression') return;
        const selectors = callee.object.arguments.map(stringValue);
        if (selectors.some((selector) => selector !== null && CONTENTEDITABLE.test(selector))) {
          context.report({ node, messageId: 'pick' });
        }
      },
    };
  },
};

const noHistoricTag = {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid HISTORIC_TAG; exclude updates from undo with a dedicated origin instead' },
    messages: {
      historic: 'HISTORIC_TAG updates never replicate through @lexical/yjs. Use a dedicated origin outside the UndoManager trackedOrigins.',
    },
    schema: [],
  },
  create(context) {
    return {
      Identifier(node) {
        if (node.name === 'HISTORIC_TAG') context.report({ node, messageId: 'historic' });
      },
      Literal(node) {
        if (node.value === 'historic') context.report({ node, messageId: 'historic' });
      },
    };
  },
};

export default {
  meta: { name: 'moss' },
  rules: {
    'no-raw-color': noRawColor,
    'no-contenteditable-pick': noContenteditablePick,
    'no-historic-tag': noHistoricTag,
  },
};
