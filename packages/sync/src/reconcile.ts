// Restore and push land a target body through the identity-preserving reconcile (A§14, A§17; SP12) in one serverWrite,
// verified or refused: the mirror's export after the reconcile must equal the target's, or nothing is written (409).
// Payload decorators keep their node and payload id; a changed payload is a minimal diff to its own payload doc.
import { $parseSerializedNode, type LexicalNode, type SerializedEditorState } from 'lexical';
import * as Y from 'yjs';
import { $reconcileRoot, type PayloadReconciler, type SerializedNode } from '@moss-multi/core/reconcile';
import { exportMarkdown, stateToMarkdown } from './converter/index.ts';
import { fieldsOf, MAP_REGISTERS } from './map-codecs.ts';
import { REGISTER_FIELDS } from './payload-docs.ts';
import { writeMapRegister, writeRegister } from './registers.ts';
import { forkWrite, mirrorOf, serverWrite, type Admit, type Mirror, type MirrorBase } from './server-doc.ts';

export class ReconcileRefused extends Error {
  readonly status = 409;
  constructor(readonly reason: 'unparseable' | 'mismatch' | 'unverified', message: string) {
    super(message);
    this.name = 'ReconcileRefused';
  }
}

/** Each payload type's JSON key (what its exportJSON writes from the payload). */
const PAYLOAD_KEYS: Readonly<Record<string, string>> = {
  'code-block': 'code', 'html-block': 'rawHtml', formula: 'formula', chart: 'config', sketch: 'grid',
};

/** The target node's payload, read from a detached node parsed from its JSON, written to the live node's payload. */
const PAYLOADS: Readonly<Record<string, PayloadReconciler>> = Object.fromEntries(
  Object.entries(PAYLOAD_KEYS).map(([type, key]) => [type, {
    keys: [key],
    $write(node: LexicalNode, json: SerializedNode) {
      const fresh = $parseSerializedNode(json as never) as unknown as Record<string, unknown>;
      const field = REGISTER_FIELDS[type];
      if (field) writeRegister(node, String(fresh[field] ?? ''));
      else writeMapRegister(node, fieldsOf(fresh, MAP_REGISTERS[type]!));
    },
    $writeProps(node: LexicalNode, json: SerializedNode) {
      // Each other exported prop `name` is the node's `__name`, read from a detached node so defaults resolve alike.
      const fresh = $parseSerializedNode(json as never) as unknown as Record<string, unknown>;
      const writable = node.getWritable() as unknown as Record<string, unknown>;
      const names = new Set([...Object.keys(node.exportJSON()), ...Object.keys(json)]);
      for (const name of names) {
        if (name === 'type' || name === 'version' || name === key) continue;
        if (`__${name}` in fresh) writable[`__${name}`] = fresh[`__${name}`];
      }
    },
  }]),
);

/** The live body as a serialized editor state: what a version keeps and a restore reconciles to. */
export function bodyState(live: Y.Doc): SerializedEditorState {
  const mirror = mirrorOf(live);
  try {
    const state = mirror.editor.getEditorState();
    return state.read(() => state.toJSON(), { editor: mirror.editor });
  } finally {
    mirror.dispose();
  }
}

/** What a write lands with the body: `mutate` edits the mirror's other roots, `verify` checks them and throws to refuse. */
export interface BesideBody {
  mutate(doc: Y.Doc): void;
  verify(mirror: Mirror): void;
}

/**
 * Reconciles `live`'s body onto `target` in one server write under `origin`. Throws ReconcileRefused (409) when the
 * target cannot be parsed or the reconciled body would not export exactly as the target does; `admit` may refuse
 * too, and `beside` lands the title and frontmatter in the same write. With `base`, the reconcile runs from that state
 * instead of `live`'s, and its diff merges into `live`. With `fork`, the result is collected as record ops instead.
 * Returns whether the live doc changed (or the fork wrote anything).
 */
export function reconcileBody(live: Y.Doc, target: SerializedEditorState, origin: unknown, admit?: Admit, beside?: BesideBody, base?: MirrorBase, fork?: ForkTarget): boolean {
  let expected: string;
  try {
    expected = stateToMarkdown(target);
  } catch (error) {
    throw new ReconcileRefused('unparseable', `target does not parse: ${(error as Error).message}`);
  }
  const refusing = <T>(run: () => T): T => {
    try {
      return run();
    } catch (error) {
      throw new ReconcileRefused('unparseable', `target does not reconcile: ${(error as Error).message}`);
    }
  };
  const mutate = (doc: Y.Doc) => {
    beside?.mutate(doc);
    const rest = refusing(() => $reconcileRoot(target.root as unknown as SerializedNode, { payloads: PAYLOADS }));
    return rest && (() => refusing(rest));
  };
  const verify = (mirror: Mirror) => {
    if (exportMarkdown(mirror.editor) !== expected) throw new ReconcileRefused('mismatch', 'the reconciled body does not export the target');
    beside?.verify(mirror);
  };
  if (fork) {
    const ops = forkWrite(live, fork.client, mutate, verify);
    fork.ops.push(...ops);
    return ops.length > 0;
  }
  return serverWrite(live, origin, mutate, admit, verify, base);
}

/** A reconcile written as a fork under a leased client: its record ops are collected and `live` is not written. */
export interface ForkTarget {
  client: number;
  ops: { doc: string; update: Uint8Array }[];
}
