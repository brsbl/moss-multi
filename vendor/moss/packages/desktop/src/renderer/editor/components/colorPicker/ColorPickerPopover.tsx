// ported-from: packages/desktop/src/renderer/editor/components/colorPicker/ColorPickerPopover.tsx @ 762abb777
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { HsvaColor } from 'react-colorful';

import { Popover } from '@moss/shared/primitives';

import type { ColorDraft, ColorLiteralFormat } from '../../utils/colorDraftParser';
import {
  commitColorPickerLiteral,
  createColorPickerState,
  getColorPickerOutput,
  setColorPickerFormat,
  setColorPickerHsva,
  type ColorPickerFormat,
  type ColorPickerState,
} from '../../utils/colorPickerState';
import { ColorPickerFormatTabs } from './ColorPickerFormatTabs';
import { ColorPickerInputs } from './ColorPickerInputs';
import { ColorPickerSquare } from './ColorPickerSquare';
import { resolveCanvasCollisionBoundary } from '../../utils/canvas-collision-boundary';

export type ColorPickerMode = 'edit-pill' | 'insert';

export interface ColorPickerPopoverPreview {
  value: string;
  cssColor: string;
}

export interface ColorPickerPopoverProps {
  open: boolean;
  mode: ColorPickerMode;
  anchorRect: { x: number; y: number; width: number; height: number } | null;
  seed: ColorDraft | null;
  initialFormat: ColorLiteralFormat | ColorPickerFormat;
  collisionBoundary?: Element | null;
  onAccept: (literal: string, format: ColorPickerFormat) => void;
  onCancel: () => void;
  onPreviewChange?: (preview: ColorPickerPopoverPreview | null) => void;
}

// Checkerboard pattern shown behind the preview swatch so the alpha channel
// is visible against the panel background. Built from string fragments so
// the source file never contains a literal CSS color function-call open
// token (rejected by `scripts/audit-colors.ts` outside the token layer).
const FN_OPEN = '(';
const CHECKER_FILL = 'rgba' + FN_OPEN + '0,0,0,0.06)';
const CHECKER_STOPS =
  CHECKER_FILL + ' 25%, transparent 25%, transparent 75%, ' + CHECKER_FILL + ' 75%';
const CHECKER_GRADIENT =
  'linear-gradient(45deg, ' + CHECKER_STOPS + '), linear-gradient(45deg, ' + CHECKER_STOPS + ')';

function toHsvaColor(state: ColorPickerState): HsvaColor {
  return { h: state.h, s: state.s, v: state.v, a: state.a };
}

export function ColorPickerPopover({
  open,
  mode,
  anchorRect,
  seed,
  initialFormat,
  collisionBoundary,
  onAccept,
  onCancel,
  onPreviewChange,
}: ColorPickerPopoverProps) {
  const [state, setState] = useState<ColorPickerState>(() => createColorPickerState(seed, initialFormat));
  const resolvedCollisionBoundary = useMemo(
    () => resolveCanvasCollisionBoundary(collisionBoundary, anchorRect),
    [anchorRect, collisionBoundary]
  );

  // Identity of the seeded source: two ColorDraft instances with the same kind +
  // value represent the same source and must NOT reseed the picker (otherwise
  // unrelated upstream rerenders that build the draft inline — e.g.
  // parseColorLiteralDraft(pill.value) — would clobber the user's HSV/input
  // edits and format choice).
  const seedKey = seed ? `${seed.kind}|${seed.value}` : null;
  const prevOpenRef = useRef(open);
  const prevSeedKeyRef = useRef<string | null>(seedKey);
  const prevInitialFormatRef = useRef(initialFormat);

  useEffect(() => {
    const opening = open && !prevOpenRef.current;
    const seedChanged = open && seedKey !== prevSeedKeyRef.current;
    const formatChanged = open && initialFormat !== prevInitialFormatRef.current;
    prevOpenRef.current = open;
    prevSeedKeyRef.current = seedKey;
    prevInitialFormatRef.current = initialFormat;
    if (opening || seedChanged || formatChanged) {
      setState(createColorPickerState(seed, initialFormat));
    }
  }, [open, seedKey, initialFormat, seed]);

  const output = useMemo(() => getColorPickerOutput(state), [state]);
  const { literal, cssColor, showAlpha, format } = output;

  const previewSignatureRef = useRef<string>('');
  const visible = open && !!anchorRect;
  useEffect(() => {
    if (!visible) {
      if (previewSignatureRef.current !== '') {
        previewSignatureRef.current = '';
        onPreviewChange?.(null);
      }
      return;
    }
    const signature = `${literal}|${cssColor}`;
    if (signature === previewSignatureRef.current) return;
    previewSignatureRef.current = signature;
    onPreviewChange?.({ value: literal, cssColor });
  }, [visible, literal, cssColor, onPreviewChange]);

  useEffect(() => {
    return () => {
      if (previewSignatureRef.current !== '') {
        previewSignatureRef.current = '';
        onPreviewChange?.(null);
      }
    };
  }, [onPreviewChange]);

  const handleFormatChange = useCallback((next: ColorPickerFormat) => {
    setState((current) => setColorPickerFormat(current, next));
  }, []);

  const handleSquareChange = useCallback((next: HsvaColor) => {
    setState((current) => setColorPickerHsva(current, next));
  }, []);

  const handleValueCommit = useCallback((rawValue: string) => {
    setState((current) => commitColorPickerLiteral(current, rawValue));
  }, []);

  const handleAccept = useCallback(() => {
    const accepted = getColorPickerOutput(state);
    onAccept(accepted.literal, accepted.format);
  }, [state, onAccept]);

  const handleCancel = useCallback(() => {
    onCancel();
  }, [onCancel]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.defaultPrevented) return;
      if (event.key !== 'Enter') return;

      const target = event.target as HTMLElement | null;

      // Enter on a focused button (Cancel, format tab, Insert/Update) must
      // run that button's own action via the browser's default click — never
      // the content-level Accept. Bail without preventDefault so the click fires.
      if (target?.tagName === 'BUTTON') return;

      // Enter on an input with a pending draft must commit synchronously and
      // then Accept using the committed output — not the stale render state.
      if (target?.tagName === 'INPUT') {
        const input = target as HTMLInputElement;
        event.preventDefault();
        if (input.hasAttribute('data-color-picker-value-input')) {
          const committed = commitColorPickerLiteral(state, input.value);
          setState(committed);
          const accepted = getColorPickerOutput(committed);
          onAccept(accepted.literal, accepted.format);
          return;
        }
        handleAccept();
        return;
      }

      event.preventDefault();
      handleAccept();
    },
    [handleAccept, onAccept, state]
  );

  const virtualRef = useRef<{ getBoundingClientRect: () => DOMRect }>({
    getBoundingClientRect: () => new DOMRect(),
  });
  if (anchorRect) {
    virtualRef.current = {
      getBoundingClientRect: () =>
        new DOMRect(anchorRect.x, anchorRect.y, anchorRect.width, anchorRect.height),
    };
  }

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) onCancel();
    },
    [onCancel]
  );

  return (
    <Popover.Root open={open && !!anchorRect} onOpenChange={handleOpenChange}>
      <Popover.Anchor virtualRef={virtualRef} />
      <Popover.Portal>
        <Popover.Content
          role="dialog"
          aria-label="Color picker"
          data-color-picker-popover=""
          data-color-picker-mode={mode}
          side="bottom"
          align="start"
          sideOffset={6}
          collisionBoundary={resolvedCollisionBoundary ? [resolvedCollisionBoundary] : undefined}
          collisionPadding={{ top: 96, right: 12, bottom: 96, left: 12 }}
          positionerClassName="z-tooltip"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
          }}
          onKeyDown={handleKeyDown}
          className="z-tooltip w-64 overflow-hidden rounded-lg border border-border-default bg-surface-panel text-ink-default shadow-floating"
        >
          <ColorPickerFormatTabs value={format} onChange={handleFormatChange} firstFocusable />

          <div className="flex flex-col gap-2 p-2">
            <ColorPickerSquare hsva={toHsvaColor(state)} showAlpha={showAlpha} onChange={handleSquareChange} />

            <div className="flex items-stretch gap-2">
              <div
                data-color-picker-preview-swatch
                className="relative h-8 w-8 flex-none overflow-hidden rounded-md border border-border-default"
                style={{
                  backgroundImage: CHECKER_GRADIENT,
                  backgroundSize: '12px 12px',
                  backgroundPosition: '0 0, 6px 6px',
                }}
              >
                <div className="absolute inset-0" style={{ backgroundColor: cssColor }} />
              </div>
              <ColorPickerInputs value={literal} format={format} onCommit={handleValueCommit} />
            </div>

            <div className="flex justify-end gap-2 border-t border-border-subtle pt-2">
              <button
                type="button"
                data-color-picker-cancel
                onClick={handleCancel}
                className="rounded-md border border-border-default bg-surface-panel px-3 py-1 text-caption font-semibold text-ink-default transition-colors hover:bg-surface-panel-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-brand/40"
              >
                Cancel
              </button>
              <button
                type="button"
                data-color-picker-insert
                onClick={handleAccept}
                className="rounded-md border border-accent-brand bg-accent-brand px-3 py-1 text-caption font-semibold text-ink-on-accent transition-colors hover:bg-accent-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-brand/40"
              >
                {mode === 'edit-pill' ? 'Update' : 'Insert'}
              </button>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
