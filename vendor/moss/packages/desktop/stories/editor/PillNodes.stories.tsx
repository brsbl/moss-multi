// ported-from: packages/desktop/stories/editor/PillNodes.stories.tsx @ 762abb777
import type { Story } from '@ladle/react';

import App from '../../src/renderer/App';
import { StoryAppProvider, storyNotes } from '../utils/story-data';
import type { MockNote } from '@moss/shared';

export const meta = {
  title: 'Editor/Pill Nodes'
};

// Note with various pill nodes pre-populated
const noteWithPills: MockNote = {
  id: 'note-pills',
  title: 'Pill Nodes Demo',
  updatedAt: new Date().toISOString(),
  folderPath: 'Demo'
};

// Note with unresolved file links (broken links)
const noteWithBrokenLinks: MockNote = {
  id: 'note-broken-links',
  title: 'Broken Links Demo',
  updatedAt: new Date().toISOString(),
  folderPath: 'Demo'
};

// Note for testing formula calculations
const noteWithFormulas: MockNote = {
  id: 'note-formulas',
  title: 'Formula Calculator Demo',
  updatedAt: new Date().toISOString(),
  folderPath: 'Demo'
};

export const WithPillNodes: Story = () => (
  <StoryAppProvider
    notes={[noteWithPills, ...storyNotes]}
    activeId="note-pills"
  >
    <App />
  </StoryAppProvider>
);
WithPillNodes.storyName = 'All Pill Types';

export const WithFormulas: Story = () => (
  <StoryAppProvider
    notes={[noteWithFormulas, ...storyNotes]}
    activeId="note-formulas"
  >
    <App />
  </StoryAppProvider>
);
WithFormulas.storyName = 'Formula Calculator';

export const WithBrokenLinks: Story = () => (
  <StoryAppProvider
    notes={[noteWithBrokenLinks, ...storyNotes]}
    activeId="note-broken-links"
  >
    <App />
  </StoryAppProvider>
);
WithBrokenLinks.storyName = 'Broken File Links';

export const WithFileLinks: Story = () => {
  // Create interconnected notes with file links
  const interconnectedNotes: MockNote[] = [
    {
      id: 'note-project',
      title: 'Project Overview',
      updatedAt: new Date().toISOString(),
      folderPath: 'Work'
    },
    {
      id: 'note-meetings',
      title: 'Meeting Notes',
      updatedAt: new Date().toISOString(),
      folderPath: 'Work'
    },
    {
      id: 'note-tasks',
      title: 'Task List',
      updatedAt: new Date().toISOString(),
      folderPath: 'Work'
    },
    {
      id: 'note-design',
      title: 'Design Specs',
      updatedAt: new Date().toISOString(),
      folderPath: 'Work'
    }
  ];

  return (
    <StoryAppProvider
      notes={interconnectedNotes}
      activeId="note-project"
    >
      <App />
    </StoryAppProvider>
  );
};
WithFileLinks.storyName = 'Interconnected Notes';
