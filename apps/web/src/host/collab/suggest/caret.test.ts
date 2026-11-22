// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { focusOverNote } from './caret.ts';

const add = (html: string): HTMLElement => {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
};

afterEach(() => {
  document.body.replaceChildren();
});

describe('focusOverNote: a remount puts the caret back only when focus is not over the note', () => {
  it('nothing focused, the body, or the editor itself: the caret goes back', () => {
    expect(focusOverNote(document)).toBe(false);
    const host = add('<div contenteditable="true" tabindex="0" data-body></div>');
    host.querySelector<HTMLElement>('[data-body]')!.focus();
    expect(focusOverNote(document)).toBe(false);
  });

  it('a menu trigger left focused after its menu closed (a mode switch from More actions): the caret goes back', () => {
    const host = add('<button aria-haspopup="menu" aria-expanded="false">More actions</button>');
    host.querySelector('button')!.focus();
    expect(focusOverNote(document)).toBe(false);
  });

  it('the control holding a list open: focus stays', () => {
    const host = add('<button aria-haspopup="dialog" aria-expanded="true">Suggestions, 1 open</button>');
    host.querySelector('button')!.focus();
    expect(focusOverNote(document)).toBe(true);
  });

  it('inside an open popup, menu or dialog: focus stays', () => {
    for (const shell of ['<div data-overlay-surface>', '<div role="menu">', '<div role="dialog">', '<div role="alertdialog">']) {
      const host = add(`${shell}<button>Cancel</button></div>`);
      host.querySelector('button')!.focus();
      expect(focusOverNote(document), shell).toBe(true);
      host.remove();
    }
  });
});
