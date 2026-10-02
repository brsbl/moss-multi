// ported-from: packages/desktop/stories/SettingsModal.stories.tsx @ 762abb777
import { useMemo, useState } from 'react';
import type { Story } from '@ladle/react';
import { Provider as JotaiProvider } from 'jotai';
import { useHydrateAtoms } from 'jotai/utils';
import { noteIntelligenceEnabledAtom } from '@moss/shared/state/atoms';
import { themeChoiceAtom } from '@moss/shared/themes';

import { SettingsModal } from '../src/renderer/components/SettingsModal';
import { isDefaultMdEditorAtom } from '../src/renderer/state/default-editor-atoms';
import { grantedDirsAtom } from '../src/renderer/state/granted-dirs-atoms';
import { workspaceInfoAtom } from '../src/renderer/state/workspace-info-atoms';

/**
 * Composite stories rendering the REAL `SettingsModal`.
 */

export const meta = {
  title: 'Composite/SettingsModal'
};

// useHydrateAtoms takes an iterable of [atom, value] tuples; the per-tuple value
// types are heterogeneous, so a single precise type isn't expressible here.
type AtomSeed = readonly [unknown, unknown];

/**
 * STORY-ONLY: neutralize the modal's dimming/blur backdrop so the modal content
 * reads unobscured in ladle. The real `ModalShell` renders a
 * `z-dialog-overlay bg-surface-modal-overlay backdrop-blur-sm` overlay; here we
 * make that overlay transparent with no blur. This does NOT touch production —
 * it only styles the overlay while these stories are mounted.
 */
function StoryOverlayReset() {
  return (
    <style>{`
      [class*="z-dialog-overlay"] {
        background: transparent !important;
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
      }
    `}</style>
  );
}

/** Seeds a scoped jotai store, then renders the real SettingsModal (open). */
function SeededSettingsModal({ seeds }: { seeds: AtomSeed[] }) {
  return (
    <JotaiProvider>
      <StoryOverlayReset />
      <HydrateAndRender seeds={seeds} />
    </JotaiProvider>
  );
}

function HydrateAndRender({ seeds }: { seeds: AtomSeed[] }) {
  // useHydrateAtoms' tuple typing (InferAtomTuples) doesn't unify with our
  // heterogeneous seed list; cast through unknown.
  useHydrateAtoms(seeds as unknown as Parameters<typeof useHydrateAtoms>[0]);
  // STORY-ONLY: drive `open` from state so the modal is dismissible (click
  // outside, Escape, or the X), with a button to reopen it afterwards.
  const [open, setOpen] = useState(true);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-border-subtle bg-surface-canvas px-3 py-1.5 text-xs text-ink-default"
      >
        Open Settings
      </button>
      <SettingsModal open={open} onOpenChange={setOpen} />
    </>
  );
}

/** Shared "everything populated" seeds; folders vary per story. */
function baseSeeds(): AtomSeed[] {
  return [
    [
      workspaceInfoAtom,
      { path: '/Users/dev/Moss', effectivePath: '/Users/dev/Moss', envOverride: false }
    ],
    [isDefaultMdEditorAtom, true],
    [noteIntelligenceEnabledAtom, true],
    [themeChoiceAtom, 'system']
  ];
}

/**
 * Empty state for a first-time user: no linked folders yet.
 */
export const EmptyNewUser: Story = () => {
  const seeds = useMemo<AtomSeed[]>(
    () => [
      ...baseSeeds(),
      [grantedDirsAtom, []]
    ],
    []
  );
  return <SeededSettingsModal seeds={seeds} />;
};

/**
 * Settings with linked folders populated.
 */
export const WithLinkedDirs: Story = () => {
  const seeds = useMemo<AtomSeed[]>(
    () => [
      ...baseSeeds(),
      [grantedDirsAtom, ['/Users/dev/projects/api', '/Users/dev/reference/docs']]
    ],
    []
  );
  return <SeededSettingsModal seeds={seeds} />;
};

/**
 * One screen with EVERY section/field populated and visible: Appearance, the
 * Workspace Location, Default Markdown Editor (already-default), Note
 * Intelligence (on), and Connected Folders (populated).
 */
export const FullModalAllSections: Story = () => {
  const seeds = useMemo<AtomSeed[]>(
    () => [
      ...baseSeeds(),
      [grantedDirsAtom, ['/Users/dev/projects/api', '/Users/dev/reference/docs']]
    ],
    []
  );
  return <SeededSettingsModal seeds={seeds} />;
};

/**
 * Moss is NOT the default .md editor: the Default Markdown Editor section shows
 * the "Set as Default" affordance instead of the already-default confirmation.
 * The `isDefaultMdEditorAtom = false` seed leads `baseSeeds()` so it is the
 * first (winning) value useHydrateAtoms applies for that atom.
 */
export const NotDefaultEditor: Story = () => {
  const seeds = useMemo<AtomSeed[]>(
    () => [
      [isDefaultMdEditorAtom, false],
      ...baseSeeds(),
      [grantedDirsAtom, []]
    ],
    []
  );
  return <SeededSettingsModal seeds={seeds} />;
};
