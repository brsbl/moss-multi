// ported-from: packages/desktop/src/renderer/panels/PropertiesTabContent.tsx @ 762abb777
import { useFieldWritable } from '@moss-multi/host/collab/title-binding'; // moss-multi seam: same gate as the title
import { useCallback } from 'react';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { Plus } from 'lucide-react';
import {
  NO_NOTE_SENTINEL,
  noteFrontmatterAtom,
  frontmatterDirtySignalAtom,
  pendingFrontmatterMetaAtom,
  focusedNoteIdAtom,
  setSearchQueryAtom,
  noteEntityAtom,
} from '@moss/shared';
import { FrontmatterHeader } from '../editor/components/FrontmatterHeader';

const stableStringifyUnknown = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyUnknown(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringifyUnknown(record[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
};

/**
 * Content for the Properties tab in the actions panel.
 * Reads the focused note's frontmatter and renders FrontmatterHeader.
 * Handles field changes by updating the frontmatter atom and signaling dirty state
 * so CanvasAreaContent picks it up for autosave.
 */
export function PropertiesTabContent() {
  const focusedNoteId = useAtomValue(focusedNoteIdAtom);
  const noteId = focusedNoteId ?? NO_NOTE_SENTINEL;
  const writable = useFieldWritable(noteId);
  const noteEntity = useAtomValue(noteEntityAtom(noteId));
  const frontmatter = useAtomValue(noteFrontmatterAtom(noteId));
  const store = useStore();
  const bumpDirtySignal = useSetAtom(frontmatterDirtySignalAtom(noteId));
  const setSearchQuery = useSetAtom(setSearchQueryAtom);

  const handleTagClick = useCallback(
    (tag: string) => {
      const normalized = tag.trim().replace(/^#/, '').trim();
      if (normalized) setSearchQuery(normalized);
    },
    [setSearchQuery]
  );

  const handleFieldSearchClick = useCallback(
    (query: string) => {
      const normalized = query.trim();
      if (normalized) setSearchQuery(normalized);
    },
    [setSearchQuery]
  );

  const handleFieldChange = useCallback(
    (field: string, value: unknown) => {
      if (noteId === NO_NOTE_SENTINEL || !writable) return;
      if (noteEntity?.trashedAt != null) return;

      const current = store.get(noteFrontmatterAtom(noteId)) ?? {};

      // No-op guard for identical values
      if (value === undefined) {
        if (!(field in current)) return;
      } else if (stableStringifyUnknown(current[field]) === stableStringifyUnknown(value)) return;

      let next: Record<string, unknown>;
      if (value === undefined) {
        const { [field]: _, ...rest } = current;
        next = rest;
      } else {
        next = { ...current, [field]: value };
      }

      store.set(noteFrontmatterAtom(noteId), next);
      store.set(pendingFrontmatterMetaAtom(noteId), (prev) => ({
        ...prev,
        [field]: {
          source: value === undefined ? 'user-removed' as const : 'user' as const,
          lastModified: Math.floor(Date.now() / 1000),
        },
      }));

      // Signal CanvasAreaContent to schedule autosave
      bumpDirtySignal((c) => c + 1);
    },
    [noteId, noteEntity, store, bumpDirtySignal, writable]
  );

  if (noteId === NO_NOTE_SENTINEL) {
    return (
      <p className="py-8 text-center text-caption text-ink-faint">No note selected</p>
    );
  }

  if (frontmatter === null) {
    return (
      <div className="py-8 text-center">
        <p className="text-caption text-ink-faint">No properties yet</p>
        {writable && noteEntity?.trashedAt == null && (
          <button
            type="button"
            onClick={() => {
              store.set(noteFrontmatterAtom(noteId), {});
              store.set(pendingFrontmatterMetaAtom(noteId), {});
              bumpDirtySignal((c) => c + 1);
            }}
            className="mt-2 inline-flex items-center gap-1 rounded-md bg-border-subtle/40 px-4 py-2 text-caption text-ink-faint hover:bg-border-subtle/60 hover:text-ink-muted"
          >
            <Plus className="h-3 w-3" aria-hidden />
            Add field
          </button>
        )}
      </div>
    );
  }

  return (
    <fieldset disabled={!writable} className="min-w-0">
    <FrontmatterHeader
      noteId={noteId}
      onFieldChange={handleFieldChange}
      onTagClick={handleTagClick}
      onFieldSearchClick={handleFieldSearchClick}
    />
    </fieldset>
  );
}
