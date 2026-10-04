// The register binding (A§10.10; docs/design/registers.md rules 1, 2 and 9): a code, HTML or formula node's payload is
// the Y.Text of its own payload doc, keyed by the node's `__regId`; the node's own field is a render cache that never
// rides the wire. Getters read the payload doc, setters write minimal diffs to it, and only the client (or server
// mirror) that mints an id writes its payload's first text, in the update that creates its element.
import {
  $getEditor, $getNodeByKey, $getRoot, $isElementNode, COLLABORATION_TAG, type EditorState, type LexicalEditor, type LexicalNode, type NodeKey,
} from 'lexical';
import * as Y from 'yjs';
import { diffText } from '@moss-multi/core/text-diff';
import { newPayloadId, payloadDocsFor, payloadText, REGISTER_FIELDS, type PayloadDocs } from './payload-docs.ts';

export { REGISTER_FIELDS };
export const REGISTER_LOCAL_ORIGIN = Symbol('moss-multi:register-local');
/** The minter's first text: outside every undo manager, so undoing a creation withholds the payload. */
export const REGISTER_MINT = Symbol('moss-multi:register-mint');
const REFRESH_TAG = 'moss-multi:register-refresh';
type RegisterNode = LexicalNode & { __regId: string; [key: string]: unknown };

interface Registry {
  root: Y.Doc;
  host: PayloadDocs;
  /** The DocDO's server mirror: it reads payloads on demand and writes first texts inside the update. */
  mirror: boolean;
  /** Ids minted here whose first text is not written yet, by node key. */
  minted: Map<NodeKey, string>;
  pending: Set<string>;
  keysById: Map<string, Set<NodeKey>>;
}

const registries = new WeakMap<LexicalEditor, Registry>();
const nodeRegistries = new WeakMap<LexicalNode, Registry>();
let bindingCount = 0;
const payloads = new WeakMap<Y.Text, string>();
const invalidated = new WeakSet<Y.Doc>();

/**
 * A payload's text, cached between transactions: every Lexical commit reads each top-level node's text, so an uncached
 * read stringifies every payload per keystroke. A transaction's changes evict before its observers run, and reads
 * while one is open or still cleaning up bypass the cache.
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
  if (value === undefined) payloads.set(text, (value = text.toString()));
  return value;
}

/** The note doc an editor's registers are bound to; views treat it as "this note is shared". */
export const registerDoc = (editor: LexicalEditor): Y.Doc | undefined => registries.get(editor)?.root;

/** The payload docs an editor's registers read and write. */
export const registerPayloads = (editor: LexicalEditor): PayloadDocs | undefined => registries.get(editor)?.host;

/** The payload text behind node `key`, held on demand; undefined for an unbound editor or a node with no id yet. */
export function payloadTextOf(editor: LexicalEditor, key: NodeKey): Y.Text | undefined {
  const registry = registries.get(editor);
  const id = (editor.getEditorState()._nodeMap.get(key) as RegisterNode | undefined)?.__regId;
  if (!registry || !id || registry.pending.has(id)) return undefined;
  return payloadText(registry.host.hold(id));
}

function currentRegistry(): Registry | undefined {
  if (!bindingCount) return undefined;
  // SerializedEditorState.toJSON() has no active editor; cached fields cover that read.
  try {
    return registries.get($getEditor());
  } catch {
    return undefined;
  }
}

/** Lexical also reads text while committing, outside an active-editor context. */
export function initRegisterNode(node: LexicalNode): string {
  const registry = currentRegistry();
  if (registry) nodeRegistries.set(node, registry);
  return '';
}

export function readRegister(node: LexicalNode, fallback: string): string {
  const id = (node as RegisterNode).__regId;
  const registry = id ? (nodeRegistries.get(node) ?? currentRegistry()) : undefined;
  if (!registry || registry.pending.has(id)) return fallback ?? '';
  return payload(payloadText(registry.host.hold(id)));
}

/** A user's edit through the field: a minimal diff to the payload. False before the node has a payload. */
export function writeRegister(node: LexicalNode, next: string): boolean {
  const registry = currentRegistry();
  const id = (node as RegisterNode).__regId;
  if (!registry || !id || registry.pending.has(id)) return false;
  const text = payloadText(registry.host.hold(id));
  const current = payload(text);
  if (current !== next) text.doc!.transact(() => text.applyDelta(diffText(current, next)), REGISTER_LOCAL_ORIGIN);
  return true;
}

/** Gives a node a new id whose first text this editor writes when the update commits (rule 2). */
function $mint(registry: Registry, node: RegisterNode, id: string = newPayloadId()): void {
  (node.getWritable() as RegisterNode).__regId = id;
  registry.minted.set(node.getKey(), id);
  registry.pending.add(id);
}

/**
 * Every imported block gets a fresh, unguessable id (a payload id is its only access check), so identical blocks get
 * independent payloads and an import never reuses an id the doc knows. Unbound converters only set the id.
 */
export function $assignRegisterIds(): void {
  const registry = currentRegistry();
  const walk = (node: LexicalNode) => {
    if (REGISTER_FIELDS[node.getType()]) {
      if (registry) $mint(registry, node as RegisterNode);
      else ((node as RegisterNode).getWritable() as RegisterNode).__regId = newPayloadId();
    }
    if ($isElementNode(node)) for (const child of node.getChildren()) walk(child);
  };
  walk($getRoot());
}

/** Copy the payload into one node's excluded render cache. Never writes to the shared tree. */
function $refreshNode(registry: Registry, node: LexicalNode | null): void {
  const field = node && REGISTER_FIELDS[node.getType()];
  if (!node || !field) return;
  const target = node as RegisterNode;
  const doc = registry.pending.has(target.__regId) ? undefined : registry.host.get(target.__regId);
  if (!doc) return;
  const value = payload(payloadText(doc));
  if (target[field] !== value) (target.getWritable() as RegisterNode)[field] = value;
}

export interface BindRegistersOptions {
  /** The DocDO's server mirror (one serialized writer). */
  serializedImports?: boolean;
  /** The payload docs to use; a note doc's own (a session's, or in memory) by default. */
  payloads?: PayloadDocs;
}

/** Installed before V1 hydration on the client and the DocDO mirror. */
export function bindRegisters(editor: LexicalEditor, doc: Y.Doc, { serializedImports = false, payloads: host = payloadDocsFor(doc) }: BindRegistersOptions = {}): () => void {
  const registry: Registry = { root: doc, host, mirror: serializedImports, minted: new Map(), pending: new Set(), keysById: new Map() };
  registries.set(editor, registry);
  bindingCount++;
  // A client holds every payload its tree names, so it asks for each; the mirror reads on demand.
  const eager = !serializedImports;
  const stops: (() => void)[] = [];
  /** A node carrying an id another attached node already has is a copy ($copyNode): it gets its own payload. */
  const $isCopy = (key: NodeKey, id: string): boolean => {
    if (registry.pending.has(id)) return registry.minted.get(key) !== id;
    for (const other of registry.keysById.get(id) ?? []) if (other !== key && $getNodeByKey(other)?.isAttached()) return true;
    return false;
  };
  for (const [type, field] of Object.entries(REGISTER_FIELDS)) {
    const klass = editor._nodes.get(type)?.klass;
    if (!klass) continue;
    stops.push(editor.registerNodeTransform(klass, (value) => {
      const node = value as RegisterNode;
      const id = node.__regId;
      if (!id || $isCopy(node.getKey(), id)) {
        // A copy starts from its source's current text, not a render cache that may lag it.
        const source = id && !registry.pending.has(id) ? host.get(id) : undefined;
        if (source) (node.getWritable() as RegisterNode)[field] = payload(payloadText(source));
        $mint(registry, node);
        return;
      }
      if (registry.pending.has(id)) return;
      const held = host.get(id);
      if (!held) return;
      const shared = payload(payloadText(held));
      if (node[field] !== shared) (node.getWritable() as RegisterNode)[field] = shared;
    }));
  }
  // Refreshes stay proportional to what changed: the nodes an update touched and the payloads whose text moved.
  const idByKey = new Map<NodeKey, string>();
  const dirtyKeys = new Set<NodeKey>();
  const dirtyIds = new Set<string>();
  const index = (key: NodeKey, state: EditorState) => {
    const node = state._nodeMap.get(key) as RegisterNode | undefined;
    const id = node && REGISTER_FIELDS[node.getType()] && node.__regId ? node.__regId : undefined;
    const previous = idByKey.get(key);
    if (previous !== id) {
      if (previous !== undefined) {
        const keys = registry.keysById.get(previous);
        keys?.delete(key);
        if (!keys?.size) registry.keysById.delete(previous);
      }
      if (id === undefined) idByKey.delete(key);
      else {
        idByKey.set(key, id);
        let keys = registry.keysById.get(id);
        if (!keys) registry.keysById.set(id, (keys = new Set()));
        keys.add(key);
      }
    }
    if (id === undefined) return;
    dirtyKeys.add(key);
    if (eager && !registry.pending.has(id)) host.hold(id);
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
        for (const id of dirtyIds) for (const key of registry.keysById.get(id) ?? []) keys.add(key);
        dirtyKeys.clear();
        dirtyIds.clear();
        for (const key of keys) $refreshNode(registry, $getNodeByKey(key));
      }, { tag: [COLLABORATION_TAG, REFRESH_TAG], skipTransforms: true, discrete: true });
    });
  };
  // Each payload's own observer marks only its id (rule 9); the V1 observer is untouched.
  const watch = (id: string, held: Y.Doc) => {
    const text = payloadText(held);
    const observer = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
      if (transaction.origin === REGISTER_MINT) return;
      dirtyIds.add(id);
      refresh();
    };
    text.observe(observer);
    stops.push(() => text.unobserve(observer));
  };
  for (const [id, held] of host.docs) watch(id, held);
  stops.push(host.onHold(watch));
  /**
   * The minter's first texts, once their nodes are committed and attached; outside every undo manager. A client writes
   * them after the commit's own note frame, so a payload's first frame names an id the server already knows.
   */
  let firstTextsQueued = false;
  const writeFirstTexts = (state: EditorState) => {
    if (stopped) return;
    state.read(() => {
      for (const [key, id] of registry.minted) {
        registry.minted.delete(key);
        registry.pending.delete(id);
        const node = $getNodeByKey(key) as RegisterNode | null;
        if (!node || node.__regId !== id || !node.isAttached()) continue;
        const text = String(node[REGISTER_FIELDS[node.getType()]] ?? '');
        const held = host.hold(id, true);
        if (text) held.transact(() => payloadText(held).insert(0, text), REGISTER_MINT);
      }
    }, { editor });
  };
  stops.push(editor.registerUpdateListener(({ editorState, prevEditorState, dirtyElements, dirtyLeaves, tags }) => {
    if (registry.minted.size && registry.mirror) writeFirstTexts(editorState);
    else if (registry.minted.size && !firstTextsQueued) {
      firstTextsQueued = true;
      queueMicrotask(() => {
        firstTextsQueued = false;
        writeFirstTexts(editor.getEditorState());
      });
    }
    if (!tags.has(REFRESH_TAG)) {
      if (dirtyLeaves.size === 0 && dirtyElements.size === 1 && dirtyElements.get('root') === false && editorState !== prevEditorState) {
        // setEditorState marks only the root: index just the nodes whose instances changed, and the ones that left.
        const before = prevEditorState._nodeMap;
        const after = editorState._nodeMap;
        for (const [key, node] of after) if (before.get(key) !== node) index(key, editorState);
        for (const key of [...idByKey.keys()]) if (!after.has(key)) index(key, editorState);
      } else {
        for (const key of dirtyLeaves) index(key, editorState);
        for (const key of dirtyElements.keys()) index(key, editorState);
      }
    }
    refresh();
  }));
  for (const key of editor.getEditorState()._nodeMap.keys()) index(key, editor.getEditorState());
  refresh();
  return () => {
    stopped = true;
    stops.forEach((stop) => stop());
    registries.delete(editor);
    bindingCount--;
  };
}
