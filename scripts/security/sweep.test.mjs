import { describe, expect, it } from 'vitest';
import { otherPortOrigin } from './sweep.mjs';

describe('otherPortOrigin', () => {
  const cases = [
    ['https://moss.example.invalid', 'https://moss.example.invalid:444'],
    ['https://moss.example.invalid:443/app', 'https://moss.example.invalid:444'],
    ['http://moss.example.invalid', 'http://moss.example.invalid:81'],
    ['http://127.0.0.1:8787', 'http://127.0.0.1:8788'],
    ['http://127.0.0.1:79', 'http://127.0.0.1:81'],
    ['https://moss.example.invalid:65535', 'https://moss.example.invalid:65534'],
  ];
  for (const [base, expected] of cases) {
    it(`${base} -> ${expected}`, () => {
      const other = otherPortOrigin(base);
      expect(other).toBe(expected);
      expect(other).not.toBe(new URL(base).origin);
      expect(new URL(other).port).not.toBe('');
    });
  }
});
