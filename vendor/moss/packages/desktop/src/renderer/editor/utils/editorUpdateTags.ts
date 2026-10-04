// ported-from: packages/desktop/src/renderer/editor/utils/editorUpdateTags.ts @ 762abb777
import { SKIP_DOM_SELECTION_TAG } from 'lexical';
import type { LexicalEditor } from 'lexical';

export const EDITOR_UPDATE_TAGS = {
  ignored: {
    agentContentUpdate: 'agent-content-update',
    skipDirty: 'skip-dirty',
    formulaDraftStyle: 'formula-draft-style',
  },
  derived: {
    formulaWorkspaceRefresh: 'formula-workspace-refresh',
    imageLocalized: 'image-localized',
  },
  content: {
    fontFamilyStyle: 'font-family-style',
  },
} as const;

export type DirtyTrackerIgnoredTag =
  (typeof EDITOR_UPDATE_TAGS.ignored)[keyof typeof EDITOR_UPDATE_TAGS.ignored];
export type DirtyTrackerDerivedTag =
  (typeof EDITOR_UPDATE_TAGS.derived)[keyof typeof EDITOR_UPDATE_TAGS.derived];
export type DirtyTrackerContentTag =
  (typeof EDITOR_UPDATE_TAGS.content)[keyof typeof EDITOR_UPDATE_TAGS.content];

export const DIRTY_TRACKER_IGNORED_TAGS = new Set<DirtyTrackerIgnoredTag>(
  Object.values(EDITOR_UPDATE_TAGS.ignored)
);
export const DIRTY_TRACKER_DERIVED_TAGS = new Set<DirtyTrackerDerivedTag>(
  Object.values(EDITOR_UPDATE_TAGS.derived)
);
export const DIRTY_TRACKER_CONTENT_TAGS = new Set<DirtyTrackerContentTag>(
  Object.values(EDITOR_UPDATE_TAGS.content)
);

export const hasTrackedEditorUpdateTag = (
  tags: Set<string>,
  trackedTags: ReadonlySet<string>
): boolean => {
  for (const tag of trackedTags) {
    if (tags.has(tag)) {
      return true;
    }
  }

  return false;
};

export const runIgnoredEditorUpdate = (
  editor: LexicalEditor,
  update: () => void,
  tag: DirtyTrackerIgnoredTag
): void => {
  editor.update(update, { tag });
};

export const runDerivedEditorUpdate = (
  editor: LexicalEditor,
  update: () => void,
  tag: DirtyTrackerDerivedTag
): void => {
  // Derived updates recompute presentation state (formula results, localized
  // images) and must never move the user's selection or steal focus — e.g.
  // a workspace refresh while the formula edit popover holds focus.
  editor.update(update, { tag: [tag, SKIP_DOM_SELECTION_TAG] });
};
