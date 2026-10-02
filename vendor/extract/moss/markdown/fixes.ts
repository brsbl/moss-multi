import { $isTextNode, type LexicalNode } from 'lexical';

// Converter fixes called from seams in markdown/transformers.ts (A§12; docs/DEVIATIONS.md).

let formulaIds: Map<string, number> | null = null;

// Formulas imported without `id=` get ids derived from their payload and occurrence, so the client, the DocDO
// and the CLI mint the same ids for the same markdown (S-conv B9). Nested imports share the outer scope.
export function withImportFormulaIds<T>(run: () => T): T {
  const outer = formulaIds;
  formulaIds = outer ?? new Map();
  try {
    return run();
  } finally {
    formulaIds = outer;
  }
}

// `{ formulaId }` inside an import; `{}` elsewhere, where live typing keeps FormulaNode's random id.
export function importFormulaId(payload: string): { formulaId?: string } {
  if (!formulaIds) return {};
  const seen = formulaIds.get(payload) ?? 0;
  formulaIds.set(payload, seen + 1);
  return { formulaId: deterministicId(`${payload}\u0000${seen}`) };
}

const OFFSETS = [0x811c9dc5, 0x01000193, 0x6c62272e, 0x9e3779b9];

function deterministicId(seed: string): string {
  const hex = OFFSETS.map((offset) => {
    let hash = offset >>> 0;
    for (let i = 0; i < seed.length; i += 1) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }).join('');
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// Lexical clears a line before an element transformer's replace() runs and keeps it cleared unless replace
// returns false after putting it back. Moss returned undefined on rejected IMAGE and TABLE lines, which
// imported them as empty paragraphs (S-conv §1.2).
export function $rejectLine(children: LexicalNode[], match: string[] & { input?: string }): false {
  const [line] = children;
  if ($isTextNode(line) && match.input !== undefined) line.setTextContent(match.input);
  return false;
}
