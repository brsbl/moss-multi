// ported-from: packages/desktop/stories/ImportFeedback.stories.tsx @ 762abb777
import type { Story } from '@ladle/react';

export const meta = {
  title: 'Components/ImportFeedback'
};

const ImportFeedbackPill = ({ type, message }: { type: 'success' | 'error'; message: string }) => (
  <div className="pointer-events-none fixed bottom-12 left-1/2 z-50 -translate-x-1/2">
    <span
      className={[
        'rounded-full px-3 py-1 text-xs shadow-lg',
        type === 'error'
          ? 'bg-status-error-surface text-status-error-text border border-status-error-border'
          : 'bg-ink-default/80 text-ink-inverse'
      ].join(' ')}
    >
      {message}
    </span>
  </div>
);

/** Pill shown after a successful markdown import. */
export const ImportSuccess: Story = () => (
  <ImportFeedbackPill type="success" message="Imported markdown" />
);

/** Pill shown when a markdown import fails. */
export const ImportError: Story = () => (
  <ImportFeedbackPill type="error" message="Failed to import markdown" />
);
