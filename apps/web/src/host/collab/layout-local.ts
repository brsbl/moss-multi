import type { Binding } from '@lexical/yjs';
import { $getRoot, $isElementNode, SKIP_DOM_SELECTION_TAG, type LexicalEditor, type LexicalNode } from 'lexical';
import { $isTableNode } from '@lexical/table';

interface Tabs extends LexicalNode {
  getTabWidths(): (number | null)[];
  setTabWidths(widths: (number | null)[]): void;
  getActiveIndex(): number;
  setActiveIndex(index: number): void;
  getTabPanels(): unknown[];
}
interface Layout { widths: (number | null)[]; active?: number }
const TAG = 'moss-local-layout';
const tabs = (node: LexicalNode): node is Tabs => node.getType() === 'tab-group';
const keyFor = (id: string) => `moss-multi:layout-identities:${id}`;

/** Yjs item identities survive reloads and peer insertions; Lexical keys and ordinals do not. */
export function bindLocalLayout(editor: LexicalEditor, binding: Binding): () => void {
  let saved: Record<string, Layout> = {};
  try { saved = JSON.parse(localStorage.getItem(keyFor(binding.id)) ?? '{}') ?? {}; } catch { /* unavailable storage */ }
  const seen = new Set<string>();
  let stopped = false;
  const identity = (node: LexicalNode): string | null => {
    const item = binding.collabNodeMap.get(node.getKey())?.getSharedType()._item;
    return item ? `${item.id.client}:${item.id.clock}` : null;
  };
  const collect = (): LexicalNode[] => {
    const result: LexicalNode[] = [];
    const visit = (node: LexicalNode) => {
      if ($isTableNode(node) || tabs(node)) result.push(node);
      if ($isElementNode(node)) node.getChildren().forEach(visit);
    };
    visit($getRoot());
    return result;
  };
  const stop = editor.registerUpdateListener(({ editorState, tags }) => {
    if (tags.has(TAG)) return;
    const pending: { key: string; layout: Layout }[] = [];
    editorState.read(() => {
      for (const node of collect()) {
        const id = identity(node);
        if (!id) continue; // before the first Yjs hydration
        if (!seen.has(id)) {
          seen.add(id);
          const layout = saved[id];
          if (layout && Array.isArray(layout.widths)) { pending.push({ key: node.getKey(), layout }); continue; }
        }
        saved[id] = $isTableNode(node)
          ? { widths: [...(node.getColWidths() ?? [])] }
          : { widths: (node as Tabs).getTabWidths(), active: (node as Tabs).getActiveIndex() };
      }
    });
    try { localStorage.setItem(keyFor(binding.id), JSON.stringify(saved)); } catch { /* layout remains in this pane */ }
    if (pending.length) queueMicrotask(() => {
      if (stopped) return;
      editor.update(() => {
        for (const node of collect()) {
          const layout = pending.find(entry => entry.key === node.getKey())?.layout;
          if (!layout) continue;
          if ($isTableNode(node)) {
            const widths = layout.widths.filter((w): w is number => typeof w === 'number' && Number.isFinite(w) && w > 0);
            const row = node.getFirstChild();
            if ($isElementNode(row) && widths.length === row.getChildrenSize()) node.setColWidths(widths);
          } else if (tabs(node)) {
            node.setTabWidths(layout.widths.map(w => typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : null));
            node.setActiveIndex(Math.max(0, Math.min(layout.active ?? 0, node.getTabPanels().length - 1)));
          }
        }
      }, { tag: [TAG, SKIP_DOM_SELECTION_TAG], discrete: true });
    });
  });
  return () => { stopped = true; stop(); };
}
