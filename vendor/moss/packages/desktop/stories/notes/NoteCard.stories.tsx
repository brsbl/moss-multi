// ported-from: packages/desktop/stories/notes/NoteCard.stories.tsx @ 762abb777
import { useState } from 'react';
import type { Story } from '@ladle/react';
import { NoteCard } from '@moss/shared/components/notes/NoteCard';

export const meta = {
  title: 'Notes/NoteCard'
};

/** Default note card */
export const Default: Story = () => {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="w-64 bg-surface-notes-list p-4">
      <NoteCard
        id="note-1"
        title="Meeting Notes"
        updatedAt={new Date()}
        isActive={selected === 'note-1'}
        onSelect={setSelected}
      />
    </div>
  );
};

/** Active (selected) state */
export const ActiveState: Story = () => (
  <div className="w-64 bg-surface-notes-list p-4">
    <NoteCard
      id="note-1"
      title="Selected Note"
      updatedAt={new Date()}
      isActive={true}
      onSelect={() => {}}
    />
  </div>
);

/** Note with active agent (loading indicator) */
export const WithActiveAgent: Story = () => (
  <div className="w-64 bg-surface-notes-list p-4">
    <NoteCard
      id="note-1"
      title="Processing Note"
      updatedAt={new Date()}
      hasActiveAgent={true}
      onSelect={() => {}}
    />
  </div>
);

/** Compact variant */
export const CompactVariant: Story = () => {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="w-48 bg-surface-notes-list p-2">
      <NoteCard
        id="note-1"
        title="Compact Note"
        updatedAt={new Date()}
        variant="compact"
        isActive={selected === 'note-1'}
        onSelect={setSelected}
      />
      <NoteCard
        id="note-2"
        title="Another Note"
        updatedAt={new Date(Date.now() - 86400000)}
        variant="compact"
        isActive={selected === 'note-2'}
        onSelect={setSelected}
      />
    </div>
  );
};

/** Compact with active agent */
export const CompactWithAgent: Story = () => (
  <div className="w-48 bg-surface-notes-list p-2">
    <NoteCard
      id="note-1"
      title="Processing..."
      updatedAt={new Date()}
      variant="compact"
      hasActiveAgent={true}
      onSelect={() => {}}
    />
  </div>
);

/** Merged note title (with + separator) */
export const MergedNote: Story = () => (
  <div className="w-80 bg-surface-notes-list p-4">
    <NoteCard
      id="note-1"
      title="Project A + Project B"
      updatedAt={new Date()}
      onSelect={() => {}}
    />
  </div>
);

/** Various date formats */
export const DateFormats: Story = () => (
  <div className="w-64 bg-surface-notes-list p-4 space-y-2">
    <NoteCard
      id="note-1"
      title="Updated Today"
      updatedAt={new Date()}
      onSelect={() => {}}
    />
    <NoteCard
      id="note-2"
      title="Updated Yesterday"
      updatedAt={new Date(Date.now() - 86400000)}
      onSelect={() => {}}
    />
    <NoteCard
      id="note-3"
      title="Updated 3 Days Ago"
      updatedAt={new Date(Date.now() - 86400000 * 3)}
      onSelect={() => {}}
    />
    <NoteCard
      id="note-4"
      title="Updated Last Month"
      updatedAt={new Date(Date.now() - 86400000 * 30)}
      onSelect={() => {}}
    />
  </div>
);

/** Draggable note */
export const Draggable: Story = () => {
  const [isDragging, setIsDragging] = useState(false);

  return (
    <div className="w-64 bg-surface-notes-list p-4">
      <NoteCard
        id="note-1"
        title="Drag me"
        updatedAt={new Date()}
        draggable
        isDragging={isDragging}
        onDragStart={() => setIsDragging(true)}
        onDragEnd={() => setIsDragging(false)}
        onSelect={() => {}}
      />
    </div>
  );
};

/** List of notes */
export const NotesList: Story = () => {
  const [selected, setSelected] = useState<string>('note-1');

  const notes = [
    { id: 'note-1', title: 'Weekly Planning', updatedAt: new Date() },
    { id: 'note-2', title: 'Project Ideas', updatedAt: new Date(Date.now() - 3600000) },
    { id: 'note-3', title: 'Meeting Notes - Q4 Review', updatedAt: new Date(Date.now() - 86400000) },
    { id: 'note-4', title: 'Reading List', updatedAt: new Date(Date.now() - 86400000 * 3) }
  ];

  return (
    <div className="w-64 bg-surface-notes-list p-2">
      <div className="space-y-1">
        {notes.map((note) => (
          <NoteCard
            key={note.id}
            id={note.id}
            title={note.title}
            updatedAt={note.updatedAt}
            isActive={selected === note.id}
            onSelect={setSelected}
          />
        ))}
      </div>
    </div>
  );
};
