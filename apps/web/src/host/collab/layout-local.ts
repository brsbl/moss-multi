import { $collectTableLayoutMetadata, $collectTabGroupLayoutMetadata, type LocalLayoutMetadata } from '@moss-desktop/renderer/editor/markdown/transformers';
import type { Binding } from '@lexical/yjs';
import { $getRoot, $isElementNode, SKIP_DOM_SELECTION_TAG, type EditorState, type LexicalEditor, type LexicalNode } from 'lexical';
import { $isTableNode } from '@lexical/table';
import { getState } from 'yjs';

interface Tabs extends LexicalNode {
  getTabWidths(): (number | null)[];
  setTabWidths(widths: (number | null)[]): void;
  getActiveIndex(): number;
  setActiveIndex(index: number): void;
  getTabPanels(): unknown[];
}
interface Layout { widths: (number | null)[]; active?: number }
const TAG = 'moss-local-layout';
/** Writes are coalesced (a column drag is many updates) and flushed on teardown and pagehide. */
export const LAYOUT_FLUSH_MS = 300;
const tabs = (node: LexicalNode): node is Tabs => node.getType() === 'tab-group';
const keyFor = (id: string) => `moss-multi:layout-identities:${id}`;
const read = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
const parse = (text: string | null): unknown => { try { return text === null ? null : JSON.parse(text); } catch { return null; } };
const isLayout = (value: unknown): value is Layout => !!value && typeof value === 'object' && Array.isArray((value as Layout).widths);

/** Yjs item identities survive reloads and peer insertions; Lexical keys and ordinals do not. */
export function bindLocalLayout(editor: LexicalEditor, binding: Binding): () => void {
  const identityKey = keyFor(binding.id);
  const legacyKey = `moss-multi:layout:${binding.id}`;
  const stored: Record<string, string | null> = { [identityKey]: read(identityKey), [legacyKey]: read(legacyKey) };
  const saved: Record<string, Layout> = {};
  const parsed = parse(stored[identityKey]);
  if (parsed && typeof parsed === 'object') for (const [id, layout] of Object.entries(parsed)) if (isLayout(layout)) saved[id] = layout;
  // Ordinals migrate only into a note with no identity store: once one exists, a stale ordinal never transfers a width.
  const legacyParsed = stored[identityKey] === null ? parse(stored[legacyKey]) as LocalLayoutMetadata | null : null;
  let legacy = legacyParsed?.version === 1 ? legacyParsed : null;
  const seen = new Set<string>();
  const queued = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Some table or tab has no Yjs identity yet (before hydration): every update is scanned until all do.
  let unresolved = true;
  let stopped = false;

  const flush = () => {
    clearTimeout(timer); timer = undefined;
    for (const [key, value] of queued) {
      try { localStorage.setItem(key, value); } catch { /* layout remains in this pane */ }
      stored[key] = value;
    }
    queued.clear();
  };
  const queue = (key: string, value: string) => {
    if (value === stored[key]) queued.delete(key); else queued.set(key, value);
    if (queued.size && timer === undefined) timer = setTimeout(flush, LAYOUT_FLUSH_MS);
  };
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
  const current = (node: LexicalNode): Layout => $isTableNode(node)
    ? { widths: [...(node.getColWidths() ?? [])] }
    : { widths: (node as Tabs).getTabWidths(), active: (node as Tabs).getActiveIndex() };

  const scan = (state: EditorState) => {
    const pending: { key: string; layout: Layout }[] = [];
    let metadata = null as string | null;
    let skip = false as boolean;
    state.read(() => {
      const nodes = collect();
      const tables = nodes.filter($isTableNode);
      const groups = nodes.filter(tabs);
      const live = new Set<string>();
      unresolved = false;
      for (const node of nodes) {
        const id = identity(node);
        if (!id) { unresolved = true; continue; }
        live.add(id);
        if (!seen.has(id)) {
          seen.add(id);
          let layout: Layout | undefined = saved[id];
          if (!layout && legacy) {
            if ($isTableNode(node) && tables.length === legacy.tableCount) {
              layout = { widths: legacy.tables[tables.indexOf(node)]?.columnWidths ?? [] };
            } else if (tabs(node) && groups.length === legacy.tabGroupCount) {
              layout = { widths: legacy.tabGroups?.[groups.indexOf(node)]?.tabWidths ?? [] };
            }
          }
          if (isLayout(layout)) { saved[id] = layout; pending.push({ key: node.getKey(), layout }); continue; }
        }
        saved[id] = current(node);
      }
      // An empty tree before the first sync says nothing about the note's layout.
      skip = unresolved || (!nodes.length && binding.doc.store.clients.size === 0);
      if (skip) return;
      if (nodes.length) legacy = null;
      // An identity the doc already holds but the hydrated tree lacks was deleted: Yjs never revives an item.
      for (const id of Object.keys(saved)) {
        if (live.has(id)) continue;
        const [client, clock] = id.split(':').map(Number);
        if (Number.isFinite(client) && Number.isFinite(clock) && clock < getState(binding.doc.store, client)) { delete saved[id]; seen.delete(id); }
      }
      if (!pending.length && (nodes.length || stored[legacyKey] !== null)) {
        metadata = JSON.stringify({ ...$collectTableLayoutMetadata(), ...$collectTabGroupLayoutMetadata() });
      }
    });
    if (skip) return pending;
    if (metadata !== null) queue(legacyKey, metadata);
    if (Object.keys(saved).length || stored[identityKey] !== null) queue(identityKey, JSON.stringify(saved));
    return pending;
  };

  const restore = (pending: { key: string; layout: Layout }[]) => {
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
  };

  const stop = editor.registerUpdateListener(({ editorState, prevEditorState, dirtyElements, tags }) => {
    if (!unresolved && !tags.has(TAG)) {
      // Only an update that writes, creates or removes a table or tab group can change layout.
      let touched = false;
      for (const [key, intentional] of dirtyElements) {
        if (!intentional) continue; // an ancestor of an edit, such as a table around a typed cell
        const node = editorState._nodeMap.get(key) ?? prevEditorState._nodeMap.get(key);
        if (node && ($isTableNode(node) || tabs(node))) { touched = true; break; }
      }
      if (!touched) return;
    }
    restore(scan(editorState));
  });
  restore(scan(editor.getEditorState()));
  const win = typeof window === 'undefined' ? null : window;
  win?.addEventListener('pagehide', flush);
  return () => { stopped = true; stop(); win?.removeEventListener('pagehide', flush); flush(); };
}
