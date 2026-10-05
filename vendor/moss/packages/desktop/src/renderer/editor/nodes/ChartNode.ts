// ported-from: packages/desktop/src/renderer/editor/nodes/ChartNode.tsx @ 762abb777 (extracted)
// moss-multi seam: register payloads (A§10.10): the config is a per-key register on a bound doc.
import { readMapRegister, writeMapRegister, initRegisterNode } from '@moss-multi/host/collab/registers';
import type { JSX } from 'react';
import { $applyNodeReplacement, type DOMConversionMap, type DOMConversionOutput, type DOMExportOutput, DecoratorNode, type EditorConfig, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread } from 'lexical';
import { cloneCommentIds, exportCommentIds, importCommentIds, initCommentIds } from '../utils/commentable-node';
import { type ChartConfig, serializeChartConfig, validateChartConfig } from '../utils/chartDefaults';
import { renderNodeView } from './node-views';

export type SerializedChartNode = Spread<
  {
    config: ChartConfig;
    commentIds?: string[];
  },
  SerializedLexicalNode
>;

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
  __regId = initRegisterNode(this);
  __config: ChartConfig;
  __commentIds: string[];

  afterCloneFrom(previous: this): void {
    super.afterCloneFrom(previous);
    this.__regId = previous.__regId;
  }

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
      config: this.getConfig(),
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
    const config = this.getConfig();
    element.setAttribute('data-chart-config', JSON.stringify(config));
    element.setAttribute('data-chart-type', config.type);
    element.textContent = `[Chart: ${config.type}]`;
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
    return (readMapRegister(this)?.__config as ChartConfig | undefined) ?? this.__config;
  }

  /** `base` is the config the caller derived `config` from; keys it left alone keep a peer's concurrent writes. */
  setConfig(config: ChartConfig, base?: ChartConfig): void {
    if (writeMapRegister(this, { __config: config }, base && { __config: base })) return;
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
    return '```moss-chart\n' + JSON.stringify(this.getConfig(), null, 2) + '\n```';
  }

  decorate(): JSX.Element {
    // moss-multi seam: node-views (A§12)
    return renderNodeView(this);
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
