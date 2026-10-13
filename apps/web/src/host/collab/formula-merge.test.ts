// T3.B15: the formula popover's merge of a peer's change into an open draft, in stored form (B009, B040, B041).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTokenCodec, mergeStoredFormula, storedCaret } from './formula-merge.ts';

const hex = (i: number) => i.toString(16).padStart(12, '0');
const ref = (i: number, name = `r${i}`) => `@(${name}#11111111-1111-4111-8111-${hex(i)}#22222222-2222-4222-8222-${hex(i)})`;
const humanize = (raw: string) => raw.replace(/@\(([a-zA-Z][a-zA-Z0-9_-]*)#[0-9a-fA-F-]{36}#[0-9a-fA-F-]{36}\)/g, '$1');
const isSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdfff;

/** Every non-surrogate BMP unit except the first `free` of the private use area, where token allocation starts. */
function crowded(free: number): string {
  const units: number[] = [];
  for (let unit = 0; unit < 0x10000; unit += 1) if (!isSurrogate(unit) && !(unit >= 0xe000 && unit < 0xe000 + free)) units.push(unit);
  let text = '';
  for (let i = 0; i < units.length; i += 4096) text += String.fromCharCode(...units.slice(i, i + 4096));
  return text;
}

/** Every UTF-16 unit, surrogates alone, and every astral code point: nothing is left for a token. */
function everything(): string {
  const parts: string[] = [crowded(0)];
  // Each surrogate alone, so no two of them pair.
  for (let unit = 0xd800; unit <= 0xdfff; unit += 1) parts.push(`${String.fromCharCode(unit)}.`);
  const points: number[] = [];
  for (let point = 0x10000; point <= 0x10ffff; point += 1) {
    points.push(point);
    if (points.length === 4096) { parts.push(String.fromCodePoint(...points)); points.length = 0; }
  }
  parts.push(String.fromCodePoint(...points));
  return parts.join('');
}

/** A hang guard: an allocator that scans past every candidate unit more than once fails instead of spinning. */
function guardAllocation() {
  const original = String.fromCharCode;
  let calls = 0;
  vi.spyOn(String, 'fromCharCode').mockImplementation((...codes: number[]) => {
    calls += 1;
    if (calls > 0x40000) throw new Error('token allocation did not complete within one pass over the alphabet');
    return original(...codes);
  });
}

afterEach(() => { vi.restoreAllMocks(); });

describe('formula token codec (B041)', () => {
  it('gives each reference its own character, never a surrogate and never one a source uses, past the BMP\'s free units', () => {
    guardAllocation();
    const draft = crowded(10);
    // Adjacent references: once the BMP's 10 free units are used, an allocator that wrapped into the surrogates gave
    // neighbours a high and a low surrogate, which a code-point decode read as one character.
    const refs = Array.from({ length: 1100 }, (_, i) => ref(i));
    const raw = `${draft}${refs.join('')}😀x${ref(0)}`;
    const codec = createTokenCodec([raw])!;
    expect(codec).not.toBeNull();
    const used = new Set(raw);
    const chars = refs.map((token) => codec.encode(token).text);
    expect(new Set(chars).size, 'no two references share a character').toBe(refs.length);
    for (const char of chars) {
      expect(used.has(char), 'no reference takes a character the text uses').toBe(false);
      expect([...char], 'one character each').toHaveLength(1);
      if (char.length === 1) expect(isSurrogate(char.charCodeAt(0)), 'a single unit is never a surrogate').toBe(false);
    }
    const encoded = codec.encode(raw);
    expect(codec.decode(encoded.text).raw, 'every reference round-trips exactly').toBe(raw);
    expect(encoded.spans).toHaveLength(1101);
    const shown = humanize(raw);
    expect(encoded.spans[1100], 'the last reference is the name at the end').toMatchObject({ start: shown.length - 2, end: shown.length });
  });

  it('merges a peer\'s retarget of one reference into a crowded draft, keeping every other reference', () => {
    guardAllocation();
    const draft = crowded(10);
    const refs = Array.from({ length: 1100 }, (_, i) => ref(i));
    const before = `${draft}${refs.join('')}`;
    const after = `${draft}${refs.map((token, i) => (i === 1050 ? ref(5000, 'r1050') : token)).join('')}`;
    const ours = `${before}*`;
    const { raw } = mergeStoredFormula(before, after, ours, [ours.length]);
    expect(raw === `${after}*`, 'the merge takes the peer\'s token whole and keeps the draft\'s own edit').toBe(true);
  });

  it('completes when every character is taken, merging the stored text as it is', () => {
    guardAllocation();
    const draft = everything();
    const before = `${draft}+${ref(1)}+${ref(2)}`;
    const after = `${draft}+${ref(1)}+${ref(3, 'r2')}`;
    const ours = `${before}*2`;
    expect(createTokenCodec([before, after, ours]), 'no character is free').toBeNull();
    const { raw } = mergeStoredFormula(before, after, ours, [0]);
    expect(raw === `${after}*2`, 'the peer\'s reference lands whole beside the draft\'s edit').toBe(true);
  });

  it('keeps ordinary astral text beside references', () => {
    const before = `😀${ref(1, 'cost')}+𝔸`;
    const after = `😀${ref(1, 'cost')}+𝔸+${ref(2, 'tax')}`;
    const ours = `1+😀${ref(1, 'cost')}+𝔸`;
    const { raw, selection } = mergeStoredFormula(before, after, ours, [humanize(ours).length]);
    expect(raw).toBe(`1+😀${ref(1, 'cost')}+𝔸+${ref(2, 'tax')}`);
    expect(selection).toEqual([humanize(ours).length]);
  });
});

describe('a caret or range inside a reference (B040)', () => {
  const price = ref(1, 'price');
  const before = `${price}+2+3`;

  it('keeps its place in the name when a peer prepends text or edits another operand', () => {
    const prepended = mergeStoredFormula(before, `1+${before}`, before, [1, 4]);
    expect(prepended.selection).toEqual([3, 6]);
    expect(humanize(prepended.raw).slice(3, 6), 'the same substring stays selected').toBe('ric');
    const operand = mergeStoredFormula(before, `${price}+2+4`, `${before}*`, [2, 2]);
    expect(humanize(operand.raw)).toBe('price+2+4*');
    expect(operand.selection, 'the caret stays between "pr" and "ice"').toEqual([2, 2]);
  });

  it('goes to where the reference stood when a peer removes or retargets it', () => {
    const removed = mergeStoredFormula(before, '5+2+3', before, [2, 2], [{ delete: price.length }, { insert: '5' }]);
    expect(humanize(removed.raw)).toBe('5+2+3');
    expect(removed.selection).toEqual([0, 0]);
    const retargeted = mergeStoredFormula(`9+${before}`, `9+${ref(2, 'price')}+2+3`, `9+${before}`, [3, 5]);
    expect(humanize(retargeted.raw)).toBe('9+price+2+3');
    expect(retargeted.selection, 'another token with the same name is not the same reference').toEqual([2, 2]);
  });
});

describe('the edit a peer made and the one the field made (B009)', () => {
  it('merges a peer\'s change from its delta, so an edit inside a run of equal characters keeps its place', () => {
    // Ben's undo removed the first '2' of four; a diff of the texts would remove the last.
    const merged = mergeStoredFormula('2222', '222', '2222', [1, 1], [{ delete: 1 }]);
    expect(merged).toEqual({ raw: '222', selection: [0, 0] });
    const named = mergeStoredFormula('aaaa+1', 'aaa+1', 'aaaa+1*', [3, 3], [{ delete: 1 }]);
    expect(named).toEqual({ raw: 'aaa+1*', selection: [2, 2] });
  });

  it('maps the field\'s caret into the stored text it writes, past references and trimmed space', () => {
    expect(storedCaret('2', 0), 'a deletion before the caret ends where the caret is').toBe(0);
    const price = ref(1, 'price');
    expect(storedCaret(`  ${price}+2`, 7), 'after the name is after its token, less the trimmed space').toBe(price.length);
    expect(storedCaret(`${price}+2`, 3), 'inside a name is at its token\'s start').toBe(0);
    expect(storedCaret('aa  ', 4), 'trailing space trimmed away clamps to the end').toBe(2);
    expect(storedCaret('aa', undefined)).toBeUndefined();
  });
});
