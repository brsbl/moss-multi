// The text checks behind a caret kept through a peer's block change (T9.47): every row of the brief's section 6 that
// text decides, and the refusals of the unit table that text decides. Null leaves the binding's own caret.
import { describe, expect, it } from 'vitest';
import { movedOut, replacedOffset, splitOffset } from './peer-caret-text.ts';

const LINE = 'Target paragraph where Ben waits.';
const LEFT = 'Target paragraph where Ben';
const RIGHT = ' waits.';
const TAIL = ' paragraph where Ben waits.';

describe('replacedOffset: my line was replaced one for one @p:col-1', () => {
  const rows: [string, string, string, string, number | null][] = [
    ['a conversion, idle mid-line', LEFT, RIGHT, LINE, LEFT.length],
    ['a conversion, idle at the start', '', LINE, LINE, 0],
    ['a conversion, idle at the end', LINE, '', LINE, LINE.length],
    ['the line was empty', '', '', '', 0],
    ['/quote: the replacement is empty', LEFT, RIGHT, '', 0],
    ['one key in flight', `${LEFT}a`, RIGHT, LINE, LEFT.length],
    ['three keys in flight', `${LEFT}abc`, RIGHT, LINE, LEFT.length],
    ['twelve keys in flight', `${LEFT}abcdefghijkl`, RIGHT, LINE, LEFT.length],
    ['200 keys in flight', `${LEFT}${'k'.repeat(200)}`, RIGHT, LINE, LEFT.length],
    ['two Backspaces in flight', 'Target paragraph where B', RIGHT, LINE, LEFT.length],
    ['typing at the end of the line in flight', `${LINE} and`, '', LINE, LINE.length],
    ["a peer's zz at my caret in the same commit", LEFT, RIGHT, 'Target paragraph where Benzz waits.', `${LEFT}zz`.length],
    ["a peer's zz at the end of the line in the same commit", LEFT, RIGHT, `${LINE}zz`, LEFT.length],
    ["a peer's \"- \" shortcut at my offset 0", '- ', LINE, LINE, 0],
    ['a peer undoes the conversion', LEFT, RIGHT, LINE, LEFT.length],
    // Refusals decided by text.
    ['refused: the commit changed my line on both sides of the caret', LEFT, RIGHT, `x${LINE}y`, null],
    ['refused: unrelated text where my line stood', LEFT, RIGHT, 'Something else entirely.', null],
    ['refused: a prefix of my line where it stood, the caret beyond it', LEFT, RIGHT, 'Target para', null],
  ];
  for (const [name, left, right, t, want] of rows) {
    it(name, () => expect(replacedOffset(left, right, t)).toBe(want));
  }
});

describe('splitOffset: the words on my left moved into a new block @p:col-1', () => {
  const rows: [string, string, string, string, string[], boolean, number | null][] = [
    ["a peer's Enter before my caret", LEFT, RIGHT, 'Target', [TAIL], false, TAIL.length - RIGHT.length],
    ["a peer's Enter at offset 0, my caret further in", LEFT, RIGHT, '', [LINE], false, LEFT.length],
    ["a peer's Enter at offset 0 of my heading (an empty paragraph and a new heading)", LEFT, RIGHT, '', ['', LINE], false, LEFT.length],
    ["a peer's Enter mid-line, my caret idle at the very end", LINE, '', 'Target', [TAIL], false, TAIL.length],
    ['my keys in flight, text on my right, they stay in the first half', `${LEFT}abc`, RIGHT, 'Targetabc', [TAIL], false, TAIL.length - RIGHT.length],
    ['after a bold run, Enter before the run', 'Hello bold ta', 'il end.', 'He', ['llo bold tail end.'], false, 'llo bold ta'.length],
    ["a range's start at the split follows its first character", 'Target paragraph where ', 'Ben waits.', 'Target paragraph where ', ['Ben waits.'], true, 0],
    // Refusals decided by text.
    ['refused: Enter exactly at my caret', LEFT, RIGHT, LEFT, [RIGHT], false, null],
    ['refused: Enter at a bold boundary at my caret', 'Hello ', 'bold tail', 'Hello ', ['bold tail'], false, null],
    ['refused: Enter at offset 0 with my caret at offset 0', '', LINE, '', [LINE], false, null],
    ['refused: typing at the end of the line across Enter', `${LINE}abc`, '', 'Targetabc', [TAIL], false, null],
    ['refused: my Backspaces in flight across Enter', 'Target paragraph where B', RIGHT, 'Target', [TAIL], false, null],
    ["refused: a peer deleted a word on my left and added a paragraph below, my caret at the end", 'Alpha beta gamma.', '', 'Alpha gamma.', ['New line.'], false, null],
    ['refused: the same, one character before the end', 'Alpha beta gamma', '.', 'Alpha gamma.', ['New line.'], false, null],
    ['refused: the same, the deleted run and the new paragraph equal in length', 'Alpha beta gamma.', '', 'Alpha gamma.', ['Beta.'], false, null],
    ['refused: my right-hand text replaced with two paragraphs, the second ending like my line', 'Alpha beta', ' gamma.', 'Alpha One.', ['Two gamma.'], false, null],
    ["refused: a peer's three lines pasted before my caret", LEFT, RIGHT, 'Target one', ['two', `three${TAIL}`], false, null],
    ["refused: a peer's Enter and zz at my place in the new block in one commit", LEFT, RIGHT, 'Target', [' paragraph where Benzz waits.'], false, null],
    ['refused: the new block does not end with my right-hand words', LEFT, RIGHT, 'Target', [' paragraph where Ben waits!'], false, null],
  ];
  for (const [name, left, right, kept, fresh, start, want] of rows) {
    it(name, () => expect(splitOffset(left, right, kept, fresh, start)).toBe(want));
  }
});

describe('movedOut: my line with the moved run inserted at one place @p:col-1', () => {
  it('the plain case: my unsent keys after the moved run', () => {
    expect(movedOut(`${LEFT}abc`, 'Targetabc', ' paragraph where Ben')).toBe(true);
  });
  it('the second position: the moved run starts like the kept text after it', () => {
    expect(movedOut('abcb', 'ab', 'bc')).toBe(true);
  });
  it('a third position is not tried', () => {
    // "xy" with "yx" inserted after "x": both tried positions miss.
    expect(movedOut('xyxy', 'xy', 'yx')).toBe(false);
  });
  it('lengths that do not add up', () => {
    expect(movedOut('Target paragraph where B', 'Target', ' paragraph where Ben')).toBe(false);
  });
});
