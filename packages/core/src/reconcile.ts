// The identity-preserving two-tier reconcile (A§14, A§17 step 4; SP12), re-derived on Lexical 0.48 from moss-collab's
// tree-markdown reconcile. Run inside an update of an editor bound to the live doc's mirror, it edits the existing
// tree into the target tree in place: a child whose whole subtree matches is untouched, a child whose identity
// matches is updated in place (text by a prefix/suffix splice in the same Yjs items), and only children the target
// lacks or adds are removed or created. The V1 binding then emits ops for what changed alone, so untouched items,
// the comment anchors on them and a peer's concurrent insert into them survive. The caller verifies the result.
import { $getRoot, $isElementNode, $isTextNode, $parseSerializedNode, type ElementNode, type LexicalNode } from 'lexical';

export type SerializedNode = Record<string, unknown>;

/** A decorator whose payload lives outside the tree (A§10.10): its JSON keys, and how to write them in place. */
export interface PayloadReconciler {
  keys: readonly string[];
  $write(node: LexicalNode, target: SerializedNode): void;
}

export interface ReconcileOptions {
  /** By node type. Payload keys are not identity: a changed payload is written to the same node's payload. */
  payloads?: Readonly<Record<string, PayloadReconciler>>;
}

/** Own props `updateFromJSON` re-applies in place, by kind and by type. */
const ELEMENT_UPDATABLE = ['format', 'indent', 'direction', 'textFormat', 'textStyle'];
const TEXT_UPDATABLE = ['text', 'format', 'style', 'mode', 'detail'];
const TYPE_UPDATABLE: Readonly<Record<string, readonly string[]>> = {
  listitem: ['value', 'checked'],
  list: ['start'],
  heading: ['tag'],
  link: ['url', 'rel', 'target', 'title'],
  autolink: ['url', 'rel', 'target', 'title', 'isUnlinked'],
};

/** Cells in one child-alignment table; past it, children align on signatures unique to both sides. */
const CHILD_CELL_BUDGET = 1_000_000;

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

type Kind = 'element' | 'text' | 'other';

const ownOf = (json: SerializedNode): SerializedNode => {
  const own = { ...json };
  delete own.children;
  return own;
};
const $ownOfNode = (node: LexicalNode): SerializedNode => ownOf(node.exportJSON() as SerializedNode);
const kindOf = (json: SerializedNode): Kind => (Array.isArray(json.children) ? 'element' : typeof json.text === 'string' ? 'text' : 'other');
const $kindOfNode = (node: LexicalNode): Kind => ($isElementNode(node) ? 'element' : $isTextNode(node) ? 'text' : 'other');
const childrenOf = (json: SerializedNode): SerializedNode[] => (Array.isArray(json.children) ? (json.children as SerializedNode[]) : []);

const pick = (own: SerializedNode, keys: readonly string[]) => keys.map((key) => own[key]);

/** Type plus every own prop that cannot be re-applied in place: equal identities reconcile without replacement. */
function identityOf(own: SerializedNode, kind: Kind, options: ReconcileOptions): string {
  const copy = { ...own };
  const type = String(own.type);
  const excluded = [
    ...(kind === 'text' ? TEXT_UPDATABLE : kind === 'element' ? ELEMENT_UPDATABLE : []),
    ...(kind === 'other' ? (options.payloads?.[type]?.keys ?? []) : (TYPE_UPDATABLE[type] ?? [])),
  ];
  for (const key of excluded) delete copy[key];
  return stableStringify(copy);
}

function fullOf(json: SerializedNode): string {
  const own = stableStringify(ownOf(json));
  return Array.isArray(json.children) ? `${own}[${childrenOf(json).map(fullOf).join(',')}]` : own;
}

function $fullOfNode(node: LexicalNode): string {
  const own = stableStringify($ownOfNode(node));
  return $isElementNode(node) ? `${own}[${node.getChildren().map($fullOfNode).join(',')}]` : own;
}

/** Shared prefix plus suffix over the longer length: how alike two texts are, in [0, 1]. */
function likeness(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  const limit = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < limit && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < limit - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return (prefix + suffix) / max;
}

/** Pairs on signatures that occur once on each side, kept where their order agrees (a longest increasing run). */
function alignUnique(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const count = new Map<string, [number, number, number]>();
  a.forEach((sig, i) => {
    const entry = count.get(sig) ?? [0, 0, i];
    entry[0]++;
    entry[2] = i;
    count.set(sig, entry);
  });
  b.forEach((sig) => {
    const entry = count.get(sig);
    if (entry) entry[1]++;
  });
  const candidates: Array<[number, number]> = [];
  b.forEach((sig, j) => {
    const entry = count.get(sig);
    if (entry && entry[0] === 1 && entry[1] === 1) candidates.push([entry[2], j]);
  });
  // Longest increasing subsequence on the a-side index (candidates are in b order).
  const tails: number[] = [];
  const back = new Array<number>(candidates.length).fill(-1);
  candidates.forEach(([i], k) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candidates[tails[mid]!]![0] < i) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) back[k] = tails[lo - 1]!;
    tails[lo] = k;
  });
  const pairs: Array<[number, number]> = [];
  for (let k = tails.length ? tails[tails.length - 1]! : -1; k >= 0; k = back[k]!) pairs.push(candidates[k]!);
  return pairs.reverse();
}

/**
 * An order-preserving alignment of `a` and `b`, as index pairs increasing on both sides: common prefix and suffix,
 * then the heaviest common subsequence of the middle while its table fits, weighting each pair by `weight` (1 when
 * absent). Past the budget the middle aligns on unique signatures.
 */
function align(a: readonly string[], b: readonly string[], weight?: (i: number, j: number) => number): Array<[number, number]> {
  const limit = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < limit && a[prefix] === b[prefix] && !weight) prefix++;
  let suffix = 0;
  while (suffix < limit - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix] && !weight) suffix++;
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < prefix; i++) pairs.push([i, i]);
  const m = a.length - prefix - suffix;
  const n = b.length - prefix - suffix;
  if (m > 0 && n > 0) {
    if ((m + 1) * (n + 1) <= CHILD_CELL_BUDGET) {
      const score: Float64Array[] = Array.from({ length: m + 1 }, () => new Float64Array(n + 1));
      const gain = (i: number, j: number) => (a[prefix + i] === b[prefix + j] ? (weight ? weight(prefix + i, prefix + j) : 1) : 0);
      for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
          const g = gain(i, j);
          score[i]![j] = Math.max(score[i + 1]![j]!, score[i]![j + 1]!, g > 0 ? g + score[i + 1]![j + 1]! : 0);
        }
      }
      let i = 0;
      let j = 0;
      while (i < m && j < n) {
        const g = gain(i, j);
        if (g > 0 && score[i]![j] === g + score[i + 1]![j + 1]!) {
          pairs.push([prefix + i, prefix + j]);
          i++;
          j++;
        } else if (score[i + 1]![j]! >= score[i]![j + 1]!) {
          i++;
        } else {
          j++;
        }
      }
    } else {
      for (const [i, j] of alignUnique(a.slice(prefix, prefix + m), b.slice(prefix, prefix + n))) pairs.push([prefix + i, prefix + j]);
    }
  }
  for (let s = suffix; s > 0; s--) pairs.push([a.length - s, b.length - s]);
  return pairs;
}

function $reconcileChildren(parent: ElementNode, targets: SerializedNode[], options: ReconcileOptions): void {
  const live = parent.getChildren();

  // Tier 1: children whose whole subtree already matches stay untouched.
  const exact = align(live.map($fullOfNode), targets.map(fullOf));

  // Tier 2: in each gap between exact matches, children with the same identity reconcile in place, preferring the
  // pairs whose text is most alike so an edited block keeps its own items.
  const liveOwn = live.map($ownOfNode);
  const liveId = live.map((node, i) => identityOf(liveOwn[i]!, $kindOfNode(node), options));
  const targetId = targets.map((json) => identityOf(ownOf(json), kindOf(json), options));
  const liveText = live.map((node) => node.getTextContent());
  const textOfTarget = (json: SerializedNode): string =>
    typeof json.text === 'string' ? json.text : childrenOf(json).map(textOfTarget).join('');

  const match = new Map<number, { li: number; exact: boolean }>();
  const paired = new Set<number>();
  let prevL = -1;
  let prevT = -1;
  for (const [li, ti] of [...exact, [live.length, targets.length] as [number, number]]) {
    const gapL: number[] = [];
    for (let k = prevL + 1; k < li; k++) gapL.push(k);
    const gapT: number[] = [];
    for (let k = prevT + 1; k < ti; k++) gapT.push(k);
    if (gapL.length && gapT.length) {
      const gapText = gapT.map((k) => textOfTarget(targets[k]!));
      const weight = (i: number, j: number) => 1 + likeness(liveText[gapL[i]!]!, gapText[j]!);
      for (const [gl, gt] of align(gapL.map((k) => liveId[k]!), gapT.map((k) => targetId[k]!), weight)) {
        match.set(gapT[gt]!, { li: gapL[gl]!, exact: false });
        paired.add(gapL[gl]!);
      }
    }
    if (li < live.length && ti < targets.length) {
      match.set(ti, { li, exact: true });
      paired.add(li);
    }
    prevL = li;
    prevT = ti;
  }

  // Place the target's children in order: paired ones stay where they are (pairs never cross), new ones are created.
  let prev: LexicalNode | null = null;
  for (let ti = 0; ti < targets.length; ti++) {
    const json = targets[ti]!;
    const hit = match.get(ti);
    if (hit) {
      const node = live[hit.li]!;
      if (!hit.exact) $reconcileNode(node, json, liveOwn[hit.li]!, options);
      prev = node;
      continue;
    }
    const fresh = $parseSerializedNode(json as never);
    if (prev) prev.insertAfter(fresh);
    else {
      const first = parent.getFirstChild();
      if (first) first.insertBefore(fresh);
      else parent.append(fresh);
    }
    prev = fresh;
  }

  // Then remove what the target lacks, keeping the parent even if it empties: the target decides its shape.
  live.forEach((node, li) => {
    if (!paired.has(li)) node.remove(true);
  });
}

/** One identity-matched node: in-place props, its payload, then its children. */
function $reconcileNode(node: LexicalNode, json: SerializedNode, own: SerializedNode, options: ReconcileOptions): void {
  const target = ownOf(json);
  const payload = $kindOfNode(node) === 'other' ? options.payloads?.[node.getType()] : undefined;
  if (payload) {
    if (stableStringify(pick(own, payload.keys)) !== stableStringify(pick(target, payload.keys))) payload.$write(node, json);
  } else if (stableStringify(own) !== stableStringify(target)) {
    node.updateFromJSON(json as never);
  }
  if ($isElementNode(node)) $reconcileChildren(node, childrenOf(json), options);
}

/** Reconciles the current tree onto `rootJson` (a serialized editor state's `root`), inside an editor update. */
export function $reconcileRoot(rootJson: SerializedNode, options: ReconcileOptions = {}): void {
  const root = $getRoot();
  const own = $ownOfNode(root);
  if (stableStringify(own) !== stableStringify(ownOf(rootJson))) root.updateFromJSON(rootJson as never);
  $reconcileChildren(root, childrenOf(rootJson), options);
}
