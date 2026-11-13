// Oracle-only stories (T9.2): pristine moss with a callout, then a table, as the note's last block, so
// e2e/parity/arrow-below.spec.ts can press ArrowDown below it and type. build.mjs copies this file into moss's stories.
import type { Story } from '@ladle/react';
import App from '../src/renderer/App';
import { StoryAppProvider } from './utils/story-data';

const TRAILING = {
  callout: 'Budget notes.\n\n```moss-callout\nwarning\nBudget is frozen until the board meets.\n```\n',
  table: 'Budget notes.\n\n| Item | Cost |\n| --- | --- |\n| Travel | 5k |\n',
} as const;

function trailing(kind: keyof typeof TRAILING): Story {
  const note = { id: `trailing-${kind}`, title: `Trailing ${kind}`, updatedAt: Date.parse('2025-01-09T12:00:00.000Z'), folderPath: 'Notes' };
  /** The story bridge starts every note empty; its own update path gives this one its body before App reads it. */
  function Content(): null {
    const bridge = (window as unknown as { electronAPI: { notes: { update(id: string, input: { content: string }): unknown } } }).electronAPI;
    void bridge.notes.update(note.id, { content: TRAILING[kind] });
    return null;
  }
  return () => (
    <StoryAppProvider notes={[note]} activeId={note.id}>
      <Content />
      <App />
    </StoryAppProvider>
  );
}

export const Callout: Story = trailing('callout');
export const Table: Story = trailing('table');
