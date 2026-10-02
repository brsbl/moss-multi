// ported-from: packages/desktop/src/renderer/editor/components/colorPicker/ColorPickerFormatTabs.tsx @ 762abb777
import { forwardRef } from 'react';

import type { ColorPickerFormat } from '../../utils/colorPickerState';

const FORMAT_LABELS: Record<ColorPickerFormat, string> = {
  hex: 'HEX',
  rgba: 'RGBA',
  hsla: 'HSLA',
};

const FORMAT_ORDER: readonly ColorPickerFormat[] = ['hex', 'rgba', 'hsla'];

export interface ColorPickerFormatTabsProps {
  value: ColorPickerFormat;
  onChange: (format: ColorPickerFormat) => void;
  firstFocusable?: boolean;
}

export const ColorPickerFormatTabs = forwardRef<HTMLButtonElement, ColorPickerFormatTabsProps>(
  function ColorPickerFormatTabs({ value, onChange, firstFocusable = false }, ref) {
    return (
      <div
        role="tablist"
        aria-label="Color format"
        className="flex gap-px border-b border-border-subtle bg-surface-panel px-2 pt-2"
      >
        {FORMAT_ORDER.map((format) => {
          const isActive = format === value;
          return (
            <button
              key={format}
              ref={isActive ? ref : undefined}
              type="button"
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              data-color-picker-first-focusable={isActive && firstFocusable ? '' : undefined}
              data-format={format}
              onClick={() => onChange(format)}
              className={[
                'flex-1 border-b-2 px-0 pb-2 pt-1 text-nano font-bold uppercase tracking-wider transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-brand/40',
                isActive
                  ? 'border-accent-brand text-accent-brand'
                  : 'border-border-clear text-ink-muted hover:text-ink-default',
              ].join(' ')}
            >
              {FORMAT_LABELS[format]}
            </button>
          );
        })}
      </div>
    );
  }
);
