// ported-from: packages/desktop/stories/ui/PromptBox.stories.tsx @ 762abb777
import { useState } from 'react';
import type { Story } from '@ladle/react';
import { PromptBox } from '@moss/shared/components/ui/prompt-box';

export const meta = {
  title: 'UI/PromptBox'
};

/** Default empty state */
export const Empty: Story = () => {
  const [value, setValue] = useState('');

  return (
    <div className="relative h-[500px] bg-surface-canvas">
      <PromptBox
        value={value}
        onChange={setValue}
        onSubmit={() => console.log('Submit:', value)}
        onClose={() => console.log('Close')}
      />
    </div>
  );
};

/** With pre-filled content */
export const WithContent: Story = () => {
  const [value, setValue] = useState(
    'Analyze the quarterly sales data and create a summary report'
  );

  return (
    <div className="relative h-[500px] bg-surface-canvas">
      <PromptBox
        value={value}
        onChange={setValue}
        onSubmit={() => console.log('Submit:', value)}
        onClose={() => console.log('Close')}
      />
    </div>
  );
};

/** Submitting state */
export const Submitting: Story = () => {
  const [value, setValue] = useState('Generate a project timeline');

  return (
    <div className="relative h-[500px] bg-surface-canvas">
      <PromptBox
        value={value}
        onChange={setValue}
        onSubmit={() => {}}
        onClose={() => console.log('Close')}
        isSubmitting={true}
      />
    </div>
  );
};

/** Interactive demo */
export const Interactive: Story = () => {
  const [value, setValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastSubmitted, setLastSubmitted] = useState<string | null>(null);

  const handleSubmit = () => {
    setIsSubmitting(true);
    setLastSubmitted(value);
    setTimeout(() => {
      setIsSubmitting(false);
      setValue('');
    }, 2000);
  };

  return (
    <div className="relative h-[500px] bg-surface-canvas">
      {lastSubmitted && (
        <div className="absolute left-4 top-4 rounded-lg bg-ink-inverse p-4 shadow-sm">
          <p className="text-xs text-ink-muted">Last submitted:</p>
          <p className="text-sm text-ink-default">{lastSubmitted}</p>
        </div>
      )}
      <PromptBox
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        onClose={() => console.log('Close')}
        isSubmitting={isSubmitting}
      />
    </div>
  );
};
