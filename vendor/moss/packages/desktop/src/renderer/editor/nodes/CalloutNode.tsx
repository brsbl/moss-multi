// ported-from: packages/desktop/src/renderer/editor/nodes/CalloutNode.tsx @ 762abb777
import {
  $applyNodeReplacement,
  $createParagraphNode,
  $createTextNode,
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
import {
  BLOCK_HEADER_CLASSNAME,
  BLOCK_SURFACE_CLASSNAME
} from '../components/block-node-primitives';
import { createElementNodeGapCursor } from '../utils/block-gap-cursor-dom';
import { buildMarkdownFence } from '../../../common/markdown-fences';

export type CalloutType = 'warning' | 'info' | 'priority';
export type PriorityLevel = 'low' | 'medium' | 'high' | 'critical';

export const CALLOUT_TYPES: readonly CalloutType[] = ['warning', 'info', 'priority'];
export const PRIORITY_LEVELS: readonly PriorityLevel[] = ['low', 'medium', 'high', 'critical'];

const CALLOUT_ACCENT_CLASSES: Record<CalloutType, string> = {
  warning: 'bg-callout-warning',
  info: 'bg-callout-info',
  priority: 'bg-callout-warning'
};

const PRIORITY_ACCENT_CLASSES: Record<PriorityLevel, string> = {
  low: 'bg-priority-low',
  medium: 'bg-priority-medium',
  high: 'bg-priority-high',
  critical: 'bg-priority-critical'
};

const ALL_ACCENT_CLASSES = Array.from(
  new Set([
    ...Object.values(CALLOUT_ACCENT_CLASSES),
    ...Object.values(PRIORITY_ACCENT_CLASSES)
  ])
);

export function getCalloutAccentClass(
  calloutType: CalloutType,
  level?: PriorityLevel
): string {
  return calloutType === 'priority' && level
    ? PRIORITY_ACCENT_CLASSES[level]
    : CALLOUT_ACCENT_CLASSES[calloutType];
}

export type SerializedCalloutNode = Spread<
  {
    calloutType: CalloutType;
    level?: PriorityLevel;
    /**
     * Legacy JSON compatibility only. Moss persists markdown, not Lexical JSON.
     */
    content?: string;
  },
  SerializedElementNode
>;

function appendPlainContent(node: CalloutNode, content: string): void {
  const lines = content.length > 0 ? content.split('\n') : [''];
  for (const line of lines) {
    const paragraph = $createParagraphNode();
    if (line.length > 0) {
      paragraph.append($createTextNode(line));
    }
    node.append(paragraph);
  }
}

function updateCalloutDom(
  dom: HTMLElement,
  calloutType: CalloutType,
  level?: PriorityLevel
): void {
  dom.setAttribute('data-callout-type', calloutType);
  const surface = dom.classList.contains('moss-callout')
    ? dom
    : dom.querySelector('.moss-callout');
  surface?.setAttribute('data-callout-type', calloutType);

  if (level) {
    dom.setAttribute('data-callout-level', level);
    surface?.setAttribute('data-callout-level', level);
  } else {
    dom.removeAttribute('data-callout-level');
    surface?.removeAttribute('data-callout-level');
  }

  const accent = dom.querySelector('.moss-callout-accent');
  if (accent) {
    accent.classList.remove(...ALL_ACCENT_CLASSES);
    accent.classList.add(getCalloutAccentClass(calloutType, level));
  }
}

function $convertCalloutElement(domNode: HTMLElement): DOMConversionOutput | null {
  const calloutType = domNode.getAttribute('data-callout-type') as CalloutType;
  if (calloutType && CALLOUT_TYPES.includes(calloutType)) {
    const level = domNode.getAttribute('data-callout-level') as PriorityLevel | null;
    const content = domNode.textContent || '';
    const node = $createCalloutNode(calloutType, content, level || undefined);
    return { node };
  }
  return null;
}

export class CalloutNode extends ElementNode {
  __calloutType: CalloutType;
  __level: PriorityLevel | undefined;

  static getType(): string {
    return 'callout';
  }

  static clone(node: CalloutNode): CalloutNode {
    return new CalloutNode(node.__calloutType, node.__level, node.__key);
  }

  static importJSON(serializedNode: SerializedCalloutNode): CalloutNode {
    const node = $createCalloutNode(
      serializedNode.calloutType,
      undefined,
      serializedNode.level
    );

    if (
      (!serializedNode.children || serializedNode.children.length === 0) &&
      typeof serializedNode.content === 'string'
    ) {
      appendPlainContent(node, serializedNode.content);
    }

    return node;
  }

  constructor(
    calloutType: CalloutType,
    level?: PriorityLevel,
    key?: NodeKey
  ) {
    super(key);
    this.__calloutType = calloutType;
    this.__level = level;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = document.createElement('div');
    dom.className = 'moss-callout-shell relative outline-none transition-colors';
    dom.setAttribute('data-block-decorator-key', this.__key);

    dom.appendChild(createElementNodeGapCursor('before', 'Insert paragraph before callout'));

    const surface = document.createElement('div');
    surface.className = `moss-callout relative ${BLOCK_SURFACE_CLASSNAME}`;
    if (config.theme.callout) {
      surface.classList.add(config.theme.callout);
    }

    const accent = document.createElement('div');
    accent.className = `moss-callout-accent absolute inset-y-0 left-0 w-1 rounded-l-lg ${getCalloutAccentClass(this.__calloutType, this.__level)}`;

    const header = document.createElement('div');
    header.className = `moss-callout-header flex h-10 items-center gap-2 px-3 pl-4 ${BLOCK_HEADER_CLASSNAME}`;
    header.contentEditable = 'false';
    setDOMUnmanaged(header);

    surface.append(accent, header);
    dom.appendChild(surface);
    dom.appendChild(createElementNodeGapCursor('after', 'Insert paragraph after callout'));
    updateCalloutDom(dom, this.__calloutType, this.__level);
    return dom;
  }

  getDOMSlot(element: HTMLElement) {
    const surface = element.classList.contains('moss-callout')
      ? element
      : element.querySelector('.moss-callout') as HTMLElement | null;
    const slot = surface ? super.getDOMSlot(element).withElement(surface) : super.getDOMSlot(element);
    const header = surface?.querySelector('.moss-callout-header');
    return header && surface?.contains(header) ? slot.withAfter(header) : slot;
  }

  updateDOM(prevNode: CalloutNode, dom: HTMLElement): boolean {
    if (
      prevNode.__calloutType !== this.__calloutType ||
      prevNode.__level !== this.__level
    ) {
      updateCalloutDom(dom, this.__calloutType, this.__level);
    }
    return false;
  }

  static importDOM(): DOMConversionMap | null {
    return {
      div: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute('data-callout-type')) {
          return null;
        }
        return {
          conversion: $convertCalloutElement,
          priority: 1
        };
      }
    };
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('div');
    element.setAttribute('data-callout-type', this.__calloutType);
    if (this.__level) {
      element.setAttribute('data-callout-level', this.__level);
    }
    element.textContent = this.getContent();
    return { element };
  }

  exportJSON(): SerializedCalloutNode {
    const json: SerializedCalloutNode = {
      ...super.exportJSON(),
      calloutType: this.__calloutType
    };
    if (this.__level) {
      json.level = this.__level;
    }
    return json;
  }

  isShadowRoot(): boolean {
    return true;
  }

  canBeEmpty(): boolean {
    return false;
  }

  canIndent(): boolean {
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

  getCalloutType(): CalloutType {
    return this.getLatest().__calloutType;
  }

  setCalloutType(calloutType: CalloutType): void {
    const writable = this.getWritable();
    writable.__calloutType = calloutType;
  }

  getLevel(): PriorityLevel | undefined {
    return this.getLatest().__level;
  }

  setLevel(level: PriorityLevel): void {
    const writable = this.getWritable();
    writable.__level = level;
  }

  getContent(): string {
    return super.getTextContent().replace(/\n{2,}/g, '\n').trim();
  }

  setContent(content: string): void {
    const writable = this.getWritable();
    writable.clear();
    appendPlainContent(writable, content.trim());
  }

  getTextContent(): string {
    return exportCalloutToMarkdown(this.__calloutType, this.getContent(), this.__level);
  }
}

export function $createCalloutNode(
  calloutType: CalloutType,
  content?: string,
  level?: PriorityLevel
): CalloutNode {
  const node = $applyNodeReplacement(new CalloutNode(calloutType, level));
  if (content !== undefined) {
    appendPlainContent(node, content);
  }
  return node;
}

export function $isCalloutNode(node: LexicalNode | null | undefined): node is CalloutNode {
  return node instanceof CalloutNode;
}

export function exportCalloutToMarkdown(
  calloutType: CalloutType,
  content: string,
  level?: PriorityLevel
): string {
  const lines: string[] = [calloutType];
  if (calloutType === 'priority' && level) {
    lines.push(level);
  }
  if (content) {
    lines.push(content);
  }
  const payload = lines.join('\n');
  const fence = buildMarkdownFence(payload);
  return `${fence}moss-callout\n${payload}\n${fence}`;
}

export function parseCalloutContent(text: string): {
  calloutType: CalloutType;
  level?: PriorityLevel;
  content: string;
} | null {
  const lines = text.split('\n');
  if (lines.length === 0) return null;

  const readMetadataValue = (line: string, key: string): string | null => {
    const match = line.trim().match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'i'));
    return match?.[1]?.trim() ?? null;
  };

  const typeLine = readMetadataValue(lines[0], 'type') ?? lines[0].trim();
  if (!CALLOUT_TYPES.includes(typeLine as CalloutType)) return null;

  const calloutType = typeLine as CalloutType;
  const contentStartIndex = 1;

  if (calloutType === 'priority' && lines.length > contentStartIndex) {
    const possibleLevel = readMetadataValue(lines[contentStartIndex], 'level') ?? lines[contentStartIndex].trim();
    if (PRIORITY_LEVELS.includes(possibleLevel as PriorityLevel)) {
      return {
        calloutType,
        level: possibleLevel as PriorityLevel,
        content: lines.slice(contentStartIndex + 1).join('\n').trim()
      };
    }
  }

  return {
    calloutType,
    content: lines.slice(contentStartIndex).join('\n').trim()
  };
}
