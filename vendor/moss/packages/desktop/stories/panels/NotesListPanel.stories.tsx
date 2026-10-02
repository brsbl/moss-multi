// ported-from: packages/desktop/stories/panels/NotesListPanel.stories.tsx @ 762abb777
import type { Story } from '@ladle/react';
import type { ReactNode } from 'react';

import { useSetAtom } from 'jotai';
import { NotesListPanelContent } from '../../src/renderer/panels/NotesListPanelContent';
import { NotesPanelFooter } from '../../src/renderer/panels/NotesPanelFooter';
import { NativeCaptureViewport } from '../utils/nativeCaptureViewport';
import { StoryAppProvider, storyNotes } from '../utils/story-data';

import { activeNoteIdAtom, type MockNote } from '@moss/shared';

const StoryViewport = ({ children }: { children: ReactNode }) => (
  <NativeCaptureViewport
    captureHeight={872}
    captureWidth={264}
    inset={2}
    surface="notes-list-panel"
    surfaceHeight={868}
    surfaceWidth={260}
  >
    {children}
  </NativeCaptureViewport>
);

const NotesListContent = () => {
  const setActiveNoteId = useSetAtom(activeNoteIdAtom);

  return (
    <NotesListPanelContent
      onSelectNote={setActiveNoteId}
      onCreateNote={() => undefined}
      onCollapse={() => undefined}
      footerContent={(
        <NotesPanelFooter
          mode="notes"
          onModeChange={() => undefined}
          onOpenFeedback={() => undefined}
          onOpenSettings={() => undefined}
        />
      )}
    />
  );
};

export const meta = {
  title: 'Panels/Notes List'
};

export const Default: Story = () => (
  <StoryAppProvider notes={storyNotes} activeId={storyNotes[0]?.id ?? null}>
    <StoryViewport>
      <NotesListContent />
    </StoryViewport>
  </StoryAppProvider>
);

export const EmptyNotes: Story = () => (
  <StoryAppProvider notes={[]} activeId={null}>
    <StoryViewport>
      <NotesListContent />
    </StoryViewport>
  </StoryAppProvider>
);

// Notes without folders - shows minimal "+ New folder" link
const notesWithoutFolders: MockNote[] = [
  {
    id: 'note-1',
    title: 'Meeting Notes',
    updatedAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(), // 5 min ago
    folderPath: 'Notes',
    contentType: 'notes'
  },
  {
    id: 'note-2',
    title: 'Project Ideas',
    updatedAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(), // 1 hour ago
    folderPath: 'Notes',
    contentType: 'notes'
  },
  {
    id: 'note-3',
    title: 'Shopping List',
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(), // 1 day ago
    folderPath: 'Notes',
    contentType: 'checklist'
  }
];

export const NoFolders: Story = () => (
  <StoryAppProvider notes={notesWithoutFolders} activeId={notesWithoutFolders[0]?.id ?? null}>
    <StoryViewport>
      <NotesListContent />
    </StoryViewport>
  </StoryAppProvider>
);
NoFolders.meta = {
  description: 'Notes without any folders - shows minimal "+ New folder" link for progressive disclosure'
};

// Notes with folders - shows full folder section
const notesWithFolders: MockNote[] = [
  // Folder: Work
  {
    id: 'work-1',
    title: 'Sprint Planning',
    updatedAt: new Date(Date.now() - 1000 * 60 * 2).toISOString(),
    folderPath: 'Notes/Work',
    contentType: 'notes'
  },
  {
    id: 'work-2',
    title: 'Team Standup Notes',
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
    folderPath: 'Notes/Work',
    contentType: 'notes'
  },
  // Folder: Personal
  {
    id: 'personal-1',
    title: 'Grocery List',
    updatedAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
    folderPath: 'Notes/Personal',
    contentType: 'checklist'
  },
  {
    id: 'personal-2',
    title: 'Vacation Planning',
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
    folderPath: 'Notes/Personal',
    contentType: 'notes'
  },
  // Folder: Projects
  {
    id: 'project-1',
    title: 'App Redesign',
    updatedAt: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
    folderPath: 'Notes/Projects',
    contentType: 'notes'
  },
  // Root notes (not in any folder)
  {
    id: 'root-1',
    title: 'Quick Note',
    updatedAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
    folderPath: 'Notes',
    contentType: 'notes'
  },
  {
    id: 'root-2',
    title: 'Ideas',
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
    folderPath: 'Notes',
    contentType: 'notes'
  }
];

export const WithFolders: Story = () => (
  <StoryAppProvider notes={notesWithFolders} activeId={notesWithFolders[0]?.id ?? null}>
    <StoryViewport>
      <NotesListContent />
    </StoryViewport>
  </StoryAppProvider>
);
WithFolders.meta = {
  description: 'Notes organized in folders - shows full FOLDERS section with note counts aligned right'
};

// Many folders to test scrolling behavior
const manyFoldersNotes: MockNote[] = [
  ...['Design', 'Development', 'Marketing', 'Research', 'Finance', 'HR', 'Legal', 'Operations'].flatMap(
    (folder, folderIndex) => [
      {
        id: `${folder.toLowerCase()}-1`,
        title: `${folder} Doc 1`,
        updatedAt: new Date(Date.now() - 1000 * 60 * (folderIndex + 1)).toISOString(),
        folderPath: `Notes/${folder}`,
        contentType: 'notes' as const
      },
      {
        id: `${folder.toLowerCase()}-2`,
        title: `${folder} Doc 2`,
        updatedAt: new Date(Date.now() - 1000 * 60 * 60 * (folderIndex + 1)).toISOString(),
        folderPath: `Notes/${folder}`,
        contentType: 'notes' as const
      }
    ]
  ),
  // Some root notes
  {
    id: 'inbox-1',
    title: 'Inbox Note',
    updatedAt: new Date(Date.now() - 1000 * 60).toISOString(),
    folderPath: 'Notes',
    contentType: 'notes'
  }
];

export const ManyFolders: Story = () => (
  <StoryAppProvider notes={manyFoldersNotes} activeId={manyFoldersNotes[0]?.id ?? null}>
    <StoryViewport>
      <NotesListContent />
    </StoryViewport>
  </StoryAppProvider>
);
ManyFolders.meta = {
  description: 'Many folders to test sticky header and scrolling behavior'
};

// Single folder to test the reveal transition
const singleFolderNotes: MockNote[] = [
  {
    id: 'archived-1',
    title: 'Old Project Notes',
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
    folderPath: 'Notes/Archive',
    contentType: 'notes'
  },
  {
    id: 'root-1',
    title: 'Current Work',
    updatedAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
    folderPath: 'Notes',
    contentType: 'notes'
  },
  {
    id: 'root-2',
    title: 'Today\'s Tasks',
    updatedAt: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
    folderPath: 'Notes',
    contentType: 'checklist'
  }
];

export const SingleFolder: Story = () => (
  <StoryAppProvider notes={singleFolderNotes} activeId={singleFolderNotes[0]?.id ?? null}>
    <StoryViewport>
      <NotesListContent />
    </StoryViewport>
  </StoryAppProvider>
);
SingleFolder.meta = {
  description: 'Single folder with root notes - minimal folder section'
};
