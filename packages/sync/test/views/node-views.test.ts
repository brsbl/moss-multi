// The class/view split's client half (A§12): decorate() renders through the view registry, and each view sits
// in its own error boundary, so one throwing decorator shows a placeholder instead of unmounting the editor.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { $getRoot, $isDecoratorNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import { createConverterEditor, importMarkdown } from '../../src/converter/index.ts';

const CHART = '```moss-chart\n{"type":"bar","data":[{"label":"A","value":1}]}\n```';

function decorateFirst(editor: ReturnType<typeof createConverterEditor>) {
  return editor.getEditorState().read(() => {
    const node = $getRoot().getFirstChild();
    if (!$isDecoratorNode(node)) throw new Error('expected a decorator node');
    return node.decorate(editor, editor._config);
  });
}

describe('node views @p:tech-4', () => {
  it('decorate() renders nothing before the client registers the views, as on the server', () => {
    expect(decorateFirst(importMarkdown(CHART))).toBeNull();
  });

  it('a view that throws renders its placeholder inside its own boundary', async () => {
    await import('@moss-desktop/renderer/editor/nodes/register-views');
    // Outside an editor composer the chart view throws (no LexicalComposerContext).
    const element = decorateFirst(importMarkdown(CHART));
    expect(element).not.toBeNull();
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    const root = createRoot(container);
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      await act(async () => root.render(element as Parameters<typeof root.render>[0]));
      expect(container.querySelector('[data-node-view-error="chart"]')?.textContent).toBe("This block couldn't be displayed.");
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      console.error = original;
      act(() => root.unmount());
      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
    }
  });
});
