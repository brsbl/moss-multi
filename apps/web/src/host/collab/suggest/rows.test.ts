// @vitest-environment jsdom
// T5.S7: a card's state changes (busy, error, copied, expanded) never rebuild its rows; a new preview hash does, once.
import type { Hunk } from '@moss-multi/core/suggest/apply';
import { describeStats, type ReviewRow } from '@moss-multi/core/suggest/describe';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { usePreviewRows } from './rows.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hunk = (text: string): Hunk => ({
  kind: 'payload', id: 'p', op: 'changed',
  before: { text: 'seed', ids: [['1:0', 4]], map: [] },
  after: { text, ids: [['1:0', 4], ['9:0', text.length - 4]], map: [] },
});

it('rows are built once per preview hash, whatever else the card re-renders for @p:mean-2 @p:R17', () => {
  const seen: ReviewRow[][] = [];
  let bump = () => {};
  let show = (_preview: { hash: string; hunks: Hunk[] }) => {};
  function Card({ initial }: { initial: { hash: string; hunks: Hunk[] } }) {
    const [, setTick] = useState(0);
    const [preview, setPreview] = useState(initial);
    bump = () => setTick((n) => n + 1);
    show = setPreview;
    const rows = usePreviewRows(preview);
    seen.push(rows);
    return createElement('div', null, rows.map((row) => row.text).join('|'));
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  const calls = describeStats.calls;
  act(() => root.render(createElement(Card, { initial: { hash: 'card-h1', hunks: [hunk('seed!')] } })));
  for (let i = 0; i < 5; i++) act(() => bump());
  expect(seen.length).toBeGreaterThanOrEqual(6);
  expect(describeStats.calls - calls, 'state changes rebuilt the rows').toBe(1);
  expect(new Set(seen).size).toBe(1);
  act(() => show({ hash: 'card-h2', hunks: [hunk('seed?')] }));
  act(() => bump());
  expect(describeStats.calls - calls, 'a new hash builds its rows once').toBe(2);
  act(() => root.unmount());
});
