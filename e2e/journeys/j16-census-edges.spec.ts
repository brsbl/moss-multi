// j16-census-edges (T5.S1, M5 Slop Cop P1): the strike census in the real app for a heading that leads its note,
// empty paragraphs, code blocks and decorators, each on either side of a boundary, with every edge key and strike
// position that applies (e2e/lib/strike-census.ts).
import { censusLeg, type Kind, type Side } from '../lib/strike-census.ts';
import { test } from '../lib/test.ts';

const KINDS: Kind[] = ['leading heading', 'empty paragraph', 'code block', 'decorator'];

for (const kind of KINDS) {
  for (const side of ['before', 'after'] as Side[]) {
    // A leading heading is the block after a boundary with nothing before it; before a boundary it is any heading.
    if (kind === 'leading heading' && side === 'before') continue;
    test(`j16-census: ${kind} ${side} the boundary, every edge key and strike position, then undo and redo: F, the cards, the Edit-mode paint, the working export and accept leave every struck character out and keep the rest @p:mean-2 @p:R17`, async ({ actors }) => {
      test.setTimeout(240_000);
      await censusLeg(actors, kind, side);
    });
  }
}
