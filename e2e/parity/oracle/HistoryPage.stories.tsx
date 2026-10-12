// Oracle-only story (A§20 History parity, T6.B3): moss has no history surface, so this is the stored reference for
// the History view (T6.3), glyphdown's history page (apps/web/src/routes/d.$docId.history.tsx @ faf98d0) laid out in
// moss's DS at the pin: the version list with its badges and the compact save, the selected version's header with
// Diff vs current and Restore, and the diff card. It renders e2e/fixtures/history.json, which the candidate is served,
// at the size the History view fills in the 1440x1000 shell. build.mjs copies it and the fixture into moss's stories.
import type { Story } from '@ladle/react';
import { ArrowLeft, Clock, RotateCcw, Tag } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@moss/shared/components/ui/button';
import { Input } from '@moss/shared/components/ui/input';
import fixture from './history.json';

type Kind = 'auto' | 'named' | 'restore-point';

/** The History view's box in the shell: the editor pane under the note's top bar. */
const SIZE = { width: 1174, height: 955 };
/** The candidate's timeAgo and size labels at STORY_NOW, per version. */
const LABELS: Record<string, { ago: string; size: string }> = {
  'v-named': { ago: '2 h ago', size: '653 B' },
  'v-restore': { ago: 'Yesterday', size: '1.2 KB' },
  'v-auto': { ago: '3 days ago', size: '2.5 MB' },
};
/** Diff vs current of the fixture's version against its current note. */
const SPANS: { kind: 'equal' | 'insert' | 'delete'; text: string }[] = [
  { kind: 'equal', text: 'The quick brown fox jumps over the lazy dog.\n\nA second line, ' },
  { kind: 'delete', text: 'as' },
  { kind: 'insert', text: 'and' },
  { kind: 'equal', text: ' ' },
  { kind: 'delete', text: 'it' },
  { kind: 'insert', text: 'Ben' },
  { kind: 'equal', text: ' ' },
  { kind: 'delete', text: 'was.' },
  { kind: 'insert', text: 'was here.' },
  { kind: 'equal', text: '\n' },
];

const BADGE = 'inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-micro';

function VersionBadge({ kind }: { kind: Kind }): ReactNode {
  if (kind === 'named') {
    return (
      <span data-version-badge="" className={`${BADGE} bg-surface-note-selected/70 text-accent-brand-pressed`}>
        <Tag aria-hidden className="h-2.5 w-2.5" />
        Named
      </span>
    );
  }
  if (kind === 'restore-point') return <span data-version-badge="" className={`${BADGE} bg-surface-badge text-accent-terracotta`}>Restore point</span>;
  return <span data-version-badge="" className={`${BADGE} bg-surface-badge text-ink-muted`}>Auto</span>;
}

export const Default: Story = () => {
  const versions = fixture.versions as { id: string; kind: Kind; name: string | null; createdAt: number }[];
  const selected = versions[0];
  return (
    <section data-history-view="ready" aria-label="Version history" style={SIZE} className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-canvas">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border-subtle px-3">
        <button
          type="button"
          className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-note-hover/40 hover:text-ink-default focus-visible:outline-none"
        >
          <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
          Back to note
        </button>
        <span className="min-w-0 truncate text-xs font-medium text-ink-default">Version history</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="flex max-h-56 w-full shrink-0 flex-col border-b border-border-subtle bg-surface-panel md:max-h-none md:w-72 md:border-b-0 md:border-r">
          <div className="border-b border-border-subtle p-2.5">
            <form className="flex flex-col gap-1.5" onSubmit={(event) => event.preventDefault()}>
              <div className="flex gap-2">
                <Input aria-label="Version name" placeholder="Name this version" value="" maxLength={80} onChange={() => undefined} className="h-7 text-xs" />
                <Button type="submit" size="sm" className="h-7 shrink-0 px-2 text-xs" disabled>
                  Save version
                </Button>
              </div>
            </form>
          </div>
          <ul aria-label="Versions" className="m-0 min-h-0 flex-1 list-none divide-y divide-border-subtle overflow-y-auto p-0">
            {versions.map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  aria-pressed={v.id === selected.id}
                  className={`block w-full cursor-pointer px-3 py-2.5 text-left transition-colors hover:bg-surface-note-hover/40 focus-visible:outline-none ${v.id === selected.id ? 'bg-surface-note-selected/70' : ''}`}
                >
                  <div className="flex items-center gap-1.5">
                    <VersionBadge kind={v.kind} />
                    <span className="ml-auto text-micro text-ink-faint">{LABELS[v.id].ago}</span>
                  </div>
                  {v.name ? <p className="mt-1 truncate text-sm font-medium text-ink-default">{v.name}</p> : null}
                  <p className="mt-0.5 text-micro text-ink-faint">
                    {new Date(v.createdAt).toLocaleString()} · {LABELS[v.id].size}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-6 py-6">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <h2 className="m-0 flex min-w-0 items-center gap-2 text-base font-semibold text-ink-default">
                <Clock aria-hidden className="h-4 w-4 shrink-0 text-ink-muted" />
                <span className="truncate">{selected.name}</span>
              </h2>
              <VersionBadge kind={selected.kind} />
              <div className="ml-auto flex items-center gap-2">
                <div className="flex overflow-hidden rounded-md border border-border-subtle text-xs">
                  <button type="button" aria-pressed className="cursor-pointer px-2.5 py-1 transition-colors focus-visible:outline-none bg-surface-note-selected text-ink-default">
                    Diff vs current
                  </button>
                  <button type="button" aria-pressed={false} className="cursor-pointer px-2.5 py-1 transition-colors focus-visible:outline-none bg-surface-panel text-ink-muted hover:text-ink-default">
                    View
                  </button>
                </div>
                <Button size="sm" className="h-7 gap-1 px-2 text-xs">
                  <RotateCcw aria-hidden className="h-3 w-3" />
                  Restore
                </Button>
              </div>
            </div>
            <div data-version-content="diff">
              <div>
                <p className="mb-2 text-xs text-ink-muted">
                  <span className="font-medium text-accent-brand-pressed">+15</span>{' '}
                  <span className="font-medium text-accent-terracotta">−8</span> characters since this version (green was added
                  since, struck out was removed since)
                </p>
                <div className="rounded-lg border border-border-subtle bg-surface-raised-card px-5 py-4">
                  <p data-version-title="" className="mb-3 break-words text-lg font-semibold text-ink-default">{fixture.title}</p>
                  <pre className="m-0 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-ink-default">
                    {SPANS.map((span, i) =>
                      span.kind === 'equal' ? (
                        <span key={i}>{span.text}</span>
                      ) : span.kind === 'insert' ? (
                        <ins key={i} className="rounded-sm bg-accent-brand/10 text-accent-brand-pressed no-underline">{span.text}</ins>
                      ) : (
                        <del key={i} className="rounded-sm bg-accent-terracotta/10 text-accent-terracotta">{span.text}</del>
                      ),
                    )}
                  </pre>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
