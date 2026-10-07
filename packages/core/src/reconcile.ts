// The identity-preserving two-tier reconcile (A§14, A§17 step 4; SP12). Tests-first stub: lands nothing yet.
import type { LexicalNode } from 'lexical';

export type SerializedNode = Record<string, unknown>;

export interface PayloadReconciler {
  keys: readonly string[];
  $write(node: LexicalNode, target: SerializedNode): void;
}

export interface ReconcileOptions {
  payloads?: Readonly<Record<string, PayloadReconciler>>;
}

/** JSON with sorted keys, so signatures do not depend on key order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    if (record[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify(record[key])}`);
  }
  return `{${parts.join(',')}}`;
}

export function $reconcileRoot(rootJson: SerializedNode, options: ReconcileOptions = {}): void {
  void rootJson;
  void options;
}
