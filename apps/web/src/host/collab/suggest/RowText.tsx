// A suggestion card row's text (docs/design/suggestions.md §8): its exact characters, never trimmed. Whitespace a
// reader could not otherwise see is drawn as faint glyphs (· space, → tab, ↵ line break, ⍽ no-break space).
import { rowSegments } from '@moss-multi/core/suggest/describe';
import type { ReactNode } from 'react';

const NAMES: Record<string, string> = { ' ': 'space', '\t': 'tab', '\n': 'line break', '\u00a0': 'no-break space' };

const described = (space: string) => {
  const names = [...space].map((ch) => NAMES[ch] ?? `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
  return names.every((name) => name === names[0]) && names.length > 1 ? `${names.length} × ${names[0]}` : names.join(', ');
};

/** Struck or `inserted` (underlined) text keeps its ink; only a faint line says which (T9.34). */
export function RowText({ text, struck, inserted = false }: { text: string; struck: boolean; inserted?: boolean }): ReactNode {
  const segments = rowSegments(text);
  const only = segments.length === 1 && segments[0].space !== undefined ? segments[0].space : null;
  const line = struck ? 'line-through decoration-ink-faint' : inserted ? 'underline decoration-ink-faint underline-offset-2' : '';
  return (
    <>
      <span className={line}>
        {segments.length === 0 ? <span className="italic text-ink-faint">empty</span> : null}
        {segments.map((segment, i) =>
          segment.space === undefined ? (
            segment.text
          ) : (
            <span key={i} data-row-space="" title={described(segment.space)} aria-label={described(segment.space)} className="px-px text-ink-faint">
              {segment.text}
            </span>
          ),
        )}
      </span>
      {/* A change that is only whitespace also says so in words. */}
      {only === null ? null : <span className="ml-1 text-micro text-ink-faint">{described(only)}</span>}
    </>
  );
}
