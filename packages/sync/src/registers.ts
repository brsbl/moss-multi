import {
  $getEditor, $getNodeByKey, $getRoot, $isElementNode, COLLABORATION_TAG, type EditorState, type LexicalEditor, type LexicalNode, type NodeKey,
} from 'lexical';
import * as Y from 'yjs';
import { diffText } from '@moss-multi/core/text-diff';

export const REGISTER_LOCAL_ORIGIN = Symbol('moss-multi:register-local');
const REGISTER_INIT = Symbol('moss-multi:register-init');
const REFRESH_TAG = 'moss-multi:register-refresh';
export const REGISTER_FIELDS: Readonly<Record<string, string>> = {
  'code-block': '__code', 'html-block': '__rawHtml', formula: '__formula',
};
type RegisterNode = LexicalNode & { __regId: string; [key: string]: unknown };
const bindings = new WeakMap<LexicalEditor, Y.Doc>();
const nodeDocs = new WeakMap<LexicalNode, Y.Doc>();
const serialized = new WeakSet<Y.Doc>();
let bindingCount = 0;
const payloads = new WeakMap<Y.Text, string>();
const invalidated = new WeakSet<Y.Doc>();

/**
 * A register's text, cached between transactions: every Lexical commit reads each top-level node's text, so an
 * uncached read stringifies every register per keystroke. A transaction's changes evict before its observers run,
 * and reads while one is open or still cleaning up bypass the cache.
 */
function payload(text: Y.Text): string {
  const doc = text.doc;
  if (!doc || doc._transaction || doc._transactionCleanups.length) return text.toString();
  if (!invalidated.has(doc)) {
    invalidated.add(doc);
    doc.on('beforeObserverCalls', (transaction: Y.Transaction) => {
      for (const type of transaction.changed.keys()) if (type instanceof Y.Text) payloads.delete(type);
    });
  }
  let value = payloads.get(text);
  if (value === undefined) payloads.set(text, value = text.toString());
  return value;
}

export const registerDoc = (editor: LexicalEditor): Y.Doc | undefined => bindings.get(editor);

/** Upgrade pre-register V1 nodes in place, before admission; retain legacy attributes. */
export function migrateRegisters(doc: Y.Doc): void {
  const registers = doc.getMap<Y.Text>('registers');
  const visit = (type: Y.XmlText | Y.XmlElement) => {
    const attrs = type.getAttributes() as Record<string, unknown>;
    const field = REGISTER_FIELDS[String(attrs.__type)];
    if (field && !attrs.__regId && typeof attrs[field] === 'string') {
      const item = type._item;
      if (!item) return;
      const id = `legacy:${item.id.client}:${item.id.clock}`;
      if (!registers.has(id)) registers.set(id, new Y.Text(attrs[field] as string));
      type.setAttribute('__regId', id);
    }
    const children = type instanceof Y.XmlText ? type.toDelta().map((op: { insert?: unknown }) => op.insert) : type.toArray();
    for (const child of children) if (child instanceof Y.XmlText || child instanceof Y.XmlElement) visit(child);
  };
  doc.transact(() => visit(doc.get('root', Y.XmlText)), REGISTER_INIT);
}
function currentDoc(): Y.Doc | undefined {
  if (!bindingCount) return undefined;
  // SerializedEditorState.toJSON() has no active editor; cached fields cover that read.
  try { return bindings.get($getEditor()); } catch { return undefined; }
}
/** Lexical also reads text while committing, outside an active-editor context. */
export function initRegisterNode(node: LexicalNode): string {
  const doc = currentDoc();
  if (doc) nodeDocs.set(node, doc);
  return '';
}
export function readRegister(node: LexicalNode, fallback: string): string {
  const id = (node as RegisterNode).__regId;
  const text = id && (nodeDocs.get(node) ?? currentDoc())?.getMap('registers').get(id);
  return text instanceof Y.Text ? payload(text) : fallback ?? '';
}
export function writeRegister(node: LexicalNode, next: string): boolean {
  const doc = currentDoc();
  const id = (node as RegisterNode).__regId;
  const text = id && doc?.getMap('registers').get(id);
  const current = doc && text instanceof Y.Text ? payload(text) : next;
  if (current !== next) doc!.transact(() => (text as Y.Text).applyDelta(diffText(current, next)), REGISTER_LOCAL_ORIGIN);
  return text instanceof Y.Text;
}

/**
 * Serialized writers (the DocDO mirror, unbound converters) import repeatable identities; identical blocks still get
 * independent registers. A live editor's import (whole-note paste) can race a peer's, so it mints unique ids.
 */
export function $assignRegisterIds(): void {
  const doc = currentDoc();
  const unique = doc !== undefined && !serialized.has(doc);
  const used = new Set(doc?.getMap('registers').keys());
  // Ordinals only grow per prefix, so N identical blocks cost O(N), not O(N^2).
  const next = new Map<string, number>();
  const walk = (node: LexicalNode) => {
    const field = REGISTER_FIELDS[node.getType()];
    if (field && unique) {
      (node.getWritable() as RegisterNode).__regId = crypto.randomUUID();
    } else if (field) {
      const target = node as RegisterNode;
      const seed = `${node.getType()}:${String(target[field])}`;
      let hash = 2166136261;
      for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
      const prefix = `import:${node.getType()}:${(hash >>> 0).toString(16)}`;
      let ordinal = next.get(prefix) ?? 0;
      while (used.has(`${prefix}:${ordinal}`)) ordinal++;
      next.set(prefix, ordinal + 1);
      const id = `${prefix}:${ordinal}`;
      used.add(id);
      (target.getWritable() as RegisterNode).__regId = id;
    }
    if ($isElementNode(node)) for (const child of node.getChildren()) walk(child);
  };
  walk($getRoot());
}

/** Copy the payload into one node's excluded render cache. Never writes to the shared tree. */
function $refreshNode(node: LexicalNode | null, registers: Y.Map<Y.Text>): void {
  const field = node && REGISTER_FIELDS[node.getType()];
  if (!node || !field) return;
  const target = node as RegisterNode;
  const text = registers.get(target.__regId);
  if (!(text instanceof Y.Text)) return;
  const value = payload(text);
  if (target[field] !== value) (target.getWritable() as RegisterNode)[field] = value;
}

/** Fill every register node's cache once; a hydrated mirror needs it before its first read. */
export function $refreshRegisters(editor: LexicalEditor, doc: Y.Doc): void {
  const registers = doc.getMap<Y.Text>('registers');
  for (const snapshot of editor.getEditorState()._nodeMap.values()) {
    if (REGISTER_FIELDS[snapshot.getType()]) $refreshNode($getNodeByKey(snapshot.getKey()), registers);
  }
}

/** Installed before V1 hydration on both the client and the DocDO mirror (`serializedImports`, one writer). */
export function bindRegisters(editor: LexicalEditor, doc: Y.Doc, { serializedImports = false } = {}): () => void {
  bindings.set(editor, doc);
  if (serializedImports) serialized.add(doc);
  bindingCount++;
  const registers = doc.getMap<Y.Text>('registers');
  const stops: (() => void)[] = [];
  for (const [type, field] of Object.entries(REGISTER_FIELDS)) {
    const klass = editor._nodes.get(type)?.klass;
    if (!klass) continue;
    stops.push(editor.registerNodeTransform(klass, (value) => {
      const node = value as RegisterNode;
      if (!node.__regId) node.getWritable().__regId = crypto.randomUUID();
      const id = (node.getLatest() as RegisterNode).__regId;
      if (!registers.has(id)) {
        doc.transact(() => registers.set(id, new Y.Text(String(node[field] ?? ''))), REGISTER_INIT);
      }
      const shared = payload(registers.get(id)!);
      if (node[field] !== shared) node.getWritable()[field] = shared;
    }));
  }
  // Refreshes stay proportional to what changed: the nodes an update touched and the registers whose text moved.
  const keysById = new Map<string, Set<NodeKey>>();
  const idByKey = new Map<NodeKey, string>();
  const dirtyKeys = new Set<NodeKey>();
  const dirtyIds = new Set<string>();
  const index = (key: NodeKey, state: EditorState) => {
    const node = state._nodeMap.get(key) as RegisterNode | undefined;
    const id = node && REGISTER_FIELDS[node.getType()] ? node.__regId : undefined;
    const previous = idByKey.get(key);
    if (previous !== id) {
      if (previous !== undefined) {
        keysById.get(previous)?.delete(key);
        if (!keysById.get(previous)?.size) keysById.delete(previous);
      }
      if (id === undefined) idByKey.delete(key);
      else {
        idByKey.set(key, id);
        let keys = keysById.get(id);
        if (!keys) keysById.set(id, keys = new Set());
        keys.add(key);
      }
    }
    if (id !== undefined) dirtyKeys.add(key);
  };
  let stopped = false;
  let queued = false;
  const refresh = () => {
    if (queued || stopped || (!dirtyKeys.size && !dirtyIds.size)) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      // The commit listener retries after pending edits; tagging them would drop their Yjs writes.
      if (stopped || editor._pendingEditorState !== null) return;
      // Finish this cache-only update before any later authored update can join it.
      editor.update(() => {
        const keys = new Set(dirtyKeys);
        for (const id of dirtyIds) for (const key of keysById.get(id) ?? []) keys.add(key);
        dirtyKeys.clear();
        dirtyIds.clear();
        for (const key of keys) $refreshNode($getNodeByKey(key), registers);
      }, { tag: [COLLABORATION_TAG, REFRESH_TAG], skipTransforms: true, discrete: true });
    });
  };
  const observe = (events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction) => {
    if (transaction.origin === REGISTER_INIT) return;
    for (const event of events) {
      if (event.target === registers) for (const id of (event as Y.YMapEvent<Y.Text>).keysChanged) dirtyIds.add(id);
      else if (typeof event.target._item?.parentSub === 'string') dirtyIds.add(event.target._item.parentSub);
    }
    refresh();
  };
  registers.observeDeep(observe);
  // Hydration can skip transforms, and may deliver the tree after the registers.
  stops.push(editor.registerUpdateListener(({ editorState, prevEditorState, dirtyElements, dirtyLeaves, tags }) => {
    if (!tags.has(REFRESH_TAG)) {
      // setEditorState marks only the root: re-index the whole state once.
      const replaced = dirtyLeaves.size === 0 && dirtyElements.size === 1 && dirtyElements.has('root') && editorState !== prevEditorState;
      const keys = replaced ? new Set([...idByKey.keys(), ...editorState._nodeMap.keys()]) : [...dirtyLeaves, ...dirtyElements.keys()];
      for (const key of keys) index(key, editorState);
    }
    refresh();
  }));
  for (const key of editor.getEditorState()._nodeMap.keys()) index(key, editor.getEditorState());
  refresh();
  return () => { stopped = true; stops.forEach(stop => stop()); registers.unobserveDeep(observe); bindings.delete(editor); bindingCount--; };
}
