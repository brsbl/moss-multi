// ported-from: packages/desktop/src/renderer/editor/plugins/EditorInputSamplingPlugin.tsx @ 762abb777
/**
 * EditorInputSamplingPlugin
 *
 * Samples 1% of editor input events and captures latency metrics via the
 * analytics IPC bridge. Measures keydown-to-DOM-update latency for typing,
 * paste, and drag inputs.
 */
import { useEffect, useRef } from 'react';

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  COMMAND_PRIORITY_NORMAL,
  DROP_COMMAND,
  KEY_DOWN_COMMAND,
  PASTE_COMMAND,
} from 'lexical';

type InputType = 'typing' | 'paste' | 'drag';

export function EditorInputSamplingPlugin(): null {
  const [editor] = useLexicalComposerContext();
  const pendingInputRef = useRef<{ timestamp: number; type: InputType } | null>(null);

  useEffect(() => {
    const unregisterKeyDown = editor.registerCommand(
      KEY_DOWN_COMMAND,
      () => {
        pendingInputRef.current = { timestamp: performance.now(), type: 'typing' };
        return false;
      },
      COMMAND_PRIORITY_NORMAL,
    );

    const unregisterPaste = editor.registerCommand(
      PASTE_COMMAND,
      () => {
        pendingInputRef.current = { timestamp: performance.now(), type: 'paste' };
        return false;
      },
      COMMAND_PRIORITY_NORMAL,
    );

    const unregisterDrop = editor.registerCommand(
      DROP_COMMAND,
      () => {
        pendingInputRef.current = { timestamp: performance.now(), type: 'drag' };
        return false;
      },
      COMMAND_PRIORITY_NORMAL,
    );

    const unregisterUpdate = editor.registerUpdateListener(() => {
      const pending = pendingInputRef.current;
      if (!pending) return;
      pendingInputRef.current = null;

      if (Math.random() >= 0.01) return;

      const latencyMs = performance.now() - pending.timestamp;

      let noteSizeKb = 0;
      editor.getEditorState().read(() => {
        const textLength = $getRoot().getTextContent().length;
        noteSizeKb = Math.round(textLength / 1024);
      });

      window.electronAPI?.analytics?.capture('editor_input_sampled', {
        latency_ms: Math.round(latencyMs * 100) / 100,
        input_type: pending.type,
        note_size_kb: noteSizeKb,
      });
    });

    return () => {
      unregisterKeyDown();
      unregisterPaste();
      unregisterDrop();
      unregisterUpdate();
    };
  }, [editor]);

  return null;
}
