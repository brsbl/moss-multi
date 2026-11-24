import { describe, expect, it } from 'vitest';
import * as row from './bottom-row.ts';

interface Press { target: unknown; preventDefault(): void }
const keep = (row as unknown as { keepCaretInNote?: (event: Press) => void }).keepCaretInNote;

/** Whether a press on `target` was kept from moving focus. */
function kept(target: unknown): boolean {
  let prevented = false;
  keep?.({ target, preventDefault: () => { prevented = true; } });
  return prevented;
}
const element = (inButton: boolean) => ({ closest: (selector: string) => (selector === 'button' && inButton ? {} : null) });

describe('a press in the pane’s bottom region (T9.51)', () => {
  it('on a notice’s action leaves focus where it is, so the docked toolbar stays and the region does not move under the pointer', () => {
    expect(kept(element(true))).toBe(true);
  });

  it('on a notice’s words is left alone, so unsaved text can still be selected by hand', () => {
    expect(kept(element(false))).toBe(false);
    expect(kept(null)).toBe(false);
  });
});
