// ported-from: packages/desktop/stories/editor/TypeaheadMenus.stories.tsx @ 762abb777
import type { Story } from '@ladle/react';

import App from '../../src/renderer/App';
import { StoryAppProvider, storyNotes } from '../utils/story-data';
import type { MockNote } from '@moss/shared';

export const meta = {
  title: 'Editor/Typeahead Menus'
};

// Create many notes for search testing
const manyNotes: MockNote[] = [
  {
    id: 'note-main',
    title: 'Typeahead Demo',
    updatedAt: new Date().toISOString(),
    folderPath: 'Demo'
  },
  {
    id: 'note-meeting-jan',
    title: 'Meeting Notes - January',
    updatedAt: '2025-01-15T10:00:00.000Z',
    folderPath: 'Work/Meetings'
  },
  {
    id: 'note-meeting-feb',
    title: 'Meeting Notes - February',
    updatedAt: '2025-02-15T10:00:00.000Z',
    folderPath: 'Work/Meetings'
  },
  {
    id: 'note-meeting-mar',
    title: 'Meeting Notes - March',
    updatedAt: '2025-03-15T10:00:00.000Z',
    folderPath: 'Work/Meetings'
  },
  {
    id: 'note-journal-1',
    title: 'My Journal - Week 1',
    updatedAt: '2025-01-07T20:00:00.000Z',
    folderPath: 'Personal/Journal'
  },
  {
    id: 'note-journal-2',
    title: 'My Journal - Week 2',
    updatedAt: '2025-01-14T20:00:00.000Z',
    folderPath: 'Personal/Journal'
  },
  {
    id: 'note-ideas',
    title: 'Project Ideas',
    updatedAt: '2025-01-20T14:00:00.000Z',
    folderPath: 'Work'
  },
  {
    id: 'note-reading',
    title: 'Reading List',
    updatedAt: '2025-01-22T09:00:00.000Z',
    folderPath: 'Personal'
  }
];

export const FileLinkTypeahead: Story = () => (
  <StoryAppProvider notes={manyNotes} activeId="note-main">
    <App />
  </StoryAppProvider>
);
FileLinkTypeahead.storyName = '[[ File Link Search';
FileLinkTypeahead.meta = {
  description: 'Type [[ to search for notes. Try searching for "Meeting" or "Journal".'
};

export const SlashCommands: Story = () => {
  const slashCommandNote: MockNote = {
    id: 'note-slash',
    title: 'Slash Commands',
    updatedAt: new Date().toISOString(),
    folderPath: 'Demo'
  };

  return (
    <StoryAppProvider notes={[slashCommandNote, ...manyNotes]} activeId="note-slash">
      <App />
    </StoryAppProvider>
  );
};
SlashCommands.storyName = '/ Slash Commands';

export const FormulaTypeahead: Story = () => {
  const formulaNote: MockNote = {
    id: 'note-formula',
    title: 'Formula Calculator',
    updatedAt: new Date().toISOString(),
    folderPath: 'Demo'
  };

  return (
    <StoryAppProvider notes={[formulaNote, ...manyNotes]} activeId="note-formula">
      <App />
    </StoryAppProvider>
  );
};
FormulaTypeahead.storyName = '= Formula Calculator';

export const KeyboardNavigation: Story = () => {
  const keyboardNote: MockNote = {
    id: 'note-keyboard',
    title: 'Keyboard Navigation',
    updatedAt: new Date().toISOString(),
    folderPath: 'Demo'
  };

  return (
    <StoryAppProvider notes={[keyboardNote, ...manyNotes]} activeId="note-keyboard">
      <App />
    </StoryAppProvider>
  );
};
KeyboardNavigation.storyName = 'Keyboard Navigation';
