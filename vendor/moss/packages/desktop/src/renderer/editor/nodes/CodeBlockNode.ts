// ported-from: packages/desktop/src/renderer/editor/nodes/CodeBlockNode.tsx @ 762abb777 (extracted)
// moss-multi seam: register payloads (A§10.10).
import { readRegister, writeRegister } from '@moss-multi/host/collab/registers';
import type { JSX } from 'react';
import { $applyNodeReplacement, type DOMConversionMap, type DOMConversionOutput, type DOMExportOutput, DecoratorNode, type EditorConfig, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread } from 'lexical';
import { resolveLanguage } from '../plugins/code-block/languages';
import { cloneCommentIds } from '../utils/commentable-node';
import { DEFAULT_THEME } from '../plugins/code-block/themes';
import { renderNodeView } from './node-views';

const pendingAutoEditKeys = new Set<string>();

export function markCodeBlockForAutoEdit(key: string): void {
  pendingAutoEditKeys.add(key);
}

export function consumeAutoEdit(key: string): boolean {
  return pendingAutoEditKeys.delete(key);
}

export type SerializedCodeBlockNode = Spread<
  {
    code: string;
    language: string;
    theme?: string;
    commentIds?: string[];
  },
  SerializedLexicalNode
>;

function $convertCodeElement(domNode: HTMLElement): DOMConversionOutput | null {
  const code = domNode.textContent || '';
  const language = domNode.getAttribute('data-language') || 'plaintext';

  const node = $createCodeBlockNode(code, language);
  return { node };
}

export class CodeBlockNode extends DecoratorNode<JSX.Element> {
  __regId = '';
  __code: string;
  __language: string;
  __theme: string;
  __commentIds: string[];

  afterCloneFrom(previous: this): void {
    super.afterCloneFrom(previous);
    this.__regId = previous.__regId;
  }

  static getType(): string {
    return 'code-block';
  }

  static clone(node: CodeBlockNode): CodeBlockNode {
    return new CodeBlockNode(node.__code, node.__language, node.__key, cloneCommentIds(node.__commentIds), node.__theme);
  }

  constructor(code: string, language: string = 'plaintext', key?: NodeKey, commentIds: string[] = [], theme: string = DEFAULT_THEME) {
    super(key);
    this.__code = code;
    this.__language = resolveLanguage(language);
    this.__theme = theme;
    this.__commentIds = commentIds;
  }

  static importJSON(serializedNode: SerializedCodeBlockNode): CodeBlockNode {
    const node = $createCodeBlockNode(serializedNode.code, serializedNode.language);
    if (serializedNode.theme) {
      node.__theme = serializedNode.theme;
    }
    if (serializedNode.commentIds) {
      node.__commentIds = serializedNode.commentIds;
    }
    return node;
  }

  exportJSON(): SerializedCodeBlockNode {
    return {
      type: 'code-block',
      version: 1,
      code: this.getCode(),
      language: this.__language,
      ...(this.__theme !== DEFAULT_THEME ? { theme: this.__theme } : {}),
      ...(this.__commentIds.length > 0 ? { commentIds: this.__commentIds } : {})
    };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      pre: () => ({
        conversion: $convertCodeElement,
        priority: 1
      })
    };
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('pre');
    const codeElement = document.createElement('code');
    codeElement.textContent = this.getCode();
    codeElement.setAttribute('data-language', this.__language);
    element.appendChild(codeElement);
    return { element };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const div = document.createElement('div');
    const theme = config.theme;
    const className = theme.codeBlock;
    if (className) {
      div.className = className;
    }
    return div;
  }

  updateDOM(): boolean {
    return false;
  }

  getCode(): string {
    return readRegister(this, this.__code);
  }

  setCode(code: string): void {
    const writable = this.getWritable();
    writable.__code = code;
    writeRegister(writable, code);
  }

  getLanguage(): string {
    return this.__language;
  }

  setLanguage(language: string): void {
    const writable = this.getWritable();
    writable.__language = resolveLanguage(language);
  }

  getCommentIds(): string[] {
    return this.__commentIds;
  }

  setCommentIds(ids: string[]): void {
    const writable = this.getWritable();
    writable.__commentIds = ids;
  }

  getTheme(): string {
    return this.__theme;
  }

  setTheme(theme: string): void {
    const writable = this.getWritable();
    writable.__theme = theme;
  }

  getTextContent(): string {
    return '```' + (this.__language || '') + '\n' + this.getCode() + '\n```';
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

export function $createCodeBlockNode(
  code: string = '',
  language: string = 'plaintext'
): CodeBlockNode {
  return $applyNodeReplacement(new CodeBlockNode(code, language));
}

export function $isCodeBlockNode(
  node: LexicalNode | null | undefined
): node is CodeBlockNode {
  return node instanceof CodeBlockNode;
}
