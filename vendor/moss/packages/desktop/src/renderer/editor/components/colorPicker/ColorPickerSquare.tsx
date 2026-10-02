// ported-from: packages/desktop/src/renderer/editor/components/colorPicker/ColorPickerSquare.tsx @ 762abb777
import type { HsvaColor } from 'react-colorful';
import { HsvColorPicker, HsvaColorPicker } from 'react-colorful';

export interface ColorPickerSquareProps {
  hsva: HsvaColor;
  showAlpha: boolean;
  onChange: (hsva: HsvaColor) => void;
}

export function ColorPickerSquare({ hsva, showAlpha, onChange }: ColorPickerSquareProps) {
  if (showAlpha) {
    return (
      <div className="moss-color-picker">
        <HsvaColorPicker color={hsva} onChange={onChange} />
      </div>
    );
  }
  return (
    <div className="moss-color-picker moss-color-picker--no-alpha">
      <HsvColorPicker
        color={{ h: hsva.h, s: hsva.s, v: hsva.v }}
        onChange={(next) => onChange({ ...next, a: hsva.a })}
      />
    </div>
  );
}
