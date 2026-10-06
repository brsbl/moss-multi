// The rows a suggestion card shows for a preview's hunks (docs/design/suggestions.md §4.4).
import type { Hunk } from './apply.ts';

export interface ReviewRow {
  kind: 'insert' | 'delete' | 'change' | 'more';
  text: string;
}

/** Excerpts a card shows before "…and N more changes". */
const EXCERPTS = 3;

/** A block's or payload's visible text, from the projection a hunk carries. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if ('lexical' in record && record.lexical) return textOf(record.lexical);
  if (typeof record.text === 'string') return record.text;
  if (Array.isArray(record.children)) return record.children.map(textOf).join(record.type === 'root' ? '\n' : '');
  if (typeof record.code === 'string') return record.code;
  if ('y' in record) return textOf(record.y);
  if (Array.isArray(record.seq)) return record.seq.map(textOf).join('');
  return '';
}

/** The changed middle of two texts: what was removed and what was added. */
function middle(before: string, after: string): { removed: string; added: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1;
  return { removed: before.slice(start, before.length - end), added: after.slice(start, after.length - end) };
}

/** Every row a card shows for `hunks`. */
export function describeHunks(hunks: readonly Hunk[]): ReviewRow[] {
  const out: ReviewRow[] = [];
  for (const hunk of hunks) {
    if (hunk.kind === 'note') {
      out.push({ kind: 'change', text: 'Note settings' });
      continue;
    }
    const before = hunk.op === 'added' ? '' : textOf(hunk.before);
    const after = hunk.op === 'removed' ? '' : textOf(hunk.after);
    const { removed, added } = middle(before, after);
    if (removed.trim()) out.push({ kind: 'delete', text: removed.trim() });
    if (added.trim()) out.push({ kind: 'insert', text: added.trim() });
    if (!removed.trim() && !added.trim()) out.push({ kind: 'change', text: hunk.kind === 'payload' ? 'Block content' : before.trim() ? `Formatting: ${before.trim()}` : 'A new block' });
  }
  if (out.length <= EXCERPTS) return out;
  return [...out.slice(0, EXCERPTS), { kind: 'more', text: `…and ${out.length - EXCERPTS} more changes` }];
}
