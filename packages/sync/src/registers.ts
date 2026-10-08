// The register binding (A§10.10; docs/design/registers.md rules 1, 2 and 9): a code, HTML or formula node's payload is
// the Y.Text of its own payload doc, keyed by the node's `__regId` (a chart's or sketch's, the doc's per-key Y.Map);
// the node's own fields are a render cache that never ride the wire. Getters read the payload doc, setters write minimal diffs to it, and only the client (or server
// mirror) that mints an id writes its payload's first text, in the update that creates its element.
import {
  $getEditor, $getNodeByKey, $getRoot, $isElementNode, COLLABORATION_TAG, type EditorState, type LexicalEditor, type LexicalNode, type NodeKey,
} from 'lexical';
import * as Y from 'yjs';
import { diffAtCaret, diffText, rebaseOps, SERVER_CELL_BUDGET } from '@moss-multi/core/text-diff';
import { fieldsOf, MAP_REGISTERS, sameValue, type Fields } from './map-codecs.ts';
import {
  isPayloadType, newPayloadId, payloadDocsFor, payloadMap, payloadText, REGISTER_FIELDS, seedPayload, type PayloadDocs,
} from './payload-docs.ts';

export { REGISTER_FIELDS };
export { MAP_REGISTERS, moveEntries, rebaseMapEntries, RegisterDraft, sameValue } from './map-codecs.ts';
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
  /** Field views waiting for a payload to be held, written first or arrive. */
  changed: Set<() => void>;
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
  if (!registry || !id) return undefined;
  // A view can mount before its new block's first text is written; it subscribes to the doc that text will fill.
  return payloadText(registry.host.hold(id, registry.pending.has(id)));
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
  // The DocDO mirror (restore, push) writes text no client typed: it diffs within the server budget, sparse past the
  // table, so a long payload changed at both ends keeps its unchanged middle's items and a peer's insert there.
  if (current !== next) {
    const ops = registry.mirror ? diffText(current, next, SERVER_CELL_BUDGET, true) : diffText(current, next);
    text.doc!.transact(() => text.applyDelta(ops), REGISTER_LOCAL_ORIGIN);
  }
  return true;
}

/** Node `node`'s compound payload doc while its value is there to read or edit; undefined otherwise. */
function heldMap(node: LexicalNode, registry: Registry | undefined): Y.Map<unknown> | undefined {
  const id = (node as RegisterNode).__regId;
  if (!registry || !id || registry.pending.has(id) || !MAP_REGISTERS[node.getType()]) return undefined;
  const map = payloadMap(registry.host.hold(id));
  // Not arrived yet: the node's cache stands in, and nothing writes against an empty base.
  return map.size ? map : undefined;
}

/** The node's compound payload from its payload doc, or undefined when it has none (unbound, new, or not arrived). */
export function readMapRegister(node: LexicalNode): Fields | undefined {
  const map = heldMap(node, nodeRegistries.get(node) ?? currentRegistry());
  return map ? MAP_REGISTERS[node.getType()].decode(map) : undefined;
}

/**
 * Writes the keys `next` changes. With `base` (the value the caller derived `next` from), a key the caller left as
 * it was keeps whatever a peer wrote meanwhile; without it the payload's current value is the base. False when the
 * caller should write the node's cache instead (unbound, or a new node whose first value is not written yet).
 */
export function writeMapRegister(node: LexicalNode, next: Fields, base?: Fields): boolean {
  const registry = currentRegistry();
  const id = (node as RegisterNode).__regId;
  const codec = MAP_REGISTERS[node.getType()];
  if (!registry || !codec || !id || registry.pending.has(id)) return false;
  // A viewer's write would leave the client and get its socket closed as revoked; its controls are inert instead.
  if (!$getEditor().isEditable()) return true;
  const register = heldMap(node, registry);
  // A payload that has not arrived is read-only, as a text field is.
  if (!register) return true;
  const current = codec.decode(register);
  const before = codec.encode(base ?? Object.fromEntries(Object.keys(next).map(field => [field, current[field]])), register);
  const after = codec.encode(next, before);
  const implied = codec.implied?.(register);
  register.doc!.transact(() => {
    for (const [key, value] of after) {
      if (before.has(key) && sameValue(before.get(key), value) && !implied?.has(key)) continue;
      if (!register.has(key) || !sameValue(register.get(key), value)) register.set(key, value);
    }
    for (const key of before.keys()) if (!after.has(key) && register.has(key)) register.delete(key);
  }, REGISTER_LOCAL_ORIGIN);
  return true;
}

/** The compound payload's raw entries, copied, or undefined when the node has none. */
export function readMapEntries(node: LexicalNode): Map<string, unknown> | undefined {
  const map = heldMap(node, nodeRegistries.get(node) ?? currentRegistry());
  return map ? new Map(map.entries()) : undefined;
}

/** A node's payload value as its first write carries it: its text, or its compound fields' encoded keys. */
function seedOf(node: RegisterNode): string | Map<string, unknown> {
  const codec = MAP_REGISTERS[node.getType()];
  return codec ? codec.encode(fieldsOf(node, codec)) : String(node[REGISTER_FIELDS[node.getType()]] ?? '');
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
    if (isPayloadType(node.getType())) {
      if (registry) $mint(registry, node as RegisterNode);
      else ((node as RegisterNode).getWritable() as RegisterNode).__regId = newPayloadId();
    }
    if ($isElementNode(node)) for (const child of node.getChildren()) walk(child);
  };
  walk($getRoot());
}

/**
 * Node `key`'s payload id, and whether its field may write: its first text is written and its state has arrived. A
 * field that may not write shows the node's render cache, read-only. Holds nothing.
 */
export function registerState(editor: LexicalEditor, key: NodeKey): { id: string; ready: boolean } | undefined {
  const registry = registries.get(editor);
  const id = (editor.getEditorState()._nodeMap.get(key) as RegisterNode | undefined)?.__regId;
  if (!registry || !id) return undefined;
  return { id, ready: !registry.pending.has(id) && registry.host.get(id) !== undefined && !registry.host.awaiting(id) };
}

/**
 * Whether node `key`'s compound payload (chart, sketch) may take an edit: unbound, new (its first value is still the
 * node's), or arrived. Until then a write has nothing to land on, so the view offers no control that writes.
 */
export function mapRegisterWritable(editor: LexicalEditor, key: NodeKey): boolean {
  const registry = registries.get(editor);
  const id = (editor.getEditorState()._nodeMap.get(key) as RegisterNode | undefined)?.__regId;
  if (!registry || !id || registry.pending.has(id)) return true;
  const doc = registry.host.get(id);
  return !!doc && !registry.host.awaiting(id) && payloadMap(doc).size > 0;
}

/** Calls `listener` when a payload is held, written first or arrives; editor updates are the caller's to watch. */
export function onRegisterChange(editor: LexicalEditor, listener: () => void): () => void {
  const registry = registries.get(editor);
  if (!registry) return () => {};
  registry.changed.add(listener);
  return () => registry.changed.delete(listener);
}

/**
 * A user's edit through a field (docs/design/registers.md, T1.F4): the field went from `before` to `after`, with the
 * caret at `caret` after it. The edit is applied to node `key`'s payload as it is now, resolved by id at this moment
 * and rebased past edits the field had not shown, so it removes only what its user saw. Never a whole-value write.
 * Returns the payload's text after, or null when the field may not write (no payload yet, or not arrived).
 */
export function writeRegisterEdit(editor: LexicalEditor, key: NodeKey, before: string, after: string, caret?: number): string | null {
  const state = registerState(editor, key);
  const registry = registries.get(editor);
  if (!state?.ready || !registry) return null;
  const text = payloadText(registry.host.hold(state.id));
  const ops = caret === undefined ? diffText(before, after) : diffAtCaret(before, after, caret);
  const rebased = rebaseOps(before, ops, text.toString());
  if (rebased.length) text.doc!.transact(() => text.applyDelta(rebased), REGISTER_LOCAL_ORIGIN);
  return text.toString();
}

/** Copies a held payload doc's value into node `target`'s excluded render cache, writing only what differs. */
function $copyPayload(target: RegisterNode, doc: Y.Doc): void {
  const field = REGISTER_FIELDS[target.getType()];
  if (field) {
    const value = payload(payloadText(doc));
    if (target[field] !== value) (target.getWritable() as RegisterNode)[field] = value;
    return;
  }
  const codec = MAP_REGISTERS[target.getType()];
  const map = payloadMap(doc);
  if (!codec || !map.size) return;
  const decoded = codec.decode(map);
  for (const name of codec.fields) if (!sameValue(target[name], decoded[name])) (target.getWritable() as RegisterNode)[name] = decoded[name];
}

/** Copy the payload into one node's excluded render cache. Never writes to the shared tree. */
function $refreshNode(registry: Registry, node: LexicalNode | null): void {
  if (!node || !isPayloadType(node.getType())) return;
  const target = node as RegisterNode;
  const doc = registry.pending.has(target.__regId) ? undefined : registry.host.get(target.__regId);
  if (doc) $copyPayload(target, doc);
}

export interface BindRegistersOptions {
  /** The DocDO's server mirror (one serialized writer). */
  serializedImports?: boolean;
  /** The payload docs to use; a note doc's own (a session's, or in memory) by default. */
  payloads?: PayloadDocs;
}

/** Installed before V1 hydration on the client and the DocDO mirror. */
export function bindRegisters(editor: LexicalEditor, doc: Y.Doc, { serializedImports = false, payloads: host = payloadDocsFor(doc) }: BindRegistersOptions = {}): () => void {
  const registry: Registry = { root: doc, host, mirror: serializedImports, minted: new Map(), pending: new Set(), keysById: new Map(), changed: new Set() };
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
  for (const type of [...Object.keys(REGISTER_FIELDS), ...Object.keys(MAP_REGISTERS)]) {
    const klass = editor._nodes.get(type)?.klass;
    if (!klass) continue;
    stops.push(editor.registerNodeTransform(klass, (value) => {
      const node = value as RegisterNode;
      const id = node.__regId;
      if (!id || $isCopy(node.getKey(), id)) {
        // A copy starts from its source's current value, not a render cache that may lag it.
        const source = id && !registry.pending.has(id) ? host.get(id) : undefined;
        if (source) $copyPayload(node, source);
        $mint(registry, node);
        return;
      }
      if (registry.pending.has(id)) return;
      const held = host.get(id);
      if (held) $copyPayload(node, held);
    }));
  }
  // Refreshes stay proportional to what changed: the nodes an update touched and the payloads whose text moved.
  const idByKey = new Map<NodeKey, string>();
  const dirtyKeys = new Set<NodeKey>();
  const dirtyIds = new Set<string>();
  const index = (key: NodeKey, state: EditorState) => {
    const node = state._nodeMap.get(key) as RegisterNode | undefined;
    const id = node && isPayloadType(node.getType()) && node.__regId ? node.__regId : undefined;
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
    const map = payloadMap(held);
    const observer = (_event: unknown, transaction: Y.Transaction) => {
      if (transaction.origin === REGISTER_MINT) return;
      dirtyIds.add(id);
      refresh();
    };
    text.observe(observer);
    map.observe(observer);
    stops.push(() => { text.unobserve(observer); map.unobserve(observer); });
  };
  for (const [id, held] of host.docs) watch(id, held);
  stops.push(host.onHold(watch));
  const notify = () => { for (const listener of [...registry.changed]) listener(); };
  stops.push(host.onHold(notify), host.onArrive(notify));
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
        const seed = seedOf(node);
        const held = host.hold(id, true);
        if (typeof seed !== 'string' || seed) seedPayload(held, seed, REGISTER_MINT);
      }
    }, { editor });
    notify();
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
