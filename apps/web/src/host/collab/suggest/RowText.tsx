// A suggestion card row's text (docs/design/suggestions.md §8): its exact characters, never trimmed. Whitespace a
// reader could not otherwise see is drawn as marked glyphs (· space, → tab, ↵ line break, ⍽ no-break space).
import { rowSegments } from '@moss-multi/core/suggest/describe';
import type { ReactNode } from 'react';

const NAMES: Record<string, string> = { ' ': 'space', '\t': 'tab', '\n': 'line break', ' ': 'no-break space' };

const described = (space: string) => {
  const names = [...space].map((ch) => NAMES[ch] ?? `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
  return names.every((name) => name === names[0]) && names.length > 1 ? `${names.length} × ${names[0]}` : names.join(', ');
};

export function RowText({ text, struck }: { text: string; struck: boolean }): ReactNode {
  const segments = rowSegments(text);
  return (
    <span className={struck ? 'line-through' : ''}>
      {segments.length === 0 ? <span className="italic text-ink-faint">empty</span> : null}
      {segments.map((segment, i) =>
        segment.space === undefined ? (
          segment.text
        ) : (
          <span key={i} data-row-space="" title={described(segment.space)} aria-label={described(segment.space)} className="rounded-sm bg-current/10 px-px opacity-70">
            {segment.text}
          </span>
        ),
      )}
    </span>
  );
}
