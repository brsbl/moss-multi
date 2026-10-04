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
export function readRegister(node: LexicalNode, fallback: string): string {
  const id = (node as RegisterNode).__regId;
  const text = id && currentDoc()?.getMap('registers').get(id);
  return text instanceof Y.Text ? text.toString() : fallback;
}
export function writeRegister(node: LexicalNode, next: string): void {
  const doc = currentDoc();
  const id = (node as RegisterNode).__regId;
  const text = id && doc?.getMap('registers').get(id);
  if (doc && text instanceof Y.Text && text.toString() !== next) {
    doc.transact(() => text.applyDelta(diffText(text.toString(), next)), REGISTER_LOCAL_ORIGIN);
  }
}

/** Imports have repeatable identities; identical blocks still get independent registers. */
export function $assignRegisterIds(): void {
  const used = new Set(currentDoc()?.getMap('registers').keys());
  const walk = (node: LexicalNode) => {
    const field = REGISTER_FIELDS[node.getType()];
    if (field) {
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

/** Installed before V1 hydration on both the client and the DocDO mirror. */
export function bindRegisters(editor: LexicalEditor, doc: Y.Doc): () => void {
  bindings.set(editor, doc);
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
  const refresh = () => editor.update(() => $refreshRegisters(editor, doc), { tag: COLLABORATION_TAG, skipTransforms: true });
  const observe = (_events: unknown, transaction: Y.Transaction) => {
    if (transaction.origin !== REGISTER_INIT && transaction.origin !== REGISTER_LOCAL_ORIGIN) refresh();
  };
  registers.observeDeep(observe);
  // Hydration can skip transforms, and may deliver the tree after the registers.
  stops.push(editor.registerUpdateListener(refresh));
  return () => { stops.forEach(stop => stop()); registers.unobserveDeep(observe); bindings.delete(editor); bindingCount--; };
}
