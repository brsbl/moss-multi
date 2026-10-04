import { $getEditor, $getNodeByKey, $getRoot, $isElementNode, COLLABORATION_TAG, type LexicalEditor, type LexicalNode } from 'lexical';
import * as Y from 'yjs';
import { diffText } from '@moss-multi/core/text-diff';

export const REGISTER_LOCAL_ORIGIN = Symbol('moss-multi:register-local');
const REGISTER_INIT = Symbol('moss-multi:register-init');
export const REGISTER_FIELDS: Readonly<Record<string, string>> = {
  'code-block': '__code', 'html-block': '__rawHtml', formula: '__formula',
};
type RegisterNode = LexicalNode & { __regId: string; [key: string]: unknown };
const bindings = new WeakMap<LexicalEditor, Y.Doc>();
const nodeDocs = new WeakMap<LexicalNode, Y.Doc>();
const serialized = new WeakSet<Y.Doc>();
let bindingCount = 0;

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
  return text instanceof Y.Text ? text.toString() : fallback ?? '';
}
export function writeRegister(node: LexicalNode, next: string): boolean {
  const doc = currentDoc();
  const id = (node as RegisterNode).__regId;
  const text = id && doc?.getMap('registers').get(id);
  if (doc && text instanceof Y.Text && text.toString() !== next) {
    doc.transact(() => text.applyDelta(diffText(text.toString(), next)), REGISTER_LOCAL_ORIGIN);
  }
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
      let ordinal = 0;
      while (used.has(`${prefix}:${ordinal}`)) ordinal++;
      const id = `${prefix}:${ordinal}`;
      used.add(id);
      (target.getWritable() as RegisterNode).__regId = id;
    }
    if ($isElementNode(node)) for (const child of node.getChildren()) walk(child);
  };
  walk($getRoot());
}

/**
 * Inside the binding's sync transaction: delete the payloads of register blocks that transaction deleted, unless a
 * live node still names them (a move re-inserts the block). One undo step then restores block and payload together,
 * and a deleted payload never reaches a later reader or a duplicate.
 */
export function deleteDestroyedRegisters(editor: LexicalEditor, transaction: Y.Transaction): void {
  const registers = bindings.get(editor)?.getMap('registers');
  if (!registers?.size) return;
  const gone = new Set<string>();
  Y.iterateDeletedStructs(transaction, transaction.deleteSet, (struct) => {
    if (!(struct instanceof Y.Item) || !(struct.content instanceof Y.ContentType)) return;
    // The block's attributes are deleted with it, so read the entry itself; its content lives until the cleanup.
    const id = struct.content.type._map.get('__regId')?.content.getContent()[0];
    if (typeof id === 'string') gone.add(id);
  });
  if (!gone.size) return;
  for (const node of editor.getEditorState()._nodeMap.values()) gone.delete((node as RegisterNode).__regId);
  for (const id of gone) registers.delete(id);
}

/** Whether a live container under `type`, other than `except`, names register `id`. */
export function namesRegister(type: { _start: Y.Item | null; _map: Map<string, Y.Item> }, id: string, except?: unknown): boolean {
  const visit = (item: Y.Item | null): boolean => {
    if (!item || item.deleted || !(item.content instanceof Y.ContentType)) return false;
    const child = item.content.type;
    if (child !== except && (child instanceof Y.XmlText || child instanceof Y.XmlElement) && child.getAttribute('__regId') === id) return true;
    return namesRegister(child, id, except);
  };
  for (let item = type._start; item; item = item.right) if (visit(item)) return true;
  for (const item of type._map.values()) if (visit(item)) return true;
  return false;
}

/**
 * A peer deleted a payload that a block here still names: it deleted the block while this client moved it. Write the
 * payload back from this editor's cache; a set made after the delete survives it.
 */
function restoreNamedRegisters(editor: LexicalEditor, doc: Y.Doc, keys: Iterable<string>): void {
  const registers = doc.getMap<Y.Text>('registers');
  const root = doc.get('root', Y.XmlText);
  for (const id of keys) {
    if (registers.has(id) || !namesRegister(root, id)) continue;
    for (const node of editor.getEditorState()._nodeMap.values()) {
      const field = REGISTER_FIELDS[node.getType()];
      const value = field && (node as RegisterNode).__regId === id ? (node as RegisterNode)[field] : undefined;
      if (typeof value !== 'string') continue;
      doc.transact(() => registers.set(id, new Y.Text(value)), REGISTER_INIT);
      break;
    }
  }
}

/** Copy shared payloads into Lexical's excluded render cache. Never writes to the shared tree. */
export function $refreshRegisters(editor: LexicalEditor, doc: Y.Doc): void {
  const registers = doc.getMap('registers');
  for (const snapshot of editor.getEditorState()._nodeMap.values()) {
    const field = REGISTER_FIELDS[snapshot.getType()];
    if (!field) continue;
    const node = $getNodeByKey(snapshot.getKey()) as RegisterNode | null;
    if (!node) continue;
    const text = registers.get(node.__regId);
    if (text instanceof Y.Text && node[field] !== text.toString()) node.getWritable()[field] = text.toString();
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
      const text = registers.get(id)!;
      if (node[field] !== text.toString()) node.getWritable()[field] = text.toString();
    }));
  }
  let stopped = false;
  let queued = false;
  const refresh = () => {
    if (queued || stopped) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      // The commit listener retries after pending edits; tagging them would drop their Yjs writes.
      if (stopped || editor._pendingEditorState !== null) return;
      // Finish this cache-only update before any later authored update can join it.
      editor.update(() => $refreshRegisters(editor, doc), { tag: COLLABORATION_TAG, skipTransforms: true, discrete: true });
    });
  };
  const observe: Parameters<typeof registers.observeDeep>[0] = (events, transaction) => {
    if (transaction.origin === REGISTER_INIT) return;
    if (!transaction.local && editor.isEditable()) {
      for (const event of events) if (event instanceof Y.YMapEvent) restoreNamedRegisters(editor, doc, event.keysChanged);
    }
    refresh();
  };
  registers.observeDeep(observe);
  // Hydration can skip transforms, and may deliver the tree after the registers.
  stops.push(editor.registerUpdateListener(refresh));
  return () => { stopped = true; stops.forEach(stop => stop()); registers.unobserveDeep(observe); bindings.delete(editor); bindingCount--; };
}
