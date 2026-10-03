// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { createEditor, COMMAND_PRIORITY_HIGH, UNDO_COMMAND, REDO_COMMAND } from 'lexical';
import { trackUndoFocus, undoFromEmptyPrompt } from './undo.ts';

it('routes empty-prompt undo and redo to the last focused writable body and releases it on unmount', () => {
  const editors = [createEditor(), createEditor()];
  const roots = editors.map(() => document.body.appendChild(document.createElement('div')));
  const received: string[] = [];
  const stops = editors.map((editor, index) => {
    editor.setRootElement(roots[index]);
    editor.registerCommand(UNDO_COMMAND, () => { received.push(`undo:${index}`); return true; }, COMMAND_PRIORITY_HIGH);
    editor.registerCommand(REDO_COMMAND, () => { received.push(`redo:${index}`); return true; }, COMMAND_PRIORITY_HIGH);
    return trackUndoFocus(editor);
  });
  const send = (shiftKey = false) => {
    const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey, cancelable: true });
    undoFromEmptyPrompt(event);
    return event.defaultPrevented;
  };
  try {
    roots[0].dispatchEvent(new FocusEvent('focusin')); expect(send()).toBe(true);
    roots[1].dispatchEvent(new FocusEvent('focusin')); expect(send(true)).toBe(true);
    expect(received).toEqual(['undo:0', 'redo:1']);
    editors[1].setEditable(false); expect(send()).toBe(false);
    editors[1].setEditable(true); stops[1](); expect(send()).toBe(false);
    expect(received).toHaveLength(2);
  } finally {
    stops.forEach(stop => stop());
    editors.forEach(editor => editor.setRootElement(null));
    roots.forEach(root => root.remove());
  }
});
