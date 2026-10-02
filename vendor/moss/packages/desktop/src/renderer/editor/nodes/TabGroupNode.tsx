// ported-from: packages/desktop/src/renderer/editor/nodes/TabGroupNode.tsx @ 762abb777
import {
  $applyNodeReplacement,
  ElementNode,
  setDOMUnmanaged,
  type DOMConversionMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedElementNode,
  type Spread
} from 'lexical';
import { $isTabPanelNode, type TabPanelNode } from './TabPanelNode';
import { createElementNodeGapCursor } from '../utils/block-gap-cursor-dom';

const TAB_GROUP_SURFACE_CLASSNAME = 'moss-tab-group';
const TAB_BAR_CLASSNAME = 'moss-tab-bar';
const TAB_GROUP_SHELL_CLASSNAME = 'moss-tab-group-shell';

// ── Serialized shape ────────────────────────────────────────────────────

export type SerializedTabGroupNode = Spread<
  { activeIndex: number; tabWidths?: readonly (number | null)[] },
  SerializedElementNode
>;

// ── Node class ──────────────────────────────────────────────────────────

export class TabGroupNode extends ElementNode {
  __activeIndex: number;
  // null at an index = that tab is auto/unpinned. Aligns with getTabPanels() order.
  // readonly to match TableNode.__colWidths; callers replace via setTabWidths().
  __tabWidths: readonly (number | null)[];

  static getType(): string {
    return 'tab-group';
  }

  static clone(node: TabGroupNode): TabGroupNode {
    return new TabGroupNode(node.__activeIndex, node.__tabWidths, node.__key);
  }

  static importJSON(serializedNode: SerializedTabGroupNode): TabGroupNode {
    return new TabGroupNode(serializedNode.activeIndex ?? 0, serializedNode.tabWidths);
  }

  constructor(activeIndex: number = 0, tabWidths: readonly (number | null)[] = [], key?: NodeKey) {
    super(key);
    this.__activeIndex = activeIndex;
    this.__tabWidths = tabWidths;
  }

  // ── DOM ─────────────────────────────────────────────────────────────

  createDOM(config: EditorConfig): HTMLDivElement {
    const dom = document.createElement('div');
    dom.classList.add(TAB_GROUP_SHELL_CLASSNAME);
    dom.setAttribute('data-block-decorator-key', this.__key);

    dom.appendChild(createElementNodeGapCursor('before', 'Insert paragraph before tabs'));

    const surface = document.createElement('div');
    surface.classList.add(TAB_GROUP_SURFACE_CLASSNAME);

    // Tab bar: non-Lexical DOM, rendered by TabBarPlugin via React portal.
    // Placed first so it appears above the children (TabPanelNode elements).
    // setDOMUnmanaged tells Lexical's reconciler to ignore this element.
    const tabBar = document.createElement('div');
    tabBar.classList.add(TAB_BAR_CLASSNAME);
    tabBar.contentEditable = 'false';
    setDOMUnmanaged(tabBar);
    surface.appendChild(tabBar);
    dom.appendChild(surface);
    dom.appendChild(createElementNodeGapCursor('after', 'Insert paragraph after tabs'));

    // TabPanelNode children are reconciled directly into dom, AFTER the tab bar.
    // getDOMSlot().withAfter(tabBar) tells Lexical to insert children after it.

    if (config.theme.tabGroup) {
      surface.classList.add(config.theme.tabGroup);
    }

    return dom;
  }

  getDOMSlot(element: HTMLElement) {
    // Children go into the tab surface, after the unmanaged tab bar.
    // This matches TableNode's pattern: children in the table, after the colgroup.
    const surface = element.querySelector(`.${TAB_GROUP_SURFACE_CLASSNAME}`) as HTMLElement | null;
    const slot = surface ? super.getDOMSlot(element).withElement(surface) : super.getDOMSlot(element);
    const tabBar = surface?.querySelector(`.${TAB_BAR_CLASSNAME}`);
    return tabBar && surface?.contains(tabBar) ? slot.withAfter(tabBar) : slot;
  }

  updateDOM(_prevNode: TabGroupNode, _dom: HTMLDivElement): boolean {
    // NEVER return true -- it destroys and recreates DOM, killing React portals
    return false;
  }

  // ── Element behavior ────────────────────────────────────────────────

  isShadowRoot(): boolean {
    return true;
  }

  canBeEmpty(): boolean {
    return false;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  extractWithChild(
    _child: LexicalNode,
    _selection: unknown,
    destination: 'clone' | 'html'
  ): boolean {
    return destination === 'html';
  }

  // ── Active index ────────────────────────────────────────────────────

  getActiveIndex(): number {
    return this.getLatest().__activeIndex;
  }

  setActiveIndex(index: number): void {
    const self = this.getWritable();
    self.__activeIndex = index;
  }

  // ── Tab widths ──────────────────────────────────────────────────────

  getTabWidths(): readonly (number | null)[] {
    return this.getLatest().__tabWidths;
  }

  setTabWidths(widths: readonly (number | null)[]): void {
    const self = this.getWritable();
    self.__tabWidths = widths;
  }

  // Route selection to active panel (prevents cursor entering hidden panels)
  selectStart(): import('lexical').RangeSelection {
    const panel = this.getActivePanel();
    if (panel) return panel.selectStart();
    return super.selectStart();
  }

  selectEnd(): import('lexical').RangeSelection {
    const panel = this.getActivePanel();
    if (panel) return panel.selectEnd();
    return super.selectEnd();
  }

  // ── Child helpers ───────────────────────────────────────────────────

  getTabPanels(): TabPanelNode[] {
    return this.getChildren().filter($isTabPanelNode);
  }

  getActivePanel(): TabPanelNode | null {
    const panels = this.getTabPanels();
    return panels[this.getActiveIndex()] ?? null;
  }

  // ── Text content (clipboard / search) ───────────────────────────────

  getTextContent(): string {
    const panels = this.getTabPanels();
    return panels.map((p) => `=== ${p.getLabel()}\n${p.getTextContent()}`).join('\n');
  }

  // ── Serialization ───────────────────────────────────────────────────

  exportJSON(): SerializedTabGroupNode {
    return {
      ...super.exportJSON(),
      activeIndex: this.__activeIndex,
      ...(this.__tabWidths.length > 0 ? { tabWidths: this.__tabWidths } : {})
    };
  }

  exportDOM(): DOMExportOutput {
    const dom = document.createElement('div');
    dom.setAttribute('data-tab-group', '');
    const panels = this.getTabPanels();
    dom.textContent = `[Tabs: ${panels.map((p) => p.getLabel()).join(', ')}]`;
    return { element: dom };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      div: (domNode: HTMLElement) => {
        if (domNode.hasAttribute('data-tab-group')) {
          return {
            conversion: $convertTabGroupElement,
            priority: 1
          };
        }
        return null;
      }
    };
  }

  // DecoratorNode had decorate() -- ElementNode does not. Tab bar UI is
  // rendered by TabBarPlugin as a React portal into .moss-tab-bar.
}

// ── DOM conversion ──────────────────────────────────────────────────────

function $convertTabGroupElement(_domNode: HTMLElement): DOMConversionOutput {
  const node = $createTabGroupNode();
  return { node };
}

// ── Helpers ─────────────────────────────────────────────────────────────

export function $createTabGroupNode(activeIndex: number = 0): TabGroupNode {
  return $applyNodeReplacement(new TabGroupNode(activeIndex));
}

export function $isTabGroupNode(
  node: LexicalNode | null | undefined
): node is TabGroupNode {
  return node instanceof TabGroupNode;
}
