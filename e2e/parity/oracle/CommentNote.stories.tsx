// Oracle-only story (A§20 comment parity, T4.3): pristine moss shows a note with one comment thread in its own App,
// MarkdownEditor, gutter and popover. build.mjs copies this file and the note (e2e/fixtures/comment-note.*) into
// moss's stories before `ladle build`. The thread reaches moss through its legacy comment footer, which its content
// load reads into the same comments map a sidecar would.
import type { Story } from '@ladle/react';
import App from '../src/renderer/App';
import { StoryAppProvider } from './utils/story-data';
import body from './comment-note.md?raw';
import comments from './comment-note.comments.json';

const note = { id: 'comment-note', title: 'Comment note', updatedAt: Date.parse('2025-01-09T12:00:00.000Z'), folderPath: 'Notes' };
const content = `${body.trimEnd()}\n<!--moss:comments\n${JSON.stringify(comments)}\n-->\n`;

/** The story bridge starts every note empty; its own update path gives this one its body before App reads it. */
function CommentContent(): null {
  const bridge = (window as unknown as { electronAPI: { notes: { update(id: string, input: { content: string }): unknown } } }).electronAPI;
  void bridge.notes.update(note.id, { content });
  return null;
}

export const Default: Story = () => (
  <StoryAppProvider notes={[note]} activeId={note.id}>
    <CommentContent />
    <App />
  </StoryAppProvider>
);
