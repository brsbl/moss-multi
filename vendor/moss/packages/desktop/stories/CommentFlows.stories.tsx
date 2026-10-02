// ported-from: packages/desktop/stories/CommentFlows.stories.tsx @ 762abb777
import type { ReactNode } from 'react';
import type { Story } from '@ladle/react';

import type { NoteComment } from '@moss/shared/state/note-atoms';
import { CommentPopover } from '../src/renderer/editor/components/CommentPopover';
import { CommentInputPopover } from '../src/renderer/editor/components/CommentInputPopover';
import { StoryAppProvider, storyNotes } from './utils/story-data';

/**
 * Ladle stories for the major threaded-comment user flows, rendered with the
 * ACTUAL app components (CommentPopover / CommentInputPopover and their real
 * Lexical composer). Ladle renders in a real browser, so the
 * popover overlays composite and screenshot correctly — unlike the offscreen
 * Electron automation harness.
 */
export const meta = {
  title: 'Editor/Comments'
};

const NOTE_ID = 'story-note';
const T = 1_736_424_000; // fixed base timestamp (seconds) for deterministic relative times
const ANCHOR = { x: 360, y: 96, width: 8, height: 18 };

const noop = () => {};

const root: NoteComment = {
  id: 'root',
  text: 'Lead with the outcome here — can we hook the reader first?',
  createdAt: T,
  updatedAt: T,
  color: 0,
  source: 'user'
};

const replies: NoteComment[] = [
  { id: 'r1', text: 'Rewrote the intro to lead with the result. Want me to apply it?', createdAt: T + 60, updatedAt: T + 60, color: 0, source: 'agent', parentId: 'root' },
  { id: 'r2', text: 'Flagged two passive-voice sentences in paragraph two.', createdAt: T + 120, updatedAt: T + 120, color: 0, source: 'external', parentId: 'root' },
  { id: 'r3', text: 'Yes — apply the new intro, keep the rest.', createdAt: T + 180, updatedAt: T + 180, color: 0, source: 'user', parentId: 'root' },
  { id: 'r4', text: 'Applied. Also tightened the second paragraph.', createdAt: T + 240, updatedAt: T + 240, color: 0, source: 'agent', parentId: 'root' },
  { id: 'r5', text: 'Looks great, thank you.', createdAt: T + 300, updatedAt: T + 300, color: 0, source: 'user', parentId: 'root' }
];

const threadMap: Record<string, NoteComment> = Object.fromEntries(
  [root, ...replies].map((c) => [c.id, c])
);
const singleMap: Record<string, NoteComment> = { root };

const Frame = ({ children }: { children: ReactNode }) => (
  <StoryAppProvider notes={storyNotes} activeId={storyNotes[0]?.id ?? null}>
    <div style={{ padding: 16 }}>{children}</div>
  </StoryAppProvider>
);

/** Open a comment -> full thread: root + flattened child comments, one source indicator per row
 *  (Me / Moss / External agent), all comments visible, and the comment composer. */
export const Thread: Story = () => (
  <Frame>
    <CommentPopover
      open
      onOpenChange={noop}
      anchorRect={ANCHOR}
      placement="bottom-end"
      comment={root}
      commentsMap={threadMap}
      noteId={NOTE_ID}
      onUpdate={noop}
      onDelete={noop}
      onReply={() => true}
      onSendToAgent={noop}
    />
  </Frame>
);
Thread.storyName = 'Thread popover (root + replies)';

/** Default single-comment popover (no replies yet) with the Reply composer. */
export const SingleComment: Story = () => (
  <Frame>
    <CommentPopover
      open
      onOpenChange={noop}
      anchorRect={ANCHOR}
      placement="bottom-end"
      comment={root}
      commentsMap={singleMap}
      noteId={NOTE_ID}
      onUpdate={noop}
      onDelete={noop}
      onReply={() => true}
      onSendToAgent={noop}
    />
  </Frame>
);
SingleComment.storyName = 'Single comment (default)';

/** Create a comment: the inline comment-input popover with its real Lexical composer. */
export const CreateComment: Story = () => (
  <Frame>
    <CommentInputPopover
      open
      onOpenChange={noop}
      anchorRect={ANCHOR}
      onCreate={() => true}
      noteId={NOTE_ID}
    />
  </Frame>
);
CreateComment.storyName = 'Create comment (input)';
