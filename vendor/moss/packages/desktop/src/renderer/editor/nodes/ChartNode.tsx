// ported-from: packages/desktop/src/renderer/editor/nodes/ChartNode.tsx @ 762abb777
import React, { Suspense, useCallback, useState, useRef, useEffect } from 'react';
import type { JSX } from 'react';
import {
  $applyNodeReplacement,
  $getNodeByKey,
  DecoratorNode,
  type DOMConversionMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread
} from 'lexical';
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
import type { ChartConfig, ChartPalette, ChartType } from '../utils/chartDefaults';
import {
  BLOCK_HEADER_CLASSNAME,
  BLOCK_SURFACE_CLASSNAME,
  BlockNodeShell
} from '../components/block-node-primitives';
import { insertParagraphAdjacentToBlock } from '../utils/block-node-insertion';
import { initCommentIds, cloneCommentIds, exportCommentIds, importCommentIds } from '../utils/commentable-node';
import { OPEN_BLOCK_COMMENT_COMMAND } from '../plugins/CommentPlugin';
import {
  validateChartConfig,
  serializeChartConfig,
  parseChartConfig,
  CHART_PALETTES,
  DISPLAY_PALETTES,
  CHART_TYPES,
  CHART_TYPE_LABELS,
  getSafePalette
} from '../utils/chartDefaults';
import {
  registerDecoratorDraftFlusher,
  unregisterDecoratorDraftFlusher
} from '../utils/decoratorDraftRegistry';

export type SerializedChartNode = Spread<
  {
    config: ChartConfig;
    commentIds?: string[];
  },
  SerializedLexicalNode
>;

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
  onSave
}: {
  title: string;
  onSave: (newTitle: string) => void;
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
    setEditValue(title);
    setIsEditingTitle(true);
  }, [title]);

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

  if (isEditingTitle) {
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
      title="Click to edit title"
    >
      {title}
    </span>
  );
}

/**
 * Styled dropdown trigger button for chart controls
 */
function ChartDropdownTrigger({
  children
}: {
  children: React.ReactNode;
}): JSX.Element {
  return (
    <DropdownMenuTrigger asChild>
      <button
        type="button"
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
  const [isTypeDropdownOpen, setIsTypeDropdownOpen] = useState(false);
  const [isPaletteDropdownOpen, setIsPaletteDropdownOpen] = useState(false);
  const currentPalette = getSafePalette(config.options?.palette);
  const isAnyDropdownOpen = isTypeDropdownOpen || isPaletteDropdownOpen;

  // Handle deletion of error-state chart
  const handleDelete = useCallback(() => {
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
      setIsEditing(true);
    },
    []
  );

  const handleTypeChange = useCallback(
    (newType: ChartType) => {
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
          <button
            type="button"
            onClick={handleDelete}
            className="absolute right-2 top-2 rounded-md p-1 text-status-error-text hover:bg-status-error-surface hover:text-status-error-text-hover"
            title="Remove chart"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </BlockNodeShell>
    );
  }

  // Edit mode view
  if (isEditing) {
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
      tabIndex={-1}
    >
      <div className={BLOCK_SURFACE_CLASSNAME}>
        {/* Header */}
        <div
          className={`flex h-10 items-center justify-between px-canvas-surface-pad ${BLOCK_HEADER_CLASSNAME}`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="min-w-0">
            <EditableTitle title={config.title || 'Chart'} onSave={handleTitleChange} />
          </div>

          {/* Controls - show on hover or when dropdown is open */}
          <div className={`flex shrink-0 items-center gap-1 transition-opacity ${
            isAnyDropdownOpen ? 'opacity-100' : 'opacity-0 group-hover/decorator:opacity-100'
          }`}>
            {/* Chart type dropdown */}
            <DropdownMenu open={isTypeDropdownOpen} onOpenChange={setIsTypeDropdownOpen}>
              <ChartDropdownTrigger>
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
              <ChartDropdownTrigger>
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
          </div>
        </div>

        {/* Chart body */}
        <div className="bg-surface-canvas p-canvas-surface-pad">
          <Suspense fallback={<ChartSkeleton />}>
            <ChartRenderer config={config} nodeKey={nodeKey} showTitle={false} />
          </Suspense>
        </div>
      </div>
    </BlockNodeShell>
  );
}

function $convertChartElement(domNode: HTMLElement): DOMConversionOutput | null {
  const configJson = domNode.getAttribute('data-chart-config');
  if (configJson) {
    try {
      const parsed = JSON.parse(configJson);
      const validation = validateChartConfig(parsed);
      if (validation.valid && validation.config) {
        const node = $createChartNode(validation.config);
        return { node };
      }
    } catch {
      // Invalid JSON, skip conversion
    }
  }
  return null;
}

export class ChartNode extends DecoratorNode<JSX.Element> {
  __config: ChartConfig;
  __commentIds: string[];

  static getType(): string {
    return 'chart';
  }

  static clone(node: ChartNode): ChartNode {
    return new ChartNode(node.__config, node.__key, cloneCommentIds(node.__commentIds));
  }

  constructor(config: ChartConfig, key?: NodeKey, commentIds?: string[]) {
    super(key);
    this.__config = config;
    this.__commentIds = initCommentIds(commentIds);
  }

  static importJSON(serializedNode: SerializedChartNode): ChartNode {
    const node = $createChartNode(serializedNode.config);
    node.__commentIds = importCommentIds(serializedNode as unknown as Record<string, unknown>);
    return node;
  }

  exportJSON(): SerializedChartNode {
    return {
      type: 'chart',
      version: 1,
      config: this.__config,
      ...exportCommentIds(this.__commentIds)
    };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      div: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute('data-chart-config')) {
          return null;
        }
        return {
          conversion: $convertChartElement,
          priority: 1
        };
      }
    };
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('div');
    element.setAttribute('data-chart-config', JSON.stringify(this.__config));
    element.setAttribute('data-chart-type', this.__config.type);
    element.textContent = `[Chart: ${this.__config.type}]`;
    return { element };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const div = document.createElement('div');
    const theme = config.theme;
    const className = theme.chart;
    if (className) {
      div.className = className;
    }
    return div;
  }

  updateDOM(): boolean {
    return false;
  }

  getConfig(): ChartConfig {
    return this.__config;
  }

  setConfig(config: ChartConfig): void {
    const writable = this.getWritable();
    writable.__config = config;
  }

  getCommentIds(): string[] {
    return this.__commentIds;
  }

  setCommentIds(ids: string[]): void {
    const writable = this.getWritable();
    writable.__commentIds = ids;
  }

  getTextContent(): string {
    return '```moss-chart\n' + JSON.stringify(this.__config, null, 2) + '\n```';
  }

  decorate(): JSX.Element {
    return <ChartWrapper config={this.__config} nodeKey={this.__key} commentIds={this.__commentIds} />;
  }

  isInline(): boolean {
    return false;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  isIsolated(): boolean {
    return true;
  }
}

export function $createChartNode(config: ChartConfig): ChartNode {
  return $applyNodeReplacement(new ChartNode(config));
}

export function $isChartNode(node: LexicalNode | null | undefined): node is ChartNode {
  return node instanceof ChartNode;
}

/**
 * Exports chart config as markdown code block.
 * For error-state charts, exports the raw JSON to allow manual fixing.
 */
export function exportChartToMarkdown(config: ChartConfig): string {
  // For error-state charts, preserve the original raw JSON if available
  if (config._parseError) {
    if (config._rawJson) {
      return '```moss-chart\n' + config._rawJson + '\n```';
    }
    // Fallback: export with error comment so user can see what went wrong
    return '```moss-chart\n// Error: ' + config._parseError + '\n' + serializeChartConfig(config) + '\n```';
  }
  return '```moss-chart\n' + serializeChartConfig(config) + '\n```';
}
