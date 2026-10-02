import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// T0.11: every surface moss lacks has a light and a dark glyphdown reference in the index.
const INDEX = fileURLToPath(new URL('../../docs/design/glyphdown-reference.md', import.meta.url));
const SURFACES = [
  'Login card',
  'Share dialog',
  'Presence and cursors',
  'Connection pill and offline banner',
  'Bell and inbox',
  'Vault switcher',
  'History page',
  'Suggest mode and SuggestionsPanel',
];
const ATTACHMENT = /https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]{36}/g;

// Table rows as { surface, light: [urls], dark: [urls] }, read through the header's Light and Dark columns.
function readIndex(text) {
  const rows = [];
  let columns = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) {
      columns = null;
      continue;
    }
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (!columns) {
      columns = { light: cells.indexOf('Light'), dark: cells.indexOf('Dark') };
      continue;
    }
    if (cells.every((cell) => /^:?-+:?$/.test(cell)) || columns.light < 0 || columns.dark < 0) continue;
    const urls = (cell) => cell?.match(ATTACHMENT) ?? [];
    rows.push({ surface: cells[0], light: urls(cells[columns.light]), dark: urls(cells[columns.dark]) });
  }
  return rows;
}

describe('glyphdown reference index', () => {
  it('exists', () => {
    expect(existsSync(INDEX), 'docs/design/glyphdown-reference.md').toBe(true);
  });

  it.each(SURFACES)('has a light and a dark attachment for %s', (surface) => {
    const rows = existsSync(INDEX) ? readIndex(readFileSync(INDEX, 'utf8')) : [];
    const row = rows.find((candidate) => candidate.surface === surface);
    expect(row, `no row for "${surface}"`).toBeDefined();
    expect(row.light.length, `${surface}: light`).toBeGreaterThan(0);
    expect(row.dark.length, `${surface}: dark`).toBeGreaterThan(0);
    expect(row.light.filter((url) => row.dark.includes(url)), `${surface}: light and dark share a URL`).toEqual([]);
  });
});
