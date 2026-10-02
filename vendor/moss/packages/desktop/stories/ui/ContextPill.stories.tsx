// ported-from: packages/desktop/stories/ui/ContextPill.stories.tsx @ 762abb777
import { useState } from 'react';
import type { Story } from '@ladle/react';
import { ContextPill } from '@moss/shared/components/ui/context-pill';

export const meta = {
  title: 'UI/ContextPill'
};

/** Short text that doesn't truncate */
export const ShortText: Story = () => {
  const [visible, setVisible] = useState(true);

  if (!visible) {
    return (
      <div className="p-8">
        <button
          onClick={() => setVisible(true)}
          className="text-sm text-accent-brand underline"
        >
          Show pill again
        </button>
      </div>
    );
  }

  return (
    <div className="p-8">
      <ContextPill
        text="Selected text snippet"
        onRemove={() => setVisible(false)}
      />
    </div>
  );
};

/** Long text that truncates with tooltip */
export const LongText: Story = () => {
  const [visible, setVisible] = useState(true);
  const longText =
    'This is a much longer piece of text that will be truncated when displayed in the pill. Hover to see the full content in a tooltip.';

  if (!visible) {
    return (
      <div className="p-8">
        <button
          onClick={() => setVisible(true)}
          className="text-sm text-accent-brand underline"
        >
          Show pill again
        </button>
      </div>
    );
  }

  return (
    <div className="p-8">
      <ContextPill text={longText} onRemove={() => setVisible(false)} />
    </div>
  );
};

/** Browser selection context with source favicon */
export const BrowserSelection: Story = () => (
  <div className="p-8">
    <ContextPill
      text="selected browser text"
      iconUrl="https://example.com/favicon.ico"
      onRemove={() => console.log('removed')}
    />
  </div>
);

/** Custom truncation length */
export const CustomMaxLength: Story = () => (
  <div className="flex flex-col gap-4 p-8">
    <div>
      <p className="mb-2 text-xs text-ink-muted">maxLength=20</p>
      <ContextPill
        text="This text will truncate at 20 characters"
        maxLength={20}
        onRemove={() => console.log('removed')}
      />
    </div>
    <div>
      <p className="mb-2 text-xs text-ink-muted">maxLength=100</p>
      <ContextPill
        text="This text will truncate at 100 characters which is much longer than the default"
        maxLength={100}
        onRemove={() => console.log('removed')}
      />
    </div>
  </div>
);

/** Multiple pills in a row */
export const MultiplePills: Story = () => {
  const [pills, setPills] = useState([
    'First selection',
    'A longer second selection that will be truncated',
    'Third'
  ]);

  return (
    <div className="p-8">
      <div className="flex flex-wrap gap-2">
        {pills.map((text, index) => (
          <ContextPill
            key={index}
            text={text}
            onRemove={() => setPills(pills.filter((_, i) => i !== index))}
          />
        ))}
      </div>
      {pills.length === 0 && (
        <button
          onClick={() =>
            setPills([
              'First selection',
              'A longer second selection that will be truncated',
              'Third'
            ])
          }
          className="text-sm text-accent-brand underline"
        >
          Reset pills
        </button>
      )}
    </div>
  );
};
