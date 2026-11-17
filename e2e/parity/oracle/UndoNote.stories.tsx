// Oracle-only story (T9.13): pristine moss with a note holding the one paragraph "Start.", so
// e2e/parity/undo-steps.spec.ts can type after it and count what each Cmd+Z takes back. build.mjs copies this file
// into moss's stories.
import type { Story } from '@ladle/react';
import App from '../src/renderer/App';
import { StoryAppProvider } from './utils/story-data';

const note = { id: 'undo-start', title: 'Undo', updatedAt: Date.parse('2025-01-09T12:00:00.000Z'), folderPath: 'Notes' };

/** The story bridge starts every note empty; its own update path gives this one its body before App reads it. */
function Content(): null {
  const bridge = (window as unknown as { electronAPI: { notes: { update(id: string, input: { content: string }): unknown } } }).electronAPI;
  void bridge.notes.update(note.id, { content: 'Start.\n' });
  return null;
}

export const Start: Story = () => (
  <StoryAppProvider notes={[note]} activeId={note.id}>
    <Content />
    <App />
  </StoryAppProvider>
);
