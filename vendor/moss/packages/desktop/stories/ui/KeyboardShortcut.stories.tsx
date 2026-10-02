// ported-from: packages/desktop/stories/ui/KeyboardShortcut.stories.tsx @ 762abb777
import type { Story } from '@ladle/react';
import { KeyboardShortcut } from '@moss/shared/components/ui/keyboard-shortcut';

export const meta = {
  title: 'UI/KeyboardShortcut'
};

/** Common keyboard shortcuts */
export const CommonShortcuts: Story = () => (
  <div className="flex flex-col gap-6 p-8">
    <div className="flex items-center justify-between rounded-lg bg-ink-inverse p-4 shadow-sm">
      <span className="text-sm text-ink-default">Save</span>
      <KeyboardShortcut keys={['⌘', 'S']} />
    </div>
    <div className="flex items-center justify-between rounded-lg bg-ink-inverse p-4 shadow-sm">
      <span className="text-sm text-ink-default">Copy</span>
      <KeyboardShortcut keys={['⌘', 'C']} />
    </div>
    <div className="flex items-center justify-between rounded-lg bg-ink-inverse p-4 shadow-sm">
      <span className="text-sm text-ink-default">Undo</span>
      <KeyboardShortcut keys={['⌘', 'Z']} />
    </div>
    <div className="flex items-center justify-between rounded-lg bg-ink-inverse p-4 shadow-sm">
      <span className="text-sm text-ink-default">New Note</span>
      <KeyboardShortcut keys={['⌘', '⇧', 'N']} />
    </div>
  </div>
);

/** Arrow key shortcuts */
export const ArrowKeys: Story = () => (
  <div className="flex gap-4 p-8">
    <KeyboardShortcut keys={['←']} />
    <KeyboardShortcut keys={['→']} />
    <KeyboardShortcut keys={['⌘', '←']} />
    <KeyboardShortcut keys={['⌘', '→']} />
  </div>
);

/** On dark variant (for use on dark backgrounds) */
export const OnDark: Story = () => (
  <div className="flex flex-col gap-4 p-8">
    <div className="rounded-lg bg-accent-brand p-6">
      <div className="flex items-center justify-between">
        <span className="text-sm text-ink-inverse">Submit</span>
        <KeyboardShortcut keys={['⌘', '↵']} variant="on-dark" />
      </div>
    </div>
    <div className="rounded-lg bg-ink-accent p-6">
      <div className="flex items-center justify-between">
        <span className="text-sm text-ink-inverse">Open Menu</span>
        <KeyboardShortcut keys={['⌥', 'O']} variant="on-dark" />
      </div>
    </div>
  </div>
);

/** Size variants */
export const Sizes: Story = () => (
  <div className="flex flex-col gap-6 p-8">
    <div className="flex items-center gap-4">
      <span className="w-20 text-sm text-ink-muted">Default:</span>
      <KeyboardShortcut keys={['⌘', 'K']} size="default" />
    </div>
    <div className="flex items-center gap-4">
      <span className="w-20 text-sm text-ink-muted">Compact:</span>
      <KeyboardShortcut keys={['⌘', 'K']} size="compact" />
    </div>
  </div>
);

/** Single key */
export const SingleKey: Story = () => (
  <div className="flex gap-4 p-8">
    <KeyboardShortcut keys={['⌘']} />
    <KeyboardShortcut keys={['⌥']} />
    <KeyboardShortcut keys={['⇧']} />
    <KeyboardShortcut keys={['K']} />
  </div>
);
