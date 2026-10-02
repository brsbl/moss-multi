// ported-from: packages/desktop/stories/panels/CanvasArea.stories.tsx @ 762abb777
import type { Story } from '@ladle/react';

import App from '../../src/renderer/App';
import { StoryAppProvider, storyNotes } from '../utils/story-data';

export const meta = {
  title: 'Panels/Canvas Area'
};

export const EmptyState: Story = () => (
  <StoryAppProvider notes={[]} activeId={null}>
    <App />
  </StoryAppProvider>
);

export const NewNote: Story = () => (
  <StoryAppProvider
    notes={[
      {
        id: 'note-new',
        title: 'Untitled',
        updatedAt: Math.floor(Date.now() / 1000),
        folderPath: 'Notes'
      }
    ]}
    activeId="note-new"
  >
    <App />
  </StoryAppProvider>
);

export const PopulatedNote: Story = () => (
  <StoryAppProvider notes={storyNotes} activeId={storyNotes[0]?.id ?? null}>
    <App />
  </StoryAppProvider>
);
