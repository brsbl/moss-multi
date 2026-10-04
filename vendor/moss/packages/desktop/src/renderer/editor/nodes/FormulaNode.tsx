// ported-from: packages/desktop/src/renderer/editor/nodes/FormulaNode.tsx @ 762abb777
// moss-multi seam: register payloads (A§10.10).
import { readRegister, writeRegister, initRegisterNode, resetRegisterOnCopy } from '@moss-multi/host/collab/registers';
import type { JSX } from 'react';
// moss-multi seam: local-view (A§10): computed values paint locally, outside the shared node.
import { useNodeView } from '@moss-multi/host/collab/view-state';
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
import {
  classifyFormulaSource,
  evaluateArithmeticExpression,
  serializeFormulaMarkdownPayload
} from '../utils/formula-runtime';
import { initCommentIds, cloneCommentIds, exportCommentIds, importCommentIds } from '../utils/commentable-node';

export type SerializedFormulaNode = Spread<
  {
    formula: string;
    result: string;
    formulaId?: string;
    name?: string | null;
    stale?: boolean;
    commentIds?: string[];
  },
  SerializedLexicalNode
>;

export interface FormulaNodeCreateOptions {
  formulaId?: string;
  name?: string | null;
  stale?: boolean;
  commentIds?: string[];
}

export const createFormulaId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `formula-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

export const humanizeFormulaExpression = (expression: string): string =>
  expression.replace(
    /@\(([a-zA-Z][a-zA-Z0-9_-]*)#[0-9a-fA-F-]{36}#[0-9a-fA-F-]{36}\)/g,
    '$1'
  );

/**
 * Safely evaluates a mathematical expression
 * Only allows numbers and basic math operators
 */
export const evaluateFormula = (expression: string): number | null => {
  return evaluateArithmeticExpression(expression);
};

/**
 * Formats a number with comma separators for thousands
 */
export const formatNumber = (num: number): string => {
  const [integerPart, decimalPart] = num.toString().split('.');
  const formattedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decimalPart ? `${formattedInteger}.${decimalPart}` : formattedInteger;
};

function FormulaComponent({
  formula,
  result,
  formulaId,
  stale,
  nodeKey
}: {
  formula: string;
  result: string;
  formulaId: string;
  stale: boolean;
  nodeKey: NodeKey;
}): JSX.Element {
  const view = useNodeView(nodeKey);
  result = view?.result ?? result;
  stale = view?.stale ?? stale;
  const sourceMode = classifyFormulaSource(formula, { storedDisplay: result });
  const isSymbolic = sourceMode === 'symbolic';
  const isStale = stale && !isSymbolic;

  return (
    <InlinePill
      variant="formula"
      size="compact"
      nodeKey={nodeKey}
      nodeKeyAttribute="data-formula-node-key"
      dataAttributes={{
        'data-formula-id': formulaId,
        'data-formula-source-mode': sourceMode,
        ...(isStale ? { 'data-formula-stale': 'true' } : {})
      }}
    >
      <span className={isStale ? 'border-b border-dotted border-accent-brand/50' : ''}>
        {result}
      </span>
    </InlinePill>
  );
}

function $convertFormulaElement(domNode: HTMLElement): DOMConversionOutput | null {
  const formula = domNode.getAttribute('data-formula');
  const result = domNode.getAttribute('data-result');
  const formulaId = domNode.getAttribute('data-formula-id');
  const name = domNode.getAttribute('data-formula-name');
  const stale = domNode.getAttribute('data-formula-stale') === 'true';

  if (formula && result) {
    const node = $createFormulaNode(formula, result, {
      ...(formulaId ? { formulaId } : {}),
      ...(name ? { name } : {}),
      stale
    });
    return { node };
  }
  return null;
}

export class FormulaNode extends DecoratorNode<JSX.Element> {
  __regId = initRegisterNode(this);
  __formula: string;
  __result: string;
  __formulaId: string;
  __name: string | null;
  __stale: boolean;
  __commentIds: string[];

  afterCloneFrom(previous: this): void {
    super.afterCloneFrom(previous);
    this.__regId = previous.__regId;
  }

  resetOnCopyNodeFrom(original: this): void {
    super.resetOnCopyNodeFrom(original);
    resetRegisterOnCopy(this);
  }

  static getType(): string {
    return 'formula';
  }

  static clone(node: FormulaNode): FormulaNode {
    return new FormulaNode(
      node.__formula,
      node.__result,
      {
        formulaId: node.__formulaId,
        name: node.__name,
        stale: node.__stale,
        commentIds: cloneCommentIds(node.__commentIds)
      },
      node.__key
    );
  }

  constructor(
    formula: string,
    result: string,
    options?: FormulaNodeCreateOptions,
    key?: NodeKey
  ) {
    super(key);
    this.__formula = formula;
    this.__result = result;
    this.__formulaId = options?.formulaId ?? createFormulaId();
    this.__name = options?.name ?? null;
    this.__stale = options?.stale ?? false;
    this.__commentIds = initCommentIds(options?.commentIds);
  }

  static importJSON(serializedNode: SerializedFormulaNode): FormulaNode {
    return $createFormulaNode(serializedNode.formula, serializedNode.result, {
      ...(serializedNode.formulaId ? { formulaId: serializedNode.formulaId } : {}),
      ...(typeof serializedNode.name === 'string' ? { name: serializedNode.name } : {}),
      ...(serializedNode.stale ? { stale: true } : {}),
      commentIds: importCommentIds(serializedNode as unknown as Record<string, unknown>)
    });
  }

  exportJSON(): SerializedFormulaNode {
    return {
      type: 'formula',
      version: 1,
      formula: this.getFormula(),
      result: this.__result,
      formulaId: this.__formulaId,
      name: this.__name,
      stale: this.__stale,
      ...exportCommentIds(this.__commentIds)
    };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      span: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute('data-formula')) {
          return null;
        }
        return {
          conversion: $convertFormulaElement,
          priority: 1
        };
      }
    };
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('span');
    element.setAttribute('data-formula', this.getFormula());
    element.setAttribute('data-result', this.__result);
    element.setAttribute('data-formula-id', this.__formulaId);
    if (this.__name) {
      element.setAttribute('data-formula-name', this.__name);
    }
    if (this.__stale) {
      element.setAttribute('data-formula-stale', 'true');
    }
    element.textContent = this.__result;
    return { element };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    const theme = config.theme;
    const className = theme.formula;
    if (className) {
      span.className = className;
    }
    return span;
  }

  updateDOM(): boolean {
    return false;
  }

  getFormula(): string {
    return readRegister(this, this.__formula);
  }

  getResult(): string {
    return this.__result;
  }

  getFormulaId(): string {
    return this.__formulaId;
  }

  getName(): string | null {
    return this.__name;
  }

  isStale(): boolean {
    return this.__stale;
  }

  setResult(result: string): void {
    const writable = this.getWritable();
    writable.__result = result;
  }

  setFormula(formula: string): void {
    if (writeRegister(this, formula)) return;
    const writable = this.getWritable();
    writable.__formula = formula;
  }

  setFormulaId(formulaId: string): void {
    const writable = this.getWritable();
    writable.__formulaId = formulaId;
  }

  setName(name: string | null): void {
    const writable = this.getWritable();
    writable.__name = name;
  }

  setStale(stale: boolean): void {
    const writable = this.getWritable();
    writable.__stale = stale;
  }

  getCommentIds(): string[] {
    return this.__commentIds;
  }

  setCommentIds(ids: string[]): void {
    const writable = this.getWritable();
    writable.__commentIds = ids;
  }

  getTextContent(): string {
    const sourceMode = classifyFormulaSource(this.getFormula(), {
      storedDisplay: this.__result
    });
    return `{{${serializeFormulaMarkdownPayload({
      expression: this.getFormula(),
      result: this.__result,
      formulaId: this.__formulaId,
      name: sourceMode === 'symbolic' ? null : this.__name,
      stale: sourceMode === 'symbolic' ? false : this.__stale
    })}}}`;
  }

  decorate(): JSX.Element {
    return (
      <FormulaComponent
        formula={this.getFormula()}
        result={this.__result}
        formulaId={this.__formulaId}
        stale={this.__stale}
        nodeKey={this.__key}
      />
    );
  }

  isInline(): boolean {
    return true;
  }

  isIsolated(): boolean {
    return true;
  }
}

export function $createFormulaNode(
  formula: string,
  result: string,
  options?: FormulaNodeCreateOptions
): FormulaNode {
  return $applyNodeReplacement(new FormulaNode(formula, result, options));
}

export function $isFormulaNode(node: LexicalNode | null | undefined): node is FormulaNode {
  return node instanceof FormulaNode;
}
