// ported-from: packages/desktop/src/renderer/editor/nodes/ColorCodeNode.tsx @ 762abb777
import type { JSX } from 'react';
import {
  $applyNodeReplacement,
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

import { InlinePill } from '../components';
import { parseColorString } from '../utils/color-codes';

export type SerializedColorCodeNode = Spread<
  {
    value: string;
  },
  SerializedLexicalNode
>;

function ColorCodeComponent({ value, nodeKey }: { value: string; nodeKey: NodeKey }): JSX.Element {
  const cssColor = parseColorString(value);
  return (
    <InlinePill
      variant="color"
      size="compact"
      nodeKey={nodeKey}
      nodeKeyAttribute="data-color-node-key"
      iconPlacement="end"
      contentClassName="min-w-0 overflow-hidden text-ellipsis"
      dataAttributes={{
        'data-color-value': value
      }}
      iconElement={
        <span
          aria-hidden="true"
          data-color-swatch="true"
          className="inline-block h-3 w-3 flex-shrink-0 rounded-sm border border-border-default"
          style={{ backgroundColor: cssColor || 'transparent' }}
        />
      }
    >
      {value}
    </InlinePill>
  );
}

function $convertColorCodeElement(domNode: HTMLElement): DOMConversionOutput | null {
  const value = domNode.getAttribute('data-color-value');
  if (value) {
    return { node: $createColorCodeNode(value) };
  }
  return null;
}

export class ColorCodeNode extends DecoratorNode<JSX.Element> {
  __value: string;

  static getType(): string {
    return 'color-code';
  }

  static clone(node: ColorCodeNode): ColorCodeNode {
    return new ColorCodeNode(node.__value, node.__key);
  }

  constructor(value: string, key?: NodeKey) {
    super(key);
    this.__value = value;
  }

  static importJSON(serializedNode: SerializedColorCodeNode): ColorCodeNode {
    return $createColorCodeNode(serializedNode.value);
  }

  exportJSON(): SerializedColorCodeNode {
    return {
      type: 'color-code',
      version: 1,
      value: this.__value
    };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      span: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute('data-color-value')) {
          return null;
        }
        return {
          conversion: $convertColorCodeElement,
          priority: 1
        };
      }
    };
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('span');
    element.setAttribute('data-color-value', this.__value);
    element.textContent = this.__value;
    return { element };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    const theme = config.theme;
    const className = theme.colorCode;
    if (className) {
      span.className = className;
    }
    return span;
  }

  updateDOM(): boolean {
    return false;
  }

  getValue(): string {
    return this.__value;
  }

  setValue(value: string): void {
    const writable = this.getWritable();
    writable.__value = value;
  }

  /**
   * Returns the raw color literal so markdown serialization writes plain text
   * (the original hex / rgb / hsl form) — never a custom inline syntax.
   */
  getTextContent(): string {
    return this.__value;
  }

  decorate(): JSX.Element {
    return <ColorCodeComponent value={this.__value} nodeKey={this.__key} />;
  }

  isInline(): boolean {
    return true;
  }

  isIsolated(): boolean {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }
}

export function $createColorCodeNode(value: string): ColorCodeNode {
  return $applyNodeReplacement(new ColorCodeNode(value));
}

export function $isColorCodeNode(node: LexicalNode | null | undefined): node is ColorCodeNode {
  return node instanceof ColorCodeNode;
}
