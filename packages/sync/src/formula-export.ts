import { $getRoot, $isElementNode, type LexicalNode } from 'lexical';
import { evaluateWorkspaceFormulas } from '@moss-desktop/renderer/editor/utils/formula-runtime';

interface Formula extends LexicalNode {
  getFormulaId(): string; getName(): string | null; getFormula(): string; getResult(): string; isStale(): boolean;
  setResult(result: string): void; setStale(stale: boolean): void;
}
/** Recompute on the disposable export mirror, never on the shared doc or a viewer's undo stack. */
export function $recomputeExportFormulas(noteId: string): void {
  const nodes: Formula[] = [];
  const visit = (node: LexicalNode) => {
    if (node.getType() === 'formula') nodes.push(node as Formula);
    if ($isElementNode(node)) node.getChildren().forEach(visit);
  };
  visit($getRoot());
  const evaluation = evaluateWorkspaceFormulas(nodes.map(node => ({
    noteId, noteTitle: '', formulaId: node.getFormulaId(), name: node.getName(),
    expression: node.getFormula(), result: node.getResult(), stale: node.isStale(),
  })));
  for (const record of evaluation.byKey.values()) {
    const node = nodes.find(node => node.getFormulaId() === record.formulaId);
    if (node && record.sourceMode === 'executable') { node.setResult(record.result); node.setStale(record.stale); }
  }
}
