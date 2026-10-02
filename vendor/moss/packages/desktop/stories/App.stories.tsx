// ported-from: packages/desktop/stories/App.stories.tsx @ 762abb777
import type { Story } from '@ladle/react';
import App from '../src/renderer/App';
import { StoryAppProvider, storyNotes } from './utils/story-data';

export const meta = {
  title: 'Desktop/App'
};

export const Default: Story = () => (
  <StoryAppProvider notes={storyNotes} activeId={storyNotes[0]?.id ?? null}>
    <App />
  </StoryAppProvider>
);

export const EmptyState: Story = () => (
  <StoryAppProvider notes={[]} activeId={null}>
    <App />
  </StoryAppProvider>
);
EmptyState.storyName = 'Empty Notes';
