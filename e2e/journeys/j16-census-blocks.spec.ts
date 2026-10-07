// j16-census-blocks (T5.S1, M5 Slop Cop P1): the strike census in the real app for paragraphs, headings, list items
// and quotes, each on either side of a boundary, with every edge key and strike position (e2e/lib/strike-census.ts).
import { censusLeg, type Kind, type Side } from '../lib/strike-census.ts';
import { test } from '../lib/test.ts';

const KINDS: Kind[] = ['paragraph', 'heading', 'list item', 'quote'];

for (const kind of KINDS) {
  for (const side of ['before', 'after'] as Side[]) {
    test(`j16-census: ${kind} ${side} the boundary, every edge key and strike position, then undo and redo: F, the cards, the Edit-mode paint, the working export and accept leave every struck character out and keep the rest @p:mean-2 @p:R17`, async ({ actors }) => {
      test.setTimeout(240_000);
      await censusLeg(actors, kind, side);
    });
  }
}
