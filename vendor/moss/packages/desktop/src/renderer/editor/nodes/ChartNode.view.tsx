// ported-from: packages/desktop/src/renderer/editor/nodes/ChartNode.tsx @ 762abb777
import React, { Suspense, useCallback, useState, useRef, useEffect } from 'react';
import type { JSX } from 'react';
import { $getNodeByKey, type NodeKey } from 'lexical';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection';
import { Code2, Check, X, AlertCircle, ChevronDown, StickyNote } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem
} from '@moss/shared/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@moss/shared/components/ui/tooltip';
// moss-multi seam: hide-registry (A§9)
import { hidden } from '@moss-multi/host/affordances';
import type { ChartConfig, ChartPalette, ChartType } from '../utils/chartDefaults';
import {
  BLOCK_HEADER_CLASSNAME,
  BLOCK_SURFACE_CLASSNAME,
  BlockNodeShell
} from '../components/block-node-primitives';
import { insertParagraphAdjacentToBlock } from '../utils/block-node-insertion';
// moss-multi seam: read-only-decorators (T2.3)
import { useIsEditorEditable } from '../components/media-primitives';
// moss-multi seam: converter-split (A§12; S-conv §2.3)
import { OPEN_BLOCK_COMMENT_COMMAND } from '../commands';
import { serializeChartConfig, parseChartConfig, CHART_PALETTES, DISPLAY_PALETTES, CHART_TYPES, CHART_TYPE_LABELS, getSafePalette } from '../utils/chartDefaults';
import {
  registerDecoratorDraftFlusher,
  unregisterDecoratorDraftFlusher
} from '../utils/decoratorDraftRegistry';
// moss-multi seam: converter-split (A§12; S-conv §2.3)
import { $isChartNode, ChartNode } from './ChartNode';
import { registerNodeView } from './node-views';
export { $createChartNode, $isChartNode, ChartNode, exportChartToMarkdown } from './ChartNode';
export type { SerializedChartNode } from './ChartNode';

// Lazy import the chart component to avoid loading recharts until needed
const ChartRenderer = React.lazy(() => import('../components/ChartRenderer'));

function ChartSkeleton(): JSX.Element {
  return (
    <div
      className="flex h-64 w-full items-center justify-center rounded-lg border border-surface-panel bg-surface-canvas"
      data-testid="chart-loading"
    >
      <div className="flex flex-col items-center gap-2 text-ink-muted">
        <div className="h-8 w-8 animate-pulse rounded bg-border-default" />
        <span className="text-sm">Loading chart...</span>
      </div>
    </div>
  );
}

/**
 * Chart edit mode - inline JSON editor with validation
 */
function ChartEditView({
  initialConfig,
  nodeKey,
  onDone,
  onCancel
}: {
  initialConfig: ChartConfig;
  nodeKey: NodeKey;
  onDone: (config: ChartConfig) => void;
  onCancel: () => void;
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [jsonText, setJsonText] = useState(() => serializeChartConfig(initialConfig));
  const [validation, setValidation] = useState<{ isValid: boolean; error?: string }>({ isValid: true });
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea on mount
  useEffect(() => {
    textareaRef.current?.focus();
    textareaRef.current?.select();
  }, []);

  // Validate on change
  useEffect(() => {
    const result = parseChartConfig(jsonText);
    setValidation({ isValid: result.valid, error: result.error });
  }, [jsonText]);

  const handleDone = useCallback(() => {
    const result = parseChartConfig(jsonText);
    if (result.valid && result.config) {
      onDone(result.config);
    }
  }, [jsonText, onDone]);

  useEffect(() => {
    const flushDraft = () => {
      handleDone();
    };

    const editorId = editor._key;
    registerDecoratorDraftFlusher(editorId, nodeKey, flushDraft);
    return () => {
      unregisterDecoratorDraftFlusher(editorId, nodeKey, flushDraft);
    };
  }, [editor._key, handleDone, nodeKey]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Prevent Lexical from capturing these keys
    e.stopPropagation();

    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (validation.isValid) {
        handleDone();
      }
    }
  }, [onCancel, handleDone, validation.isValid]);

  return (
    <div
      className={`${BLOCK_SURFACE_CLASSNAME} p-canvas-surface-pad`}
    >
      {/* Toolbar */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Code2 className="h-4 w-4 text-ink-muted" />
          <span className="text-sm font-medium text-ink-muted">Chart JSON</span>
        </div>
        <div className="flex items-center gap-2">
          {!validation.isValid && (
            <div className="flex items-center gap-1 text-xs text-status-error-text">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="max-w-error-message truncate" title={validation.error}>
                {validation.error || 'Invalid JSON'}
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="flex items-center gap-1 rounded-md border border-surface-panel bg-surface-raised-control px-2 py-1 text-xs text-ink-muted hover:bg-surface-canvas"
            title="Cancel (Esc)"
          >
            <X className="h-3.5 w-3.5" />
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDone}
            disabled={!validation.isValid}
            className="flex items-center gap-1 rounded-md bg-accent-brand px-2 py-1 text-xs text-ink-on-accent hover:bg-accent-brand/90 disabled:cursor-not-allowed disabled:opacity-50"
            title={validation.isValid ? 'Apply changes (⌘+Enter)' : 'Fix JSON errors first'}
          >
            <Check className="h-3.5 w-3.5" />
            Done
          </button>
        </div>
      </div>

      {/* JSON Editor */}
      <textarea
        ref={textareaRef}
        value={jsonText}
        onChange={(e) => setJsonText(e.target.value)}
        onKeyDown={handleKeyDown}
        className="w-full resize-y rounded-md border border-surface-panel bg-surface-raised-control p-canvas-surface-pad font-mono text-sm text-ink-default focus:border-ink-default/20 focus:outline-none focus:ring-1 focus:ring-ink-default/20"
        rows={12}
        spellCheck={false}
      />
    </div>
  );
}

/**
 * Inline editable title component with double-click to edit
 */
function EditableTitle({
  title,
  onSave,
  readOnly = false
}: {
  title: string;
  onSave: (newTitle: string) => void;
  /** moss-multi seam: read-only-decorators (T2.3): a read-only editor shows the title and opens no field */
  readOnly?: boolean;
}): JSX.Element {
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editValue, setEditValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditingTitle && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditingTitle]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (readOnly) return; // moss-multi seam: read-only-decorators (T2.3)
    setEditValue(title);
    setIsEditingTitle(true);
  }, [title, readOnly]);

  const handleSave = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== title) {
      onSave(trimmed);
    }
    setIsEditingTitle(false);
  }, [editValue, title, onSave]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setIsEditingTitle(false);
    }
  }, [handleSave]);

  if (isEditingTitle && !readOnly /* moss-multi seam: read-only-decorators (T2.3) */) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={handleSave}
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
        className="min-w-0 flex-1 bg-surface-transparent font-mono text-xs text-ink-default outline-none"
      />
    );
  }

  return (
    <span
      onClick={handleClick}
      className="min-w-0 flex-1 cursor-text truncate font-mono text-xs text-ink-muted hover:text-ink-default"
      title={readOnly ? undefined : 'Click to edit title' /* moss-multi seam: read-only-decorators (T2.3) */}
    >
      {title}
    </span>
  );
}

/**
 * Styled dropdown trigger button for chart controls
 */
function ChartDropdownTrigger({
  children,
  disabled = false
}: {
  children: React.ReactNode;
  /** moss-multi seam: read-only-decorators (T2.3) */
  disabled?: boolean;
}): JSX.Element {
  return (
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        disabled={disabled}
        className="flex items-center gap-1 rounded-md border border-surface-panel bg-surface-raised-control px-2 py-1 text-xs text-ink-muted shadow-sm hover:bg-surface-canvas focus:border-accent-success focus:outline-none focus:ring-1 focus:ring-accent-success/30"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
        <ChevronDown className="h-3 w-3" />
      </button>
    </DropdownMenuTrigger>
  );
}

function ChartWrapper({
  config,
  nodeKey,
  commentIds: _commentIds = []
}: {
  config: ChartConfig;
  nodeKey: NodeKey;
  commentIds?: string[];
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [isSelected, setSelected, clearSelection] = useLexicalNodeSelection(nodeKey);
  const [isEditing, setIsEditing] = useState(false);
  // moss-multi seam: read-only-decorators (T2.3): a closed body takes no chart edit; an edit left open closes without writing
  const editable = useIsEditorEditable();
  useEffect(() => {
    if (!editable) setIsEditing(false);
  }, [editable]);
  // Nothing under a closed body takes focus (invariant 9): the chart library's focusable svg and layers lose their tabindex.
  const chartBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = chartBodyRef.current;
    if (editable || !root) return;
    const strip = () => {
      for (const el of root.querySelectorAll('[tabindex]')) el.removeAttribute('tabindex');
    };
    strip();
    const observer = new MutationObserver(strip);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['tabindex'] });
    return () => observer.disconnect();
  }, [editable]);
  const [isTypeDropdownOpen, setIsTypeDropdownOpen] = useState(false);
  const [isPaletteDropdownOpen, setIsPaletteDropdownOpen] = useState(false);
  const currentPalette = getSafePalette(config.options?.palette);
  const isAnyDropdownOpen = isTypeDropdownOpen || isPaletteDropdownOpen;

  // Handle deletion of error-state chart
  const handleDelete = useCallback(() => {
    if (!editor.isEditable()) return; // moss-multi seam: read-only-decorators (T2.3)
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (node) {
        node.remove();
      }
    });
  }, [editor, nodeKey]);

  // Handle click to select
  const handleContainerClick = useCallback(
    (e: React.MouseEvent) => {
      // Don't handle if clicking on interactive elements
      const target = e.target as HTMLElement;
      if (target.closest('button') || target.closest('input') || target.closest('textarea') || target.closest('[role="menu"]')) {
        return;
      }

      if (e.shiftKey) {
        setSelected(!isSelected);
      } else {
        clearSelection();
        setSelected(true);
      }
    },
    [isSelected, setSelected, clearSelection]
  );

  const handleEditClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!editor.isEditable()) return; // moss-multi seam: read-only-decorators (T2.3)
      setIsEditing(true);
    },
    [editor]
  );

  const handleTypeChange = useCallback(
    (newType: ChartType) => {
      if (!editor.isEditable()) return; // moss-multi seam: read-only-decorators (T2.3)
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if (node && $isChartNode(node)) {
          // Update title if it matches "Sample X Chart" pattern
          let newTitle = config.title;
          const sampleChartPattern = /^Sample \w+ Chart$/;
          if (config.title && sampleChartPattern.test(config.title)) {
            newTitle = `Sample ${CHART_TYPE_LABELS[newType]} Chart`;
          }

          const updatedConfig: ChartConfig = {
            ...config,
            type: newType,
            title: newTitle
          };
          node.setConfig(updatedConfig);
        }
      });
    },
    [editor, nodeKey, config]
  );

  const handlePaletteChange = useCallback(
    (newPalette: ChartPalette) => {
      if (!editor.isEditable()) return; // moss-multi seam: read-only-decorators (T2.3)
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if (node && $isChartNode(node)) {
          const updatedConfig: ChartConfig = {
            ...config,
            options: {
              ...config.options,
              palette: newPalette
            }
          };
          node.setConfig(updatedConfig);
        }
      });
    },
    [editor, nodeKey, config]
  );

  const handleTitleChange = useCallback(
    (newTitle: string) => {
      if (!editor.isEditable()) return; // moss-multi seam: read-only-decorators (T2.3)
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if (node && $isChartNode(node)) {
          const updatedConfig: ChartConfig = {
            ...config,
            title: newTitle
          };
          node.setConfig(updatedConfig);
        }
      });
    },
    [editor, nodeKey, config]
  );

  const handleDone = useCallback(
    (newConfig: ChartConfig) => {
      if (!editor.isEditable()) return; // moss-multi seam: read-only-decorators (T2.3)
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if (node && $isChartNode(node)) {
          node.setConfig(newConfig);
        }
      });
      setIsEditing(false);
    },
    [editor, nodeKey]
  );

  const handleCancel = useCallback(() => {
    setIsEditing(false);
  }, []);

  const handleGapClick = useCallback(
    (position: 'before' | 'after') => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!editor.isEditable()) return; // moss-multi seam: read-only-decorators (T2.3)
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if (!node) return;

        insertParagraphAdjacentToBlock(node, position);
      });
    },
    [editor, nodeKey]
  );

  // Render error state for invalid chart data
  if (config._parseError) {
    return (
      <BlockNodeShell
        selected={isSelected}
        beforeLabel="Insert paragraph before chart"
        afterLabel="Insert paragraph after chart"
        onGapClick={handleGapClick}
        className="my-6"
        data-block-decorator-key={nodeKey}
      >
        <div className={`${BLOCK_SURFACE_CLASSNAME} relative flex flex-col items-center justify-center bg-status-error-surface p-8`}>
          <div className="flex flex-col items-center gap-2 text-status-error-text">
            <AlertCircle className="h-8 w-8" />
            <span className="text-sm font-medium">Invalid chart data</span>
            <span className="max-w-md text-center text-xs">{config._parseError}</span>
            {config._rawJson && (
              <pre className="mt-2 max-h-32 max-w-lg overflow-auto rounded bg-status-error-surface/50 p-2 text-xs">
                {config._rawJson.slice(0, 200)}{config._rawJson.length > 200 ? '...' : ''}
              </pre>
            )}
          </div>
          {editable ? ( /* moss-multi seam: read-only-decorators (T2.3) */
          <button
            type="button"
            onClick={handleDelete}
            className="absolute right-2 top-2 rounded-md p-1 text-status-error-text hover:bg-status-error-surface hover:text-status-error-text-hover"
            title="Remove chart"
          >
            <X className="h-4 w-4" />
          </button>
          ) : null}
        </div>
      </BlockNodeShell>
    );
  }

  // Edit mode view
  if (isEditing && editable /* moss-multi seam: read-only-decorators (T2.3) */) {
    return (
      <BlockNodeShell
        selected={isSelected}
        beforeLabel="Insert paragraph before chart"
        afterLabel="Insert paragraph after chart"
        onGapClick={handleGapClick}
        className="my-6"
        data-block-decorator-key={nodeKey}
      >
        <ChartEditView
          initialConfig={config}
          nodeKey={nodeKey}
          onDone={handleDone}
          onCancel={handleCancel}
        />
      </BlockNodeShell>
    );
  }

  // Normal chart view
  return (
    <BlockNodeShell
      selected={isSelected}
      beforeLabel="Insert paragraph before chart"
      afterLabel="Insert paragraph after chart"
      onGapClick={handleGapClick}
      className="my-6 outline-none transition-colors"
      data-block-decorator-key={nodeKey}
      onClick={handleContainerClick}
      tabIndex={editable ? -1 : undefined /* moss-multi seam: read-only-decorators (T2.3) */}
    >
      <div className={BLOCK_SURFACE_CLASSNAME}>
        {/* Header */}
        <div
          className={`flex h-10 items-center justify-between px-canvas-surface-pad ${BLOCK_HEADER_CLASSNAME}`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="min-w-0">
            <EditableTitle title={config.title || 'Chart'} onSave={handleTitleChange} readOnly={!editable /* moss-multi seam: read-only-decorators (T2.3) */} />
          </div>

          {/* Controls - show on hover or when dropdown is open */}
          <div className={`flex shrink-0 items-center gap-1 transition-opacity ${
            isAnyDropdownOpen ? 'opacity-100' : 'opacity-0 group-hover/decorator:opacity-100'
          }`}>
            {/* Chart type dropdown */}
            <DropdownMenu open={isTypeDropdownOpen} onOpenChange={setIsTypeDropdownOpen}>
              <ChartDropdownTrigger disabled={!editable /* moss-multi seam: read-only-decorators (T2.3) */}>
                {CHART_TYPE_LABELS[config.type]}
              </ChartDropdownTrigger>
              <DropdownMenuContent align="end">
                {CHART_TYPES.map((type) => (
                  <DropdownMenuItem
                    key={type}
                    onClick={() => handleTypeChange(type)}
                    className={config.type === type ? 'bg-surface-canvas' : ''}
                  >
                    {CHART_TYPE_LABELS[type]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Palette dropdown */}
            <DropdownMenu open={isPaletteDropdownOpen} onOpenChange={setIsPaletteDropdownOpen}>
              <ChartDropdownTrigger disabled={!editable /* moss-multi seam: read-only-decorators (T2.3) */}>
                {CHART_PALETTES[currentPalette].name}
              </ChartDropdownTrigger>
              <DropdownMenuContent align="end">
                {DISPLAY_PALETTES.map((key) => (
                  <DropdownMenuItem
                    key={key}
                    onClick={() => handlePaletteChange(key)}
                    className={currentPalette === key ? 'bg-surface-canvas' : ''}
                  >
                    {CHART_PALETTES[key].name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Edit JSON button */}
            {/* moss-multi seam: read-only-decorators (T2.3): a closed body opens no chart editor */}
            {editable ? (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleEditClick}
                    className="flex items-center gap-1.5 rounded border border-surface-panel bg-surface-raised-control px-2 py-1 text-xs text-ink-muted shadow-sm hover:bg-surface-canvas hover:text-ink-default"
                  >
                    <Code2 className="h-3 w-3" />
                    Edit
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom"><p>Edit chart data</p></TooltipContent>
              </Tooltip>
            </TooltipProvider>
            ) : null}
            {/* moss-multi seam: hide-registry (A§9) */}
            {hidden('comments') ? null : (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      editor.dispatchCommand(OPEN_BLOCK_COMMENT_COMMAND, { nodeKey });
                    }}
                    className="flex h-6 w-6 items-center justify-center rounded border border-surface-panel bg-surface-raised-control text-ink-muted shadow-sm hover:bg-surface-canvas hover:text-ink-default"
                  >
                    <StickyNote className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom"><p>Add comment</p></TooltipContent>
              </Tooltip>
            </TooltipProvider>
            )}
          </div>
        </div>

        {/* Chart body */}
        {/* moss-multi seam: read-only-decorators (T2.3): keyed so a reopened body gets the chart's own tabindexes back */}
        <div key={editable ? 'live' : 'closed'} ref={chartBodyRef} className="bg-surface-canvas p-canvas-surface-pad">
          <Suspense fallback={<ChartSkeleton />}>
            <ChartRenderer config={config} nodeKey={nodeKey} showTitle={false} />
          </Suspense>
        </div>
      </div>
    </BlockNodeShell>
  );
}

// moss-multi seam: node-views (A§12)
registerNodeView(ChartNode.getType(), function decorate(this: ChartNode): JSX.Element {
    return <ChartWrapper config={this.__config} nodeKey={this.__key} commentIds={this.__commentIds} />;
  });
