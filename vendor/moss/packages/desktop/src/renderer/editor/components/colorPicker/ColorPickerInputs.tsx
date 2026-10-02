// ported-from: packages/desktop/src/renderer/editor/components/colorPicker/ColorPickerInputs.tsx @ 762abb777
import { useEffect, useState } from 'react';

import type { ColorPickerFormat } from '../../utils/colorPickerState';

export interface ColorPickerInputsProps {
  value: string;
  format: ColorPickerFormat;
  onCommit: (rawValue: string) => void;
}

export function ColorPickerInputs({ value, format, onCommit }: ColorPickerInputsProps) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const handleCommit = () => {
    if (draft === value) return;
    onCommit(draft);
  };

  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="sr-only">{format.toUpperCase()} value</span>
      <input
        type="text"
        spellCheck={false}
        autoComplete="off"
        value={draft}
        data-color-picker-literal
        data-color-picker-value-input
        aria-label={`${format.toUpperCase()} value`}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={handleCommit}
        className={[
          'h-8 w-full rounded-md border border-border-subtle bg-surface-panel-alt px-2 font-mono text-caption font-semibold text-ink-default',
          'focus:border-accent-brand focus:outline-none focus:ring-2 focus:ring-accent-brand/30',
          format === 'hex' ? 'lowercase' : '',
        ].join(' ')}
      />
    </label>
  );
}
