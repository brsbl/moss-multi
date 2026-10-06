// A suggestion card row's text (docs/design/suggestions.md §8).
import type { ReactNode } from 'react';

export function RowText({ text, struck }: { text: string; struck: boolean }): ReactNode {
  return <span className={struck ? 'line-through' : ''}>{text.trim() || '¶'}</span>;
}
