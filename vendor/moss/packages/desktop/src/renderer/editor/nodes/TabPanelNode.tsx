// ported-from: packages/desktop/src/renderer/editor/nodes/TabPanelNode.tsx @ 762abb777
import {
  $applyNodeReplacement,
  ElementNode,
  type DOMConversionMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedElementNode,
  type Spread
} from 'lexical';

export type SerializedTabPanelNode = Spread<
  { label: string },
  SerializedElementNode
>;

export class TabPanelNode extends ElementNode {
  __label: string;

  static getType(): string {
    return 'tab-panel';
  }

  static clone(node: TabPanelNode): TabPanelNode {
    return new TabPanelNode(node.__label, node.__key);
  }

  static importJSON(serializedNode: SerializedTabPanelNode): TabPanelNode {
    const node = $createTabPanelNode(serializedNode.label);
    return node;
  }

  constructor(label: string, key?: NodeKey) {
    super(key);
    this.__label = label;
  }

  createDOM(config: EditorConfig): HTMLDivElement {
    const dom = document.createElement('div');
    dom.setAttribute('data-tab-panel', '');
    dom.setAttribute('data-tab-label', this.__label);
    // Initial visibility: check index vs parent's activeIndex
    // Import: $isTabGroupNode here would create circular dep, so use duck typing
    // Set initial visibility based on parent's activeIndex
    const parent = this.getParent();
    if (parent && 'getActiveIndex' in parent && typeof parent.getActiveIndex === 'function') {
      const myIndex = this.getIndexWithinParent();
      if (myIndex === (parent as { getActiveIndex: () => number }).getActiveIndex()) {
        dom.setAttribute('data-active', '');
      }
    }
    if (config.theme.tabPanel) {
      dom.classList.add(config.theme.tabPanel);
    }
    return dom;
  }

  updateDOM(prevNode: TabPanelNode, dom: HTMLDivElement): boolean {
    if (prevNode.__label !== this.__label) {
      dom.setAttribute('data-tab-label', this.__label);
    }
    // Visibility managed by TabBarPlugin via data-active attribute, not here
    return false;
  }

  isShadowRoot(): boolean {
    return true;
  }

  canBeEmpty(): boolean {
    return false;
  }

  collapseAtStart(): boolean {
    return true;
  }

  canIndent(): boolean {
    return false;
  }

  extractWithChild(
    _child: LexicalNode,
    _selection: any,
    destination: 'clone' | 'html'
  ): boolean {
    return destination === 'html';
  }

  getLabel(): string {
    return this.getLatest().__label;
  }

  setLabel(label: string): void {
    const self = this.getWritable();
    self.__label = label;
  }

  exportJSON(): SerializedTabPanelNode {
    return {
      ...super.exportJSON(),
      label: this.__label,
    };
  }

  exportDOM(_editor: any): DOMExportOutput {
    const dom = document.createElement('div');
    dom.setAttribute('data-tab-panel', '');
    dom.setAttribute('data-tab-label', this.__label);
    return { element: dom };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      div: (domNode: HTMLElement) => {
        if (domNode.hasAttribute('data-tab-panel')) {
          return {
            conversion: $convertTabPanelElement,
            priority: 1,
          };
        }
        return null;
      },
    };
  }
}

function $convertTabPanelElement(domNode: HTMLElement): DOMConversionOutput {
  const label = domNode.getAttribute('data-tab-label') || 'Tab';
  const node = $createTabPanelNode(label);
  return { node };
}

export function $createTabPanelNode(label: string): TabPanelNode {
  return $applyNodeReplacement(new TabPanelNode(label));
}

export function $isTabPanelNode(
  node: LexicalNode | null | undefined
): node is TabPanelNode {
  return node instanceof TabPanelNode;
}
