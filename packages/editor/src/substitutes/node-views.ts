// Substituted for the generated nodes/node-views.ts in the editor bundle (A§2.1, T3.12): the same registry, plus views
// whose code loads on first use (lazy-views.ts). A lazy family's decorate() always renders a Suspense boundary over
// LazyNodeView, before and after its chunk arrives, so the block never remounts; while the chunk loads, the
// family's placeholder holds the block's place.
import { Suspense, createElement, use, type ReactNode } from 'react';
import { $getNodeByKey, type LexicalNode, type NodeKey } from 'lexical';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';

type NodeView = (this: LexicalNode, ...args: unknown[]) => unknown;
type NodeViewWrapper = (type: string, element: unknown) => unknown;

interface DeferredView {
  load: () => Promise<unknown>;
  placeholder: (node: LexicalNode) => ReactNode;
  loading: Promise<void> | null;
}

const views = new Map<string, NodeView>();
const deferred = new Map<string, DeferredView>();
let wrapView: NodeViewWrapper = (_type, element) => element;

export function registerNodeView<N extends LexicalNode>(type: string, view: (this: N, ...args: never[]) => unknown): void {
  views.set(type, view as unknown as NodeView);
}

export function setNodeViewWrapper(wrapper: NodeViewWrapper): void {
  wrapView = wrapper;
}

/** `type`'s view is registered by the module `load` imports; `placeholder` stands in for it until then. */
export function registerLazyNodeView(type: string, load: () => Promise<unknown>, placeholder: (node: LexicalNode) => ReactNode): void {
  deferred.set(type, { load, placeholder, loading: null });
}

/** Loads `type`'s view once; a failed load is tried again on the next call. */
export function loadNodeView(type: string): Promise<void> {
  const entry = deferred.get(type);
  if (!entry) return Promise.resolve();
  entry.loading ??= entry.load().then(
    () => undefined,
    (error: unknown) => {
      entry.loading = null;
      throw error;
    },
  );
  return entry.loading;
}

function LazyNodeView({ type, nodeKey, args, element }: { type: string; nodeKey: NodeKey; args: readonly unknown[]; element: { view: unknown } | null }): ReactNode {
  const [editor] = useLexicalComposerContext();
  if (element) return element.view as ReactNode;
  if (!views.has(type)) use(loadNodeView(type));
  const view = views.get(type);
  return editor.getEditorState().read(
    () => {
      const node = $getNodeByKey(nodeKey);
      return node && view ? (view.apply(node, [...args]) as ReactNode) : null;
    },
    { editor },
  );
}

export function renderNodeView<T>(node: LexicalNode, args: readonly unknown[] = []): T {
  const type = node.getType();
  const view = views.get(type);
  const lazy = deferred.get(type);
  if (lazy) {
    const element = view ? { view: view.apply(node, [...args]) } : null;
    const inner = createElement(LazyNodeView, { type, nodeKey: node.getKey(), args, element });
    return wrapView(type, createElement(Suspense, { fallback: lazy.placeholder(node) }, inner)) as T;
  }
  if (!view) return null as T;
  return wrapView(type, view.apply(node, [...args])) as T;
}
