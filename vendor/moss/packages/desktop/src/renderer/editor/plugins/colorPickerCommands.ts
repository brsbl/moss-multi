// ported-from: packages/desktop/src/renderer/editor/plugins/colorPickerCommands.ts @ 762abb777
import { createCommand } from 'lexical';

import type { ColorDraft, ColorPickerFormat } from '../utils/colorDraftParser';
import type { ColorPickerTriggerRange } from '../utils/colorPickerTriggers';

export interface ColorPickerAnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OpenColorPickerPayload {
  initialFormat: ColorPickerFormat;
  seed?: ColorDraft | null;
  replaceRange?: ColorPickerTriggerRange | null;
  anchorRect?: ColorPickerAnchorRect | null;
}

export const OPEN_COLOR_PICKER_COMMAND = createCommand<OpenColorPickerPayload>(
  'OPEN_COLOR_PICKER_COMMAND'
);
