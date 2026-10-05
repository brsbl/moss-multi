// T4.0 supported liveness against the real DocDO (T4.2; docs/design/comments.md §0): real @lexical/yjs V1 editors with
// Y.UndoManager, the DocDO applying each frame. A comment keeps its exact characters through formatting, Enter, soft
// breaks, joins and markdown shortcuts, orphans when its text goes, and reattaches on undo or redo, including offline
// replays under the frame discipline.
import { BOLD_STAR, registerMarkdownShortcuts } from '@lexical/markdown';
import { $getSelection, $isRangeSelection, type ElementNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import { liveUnits, mintAnchor } from '@moss-multi/core/anchor-frame';
import { MARKDOWN_EDITOR_TRANSFORMERS } from '../../src/converter/index.ts';
import { $block, $caret, $select, scene, type FrameVerdict, type Scene } from './comments-scene.ts';

const accepted = (verdicts: FrameVerdict[]) => expect(verdicts.map((verdict) => verdict.refused)).toEqual(verdicts.map(() => null));
const on = (s: Scene, text: string, id = 'c1') => {
  expect(s.status(id), `${id} is anchored`).toBe('anchored');
  expect(s.text(id)).toBe(text);
};
/** Comment `id` sits on the live units at `from` in the server's text, not on another copy of its quote. */
const placed = (s: Scene, id: string, from: number, quote: string) => {
  const { text, units } = liveUnits(s.server);
  expect(text.slice(from, from + quote.length)).toBe(quote);
  const want = mintAnchor(units[from], units[from + quote.length - 1]);
  expect([s.anchor(id)?.start, s.anchor(id)?.end], `${id} is at ${from}`).toEqual([want.start, want.end]);
};
const orphaned = (s: Scene, id = 'c1') => {
  expect(s.status(id), `${id} is orphaned`).toBe('orphaned');
  expect(s.text(id)).toBeNull();
};

describe('T4.0 supported liveness: a comment keeps its exact characters @p:tech-3', () => {
  for (const [label, target] of [
    ['before', 'quick'],
    ['inside', 'own'],
    ['across the start', 'quick bro'],
    ['across the end', 'fox jumps'],
    ['after', 'jumps'],
  ] as const) {
    it(`bold ${label} it, then unbold`, () => scene(async (s) => {
      const a = s.peer();
      await s.comment('c1', 'brown fox');
      a.edit(() => $select(target).formatText('bold'));
      accepted(await a.send());
      on(s, 'brown fox');
      a.edit(() => $select(target).formatText('bold'));
      accepted(await a.send());
      on(s, 'brown fox');
    }));
  }

  it('Enter before it', () => scene(async (s) => {
    const a = s.peer();
    await s.comment('c1', 'brown fox');
    a.edit(() => $caret('brown').insertParagraph());
    accepted(await a.send());
    expect(a.text()).toContain('The quick \n\nbrown fox');
    on(s, 'brown fox');
  }));

  it('Enter inside it: the range crosses into the new block', () => scene(async (s) => {
    const a = s.peer();
    await s.comment('c1', 'brown fox');
    a.edit(() => $caret(' fox').insertParagraph());
    accepted(await a.send());
    expect(a.text()).toContain('brown\n\n fox');
    on(s, 'brown fox');
  }));

  it('a soft break inside it', () => scene(async (s) => {
    const a = s.peer();
    await s.comment('c1', 'brown fox');
    a.edit(() => $caret(' fox').insertLineBreak());
    accepted(await a.send());
    on(s, 'brown fox');
  }));

  it('a Backspace join of its block', () => scene(async (s) => {
    const a = s.peer();
    await s.comment('c1', 'Second paragraph');
    a.edit(() => $caret('Second').deleteCharacter(true));
    accepted(await a.send());
    expect(a.text()).toContain('dog.Second paragraph');
    on(s, 'Second paragraph');
  }));

  it('a markdown inline shortcut in its text node', () => scene(async (s) => {
    const a = s.peer();
    const stop = registerMarkdownShortcuts(a.editor, [BOLD_STAR]);
    try {
      await s.comment('c1', 'brown fox');
      a.edit(() => $caret('The').insertText('**go* '));
      accepted(await a.send());
      a.edit(() => $caret('go*', 0, 'end'));
      a.edit(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertText('*');
      });
      accepted(await a.send());
      expect(a.text().startsWith('go The quick'), a.text()).toBe(true);
      on(s, 'brown fox');
    } finally {
      stop();
    }
  }));

  // moss's own shortcut set. Typing the closing delimiter makes Lexical delete the commented text with its delimiters
  // and reinsert it as a new formatted node, so the gap's lost text is the inserted text plus the delimiters.
  for (const [label, open, close] of [
    ['bold **', '**', '**'],
    ['italic _', '_', '_'],
    ['strikethrough ~~', '~~', '~~'],
    ['inline code `', '`', '`'],
    ['highlight ==', '==', '=='],
    ['link [](url)', '[', '](https://example.invalid)'],
  ] as const) {
    it(`a markdown shortcut that wraps its text: ${label}`, () => scene(async (s) => {
      const a = s.peer();
      const stop = registerMarkdownShortcuts(a.editor, MARKDOWN_EDITOR_TRANSFORMERS);
      const type = (text: string) => a.edit(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertText(text);
      });
      try {
        await s.comment('c1', 'brown fox');
        a.edit(() => $caret('brown'));
        type(open);
        accepted(await a.send());
        a.edit(() => $caret('fox', 0, 'end'));
        // All but the last character at once (no shortcut fires), then the last one as a keystroke.
        if (close.length > 1) type(close.slice(0, -1));
        type(close.slice(-1));
        accepted(await a.send());
        expect(a.text(), 'the shortcut fired').toContain('The quick brown fox jumps');
        on(s, 'brown fox');
      } finally {
        stop();
      }
    }));
  }

  // Lexical keeps 'The quick ' and @lexical/yjs deletes the rest of the old node, so the lost text holds the commented
  // passage twice: once wrapped in the delimiters and once in the untouched text after it.
  it('markdown-wrap-keeps-first-of-two-identical-passages', () => scene(async (s) => {
    const a = s.peer();
    const stop = registerMarkdownShortcuts(a.editor, MARKDOWN_EDITOR_TRANSFORMERS);
    const type = (text: string) => a.edit(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.insertText(text);
    });
    try {
      await s.comment('c1', 'brown fox');
      await s.comment('c2', 'brown fox', 1);
      a.edit(() => $caret('brown'));
      type('**');
      accepted(await a.send());
      a.edit(() => $caret('fox', 0, 'end'));
      type('*');
      type('*');
      accepted(await a.send());
      expect(a.text(), 'the shortcut fired').toBe('The quick brown fox brown fox jumps.');
      on(s, 'brown fox');
      on(s, 'brown fox', 'c2');
      placed(s, 'c1', 10, 'brown fox');
      placed(s, 'c2', 20, 'brown fox');
    } finally {
      stop();
    }
  }, 'The quick brown fox brown fox jumps.'));
});

// P2 #9 (comments.md §7): a shortcut whose rewritten span holds the commented text more than once cannot be mapped
// without a guess, so the comment fails safe to orphaned. The same shortcut with the text unambiguous keeps it.
describe('T4.0 a link shortcut maps its label only when the label is unambiguous in the rewritten span @p:tech-3', () => {
  const link = (url: string) => async (s: Scene) => {
    const a = s.peer();
    const stop = registerMarkdownShortcuts(a.editor, MARKDOWN_EDITOR_TRANSFORMERS);
    const type = (text: string) => a.edit(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.insertText(text);
    });
    try {
      await s.comment('c1', 'example');
      a.edit(() => $caret('example'));
      type('[');
      accepted(await a.send());
      a.edit(() => $caret('example', 0, 'end'));
      type(`](${url}`);
      type(')');
      accepted(await a.send());
      expect(a.text(), 'the shortcut fired').toBe('Visit example now.');
    } finally {
      stop();
    }
  };

  it('link-label-in-url-orphans-the-comment', () => scene(async (s) => {
    await link('https://example.invalid')(s);
    orphaned(s);
  }, 'Visit example now.'));

  it('link-label-not-in-url-keeps-the-comment', () => scene(async (s) => {
    await link('https://moss.invalid')(s);
    on(s, 'example');
    placed(s, 'c1', 6, 'example');
  }, 'Visit example now.'));
});

describe('T4.0 supported liveness: orphan on deletion, reattach on undo and redo @p:tech-3 @p:R18', () => {
  it('delete then undo, in separate frames', () => scene(async (s) => {
    const a = s.peer();
    await s.comment('c1', 'brown fox');
    a.edit(() => $select('brown fox').removeText());
    accepted(await a.send());
    orphaned(s);
    a.undo();
    accepted(await a.send());
    on(s, 'brown fox');
  }));

  it('delete then undo, in the same frame', () => scene(async (s) => {
    const a = s.peer();
    await s.comment('c1', 'brown fox');
    a.edit(() => $select('brown fox').removeText());
    a.undo();
    accepted(await a.sendMerged());
    on(s, 'brown fox');
  }));

  it('delete, undo, redo, undo: frame by frame, and as one frame', () => scene(async (s) => {
    const a = s.peer();
    await s.comment('c1', 'brown fox');
    a.edit(() => $select('brown fox').removeText());
    accepted(await a.send());
    orphaned(s);
    a.undo();
    accepted(await a.send());
    on(s, 'brown fox');
    a.redo();
    accepted(await a.send());
    orphaned(s);
    a.undo();
    accepted(await a.send());
    on(s, 'brown fox');

    await s.comment('c2', 'lazy dog');
    a.edit(() => $select('lazy dog').removeText());
    a.undo();
    a.redo();
    a.undo();
    accepted(await a.sendMerged());
    on(s, 'lazy dog', 'c2');
  }));

  it('block delete then undo', () => scene(async (s) => {
    const a = s.peer();
    await s.comment('c1', 'brown fox');
    a.edit(() => $block(0).remove());
    accepted(await a.send());
    orphaned(s);
    a.undo();
    accepted(await a.send());
    on(s, 'brown fox');
  }));

  it('cross-block delete (after an Enter inside it) then undo', () => scene(async (s) => {
    const a = s.peer();
    await s.comment('c1', 'brown fox');
    a.edit(() => $caret(' fox').insertParagraph());
    accepted(await a.send());
    on(s, 'brown fox');
    a.edit(() => $select('brown\n fox').removeText());
    accepted(await a.send());
    orphaned(s);
    a.undo();
    accepted(await a.send());
    on(s, 'brown fox');
  }));

  it('text delete, then its paragraph deleted, then both undone (lift)', () => scene(async (s) => {
    const a = s.peer();
    await s.comment('c1', 'brown');
    a.edit(() => $select('brown').removeText());
    accepted(await a.send());
    orphaned(s);
    a.edit(() => $block(0).remove());
    accepted(await a.send());
    orphaned(s);
    a.undo();
    accepted(await a.send());
    expect(a.text()).toContain('The quick  fox');
    orphaned(s);
    a.undo();
    accepted(await a.send());
    on(s, 'brown');
  }));

  it('lift-empty-paragraph-undo-restores-comment', () => scene(async (s) => {
    // The whole paragraph's text goes, then the empty paragraph: the first undo restores an empty block, so the
    // re-homed place has no live bound and the second undo's copies have neither origin nor right origin.
    const a = s.peer();
    await s.comment('c1', 'unique passage');
    a.edit(() => $select('unique passage').removeText());
    accepted(await a.send());
    orphaned(s);
    a.edit(() => $block(0).remove());
    accepted(await a.send());
    orphaned(s);
    a.undo();
    accepted(await a.send());
    orphaned(s);
    a.undo();
    accepted(await a.send());
    on(s, 'unique passage');
  }, 'unique passage\n\nTail.'));

  it('lift: a comment on part of a paragraph whose whole text is deleted, then the paragraph, both undone', () => scene(async (s) => {
    // The frame also deletes the text node's property map and the uncommented rest, which the second undo restores
    // into the same re-homed place (§5.3: the segment spans the frame's own deletions next to the members).
    const a = s.peer();
    await s.comment('c1', 'unique');
    a.edit(() => $select('unique passage').removeText());
    accepted(await a.send());
    orphaned(s);
    a.edit(() => $block(0).remove());
    accepted(await a.send());
    orphaned(s);
    a.undo();
    accepted(await a.send());
    orphaned(s);
    a.undo();
    accepted(await a.send());
    on(s, 'unique');
  }, 'unique passage\n\nTail.'));

  it('lift: the deletion also takes an uncommented neighbour, then the paragraph, both undone', () => scene(async (s) => {
    const a = s.peer();
    await s.comment('c1', 'brown');
    a.edit(() => $select('quick brown').removeText());
    accepted(await a.send());
    orphaned(s);
    a.edit(() => $block(0).remove());
    accepted(await a.send());
    orphaned(s);
    a.undo();
    accepted(await a.send());
    orphaned(s);
    a.undo();
    accepted(await a.send());
    on(s, 'brown');
  }));

  it('offline: type inside it, delete all of it, undo the deletion; replayed under the discipline it reattaches whole', () => scene(async (s) => {
    const a = s.peer();
    await s.comment('c1', 'brown');
    s.offline(a);
    a.edit(() => $caret('own').insertText('X'));
    a.edit(() => $select('brXown').removeText());
    a.undo();
    s.online(a);
    const verdicts = await a.sendGrouped();
    expect(verdicts).toHaveLength(3);
    accepted(verdicts);
    on(s, 'brXown');
  }));

  it('offline-lift-empty-paragraph-coalesced-deletes-undo-restores-comment', () => scene(async (s) => {
    // Both deletions are delete-only, so the replay sends them as one frame and the place is the whole paragraph.
    // The first undo restores it empty; the second undo's copies sit inside that copy, whose right origin is the
    // member paragraph (§5.4).
    const a = s.peer();
    await s.comment('c1', 'unique passage');
    s.offline(a);
    a.edit(() => $select('unique passage').removeText());
    a.edit(() => $block(0).remove());
    s.online(a);
    const verdicts = await a.sendGrouped();
    expect(verdicts).toHaveLength(1);
    accepted(verdicts);
    orphaned(s);
    a.undo();
    accepted(await a.send());
    orphaned(s);
    a.undo();
    accepted(await a.send());
    on(s, 'unique passage');
  }, 'unique passage\n\nTail.'));

  it('offline-lift-partial-text-coalesced-deletes-undo-restores-comment', () => scene(async (s) => {
    const a = s.peer();
    await s.comment('c1', 'brown');
    s.offline(a);
    a.edit(() => $select('brown').removeText());
    a.edit(() => $block(0).remove());
    s.online(a);
    const verdicts = await a.sendGrouped();
    expect(verdicts).toHaveLength(1);
    accepted(verdicts);
    orphaned(s);
    a.undo();
    accepted(await a.send());
    expect(a.text()).toContain('The quick  fox');
    orphaned(s);
    a.undo();
    accepted(await a.send());
    on(s, 'brown');
  }));

  it("a paragraph's whole text deleted, then retyped into the empty paragraph, stays orphaned", () => scene(async (s) => {
    // §5.3's member extension takes the text node's property map too; the retype still lands after the tombstone run.
    const a = s.peer();
    await s.comment('c1', 'unique passage');
    a.edit(() => $select('unique passage').removeText());
    accepted(await a.send());
    orphaned(s);
    a.edit(() => {
      ($block(0) as ElementNode).selectStart();
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.insertText('unique passage');
    });
    accepted(await a.send());
    expect(a.text()).toContain('unique passage');
    orphaned(s);
  }, 'unique passage\n\nTail.'));

  it('offline: delete it, then retype it identically; replayed under the discipline it stays orphaned', () => scene(async (s) => {
    const a = s.peer();
    await s.comment('c1', 'brown');
    s.offline(a);
    a.edit(() => $select('brown').removeText());
    a.edit(() => $caret(' fox').insertText('brown'));
    s.online(a);
    const verdicts = await a.sendGrouped();
    expect(verdicts).toHaveLength(2);
    accepted(verdicts);
    expect(a.text()).toContain('The quick brown fox');
    orphaned(s);
  }));
});
