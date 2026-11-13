// Oracle-only story (A§20 node-family parity): pristine moss renders the demo note (e2e/fixtures/demo-note.md) in its
// own App and MarkdownEditor. build.mjs copies this file and the note into moss's stories before `ladle build`.
import type { Story } from '@ladle/react';
import App from '../src/renderer/App';
import { StoryAppProvider } from './utils/story-data';
import demo from './demo-note.md?raw';

const note = { id: 'demo-note', title: 'Demo note', updatedAt: Date.parse('2025-01-09T12:00:00.000Z'), folderPath: 'Notes' };

/** The story bridge starts every note empty; its own update path gives this one the demo body before App reads it. */
function DemoContent(): null {
  const bridge = (window as unknown as { electronAPI: { notes: { update(id: string, input: { content: string }): unknown } } }).electronAPI;
  void bridge.notes.update(note.id, { content: demo });
  return null;
}

export const Default: Story = () => (
  <StoryAppProvider notes={[note]} activeId={note.id}>
    <DemoContent />
    <App />
  </StoryAppProvider>
);
