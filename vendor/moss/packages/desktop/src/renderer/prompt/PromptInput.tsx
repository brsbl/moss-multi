// ported-from: packages/desktop/src/renderer/prompt/PromptInput.tsx @ 762abb777
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef
} from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import type { InitialConfigType } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import { AutoFocusPlugin } from '@lexical/react/LexicalAutoFocusPlugin';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $nodesOfType,
  CLEAR_EDITOR_COMMAND,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  type EditorState
} from 'lexical';
import { useAtom, useStore } from 'jotai';
import { promptDraftAtom } from '@moss/shared';
import { noteIdsAtom, noteEntityAtom } from '@moss/shared/state/note-atoms';

import { MentionNode, $createMentionNode, type MentionType } from './MentionNode';
import { MentionPlugin, type MentionState } from './MentionPlugin';
import { splitCommentMentionSegments } from '../editor/utils/comment-mentions';

export interface PromptMention {
  id: string;
  title: string;
  type: MentionType;
}

export interface PromptSubmitResult {
  text: string;
  noteIds: string[];
  directoryPaths: string[];
  mentions: PromptMention[];
  imageUrls: string[];
}

interface PromptInputProps {
  placeholder?: string;
  onSubmit: (result: PromptSubmitResult) => void;
  /** When true, prevents editing and submission */
  isSubmitting?: boolean;
  onEscape?: () => void;
  /** External value (controlled mode) - when provided, skips global atom */
  value?: string;
  /** External change handler (controlled mode) */
  onChange?: (value: string) => void;
  /** Render the typeahead menu inline (non-portal) below the input */
  inline?: boolean;
  /** Callback for mention typeahead state changes */
  onMentionStateChange?: (state: MentionState | null) => void;
}

export interface PromptInputHandle {
  submit: () => void;
  focus: () => void;
  resetHeight: () => void;
}

const theme = {
  paragraph: 'mb-0 leading-relaxed'
};

const Placeholder = ({ children }: { children: string }) => (
  <div className="pointer-events-none absolute left-4 top-3 select-none text-caption leading-relaxed text-ink-faint">
    {children}
  </div>
);

/**
 * Internal plugin that handles Cmd/Ctrl+Enter submit, Escape close,
 * backspace-on-empty close, and exposes imperative handles.
 */
function PromptCommandsPlugin({
  onSubmit,
  onEscape,
  isSubmitting,
  handleRef
}: {
  onSubmit: (result: PromptSubmitResult) => void;
  onEscape?: () => void;
  isSubmitting: boolean;
  handleRef: React.MutableRefObject<PromptInputHandle>;
}) {
  const [editor] = useLexicalComposerContext();

  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const isSubmittingRef = useRef(isSubmitting);
  isSubmittingRef.current = isSubmitting;

  const collectAndSubmit = useCallback(() => {
    if (isSubmittingRef.current) return false;

    let didSubmit = false;

    editor.getEditorState().read(() => {
      const text = $getRoot().getTextContent().trim();
      if (text.length === 0) return;

      const mentions = $nodesOfType(MentionNode).map((node) => ({
        id: node.getMentionId(),
        title: node.getMentionTitle(),
        type: node.getMentionType()
      }));
      const noteIds = mentions
        .filter((mention) => mention.type === 'note')
        .map((mention) => mention.id);
      const directoryPaths = mentions
        .filter((mention) => mention.type === 'directory')
        .map((mention) => mention.id);

      onSubmitRef.current({ text, noteIds, directoryPaths, mentions, imageUrls: [] });
      didSubmit = true;
    });

    if (didSubmit) {
      editor.dispatchCommand(CLEAR_EDITOR_COMMAND, undefined);
    }

    return didSubmit;
  }, [editor]);

  // Expose imperative handle via effect (not during render)
  useEffect(() => {
    handleRef.current = {
      submit: () => { collectAndSubmit(); },
      focus: () => { editor.focus(); },
      resetHeight: () => { /* Lexical ContentEditable auto-sizes; no-op */ }
    };
  }, [editor, collectAndSubmit, handleRef]);

  // Cmd/Ctrl+Enter to submit
  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (!event) return false;
        const isModifierEnter = event.metaKey || event.ctrlKey;
        if (isModifierEnter) {
          event.preventDefault();
          return collectAndSubmit();
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH
    );
  }, [editor, collectAndSubmit]);

  // Escape to close
  useEffect(() => {
    if (!onEscape) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onEscape();
      }
    };

    const rootElement = editor.getRootElement();
    rootElement?.addEventListener('keydown', handleKeyDown);
    return () => {
      rootElement?.removeEventListener('keydown', handleKeyDown);
    };
  }, [editor, onEscape]);

  return null;
}

/**
 * Plugin that syncs Lexical editor state with the global promptDraftAtom
 * (uncontrolled mode) or with external value/onChange (controlled mode).
 */
function DraftSyncPlugin({
  controlledValue,
  controlledOnChange,
  containerRef
}: {
  controlledValue?: string;
  controlledOnChange?: (value: string) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [editor] = useLexicalComposerContext();
  const [atomValue, setAtomValue] = useAtom(promptDraftAtom);
  const store = useStore();
  const isControlled = controlledValue !== undefined;

  // Track whether we're currently pushing an external value into the editor,
  // so we can skip the resulting onChange callback.
  const isExternalUpdateRef = useRef(false);
  // Track the last text we set from outside to avoid unnecessary editor updates
  const lastExternalTextRef = useRef<string | null>(null);
  // Incremented by handleChange (internal writes), consumed by the sync
  // effect. If the counter is ahead of what the effect last saw, the atom
  // change originated from this editor — skip the rebuild.
  const internalWriteCountRef = useRef(0);
  const lastConsumedWriteRef = useRef(0);

  const currentText = isControlled ? controlledValue : atomValue;
  const setCurrentText = useCallback(
    (text: string) => {
      if (isControlled) {
        controlledOnChange?.(text);
      } else {
        setAtomValue(text);
      }
    },
    [isControlled, controlledOnChange, setAtomValue]
  );

  // When the external value changes (from outside the editor), update the editor
  useEffect(() => {
    // Only sync if the external text differs from what we last pushed in
    if (lastExternalTextRef.current === currentText) return;

    // If there are unconsumed internal writes, this atom change came from
    // the editor itself (via handleChange). Consume and skip the rebuild.
    if (internalWriteCountRef.current > lastConsumedWriteRef.current) {
      lastConsumedWriteRef.current = internalWriteCountRef.current;
      lastExternalTextRef.current = currentText;
      return;
    }

    // Read current editor text to compare
    let editorText = '';
    editor.getEditorState().read(() => {
      editorText = $getRoot().getTextContent();
    });

    if (editorText === currentText) {
      lastExternalTextRef.current = currentText;
      return;
    }

    // Check if user is interacting anywhere within this prompt input container
    // (not just the ContentEditable — includes buttons, @ trigger, etc.).
    // Uses the container ref rather than the Lexical root to avoid rebuilding
    // the editor tree when focus is on a sibling button within the wrapper.
    const container = containerRef.current;
    const activeElement = document.activeElement;
    const containerOwnsInteraction =
      !!container &&
      activeElement instanceof HTMLElement &&
      container.contains(activeElement);

    // In uncontrolled mode, ignore external rebuilds while the user is
    // interacting with any part of this prompt input component.
    // This prevents atom churn from resetting caret position during active typing.
    if (!isControlled && containerOwnsInteraction) {
      lastExternalTextRef.current = currentText;
      return;
    }

    // Push external value into editor
    isExternalUpdateRef.current = true;
    lastExternalTextRef.current = currentText;

    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      if (currentText) {
        // Check for Unicode mention markers from comment @mentions
        if (currentText.includes('\u2063')) {
          const segments = splitCommentMentionSegments(currentText);
          for (const segment of segments) {
            if (segment.type === 'mention') {
              const title = segment.value.startsWith('@')
                ? segment.value.slice(1)
                : segment.value;
              if (title) {
                if (segment.mentionType === 'note') {
                  // Resolve note title to real UUID
                  const ids = store.get(noteIdsAtom);
                  const titleLower = title.toLowerCase();
                  let resolvedId: string | null = null;
                  for (const id of ids) {
                    const entity = store.get(noteEntityAtom(id));
                    if (entity && entity.title.toLowerCase() === titleLower) {
                      resolvedId = id;
                      break;
                    }
                  }
                  if (resolvedId) {
                    paragraph.append(
                      $createMentionNode(resolvedId, title, segment.mentionType)
                    );
                  } else {
                    // No matching note found — render as plain text
                    paragraph.append($createTextNode(`@${title}`));
                  }
                } else {
                  // Directory/folder mentions use title as identifier
                  paragraph.append(
                    $createMentionNode(title, title, segment.mentionType)
                  );
                }
              }
            } else if (segment.value) {
              paragraph.append($createTextNode(segment.value));
            }
          }
        } else {
          paragraph.append($createTextNode(currentText));
        }
      }
      root.append(paragraph);
      // Move cursor to end
      paragraph.selectEnd();
    });

    // Reset flag after update cycle - microtask runs after the synchronous
    // editor.update() finishes but before OnChangePlugin fires from the next cycle
    queueMicrotask(() => {
      isExternalUpdateRef.current = false;
    });
  }, [editor, currentText, isControlled]);

  // On editor change, sync text back to external state
  const handleChange = useCallback(
    (editorState: EditorState) => {
      if (isExternalUpdateRef.current) return;

      editorState.read(() => {
        const text = $getRoot().getTextContent();
        lastExternalTextRef.current = text;
        internalWriteCountRef.current += 1;
        setCurrentText(text);
      });
    },
    [setCurrentText]
  );

  return <OnChangePlugin onChange={handleChange} ignoreSelectionChange />;
}

/**
 * PromptInput - Lexical-based prompt editor with MentionNode support.
 *
 * Usage (uncontrolled - uses global promptDraftAtom):
 *   <PromptInput onSubmit={handleSubmit} />
 *
 * Usage (controlled):
 *   <PromptInput onSubmit={handleSubmit} value={draft} onChange={setDraft} />
 */
export const PromptInput = forwardRef<PromptInputHandle, PromptInputProps>(
  function PromptInput(
    {
      placeholder = 'Type your prompt...',
      onSubmit,
      isSubmitting = false,
      onEscape,
      value: controlledValue,
      onChange: controlledOnChange,
      inline,
      onMentionStateChange
    },
    ref
  ) {
    const handleRef = useRef<PromptInputHandle>({
      submit: () => {},
      focus: () => {},
      resetHeight: () => {}
    });
    const containerRef = useRef<HTMLDivElement>(null);

    useImperativeHandle(ref, () => ({
      submit: () => handleRef.current.submit(),
      focus: () => handleRef.current.focus(),
      resetHeight: () => handleRef.current.resetHeight()
    }), []);

    const initialConfig = useMemo<InitialConfigType>(
      () => ({
        namespace: 'moss-prompt-input',
        theme,
        nodes: [MentionNode],
        editable: !isSubmitting,
        onError(error: Error) {
          console.error('PromptInput error:', error);
        }
      }),
      // Only use isSubmitting for initial config; editable toggling
      // is handled separately to avoid re-creating the editor.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      []
    );

    return (
      <LexicalComposer initialConfig={initialConfig}>
        {/* Focus guard: data-focus-guard="active" blocks the canvas editor from
            stealing focus (checked by FocusGuardPlugin). The attribute is set/cleared
            synchronously — no rAF race. relatedTarget tells us if focus is moving to
            another element inside this container (e.g., the submit button).
            INVARIANT: all interactive children must be focusable (<button>, <input>,
            elements with tabIndex). A bare <div onClick> would give relatedTarget=null
            on blur, clearing the guard prematurely. */}
        <div
          ref={containerRef}
          className="relative min-h-12"
          data-focus-guard=""
          onFocusCapture={(e) => {
            e.currentTarget.setAttribute('data-focus-guard', 'active');
          }}
          onBlurCapture={(e) => {
            const next = e.relatedTarget;
            if (next instanceof Node && e.currentTarget.contains(next)) return;
            e.currentTarget.setAttribute('data-focus-guard', '');
          }}
        >
          <PlainTextPlugin
            contentEditable={
              <ContentEditable
                className="min-h-12 max-h-48 w-full resize-none overflow-y-auto rounded-lg border border-surface-glass-border bg-surface-raised-control px-4 py-3 text-caption text-ink-default outline-none"
                aria-placeholder={placeholder}
                placeholder={() => null}
              />
            }
            placeholder={<Placeholder>{placeholder}</Placeholder>}
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          <AutoFocusPlugin />
          <EditablePlugin isSubmitting={isSubmitting} />
          <PromptCommandsPlugin
            onSubmit={onSubmit}
            onEscape={onEscape}
            isSubmitting={isSubmitting}
            handleRef={handleRef}
          />
          <MentionPlugin inline={inline} onMentionStateChange={onMentionStateChange} />
          <DraftSyncPlugin
            controlledValue={controlledValue}
            controlledOnChange={controlledOnChange}
            containerRef={containerRef}
          />
        </div>
      </LexicalComposer>
    );
  }
);

/**
 * Keeps the editor's editable state in sync with the isSubmitting prop
 * without re-creating the composer.
 */
function EditablePlugin({ isSubmitting }: { isSubmitting: boolean }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    editor.setEditable(!isSubmitting);
  }, [editor, isSubmitting]);

  return null;
}

export default PromptInput;
